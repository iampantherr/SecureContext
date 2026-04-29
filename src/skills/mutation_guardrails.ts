/**
 * Mutation guardrails (v0.18.1)
 * ==============================
 *
 * Cost + cadence protection for the L1 outcome-triggered mutation path.
 * Checks 3 things before enqueuing a mutation request:
 *
 *   1. Cooldown: ≥ 6h since the last mutation for this skill (env-tunable)
 *   2. Failure threshold: ≥ 3 failures in last 10 runs (env-tunable)
 *   3. Daily cap: ≤ 5 mutations queued per project per day (env-tunable)
 *
 * All thresholds operator-tunable via env vars:
 *   ZC_MUTATION_COOLDOWN_HOURS         — default 6
 *   ZC_MUTATION_FAILURE_THRESHOLD      — default 3
 *   ZC_MUTATION_FAILURE_WINDOW         — default 10 (recent runs to count)
 *   ZC_MUTATION_DAILY_CAP_PER_PROJECT  — default 5
 *
 * Returns a structured decision so callers can log the reason regardless
 * of whether the mutation fires.
 */

import type { DatabaseSync } from "node:sqlite";
import { getRecentSkillRuns, getRecentMutations } from "./storage.js";

export interface GuardrailDecision {
  /** True iff all guardrails pass; safe to enqueue. */
  trigger: boolean;
  /** Human + machine-readable explanation. Always populated. */
  reason: string;
  /** Diagnostic counters — useful for logging + dashboards. */
  metrics: {
    failures_in_window:   number;
    failure_threshold:    number;
    failure_window:       number;
    cooldown_hours:       number;
    last_mutation_age_h:  number | null;  // null if no prior mutation
    todays_mutations:     number;
    daily_cap:            number;
  };
}

function envInt(name: string, defaultVal: number): number {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : defaultVal;
}

/**
 * Decide whether an L1 mutation should fire for `skill_id` in `project_path`.
 *
 * `db` is the project's SQLite handle (used to query recent runs + mutations).
 * The PG mirror has the same data when ZC_TELEMETRY_BACKEND=postgres|dual,
 * but for the guardrail check we use the local SQLite — fewer round-trips
 * and the data is mirrored on each write so it's always fresh.
 *
 * The function is sync-safe to call from inside outcome resolvers that
 * already have the SQLite handle open.
 */
export function checkMutationGuardrails(
  db: DatabaseSync,
  skill_id: string,
): GuardrailDecision {
  const COOLDOWN_HOURS    = envInt("ZC_MUTATION_COOLDOWN_HOURS",        6);
  const FAILURE_THRESHOLD = envInt("ZC_MUTATION_FAILURE_THRESHOLD",     3);
  const FAILURE_WINDOW    = envInt("ZC_MUTATION_FAILURE_WINDOW",        10);
  const DAILY_CAP         = envInt("ZC_MUTATION_DAILY_CAP_PER_PROJECT", 5);

  // 1. Cooldown — most-recent mutation for this skill
  const recentMutations = getRecentMutations(db, skill_id, 1);
  let last_mutation_age_h: number | null = null;
  if (recentMutations.length > 0) {
    const mutTs = new Date(recentMutations[0].created_at).getTime();
    last_mutation_age_h = (Date.now() - mutTs) / 3_600_000;
    if (last_mutation_age_h < COOLDOWN_HOURS) {
      return {
        trigger: false,
        reason: `cooldown active: last mutation ${last_mutation_age_h.toFixed(1)}h ago (need ≥${COOLDOWN_HOURS}h)`,
        metrics: { failures_in_window: 0, failure_threshold: FAILURE_THRESHOLD, failure_window: FAILURE_WINDOW, cooldown_hours: COOLDOWN_HOURS, last_mutation_age_h, todays_mutations: 0, daily_cap: DAILY_CAP },
      };
    }
  }

  // 2. Failure threshold
  const recentRuns = getRecentSkillRuns(db, skill_id, FAILURE_WINDOW);
  const failures = recentRuns.filter((r) => r.status !== "succeeded" || (r.outcome_score !== null && r.outcome_score < 0.5)).length;
  if (failures < FAILURE_THRESHOLD) {
    return {
      trigger: false,
      reason: `only ${failures} failures in last ${recentRuns.length} runs (need ≥ ${FAILURE_THRESHOLD})`,
      metrics: { failures_in_window: failures, failure_threshold: FAILURE_THRESHOLD, failure_window: FAILURE_WINDOW, cooldown_hours: COOLDOWN_HOURS, last_mutation_age_h, todays_mutations: 0, daily_cap: DAILY_CAP },
    };
  }

  // 3. Daily cap — count today's mutations across ALL skills in this project
  // We look at skill_mutations.created_at — any mutation today, regardless of which skill
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const todaysMutations = (db.prepare(
    `SELECT COUNT(*) AS n FROM skill_mutations WHERE created_at >= ?`
  ).get(todayIso) as { n: number }).n;
  if (todaysMutations >= DAILY_CAP) {
    return {
      trigger: false,
      reason: `daily cap reached: ${todaysMutations} mutations today (cap ${DAILY_CAP})`,
      metrics: { failures_in_window: failures, failure_threshold: FAILURE_THRESHOLD, failure_window: FAILURE_WINDOW, cooldown_hours: COOLDOWN_HOURS, last_mutation_age_h, todays_mutations: todaysMutations, daily_cap: DAILY_CAP },
    };
  }

  return {
    trigger: true,
    reason: `passed: ${failures} failures, last mut ${last_mutation_age_h === null ? "never" : last_mutation_age_h.toFixed(1) + "h"} ago, ${todaysMutations}/${DAILY_CAP} today`,
    metrics: { failures_in_window: failures, failure_threshold: FAILURE_THRESHOLD, failure_window: FAILURE_WINDOW, cooldown_hours: COOLDOWN_HOURS, last_mutation_age_h, todays_mutations: todaysMutations, daily_cap: DAILY_CAP },
  };
}
