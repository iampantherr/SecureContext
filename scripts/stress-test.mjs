/**
 * Stress test: simulates N concurrent agents each making M MCP tool calls
 * against the SAME project DB. Measures throughput, latency, and — most
 * importantly — chain integrity under concurrent writers.
 *
 * Architectural concern under test:
 *   recordToolCall reads the last row_hash from the table, then INSERTs a
 *   new row whose prev_hash links to it. The read and insert are NOT
 *   atomic. With concurrent writers, two processes can read the same last
 *   row_hash and both write rows claiming the same prev_hash → chain
 *   integrity verification fails.
 *
 * Usage:
 *   node scripts/stress-test.mjs [workers] [calls_per_worker] [project_dir?]
 *   node scripts/stress-test.mjs --worker <projectPath> <calls> <workerId>  (internal)
 *
 * Examples:
 *   node scripts/stress-test.mjs 1 1000   # baseline: single-writer ceiling
 *   node scripts/stress-test.mjs 10 100   # target: 10 agents × 100 calls
 *   node scripts/stress-test.mjs 20 100   # stress: 20 agents
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

// ── Worker mode ─────────────────────────────────────────────────────────
if (process.argv[2] === "--worker") {
  const projectPath = process.argv[3];
  const callCount   = parseInt(process.argv[4], 10);
  const workerId    = process.argv[5];

  const { recordToolCall, newCallId } = await import("../dist/telemetry.js");

  const TOOLS = ["Read", "Edit", "Bash", "zc_search", "zc_status", "zc_remember"];
  const latencies = [];
  let successes = 0, failures = 0;
  const start = Date.now();

  for (let i = 0; i < callCount; i++) {
    const t0 = Date.now();
    const r = recordToolCall({
      callId:    newCallId(),
      sessionId: `stress-${workerId}`,
      agentId:   `agent-${workerId}`,
      projectPath,
      toolName:  TOOLS[i % TOOLS.length],
      model:     "claude-sonnet-4-6",
      inputTokens:  50 + (i % 10),
      outputTokens: 25 + (i % 5),
      latencyMs:    5 + (i % 20),
      status:    "ok",
    });
    latencies.push(Date.now() - t0);
    if (r) successes++; else failures++;
  }

  latencies.sort((a, b) => a - b);
  const elapsed = Date.now() - start;
  const p50 = latencies[Math.floor(latencies.length * 0.50)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];

  console.log(JSON.stringify({ workerId, successes, failures, elapsed, p50, p95, p99 }));
  process.exit(0);
}

// ── Coordinator mode ────────────────────────────────────────────────────
const N = parseInt(process.argv[2] ?? "10", 10);
const M = parseInt(process.argv[3] ?? "100", 10);
const projectPath = process.argv[4] ?? join(tmpdir(), "zc-stress-" + Date.now());

mkdirSync(projectPath, { recursive: true });

// Clean any prior DB for this project
const projectHash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
const dbPath = join(homedir(), ".claude", "zc-ctx", "sessions", projectHash + ".db");
for (const sfx of ["", "-wal", "-shm"]) {
  try { if (existsSync(dbPath + sfx)) unlinkSync(dbPath + sfx); } catch {}
}

console.log("═".repeat(70));
console.log(`Stress test: ${N} concurrent workers × ${M} calls = ${N*M} total`);
console.log(`Project: ${projectPath}`);
console.log(`DB:      ${dbPath}`);
console.log("═".repeat(70));

const start = Date.now();
const promises = [];
for (let i = 0; i < N; i++) {
  promises.push(new Promise((resolve, reject) => {
    const c = spawn("node", [SELF, "--worker", projectPath, String(M), `w${i}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => stdout += d);
    c.stderr.on("data", (d) => stderr += d);
    c.on("exit", (code) => {
      if (code !== 0) {
        return reject(new Error(`Worker ${i} exited ${code}: ${stderr.slice(0, 300)}`));
      }
      try {
        const lastJsonLine = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
        resolve(JSON.parse(lastJsonLine));
      } catch (e) {
        reject(new Error(`Worker ${i} bad JSON: ${stdout.slice(0, 300)}`));
      }
    });
    c.on("error", reject);
  }));
}

const results = await Promise.all(promises);
const wallElapsed = Date.now() - start;

const totalSuccess = results.reduce((s, r) => s + r.successes, 0);
const totalFail    = results.reduce((s, r) => s + r.failures, 0);
const allLatencies = []; // we don't have raw latencies, but we have per-worker pXX
const avgWorkerElapsed = results.reduce((s, r) => s + r.elapsed, 0) / results.length;
const maxWorkerElapsed = Math.max(...results.map((r) => r.elapsed));
const minWorkerElapsed = Math.min(...results.map((r) => r.elapsed));

const worstP95 = Math.max(...results.map((r) => r.p95));
const worstP99 = Math.max(...results.map((r) => r.p99));

console.log("\nThroughput");
console.log("──────────");
console.log(`  Wall-clock total: ${wallElapsed}ms`);
console.log(`  Worker elapsed:   min=${minWorkerElapsed}ms  avg=${avgWorkerElapsed.toFixed(0)}ms  max=${maxWorkerElapsed}ms`);
console.log(`  Throughput:       ${(totalSuccess / wallElapsed * 1000).toFixed(1)} writes/sec`);
console.log(`  Successes:        ${totalSuccess}/${N*M}  (${(totalSuccess/(N*M)*100).toFixed(1)}%)`);
console.log(`  Failures:         ${totalFail}`);

console.log("\nPer-call latency (worst across workers)");
console.log("───────────────────────────────────────");
console.log(`  worst worker p95: ${worstP95}ms`);
console.log(`  worst worker p99: ${worstP99}ms`);

// Verify chain
console.log("\nChain integrity");
console.log("───────────────");
const { verifyToolCallChain } = await import("../dist/telemetry.js");
const v = verifyToolCallChain(projectPath);
console.log(`  Total rows in DB: ${v.totalRows}`);
console.log(`  Chain verified:   ${v.ok ? "✓ OK" : "✗ BROKEN at id " + v.brokenAt + " (" + v.brokenKind + ")"}`);
if (!v.ok) {
  console.log(`  → A broken chain under concurrent load is the architecture concern`);
  console.log(`     described in the test header. ${v.brokenKind === "prev-mismatch"
                ? "Two workers read the same prev_hash and raced."
                : "Row content was modified between hashing and read-back."}`);
}

const wroteRows = v.totalRows;
const lostRows = (N*M) - wroteRows;
if (lostRows > 0) {
  console.log(`  ⚠ ${lostRows} writes silently dropped (returned null from recordToolCall)`);
}

// Cleanup
try { rmSync(projectPath, { recursive: true, force: true }); } catch {}
for (const sfx of ["", "-wal", "-shm"]) {
  try { if (existsSync(dbPath + sfx)) unlinkSync(dbPath + sfx); } catch {}
}

process.exit(v.ok && totalFail === 0 ? 0 : 1);
