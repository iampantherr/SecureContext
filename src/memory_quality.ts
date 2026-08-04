/**
 * Memory quality for multi-agent work (v0.51.0).
 *
 * Built after measuring a real multi-agent project (A2A_communication, 3 agents,
 * ~2 days of continuous delivery) and finding three quantified problems that
 * degrade recall exactly when a fleet needs it most:
 *
 *   1. IMPORTANCE INFLATION. 655 of 1117 live facts (59%) were importance 5,
 *      against a documented soft cap of 25 per namespace. When 59% of memory is
 *      "critical", importance stops discriminating and both ranking and eviction
 *      degrade to insertion order. The soft cap only WARNS at write time, and a
 *      warning that fires on more than half of writes stops being read.
 *
 *   2. ROLE ASYMMETRY. Private fact counts were orchestrator 280, developer 190,
 *      qa 9 — a 20-30x spread. Meanwhile the SHARED pool (593) was larger than
 *      any private one, so every agent loads mostly other roles' coordination
 *      markers. The verification role — whose knowledge (what was tested, which
 *      traps exist) is the most expensive to re-derive — was the most crowded out.
 *
 *   3. CONSTRAINT LOSS. When a worker was retired and relaunched mid-phase, the
 *      operator's standing "never terminate these agents" rule died with its
 *      context and the replacement destroyed protected resources. Constraints
 *      lived in prose in an agent's context window, not in memory, so nothing
 *      survived the restart and nothing re-injected them.
 *
 * Everything here is a PURE function so the SQLite and PG recall paths can share
 * it and rank identically (same contract as salience.ts). Every behaviour is
 * kill-switched to a byte-identical no-op, per this repo's env-pinning rule.
 */
import { Config } from "./config.js";

/** Fact shape this module needs. Deliberately structural — both stores satisfy it. */
export interface QualityRankable {
  key:               string;
  importance:        number;
  agent_id?:         string | null;
  kind?:             string | null;
  created_at?:       string | Date | null;
  last_retrieved_at?: string | Date | null;
}

// ─── 1. Pinned classes (constraints and anti-patterns) ───────────────────────
/**
 * Facts that must NEVER be dropped by the recall budget.
 *
 * Two kinds earn this:
 *   - 'constraint'  — standing operator rules ("never terminate agents X,Y,Z",
 *     "no pushes without approval"). The protected-agent incident happened
 *     because a constraint lived only in a context window and did not survive a
 *     worker relaunch. A constraint that can be truncated is not a constraint.
 *   - 'antipattern' — hard-won "we already made this mistake" knowledge. Its
 *     entire value is being present BEFORE the mistake recurs; a lesson that
 *     collapses into a tail index has already failed.
 *
 * Pinning is bounded (PINNED_MAX_FACTS) so a runaway writer cannot consume the
 * whole budget with self-declared constraints.
 */
export const PINNED_KINDS = new Set(["constraint", "antipattern"]);

export function isPinnedKind(f: QualityRankable): boolean {
  if (!Config.PIN_CONSTRAINTS) return false;
  return PINNED_KINDS.has((f.kind ?? "").trim().toLowerCase());
}

/**
 * Split facts into [pinned, rest], preserving relative order within each group
 * and capping how many facts may be pinned. Callers render pinned first and
 * exempt them from truncation.
 */
export function partitionPinned<F extends QualityRankable>(facts: F[]): { pinned: F[]; rest: F[] } {
  if (!Config.PIN_CONSTRAINTS) return { pinned: [], rest: facts };
  const cap = Math.max(0, Config.PINNED_MAX_FACTS);
  const pinned: F[] = [];
  const rest: F[] = [];
  for (const f of facts) {
    if (isPinnedKind(f) && pinned.length < cap) pinned.push(f);
    else rest.push(f);
  }
  return { pinned, rest };
}

// ─── 2. Memory health (surfacing the imbalance) ──────────────────────────────
export interface MemoryHealth {
  totalFacts:        number;
  imp5Count:         number;
  imp5Pct:           number;
  /** Live facts per agent namespace, descending. */
  byAgent:           Array<{ agent_id: string; facts: number }>;
  /** Roles whose private fact count is far below the busiest role. */
  underRecording:    string[];
  pinnedCount:       number;
  warnings:          string[];
}

/**
 * Compute health from a fact list. Pure so it can be unit-tested and run against
 * either store. The point is to make the two measured pathologies VISIBLE —
 * importance inflation and role asymmetry — because neither is detectable from
 * a single recall, which is exactly why both persisted unnoticed.
 */
export function computeMemoryHealth(facts: QualityRankable[]): MemoryHealth {
  const total = facts.length;
  const imp5 = facts.filter(f => f.importance >= 5).length;
  const counts = new Map<string, number>();
  for (const f of facts) {
    const a = (f.agent_id ?? "default").trim() || "default";
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const byAgent = [...counts.entries()]
    .map(([agent_id, n]) => ({ agent_id, facts: n }))
    .sort((a, b) => b.facts - a.facts);

  const privates = byAgent.filter(a => a.agent_id !== "default");
  const busiest = privates.length ? privates[0].facts : 0;
  const underRecording = privates
    .filter(a => busiest > 0 && a.facts * 10 < busiest)   // an order of magnitude behind
    .map(a => a.agent_id);

  const pinned = facts.filter(f => PINNED_KINDS.has((f.kind ?? "").trim().toLowerCase())).length;

  const warnings: string[] = [];
  const pct = total ? (imp5 / total) * 100 : 0;
  if (pct > 25) {
    warnings.push(
      `${imp5}/${total} facts (${pct.toFixed(0)}%) are importance-5. Above ~25% the importance axis stops ` +
      `discriminating and ranking degrades toward insertion order. Demote or expire the stale ones.`);
  }
  if (underRecording.length) {
    warnings.push(
      `Role(s) ${underRecording.join(", ")} hold an order of magnitude fewer private facts than the busiest ` +
      `role (${busiest}). Their session knowledge is likely living in files that do not survive a restart.`);
  }
  if (Config.PIN_CONSTRAINTS && pinned === 0 && total > 50) {
    warnings.push(
      `No 'constraint' or 'antipattern' facts recorded. Standing rules and known traps are only surviving in ` +
      `context windows, which do not outlive an agent relaunch.`);
  }
  return { totalFacts: total, imp5Count: imp5, imp5Pct: Number(pct.toFixed(1)), byAgent, underRecording, pinnedCount: pinned, warnings };
}
