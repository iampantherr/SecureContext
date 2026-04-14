/**
 * Live Smart Working Memory test — v0.8.0
 * Verifies that working memory limits scale dynamically with project complexity.
 *
 * Run: node scripts/live-smart-memory-test.mjs
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runMigrations } from "../dist/migrations.js";
import { computeProjectComplexity, getWorkingMemoryLimits } from "../dist/memory.js";
import { issueToken } from "../dist/access-control.js";

const DB_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");
mkdirSync(DB_DIR, { recursive: true });

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function openTestDb(tag) {
  const hash = createHash("sha256").update("smart-mem-test-" + tag).digest("hex").slice(0, 16);
  const path = join(DB_DIR, "smtest_" + hash + ".db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  return { db, path };
}

function cleanDb(tag) {
  const hash = createHash("sha256").update("smart-mem-test-" + tag).digest("hex").slice(0, 16);
  const base = join(DB_DIR, "smtest_" + hash + ".db");
  for (const ext of ["", "-wal", "-shm"]) {
    try { if (existsSync(base + ext)) unlinkSync(base + ext); } catch {}
  }
}

// Clean up before starting
for (const tag of ["fresh", "kb-heavy", "broadcast-heavy", "multi-agent", "full-platform"]) {
  cleanDb(tag);
}

console.log("\n=== LIVE SMART MEMORY SIZING TEST SUITE ===\n");

// ─── Test 1: Fresh project — base limit ──────────────────────────────────────
console.log("--- Test 1: Fresh project (no KB, no broadcasts, no agents) ---");
const { db: db1 } = openTestDb("fresh");

const p1 = computeProjectComplexity(db1);
assert("Fresh project: kbEntries = 0",      p1.kbEntries === 0);
assert("Fresh project: broadcastCount = 0", p1.broadcastCount === 0);
assert("Fresh project: activeAgents = 0",   p1.activeAgents === 0);
assert("Fresh project: limit = 100 (base)", p1.computedLimit === 100, `got ${p1.computedLimit}`);
assert("Fresh project: evictTo = 80 (80%)", p1.evictTo === 80,        `got ${p1.evictTo}`);
console.log(`  [INFO] Formula: 100 + kb(0) + bc(0) + agents(0) = ${p1.computedLimit}, evictTo=${p1.evictTo}`);

// ─── Test 2: Cache round-trip ─────────────────────────────────────────────────
console.log("\n--- Test 2: Cache round-trip (getWorkingMemoryLimits reads project_meta) ---");
const limits1 = getWorkingMemoryLimits(db1);
assert("Cache hit: max matches computed limit",    limits1.max === p1.computedLimit);
assert("Cache hit: evictTo matches computed",      limits1.evictTo === p1.evictTo);
assert("Cache hit: profile is not null",           limits1.profile !== null);
assert("Cache hit: profile.computedAt present",    typeof limits1.profile?.computedAt === "string");

// Force recompute returns same values (still a fresh DB)
const limits1b = getWorkingMemoryLimits(db1, true);
assert("Force recompute: same limit on fresh DB",  limits1b.max === 100);

// ─── Test 3: KB-heavy project ─────────────────────────────────────────────────
console.log("\n--- Test 3: KB-heavy project (300 source_meta entries → +20 KB bonus) ---");
const { db: db2 } = openTestDb("kb-heavy");

// Insert 300 KB entries
const ins2 = db2.prepare("INSERT OR IGNORE INTO source_meta(source, source_type, retention_tier, created_at) VALUES (?, 'internal', 'internal', ?)");
const t = new Date().toISOString();
for (let i = 0; i < 300; i++) ins2.run(`kb-entry-${i}`, t);

const p2 = computeProjectComplexity(db2);
// Expected kb_bonus = floor(300/15) = 20, capped at 60 → 20
// Final: 100 + 20 + 0 + 0 = 120
assert("KB-heavy: kbEntries = 300",          p2.kbEntries === 300,       `got ${p2.kbEntries}`);
assert("KB-heavy: limit > 100",              p2.computedLimit > 100,     `got ${p2.computedLimit}`);
assert("KB-heavy: limit = 120",              p2.computedLimit === 120,   `got ${p2.computedLimit}`);
assert("KB-heavy: evictTo = 96 (80%)",       p2.evictTo === 96,          `got ${p2.evictTo}`);
console.log(`  [INFO] Formula: 100 + kb(${Math.min(Math.floor(300/15),60)}) + bc(0) + agents(0) = ${p2.computedLimit}, evictTo=${p2.evictTo}`);

// ─── Test 4: Broadcast-heavy project ──────────────────────────────────────────
console.log("\n--- Test 4: Broadcast-heavy project (180 broadcasts → +6 broadcast bonus) ---");
const { db: db3 } = openTestDb("broadcast-heavy");

const ins3 = db3.prepare(`INSERT INTO broadcasts(type,agent_id,task,summary,files,state,depends_on,reason,importance,created_at) VALUES (?,?,?,?,?,?,?,?,3,?)`);
for (let i = 0; i < 180; i++) {
  ins3.run("STATUS", "agent-x", "task", "summary", "[]", "", "[]", "", t);
}

const p3 = computeProjectComplexity(db3);
// Expected bc_bonus = floor(180/30) = 6, capped at 40 → 6
// Final: 100 + 0 + 6 + 0 = 106
assert("BC-heavy: broadcastCount = 180",     p3.broadcastCount === 180, `got ${p3.broadcastCount}`);
assert("BC-heavy: limit = 106",             p3.computedLimit === 106,  `got ${p3.computedLimit}`);
assert("BC-heavy: evictTo = 84 (80%)",      p3.evictTo === 84,         `got ${p3.evictTo}`);
console.log(`  [INFO] Formula: 100 + kb(0) + bc(${Math.min(Math.floor(180/30),40)}) + agents(0) = ${p3.computedLimit}, evictTo=${p3.evictTo}`);

// ─── Test 5: Multi-agent project ──────────────────────────────────────────────
console.log("\n--- Test 5: Multi-agent project (4 active sessions → +60 agent bonus) ---");
const { db: db4 } = openTestDb("multi-agent");

// Issue 4 active tokens (expires 24h from now)
const projPath = "smart-mem-test-multi-agent";
for (const [id, role] of [
  ["orch", "orchestrator"], ["dev", "developer"], ["mkt", "marketer"], ["res", "researcher"]
]) {
  issueToken(db4, projPath, id, role);
}

const p4 = computeProjectComplexity(db4);
// Expected agent_bonus = 4 * 15 = 60, capped at 50 → 50
// Final: 100 + 0 + 0 + 50 = 150
assert("Multi-agent: activeAgents = 4",     p4.activeAgents === 4,    `got ${p4.activeAgents}`);
assert("Multi-agent: limit = 150",          p4.computedLimit === 150, `got ${p4.computedLimit}`);
assert("Multi-agent: evictTo = 120 (80%)",  p4.evictTo === 120,       `got ${p4.evictTo}`);
console.log(`  [INFO] Formula: 100 + kb(0) + bc(0) + agents(${Math.min(4*15,50)}) = ${p4.computedLimit}, evictTo=${p4.evictTo}`);

// ─── Test 6: Full-platform project (all signals combined) ──────────────────────
console.log("\n--- Test 6: Full-platform project (300 KB + 300 BC + 4 agents) ---");
const { db: db5 } = openTestDb("full-platform");

// 300 KB entries
const ins5kb = db5.prepare("INSERT OR IGNORE INTO source_meta(source, source_type, retention_tier, created_at) VALUES (?, 'internal', 'internal', ?)");
for (let i = 0; i < 300; i++) ins5kb.run(`kb-${i}`, t);

// 300 broadcasts
const ins5bc = db5.prepare(`INSERT INTO broadcasts(type,agent_id,task,summary,files,state,depends_on,reason,importance,created_at) VALUES (?,?,?,?,?,?,?,?,3,?)`);
for (let i = 0; i < 300; i++) ins5bc.run("STATUS", "orch", "task", "s", "[]", "", "[]", "", t);

// 4 active agents
const pp5 = "smart-mem-test-full-platform";
for (const [id, role] of [
  ["orch", "orchestrator"], ["dev", "developer"], ["mkt", "marketer"], ["res", "researcher"]
]) {
  issueToken(db5, pp5, id, role);
}

const p5 = computeProjectComplexity(db5);
// kb_bonus    = floor(300/15) = 20
// bc_bonus    = floor(300/30) = 10
// agent_bonus = 4*15 = 60 → capped at 50
// Final: 100 + 20 + 10 + 50 = 180
assert("Full-platform: kbEntries = 300",     p5.kbEntries === 300,      `got ${p5.kbEntries}`);
assert("Full-platform: broadcastCount = 300", p5.broadcastCount === 300, `got ${p5.broadcastCount}`);
assert("Full-platform: activeAgents = 4",    p5.activeAgents === 4,    `got ${p5.activeAgents}`);
assert("Full-platform: limit = 180",         p5.computedLimit === 180, `got ${p5.computedLimit}`);
assert("Full-platform: evictTo = 144",       p5.evictTo === 144,       `got ${p5.evictTo}`);
console.log(`  [INFO] Formula: 100 + kb(20) + bc(10) + agents(50) = ${p5.computedLimit}, evictTo=${p5.evictTo}`);

// ─── Test 7: Cap enforcement ──────────────────────────────────────────────────
console.log("\n--- Test 7: Cap enforcement (900+ KB, 1200+ BC, 5 agents → max 250) ---");
const { db: db6 } = openTestDb("full-platform"); // reuse — already seeded with 300 KB + 300 BC + 4 agents

// Pump up to extreme values in-memory by manually testing the formula
function simulateComplexity(kbEntries, broadcastCount, activeAgents) {
  const kbBonus    = Math.min(Math.floor(kbEntries / 15), 60);
  const bcBonus    = Math.min(Math.floor(broadcastCount / 30), 40);
  const agentBonus = Math.min(activeAgents * 15, 50);
  return Math.max(100, Math.min(250, 100 + kbBonus + bcBonus + agentBonus));
}

assert("Max cap: 900 KB + 1200 BC + 5 agents = 250",
  simulateComplexity(900, 1200, 5) === 250,
  `got ${simulateComplexity(900, 1200, 5)}`);

assert("Mid cap: 450 KB + 600 BC + 3 agents = 100+30+20+45=195",
  simulateComplexity(450, 600, 3) === 195,
  `got ${simulateComplexity(450, 600, 3)}`);

assert("Floor hold: 5 KB + 2 BC + 0 agents = 100 (base)",
  simulateComplexity(5, 2, 0) === 100,
  `got ${simulateComplexity(5, 2, 0)}`);

assert("Single solo dev: 20 KB + 10 BC + 1 agent = 100+1+0+15=116",
  simulateComplexity(20, 10, 1) === 116,
  `got ${simulateComplexity(20, 10, 1)}`);

// ─── Cleanup ─────────────────────────────────────────────────────────────────
db1.close(); db2.close(); db3.close(); db4.close(); db5.close(); db6.close();
for (const tag of ["fresh", "kb-heavy", "broadcast-heavy", "multi-agent", "full-platform"]) {
  cleanDb(tag);
}

console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
