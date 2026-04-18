/**
 * Live hook test — simulates Claude Code's hook stdin payloads
 * =============================================================
 *
 * Each of the three v0.10.0 harness hooks receives a JSON payload from
 * Claude Code on stdin. This script fabricates the exact payload shape
 * and pipes it into each hook, verifying:
 *   - PreRead:   allow first Read, block duplicate, allow after Edit
 *   - PostEdit:  L0/L1 regenerated in source_meta after a file change
 *   - PostBash:  tool_output_digest populated; output searchable
 *
 * Run: node scripts/test-hooks-live.mjs
 */

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const HOOKS_DIR  = join(homedir(), ".claude", "hooks");
const DB_DIR     = join(homedir(), ".claude", "zc-ctx", "sessions");
const PROJECT    = join(tmpdir(), "zc-hook-test-" + Date.now());

mkdirSync(PROJECT, { recursive: true });
mkdirSync(join(PROJECT, "src"), { recursive: true });

let passed = 0;
let failed = 0;
const fails = [];

function assert(label, cond, detail) {
  if (cond) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}${detail ? " — " + detail : ""}`);
    fails.push(label);
    failed++;
  }
}

function dbPath(projectPath) {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(DB_DIR, `${hash}.db`);
}

function cleanDb() {
  const base = dbPath(PROJECT);
  for (const ext of ["", "-wal", "-shm"]) {
    try { if (existsSync(base + ext)) unlinkSync(base + ext); } catch {}
  }
}

/** Pipe JSON into a hook via stdin; capture stdout + exit code. */
function runHook(hookFile, payload) {
  return new Promise((resolve) => {
    const proc = spawn("node", [join(HOOKS_DIR, hookFile)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ZC_CTX_DIST: "C:\\Users\\Amit\\AI_projects\\SecureContext\\dist" },
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (c) => stdout += c);
    proc.stderr.on("data", (c) => stderr += c);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

// ─── Setup: fresh DB and test files ─────────────────────────────────────────
cleanDb();
writeFileSync(join(PROJECT, "src", "hello.ts"),
  `// A friendly greeting module that exports a single function.
export function hello(name: string): string {
  return "hello, " + name;
}
`);
writeFileSync(join(PROJECT, "src", "calc.ts"),
  `// Arithmetic helpers.
export function add(a: number, b: number): number { return a + b; }
export function mul(a: number, b: number): number { return a * b; }
`);

const SESSION_ID = "hook-test-" + Date.now();
const TEST_PATH_1 = join(PROJECT, "src", "hello.ts").replace(/\\/g, "/");
const TEST_PATH_2 = join(PROJECT, "src", "calc.ts").replace(/\\/g, "/");

// Run migrations by instantiating the DB once
{
  const db = new DatabaseSync(dbPath(PROJECT));
  db.exec("PRAGMA journal_mode = WAL");
  const { runMigrations } = await import("../dist/migrations.js");
  runMigrations(db);
  db.close();
}

console.log("\n=== HOOK LIVE TESTS — v0.10.0 harness ===");
console.log(`project:   ${PROJECT}`);
console.log(`session:   ${SESSION_ID}\n`);

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: PreRead dedup
// ═══════════════════════════════════════════════════════════════════════════
console.log("--- Test 1: preread-dedup.mjs ---");

// 1a. First Read of hello.ts → should ALLOW (exit 0, no "block" decision)
{
  const r = await runHook("preread-dedup.mjs", {
    tool_name: "Read",
    tool_input: { file_path: TEST_PATH_1 },
    session_id: SESSION_ID,
    cwd: PROJECT,
  });
  assert("first Read of hello.ts is allowed",
    r.code === 0 && !r.stdout.includes('"decision":"block"'),
    `exit=${r.code} stdout=${r.stdout.slice(0, 100)}`);
}

// 1b. Second Read of hello.ts → should BLOCK with redirect message
{
  const r = await runHook("preread-dedup.mjs", {
    tool_name: "Read",
    tool_input: { file_path: TEST_PATH_1 },
    session_id: SESSION_ID,
    cwd: PROJECT,
  });
  const parsed = r.stdout ? JSON.parse(r.stdout) : {};
  assert("second Read of hello.ts is BLOCKED",
    parsed.decision === "block",
    `decision=${parsed.decision}`);
  assert("block message mentions zc_file_summary",
    (parsed.reason ?? "").includes("zc_file_summary"));
  assert("block message includes the path",
    (parsed.reason ?? "").includes("hello.ts"));
}

// 1c. Read of calc.ts (different path, same session) → should ALLOW
{
  const r = await runHook("preread-dedup.mjs", {
    tool_name: "Read",
    tool_input: { file_path: TEST_PATH_2 },
    session_id: SESSION_ID,
    cwd: PROJECT,
  });
  assert("Read of different file (calc.ts) is allowed",
    r.code === 0 && !r.stdout.includes('"decision":"block"'));
}

// 1d. Read with different session_id → should ALLOW (per-session dedup)
{
  const r = await runHook("preread-dedup.mjs", {
    tool_name: "Read",
    tool_input: { file_path: TEST_PATH_1 },
    session_id: "different-session",
    cwd: PROJECT,
  });
  assert("Read in different session is allowed (per-session dedup)",
    r.code === 0 && !r.stdout.includes('"decision":"block"'));
}

// 1e. Non-Read tool call → should fall through (noop)
{
  const r = await runHook("preread-dedup.mjs", {
    tool_name: "Glob",
    tool_input: { pattern: "**/*.ts" },
    session_id: SESSION_ID,
    cwd: PROJECT,
  });
  assert("non-Read tool call falls through", r.code === 0 && r.stdout === "");
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: PostEdit reindex
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- Test 2: postedit-reindex.mjs ---");

// 2a. Get baseline: no source_meta entries yet
{
  const db = new DatabaseSync(dbPath(PROJECT));
  const before = db.prepare(`SELECT COUNT(*) as n FROM source_meta WHERE source LIKE 'file:%'`).get();
  db.close();
  assert("baseline: no file entries in source_meta", before.n === 0, `got ${before.n}`);
}

// 2b. Simulate Edit of hello.ts (modify file then fire hook)
writeFileSync(join(PROJECT, "src", "hello.ts"),
  `// EDITED: greeting with exclamation.
export function hello(name: string): string {
  return "HELLO, " + name + "!";
}
`);

{
  const t0 = Date.now();
  const r = await runHook("postedit-reindex.mjs", {
    tool_name: "Edit",
    tool_input: { file_path: TEST_PATH_1 },
    session_id: SESSION_ID,
    cwd: PROJECT,
  });
  const dt = Date.now() - t0;
  console.log(`  [INFO] hook ran in ${dt}ms (includes Ollama 14b summarization)`);
  assert("postedit hook exits 0", r.code === 0, `exit=${r.code} stderr=${r.stderr.slice(0,150)}`);
}

// 2c. Verify source_meta has entry for hello.ts with L0/L1
{
  const db = new DatabaseSync(dbPath(PROJECT));
  const row = db.prepare(
    `SELECT source, l0_summary, l1_summary, created_at FROM source_meta WHERE source LIKE 'file:%hello.ts'`
  ).get();
  db.close();

  assert("source_meta has entry for hello.ts", row !== undefined);
  if (row) {
    assert("L0 summary is non-empty", (row.l0_summary ?? "").length > 0);
    assert("L1 summary is non-empty", (row.l1_summary ?? "").length > 0);
    assert("L0 ≤ 100 chars", row.l0_summary.length <= 100);
    assert("L1 ≤ 1500 chars", row.l1_summary.length <= 1500);
    assert("L0 mentions greeting (semantic, not first-100-chars)",
      /greet|hello|salutation|welcom/i.test(row.l0_summary),
      `L0: ${row.l0_summary}`);
    console.log(`  [INFO] L0: ${row.l0_summary}`);
  }
}

// 2d. Verify session_read_log was cleared for hello.ts
//     (PostEdit should remove the entry so agent can re-Read the fresh version)
{
  const db = new DatabaseSync(dbPath(PROJECT));
  const row = db.prepare(
    `SELECT COUNT(*) as n FROM session_read_log WHERE session_id = ? AND path = ?`
  ).get(SESSION_ID, TEST_PATH_1);
  db.close();
  assert("session_read_log cleared after Edit (can re-Read fresh version)",
    row.n === 0, `got ${row.n} rows`);
}

// 2e. Non-Edit tool → should fall through
{
  const r = await runHook("postedit-reindex.mjs", {
    tool_name: "Read",
    tool_input: { file_path: TEST_PATH_1 },
    session_id: SESSION_ID,
    cwd: PROJECT,
  });
  assert("non-Edit tool falls through (noop)", r.code === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: PostBash capture
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- Test 3: postbash-capture.mjs ---");

// 3a. Short output (< 50 lines) → should fall through
{
  const r = await runHook("postbash-capture.mjs", {
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
    tool_response: { stdout: "hi\n", exit_code: 0 },
    session_id: SESSION_ID,
    cwd: PROJECT,
  });
  assert("short output falls through (no capture)", r.code === 0 && r.stdout === "");
}

// 3b. Long output (100 lines) → should capture to KB
const longOut = Array.from({ length: 100 }, (_, i) => `line ${i+1}: some noisy test output ${Math.random().toString(36).slice(2, 10)}`).join("\n");
{
  const r = await runHook("postbash-capture.mjs", {
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { stdout: longOut, exit_code: 0 },
    session_id: SESSION_ID,
    cwd: PROJECT,
  });
  assert("long output captured (exit 0)", r.code === 0);
  assert("hook returned a modify decision",
    r.stdout.includes('"decision":"modify"') || r.stdout.includes("Captured"),
    `stdout: ${r.stdout.slice(0, 150)}`);
}

// 3c. Verify tool_output_digest has the entry
{
  const db = new DatabaseSync(dbPath(PROJECT));
  const row = db.prepare(
    `SELECT hash, command, exit_code, full_ref FROM tool_output_digest WHERE command = ?`
  ).get("npm test");
  db.close();
  assert("tool_output_digest has 'npm test' entry", row !== undefined);
  if (row) {
    assert("hash is 32 hex chars", /^[a-f0-9]{32}$/.test(row.hash));
    assert("exit_code stored correctly", row.exit_code === 0);
    assert("full_ref has tool_output/ prefix", row.full_ref.startsWith("tool_output/"));
  }
}

// 3d. Verify full output is in KB (FTS-searchable)
{
  const db = new DatabaseSync(dbPath(PROJECT));
  const row = db.prepare(
    `SELECT content FROM knowledge WHERE source LIKE 'tool_output/%' LIMIT 1`
  ).get();
  db.close();
  assert("full bash output stored in knowledge FTS table", row !== undefined);
  if (row) {
    assert("stored content contains the command header",
      row.content.includes("npm test"));
    assert("stored content contains the last line of stdout",
      row.content.includes("line 100"));
  }
}

// 3e. Same command + stdout again → should dedup by hash
{
  const r = await runHook("postbash-capture.mjs", {
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { stdout: longOut, exit_code: 0 },
    session_id: SESSION_ID,
    cwd: PROJECT,
  });
  assert("re-run with same cmd+output still returns cleanly", r.code === 0);

  const db = new DatabaseSync(dbPath(PROJECT));
  const row = db.prepare(`SELECT COUNT(*) as n FROM tool_output_digest WHERE command = ?`).get("npm test");
  db.close();
  assert("dedup: still only ONE tool_output_digest row for 'npm test'",
    row.n === 1, `got ${row.n}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════════════
cleanDb();
try { rmSync(PROJECT, { recursive: true, force: true }); } catch {}

console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  console.log("Failures:");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
