/**
 * v0.20.0 — Context-budget awareness (Tier A item #3 from the harness plan).
 *
 * Tracks cumulative tokens per session and surfaces a live "X% / 200K"
 * indicator in every tool-response cost header so the agent learns from
 * its own usage in real time. At 70%/85%/95% thresholds, prepends a
 * warning banner the agent reliably notices.
 *
 * Hard enforcement (block Read when zc_file_summary is available, force
 * summarize_session at 85%) is a v0.21+ task — for v0.20.0 we ship the
 * SIGNAL. The agent's role prompt + skills tell it what to do at each
 * threshold; this module provides the threshold detection.
 *
 * Configuration:
 *   ZC_CONTEXT_BUDGET_TOKENS   default 200_000  (Sonnet 4.6 / Opus 4.7 window)
 *   ZC_CONTEXT_WARN_THRESHOLD  default 0.70
 *   ZC_CONTEXT_ALERT_THRESHOLD default 0.85
 *   ZC_CONTEXT_EMERGENCY_THRESHOLD default 0.95
 *
 * Memory model: per-session counter held in process memory. When the MCP
 * server restarts the counter resets (correct — a new process is a new
 * session for budget purposes). Each session_id has independent accounting.
 */

const BUDGET_TOTAL = parseInt(process.env.ZC_CONTEXT_BUDGET_TOKENS ?? "200000", 10);
const WARN  = parseFloat(process.env.ZC_CONTEXT_WARN_THRESHOLD      ?? "0.70");
const ALERT = parseFloat(process.env.ZC_CONTEXT_ALERT_THRESHOLD     ?? "0.85");
const EMERG = parseFloat(process.env.ZC_CONTEXT_EMERGENCY_THRESHOLD ?? "0.95");

interface SessionUsage {
  inputTokens:  number;
  outputTokens: number;
  cost:         number;
  callCount:    number;
  startedAt:    number;
  lastUpdate:   number;
}

const usage = new Map<string, SessionUsage>();

/** Called from recordToolCall after each successful telemetry write. */
export function recordContextUsage(sessionId: string, inputTokens: number, outputTokens: number, cost: number): void {
  const now = Date.now();
  const existing = usage.get(sessionId);
  if (!existing) {
    usage.set(sessionId, {
      inputTokens, outputTokens, cost, callCount: 1,
      startedAt: now, lastUpdate: now,
    });
    return;
  }
  existing.inputTokens  += inputTokens;
  existing.outputTokens += outputTokens;
  existing.cost         += cost;
  existing.callCount    += 1;
  existing.lastUpdate    = now;
}

export type BudgetTier = "ok" | "warn" | "alert" | "emergency";

export interface ContextStatus {
  sessionId:    string;
  totalTokens:  number;       // input + output
  budget:       number;       // BUDGET_TOTAL
  fraction:     number;       // 0..1+
  pct:          number;       // 0..100+
  tier:         BudgetTier;
  callCount:    number;
  cost:         number;
  recommendation: string;
}

function tierFor(fraction: number): BudgetTier {
  if (fraction >= EMERG) return "emergency";
  if (fraction >= ALERT) return "alert";
  if (fraction >= WARN ) return "warn";
  return "ok";
}

function recommendationFor(tier: BudgetTier): string {
  switch (tier) {
    case "ok":
      return "Context budget healthy — proceed normally.";
    case "warn":
      return "70% threshold crossed: prefer zc_file_summary(path) over Read for purpose checks. Use zc_search([q]) instead of reading multiple files. Reads are 5-10× more expensive than summaries.";
    case "alert":
      return "85% threshold crossed: call zc_summarize_session() now to persist work + free context. Avoid new Read/Bash that load >2K tokens. Stick to zc_recall_context, zc_file_summary, zc_search, Edit, Write, zc_broadcast.";
    case "emergency":
      return "95% EMERGENCY: only Edit, Write, zc_broadcast, zc_remember(importance=5), zc_summarize_session are safe. Stop all reads and exploratory tools. Wrap up the current task and broadcast MERGE.";
  }
}

export function getContextStatus(sessionId: string): ContextStatus {
  const u = usage.get(sessionId) ?? { inputTokens: 0, outputTokens: 0, cost: 0, callCount: 0, startedAt: Date.now(), lastUpdate: Date.now() };
  const totalTokens = u.inputTokens + u.outputTokens;
  const fraction    = totalTokens / BUDGET_TOTAL;
  const tier        = tierFor(fraction);
  return {
    sessionId,
    totalTokens,
    budget:    BUDGET_TOTAL,
    fraction,
    pct:       Math.round(fraction * 1000) / 10,
    tier,
    callCount: u.callCount,
    cost:      u.cost,
    recommendation: recommendationFor(tier),
  };
}

/**
 * Format a context-budget suffix to append to every tool response's cost
 * header. Includes the threshold marker if any threshold has been crossed.
 *
 * Examples:
 *   "[ctx: 12.3% / 200K]"                                    — under WARN
 *   "[ctx: 71.5% / 200K — ⚠ WARN]"                           — between WARN and ALERT
 *   "[ctx: 87.2% / 200K — 🚨 ALERT call zc_summarize_session]" — between ALERT and EMERGENCY
 *   "[ctx: 96.8% / 200K — ⛔ EMERGENCY edits/broadcasts only]" — above EMERGENCY
 */
export function formatBudgetSuffix(sessionId: string): string {
  const s = getContextStatus(sessionId);
  const pct = s.pct.toFixed(1);
  const budgetK = Math.round(s.budget / 1000);
  if (s.tier === "ok")        return `[ctx: ${pct}% / ${budgetK}K]`;
  if (s.tier === "warn")      return `[ctx: ${pct}% / ${budgetK}K — ⚠ WARN: prefer summary over Read]`;
  if (s.tier === "alert")     return `[ctx: ${pct}% / ${budgetK}K — 🚨 ALERT: call zc_summarize_session]`;
  return                              `[ctx: ${pct}% / ${budgetK}K — ⛔ EMERGENCY: edits/broadcasts only]`;
}

/** Test helper: reset all session counters. */
export function _resetContextBudgetForTesting(): void {
  usage.clear();
}
