/**
 * E2E test — v0.10.2 auto-indexing (SessionStart hook + background indexer + banner)
 * ===================================================================================
 *
 * Exercises the full flow end-to-end with real filesystem + real DB + real
 * Ollama. Six scenarios that mirror actual user situations.
 *
 * Run: node scripts/test-autoindex-live.mjs
 *
 * Pre-reqs:
 *   - Docker Ollama reachable (ZC_OLLAMA_URL)
 *   - qwen2.5-coder:14b (or any coder model in the preference list) installed
 */

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { runMigrations }     from "../dist/migrations.js";
import { getIndexingStatus } from "../dist/harness.js";
import { getSystemHealth, formatHealthBanner, resetHealthCache } from "../dist/harness.js";

const DB_DIR   = join(homedir(), ".claude", "zc-ctx", "sessions");
const SC_ROOT  = join(homedir(), "AI_projects", "SecureContext");
const BG_IDX   = join(SC_ROOT, "scripts", "background-index.mjs");
const HOOK_PS1 = join(SC_ROOT, "hooks", "session-start-index-check.ps1");
mkdirSync(DB_DIR, { recursive: true });

let passed = 0, failed = 0;
const fails = [];

function assert(label, cond, detail) {
  if (cond) { console.log(`  [PASS] ${label}`); passed++; }
  else      { console.log(`  [FAIL] ${label}${detail ? " — " + detail : ""}`); fails.push(label); failed++; }
}

function dbFileFor(projectPath) {
  const h = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(DB_DIR, `${h}.db`);
}
function statusFileFor(projectPath) {
  const h = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(DB_DIR, `${h}.indexing.status`);
}

function cleanup(projectPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = dbFileFor(projectPath) + suffix;
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
  const s = statusFileFor(projectPath);
  try { if (existsSync(s)) unlinkSync(s); } catch {}
  try { rmSync(projectPath, { recursive: true, force: true }); } catch {}
}

function mkProject(tag, fileCount = 3) {
  const p = join(tmpdir(), `zc-ai-test-${tag}-${Date.now()}`);
  mkdirSync(join(p, "src"), { recursive: true });
  // Project marker — use an empty .git dir so package.json doesn't show up in
  // INDEX_FILE_EXTENSIONS (.json is indexable, which would inflate file counts)
  mkdirSync(join(p, ".git"), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(p, "src", `file${i}.ts`),
      `// File ${i}: a tiny module.\nexport const value${i} = ${i};\nexport function describe${i}() { return "describes value${i}"; }\n`);
  }
  return p;
}

async function waitForIndexingComplete(projectPath, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = getIndexingStatus(projectPath);
    if (s.state === "indexed") return s;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("indexing did not complete in time");
}

function runHook(projectPath) {
  // Run the hook with cwd set to the project so it picks up the project path correctly
  const res = spawnSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", HOOK_PS1,
  ], {
    cwd: projectPath,
    encoding: "utf8",
    env: { ...process.env, ZC_CTX_DIST: join(SC_ROOT, "dist") },
  });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

console.log("\n=== AUTO-INDEX E2E TESTS — v0.10.2 ===\n");

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 1 — Fresh project with no marker (bare directory)
// Hook should silently no-op; no background indexer spawned.
// ═══════════════════════════════════════════════════════════════════════════
console.log("--- Scenario 1: bare directory (no project markers) ---");
{
  const p = join(tmpdir(), `zc-ai-test-bare-${Date.now()}`);
  mkdirSync(p, { recursive: true });
  // NO package.json, NO .git, NO CLAUDE.md — not a project
  try {
    const r = runHook(p);
    assert("hook exits 0 on non-project dir", r.code === 0, `exit=${r.code}`);
    assert("no <system-reminder> emitted",    !r.stdout.includes("system-reminder"),
      `stdout length=${r.stdout.length}`);
    assert("no status file created",         !existsSync(statusFileFor(p)));
  } finally {
    cleanup(p);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 2 — Existing project with 3 files, first time seeing it
// Hook spawns background indexer → status file appears → indexer completes →
// source_meta populated → health banner transitions onboarding → full.
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- Scenario 2: existing project, first time (3 files) ---");
{
  const p = mkProject("scenario2", 3);
  try {
    // Pre: no status, no DB
    assert("pre: no status file",          !existsSync(statusFileFor(p)));
    assert("pre: no DB file",              !existsSync(dbFileFor(p)));

    // Run hook
    const r = runHook(p);
    assert("hook exits 0",                 r.code === 0);
    assert("hook emitted onboarding reminder",
      r.stdout.includes("Background indexing") || r.stdout.includes("background indexer"),
      `stdout first 200 chars: ${r.stdout.slice(0, 200)}`);

    // Poll: status file should appear — OR indexing may complete before we
    // observe it (on fast GPU with tiny files, full run is ~2s). Both are
    // valid outcomes. If we see neither appearance NOR completion within 10s,
    // that's a real failure.
    let appeared = false;
    let finalStatus = null;
    for (let i = 0; i < 60; i++) {  // 12s max
      if (existsSync(statusFileFor(p))) { appeared = true; break; }
      const s = getIndexingStatus(p);
      if (s.state === "indexed") { finalStatus = s; break; }
      await new Promise(r2 => setTimeout(r2, 200));
    }
    assert("status file appeared OR indexing completed fast",
      appeared || (finalStatus?.state === "indexed"));

    // Wait for completion (no-op if already done)
    if (!finalStatus) finalStatus = await waitForIndexingComplete(p);
    assert("indexing completed (status=indexed)",  finalStatus.state === "indexed");
    assert("all 3 files indexed",                  finalStatus.fileCountInKb === 3,
      `got ${finalStatus.fileCountInKb}`);

    // Status file should have been deleted post-completion
    assert("status file cleaned up after completion", !existsSync(statusFileFor(p)));

    // Health banner check: should be full mode now
    resetHealthCache();
    const health  = await getSystemHealth(p);
    const banner  = formatHealthBanner(health);
    assert("health.mode === 'full' after indexing", health.mode === "full",
      `got mode=${health.mode}`);
    assert("banner is empty in full mode", banner === "",
      `banner length: ${banner.length}`);
  } finally {
    cleanup(p);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3 — Already-indexed project, hook is a no-op
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- Scenario 3: already-indexed project ---");
{
  const p = mkProject("scenario3", 2);
  try {
    // Prime the DB: pretend indexing already happened
    const db = new DatabaseSync(dbFileFor(p));
    db.exec("PRAGMA journal_mode = WAL");
    runMigrations(db);
    db.prepare(
      `INSERT OR REPLACE INTO source_meta(source, source_type, retention_tier, created_at, l0_summary, l1_summary)
       VALUES (?, 'internal', 'internal', ?, ?, ?)`
    ).run("file:src/file0.ts", new Date().toISOString(), "pre-indexed", "pre-indexed detail");
    db.close();

    const s0 = getIndexingStatus(p);
    assert("pre: getIndexingStatus reports 'indexed'", s0.state === "indexed");

    const r = runHook(p);
    assert("hook exits 0",                                  r.code === 0);
    assert("hook does NOT emit onboarding reminder",        !r.stdout.includes("Background indexing"),
      `unexpected stdout: ${r.stdout.slice(0, 200)}`);

    // Give it a moment to make sure no background indexer spawned
    await new Promise(r => setTimeout(r, 1500));
    assert("no status file created (already indexed)",      !existsSync(statusFileFor(p)));
  } finally {
    cleanup(p);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 4 — Concurrent hook invocation (resume after compact)
// Two hook calls in quick succession; second sees "indexing" state.
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- Scenario 4: concurrent hook (second call sees 'indexing') ---");
{
  const p = mkProject("scenario4", 4);
  try {
    // First hook: spawns indexer
    const r1 = runHook(p);
    assert("first hook exits 0",             r1.code === 0);
    assert("first hook emits onboarding",    (r1.stdout.includes("Background indexing") || r1.stdout.includes("background indexer")));

    // Give it a moment to write the initial status file — OR race to completion
    let statusWritten = false;
    let fastDone = false;
    for (let i = 0; i < 30; i++) {
      if (existsSync(statusFileFor(p))) { statusWritten = true; break; }
      if (getIndexingStatus(p).state === "indexed") { fastDone = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert("initial status file present OR fast completion",    statusWritten || fastDone);

    // Second hook (simulating resume-after-compact)
    const r2 = runHook(p);
    assert("second hook exits 0",            r2.code === 0);

    // It can legitimately see EITHER 'indexing' (if still running) OR
    // 'indexed' (if indexing was very fast) — both are correct behaviors.
    // It should NOT emit the "starting indexer" message.
    const saidStarting = r2.stdout.includes("just started");
    assert("second hook does NOT claim to 'just start' indexing", !saidStarting,
      `second hook stdout: ${r2.stdout.slice(0, 200)}`);

    // Wait for completion
    await waitForIndexingComplete(p);
    const final = getIndexingStatus(p);
    assert("final state is indexed",         final.state === "indexed");
    assert("all 4 files indexed",            final.fileCountInKb === 4);
  } finally {
    cleanup(p);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 5 — Stale status file (crashed prior run, > 1h old)
// Hook + bg-indexer should treat it as stale and start fresh.
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- Scenario 5: stale status file (simulated crash) ---");
{
  const p = mkProject("scenario5", 2);
  try {
    // Write a stale status file (started_at 2h ago, not finished)
    writeFileSync(statusFileFor(p), JSON.stringify({
      projectPath: p,
      started_at:  new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      total_files: 99, completed_files: 1,
      finished_at: null, error: null, pid: 99999,
    }));

    const s0 = getIndexingStatus(p);
    // Stale means treat as not-indexed (since no files in KB)
    assert("stale status → treated as not-indexed", s0.state === "not-indexed",
      `got state=${s0.state}`);

    const r = runHook(p);
    assert("hook exits 0 on stale status",   r.code === 0);
    assert("hook starts fresh indexer",
      r.stdout.includes("Background indexing") || r.stdout.includes("background indexer"));

    await waitForIndexingComplete(p);
    const final = getIndexingStatus(p);
    assert("fresh run completes successfully", final.state === "indexed");
    assert("all 2 files indexed",              final.fileCountInKb === 2,
      `got ${final.fileCountInKb}`);
  } finally {
    cleanup(p);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 6 — Health banner transitions correctly through lifecycle
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- Scenario 6: health banner lifecycle (not-indexed → indexing → indexed) ---");
{
  const p = mkProject("scenario6", 3);
  try {
    // State A: not indexed
    resetHealthCache();
    const hA = await getSystemHealth(p);
    const bA = formatHealthBanner(hA);
    assert("A: mode=onboarding for not-indexed",  hA.mode === "onboarding" || hA.mode === "degraded",
      `got ${hA.mode}`);
    // Accept either banner — onboarding shows "no indexed source files"; degraded shows warnings.
    // In our local full-mode Docker Ollama setup, it's onboarding.
    if (hA.mode === "onboarding") {
      assert("A: banner mentions 'not indexed' or 'no indexed'",
        bA.includes("no indexed") || bA.includes("not indexed") || bA.includes("zc_index_project"));
    }

    // Trigger indexer via hook
    runHook(p);

    // State B: indexing in progress — poll for status file
    let sawIndexing = false;
    for (let i = 0; i < 60; i++) {
      resetHealthCache();
      const hB = await getSystemHealth(p);
      if (hB.mode === "onboarding" && hB.indexingStatus?.state === "indexing") {
        sawIndexing = true;
        const bB = formatHealthBanner(hB);
        assert("B: banner mentions 'indexing in progress'",
          bB.toLowerCase().includes("indexing"),
          `banner: ${bB.slice(0, 200)}`);
        break;
      }
      if (hB.mode === "full") break;  // indexing finished before we polled
      await new Promise(r2 => setTimeout(r2, 200));
    }
    // Indexing may be too fast to observe on small projects; don't fail if we missed it,
    // but warn.
    if (!sawIndexing) console.log("  [info] indexing completed too fast to observe 'in progress' state (4 files × 2s = ~8s)");

    // Wait for completion
    await waitForIndexingComplete(p);

    // State C: full mode
    resetHealthCache();
    const hC = await getSystemHealth(p);
    const bC = formatHealthBanner(hC);
    assert("C: mode=full after indexing",      hC.mode === "full");
    assert("C: banner is empty in full mode",  bC === "");
  } finally {
    cleanup(p);
  }
}

console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  console.log("Failures:");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
