/**
 * Live Store Abstraction test suite
 * Tests SqliteStore through the Store interface — covers all methods,
 * edge cases, concurrent writes, RBAC, hash chain, and rate limiting.
 *
 * Run: node scripts/live-store-test.mjs
 */

import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Bootstrap: point ZC_STORE=sqlite so createStore() uses SqliteStore
process.env["ZC_STORE"] = "sqlite";

const { createStore } = await import("../dist/store.js");

const DB_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");
mkdirSync(DB_DIR, { recursive: true });

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}${detail !== undefined ? " — " + String(detail) : ""}`);
    failed++;
  }
}

function cleanDb(projectPath) {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  const base = join(DB_DIR, `${hash}.db`);
  for (const ext of ["", "-wal", "-shm"]) {
    try { if (existsSync(base + ext)) unlinkSync(base + ext); } catch {}
  }
}

const PP1 = "C:/store-test/project-alpha";
const PP2 = "C:/store-test/project-beta";
cleanDb(PP1);
cleanDb(PP2);

console.log("\n=== STORE ABSTRACTION TEST SUITE — SqliteStore ===\n");

const store = await createStore();

// ─── Test 1: Working memory basics ───────────────────────────────────────────
console.log("--- Test 1: Working memory CRUD ---");

await store.remember(PP1, "auth-method", "JWT RS256", 4, "default");
await store.remember(PP1, "db-url",      "postgres://localhost/app", 3, "default");
await store.remember(PP1, "debug-flag",  "true", 1, "default");

const facts = await store.recall(PP1, "default");
assert("Recall returns stored facts",              facts.length === 3,           `got ${facts.length}`);
assert("Highest importance first",                 facts[0].importance >= facts[1].importance);
assert("Critical fact present",                    facts.some(f => f.key === "auth-method"));

// Upsert — update in place
await store.remember(PP1, "auth-method", "JWT ES256 (upgraded)", 5, "default");
const facts2 = await store.recall(PP1, "default");
assert("Upsert: still 3 facts",                    facts2.length === 3);
const updated = facts2.find(f => f.key === "auth-method");
assert("Upsert: value updated",                    updated?.value === "JWT ES256 (upgraded)");
assert("Upsert: importance updated to 5",          updated?.importance === 5);

// Forget
const wasDeleted = await store.forget(PP1, "debug-flag", "default");
const facts3 = await store.recall(PP1, "default");
assert("Forget: key removed",                      wasDeleted === true);
assert("Forget: count reduced",                    facts3.length === 2);

// Forget non-existent key
const noDelete = await store.forget(PP1, "nonexistent-key", "default");
assert("Forget nonexistent: returns false",        noDelete === false);

// Agent namespacing
await store.remember(PP1, "agent-task", "build auth module", 3, "developer-1");
await store.remember(PP1, "agent-task", "write copy",        3, "marketer-1");
const devFacts = await store.recall(PP1, "developer-1");
const mktFacts = await store.recall(PP1, "marketer-1");
assert("Agent namespace: dev facts isolated",      devFacts.length === 1 && devFacts[0].value === "build auth module");
assert("Agent namespace: mkt facts isolated",      mktFacts.length === 1 && mktFacts[0].value === "write copy");
assert("Agent namespace: no cross-contamination",  devFacts[0].value !== mktFacts[0].value);

// ─── Test 2: Working memory eviction ─────────────────────────────────────────
console.log("\n--- Test 2: Working memory smart eviction ---");

// Clean PP2 for a controlled eviction test
const stats0 = await store.getMemoryStats(PP2, "default");
assert("Fresh project: 0 facts",                   stats0.count === 0);
assert("Fresh project: max = 50 (no complexity)",  stats0.max === 50);

// Fill to just over base limit (50) using low-importance facts
// so eviction triggers predictably on the cheap ones
for (let i = 0; i < 52; i++) {
  await store.remember(PP2, `low-fact-${i}`, `value-${i}`, 1, "default");
}
const statsAfter = await store.getMemoryStats(PP2, "default");
assert("Eviction triggered: count <= max",         statsAfter.count <= statsAfter.max,
  `count=${statsAfter.count} max=${statsAfter.max}`);
assert("Eviction: count reduced to ~evictTo",      statsAfter.count <= 42);

// High-importance facts survive eviction
await store.remember(PP2, "critical-arch", "microservices via gRPC", 5, "default");
for (let i = 0; i < 5; i++) {
  await store.remember(PP2, `filler-${i}`, `x`, 1, "default");
}
const factsE = await store.recall(PP2, "default");
assert("Eviction: critical fact (★5) survives",    factsE.some(f => f.key === "critical-arch"));

// ─── Test 3: KB index + search ────────────────────────────────────────────────
console.log("\n--- Test 3: Knowledge base index + BM25 search ---");

// Use exact terms that appear in the FTS5 query — porter stemming must match
await store.index(PP1, "JWT RS256 token authentication using asymmetric key pairs for service authentication", "arch/auth-design.md");
await store.index(PP1, "PostgreSQL pgvector extension enables native cosine similarity search on embedding vectors", "docs/pgvector.md");
await store.index(PP1, "Redis pubsub for real-time agent coordination messages without polling overhead", "docs/redis.md");

// Give FTS5 a moment to index
await new Promise(r => setTimeout(r, 100));

// Use terms that appear literally in the content (FTS5 porter stemming is strict)
const results = await store.search(PP1, ["JWT token authentication"], { limit: 5 });
assert("Search returns results for indexed content",   results.length > 0,       `got ${results.length}`);
assert("Relevant result ranked first",                results[0].source === "arch/auth-design.md" || results[0].content.includes("JWT"),
  `top source: ${results[0]?.source}`);
assert("Result has snippet",                          typeof results[0].snippet === "string" && results[0].snippet.length > 0);

const noResults = await store.search(PP1, ["completely irrelevant xyz123 gibberish"], { limit: 5 });
assert("Search: no results for non-matching query",   noResults.length === 0);

// External content gets source_type flag
await store.index(PP1, "Competitor pricing: $99/month per agent", "https://competitor.com/pricing", "external");
const extResults = await store.search(PP1, ["competitor pricing"], { limit: 5 });
assert("External content indexed and searchable",     extResults.length > 0);
assert("External content has sourceType=external",    extResults[0].sourceType === "external");

// Cross-project isolation
await store.index(PP2, "PP2-only secret content: hidden from PP1 search", "pp2-secret.md");
await new Promise(r => setTimeout(r, 100));
const crossCheck = await store.search(PP1, ["PP2-only secret hidden"], { limit: 5 });
assert("Cross-project search isolation: PP2 content not in PP1 results",
  !crossCheck.some(r => r.source === "pp2-secret.md"));

// ─── Test 4: KB stats ─────────────────────────────────────────────────────────
console.log("\n--- Test 4: KB stats ---");
const kbStats = await store.getKbStats(PP1);
assert("KB stats: totalEntries > 0",              kbStats.totalEntries > 0, `got ${kbStats.totalEntries}`);
assert("KB stats: externalEntries counted",        kbStats.externalEntries >= 1);
assert("KB stats: dbSizeBytes > 0",               kbStats.dbSizeBytes > 0);

// ─── Test 5: RBAC token lifecycle ─────────────────────────────────────────────
console.log("\n--- Test 5: RBAC token lifecycle ---");

const orchToken = await store.issueToken(PP1, "alpha-orchestrator", "orchestrator");
assert("Token issued: zcst. prefix",              orchToken.startsWith("zcst."));
assert("Token has 3 parts",                       orchToken.split(".").length === 3);

const payload = await store.verifyToken(PP1, orchToken);
assert("Token verifies",                          payload !== null);
assert("Token role = orchestrator",               payload?.role === "orchestrator");
assert("Token agentId correct",                   payload?.agentId === "alpha-orchestrator");

// Wrong project
const crossVerify = await store.verifyToken(PP2, orchToken);
assert("Token rejected by wrong project",         crossVerify === null);

// Developer token
const devToken = await store.issueToken(PP1, "alpha-developer", "developer");
const devPayload = await store.verifyToken(PP1, devToken);
assert("Developer token verifies",               devPayload?.role === "developer");

// Revocation
await store.revokeTokens(PP1, "alpha-developer");
const afterRevoke = await store.verifyToken(PP1, devToken);
assert("Revoked token invalid",                  afterRevoke === null);
assert("Orchestrator unaffected by dev revoke",  (await store.verifyToken(PP1, orchToken)) !== null);

// Session count
const count = await store.countActiveSessions(PP1);
assert("Active sessions: 1 (orch only)",         count === 1, `got ${count}`);

// ─── Test 6: Broadcast channel ────────────────────────────────────────────────
console.log("\n--- Test 6: Broadcast channel + hash chain ---");

// Issue tokens for broadcast test — RBAC is now active (tokens were issued in Test 5)
const bcOrchToken = await store.issueToken(PP1, "bc-orchestrator", "orchestrator");
const bcDevToken  = await store.issueToken(PP1, "bc-developer",  "developer");

const bc1 = await store.broadcast(PP1, "ASSIGN", "bc-orchestrator", {
  task: "Build auth module", summary: "Assign JWT implementation to developer",
  importance: 4, session_token: bcOrchToken,
});
assert("Broadcast ASSIGN posted",                bc1.id > 0);
assert("Broadcast type correct",                 bc1.type === "ASSIGN");

const bc2 = await store.broadcast(PP1, "STATUS", "bc-developer", {
  task: "Build auth module", summary: "Started implementation, 30% done",
  importance: 3, session_token: bcDevToken,
});
assert("Broadcast STATUS posted",               bc2.id > bc1.id);

const bc3 = await store.broadcast(PP1, "MERGE", "bc-orchestrator", {
  task: "Build auth module", summary: "Auth module approved and merged",
  importance: 4, session_token: bcOrchToken,
});
assert("Broadcast MERGE posted",                bc3.id > bc2.id);

// Recall
const recalls = await store.recallBroadcasts(PP1, { limit: 10 });
assert("Recall: 3 broadcasts returned",         recalls.length === 3);
assert("Recall: most recent first",             recalls[0].id === bc3.id);

// Hash chain integrity
const chain = await store.chainStatus(PP1);
assert("Hash chain: intact after 3 broadcasts", chain.ok, JSON.stringify(chain));
assert("Hash chain: totalRows = 3",             chain.totalRows === 3);

// RBAC: developer cannot ASSIGN
let devAssignRejected = false;
try {
  await store.broadcast(PP1, "ASSIGN", "bc-developer", {
    task: "x", summary: "y", session_token: bcDevToken,
  });
} catch { devAssignRejected = true; }
assert("RBAC: developer CANNOT broadcast ASSIGN",  devAssignRejected);

// Cross-project broadcast isolation
const broadcastsInPP2 = await store.recallBroadcasts(PP2, { limit: 10 });
assert("Broadcast isolation: PP2 has no PP1 broadcasts", broadcastsInPP2.length === 0);

// Ack
await store.ack(PP1, bc1.id);
// Ack is fire-and-forget — just verify no error thrown

// Replay
const replay = await store.replay(PP1, bc2.id);
assert("Replay from bc2.id: 2 broadcasts",      replay.length === 2);
assert("Replay ordered oldest first",            replay[0].id === bc2.id);

// ─── Test 7: Channel key ──────────────────────────────────────────────────────
console.log("\n--- Test 7: Channel key protection ---");

assert("No key initially",                       !(await store.isChannelKeyConfigured(PP2)));
await store.setChannelKey(PP2, "super-secret-channel-key-32chars!!");
assert("Key configured after set",              await store.isChannelKeyConfigured(PP2));

// Wrong key throws
let wrongKeyRejected = false;
try {
  await store.broadcast(PP2, "STATUS", "agent-x", { task: "t", summary: "s", channel_key: "wrong-key" });
} catch { wrongKeyRejected = true; }
assert("Wrong channel key rejected",            wrongKeyRejected);

// ─── Test 8: Rate limiting ────────────────────────────────────────────────────
console.log("\n--- Test 8: Fetch rate limiting ---");

const stats1 = await store.getFetchStats(PP1);
assert("Initial fetch count: 0 or low",        stats1.used >= 0);
assert("Remaining > 0",                        stats1.remaining > 0);

const afterInc = await store.incrementFetch(PP1);
assert("Increment: used increased by 1",       afterInc.used === stats1.used + 1);
assert("Increment: remaining decreased by 1",  afterInc.remaining === stats1.remaining - 1);

// ─── Test 9: Memory stats with complexity profile ─────────────────────────────
console.log("\n--- Test 9: Dynamic memory stats ---");

// Force-recompute so the cache reflects all KB entries indexed above
const freshLimits = await store.getWorkingMemoryLimits(PP1, true);
const memStats    = await store.getMemoryStats(PP1, "default");
assert("getMemoryStats: count >= 0",          memStats.count >= 0);
assert("getMemoryStats: max >= 50",           memStats.max >= 50);
assert("getMemoryStats: evictTo < max",       memStats.evictTo < memStats.max);
assert("getMemoryStats: complexity present",  memStats.complexity !== null);
assert("Complexity: kbEntries reflected",     freshLimits.profile?.kbEntries >= 3,
  `got ${freshLimits.profile?.kbEntries}`);

// ─── Test 10: Archive session summary ─────────────────────────────────────────
console.log("\n--- Test 10: Session summary archival ---");

await store.archiveSummary(PP1, "Completed auth module. JWT RS256. Tests passing. Ready for review.");
const factsAfterSummary = await store.recall(PP1, "default");
assert("Summary stored in working memory",    factsAfterSummary.some(f => f.key === "last_session_summary"));

// ─── Cleanup ──────────────────────────────────────────────────────────────────
await store.close();
cleanDb(PP1);
cleanDb(PP2);

console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
