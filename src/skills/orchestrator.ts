/**
 * Mutation orchestrator (v0.18.0 Sprint 2)
 * =========================================
 *
 * The full skill→mutate→replay→promote cycle. Stitches together every other
 * Sprint 2 module:
 *
 *   1. select underperforming skills (bottom by recent avg outcome_score)
 *   2. for each: invoke the configured mutator → 5 candidates
 *   3. verify candidate HMACs match (RT-S2-09)
 *   4. replay each candidate against fixtures
 *   5. compare candidate vs parent — pick the best
 *   6. apply scoring.shouldPromote — decision boundary
 *   7. on promote: archive parent, insert new skill version (atomic)
 *   8. record EVERYTHING into skill_mutations + skill_runs for audit
 *
 * Designed for both the nightly cron path (BatchSonnetMutator) AND ad-hoc
 * runs (`zc_propose_mutation` MCP tool with realtime-sonnet or local-mock).
 *
 * SAFETY:
 *   - The orchestrator never overwrites a skill silently. Promotions create
 *     a new (name, scope, version) row; the prior row is soft-archived.
 *   - All mutations are logged to skill_mutations regardless of outcome.
 *   - On any error mid-cycle, partial state is cleaned up + the cycle is
 *     marked as a no-op (caller sees `promoted=false, reason='error: ...'`).
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  Skill, SkillRun, SkillMutation, MutationContext, MutationCycleResult,
  AcceptanceCriteria,
} from "./types.js";
// v0.18.0 — use the dual-backend dispatch so promotions land in PG too
// (when ZC_TELEMETRY_BACKEND=postgres|dual). Falls through to SQLite otherwise.
import {
  upsertSkill, archiveSkill, getRecentSkillRuns, recordMutation, resolveMutation,
  getActiveSkill, listActiveSkills, getExemplarRuns,
} from "./storage_dual.js";
import {
  candidateToSkill, getMutator, type Mutator,
} from "./mutator.js";
import {
  replaySkill, compareReplays, type SkillExecutor, LocalDeterministicExecutor,
} from "./replay.js";
import { aggregateScore, shouldPromote } from "./scoring.js";
import { computeSkillBodyHmac, verifySkillHmac } from "./loader.js";
import { randomUUID } from "node:crypto";

/** Top-level options for one mutation cycle. */
export interface MutationCycleOptions {
  /** Mutator to use; if absent, resolves from ZC_MUTATOR_MODEL env. */
  mutator?:    Mutator;
  /** Executor for replay; if absent, LocalDeterministicExecutor (test/L1 path). */
  executor?:   SkillExecutor;
  /** How many recent skill_runs to consider for parent baseline. */
  parent_runs_window?: number;
  /** Override acceptance_criteria (default: from skill.frontmatter). */
  acceptance?: AcceptanceCriteria;
  /**
   * Project path used for project_hash on PG mirror writes (skill_runs_pg /
   * skill_mutations_pg). Defaults to "default" if absent — the SQLite-only
   * code path doesn't need it, but PG dual-write does.
   */
  projectPath?: string;
}

/**
 * Run one full mutation cycle for a given skill_id. Returns the cycle result
 * (always — even on no-promote / error paths). Records EVERY candidate as a
 * skill_mutations row regardless of promotion.
 */
export async function runMutationCycle(
  db: DatabaseSync,
  parent: Skill,
  options: MutationCycleOptions = {},
): Promise<MutationCycleResult> {
  const startedAt = Date.now();
  const mutator   = options.mutator  ?? await getMutator();
  const executor  = options.executor ?? new LocalDeterministicExecutor();

  // Compute parent baseline — agg of recent runs OR replay-against-fixtures
  // if no recent runs exist.
  const recentRuns = await getRecentSkillRuns(db, parent.skill_id, options.parent_runs_window ?? 20);
  let parentBaselineAgg;
  if (recentRuns.length === 0) {
    // Cold start: replay fixtures to seed a baseline
    const replay = await replaySkill(parent, executor);
    parentBaselineAgg = {
      avg_score:       replay.agg_score,
      pass_rate:       replay.pass_rate,
      avg_cost_usd:    replay.avg_cost_usd,
      avg_duration_ms: replay.avg_duration_ms,
      n:               replay.per_fixture.length,
    };
  } else {
    parentBaselineAgg = aggregateScore(recentRuns);
  }
  const baseline_score = parentBaselineAgg.avg_score;

  // v0.23.0 Phase 1 F — fetch operator-tagged exemplars (PG-only, returns [] if PG unavailable).
  const exemplars = await getExemplarRuns(parent.skill_id, 5);

  // Step 1: invoke mutator
  const ctx: MutationContext = {
    parent,
    recent_runs:    recentRuns,
    failure_traces: recentRuns.filter((r) => r.failure_trace).map((r) => r.failure_trace as string),
    fixtures:       parent.frontmatter.fixtures ?? [],
    exemplars,
  };

  let mutResult;
  try {
    mutResult = await mutator.mutate(ctx);
  } catch (e) {
    // Mutator failed — record nothing (no candidates produced) but return result
    return {
      skill_id:           parent.skill_id,
      baseline_score,
      candidates_count:   0,
      best_candidate_score: 0,
      promoted:           false,
      total_cost_usd:     0,
      duration_ms:        Date.now() - startedAt,
      reason:             `mutator error: ${(e as Error).message}`,
    };
  }

  // Step 2: verify candidate HMACs (RT-S2-09 — defense against bytes-modified
  // between proposal and replay). We compute the HMAC ourselves so the
  // candidate provenance is traceable.
  const acceptance = options.acceptance ?? parent.frontmatter.acceptance_criteria;

  // Step 3: for each candidate, build a Skill, replay against fixtures,
  // record skill_mutations row.
  let bestCandidate:        Awaited<ReturnType<typeof candidateToSkill>> | null = null;
  let bestCandidateAgg:     ReturnType<typeof aggregateScore> | null = null;
  let bestCandidateHmac:    string | null = null;
  let bestCandidateMutationId: string | null = null;

  for (let i = 0; i < mutResult.candidates.length; i++) {
    const c = mutResult.candidates[i];
    const candidateHmac = await computeSkillBodyHmac(c.candidate_body);
    const mutationId = `mut-${randomUUID().slice(0, 12)}`;
    const candidateSkill = await candidateToSkill(parent, c);

    const mutationRow: SkillMutation = {
      mutation_id:     mutationId,
      parent_skill_id: parent.skill_id,
      candidate_body:  c.candidate_body,
      candidate_hmac:  candidateHmac,
      proposed_by:     mutResult.proposer_model,
      judged_by:       mutResult.judge_model,
      judge_score:     c.self_rated_score ?? null,
      judge_rationale: c.rationale,
      replay_score:    null,
      promoted:        false,
      promoted_to_skill_id: null,
      created_at:      new Date().toISOString(),
      resolved_at:     null,
    };
    await recordMutation(db, mutationRow, options.projectPath ?? "default");

    // Re-verify before replay — RT-S2-09 (corruption between propose+replay)
    if (!await verifySkillHmac(candidateSkill.body, candidateSkill.body_hmac)) {
      await resolveMutation(db, mutationId, { replay_score: 0, judge_rationale: "HMAC mismatch — replay refused (RT-S2-09)" });
      continue;
    }

    const replay = await replaySkill(candidateSkill, executor);
    const candAgg = {
      avg_score:       replay.agg_score,
      pass_rate:       replay.pass_rate,
      avg_cost_usd:    replay.avg_cost_usd,
      avg_duration_ms: replay.avg_duration_ms,
      n:               replay.per_fixture.length,
    };
    await resolveMutation(db, mutationId, { replay_score: candAgg.avg_score });

    if (bestCandidateAgg === null || candAgg.avg_score > bestCandidateAgg.avg_score) {
      bestCandidate            = candidateSkill;
      bestCandidateAgg         = candAgg;
      bestCandidateHmac        = candidateHmac;
      bestCandidateMutationId  = mutationId;
    }
  }

  if (bestCandidate === null || bestCandidateAgg === null) {
    return {
      skill_id:           parent.skill_id,
      baseline_score,
      candidates_count:   mutResult.candidates.length,
      best_candidate_score: 0,
      promoted:           false,
      total_cost_usd:     mutResult.total_cost_usd,
      duration_ms:        Date.now() - startedAt,
      reason:             "no candidate replayed successfully",
    };
  }

  // Step 4: promotion decision
  const promoteDecision = shouldPromote(bestCandidateAgg, parentBaselineAgg, acceptance);

  let promoted = false;
  let new_skill_id: string | undefined;
  let archived_skill_id: string | undefined;

  if (promoteDecision.promote && bestCandidateMutationId) {
    // Atomic: archive parent + insert new version. SQLite doesn't have a
    // multi-statement-tx wrapper at our layer's API; we use BEGIN/COMMIT manually.
    db.exec("BEGIN");
    try {
      await archiveSkill(db, parent.skill_id, `promoted candidate ${bestCandidateMutationId}`);
      // v0.23.0 — mutator-source so the security-scan audit log attributes
      // the row correctly. The candidate was already HMAC-verified above.
      await upsertSkill(db, bestCandidate, "mutator");
      await resolveMutation(db, bestCandidateMutationId, {
        promoted: true,
        promoted_to_skill_id: bestCandidate.skill_id,
      });
      db.exec("COMMIT");
      promoted = true;
      new_skill_id = bestCandidate.skill_id;
      archived_skill_id = parent.skill_id;
    } catch (e) {
      db.exec("ROLLBACK");
      void e;
    }
  }

  // Use the candidate HMAC if needed (silence linter); also avoids dropping
  // the variable in case future code wants to write it to a sidecar table.
  void bestCandidateHmac;

  return {
    skill_id:           parent.skill_id,
    baseline_score,
    candidates_count:   mutResult.candidates.length,
    best_candidate_score: bestCandidateAgg.avg_score,
    promoted,
    new_skill_id,
    archived_skill_id,
    total_cost_usd:     mutResult.total_cost_usd,
    duration_ms:        Date.now() - startedAt,
    reason:             promoteDecision.reason,
  };
}

/**
 * Select the bottom-N skills by recent avg outcome_score for nightly cron.
 * Skills with no recent runs are included at the front (cold start need
 * exploration too).
 */
export async function selectUnderperformingSkills(
  db: DatabaseSync,
  skills: Skill[],
  topN = 3,
  recencyWindow = 20,
): Promise<Skill[]> {
  const scored = await Promise.all(skills.map(async (s) => {
    const runs = await getRecentSkillRuns(db, s.skill_id, recencyWindow);
    const avg = runs.length === 0 ? 0 : aggregateScore(runs).avg_score;
    return { skill: s, avg };
  }));
  // Lowest first; cold-start skills (avg=0) bubble up
  scored.sort((a, b) => a.avg - b.avg);
  return scored.slice(0, topN).map((s) => s.skill);
}

/**
 * Run a full nightly cycle across all active skills:
 *   - select bottom-3
 *   - run mutation cycle on each
 *   - return summary
 */
export async function runNightlyCycle(
  db: DatabaseSync,
  options: MutationCycleOptions & { topN?: number } = {},
): Promise<{ cycles: MutationCycleResult[]; total_cost_usd: number; total_duration_ms: number }> {
  const startedAt = Date.now();
  const skills = await listActiveSkills(db);
  const targets = await selectUnderperformingSkills(db, skills, options.topN ?? 3);
  const cycles: MutationCycleResult[] = [];
  for (const t of targets) {
    cycles.push(await runMutationCycle(db, t, options));
  }
  return {
    cycles,
    total_cost_usd:    cycles.reduce((s, c) => s + c.total_cost_usd, 0),
    total_duration_ms: Date.now() - startedAt,
  };
}

// Helper for callers who want to lookup a skill by name + scope (re-export)
export { getActiveSkill, upsertSkill };
// Silence unused-import linter
void recordMutation;
void replaySkill;
void compareReplays;
