/**
 * E2E verification for Sprint 1 v0.11.0
 *
 * Inspects the actual running MCP server's output against this session's
 * tool activity. Proves (or disproves) that telemetry + outcomes + logger
 * are wired end-to-end in live code — not just unit tests.
 *
 * Usage:
 *   node scripts/e2e-verify.mjs [project_path]
 *
 * If project_path omitted, picks the most-recently-touched DB in
 * ~/.claude/zc-ctx/sessions/.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { verifyToolCallChain, getToolCall } from "../dist/telemetry.js";
import {
  verifyOutcomesChain,
  recordOutcome,
  resolveGitCommitOutcome,
  resolveUserPromptOutcome,
  resolveFollowUpOutcomes,
  getOutcomesForToolCall,
} from "../dist/outcomes.js";
import { readLogs } from "../dist/logger.js";

const SESSIONS_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");
const LOGS_DIR     = join(homedir(), ".claude", "zc-ctx", "logs");

function hashOf(path) {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

function findActiveDb() {
  // Pick the DB that has a non-empty tool_calls table AND was most recently modified
  const files = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".db") && !f.endsWith("-wal") && !f.endsWith("-shm"))
    .map((f) => ({ f, p: join(SESSIONS_DIR, f), mtime: statSync(join(SESSIONS_DIR, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const { f, p } of files.slice(0, 20)) {
    try {
      const db = new DatabaseSync(p);
      const tbl = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='tool_calls'`
      ).get();
      if (!tbl) { db.close(); continue; }
      const count = db.prepare(`SELECT COUNT(*) AS n FROM tool_calls`).get();
      db.close();
      if (count && count.n > 0) {
        return { dbPath: p, hashPrefix: f.replace(".db", ""), rowCount: count.n };
      }
    } catch { continue; }
  }
  return null;
}

function header(title) {
  console.log("\n" + "═".repeat(70));
  console.log("  " + title);
  console.log("═".repeat(70));
}

async function main() {
  let projectPath = process.argv[2];
  let dbInfo;

  if (projectPath) {
    const p = join(SESSIONS_DIR, hashOf(projectPath) + ".db");
    if (!existsSync(p)) {
      console.error(`FAIL: no DB for project '${projectPath}' at ${p}`);
      process.exit(1);
    }
    const db = new DatabaseSync(p);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM tool_calls`).get();
    db.close();
    dbInfo = { dbPath: p, hashPrefix: hashOf(projectPath), rowCount: n.n };
  } else {
    dbInfo = findActiveDb();
    if (!dbInfo) {
      console.error("FAIL: no project DB with tool_calls rows found in " + SESSIONS_DIR);
      console.error("This means the MCP server is NOT recording telemetry.");
      process.exit(1);
    }
  }

  header("1. Active project DB");
  console.log(`  Path:       ${dbInfo.dbPath}`);
  console.log(`  Hash:       ${dbInfo.hashPrefix}`);
  console.log(`  tool_calls rows: ${dbInfo.rowCount}`);

  const db = new DatabaseSync(dbInfo.dbPath);

  // ── Telemetry rows ───────────────────────────────────────────────────
  header("2. Most recent 10 tool_calls (newest first)");
  const recent = db.prepare(`
    SELECT call_id, session_id, agent_id, tool_name, model,
           input_tokens, output_tokens, cost_usd, cost_known,
           latency_ms, status, error_class, ts, trace_id
    FROM tool_calls
    ORDER BY id DESC
    LIMIT 10
  `).all();
  for (const r of recent) {
    const cost = r.cost_known ? `$${Number(r.cost_usd).toFixed(6)}` : "$?";
    console.log(
      `  ${r.ts} ${String(r.tool_name).padEnd(24)} ` +
      `${String(r.input_tokens).padStart(6)} in, ${String(r.output_tokens).padStart(6)} out, ` +
      `${cost.padStart(10)}, ${String(r.latency_ms).padStart(5)}ms, ` +
      `${r.status} agent=${r.agent_id}`
    );
  }

  // ── Tool distribution ────────────────────────────────────────────────
  header("3. Tool call distribution (top 10)");
  const dist = db.prepare(`
    SELECT tool_name, COUNT(*) AS calls, SUM(cost_usd) AS cost, AVG(latency_ms) AS avg_ms
    FROM tool_calls
    GROUP BY tool_name
    ORDER BY calls DESC
    LIMIT 10
  `).all();
  for (const r of dist) {
    console.log(
      `  ${String(r.tool_name).padEnd(28)} ${String(r.calls).padStart(4)} calls, ` +
      `$${Number(r.cost).toFixed(4)}, avg ${Number(r.avg_ms).toFixed(1)}ms`
    );
  }

  // ── Session distribution ─────────────────────────────────────────────
  header("4. Session distribution");
  const sess = db.prepare(`
    SELECT session_id, COUNT(*) AS calls, MIN(ts) AS first, MAX(ts) AS last
    FROM tool_calls
    GROUP BY session_id
    ORDER BY calls DESC
    LIMIT 5
  `).all();
  for (const r of sess) {
    console.log(`  ${r.session_id}  ${String(r.calls).padStart(4)} calls  ${r.first} → ${r.last}`);
  }

  // ── Chain integrity ──────────────────────────────────────────────────
  header("5. Chain integrity on live data");
  // Reverse hash prefix → project path to let verifyToolCallChain compute its own hash.
  // Since we have only the hash, we pass the path directly if known.
  // Otherwise we verify in-place by reading the DB rows directly.
  // Our helper takes a project path; for now we compute it if the user passed one.
  if (projectPath) {
    const tc = verifyToolCallChain(projectPath);
    const oc = verifyOutcomesChain(projectPath);
    console.log(`  tool_calls chain: ${tc.ok ? "OK" : "BROKEN at id " + tc.brokenAt + " (" + tc.brokenKind + ")"}  (${tc.totalRows} rows)`);
    console.log(`  outcomes chain:   ${oc.ok ? "OK" : "BROKEN at id " + oc.brokenAt + " (" + oc.brokenKind + ")"}  (${oc.totalRows} rows)`);
  } else {
    console.log("  (skipped — need explicit project_path arg to run verifier)");
  }

  // ── Outcomes summary ─────────────────────────────────────────────────
  const hasOutcomes = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='outcomes'`
  ).get();
  if (hasOutcomes) {
    header("6. Outcomes table contents");
    const oc = db.prepare(`
      SELECT outcome_kind, signal_source, COUNT(*) AS n, AVG(confidence) AS avg_conf
      FROM outcomes
      GROUP BY outcome_kind, signal_source
    `).all();
    if (oc.length === 0) {
      console.log("  (no outcomes recorded yet — expected if resolvers haven't fired)");
    } else {
      for (const r of oc) {
        console.log(`  ${String(r.outcome_kind).padEnd(14)} ← ${String(r.signal_source).padEnd(12)} ${String(r.n).padStart(4)} rows, avg confidence ${Number(r.avg_conf).toFixed(2)}`);
      }
    }
  }

  // ── Learnings table ──────────────────────────────────────────────────
  const hasLearnings = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='learnings'`
  ).get();
  if (hasLearnings) {
    header("7. Learnings table contents");
    const ln = db.prepare(
      `SELECT category, COUNT(*) AS n FROM learnings GROUP BY category`
    ).all();
    if (ln.length === 0) {
      console.log("  (no learnings mirrored — expected if no learnings/*.jsonl has been written)");
    } else {
      for (const r of ln) {
        console.log(`  ${String(r.category).padEnd(12)} ${r.n} rows`);
      }
    }
  }

  db.close();

  // ── Logger files ─────────────────────────────────────────────────────
  header("8. Logger files (" + LOGS_DIR + ")");
  if (existsSync(LOGS_DIR)) {
    const today = new Date().toISOString().slice(0, 10);
    const logs = readdirSync(LOGS_DIR).filter((f) => f.includes(today));
    for (const f of logs) {
      const p = join(LOGS_DIR, f);
      const size = statSync(p).size;
      const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).length;
      console.log(`  ${f.padEnd(45)} ${String(lines).padStart(5)} lines, ${String(size).padStart(8)} bytes`);
    }
  } else {
    console.log("  (directory does not exist — logger never wrote)");
  }

  // ── readLogs integration ─────────────────────────────────────────────
  header("9. readLogs() sample — last 5 telemetry entries");
  const telem = readLogs({ component: "telemetry", minLevel: "DEBUG", limit: 5 });
  if (telem.length === 0) {
    console.log("  (no telemetry log entries — MCP server may predate Sprint 1 wrapper)");
  } else {
    for (const e of telem) {
      console.log(`  ${e.ts} ${String(e.level).padEnd(5)} ${e.event} ${JSON.stringify(e.context ?? {})}`);
    }
  }

  header("Verification complete");
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
