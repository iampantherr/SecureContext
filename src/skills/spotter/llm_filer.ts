/**
 * v0.28.0-β — Skill-spotter LLM filer.
 *
 * Takes the structured signals from a v0.28.0-α dry-run and asks
 * claude-sonnet-4-6 to apply the four Anthropic skill-quality gates
 * (procedural-not-factual / clear-trigger / ≥3-repeated /
 * progressive-disclosure-leverage), plus duplicate detection against
 * existing skills, plus global-vs-project scope classification.
 *
 * For each signal the LLM either:
 *   - files a skill_candidates_pg row with status='ready' + a full
 *     proposed_skill_body (the operator reviews + approves to admit), OR
 *   - records a rejection outcome on the signal row with a one-line reason
 *
 * The β filer ALWAYS runs against a specific run_id (you pick the dry-run
 * output to file). It does NOT re-mine signals — that's α's job.
 *
 * AUTH:
 *   Uses `claude` CLI subprocess (no ANTHROPIC_API_KEY needed). Inherits
 *   the operator's Claude Pro auth. Cost: ~$0.15 per run with Sonnet 4.6
 *   on a typical 12K-input + 4K-output decision; under $5/month even with
 *   daily cron.
 *
 * SAFETY:
 *   - LLM output is parsed strictly as JSON; malformed output → no
 *     candidates filed, error logged.
 *   - Each filed candidate's body is admission-gate-eligible (the operator
 *     still has to approve, after which the existing approve flow writes
 *     the body to disk and triggers admission).
 *   - We pass existing skill names + descriptions to the LLM so it can
 *     detect duplicates rather than proposing the same skill twice.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { withClient } from "../../pg_pool.js";
import { logger } from "../../logger.js";

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

const SPOTTER_SYSTEM_PROMPT = `You are the skill-spotter judgment agent for SecureContext.

Your job: take a list of OBSERVED ACTIVITY PATTERNS (each is a structured signal from
a detector) and decide which ones are worth formalizing as Anthropic-style filesystem skills.
For the ones worth formalizing, you write the full SKILL.md body.

Apply these FOUR quality gates (from Anthropic's skill-design guidelines):

1. **PROCEDURAL**: pattern must describe HOW TO do something repeatable, not WHAT something is.
   Reject if instances vary so wildly the procedure is really task-specific reasoning,
   not procedure.
2. **CLEAR TRIGGER**: you must be able to write a one-sentence "Use this whenever <X>" rule
   with the literal words/phrases the user would type. Vague triggers fail to fire at runtime.
   Reject if you cannot write a clear trigger.
3. **>=3 OCCURRENCES**: the detector already filters for >=3 by default, but cross-check
   the data; reject if the actual occurrence count is below threshold OR if all occurrences
   are within a very short time window (likely a one-off retry burst, not a true pattern).
4. **PROGRESSIVE DISCLOSURE LEVERAGE**: skill should have L1 (description ~100 tokens),
   L2 (procedural body <5k tokens), and ideally L3 (bundled scripts that do the work). If
   the entire procedure fits in a one-prompt nudge with no bundled tooling needed, reject —
   it's better as a 'zc_remember' fact or a one-liner.

Anti-patterns to reject (in addition to the four gates):
- **Duplicates an existing skill**: if a skill with similar description/triggers already
  exists (we provide the list), reject with outcome=rejected_duplicate.
- **Wildly variable instances**: if the same N-gram tool sequence shows up but each instance
  is doing a fundamentally different task, reject with outcome=rejected_variable_instances.

SCOPE classification:
- The signal's evidence includes session_ids and (for some signals) project_hashes.
- If the pattern is project-binding (mentions project-specific files/paths/conventions),
  propose scope=project. Otherwise propose scope=global.

OUTPUT FORMAT — single JSON object on stdout, nothing else:
{
  "decisions": [
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
    },
    ...
  ]
}

Be conservative. We'd rather miss a real skill than flood the operator with poor candidates.
If you're not sure, reject.`;

export interface FilerOptions {
  run_id: string;
  /** Override claude CLI binary path (defaults to "claude" on PATH). */
  claude_bin?: string;
  /** Override model. Defaults to claude-sonnet-4-6. */
  model?: string;
  /** Timeout for the claude subprocess. Default 5 min. */
  timeout_ms?: number;
  /** If false, only does a dry run — don't write candidates. Default true. */
  write_candidates?: boolean;
}

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

/**
 * Spawn the claude CLI subprocess in headless `-p` mode and capture stdout.
 * Resolves with the stdout string or rejects with the stderr + exit code.
 */
function callClaudeCli(opts: {
  bin: string;
  model: string;
  system_prompt: string;
  user_prompt: string;
  timeout_ms: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "--model", opts.model,
      "--dangerously-skip-permissions",
      "--append-system-prompt", opts.system_prompt,
      "-p", opts.user_prompt,
    ];
    const child = spawn(opts.bin, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const t = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error(`claude CLI timed out after ${opts.timeout_ms}ms`));
    }, opts.timeout_ms);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(t);
      if (killed) return;
      reject(new Error(`claude CLI spawn failed: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (killed) return;
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

function extractJson(s: string): unknown {
  // Try direct parse first
  const trimmed = s.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  // Look for the first { ... last } block (LLMs sometimes prefix text)
  const start = trimmed.indexOf("{");
  const end   = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new Error(`could not extract JSON from claude output (first 200 chars: ${trimmed.slice(0, 200)})`);
}

function validateDecisions(parsed: unknown): LlmDecision[] {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("LLM output is not an object");
  }
  const obj = parsed as { decisions?: unknown };
  if (!Array.isArray(obj.decisions)) {
    throw new Error("LLM output missing 'decisions' array");
  }
  const valid: LlmDecision[] = [];
  for (const raw of obj.decisions) {
    if (typeof raw !== "object" || raw === null) continue;
    const d = raw as Record<string, unknown>;
    if (typeof d.signal_id !== "number") continue;
    if (typeof d.outcome !== "string") continue;
    const outcomes: FilerOutcome[] = [
      "filed_candidate", "rejected_low_signal", "rejected_not_procedural",
      "rejected_fits_in_prompt", "rejected_duplicate", "rejected_variable_instances",
    ];
    if (!outcomes.includes(d.outcome as FilerOutcome)) continue;
    const decision: LlmDecision = {
      signal_id: d.signal_id,
      outcome: d.outcome as FilerOutcome,
      outcome_reason: typeof d.outcome_reason === "string" ? d.outcome_reason : "",
    };
    if (decision.outcome === "filed_candidate") {
      const cand = d.candidate as Record<string, unknown> | undefined;
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
        decision.outcome_reason = `LLM marked filed_candidate but candidate fields invalid: ${decision.outcome_reason}`;
      }
    }
    valid.push(decision);
  }
  return valid;
}

export async function runSpotterLlmFiler(opts: FilerOptions): Promise<FilerResult> {
  const tStart = Date.now();
  const claudeBin = opts.claude_bin ?? "claude";
  const model = opts.model ?? "claude-sonnet-4-6";
  const timeout = opts.timeout_ms ?? 5 * 60 * 1000;
  const writeCandidates = opts.write_candidates !== false;

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
    instructions: "Apply the four quality gates from your system prompt to each signal. Return the JSON object with decisions[].",
  }, null, 2);

  let llmOutput: string;
  try {
    llmOutput = await callClaudeCli({
      bin: claudeBin,
      model,
      system_prompt: SPOTTER_SYSTEM_PROMPT,
      user_prompt: userPrompt,
      timeout_ms: timeout,
    });
  } catch (e) {
    logger.error("skills", "spotter_llm_call_failed", { run_id: opts.run_id, error: (e as Error).message });
    return {
      run_id: opts.run_id, signals_processed: 0, candidates_filed: 0,
      by_outcome: zeroOutcomeMap(), llm_duration_ms: Date.now() - tStart,
      candidate_ids: [], errors: [(e as Error).message],
    };
  }

  const llmMs = Date.now() - tStart;
  let parsed: unknown;
  try {
    parsed = extractJson(llmOutput);
  } catch (e) {
    logger.error("skills", "spotter_llm_parse_failed", { run_id: opts.run_id, error: (e as Error).message });
    return {
      run_id: opts.run_id, signals_processed: 0, candidates_filed: 0,
      by_outcome: zeroOutcomeMap(), llm_duration_ms: llmMs,
      candidate_ids: [], errors: [`LLM output not parseable: ${(e as Error).message}`],
    };
  }

  let decisions: LlmDecision[];
  try {
    decisions = validateDecisions(parsed);
  } catch (e) {
    return {
      run_id: opts.run_id, signals_processed: 0, candidates_filed: 0,
      by_outcome: zeroOutcomeMap(), llm_duration_ms: llmMs,
      candidate_ids: [], errors: [`LLM output validation failed: ${(e as Error).message}`],
    };
  }

  // Persist decisions
  const byOutcome = zeroOutcomeMap();
  const candidateIds: string[] = [];
  const errors: string[] = [];

  for (const d of decisions) {
    byOutcome[d.outcome] = (byOutcome[d.outcome] ?? 0) + 1;
    try {
      if (d.outcome === "filed_candidate" && d.candidate && writeCandidates) {
        const candidateId = randomUUID();
        // Local non-null aliases — TS doesn't narrow `d.candidate` into the
        // withClient closure, but a const alias is unambiguous.
        const cand = d.candidate;
        const sid  = d.signal_id;
        // Insert into skill_candidates_pg (synthesize a project_hash placeholder
        // since this candidate isn't tied to a rejection cluster).
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
              "developer",  // β default; can be refined when role-classifier integrated
              0,            // not from rejection cluster
              JSON.stringify({ source: "skill-spotter", signal_id: sid, scope: cand.scope }),
              `[spotter] ${cand.skill_name}: ${cand.description.slice(0, 140)}`,
              `---\nname: ${cand.skill_name}\ndescription: |\n  ${cand.description}\nscope: ${cand.scope}\n---\n\n${cand.proposed_skill_body}`,
            ],
          );
        });
        candidateIds.push(candidateId);
        // Mark signal row as filed
        await withClient(async (c) => {
          await c.query(
            `UPDATE skill_spotter_signals_pg
                SET outcome = 'filed_candidate', outcome_reason = $2, candidate_id = $3::uuid
              WHERE signal_id = $1`,
            [d.signal_id, d.outcome_reason, candidateId],
          );
        });
      } else if (d.outcome !== "filed_candidate") {
        // Update signal row with rejection outcome
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
