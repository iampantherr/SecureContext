/**
 * v0.28.0-β — Skill-spotter LLM filer.
 * v0.30.0 — REFACTORED to use terminal-agent queue pattern (no API key needed).
 *
 * Takes the structured signals from a v0.28.0-α dry-run and asks a terminal-
 * launched Claude CLI agent (Pro-plan auth) to apply the four Anthropic skill-
 * quality gates (procedural-not-factual / clear-trigger / ≥3-repeated /
 * progressive-disclosure-leverage), plus duplicate detection against existing
 * skills, plus global-vs-project scope classification.
 *
 * For each signal the LLM either:
 *   - files a skill_candidates_pg row with status='ready' + a full
 *     proposed_skill_body (the operator reviews + approves to admit), OR
 *   - records a rejection outcome on the signal row with a one-line reason
 *
 * The β filer ALWAYS runs against a specific run_id (you pick the dry-run
 * output to file). It does NOT re-mine signals — that's α's job.
 *
 * AUTH (v0.30.0 — no API key):
 *   The filer ENQUEUES a task into task_queue_pg with role='mutator' (or a
 *   custom pool) and payload.kind='skill-spotter-filer'. A terminal Claude
 *   CLI agent already running for the operator's project (started via
 *   start-agents.ps1, authenticated via Pro plan login) claims the task,
 *   runs the LLM reasoning, stores the decisions in the mutation_results
 *   side-channel, and broadcasts a STATUS pointer. The β filer polls
 *   broadcasts for the matching run_id, fetches the side-channel row,
 *   verifies the bodies_hash, and processes the decisions.
 *
 *   Cost: $0 (Pro plan). Throughput: ≤ 1 LLM call per filer invocation.
 *
 * SAFETY:
 *   - Each decision is parsed strictly as JSON; malformed decisions are
 *     dropped, not silently turned into candidates.
 *   - Side-channel row's bodies_hash is verified on fetch (RT-S2-09 invariant).
 *   - Each filed candidate's body is admission-gate-eligible — the operator
 *     still has to approve, after which the existing approve flow writes
 *     the body to disk and triggers admission.
 *   - We pass existing skill names + descriptions to the LLM so it can
 *     detect duplicates rather than proposing the same skill twice.
 */

import { randomUUID, createHash } from "node:crypto";
import { withClient } from "../../pg_pool.js";
import { logger } from "../../logger.js";
import { ANTHROPIC_SKILL_STANDARD } from "../anthropic_standard.js";

export type FilerOutcome =
  | "filed_candidate"
  | "rejected_low_signal"
  | "rejected_not_procedural"
  | "rejected_fits_in_prompt"
  | "rejected_duplicate"
  | "rejected_variable_instances";

export interface FilerResult {
  run_id:             string;
  signals_processed:  number;
  candidates_filed:   number;
  by_outcome:         Record<FilerOutcome, number>;
  llm_duration_ms:    number;
  candidate_ids:      string[];
  errors:             string[];
}

interface LlmDecision {
  signal_id:       number;
  outcome:         FilerOutcome;
  outcome_reason:  string;
  candidate?: {
    skill_name:           string;
    scope:                "global" | "project";
    description:          string;
    procedure_steps:      string[];
    proposed_skill_body:  string;
  };
}

const DEFAULT_TIMEOUT_MS   = 10 * 60 * 1000;
const DEFAULT_POLL_MS      = 2_000;
// Role chosen so the existing dispatcher auto-spawn pattern (^mutator-) fires
// when there's no live worker — see A2A_dispatcher/dispatcher.mjs:MUTATOR_POOL_PATTERN.
// "mutator-general" is the catch-all pool defined in A2A_dispatcher/roles.json
// (Sprint 2.7); the spotter-filer payload is read by the agent via payload.kind
// so the pool's domain-style rules are bypassed for non-mutation work.
const DEFAULT_AGENT_ROLE   = "mutator-general";

/**
 * Build the agent-side system context. This is shipped via the task payload —
 * the terminal agent reads `payload.system_prompt` and `payload.user_prompt`
 * and processes them in its existing CLI context (Pro-plan auth).
 */
const SPOTTER_SYSTEM_PROMPT = `You are the skill-spotter judgment agent for SecureContext.

Your job: take a list of OBSERVED ACTIVITY PATTERNS (each is a structured signal from
a detector) and decide which ones are worth formalizing as Anthropic-style filesystem skills.
For the ones worth formalizing, you write the full SKILL.md body.

# The standard you must respect

${ANTHROPIC_SKILL_STANDARD}

# Spotter-specific anti-patterns to reject (in addition to the standard above)

- **Duplicates an existing skill**: if a skill with similar description/triggers already
  exists (we provide the list), reject with outcome=rejected_duplicate.
- **Wildly variable instances**: if the same N-gram tool sequence shows up but each instance
  is doing a fundamentally different task, reject with outcome=rejected_variable_instances.

# Scope decision for new spotter candidates

Apply the scope matrix from the standard above. The signal's evidence includes
session_ids and (for some signals) project_hashes. If a pattern appears only in one
project_hash, propose scope=project (default tie-breaker). Promote to global later
when it shows up in ≥2 distinct projects.

OUTPUT — a "decisions" array where each entry is one of:
{
  "signal_id": <int from input>,
  "outcome": "filed_candidate" | "rejected_not_procedural" | "rejected_fits_in_prompt" | "rejected_duplicate" | "rejected_variable_instances" | "rejected_low_signal",
  "outcome_reason": "<one-line explanation>",
  "candidate": {                                  // ONLY when outcome=filed_candidate
    "skill_name": "<kebab-case, <=64 chars>",
    "scope": "global" | "project",
    "description": "Use this whenever <X>. The skill <Y>.",
    "procedure_steps": ["step 1", "step 2", "step 3"],
    "proposed_skill_body": "<full SKILL.md body in markdown, starting with '# <Title>' and including '## When to use', '## Procedure' with numbered steps, and '## Bundled scripts' (with TODO placeholders if needed)>"
  }
}

Be conservative. We'd rather miss a real skill than flood the operator with poor candidates.
If you're not sure, reject.`;

export interface FilerOptions {
  run_id: string;
  /** Project path used to compute project_hash for queue routing + side-channel DB. REQUIRED. */
  project_path: string;
  /** Role of the terminal agent pool. Defaults to 'mutator' — agents subscribed to that role pick up the task. */
  agent_role?: string;
  /** Total wait for the agent's broadcast response. Default 10 min (β filer reasoning can be lengthy). */
  timeout_ms?: number;
  /** Polling cadence while waiting. Default 2s. */
  poll_interval_ms?: number;
  /** If false, only does a dry run — don't write candidates. Default true. */
  write_candidates?: boolean;
}

// ─── Custom error types ──────────────────────────────────────────────────────

export class SpotterFilerTimeoutError extends Error {
  constructor(public run_id: string, public elapsed_ms: number) {
    super(`SpotterLlmFiler: no broadcast for run_id=${run_id} within ${elapsed_ms}ms`);
    this.name = "SpotterFilerTimeoutError";
  }
}

export class SpotterFilerEnqueueError extends Error {
  constructor(public run_id: string) {
    super(`SpotterLlmFiler: enqueueTask returned false for run_id=${run_id} (already queued?)`);
    this.name = "SpotterFilerEnqueueError";
  }
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function listExistingSkillsForDedup(): Promise<Array<{ name: string; description: string }>> {
  return await withClient(async (c) => {
    const r = await c.query<{ name: string; description: string }>(
      `SELECT name, description FROM skills_pg
        WHERE archived_at IS NULL AND (quarantined IS NULL OR quarantined = FALSE)
        ORDER BY name`,
    );
    return r.rows;
  });
}

async function loadSignals(runId: string): Promise<Array<{
  signal_id: number;
  signal_type: string;
  occurrences: number;
  confidence: number;
  evidence: unknown;
  proposed_trigger: string | null;
  proposed_name_hint: string | null;
}>> {
  return await withClient(async (c) => {
    const r = await c.query(
      `SELECT signal_id, signal_type, occurrences, confidence, evidence,
              proposed_trigger, proposed_name_hint
         FROM skill_spotter_signals_pg
        WHERE run_id = $1 AND outcome = 'observed'
        ORDER BY occurrences DESC, signal_id ASC`,
      [runId],
    );
    return r.rows as Array<{
      signal_id: number; signal_type: string; occurrences: number;
      confidence: number; evidence: unknown; proposed_trigger: string | null;
      proposed_name_hint: string | null;
    }>;
  });
}

// ─── Agent-side instructions ─────────────────────────────────────────────────

/**
 * The step-by-step instructions the terminal mutator agent reads out of
 * task.payload.instructions. Mirrors CliClaudeMutator._instructionsForAgent
 * so a single mutator-pool agent can handle BOTH skill-mutation tasks and
 * skill-spotter-filer tasks (it branches on payload.kind).
 */
function instructionsForSpotterAgent(runId: string): string {
  return [
    "You are processing a SKILL-SPOTTER LLM-FILER request (payload.kind='skill-spotter-filer').",
    "",
    "## What you have in the task payload",
    "- system_prompt: the system prompt that defines your judgement role + Anthropic standard.",
    "- user_prompt: the JSON payload (signals[], existing_skills_for_dedup[], instructions).",
    "- run_id: the spotter dry-run id you are filing for.",
    "",
    "## What you do",
    "1. Read system_prompt + user_prompt. Internalize the four invariants and the scope matrix.",
    "2. For EACH signal in user_prompt.signals, decide:",
    "   - outcome (one of: filed_candidate, rejected_low_signal, rejected_not_procedural,",
    "     rejected_fits_in_prompt, rejected_duplicate, rejected_variable_instances)",
    "   - outcome_reason (one short line)",
    "   - if filed_candidate: also produce {skill_name, scope, description, procedure_steps,",
    "     proposed_skill_body} per system_prompt schema.",
    "3. Persist your decisions via the mutation_results side-channel (reused as a generic",
    "   bodies side-channel; each 'body' is one JSON-encoded decision):",
    "",
    "STEP 1 — persist via side-channel:",
    `  zc_record_mutation_result({`,
    `    mutation_id: "${runId}",`,
    `    skill_id: "spotter-filer:${runId}",`,
    `    proposer_model: "claude-sonnet-4-6",`,
    `    proposer_role: "spotter-filer",`,
    `    bodies: decisions.map(d => ({`,
    `      candidate_body: JSON.stringify(d),                  // FULL decision as JSON`,
    `      rationale:      d.outcome_reason ?? "",`,
    `      self_rated_score: d.outcome === "filed_candidate" ? 0.8 : 0.2`,
    `    }))`,
    `  })`,
    "  → returns {result_id, bodies_hash, headline}.",
    "",
    "STEP 2 — broadcast pointer ONLY (the side-channel holds the bodies):",
    `  zc_broadcast({`,
    `    type: "STATUS", state: "spotter-filer-result", agent_id: <your_agent_id>,`,
    `    summary: JSON.stringify({`,
    `      run_id:          "${runId}",`,
    `      result_id:       <from STEP 1>,`,
    `      bodies_hash:     <from STEP 1>,`,
    `      decisions_count: decisions.length,`,
    `      proposer_model:  "claude-sonnet-4-6"`,
    `    })`,
    `  })`,
    "",
    "STEP 3 — call zc_complete_task on this task and loop for the next.",
    "",
    "Be conservative — fewer high-quality candidates beat many low-quality ones.",
  ].join("\n");
}

// ─── Enqueue + wait ──────────────────────────────────────────────────────────

interface AgentResponse {
  result_id:    string;
  bodies_hash:  string;
  decisions:    LlmDecision[];
}

/**
 * Broadcast polling — reads from PG `broadcasts` table directly so the
 * filer running in sc-api's container can see broadcasts written by a
 * terminal Claude CLI agent running on the host. The per-process SQLite
 * mirror in memory.ts is NOT shared across the container boundary, so
 * `recallSharedChannel` would silently see zero rows.
 */
async function pollBroadcasts(sinceId: number, projectHash: string): Promise<Array<{
  id: number; type: string; agent_id: string; state?: string; summary?: string;
}>> {
  return await withClient(async (c) => {
    const r = await c.query<{
      id: number; type: string; agent_id: string; state: string; summary: string;
    }>(
      `SELECT id, type, agent_id, state, summary
         FROM broadcasts
        WHERE project_hash = $1 AND id > $2
        ORDER BY id ASC
        LIMIT 200`,
      [projectHash, sinceId],
    );
    return r.rows.map((row) => ({
      id:       row.id,
      type:     row.type,
      agent_id: row.agent_id,
      state:    row.state,
      summary:  row.summary,
    }));
  });
}

async function currentMaxBroadcastId(projectHash: string): Promise<number> {
  return await withClient(async (c) => {
    const r = await c.query<{ mx: number | null }>(
      `SELECT COALESCE(MAX(id), 0)::int AS mx FROM broadcasts WHERE project_hash = $1`,
      [projectHash],
    );
    return r.rows[0]?.mx ?? 0;
  });
}

/**
 * Open the per-project SQLite side-channel DB and fetch + verify the result row.
 */
async function fetchDecisionsFromSideChannel(
  runId: string,
  projectPath: string,
  expectedHash: string,
): Promise<LlmDecision[]> {
  const { fetchMutationResult } = await import("../mutation_results.js");
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");

  const dbDir = join(homedir(), ".claude", "zc-ctx", "sessions");
  mkdirSync(dbDir, { recursive: true });
  const projectHash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  const dbFile = join(dbDir, `${projectHash}.db`);

  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL");
  try {
    const row = await fetchMutationResult(db, runId, { expectedHash });
    if (!row) {
      throw new Error(`SpotterLlmFiler: side-channel fetch failed for ${runId} — hash mismatch or row missing (expected ${expectedHash})`);
    }
    const decisions: LlmDecision[] = [];
    for (const body of row.bodies) {
      try {
        const parsed = JSON.parse(body.candidate_body) as Partial<LlmDecision> & { signal_id?: unknown };
        // Coerce signal_id (LLMs sometimes emit it as a string like "28").
        const coercedId = typeof parsed.signal_id === "number"
          ? parsed.signal_id
          : (typeof parsed.signal_id === "string" && /^-?\d+$/.test(parsed.signal_id)
              ? parseInt(parsed.signal_id, 10)
              : NaN);
        if (Number.isFinite(coercedId) && typeof parsed.outcome === "string") {
          decisions.push({ ...(parsed as LlmDecision), signal_id: coercedId });
        } else {
          logger.warn("skills", "spotter_filer_skip_malformed_decision", {
            run_id: runId, signal_id_raw: parsed.signal_id, outcome_raw: parsed.outcome,
          });
        }
      } catch (e) {
        logger.warn("skills", "spotter_filer_skip_malformed_decision", {
          run_id: runId, error: (e as Error).message,
        });
      }
    }
    return decisions;
  } finally {
    db.close();
  }
}

/**
 * Enqueue a task for the terminal mutator agent and wait for its broadcast.
 * Returns the parsed decisions array, throwing SpotterFilerTimeoutError on timeout.
 */
async function enqueueAndAwaitAgent(opts: {
  runId:           string;
  projectPath:     string;
  role:            string;
  timeoutMs:       number;
  pollIntervalMs:  number;
  payload:         Record<string, unknown>;
}): Promise<AgentResponse> {
  const { enqueueTask } = await import("../../task_queue.js");
  const projectHash = createHash("sha256").update(opts.projectPath).digest("hex").slice(0, 16);

  // 1. Capture broadcast watermark BEFORE enqueuing.
  const sinceId = await currentMaxBroadcastId(projectHash);

  // 2. Enqueue.
  const inserted = await enqueueTask({
    taskId:      opts.runId,
    projectHash,
    role:        opts.role,
    payload:     opts.payload,
  });
  if (!inserted) throw new SpotterFilerEnqueueError(opts.runId);

  logger.info("skills", "spotter_filer_enqueued", {
    run_id:        opts.runId,
    project_hash:  projectHash,
    role:          opts.role,
    timeout_ms:    opts.timeoutMs,
  });

  // 3. Poll broadcasts.
  const startedAt = Date.now();
  let cursor = sinceId;
  while (Date.now() - startedAt < opts.timeoutMs) {
    await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
    const fresh = await pollBroadcasts(cursor, projectHash);
    if (fresh.length === 0) continue;
    cursor = Math.max(cursor, ...fresh.map((b) => b.id));
    for (const b of fresh) {
      if (b.type !== "STATUS") continue;
      if ((b.state ?? "").toLowerCase() !== "spotter-filer-result") continue;
      if (!b.summary) continue;
      let parsed: {
        run_id?: string;
        result_id?: string;
        bodies_hash?: string;
        decisions_count?: number;
      };
      try { parsed = JSON.parse(b.summary); } catch { continue; }
      if (parsed.run_id !== opts.runId) continue;
      if (!parsed.result_id || !parsed.bodies_hash) {
        throw new Error(`SpotterLlmFiler: response for ${opts.runId} missing result_id/bodies_hash pointer`);
      }
      const decisions = await fetchDecisionsFromSideChannel(
        opts.runId, opts.projectPath, parsed.bodies_hash,
      );
      return {
        result_id:   parsed.result_id,
        bodies_hash: parsed.bodies_hash,
        decisions,
      };
    }
  }
  throw new SpotterFilerTimeoutError(opts.runId, Date.now() - startedAt);
}

// ─── Decision validator (unchanged from subprocess version) ──────────────────

function validateDecisions(raw: LlmDecision[]): LlmDecision[] {
  const valid: LlmDecision[] = [];
  const outcomes: FilerOutcome[] = [
    "filed_candidate", "rejected_low_signal", "rejected_not_procedural",
    "rejected_fits_in_prompt", "rejected_duplicate", "rejected_variable_instances",
  ];
  for (const d of raw) {
    if (typeof d.signal_id !== "number" || !Number.isFinite(d.signal_id)) continue;
    if (!outcomes.includes(d.outcome)) continue;
    const decision: LlmDecision = {
      signal_id:      d.signal_id,
      outcome:        d.outcome,
      outcome_reason: typeof d.outcome_reason === "string" ? d.outcome_reason : "",
    };
    if (decision.outcome === "filed_candidate") {
      const cand = d.candidate;
      if (cand
          && typeof cand.skill_name === "string"
          && typeof cand.description === "string"
          && typeof cand.proposed_skill_body === "string"
          && (cand.scope === "global" || cand.scope === "project")
          && Array.isArray(cand.procedure_steps)) {
        decision.candidate = {
          skill_name:           cand.skill_name,
          scope:                cand.scope,
          description:          cand.description,
          procedure_steps:      cand.procedure_steps.filter((s): s is string => typeof s === "string"),
          proposed_skill_body:  cand.proposed_skill_body,
        };
      } else {
        // Downgrade to rejection if candidate fields invalid
        decision.outcome = "rejected_low_signal";
        decision.outcome_reason = `agent marked filed_candidate but candidate fields invalid: ${decision.outcome_reason}`;
      }
    }
    valid.push(decision);
  }
  return valid;
}

// ─── Public entry point ──────────────────────────────────────────────────────

export async function runSpotterLlmFiler(opts: FilerOptions): Promise<FilerResult> {
  if (!opts.project_path) {
    throw new Error("runSpotterLlmFiler: project_path is required (used for queue routing + side-channel DB)");
  }
  const tStart           = Date.now();
  const role             = opts.agent_role       ?? DEFAULT_AGENT_ROLE;
  const timeoutMs        = opts.timeout_ms       ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs   = opts.poll_interval_ms ?? DEFAULT_POLL_MS;
  const writeCandidates  = opts.write_candidates !== false;

  const signals = await loadSignals(opts.run_id);
  if (signals.length === 0) {
    return {
      run_id: opts.run_id, signals_processed: 0, candidates_filed: 0,
      by_outcome: zeroOutcomeMap(), llm_duration_ms: 0,
      candidate_ids: [], errors: ["no observed signals found for this run_id"],
    };
  }

  const existingSkills = await listExistingSkillsForDedup();

  const userPrompt = JSON.stringify({
    run_id: opts.run_id,
    signals: signals.map((s) => ({
      signal_id: s.signal_id,
      signal_type: s.signal_type,
      occurrences: s.occurrences,
      confidence: s.confidence,
      evidence: s.evidence,
      detector_proposed_trigger: s.proposed_trigger,
      detector_proposed_name: s.proposed_name_hint,
    })),
    existing_skills_for_dedup: existingSkills,
    instructions: "Apply the four quality gates from your system prompt to each signal. Return decisions[].",
  }, null, 2);

  const agentPayload: Record<string, unknown> = {
    kind:           "skill-spotter-filer",
    run_id:         opts.run_id,
    system_prompt:  SPOTTER_SYSTEM_PROMPT,
    user_prompt:    userPrompt,
    instructions:   instructionsForSpotterAgent(opts.run_id),
  };

  let rawDecisions: LlmDecision[];
  let resultId = "";
  let bodiesHash = "";
  try {
    const resp = await enqueueAndAwaitAgent({
      runId:           opts.run_id,
      projectPath:     opts.project_path,
      role,
      timeoutMs,
      pollIntervalMs,
      payload:         agentPayload,
    });
    rawDecisions = resp.decisions;
    resultId     = resp.result_id;
    bodiesHash   = resp.bodies_hash;
  } catch (e) {
    logger.error("skills", "spotter_filer_agent_failed", {
      run_id: opts.run_id, error: (e as Error).message,
    });
    return {
      run_id: opts.run_id, signals_processed: 0, candidates_filed: 0,
      by_outcome: zeroOutcomeMap(), llm_duration_ms: Date.now() - tStart,
      candidate_ids: [], errors: [(e as Error).message],
    };
  }

  const llmMs = Date.now() - tStart;
  const decisions = validateDecisions(rawDecisions);

  // Persist decisions
  const byOutcome = zeroOutcomeMap();
  const candidateIds: string[] = [];
  const errors: string[] = [];

  for (const d of decisions) {
    byOutcome[d.outcome] = (byOutcome[d.outcome] ?? 0) + 1;
    try {
      if (d.outcome === "filed_candidate" && d.candidate && writeCandidates) {
        const candidateId = randomUUID();
        const cand = d.candidate;
        const sid  = d.signal_id;
        await withClient(async (c) => {
          await c.query(
            `INSERT INTO skill_candidates_pg (
               candidate_id, project_hash, target_role, rejection_count,
               first_rejection_at, last_rejection_at, rejection_outcomes,
               headline, proposed_skill_body, proposed_at, status
             ) VALUES ($1, $2, $3, $4, now(), now(), $5::jsonb,
                       $6, $7, now(), 'ready')`,
            [
              candidateId,
              "spotter-global",
              "developer",
              0,
              JSON.stringify({
                source:    "skill-spotter",
                signal_id: sid,
                scope:     cand.scope,
                result_id: resultId,
                bodies_hash: bodiesHash,
              }),
              `[spotter] ${cand.skill_name}: ${cand.description.slice(0, 140)}`,
              `---\nname: ${cand.skill_name}\ndescription: |\n  ${cand.description}\nscope: ${cand.scope}\n---\n\n${cand.proposed_skill_body}`,
            ],
          );
        });
        candidateIds.push(candidateId);
        await withClient(async (c) => {
          await c.query(
            `UPDATE skill_spotter_signals_pg
                SET outcome = 'filed_candidate', outcome_reason = $2, candidate_id = $3::uuid
              WHERE signal_id = $1`,
            [d.signal_id, d.outcome_reason, candidateId],
          );
        });
      } else if (d.outcome !== "filed_candidate") {
        await withClient(async (c) => {
          await c.query(
            `UPDATE skill_spotter_signals_pg
                SET outcome = $2, outcome_reason = $3
              WHERE signal_id = $1`,
            [d.signal_id, d.outcome, d.outcome_reason],
          );
        });
      }
    } catch (e) {
      errors.push(`signal_id=${d.signal_id} persist failed: ${(e as Error).message}`);
      logger.warn("skills", "spotter_filer_persist_failed", {
        signal_id: d.signal_id, error: (e as Error).message,
      });
    }
  }

  // Update run row
  await withClient(async (c) => {
    await c.query(
      `UPDATE skill_spotter_runs_pg
          SET mode = 'llm-proposed', candidates_filed = $2
        WHERE run_id = $1`,
      [opts.run_id, candidateIds.length],
    );
  });

  logger.info("skills", "spotter_llm_filer_complete", {
    run_id: opts.run_id, signals: decisions.length,
    candidates: candidateIds.length, duration_ms: llmMs,
    result_id: resultId, bodies_hash: bodiesHash,
  });

  return {
    run_id: opts.run_id,
    signals_processed: decisions.length,
    candidates_filed: candidateIds.length,
    by_outcome: byOutcome,
    llm_duration_ms: llmMs,
    candidate_ids: candidateIds,
    errors,
  };
}

function zeroOutcomeMap(): Record<FilerOutcome, number> {
  return {
    filed_candidate:               0,
    rejected_low_signal:           0,
    rejected_not_procedural:       0,
    rejected_fits_in_prompt:       0,
    rejected_duplicate:            0,
    rejected_variable_instances:   0,
  };
}
