/**
 * v0.19.0 Step 2 — Orchestrator REJECT outcome resolver (Option B).
 *
 * Closes the feedback gap discovered in v0.18.9: when an orchestrator
 * broadcasts a REJECT for a worker's MERGE attempt, that signal was
 * just text in the `broadcasts` table. It never reached the outcome
 * resolver pipeline (Sprint 1 Phase C only resolved git_commit /
 * user_prompt / follow_up). Result: skills couldn't learn from
 * orchestrator-level rejections, and operators saw the same kind of
 * rejection recurring across sessions with no improvement.
 *
 * What this does:
 *
 *   1. Walk back to find the rejected agent's most recent MERGE for the
 *      same `task` field (the natural rejection target).
 *   2. Write an `outcomes_pg` row:
 *        outcome_kind  = 'rejected'
 *        signal_source = 'orchestrator_reject'
 *        ref_type      = 'task'  (the broadcast's task field)
 *        ref_id        = <task value>
 *        evidence      = { rejected_agent, rejected_broadcast_id,
 *                          merge_broadcast_id, reject_reason, summary }
 *
 *   3. Append a `failures.jsonl` learning row in
 *      <project>/learnings/failures.jsonl so the
 *      learnings-indexer hook mirrors it into Postgres.
 *
 *   4. If the rejected agent has any `skill_runs_pg` rows referencing
 *      this task (or, if no task match, any successful runs in the
 *      MERGE-to-REJECT time window), update the most-recent matching
 *      run with outcome_score=0.2 and status='succeeded'->'failed'.
 *      That triggers the mutator's auto-spawn detector on the next tick,
 *      since it queries for low-scoring skill_runs.
 *
 *   5. Surface the rejection in working memory via writeWorkingFact()
 *      so the next time the rejected agent calls zc_recall_context,
 *      they see "Last attempt at <task> was rejected because <reason>"
 *      and can self-correct.
 *
 * The resolver is fire-and-forget from the broadcast endpoint — its
 * failure must not break broadcast delivery. Errors are surfaced via
 * the structured logger.
 *
 * Future (Sprint 2.10+): emit a `skill_candidate` event when the same
 * REJECT reason recurs N times for a role with no relevant skill —
 * that's Step 3 of the v0.19.0 plan, see skill_candidate_detector.ts.
 */

import { withClient } from "./pg_pool.js";
import { logger } from "./logger.js";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface RejectInput {
  projectPath:      string;
  rejectingAgentId: string;     // who broadcast the REJECT (typically 'orchestrator')
  task?:            string;     // the task field from the REJECT broadcast
  summary?:         string;     // free-text "why rejected"
  reason?:          string;     // structured reason
  rejectBroadcastId: number;    // the REJECT broadcast row id (returned by store.broadcast)
}

export interface RejectResolution {
  outcome_id:           string | null;
  rejected_agent_id:    string | null;
  merge_broadcast_id:   number | null;
  flagged_skill_run_id: string | null;
  learnings_appended:   boolean;
  memory_written:       boolean;
}

const PROJECT_HASH_LEN = 16;

function projectHashOf(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, PROJECT_HASH_LEN);
}

/**
 * Find the rejected agent's most recent MERGE for the given task. The
 * REJECT broadcast itself has agent_id = the orchestrator (sender), so we
 * look back at recent MERGE broadcasts to identify whose work was rejected.
 */
async function findRejectedMerge(
  projectHash: string,
  task:        string | undefined,
  rejectId:    number,
): Promise<{ id: number; agent_id: string; created_at: string } | null> {
  if (!task) return null;
  return await withClient(async (c) => {
    const r = await c.query<{ id: number; agent_id: string; created_at: string }>(
      `SELECT id, agent_id, created_at
         FROM broadcasts
        WHERE project_hash = $1
          AND type = 'MERGE'
          AND task = $2
          AND id < $3
        ORDER BY id DESC
        LIMIT 1`,
      [projectHash, task, rejectId],
    );
    return r.rows[0] ?? null;
  });
}

/**
 * Write the structured outcome row. Uses outcomes_pg directly via the
 * Reference Monitor pattern (no chained-table here yet — keeping it simple
 * for v0.19.0; classification chain can be added in v0.20+).
 */
async function writeOutcomeRow(
  projectHash:    string,
  rejectedAgent:  string,
  task:           string,
  rejectId:       number,
  mergeId:        number | null,
  reason:         string | undefined,
  summary:        string | undefined,
): Promise<string | null> {
  const outcomeId = `oc-reject-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const evidence = {
    rejected_agent:        rejectedAgent,
    rejected_broadcast_id: rejectId,
    merge_broadcast_id:    mergeId,
    reject_reason:         reason ?? null,
    reject_summary:        summary ?? null,
    resolver_version:      "v0.19.0",
  };
  try {
    return await withClient(async (c) => {
      // Use a placeholder hash for v0.19.0 (full chained outcome write is a
      // v0.20.0 task — that requires per-agent role provisioning for the
      // rejecting agent which adds complexity we don't need yet). The row
      // is queryable; chain integrity can be backfilled later.
      const r = await c.query<{ id: number }>(
        `INSERT INTO outcomes_pg (
            outcome_id, ref_type, ref_id, outcome_kind,
            signal_source, confidence, score_delta, evidence,
            resolved_at, prev_hash, row_hash, classification, created_by_agent_id
          ) VALUES (
            $1, 'task', $2, 'rejected',
            'orchestrator_reject', 0.95, -0.5, $3::jsonb,
            now(), 'unchained-v0_19_0', $4, 'public', 'orchestrator'
          ) RETURNING id`,
        // classification='public' — orchestrator REJECT broadcasts are routed
        // through the shared channel and visible to all workers in the project,
        // so 'public' is correct per the v0.16.0 T3.2 MAC scheme. NOT NULL
        // constraint added by mig 4 in v0.16.0; previous v0.19.0 RC had NULL
        // which violated the constraint silently (caught by E2E).
        [outcomeId, task, JSON.stringify(evidence), createHash("sha256").update(outcomeId).digest("hex")],
      );
      void r;
      return outcomeId;
    });
  } catch (e) {
    logger.error("outcomes", "reject_resolver_outcome_write_failed", {
      error: (e as Error).message, project_hash: projectHash, task,
    });
    return null;
  }
}

/**
 * Append a failures.jsonl learning row. The learnings-indexer hook
 * mirrors this into the SQLite/PG learnings tables on PostToolUse,
 * so we don't need to touch the DB directly here.
 */
function appendFailureLearning(
  projectPath:    string,
  rejectedAgent:  string,
  task:           string,
  reason:         string | undefined,
  summary:        string | undefined,
): boolean {
  // Docker note: when the API server runs in a Linux container, projectPath
  // is the host's Windows path (e.g. "C:\\Users\\Amit\\..."), which the
  // container can't access. In that case mkdir/append fails with EACCES or
  // ENOENT — that's expected and not a bug. The outcomes_pg row + working
  // memory fact are the canonical record; learnings/failures.jsonl is a
  // nice-to-have for native (non-Docker) deployments + for the
  // learnings-indexer hook to pick up later. Failure here is downgraded
  // to INFO log to avoid polluting the ERROR stream.
  try {
    const learningsDir = join(projectPath, "learnings");
    if (!existsSync(learningsDir)) mkdirSync(learningsDir, { recursive: true });
    const file = join(learningsDir, "failures.jsonl");
    const row = {
      ts:             new Date().toISOString(),
      kind:           "orchestrator_reject",
      task,
      rejected_agent: rejectedAgent,
      root_cause:     reason ?? "(orchestrator rejection — see summary)",
      impact:         summary ?? null,
      learning:       `Orchestrator rejected ${rejectedAgent}'s MERGE for "${task}". Reason: ${reason ?? summary ?? "unspecified"}.`,
      prevention:     `Before broadcasting MERGE for similar tasks, address: ${reason ?? summary ?? "operator-supplied review criteria"}. See orchestrator REJECT broadcast for full reason.`,
      source:         "v0.19.0/outcomes_reject_resolver",
    };
    appendFileSync(file, JSON.stringify(row) + "\n", "utf-8");
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    const isExpectedDockerFailure = msg.includes("EACCES") || msg.includes("ENOENT");
    if (isExpectedDockerFailure) {
      logger.info("outcomes", "reject_resolver_learning_skip_docker", {
        reason: "container cannot reach host project path", project_path: projectPath,
      });
    } else {
      logger.error("outcomes", "reject_resolver_learning_append_failed", {
        error: msg, project_path: projectPath,
      });
    }
    return false;
  }
}

/**
 * Find the most recent skill_run for the rejected agent that could plausibly
 * be the cause of the rejection. Two strategies:
 *
 *   1. If the rejected agent has any skill_run with task_id = the broadcast
 *      task, pick the most recent. Highest precision.
 *   2. Otherwise, fall back to the agent's most recent skill_run within the
 *      MERGE-to-REJECT time window. Lower precision but catches cases where
 *      the skill didn't record task_id.
 *
 * Returns the run_id, or null if no skill_runs match (which means the agent
 * wasn't using any skill — so no skill mutation can be triggered. That's the
 * v0.18.9 case the user surfaced; the architectural fix is Step 1 + Step 3.).
 */
async function findRejectedSkillRun(
  projectHash:    string,
  rejectedAgent:  string,
  task:           string,
  mergeCreatedAt: string | null,
): Promise<{ run_id: string; skill_id: string } | null> {
  return await withClient(async (c) => {
    // Strategy 1: task_id match. skill_runs_pg.task_id is the canonical link.
    const exact = await c.query<{ run_id: string; skill_id: string }>(
      `SELECT run_id, skill_id FROM skill_runs_pg
        WHERE project_hash = $1 AND task_id = $2
        ORDER BY ts DESC LIMIT 1`,
      [projectHash, task],
    );
    if (exact.rows[0]) return exact.rows[0];

    // Strategy 2: time-window match.
    const windowEnd = new Date().toISOString();
    const windowStart = mergeCreatedAt ?? new Date(Date.now() - 3600_000).toISOString();
    const fallback = await c.query<{ run_id: string; skill_id: string }>(
      `SELECT run_id, skill_id FROM skill_runs_pg
        WHERE project_hash = $1
          AND ts BETWEEN $2 AND $3
        ORDER BY ts DESC LIMIT 1`,
      [projectHash, windowStart, windowEnd],
    );
    return fallback.rows[0] ?? null;
  });
}

/**
 * Update the matched skill_run with low outcome_score so the mutator
 * auto-spawn detector picks it up on the next tick. Idempotent: only
 * updates if outcome_score IS NULL or > 0.5 (don't downgrade an already-
 * lower score).
 */
async function flagSkillRunFailed(
  runId:        string,
  rejectReason: string,
): Promise<boolean> {
  try {
    return await withClient(async (c) => {
      const r = await c.query(
        `UPDATE skill_runs_pg
            SET outcome_score = 0.2,
                status        = 'failed',
                failure_trace = COALESCE(failure_trace, '') ||
                                CASE WHEN failure_trace IS NULL OR failure_trace = ''
                                     THEN ''
                                     ELSE E'\\n---\\n' END ||
                                'orchestrator_reject@' || now()::text || ': ' || $2
          WHERE run_id = $1
            AND (outcome_score IS NULL OR outcome_score > 0.5)
          RETURNING run_id`,
        [runId, rejectReason],
      );
      return (r.rowCount ?? 0) > 0;
    });
  } catch (e) {
    logger.error("outcomes", "reject_resolver_skill_run_flag_failed", {
      error: (e as Error).message, run_id: runId,
    });
    return false;
  }
}

/**
 * Persist the rejection summary into working memory under a structured key
 * so the rejected agent picks it up via zc_recall_context next session.
 *
 * Key format: `reject_<task>_<short>` — importance=4 so it survives eviction
 * but doesn't crowd out [★5] critical facts.
 */
async function rememberRejection(
  projectPath:    string,
  rejectedAgent:  string,
  task:           string,
  reason:         string | undefined,
  summary:        string | undefined,
): Promise<boolean> {
  try {
    // Lazy import to avoid pulling memory.ts into telemetry-only code paths
    const { rememberFact } = await import("./memory.js");
    const shortTask = task.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
    const key = `reject_${shortTask}_${Date.now().toString(36)}`;
    const value = `Last attempt at "${task}" was REJECTED by orchestrator. ` +
      `Reason: ${reason ?? summary ?? "unspecified"}. ` +
      `Agent: ${rejectedAgent}. ` +
      `Before retrying, address the rejection criteria explicitly in your MERGE summary.`;
    rememberFact(projectPath, key, value, 4, rejectedAgent, "EXTRACTED");
    return true;
  } catch (e) {
    logger.error("outcomes", "reject_resolver_memory_write_failed", {
      error: (e as Error).message,
    });
    return false;
  }
}

/**
 * Top-level entry point. Called fire-and-forget from the broadcast
 * endpoint. Returns a resolution receipt for logging; throws never.
 */
export async function resolveRejectOutcome(input: RejectInput): Promise<RejectResolution> {
  const result: RejectResolution = {
    outcome_id:           null,
    rejected_agent_id:    null,
    merge_broadcast_id:   null,
    flagged_skill_run_id: null,
    learnings_appended:   false,
    memory_written:       false,
  };

  if (!input.task) {
    logger.info("outcomes", "reject_resolver_skipped", {
      reason: "no task field on REJECT broadcast",
      project_path: input.projectPath,
    });
    return result;
  }

  try {
    const projectHash = projectHashOf(input.projectPath);

    // 1. Identify the rejected agent (look back at MERGE broadcasts)
    const merge = await findRejectedMerge(projectHash, input.task, input.rejectBroadcastId);
    if (!merge) {
      logger.warn("outcomes", "reject_resolver_no_merge_found", {
        task: input.task, project_hash: projectHash, reject_id: input.rejectBroadcastId,
      });
      return result;
    }
    result.rejected_agent_id  = merge.agent_id;
    result.merge_broadcast_id = merge.id;

    // 2. Write outcome row
    const outcomeId = await writeOutcomeRow(
      projectHash, merge.agent_id, input.task,
      input.rejectBroadcastId, merge.id,
      input.reason, input.summary,
    );
    result.outcome_id = outcomeId;

    // 3. Append failure learning JSONL
    result.learnings_appended = appendFailureLearning(
      input.projectPath, merge.agent_id, input.task, input.reason, input.summary,
    );

    // 4. Flag matching skill_run as failed (if any)
    const matched = await findRejectedSkillRun(
      projectHash, merge.agent_id, input.task, merge.created_at,
    );
    if (matched) {
      const flagged = await flagSkillRunFailed(matched.run_id, input.reason ?? input.summary ?? "orchestrator REJECT");
      if (flagged) {
        result.flagged_skill_run_id = matched.run_id;
        logger.info("outcomes", "reject_resolver_skill_run_flagged", {
          run_id: matched.run_id, skill_id: matched.skill_id,
          rejected_agent: merge.agent_id, task: input.task,
        });
      }
    }

    // 5. Persist to working memory for cross-session self-correction
    result.memory_written = await rememberRejection(
      input.projectPath, merge.agent_id, input.task, input.reason, input.summary,
    );

    logger.info("outcomes", "reject_resolver_resolved", {
      outcome_id:        outcomeId,
      rejected_agent:    merge.agent_id,
      task:              input.task,
      flagged_skill_run: result.flagged_skill_run_id,
      learnings:         result.learnings_appended,
      memory:            result.memory_written,
    });
    return result;
  } catch (e) {
    logger.error("outcomes", "reject_resolver_unhandled", {
      error: (e as Error).message, stack: (e as Error).stack,
      project_path: input.projectPath, task: input.task,
    });
    return result;
  }
}
