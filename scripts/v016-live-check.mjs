import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { join } from "node:path";
import { homedir } from "node:os";

const DB = join(homedir(), ".claude", "zc-ctx", "sessions", "aafb4b029db36884.db");
const pool = new Pool({
  host: "localhost", port: 5432, user: "scuser",
  password: "79bd1ca6011b797c70e90c02becdaa90d99cfc501abaec09",
  database: "securecontext",
});

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
function section(t) { console.log(`\n━━━ ${t} ${"━".repeat(Math.max(0, 65 - t.length))}`); }

console.log("v0.16.0 Comprehensive Live Verification");
console.log("=".repeat(72));

// ─── A. Structured ASSIGN persisted in PG ──────────────────────────────
section("A. v0.15.0 structured ASSIGN columns persist in PG (closes v0.15.0 limit)");
const { rows: bcRows } = await pool.query(`
  SELECT id, type, complexity_estimate, estimated_tokens,
         file_ownership_exclusive, required_skills, acceptance_criteria
  FROM broadcasts WHERE id = 1042
`);
ok("broadcast 1042 exists in PG", bcRows.length === 1);
if (bcRows.length === 1) {
  const r = bcRows[0];
  ok("complexity_estimate=2 in PG", r.complexity_estimate === 2);
  ok("estimated_tokens=2500 in PG", r.estimated_tokens === 2500);
  ok("file_ownership_exclusive includes utils/format-duration.js",
     JSON.parse(r.file_ownership_exclusive ?? "[]").includes("utils/format-duration.js"));
  ok("required_skills includes javascript",
     JSON.parse(r.required_skills ?? "[]").includes("javascript"));
  ok("acceptance_criteria has 4 items",
     JSON.parse(r.acceptance_criteria ?? "[]").length === 4);
}

// ─── B. Telemetry rows (SQLite — agent's MCP local mode) ─────────────────
section("B. Telemetry — agent's MCP calls recorded with hash chain");
const sdb = new DatabaseSync(DB);
const tcCount = sdb.prepare("SELECT COUNT(*) AS n FROM tool_calls").get().n;
ok("tool_calls table has rows", tcCount > 0, `${tcCount} rows`);
const sample = sdb.prepare("SELECT call_id, tool_name, agent_id, model, latency_ms, status, prev_hash, row_hash FROM tool_calls ORDER BY id DESC LIMIT 5").all();
console.log("  Sample (newest):");
for (const r of sample) console.log(`    ${r.tool_name.padEnd(28)} agent=${r.agent_id} lat=${r.latency_ms}ms  trace=${r.row_hash.slice(0,8)}`);

// Chain integrity: re-verify
const allCalls = sdb.prepare("SELECT id, prev_hash, row_hash FROM tool_calls ORDER BY id ASC").all();
let chainOk = true, brokenAt = -1;
for (let i = 1; i < allCalls.length; i++) {
  if (allCalls[i].prev_hash !== allCalls[i-1].row_hash) { chainOk = false; brokenAt = i; break; }
}
ok("chain links connected end-to-end", chainOk, brokenAt >= 0 ? `broke at index ${brokenAt}` : `${allCalls.length} rows`);

// ─── C. Outcomes (resolvers fired) ────────────────────────────────────
section("C. Outcomes — resolvers fired on agent activity");
const ocCount = sdb.prepare("SELECT COUNT(*) AS n FROM outcomes").get().n;
ok("outcomes table has rows", ocCount > 0, `${ocCount} rows`);
const ocByKind = sdb.prepare(`SELECT outcome_kind, signal_source, COUNT(*) AS n FROM outcomes GROUP BY outcome_kind, signal_source`).all();
for (const r of ocByKind) console.log(`  ► ${r.outcome_kind} ← ${r.signal_source} (${r.n})`);

// ─── D. v0.15.0 §8.6 T3.2 classification on outcomes (SQLite) ────────────
section("D. v0.15.0 T3.2 — classification labels on outcomes");
const ocClass = sdb.prepare("SELECT classification, COUNT(*) AS n FROM outcomes GROUP BY classification").all();
ok("outcomes has classification column", ocClass.length > 0);
for (const r of ocClass) console.log(`  ► ${r.classification} (${r.n})`);

sdb.close();

// ─── E. v0.16.0 RLS verification (live PG cross-agent restricted read) ───
section("E. v0.16.0 T3.2 — Postgres RLS blocks cross-agent restricted reads");
// Write a restricted outcome as alice
const aliceWrite = await pool.query(`
  BEGIN;
  DO $$ BEGIN CREATE ROLE "zc_agent_alice" NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  GRANT INSERT, SELECT ON outcomes_pg TO "zc_agent_alice";
  GRANT USAGE ON SCHEMA public TO "zc_agent_alice";
  GRANT USAGE ON SEQUENCE outcomes_pg_id_seq TO "zc_agent_alice";
  DO $$ BEGIN CREATE ROLE "zc_agent_bob" NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  GRANT SELECT ON outcomes_pg TO "zc_agent_bob";
  GRANT USAGE ON SCHEMA public TO "zc_agent_bob";
  COMMIT;
`).catch((e) => console.log("setup error:", e.message));
void aliceWrite;

const c1 = await pool.connect();
try {
  await c1.query("BEGIN");
  await c1.query(`SET LOCAL ROLE "zc_agent_alice"`);
  await c1.query(`SELECT set_config('zc.current_agent', 'alice', true)`);
  const oid = "live-rls-test-" + Date.now();
  await c1.query(`INSERT INTO outcomes_pg (
    outcome_id, ref_type, ref_id, outcome_kind, signal_source,
    confidence, prev_hash, row_hash, classification, created_by_agent_id
  ) VALUES ($1, 'tool_call', 'cid', 'rejected', 'user_prompt', 0.5, 'g', 'h', 'restricted', 'alice')`, [oid]);
  await c1.query("COMMIT");

  // Now bob tries to read it
  const c2 = await pool.connect();
  try {
    await c2.query("BEGIN");
    await c2.query(`SET LOCAL ROLE "zc_agent_bob"`);
    await c2.query(`SELECT set_config('zc.current_agent', 'bob', true)`);
    const r = await c2.query(`SELECT outcome_id FROM outcomes_pg WHERE outcome_id = $1`, [oid]);
    await c2.query("COMMIT");
    ok("bob CANNOT see alice's restricted outcome (RLS blocked)", r.rows.length === 0);
  } finally { c2.release(); }

  // Alice can still read her own
  const c3 = await pool.connect();
  try {
    await c3.query("BEGIN");
    await c3.query(`SET LOCAL ROLE "zc_agent_alice"`);
    await c3.query(`SELECT set_config('zc.current_agent', 'alice', true)`);
    const r = await c3.query(`SELECT outcome_id FROM outcomes_pg WHERE outcome_id = $1`, [oid]);
    await c3.query("COMMIT");
    ok("alice CAN see her own restricted outcome", r.rows.length === 1);
  } finally { c3.release(); }
} finally { c1.release(); }

// ─── F. Real user task — file actually edited + commit landed ────────
section("F. Real user task — agent did real work");
const fs = await import("node:fs");
const fileContent = fs.readFileSync("C:/Users/Amit/AI_projects/Test_Agent_Coordination/utils/format-duration.js", "utf8");
ok("format-duration.js has TypeError validation",
   fileContent.includes("TypeError") && fileContent.includes("format-duration: ms must be a finite non-negative number"));
ok("guard checks Number.isFinite + ms < 0",
   fileContent.includes("Number.isFinite") && fileContent.includes("ms < 0"));

const { execSync } = await import("node:child_process");
const log = execSync("git log --oneline -1 utils/format-duration.js",
  { cwd: "C:/Users/Amit/AI_projects/Test_Agent_Coordination", encoding: "utf8" });
ok("git commit landed with EXACT message", log.includes("harden: validate input in format-duration"));

// ─── G. Summary ──────────────────────────────────────────────────────
console.log(`\n${"=".repeat(72)}`);
console.log(`  PASS: ${pass}`);
console.log(`  FAIL: ${fail}`);
await pool.end();
process.exit(fail === 0 ? 0 : 1);
