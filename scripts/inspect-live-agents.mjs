/**
 * Post-run inspector: inspects EVERY project DB that was touched today and
 * has Sprint 1 schema, dumps full analysis. Run AFTER real agents have done
 * work to validate the full pipeline.
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SESSIONS_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");
const LOGS_DIR     = join(homedir(), ".claude", "zc-ctx", "logs");
const today = new Date().toISOString().slice(0, 10);

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function divider(title) {
  console.log("\n" + "═".repeat(72));
  console.log("  " + title);
  console.log("═".repeat(72));
}

// ── Find live DBs ───────────────────────────────────────────────────────
const candidates = [];
for (const f of readdirSync(SESSIONS_DIR)) {
  if (!f.endsWith(".db")) continue;
  const p = join(SESSIONS_DIR, f);
  const m = statSync(p).mtime.toISOString();
  if (!m.startsWith(today)) continue;
  try {
    const db = new DatabaseSync(p);
    const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tool_calls'`).get();
    if (!tbl) { db.close(); continue; }
    const cols = db.prepare(`PRAGMA table_info(tool_calls)`).all();
    const hasId = cols.some((c) => c.name === "id");
    if (!hasId) { db.close(); continue; }
    const n = db.prepare(`SELECT COUNT(*) AS n FROM tool_calls`).get();
    if (n.n === 0) { db.close(); continue; }
    candidates.push({ file: f, path: p, rows: n.n, mtime: m });
    db.close();
  } catch {}
}
candidates.sort((a, b) => b.rows - a.rows);

divider(`Discovery [${ts()}]`);
if (candidates.length === 0) {
  console.log("NO DBs with Sprint 1 tool_calls rows found — agents did NOT use new wrapper.");
  process.exit(2);
}
console.log(`Found ${candidates.length} active Sprint 1 DB(s) with tool_calls data today:\n`);
for (const c of candidates) {
  console.log(`  ${c.file}  ${String(c.rows).padStart(4)} rows   mtime=${c.mtime}`);
}

// ── Full analysis on the DB with most activity ─────────────────────────
const target = candidates[0];
console.log(`\n→ Deep-dive on: ${target.file}\n`);

const db = new DatabaseSync(target.path);

divider("1. Tool call distribution");
const dist = db.prepare(`
  SELECT tool_name, COUNT(*) AS calls,
         ROUND(SUM(cost_usd), 6) AS cost_usd,
         ROUND(AVG(latency_ms), 1) AS avg_ms,
         SUM(input_tokens) AS in_tok,
         SUM(output_tokens) AS out_tok
  FROM tool_calls
  GROUP BY tool_name
  ORDER BY calls DESC
`).all();
for (const r of dist) {
  console.log(
    `  ${String(r.tool_name).padEnd(28)} ${String(r.calls).padStart(4)} calls  ` +
    `$${String(r.cost_usd).padStart(10)}  ${String(r.avg_ms).padStart(7)}ms avg  ` +
    `${String(r.in_tok).padStart(8)}in / ${String(r.out_tok).padStart(7)}out tok`
  );
}

divider("2. Agent breakdown");
const agents = db.prepare(`
  SELECT agent_id, COUNT(*) AS calls, ROUND(SUM(cost_usd), 6) AS cost_usd
  FROM tool_calls GROUP BY agent_id ORDER BY calls DESC
`).all();
for (const r of agents) {
  console.log(`  agent=${String(r.agent_id).padEnd(24)} ${String(r.calls).padStart(4)} calls  $${r.cost_usd}`);
}

divider("3. Session distribution");
const sessions = db.prepare(`
  SELECT session_id, COUNT(*) AS calls, MIN(ts) AS first, MAX(ts) AS last
  FROM tool_calls GROUP BY session_id ORDER BY calls DESC LIMIT 10
`).all();
for (const r of sessions) {
  console.log(`  ${r.session_id}  ${String(r.calls).padStart(4)} calls  ${r.first} → ${r.last}`);
}

divider("4. Sample rows — newest 8 tool_calls");
const recent = db.prepare(`
  SELECT call_id, tool_name, model, input_tokens, output_tokens,
         cost_usd, cost_known, latency_ms, status, trace_id, ts
  FROM tool_calls ORDER BY id DESC LIMIT 8
`).all();
for (const r of recent) {
  const cost = r.cost_known ? `$${Number(r.cost_usd).toFixed(6)}` : "$?";
  console.log(`  ${r.ts}`);
  console.log(`    tool=${r.tool_name}  model=${r.model}  cost=${cost} lat=${r.latency_ms}ms status=${r.status}`);
  console.log(`    tokens=${r.input_tokens}in/${r.output_tokens}out  trace=${r.trace_id ?? "(none)"}`);
}

divider("5. Chain integrity");
const rows = db.prepare(`
  SELECT id, call_id, prev_hash, row_hash FROM tool_calls ORDER BY id ASC
`).all();
console.log(`  Total rows: ${rows.length}`);
console.log(`  First row prev_hash: ${rows[0]?.prev_hash}`);
console.log(`  Last  row row_hash:  ${rows[rows.length-1]?.row_hash}`);

let chainConnected = true;
for (let i = 1; i < rows.length; i++) {
  if (rows[i].prev_hash !== rows[i-1].row_hash) {
    console.log(`  ✗ CHAIN BREAK at row id=${rows[i].id} (prev_hash ≠ previous row_hash)`);
    chainConnected = false;
    break;
  }
}
if (chainConnected) console.log("  ✓ Chain links connected end-to-end");

divider("6. Outcomes table (if populated)");
const hasOutcomes = db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='outcomes'`
).get();
if (hasOutcomes) {
  const oc = db.prepare(`
    SELECT outcome_kind, signal_source, COUNT(*) AS n, ROUND(AVG(confidence), 2) AS avg_conf
    FROM outcomes GROUP BY outcome_kind, signal_source ORDER BY n DESC
  `).all();
  if (oc.length === 0) {
    console.log("  (no outcomes yet — resolvers may not have fired in this run)");
  } else {
    for (const r of oc) {
      console.log(`  ${String(r.outcome_kind).padEnd(14)} ← ${String(r.signal_source).padEnd(12)} ${String(r.n).padStart(3)} rows  avg_conf=${r.avg_conf}`);
    }
  }
}

divider("7. Learnings table");
const hasLearnings = db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='learnings'`
).get();
if (hasLearnings) {
  const ln = db.prepare(
    `SELECT category, COUNT(*) AS n FROM learnings GROUP BY category`
  ).all();
  if (ln.length === 0) {
    console.log("  (no learnings mirrored — no learnings/*.jsonl writes yet)");
  } else {
    for (const r of ln) console.log(`  ${String(r.category).padEnd(14)} ${r.n} rows`);
  }
}

db.close();

divider("8. Logger activity today");
if (existsSync(LOGS_DIR)) {
  const today2 = today;
  const files = readdirSync(LOGS_DIR).filter((f) => f.includes(today2)).sort();
  if (files.length === 0) {
    console.log("  (no log files for today)");
  } else {
    for (const f of files) {
      const p = join(LOGS_DIR, f);
      const sz = statSync(p).size;
      console.log(`  ${f.padEnd(50)} ${String(sz).padStart(10)} bytes`);
    }
  }
}

divider("Summary");
const ok = chainConnected && candidates.length > 0;
console.log(ok ? "  ✓ LIVE AGENTS USING SPRINT 1 TELEMETRY" : "  ✗ VALIDATION FAILED");
console.log(`  ${target.rows} tool_call rows recorded by real agents in ${target.file}`);
process.exit(ok ? 0 : 1);
