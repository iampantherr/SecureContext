/**
 * R8 (v0.43.0) — recall output budget.
 *
 * Shared by the SQLite formatter (memory.ts), the PG proxy renderer (server.ts)
 * and the regression check script, so all paths partition identically.
 *
 * Problem this solves (measured on the live A2A project): 237 live facts ×
 * ~500-char values rendered ~47k tokens per zc_recall_context call. Agents
 * coped by spawning subagents to "digest" the output — slower, lossier, and
 * MORE expensive than the recall it was protecting against. The budget keeps
 * the rendered output bounded: the top-ranked facts render in full, the tail
 * collapses to a grouped index, and nothing is lost — collapsed facts remain
 * retrievable via focused recall or zc_search.
 *
 * Temporal contract (from the operator's "what happened last week" review):
 * facts inside a parsed time window get ABSOLUTE priority over the budget's
 * top tier, and if even they overflow, the notice says exactly how many
 * in-window facts were collapsed — explicit progressive disclosure, never
 * silent truncation.
 */
import { Config } from "./config.js";
import { partitionPinned, PINNED_KINDS } from "./memory_quality.js";

export interface BudgetableFact {
  key: string;
  value: string;
  importance: number;
  agent_id?: string;
  /** v0.51.0 — 'constraint' / 'antipattern' are pinned above the budget. */
  kind?: string | null;
  created_at?: string | Date;
  valid_at?: string | Date | null;
  last_retrieved_at?: string | Date | null;
}

export interface TemporalWindow {
  from?: Date;
  to?: Date;
}

export interface BudgetResult<F> {
  /** Facts to render in full, in their incoming order (in-window first when a window is given). */
  rendered: F[];
  /** Facts collapsed into the tail index. Empty when everything fit. */
  collapsed: F[];
  /** How many collapsed facts fall INSIDE the caller's temporal window (0 when no window). */
  inWindowCollapsed: number;
  /** Ready-to-append tail lines ("" when nothing was collapsed). */
  tailNotice: string;
}

/** Event-time of a fact: valid_at (M3 bi-temporal), falling back to created_at. */
function eventTime(f: BudgetableFact): number {
  const raw = f.valid_at ?? f.created_at;
  if (raw instanceof Date) return raw.getTime();
  const t = Date.parse(String(raw ?? ""));
  return Number.isFinite(t) ? t : NaN;
}

export function isInWindow(f: BudgetableFact, win?: TemporalWindow): boolean {
  if (!win || (!win.from && !win.to)) return false;
  const ev = eventTime(f);
  return (
    Number.isFinite(ev) &&
    (!win.from || ev >= win.from.getTime()) &&
    (!win.to || ev <= win.to.getTime())
  );
}

/**
 * Grouping prefix for the collapsed-tail index. Keys in the wild look like
 * OWNERSHIP_DEV_TASK_X, LEARNING_STALE_BUILD, FEEDBACK_NOTE_..., ckpt_fix1 —
 * the first _/- segment is the de-facto category convention.
 */
export function keyPrefix(key: string): string {
  const seg = String(key).split(/[_\-.]/, 1)[0] ?? key;
  return seg.length >= 2 ? seg : key.slice(0, 8);
}

/** Estimated rendered length of one fact line (key + value + badge/format overhead). */
function estLen(f: BudgetableFact): number {
  return String(f.key).length + String(f.value).length + 24;
}

/**
 * Partition an already-RANKED fact list against the character budget.
 *
 * - Order is never changed except that in-window facts (when `win` is given)
 *   are stably moved to the front — the temporal tier-1 contract.
 * - At least Config.RECALL_MIN_FACTS facts always render, so a pathological
 *   budget cannot blank the recall.
 * - maxChars <= 0 disables budgeting entirely (kill-switch: everything renders).
 */
export function budgetFacts<F extends BudgetableFact>(
  facts: F[],
  opts: { maxChars?: number; win?: TemporalWindow } = {}
): BudgetResult<F> {
  const budget = opts.maxChars ?? Config.RECALL_MAX_CHARS;
  if (budget <= 0 || facts.length === 0) {
    return { rendered: facts, collapsed: [], inWindowCollapsed: 0, tailNotice: "" };
  }


  // Pinned tier-0 (v0.51.0): standing constraints and known anti-patterns are
  // rendered FIRST and are exempt from truncation. A constraint that the budget
  // can collapse into a tail index is not a constraint — that is precisely how
  // an operator's "never terminate these agents" rule was lost across a worker
  // relaunch, after which the replacement destroyed the protected resources.
  // Bounded by PINNED_MAX_FACTS so a runaway writer cannot eat the budget.
  const { pinned, rest } = partitionPinned(facts);

  // Temporal tier-1: stable partition, in-window first (relative order preserved).
  let ordered = rest;
  const hasWin = !!(opts.win && (opts.win.from || opts.win.to));
  if (hasWin) {
    const inWin: F[] = [];
    const outWin: F[] = [];
    for (const f of rest) (isInWindow(f, opts.win) ? inWin : outWin).push(f);
    ordered = [...inWin, ...outWin];
  }

  const minFacts = Math.max(1, Config.RECALL_MIN_FACTS);

  // v0.51.5 — pinned facts have their OWN char budget and do NOT consume the
  // working-context budget.
  //
  // Measured on the live A2A project: once the team started writing real
  // constraints, 12 pinned facts reached 13,220 of the 16,000-char budget — 83%
  // — leaving room for about seven working facts. Charging standing rules
  // against working context sets up a false choice between "know the rules" and
  // "know what is happening", and the agent loses either way. They are different
  // kinds of content and they get different budgets.
  //
  // Pins remain doubly bounded (PINNED_MAX_FACTS and PINNED_MAX_CHARS) so this
  // cannot become an unbounded channel, and anything dropped is announced.
  const pinBudget = Math.max(0, Config.PINNED_MAX_CHARS);
  const rendered: F[] = [];
  const collapsed: F[] = [];
  let pinUsed = 0;
  for (const f of pinned) {
    const len = estLen(f);
    if (pinUsed + len <= pinBudget || rendered.length === 0) {
      rendered.push(f);
      pinUsed += len;
    } else {
      collapsed.push(f);   // announced via the pinned-overflow notice below
    }
  }
  let used = 0;
  for (const f of ordered) {
    const len = estLen(f);
    if (rendered.length < minFacts || used + len <= budget) {
      rendered.push(f);
      used += len;
    } else {
      collapsed.push(f);
    }
  }

  // A pinned fact that overflowed PINNED_MAX_FACTS is still collapsible — that
  // bound is deliberate, so a runaway writer cannot eat the whole budget. But
  // collapsing a constraint SILENTLY is the exact failure this tier exists to
  // prevent, so say it out loud.
  const pinnedOverflow = collapsed.filter(
    (f) => PINNED_KINDS.has(String(f.kind ?? "").trim().toLowerCase())
  ).length;
  const overflowLine =
    pinnedOverflow > 0
      ? `⚠ ${pinnedOverflow} constraint/antipattern fact(s) exceeded the pinned budget ` +
        `(ZC_PINNED_MAX_FACTS=${Config.PINNED_MAX_FACTS}, ZC_PINNED_MAX_CHARS=` +
        `${Config.PINNED_MAX_CHARS}) and were NOT pinned. Raise a limit or prune — ` +
        `a standing rule you cannot see is a standing rule you will break.`
      : "";

  if (collapsed.length === 0) {
    return { rendered, collapsed, inWindowCollapsed: 0, tailNotice: "" };
  }

  const inWindowCollapsed = hasWin
    ? collapsed.filter((f) => isInWindow(f, opts.win)).length
    : 0;

  // Grouped index: counts by key prefix, largest groups first, capped.
  const groups = new Map<string, number>();
  for (const f of collapsed) {
    const p = keyPrefix(f.key);
    groups.set(p, (groups.get(p) ?? 0) + 1);
  }
  const MAX_GROUPS = 12;
  const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, MAX_GROUPS);
  const restCount = sorted.slice(MAX_GROUPS).reduce((a, [, n]) => a + n, 0);
  const idx =
    shown.map(([p, n]) => `${p}_* (${n})`).join(" · ") +
    (restCount > 0 ? ` · other (${restCount})` : "");

  const lines: string[] = [
    "",
    `…${collapsed.length} more facts collapsed to fit the recall budget (ZC_RECALL_MAX_CHARS=${budget}):`,
    `  ${idx}`,
    `  Pull specifics with zc_recall_context {focus:"<topic or time>"} or zc_search — nothing is deleted.`,
  ];
  if (overflowLine) lines.splice(1, 0, overflowLine);
  if (inWindowCollapsed > 0) {
    lines.splice(
      1,
      0,
      `⚠ ${inWindowCollapsed} of the collapsed facts are INSIDE your requested time window — ` +
        `narrow the focus or raise ZC_RECALL_MAX_CHARS to see all of them.`
    );
  }
  return { rendered, collapsed, inWindowCollapsed, tailNotice: lines.join("\n") };
}

/**
 * R8c — staleness demotion for CLASSIC (unfocused) recall ordering.
 *
 * Effective importance for SORTING only: a fact neither retrieved nor created
 * within RECALL_STALE_DAYS sorts as (importance - RECALL_STALE_DEMOTE), so a
 * stale ★5 ranks below a fresh ★3 and falls past the budget first. The stored
 * importance is never mutated and the rendered badge still shows the real ★.
 * RECALL_STALE_DEMOTE=0 ⇒ inert (byte-identical ordering).
 */
export function effectiveImportance(f: BudgetableFact, nowMs: number): number {
  if (Config.RECALL_STALE_DEMOTE <= 0) return f.importance;
  const lastTouchRaw = f.last_retrieved_at ?? f.created_at;
  const t =
    lastTouchRaw instanceof Date ? lastTouchRaw.getTime() : Date.parse(String(lastTouchRaw ?? ""));
  if (!Number.isFinite(t)) return f.importance;
  // Decay PERIOD. Measured on the live A2A corpus (773 facts, 9 agents): 772 of
  // them were touched within 30 days, so with the old 30-day threshold the decay
  // axis was inert — effective-importance entropy 1.417 before vs 1.414 after,
  // i.e. progressive decay changed nothing at all. At a 14-day period it does
  // real work: entropy 1.598, and the ★5 population drops 362 → 145, which is
  // the importance-inflation problem this axis exists to correct.
  // IMPORTANCE_DECAY_DAYS falls back to RECALL_STALE_DAYS so the older env var
  // still controls behaviour for anyone who set it.
  const decayDays = Config.IMPORTANCE_DECAY_DAYS > 0
    ? Config.IMPORTANCE_DECAY_DAYS
    : Config.RECALL_STALE_DAYS;
  const staleMs = decayDays * 24 * 60 * 60 * 1000;
  if (nowMs - t <= staleMs) return f.importance;

  // v0.51.0 — PROGRESSIVE decay with a floor, replacing a single flat -2 step.
  // Measured on a live 3-agent project: 59% of 1117 facts were importance-5
  // (soft cap 25). A one-step demotion cannot separate "stale by a week" from
  // "untouched for three months" — both landed on the same rung, so the axis
  // still failed to discriminate across the bulk of an inflated namespace.
  // Now: one point per elapsed stale period, floored so a stale critical fact
  // still outranks genuine noise. This demotes; it never forgets.
  // Floor also fixes a latent bug: the old form could drive importance to 0 or
  // negative for a long-untouched ★1, inverting it below facts it should beat.
  const periods = Math.floor((nowMs - t) / staleMs);
  const floor   = Math.max(1, Math.min(5, Config.IMPORTANCE_DECAY_FLOOR));
  const decayed = f.importance - Config.RECALL_STALE_DEMOTE * periods;
  return Math.max(Math.min(floor, f.importance), decayed);
}

/**
 * Re-sort an unfocused recall list by effective (staleness-demoted) importance.
 * Preserves the own-namespace-first partition and created_at DESC tiebreak.
 * Inert when RECALL_STALE_DEMOTE=0 (returns the input array untouched).
 */
export function applyStalenessDemotion<F extends BudgetableFact>(
  rows: F[],
  ownAgent: string | undefined,
  nowMs: number
): F[] {
  if (Config.RECALL_STALE_DEMOTE <= 0 || rows.length === 0) return rows;
  const eff = new Map<F, number>(rows.map((r) => [r, effectiveImportance(r, nowMs)]));
  const prio = (r: F) => (ownAgent && ownAgent !== "default" && r.agent_id === ownAgent ? 0 : 1);
  return [...rows].sort(
    (a, b) =>
      prio(a) - prio(b) ||
      eff.get(b)! - eff.get(a)! ||
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
  );
}
