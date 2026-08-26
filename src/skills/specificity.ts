/**
 * Failure-specificity assessment (v0.61.0 — mutation engine M3c)
 * ================================================================
 *
 * Operator's rule: when a BROAD (global) skill fails on one very specific
 * project, narrowing the broad skill to fit that case is NOT a desired
 * outcome — the fix is a project-scoped complement skill that supersedes the
 * broad one inside that project (resolveSkill already prefers project scope
 * over global for the same name).
 *
 * Pure data over the runs already fetched for the cycle — no model call.
 */
import type { Skill, SkillRun } from "./types.js";

export interface SpecificityAssessment {
  fork:          boolean;
  project_hash?: string;
  reason:        string;
}

const MIN_FAILURES        = 3;
const CONCENTRATION_MIN   = 0.8;  // ≥80% of failures from one project
const OTHER_HEALTHY_MIN   = 0.7;  // avg elsewhere must show the skill works broadly
const OTHER_MIN_RUNS      = 3;

function isFailure(r: SkillRun): boolean {
  return r.status === "failed" || r.status === "timeout" || (r.outcome_score ?? 1) < 0.5;
}

export function assessFailureSpecificity(parent: Skill, runs: SkillRun[]): SpecificityAssessment {
  if (parent.frontmatter.scope !== "global") {
    return { fork: false, reason: "skill is already project-scoped" };
  }
  const attributed = runs.filter((r) => r.project_hash);
  const failures = attributed.filter(isFailure);
  if (failures.length < MIN_FAILURES) {
    return { fork: false, reason: `only ${failures.length} attributed failures (need ${MIN_FAILURES})` };
  }
  const byProject = new Map<string, number>();
  for (const f of failures) byProject.set(f.project_hash!, (byProject.get(f.project_hash!) ?? 0) + 1);
  const [topHash, topCount] = [...byProject.entries()].sort((a, b) => b[1] - a[1])[0];
  const concentration = topCount / failures.length;
  if (concentration < CONCENTRATION_MIN) {
    return { fork: false, reason: `failures spread across ${byProject.size} projects (top only ${(concentration * 100).toFixed(0)}%) — the broad skill itself is the problem` };
  }
  const others = attributed.filter((r) => r.project_hash !== topHash && r.outcome_score !== null);
  if (others.length < OTHER_MIN_RUNS) {
    return { fork: false, reason: `no evidence the skill is healthy elsewhere (${others.length} runs outside ${topHash.slice(0, 8)})` };
  }
  const otherAvg = others.reduce((s, r) => s + (r.outcome_score ?? 0), 0) / others.length;
  if (otherAvg < OTHER_HEALTHY_MIN) {
    return { fork: false, reason: `skill is unhealthy everywhere (elsewhere avg ${otherAvg.toFixed(2)}) — a broad fix is appropriate` };
  }
  return {
    fork: true,
    project_hash: topHash,
    reason: `${topCount}/${failures.length} failures concentrate in project ${topHash.slice(0, 8)} while elsewhere avg is ${otherAvg.toFixed(2)} over ${others.length} runs — the broad skill works; this project needs a scoped complement`,
  };
}
