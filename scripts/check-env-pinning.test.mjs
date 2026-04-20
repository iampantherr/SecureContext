#!/usr/bin/env node
/**
 * Tests for scripts/check-env-pinning.mjs
 * =========================================
 *
 * Self-contained harness — creates temp src/ + start-agents.ps1 fixtures
 * that exercise every category of rule the linter enforces, invokes the
 * linter as a child process, and asserts on exit code + output.
 *
 * Run: node scripts/check-env-pinning.test.mjs
 * (not a vitest file — the linter itself is a CLI; simpler to spawn it)
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const linterPath = fileURLToPath(new URL("./check-env-pinning.mjs", import.meta.url));

let pass = 0;
let fail = 0;
const failures = [];

function runLinter(tmpScRoot, tmpDispatcher) {
  // The linter resolves src/ relative to its own location, so we copy it
  // into a sibling `scripts/` under the fake scRoot for the test.
  const fakeScripts = join(tmpScRoot, "scripts");
  mkdirSync(fakeScripts, { recursive: true });
  const copyPath = join(fakeScripts, "check-env-pinning.mjs");
  // Read + write rather than fs.copy so we don't introduce a new dep
  const body = readFileSync(linterPath, "utf8");
  writeFileSync(copyPath, body, "utf8");

  const result = spawnSync(process.execPath, [copyPath, "--dispatcher-path", tmpDispatcher], {
    encoding: "utf8",
    env: { ...process.env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function setupFixture(srcFiles, dispatcherScript) {
  const tmpSc = mkdtempSync(join(tmpdir(), "env-lint-sc-"));
  const tmpDisp = mkdtempSync(join(tmpdir(), "env-lint-disp-"));
  const srcDir = join(tmpSc, "src");
  mkdirSync(srcDir, { recursive: true });
  for (const [name, content] of Object.entries(srcFiles)) {
    writeFileSync(join(srcDir, name), content, "utf8");
  }
  writeFileSync(join(tmpDisp, "start-agents.ps1"), dispatcherScript, "utf8");
  return { tmpSc, tmpDisp };
}

function cleanup(tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }

function assert(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? "\n      " + detail : ""}`); }
}

// ─── Test 1: a happy-path fixture with all three var categories ──────────────

const goodDispatcher = `
# Minimal start-agents.ps1 fixture
$orchLauncher = @"
\`$env:ZC_AGENT_ID   = 'orchestrator'
\`$env:ZC_AGENT_ROLE = 'orchestrator'
\`$env:ZC_AGENT_MODEL = 'claude-opus-4-7'
"@

if (\$zcApiUrl) { \$orchEnvBlock = "\\\`$env:ZC_API_URL = '\$zcApiUrl'\\n\\\`$env:ZC_API_KEY = '\$zcApiKey'\\n" }
if (\$zcPgHost) { \$orchEnvBlock += "\\\`$env:ZC_POSTGRES_HOST = '\$zcPgHost'\\n" }
if (\$zcPgPort) { \$orchEnvBlock += "\\\`$env:ZC_POSTGRES_PORT = '\$zcPgPort'\\n" }
if (\$zcPgUser) { \$orchEnvBlock += "\\\`$env:ZC_POSTGRES_USER = '\$zcPgUser'\\n" }
if (\$zcPgPassword) { \$orchEnvBlock += "\\\`$env:ZC_POSTGRES_PASSWORD = '\$zcPgPassword'\\n" }
if (\$zcPgDb) { \$orchEnvBlock += "\\\`$env:ZC_POSTGRES_DB = '\$zcPgDb'\\n" }
if (\$zcBackend) { \$orchEnvBlock += "\\\`$env:ZC_TELEMETRY_BACKEND = '\$zcBackend'\\n" }

$workerLauncher = @"
\`$env:ZC_AGENT_ID    = '\$agentName'
\`$env:ZC_AGENT_ROLE  = '\$roleName'
\`$env:ZC_AGENT_MODEL = 'claude-sonnet-4-6'
"@
`;

{
  console.log("--- test 1: happy path — all 3 critical + shared pinned ---");
  const { tmpSc, tmpDisp } = setupFixture({
    "a.ts": "const x = process.env.ZC_AGENT_ID; const y = process.env.ZC_AGENT_ROLE; const z = process.env.ZC_AGENT_MODEL;",
    "b.ts": "const a = process.env.ZC_API_URL; const b = process.env.ZC_POSTGRES_HOST; const c = process.env.ZC_LOG_LEVEL;",
  }, goodDispatcher);
  const r = runLinter(tmpSc, tmpDisp);
  assert("exit code 0", r.status === 0, `status=${r.status}\n${r.stdout}${r.stderr}`);
  assert("reports all 3 critical found", /critical \(must be pinned per-agent\): 3/.test(r.stdout));
  assert("no unclassified", /unclassified.*\(NEED REVIEW\):\s+0/.test(r.stdout));
  assert("no CRITICAL violations", !/CRITICAL-pin violations/.test(r.stdout));
  cleanup(tmpSc); cleanup(tmpDisp);
}

// ─── Test 2: missing ZC_AGENT_ID in orchLauncher → CRITICAL violation ─────

{
  console.log("\n--- test 2: missing ZC_AGENT_ID in orchLauncher — CRITICAL violation ---");
  const badDispatcher = goodDispatcher.replace(
    "\`$env:ZC_AGENT_ID   = 'orchestrator'\n",
    "# ZC_AGENT_ID intentionally missing\n"
  );
  const { tmpSc, tmpDisp } = setupFixture({
    "a.ts": "const x = process.env.ZC_AGENT_ID; const y = process.env.ZC_AGENT_ROLE; const z = process.env.ZC_AGENT_MODEL;",
  }, badDispatcher);
  const r = runLinter(tmpSc, tmpDisp);
  assert("exit code 1", r.status === 1, `status=${r.status}\n${r.stdout}`);
  assert("reports ZC_AGENT_ID missing from orchLauncher", /CRITICAL ZC_AGENT_ID NOT pinned in orchLauncher/.test(r.stdout));
  cleanup(tmpSc); cleanup(tmpDisp);
}

// ─── Test 3: unclassified var → fail ─────────────────────────────────────

{
  console.log("\n--- test 3: new ZC_NOVEL_VAR without classification — FAIL ---");
  const { tmpSc, tmpDisp } = setupFixture({
    "x.ts": "const q = process.env.ZC_AGENT_ID; const z = process.env.ZC_NOVEL_VAR;",
  }, goodDispatcher);
  const r = runLinter(tmpSc, tmpDisp);
  assert("exit code 1 (unclassified)", r.status === 1, `status=${r.status}\n${r.stdout}`);
  assert("reports ZC_NOVEL_VAR", /ZC_NOVEL_VAR/.test(r.stdout));
  assert("tells operator to classify", /classify in scripts\/check-env-pinning\.mjs/.test(r.stdout));
  cleanup(tmpSc); cleanup(tmpDisp);
}

// ─── Test 4: SHARED var missing from scope → warning only (not fail) ─────

{
  console.log("\n--- test 4: SHARED var missing from worker propagation — warning only ---");
  // Remove the ZC_POSTGRES_USER line from the worker propagation entirely
  const badDispatcher = goodDispatcher
    .replace(/if \(\$zcPgUser\)[^\n]+\n/, "# ZC_POSTGRES_USER propagation removed\n");
  const { tmpSc, tmpDisp } = setupFixture({
    "a.ts": "const x = process.env.ZC_AGENT_ID; const y = process.env.ZC_AGENT_ROLE; const z = process.env.ZC_AGENT_MODEL; const u = process.env.ZC_POSTGRES_USER;",
  }, badDispatcher);
  const r = runLinter(tmpSc, tmpDisp);
  // Missing SHARED generates warnings but doesn't fail (warnings != problems)
  assert("exit code 0 (warning not fatal)", r.status === 0, `status=${r.status}\n${r.stdout}`);
  assert("prints SHARED warning", /SHARED ZC_POSTGRES_USER missing/.test(r.stdout));
  cleanup(tmpSc); cleanup(tmpDisp);
}

// ─── Test 5: bracket-notation reference (process.env['ZC_X']) also detected ─

{
  console.log("\n--- test 5: bracket-notation env ref is detected ---");
  const { tmpSc, tmpDisp } = setupFixture({
    "a.ts": `const x = process.env['ZC_AGENT_ID']; const y = process.env["ZC_AGENT_ROLE"]; const z = process.env.ZC_AGENT_MODEL;`,
  }, goodDispatcher);
  const r = runLinter(tmpSc, tmpDisp);
  assert("exit code 0", r.status === 0, `status=${r.status}\n${r.stdout}`);
  assert("all 3 critical counted", /critical \(must be pinned per-agent\): 3/.test(r.stdout));
  cleanup(tmpSc); cleanup(tmpDisp);
}

// ─── Test 6: dispatcher path missing → exit 2 ────────────────────────────

{
  console.log("\n--- test 6: missing dispatcher path — exit 2 ---");
  const tmpSc = mkdtempSync(join(tmpdir(), "env-lint-sc-"));
  mkdirSync(join(tmpSc, "src"), { recursive: true });
  writeFileSync(join(tmpSc, "src", "a.ts"), "const x = process.env.ZC_AGENT_ID;", "utf8");
  // Pass a path that doesn't exist
  const fakeScripts = join(tmpSc, "scripts");
  mkdirSync(fakeScripts, { recursive: true });
  const body = readFileSync(linterPath, "utf8");
  writeFileSync(join(fakeScripts, "check-env-pinning.mjs"), body, "utf8");
  const result = spawnSync(process.execPath, [join(fakeScripts, "check-env-pinning.mjs"), "--dispatcher-path", "/nonexistent/path/definitely"], { encoding: "utf8" });
  assert("exit code 2", result.status === 2, `status=${result.status}`);
  cleanup(tmpSc);
}

console.log(`\n${pass + fail} total, ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
