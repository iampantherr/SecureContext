/**
 * v0.28.0-α — Skill-spotter dry-run orchestrator.
 *
 * Calls the detector library, persists a run + each signal to PG, returns
 * the structured result so the API + dashboard can show it.
 *
 * "Dry-run" means: signals are emitted as `outcome='observed'` — no
 * candidates are filed in skill_candidates_pg, no LLM is invoked. That's
 * v0.28.0-β's job; α just validates the signal quality first.
 */

import { randomUUID } from "node:crypto";
import { withClient } from "../../pg_pool.js";
import { logger } from "../../logger.js";
import { runAllDetectors, type SkillSignal, type DetectorOptions } from "./detectors.js";

export interface SpotterRunSummary {
  run_id:           string;
  mode:             "dry-run" | "llm-proposed" | "llm-approved";
  window_days:      number;
  window_start:     string;
  window_end:       string;
  duration_ms:      number;
  signals_emitted:  number;
  signals_by_type:  Record<string, number>;
  /** Inline preview — first N signals so the caller doesn't need a second round-trip. */
  signals_preview:  Array<SkillSignal & { signal_id: number }>;
}

/**
 * Run all detectors, persist the run + signals, return the summary.
 * α writes outcome='observed' for every signal; β will mutate them.
 */
export async function runSpotterDryRun(opts: DetectorOptions = {}): Promise<SpotterRunSummary> {
  const t0 = Date.now();
  const runId = randomUUID();
  const windowDays = opts.windowDays ?? 7;
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 86400_000);

  // Open the run row first so even a partial detector failure leaves a record
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO skill_spotter_runs_pg
         (run_id, started_at, window_days, window_start, window_end, mode)
       VALUES ($1, NOW(), $2, $3, $4, 'dry-run')`,
      [runId, windowDays, windowStart.toISOString(), windowEnd.toISOString()],
    );
  });

  let signals: SkillSignal[] = [];
  try {
    signals = await runAllDetectors(opts);
  } catch (e) {
    logger.error("skills", "spotter_detectors_failed", {
      run_id: runId, error: (e as Error).message,
    });
  }

  // Persist signals + collect their assigned IDs for the inline preview
  const insertedRows: Array<{ signal_id: number; signal: SkillSignal }> = [];
  for (const sig of signals) {
    try {
      const ins = await withClient(async (c) => {
        const r = await c.query<{ signal_id: number }>(
          `INSERT INTO skill_spotter_signals_pg
             (run_id, signal_type, occurrences, confidence, evidence,
              proposed_trigger, proposed_steps, proposed_name_hint,
              effort_estimate, outcome)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, 'observed')
           RETURNING signal_id`,
          [
            runId,
            sig.signal_type,
            sig.occurrences,
            sig.confidence,
            JSON.stringify(sig.evidence),
            sig.proposed_trigger ?? null,
            sig.proposed_steps ? JSON.stringify(sig.proposed_steps) : null,
            sig.proposed_name_hint ?? null,
            sig.effort_estimate ?? null,
          ],
        );
        return r.rows[0];
      });
      insertedRows.push({ signal_id: ins.signal_id, signal: sig });
    } catch (e) {
      logger.warn("skills", "spotter_signal_insert_failed", {
        run_id: runId, signal_type: sig.signal_type, error: (e as Error).message,
      });
    }
  }

  const durationMs = Date.now() - t0;
  await withClient(async (c) => {
    await c.query(
      `UPDATE skill_spotter_runs_pg
          SET finished_at = NOW(),
              signals_emitted = $2,
              duration_ms = $3
        WHERE run_id = $1`,
      [runId, insertedRows.length, durationMs],
    );
  });

  // Group by type for the summary
  const byType: Record<string, number> = {};
  for (const sig of signals) {
    byType[sig.signal_type] = (byType[sig.signal_type] ?? 0) + 1;
  }

  logger.info("skills", "spotter_dry_run_complete", {
    run_id: runId, signals_emitted: insertedRows.length,
    duration_ms: durationMs, by_type: byType,
  });

  return {
    run_id:          runId,
    mode:            "dry-run",
    window_days:     windowDays,
    window_start:    windowStart.toISOString(),
    window_end:      windowEnd.toISOString(),
    duration_ms:     durationMs,
    signals_emitted: insertedRows.length,
    signals_by_type: byType,
    signals_preview: insertedRows.slice(0, 25).map((r) => ({ ...r.signal, signal_id: r.signal_id })),
  };
}

/**
 * Read historic spotter runs for the dashboard list view.
 */
export async function listSpotterRuns(limit = 20): Promise<Array<{
  run_id:         string;
  started_at:     string;
  mode:           string;
  window_days:    number;
  signals_emitted: number;
  candidates_filed: number;
  duration_ms:    number | null;
}>> {
  return await withClient(async (c) => {
    const r = await c.query(
      `SELECT run_id::text, started_at::text, mode, window_days, signals_emitted,
              candidates_filed, duration_ms
         FROM skill_spotter_runs_pg
        ORDER BY started_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(200, limit))],
    );
    return r.rows as Array<{
      run_id: string; started_at: string; mode: string; window_days: number;
      signals_emitted: number; candidates_filed: number; duration_ms: number | null;
    }>;
  });
}

/**
 * Read signals from one specific run.
 */
export async function listSpotterSignals(runId: string, limit = 100): Promise<Array<{
  signal_id:        number;
  signal_type:      string;
  occurrences:      number;
  confidence:       number;
  evidence:         unknown;
  proposed_trigger: string | null;
  proposed_steps:   unknown;
  proposed_name_hint: string | null;
  effort_estimate:  string | null;
  outcome:          string;
  outcome_reason:   string | null;
}>> {
  return await withClient(async (c) => {
    const r = await c.query(
      `SELECT signal_id, signal_type, occurrences, confidence, evidence,
              proposed_trigger, proposed_steps, proposed_name_hint,
              effort_estimate, outcome, outcome_reason
         FROM skill_spotter_signals_pg
        WHERE run_id = $1
        ORDER BY occurrences DESC, signal_id ASC
        LIMIT $2`,
      [runId, Math.max(1, Math.min(500, limit))],
    );
    return r.rows as Array<{
      signal_id: number; signal_type: string; occurrences: number;
      confidence: number; evidence: unknown; proposed_trigger: string | null;
      proposed_steps: unknown; proposed_name_hint: string | null;
      effort_estimate: string | null; outcome: string; outcome_reason: string | null;
    }>;
  });
}
