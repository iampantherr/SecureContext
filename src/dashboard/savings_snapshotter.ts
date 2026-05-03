/**
 * v0.18.8 Sprint 2.8 — Daily savings snapshotter + trend queries +
 * per-agent breakdown + anti-pattern detection.
 *
 * The snapshotter writes one row per project per UTC day to
 * token_savings_snapshots_pg with full aggregates. The dispatcher tick
 * calls maybeRunSnapshotter() with a 24h cooldown so it runs at most
 * once per day per project.
 *
 * Trend queries hit the snapshot table directly (fast). Live dashboard
 * windows (today, last hour) still hit raw tool_calls_pg (real-time).
 */

import { withClient } from "../pg_pool.js";
import { fetchToolUsage } from "./token_savings.js";

// ─── Constants (mirror token_savings.ts; tunable via env) ─────────────────

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (!raw) return dflt;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

const BASELINE = {
  zc_recall_context: () => envInt("ZC_SAVINGS_RECALL_BASELINE", 30_000),
  zc_search:         () => envInt("ZC_SAVINGS_SEARCH_BASELINE", 25_000),
  zc_search_global:  () => envInt("ZC_SAVINGS_SEARCH_BASELINE", 25_000),
  zc_file_summary:   () => envInt("ZC_SAVINGS_SUMMARY_BASELINE", 5_000),
  zc_check:          () => envInt("ZC_SAVINGS_CHECK_BASELINE",   8_000),
  zc_fetch:          () => envInt("ZC_SAVINGS_FETCH_BASELINE",   8_000),
  zc_batch:          () => envInt("ZC_SAVINGS_SEARCH_BASELINE", 25_000),
};
function avgCostPerToken(): number {
  return parseFloat(process.env.ZC_SAVINGS_AVG_COST_PER_TOKEN ?? "0.000003");
}

// ─── Snapshotter ──────────────────────────────────────────────────────────

export type Cadence = "4h" | "daily";

interface SnapshotRow {
  snapshot_id:                   string;
  project_hash:                  string;
  cadence:                       Cadence;
  period_start:                  string;
  period_end:                    string;
  total_calls:                   number;
  total_actual_tokens:           number;
  total_actual_cost_usd:         number;
  total_estimated_native_tokens: number;
  total_saved_tokens:            number;
  total_saved_cost_usd:          number;
  reduction_pct:                 number;
  confidence:                    "low" | "medium" | "high";
  per_tool:                      Record<string, unknown>;
  per_agent:                     Record<string, unknown>;
}

/**
 * Compute the canonical UTC-aligned bucket for a given timestamp + cadence.
 *  - 'daily':  day boundaries (00:00:00 UTC → 23:59:59.999 UTC)
 *  - '4h':     4-hour boundaries (00, 04, 08, 12, 16, 20 UTC)
 */
function bucketBounds(t: Date, cadence: Cadence): { start: Date; end: Date; id_suffix: string } {
  const yyyy = t.getUTCFullYear();
  const mm   = t.getUTCMonth();
  const dd   = t.getUTCDate();
  if (cadence === "daily") {
    const start = new Date(Date.UTC(yyyy, mm, dd, 0, 0, 0));
    const end   = new Date(Date.UTC(yyyy, mm, dd + 1, 0, 0, 0));
    const id    = `${yyyy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    return { start, end, id_suffix: `daily-${id}` };
  } else {
    const hourBucket = Math.floor(t.getUTCHours() / 4) * 4;
    const start = new Date(Date.UTC(yyyy, mm, dd, hourBucket, 0, 0));
    const end   = new Date(Date.UTC(yyyy, mm, dd, hourBucket + 4, 0, 0));
    const id    = `${yyyy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}T${String(hourBucket).padStart(2, "0")}`;
    return { start, end, id_suffix: `4h-${id}` };
  }
}

/**
 * Build a snapshot for a single project + cadence + bucket-anchor time.
 * Pulls from tool_calls_pg, aggregates per-tool + per-agent, computes savings.
 */
async function buildSnapshot(projectHash: string, anchor: Date, cadence: Cadence): Promise<SnapshotRow> {
  const { start: periodStart, end: periodEnd, id_suffix } = bucketBounds(anchor, cadence);

  // 1. Per-tool aggregation (existing helper)
  const usage = await fetchToolUsage(projectHash, periodStart.toISOString(), periodEnd.toISOString());

  // 2. Per-agent aggregation
  const perAgent = await withClient(async (c) => {
    const res = await c.query<{
      agent_id: string; tool_name: string; n: string; tokens: string; cost: string;
    }>(
      `SELECT agent_id, tool_name,
              COUNT(*)::text                AS n,
              COALESCE(SUM(input_tokens + output_tokens), 0)::text AS tokens,
              COALESCE(SUM(cost_usd), 0)::text AS cost
         FROM tool_calls_pg
        WHERE project_hash = $1
          AND ts >= $2::timestamptz
          AND ts <  $3::timestamptz
        GROUP BY agent_id, tool_name`,
      [projectHash, periodStart.toISOString(), periodEnd.toISOString()],
    );
    return res.rows;
  });

  // 3. Compute totals + per-tool savings
  const cost_per_token = avgCostPerToken();
  let total_actual_tokens = 0;
  let total_actual_cost   = 0;
  let total_native        = 0;
  let total_calls         = 0;
  const per_tool: Record<string, {
    calls: number; actual_tokens: number; baseline_per_call: number;
    estimated_native: number; saved_tokens: number; saved_cost_usd: number;
  }> = {};

  for (const row of usage) {
    total_actual_tokens += row.input_tokens + row.output_tokens;
    total_actual_cost   += row.cost_usd;
    total_calls         += row.call_count;
    const baselineFn = BASELINE[row.tool_name as keyof typeof BASELINE];
    if (!baselineFn) continue;
    const baseline = baselineFn();
    const estimated_native = baseline * row.call_count;
    const saved = Math.max(0, estimated_native - (row.input_tokens + row.output_tokens));
    total_native += estimated_native;
    per_tool[row.tool_name] = {
      calls:             row.call_count,
      actual_tokens:     row.input_tokens + row.output_tokens,
      baseline_per_call: baseline,
      estimated_native,
      saved_tokens:      saved,
      saved_cost_usd:    saved * cost_per_token,
    };
  }

  // 4. Per-agent savings (sum savings across each agent's tool calls)
  const per_agent: Record<string, {
    calls: number; actual_tokens: number; estimated_native: number;
    saved_tokens: number; saved_cost_usd: number; reduction_pct: number;
  }> = {};
  for (const r of perAgent) {
    const tokens = parseInt(r.tokens, 10);
    const calls = parseInt(r.n, 10);
    const baselineFn = BASELINE[r.tool_name as keyof typeof BASELINE];
    const baseline = baselineFn ? baselineFn() : 0;
    const estimated = baseline * calls;
    const saved = Math.max(0, estimated - tokens);
    const a = per_agent[r.agent_id] ??= {
      calls: 0, actual_tokens: 0, estimated_native: 0,
      saved_tokens: 0, saved_cost_usd: 0, reduction_pct: 0,
    };
    a.calls            += calls;
    a.actual_tokens    += tokens;
    a.estimated_native += estimated;
    a.saved_tokens     += saved;
    a.saved_cost_usd   += saved * cost_per_token;
  }
  for (const a of Object.values(per_agent)) {
    a.reduction_pct = a.estimated_native > 0 ? (a.saved_tokens / a.estimated_native) * 100 : 0;
  }

  const total_saved = Math.max(0, total_native - total_actual_tokens);
  const reduction   = total_native > 0 ? (total_saved / total_native) * 100 : 0;
  const distinctTools = Object.keys(per_tool).length;
  let confidence: "low" | "medium" | "high" = "low";
  if (total_calls >= 50 && distinctTools >= 3)      confidence = "high";
  else if (total_calls >= 15 && distinctTools >= 2) confidence = "medium";

  return {
    snapshot_id:                   `snap-${projectHash}-${id_suffix}`,
    project_hash:                  projectHash,
    cadence,
    period_start:                  periodStart.toISOString(),
    period_end:                    periodEnd.toISOString(),
    total_calls,
    total_actual_tokens,
    total_actual_cost_usd:         total_actual_cost,
    total_estimated_native_tokens: total_native,
    total_saved_tokens:            total_saved,
    total_saved_cost_usd:          total_saved * cost_per_token,
    reduction_pct:                 Math.round(reduction * 100) / 100,
    confidence,
    per_tool,
    per_agent,
  };
}

/**
 * UPSERT a snapshot row. Idempotent — re-running for the same project+cadence+period_start
 * overwrites the prior snapshot (so a re-snapshotter run picks up tool_calls
 * that landed since the last run).
 */
async function upsertSnapshot(snap: SnapshotRow): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO token_savings_snapshots_pg
        (snapshot_id, project_hash, cadence, period_start, period_end,
         total_calls, total_actual_tokens, total_actual_cost_usd,
         total_estimated_native_tokens, total_saved_tokens, total_saved_cost_usd,
         reduction_pct, confidence, per_tool, per_agent)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz,
               $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)
       ON CONFLICT (project_hash, cadence, period_start) DO UPDATE SET
         snapshot_id                  = EXCLUDED.snapshot_id,
         period_end                   = EXCLUDED.period_end,
         total_calls                  = EXCLUDED.total_calls,
         total_actual_tokens          = EXCLUDED.total_actual_tokens,
         total_actual_cost_usd        = EXCLUDED.total_actual_cost_usd,
         total_estimated_native_tokens = EXCLUDED.total_estimated_native_tokens,
         total_saved_tokens           = EXCLUDED.total_saved_tokens,
         total_saved_cost_usd         = EXCLUDED.total_saved_cost_usd,
         reduction_pct                = EXCLUDED.reduction_pct,
         confidence                   = EXCLUDED.confidence,
         per_tool                     = EXCLUDED.per_tool,
         per_agent                    = EXCLUDED.per_agent`,
      [
        snap.snapshot_id, snap.project_hash, snap.cadence,
        snap.period_start, snap.period_end,
        snap.total_calls, snap.total_actual_tokens, snap.total_actual_cost_usd,
        snap.total_estimated_native_tokens, snap.total_saved_tokens, snap.total_saved_cost_usd,
        snap.reduction_pct, snap.confidence,
        JSON.stringify(snap.per_tool), JSON.stringify(snap.per_agent),
      ],
    );
  });
}

/**
 * Snapshot a specific cadence + bucket for every project that had activity.
 * Idempotent (UPSERT). Called by the dispatcher tick (with cadence-specific
 * cooldowns) and on-demand from the /dashboard/savings/snapshot-now route.
 *
 * For 'daily': snapshots YESTERDAY (complete day, won't change).
 * For '4h':    snapshots the LAST COMPLETED 4h bucket (won't change).
 */
export async function runSnapshotter(
  cadence: Cadence,
  opts: { force?: boolean; anchor?: Date } = {},
): Promise<{ snapshots_written: number; projects: string[]; cadence: Cadence }> {
  // Determine the bucket we're snapshotting (last COMPLETED bucket of this cadence)
  let anchor: Date;
  if (opts.anchor) {
    anchor = opts.anchor;
  } else if (cadence === "daily") {
    anchor = new Date(Date.now() - 24 * 60 * 60 * 1000);  // yesterday
  } else {
    anchor = new Date(Date.now() - 4 * 60 * 60 * 1000);   // 4h ago (last completed 4h bucket)
  }
  const { start: bucketStart, end: bucketEnd } = bucketBounds(anchor, cadence);

  const projects = await withClient(async (c) => {
    const res = await c.query<{ project_hash: string }>(
      `SELECT DISTINCT project_hash
         FROM tool_calls_pg
        WHERE ts >= $1::timestamptz AND ts < $2::timestamptz
          ${opts.force ? "" : `AND NOT EXISTS (
              SELECT 1 FROM token_savings_snapshots_pg s
               WHERE s.project_hash = tool_calls_pg.project_hash
                 AND s.cadence      = $3
                 AND s.period_start = $1::timestamptz
          )`}`,
      opts.force
        ? [bucketStart.toISOString(), bucketEnd.toISOString()]
        : [bucketStart.toISOString(), bucketEnd.toISOString(), cadence],
    );
    return res.rows.map((r) => r.project_hash);
  });

  for (const projectHash of projects) {
    const snap = await buildSnapshot(projectHash, anchor, cadence);
    await upsertSnapshot(snap);
  }
  return { snapshots_written: projects.length, projects, cadence };
}

/**
 * Per-tick check: cadence-specific cooldowns. The dispatcher calls this on
 * every health-check tick; we run at most once per cooldown window.
 *
 *   '4h' cooldown    : 4 hours    (snapshots the just-completed 4h bucket)
 *   'daily' cooldown : 24 hours   (snapshots yesterday)
 */
const lastRun: Record<Cadence, number> = { "4h": 0, "daily": 0 };
const COOLDOWN_MS: Record<Cadence, number> = {
  "4h":    4  * 60 * 60 * 1000,
  "daily": 24 * 60 * 60 * 1000,
};
export async function maybeRunSnapshotter(): Promise<void> {
  for (const cadence of ["4h", "daily"] as const) {
    if (Date.now() - lastRun[cadence] < COOLDOWN_MS[cadence]) continue;
    lastRun[cadence] = Date.now();
    try {
      await runSnapshotter(cadence);
    } catch { /* tolerate; next tick retries */ }
  }
}

// ─── Trend query (30-day sparkline source) ────────────────────────────────

export interface DailySnapshotPoint {
  date:           string;
  saved_tokens:   number;
  saved_cost_usd: number;
  total_calls:    number;
  reduction_pct:  number;
}

/**
 * Fetch trend points for a project at a given cadence.
 *   cadence='daily' + count=30 → last 30 days, one point per day
 *   cadence='4h'    + count=24 → last 96 hours, one point per 4h bucket (24 buckets)
 */
export async function fetchTrend(
  projectHash: string,
  cadence: Cadence = "daily",
  count = 30,
): Promise<DailySnapshotPoint[]> {
  return withClient(async (c) => {
    const res = await c.query<{
      period_start: string;
      total_saved_tokens: string;
      total_saved_cost_usd: string;
      total_calls: string;
      reduction_pct: string;
    }>(
      `SELECT period_start::text,
              total_saved_tokens::text,
              total_saved_cost_usd::text,
              total_calls::text,
              reduction_pct::text
         FROM token_savings_snapshots_pg
        WHERE project_hash = $1
          AND cadence      = $2
        ORDER BY period_start DESC
        LIMIT $3`,
      [projectHash, cadence, count],
    );
    return res.rows
      .map((r) => ({
        date:           cadence === "daily" ? r.period_start.slice(0, 10) : r.period_start.slice(0, 16),
        saved_tokens:   parseInt(r.total_saved_tokens, 10),
        saved_cost_usd: parseFloat(r.total_saved_cost_usd),
        total_calls:    parseInt(r.total_calls, 10),
        reduction_pct:  parseFloat(r.reduction_pct),
      }))
      .reverse();  // ASC for plotting
  });
}

// ─── Anti-pattern detector (3 conservative detectors) ─────────────────────

export interface AntiPattern {
  kind:        "unread_summary" | "duplicate_recall" | "expensive_skill";
  severity:    "info" | "warn";
  agent_id?:   string;
  skill_id?:   string;
  message:     string;
  evidence:    Record<string, unknown>;
}

export async function detectAntiPatterns(projectHash: string): Promise<AntiPattern[]> {
  const out: AntiPattern[] = [];

  // 1. Reads without zc_file_summary (5+ Reads in 60min by same agent without any zc_file_summary)
  try {
    const r = await withClient(async (c) => {
      const res = await c.query<{ agent_id: string; reads: string; summaries: string }>(
        `WITH window AS (
           SELECT agent_id, tool_name FROM tool_calls_pg
            WHERE project_hash = $1
              AND ts > now() - interval '60 minutes'
         )
         SELECT agent_id,
                COUNT(*) FILTER (WHERE tool_name = 'Read')::text            AS reads,
                COUNT(*) FILTER (WHERE tool_name = 'zc_file_summary')::text AS summaries
           FROM window
          GROUP BY agent_id
         HAVING COUNT(*) FILTER (WHERE tool_name = 'Read') >= 5
            AND COUNT(*) FILTER (WHERE tool_name = 'zc_file_summary') = 0`,
        [projectHash],
      );
      return res.rows;
    });
    for (const row of r) {
      const reads = parseInt(row.reads, 10);
      out.push({
        kind: "unread_summary",
        severity: reads >= 10 ? "warn" : "info",
        agent_id: row.agent_id,
        message: `Agent ${row.agent_id} did ${reads} Reads in last 60 min without using zc_file_summary — likely ~${(reads * 4500).toLocaleString()} tokens wasted`,
        evidence: { reads, summaries: 0, window_min: 60 },
      });
    }
  } catch { /* tolerate */ }

  // 2. Duplicate zc_recall_context within 60s cache window (same agent)
  try {
    const r = await withClient(async (c) => {
      const res = await c.query<{ agent_id: string; n: string }>(
        `WITH ranked AS (
           SELECT agent_id, ts,
                  LAG(ts) OVER (PARTITION BY agent_id ORDER BY ts) AS prev_ts
             FROM tool_calls_pg
            WHERE project_hash = $1
              AND tool_name = 'zc_recall_context'
              AND ts > now() - interval '60 minutes'
         )
         SELECT agent_id, COUNT(*)::text AS n
           FROM ranked
          WHERE prev_ts IS NOT NULL
            AND ts - prev_ts < interval '60 seconds'
          GROUP BY agent_id`,
        [projectHash],
      );
      return res.rows;
    });
    for (const row of r) {
      const n = parseInt(row.n, 10);
      if (n >= 2) {
        out.push({
          kind: "duplicate_recall",
          severity: "warn",
          agent_id: row.agent_id,
          message: `Agent ${row.agent_id} called zc_recall_context ${n + 1} times within 60s of each other — cache hit window is 60s, so most calls were duplicates`,
          evidence: { duplicate_pairs: n, window_min: 60 },
        });
      }
    }
  } catch { /* tolerate */ }

  // 3. Skill cost outlier (>5× median per-run cost in pool)
  try {
    const r = await withClient(async (c) => {
      const res = await c.query<{ skill_id: string; my_avg: string; pool_median: string }>(
        `WITH skill_avg AS (
           SELECT s.skill_id, s.frontmatter->>'name' AS name,
                  AVG(r.total_tokens)::numeric AS my_avg
             FROM skill_runs_pg r
             JOIN skills_pg s ON s.skill_id = r.skill_id
            WHERE r.ts > now() - interval '7 days'
              AND s.archived_at IS NULL
            GROUP BY s.skill_id, s.frontmatter
         )
         SELECT skill_id, my_avg::text,
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY my_avg) OVER (), 0)::text AS pool_median
           FROM skill_avg
          WHERE my_avg > 5 * (
            SELECT COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY my_avg), 0)
              FROM skill_avg
          )`,
        [],
      );
      return res.rows;
    });
    for (const row of r) {
      out.push({
        kind: "expensive_skill",
        severity: "info",
        skill_id: row.skill_id,
        message: `Skill ${row.skill_id} consumes ~${parseFloat(row.my_avg).toFixed(0)} tokens per run vs pool median ~${parseFloat(row.pool_median).toFixed(0)} — review for inefficiency`,
        evidence: { my_avg: parseFloat(row.my_avg), pool_median: parseFloat(row.pool_median) },
      });
    }
  } catch { /* tolerate */ }

  return out;
}

// ─── Render helpers (HTML fragments for the new dashboard panels) ─────────

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Inline SVG sparkline of saved-tokens-per-day for the last N days.
 * No JS, no external deps. Falls back to "no data" message when empty.
 */
export function renderTrendSparkline(points: DailySnapshotPoint[]): string {
  if (points.length === 0) {
    return `<div class="trend-empty">No daily snapshots yet — run for a day to populate. (Snapshotter writes one row per project per day at most every 24h.)</div>`;
  }
  const W = 600;
  const H = 80;
  const max = Math.max(...points.map((p) => p.saved_tokens), 1);
  const min = 0;
  const dx = points.length > 1 ? W / (points.length - 1) : W;
  const path = points.map((p, i) => {
    const x = i * dx;
    const y = H - ((p.saved_tokens - min) / (max - min)) * (H - 8) - 4;
    return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  const fill = `M 0 ${H} ` + points.map((p, i) => {
    const x = i * dx;
    const y = H - ((p.saved_tokens - min) / (max - min)) * (H - 8) - 4;
    return `L ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ") + ` L ${W} ${H} Z`;
  const totalSaved = points.reduce((s, p) => s + p.saved_tokens, 0);
  const totalCost  = points.reduce((s, p) => s + p.saved_cost_usd, 0);
  return `
    <div class="trend-panel">
      <div class="trend-header">
        <strong>${fmt(totalSaved)}</strong> tokens saved over ${points.length} completed day${points.length === 1 ? "" : "s"} ·
        <strong>$${totalCost.toFixed(4)}</strong> cost saved
      </div>
      <!-- v0.22.7: explain why the trend total can be lower than the headline.
           Headline = live aggregate over the selected window (includes today).
           Trend    = closed daily snapshots only (today is mid-flight, so its
                      bucket isn't written yet). The snapshotter runs ≤1×/day
                      per project. -->
      <div class="trend-footnote" style="font-size:0.75rem; color:#94a3b8; margin-top:4px">
        Trend reflects closed daily snapshots only — today's in-flight totals
        are above (Headline = live live aggregate; Trend = sealed days).
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="trend-svg" preserveAspectRatio="none">
        <path d="${fill}" fill="rgba(74,222,128,0.15)" />
        <path d="${path}" stroke="#4ade80" stroke-width="1.5" fill="none" />
      </svg>
      <div class="trend-axis">
        <span>${points[0]?.date ?? ""}</span>
        <span>${points[points.length - 1]?.date ?? ""}</span>
      </div>
    </div>
  `;
}

export function renderPerAgentBreakdown(perAgent: Record<string, { calls: number; saved_tokens: number; reduction_pct: number; saved_cost_usd: number }>): string {
  const entries = Object.entries(perAgent).sort((a, b) => b[1].saved_tokens - a[1].saved_tokens).slice(0, 8);
  if (entries.length === 0) return "";
  const rows = entries.map(([agent, m]) => `
    <tr>
      <td><code>${agent}</code></td>
      <td>${fmt(m.calls)}</td>
      <td>${fmt(m.saved_tokens)}</td>
      <td>${m.reduction_pct.toFixed(1)}%</td>
      <td>$${m.saved_cost_usd.toFixed(4)}</td>
    </tr>
  `).join("");
  return `
    <details class="per-agent-panel">
      <summary>Per-agent breakdown (top ${entries.length})</summary>
      <table class="savings-table">
        <thead><tr><th>Agent</th><th>Calls</th><th>Saved tokens</th><th>Reduction</th><th>Saved $</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>
  `;
}

/**
 * v0.18.8 Loop A — Build a session-start efficiency advisory for the
 * orchestrator. Reads last 7 days of tool_calls_pg for the project, identifies
 * 1-2 actionable patterns, returns a short string the orchestrator can
 * include in its initial recall_context output.
 *
 * Returns null if no actionable advisory (fewer than 10 calls in window
 * → not enough signal).
 */
export async function buildOrchestratorAdvisory(projectHash: string): Promise<string | null> {
  try {
    const usage = await withClient(async (c) => {
      const res = await c.query<{ tool_name: string; n: string; tokens: string }>(
        `SELECT tool_name, COUNT(*)::text AS n,
                COALESCE(SUM(input_tokens + output_tokens), 0)::text AS tokens
           FROM tool_calls_pg
          WHERE project_hash = $1
            AND ts > now() - interval '7 days'
          GROUP BY tool_name
          ORDER BY n DESC`,
        [projectHash],
      );
      return res.rows;
    });
    const totalCalls = usage.reduce((s, r) => s + parseInt(r.n, 10), 0);
    if (totalCalls < 10) return null;

    const findCalls = (name: string) => {
      const r = usage.find((u) => u.tool_name === name);
      return r ? parseInt(r.n, 10) : 0;
    };
    const reads        = findCalls("Read");
    const summaries    = findCalls("zc_file_summary");
    const recallCalls  = findCalls("zc_recall_context");
    const searchCalls  = findCalls("zc_search");

    const tips: string[] = [];
    if (reads >= 8 && summaries === 0) {
      tips.push(`Workers used Read ${reads}× last 7d but never zc_file_summary. For "what does X do" questions, prefer zc_file_summary — saves ~5K tokens per call.`);
    }
    if (recallCalls >= 5 && totalCalls > 20 && (recallCalls / totalCalls) > 0.3) {
      tips.push(`zc_recall_context is ${Math.round((recallCalls/totalCalls)*100)}% of all SC calls — high. Cache TTL is 60s; consecutive recall calls within that window are deduplicated for free.`);
    }
    if (searchCalls === 0 && reads >= 10) {
      tips.push(`No zc_search usage in 7d but ${reads} Reads. For "where is X implemented" questions, zc_search returns top-10 matches across the codebase — saves ~25K tokens vs reading 5-10 files manually.`);
    }
    if (tips.length === 0) return null;

    return `EFFICIENCY ADVISORY (last 7d, ${totalCalls} SC calls):\n` + tips.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
  } catch { return null; }
}

/**
 * v0.18.8 Loop B — Per-skill avg cost (tokens-per-run) for the Skills panel.
 * Returns a Map<skill_id, {avg_tokens, run_count, pool_median}> for skills
 * with ≥3 runs in last 30 days. Used to flag skill efficiency outliers.
 */
export async function fetchSkillEfficiency(projectHash: string): Promise<Map<string, { avg_tokens: number; run_count: number }>> {
  const map = new Map<string, { avg_tokens: number; run_count: number }>();
  try {
    const rows = await withClient(async (c) => {
      const res = await c.query<{ skill_id: string; avg_tokens: string; run_count: string }>(
        `SELECT skill_id,
                AVG(total_tokens)::text AS avg_tokens,
                COUNT(*)::text          AS run_count
           FROM skill_runs_pg
          WHERE ts > now() - interval '30 days'
            AND total_tokens IS NOT NULL
          GROUP BY skill_id
         HAVING COUNT(*) >= 3`,
        [],
      );
      return res.rows;
    });
    for (const r of rows) {
      map.set(r.skill_id, {
        avg_tokens: parseFloat(r.avg_tokens),
        run_count:  parseInt(r.run_count, 10),
      });
    }
  } catch { /* tolerate */ }
  void projectHash;  // currently unused but kept for future per-project filtering
  return map;
}

export function renderAntiPatterns(patterns: AntiPattern[]): string {
  if (patterns.length === 0) return "";
  const rows = patterns.map((p) => {
    const color = p.severity === "warn" ? "warn-chip" : "info-chip";
    return `<div class="anti-pattern ${color}"><strong>[${p.kind}]</strong> ${p.message}</div>`;
  }).join("");
  return `
    <details class="anti-patterns-panel" open>
      <summary>Anti-patterns detected (${patterns.length})</summary>
      ${rows}
    </details>
  `;
}
