/**
 * Multi-project stress: workers split across N projects.
 * Should scale linearly with project count since no shared DB.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECTS = 5;
const WORKERS_PER_PROJECT = 4;
const CALLS_PER_WORKER = 100;
const TOTAL = PROJECTS * WORKERS_PER_PROJECT * CALLS_PER_WORKER;

const projectPaths = [];
for (let i = 0; i < PROJECTS; i++) {
  const p = join(tmpdir(), `zc-stress-mp-${Date.now()}-${i}`);
  mkdirSync(p, { recursive: true });
  projectPaths.push(p);
  // Clean DB
  const h = createHash("sha256").update(p).digest("hex").slice(0, 16);
  const db = join(homedir(), ".claude", "zc-ctx", "sessions", h + ".db");
  for (const sfx of ["", "-wal", "-shm"]) { try { if (existsSync(db + sfx)) unlinkSync(db + sfx); } catch {} }
}

const SELF_DIR = join(import.meta.url.replace("file:///", "").replace(/\//g, "\\"), "..");
const STRESS_SCRIPT = fileURLToPath(new URL("./stress-test.mjs", import.meta.url));

console.log("═".repeat(70));
console.log(`Multi-project stress: ${PROJECTS} projects × ${WORKERS_PER_PROJECT} workers × ${CALLS_PER_WORKER} calls = ${TOTAL} total`);
console.log("═".repeat(70));

const start = Date.now();
const promises = [];
for (let p = 0; p < PROJECTS; p++) {
  for (let w = 0; w < WORKERS_PER_PROJECT; w++) {
    promises.push(new Promise((resolve, reject) => {
      const c = spawn("node", [STRESS_SCRIPT, "--worker", projectPaths[p], String(CALLS_PER_WORKER), `p${p}w${w}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      c.stdout.on("data", (d) => out += d);
      c.stderr.on("data", (d) => err += d);
      c.on("exit", (code) => {
        if (code !== 0) return reject(new Error(`p${p}w${w} exit ${code}: ${err.slice(0,200)}`));
        try {
          const last = out.trim().split("\n").reverse().find((l) => l.startsWith("{"));
          resolve({ project: p, ...JSON.parse(last) });
        } catch (e) { reject(new Error(`p${p}w${w} bad json: ${out.slice(0,200)}`)); }
      });
      c.on("error", reject);
    }));
  }
}

const results = await Promise.all(promises);
const elapsed = Date.now() - start;

const totalSuccess = results.reduce((s, r) => s + r.successes, 0);
const totalFail    = results.reduce((s, r) => s + r.failures, 0);

console.log(`\nThroughput`);
console.log(`──────────`);
console.log(`  Wall-clock:  ${elapsed}ms`);
console.log(`  Throughput:  ${(totalSuccess / elapsed * 1000).toFixed(1)} writes/sec`);
console.log(`  Success:     ${totalSuccess}/${TOTAL}  (${(totalSuccess/TOTAL*100).toFixed(1)}%)`);
console.log(`  Failures:    ${totalFail}`);

// Per-project chain check
console.log(`\nChain integrity per project (${WORKERS_PER_PROJECT} concurrent writers each)`);
console.log(`──────────────────────────────────────────────────────────`);
const { verifyToolCallChain } = await import("../dist/telemetry.js");
let allOk = true;
for (let p = 0; p < PROJECTS; p++) {
  const v = verifyToolCallChain(projectPaths[p]);
  console.log(`  project ${p}: ${v.totalRows} rows, chain ${v.ok ? "✓ OK" : "✗ BROKEN at id " + v.brokenAt + " (" + v.brokenKind + ")"}`);
  if (!v.ok) allOk = false;
}

// Cleanup
for (const p of projectPaths) {
  try { rmSync(p, { recursive: true, force: true }); } catch {}
  const h = createHash("sha256").update(p).digest("hex").slice(0, 16);
  const db = join(homedir(), ".claude", "zc-ctx", "sessions", h + ".db");
  for (const sfx of ["", "-wal", "-shm"]) { try { if (existsSync(db + sfx)) unlinkSync(db + sfx); } catch {} }
}

console.log(`\n${allOk ? "✓ multi-project linear scaling holds" : "✗ even multi-project shows breakage"}`);
process.exit(allOk ? 0 : 1);
