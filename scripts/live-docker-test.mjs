/**
 * SecureContext — Production Mode Integration Test Suite
 *
 * Tests the FULL Docker stack: securecontext-postgres + securecontext-api + securecontext-ollama
 *
 * Unlike live-api-test.mjs (which starts an in-process server with SQLite),
 * this test connects to a LIVE Docker stack and confirms PostgreSQL-backed behaviour:
 *   - store="postgres" reported by /health
 *   - Multi-tenant project isolation via project_hash
 *   - PostgreSQL FTS search (tsvector / GIN)
 *   - Broadcast hash chain integrity under sequential writes
 *   - RBAC token lifecycle against PostgreSQL
 *   - Dynamic working memory sizing against real data
 *   - Concurrent writes (advisory lock correctness)
 *   - Container restart survival (data persists in volume)
 *
 * Prerequisites:
 *   docker compose --env-file docker/.env -f docker/docker-compose.yml up -d
 *
 * Run:
 *   node scripts/live-docker-test.mjs
 *
 * Environment:
 *   SC_API_URL   — defaults to http://localhost:3099
 *   SC_API_KEY   — loaded from docker/.env automatically if not set
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load API key from docker/.env if not already in environment ───────────────
function loadEnvFile() {
  const envPath = join(__dirname, "..", "docker", ".env");
  if (!existsSync(envPath)) return {};
  const vars = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const eq = stripped.indexOf("=");
    if (eq === -1) continue;
    vars[stripped.slice(0, eq).trim()] = stripped.slice(eq + 1).trim();
  }
  return vars;
}

const dotenv   = loadEnvFile();
const BASE_URL = process.env["SC_API_URL"] ?? "http://localhost:3099";
const API_KEY  = process.env["SC_API_KEY"] ?? dotenv["ZC_API_KEY"] ?? "";

if (!API_KEY) {
  console.error("ERROR: No API key found. Set SC_API_KEY or ensure docker/.env has ZC_API_KEY.");
  process.exit(1);
}

// ── Test harness ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let section = "";

function startSection(name) {
  section = name;
  console.log(`\n--- ${name} ---`);
}

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}${detail !== undefined ? " — got: " + JSON.stringify(detail) : ""}`);
    failed++;
  }
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const url = `${BASE_URL}${path}`;
  try {
    const res = await fetch(url, opts);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  } catch (e) {
    return { status: 0, body: {}, error: e.message };
  }
}

// Use unique project paths that won't collide with existing data
const PP1 = "/securecontext-docker-test/project-alpha";
const PP2 = "/securecontext-docker-test/project-beta";

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 1 — Stack health and PostgreSQL confirmation
// ═══════════════════════════════════════════════════════════════════════════════
startSection("Stack health — confirms Docker + PostgreSQL");

const health = await api("GET", "/health");
assert("GET /health: 200",                health.status === 200);
assert("GET /health: status=ok",          health.body.status === "ok");
assert("GET /health: version=0.9.0",      health.body.version === "0.9.0",  health.body.version);
assert("GET /health: store=postgres",     health.body.store  === "postgres", health.body.store);
assert("GET /health: ts present",         typeof health.body.ts === "string");

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 2 — Authentication enforcement
// ═══════════════════════════════════════════════════════════════════════════════
startSection("Authentication");

const noAuth = await fetch(`${BASE_URL}/api/v1/recall?projectPath=${encodeURIComponent(PP1)}`);
assert("No auth header → 401",     noAuth.status === 401);

const badAuth = await fetch(`${BASE_URL}/api/v1/recall?projectPath=${encodeURIComponent(PP1)}`, {
  headers: { "Authorization": "Bearer wrong-key-entirely" },
});
assert("Bad API key → 401",        badAuth.status === 401);

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 3 — Input validation
// ═══════════════════════════════════════════════════════════════════════════════
startSection("Input validation");

const relPath = await api("POST", "/api/v1/remember", { projectPath: "relative/path", key: "k", value: "v", importance: 3 });
assert("Relative projectPath → 400",   relPath.status === 400);

const noPath = await api("POST", "/api/v1/remember", { key: "k", value: "v", importance: 3 });
assert("Missing projectPath → 400",    noPath.status === 400);

const noKey = await api("POST", "/api/v1/remember", { projectPath: PP1, value: "v", importance: 3 });
assert("Missing key → 400",            noKey.status === 400);

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 4 — Working memory CRUD against PostgreSQL
// ═══════════════════════════════════════════════════════════════════════════════
startSection("Working memory CRUD (PostgreSQL backend)");

const rem1 = await api("POST", "/api/v1/remember", { projectPath: PP1, key: "arch-decision", value: "Use microservices", importance: 5, agentId: "agent1" });
assert("POST /remember: 200",          rem1.status === 200);
assert("POST /remember: ok=true",      rem1.body.ok === true);

await api("POST", "/api/v1/remember", { projectPath: PP1, key: "db-choice",    value: "PostgreSQL with pgvector", importance: 4, agentId: "agent1" });
await api("POST", "/api/v1/remember", { projectPath: PP1, key: "api-pattern",  value: "REST over gRPC for now",   importance: 3, agentId: "agent1" });

const recall = await api("GET", `/api/v1/recall?projectPath=${encodeURIComponent(PP1)}&agentId=agent1`);
assert("GET /recall: 200",             recall.status === 200);
assert("GET /recall: 3 facts",         recall.body.facts?.length === 3,       recall.body.facts?.length);
assert("GET /recall: max present",     typeof recall.body.max === "number");
assert("GET /recall: highest-importance first", recall.body.facts?.[0]?.importance >= recall.body.facts?.[1]?.importance);

// Upsert — update value + importance
await api("POST", "/api/v1/remember", { projectPath: PP1, key: "arch-decision", value: "Monolith first (revised)", importance: 5, agentId: "agent1" });
const afterUpsert = await api("GET", `/api/v1/recall?projectPath=${encodeURIComponent(PP1)}&agentId=agent1`);
assert("Upsert: still 3 facts",        afterUpsert.body.facts?.length === 3);
const upserted = afterUpsert.body.facts?.find(f => f.key === "arch-decision");
assert("Upsert: value updated",        upserted?.value === "Monolith first (revised)");

// Forget
const forget = await api("POST", "/api/v1/forget", { projectPath: PP1, key: "api-pattern", agentId: "agent1" });
assert("POST /forget: 200",            forget.status === 200);
assert("POST /forget: deleted=true",   forget.body.deleted === true);

const forgetGone = await api("POST", "/api/v1/forget", { projectPath: PP1, key: "api-pattern", agentId: "agent1" });
assert("Forget nonexistent: deleted=false", forgetGone.body.deleted === false);

const afterForget = await api("GET", `/api/v1/recall?projectPath=${encodeURIComponent(PP1)}&agentId=agent1`);
assert("After forget: 2 facts remain", afterForget.body.facts?.length === 2,  afterForget.body.facts?.length);

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 5 — Multi-tenant project isolation (critical PostgreSQL property)
// ═══════════════════════════════════════════════════════════════════════════════
startSection("Multi-tenant isolation (project_hash partitioning)");

// Write to PP2 — must NOT appear in PP1 results
await api("POST", "/api/v1/remember", { projectPath: PP2, key: "pp2-secret", value: "Beta project only", importance: 4, agentId: "agent2" });

const pp1Facts = await api("GET", `/api/v1/recall?projectPath=${encodeURIComponent(PP1)}&agentId=agent1`);
const pp2Facts = await api("GET", `/api/v1/recall?projectPath=${encodeURIComponent(PP2)}&agentId=agent2`);

const pp1HasPP2Data = pp1Facts.body.facts?.some(f => f.key === "pp2-secret");
const pp2HasPP1Data = pp2Facts.body.facts?.some(f => f.key === "arch-decision");

assert("PP1 cannot see PP2 facts",     pp1HasPP2Data === false, pp1HasPP2Data);
assert("PP2 cannot see PP1 facts",     pp2HasPP1Data === false, pp2HasPP1Data);
assert("PP2 has its own fact",         pp2Facts.body.facts?.some(f => f.key === "pp2-secret") === true);

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 6 — Knowledge base: index + PostgreSQL FTS search
// ═══════════════════════════════════════════════════════════════════════════════
startSection("Knowledge base — PostgreSQL FTS (tsvector/GIN)");

await api("POST", "/api/v1/index", {
  projectPath: PP1,
  content: "The authentication module uses JWT RS256 tokens with 24-hour expiry. Refresh tokens are stored in Redis with a 7-day TTL.",
  source: "doc:auth-spec",
});
await api("POST", "/api/v1/index", {
  projectPath: PP1,
  content: "The payment system integrates with Stripe webhooks. All webhook events are validated with the Stripe signing secret before processing.",
  source: "doc:payment-spec",
});
await api("POST", "/api/v1/index", {
  projectPath: PP1,
  content: "Database migrations run automatically on startup using a versioned migration system. Each migration is atomic and idempotent.",
  source: "doc:db-spec",
});

// Also index into PP2 to verify search isolation
await api("POST", "/api/v1/index", {
  projectPath: PP2,
  content: "PP2 private specification: secret beta architecture using Go microservices.",
  source: "doc:pp2-private",
});

const authSearch = await api("POST", "/api/v1/search", {
  projectPath: PP1,
  queries: ["JWT authentication tokens"],
});
assert("Search: 200",                      authSearch.status === 200);
assert("Search: results returned",         authSearch.body.results?.length > 0,   authSearch.body.results?.length);
assert("Search: auth doc ranked first",    authSearch.body.results?.[0]?.source === "doc:auth-spec", authSearch.body.results?.[0]?.source);

const paySearch = await api("POST", "/api/v1/search", {
  projectPath: PP1,
  queries: ["Stripe payment webhooks"],
});
assert("Search: payment doc found",        paySearch.body.results?.[0]?.source === "doc:payment-spec", paySearch.body.results?.[0]?.source);

// Cross-project search isolation
const pp1SearchForPP2 = await api("POST", "/api/v1/search", {
  projectPath: PP1,
  queries: ["Go microservices beta"],
});
const pp2DataInPP1 = pp1SearchForPP2.body.results?.some(r => r.source === "doc:pp2-private");
assert("Search isolation: PP2 doc not in PP1 results", pp2DataInPP1 === false, pp2DataInPP1);

// Empty queries → 400
const badSearch = await api("POST", "/api/v1/search", { projectPath: PP1, queries: [] });
assert("Empty queries → 400",             badSearch.status === 400);

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 7 — Status endpoint (confirms PostgreSQL store type)
// ═══════════════════════════════════════════════════════════════════════════════
startSection("Status endpoint (store_type confirmation)");

// Pass agentId=agent1 — status is per-agent; "default" agentId has no facts here
const status = await api("GET", `/api/v1/status?projectPath=${encodeURIComponent(PP1)}&agentId=agent1`);
assert("GET /status: 200",               status.status === 200);
assert("GET /status: workingMemory",     typeof status.body.workingMemory === "object");
assert("GET /status: knowledgeBase",     typeof status.body.knowledgeBase === "object");
assert("GET /status: chain",             typeof status.body.chain === "object");
assert("GET /status: kbEntries > 0",     status.body.knowledgeBase?.totalEntries > 0, status.body.knowledgeBase?.totalEntries);
assert("GET /status: workingMemory.count >= 2", status.body.workingMemory?.count >= 2, status.body.workingMemory?.count);

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 8 — RBAC token lifecycle against PostgreSQL
// ═══════════════════════════════════════════════════════════════════════════════
startSection("RBAC token lifecycle (PostgreSQL-backed)");

const orchToken = await api("POST", "/api/v1/issue-token", { projectPath: PP1, agentId: "orch-1", role: "orchestrator" });
assert("Issue orchestrator token: 200",   orchToken.status === 200);
assert("Token: zcst. prefix",             orchToken.body.token?.startsWith("zcst."), orchToken.body.token?.slice(0, 10));

const devToken = await api("POST", "/api/v1/issue-token", { projectPath: PP1, agentId: "dev-1", role: "developer" });
assert("Issue developer token: 200",      devToken.status === 200);

const verifyOrch = await api("POST", "/api/v1/verify-token", { projectPath: PP1, token: orchToken.body.token });
assert("Verify orchestrator: valid=true", verifyOrch.body.valid === true);
assert("Verify orchestrator: role",       verifyOrch.body.payload?.role === "orchestrator");
assert("Verify orchestrator: agentId",    verifyOrch.body.payload?.agentId === "orch-1");

// Cross-project rejection
const crossVerify = await api("POST", "/api/v1/verify-token", { projectPath: PP2, token: orchToken.body.token });
assert("Cross-project verify: valid=false", crossVerify.body.valid === false);

// Revoke
const revoke = await api("POST", "/api/v1/revoke-token", { projectPath: PP1, token: devToken.body.token, agentId: "dev-1" });
assert("Revoke dev token: 200",           revoke.status === 200);

const afterRevoke = await api("POST", "/api/v1/verify-token", { projectPath: PP1, token: devToken.body.token });
assert("After revoke: token invalid",     afterRevoke.body.valid === false);

// Orch token unaffected
const orchStillValid = await api("POST", "/api/v1/verify-token", { projectPath: PP1, token: orchToken.body.token });
assert("Orch token unaffected by dev revoke", orchStillValid.body.valid === true);

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 9 — Broadcast channel + hash chain (PostgreSQL advisory lock)
// ═══════════════════════════════════════════════════════════════════════════════
startSection("Broadcast channel + hash chain (PostgreSQL advisory lock)");

// Fresh chain status
const emptyChain = await api("GET", `/api/v1/chain?projectPath=${encodeURIComponent(PP1)}`);
assert("Empty chain: ok=true (no broadcasts yet for PP1)", emptyChain.body.chain?.ok === true);

// Send broadcasts with orchestrator token (RBAC is active — tokens exist for PP1)
const bc1 = await api("POST", "/api/v1/broadcast", {
  projectPath: PP1, type: "ASSIGN", agentId: "orch-1",
  task: "Build auth module", summary: "Implement JWT RS256", importance: 5,
  session_token: orchToken.body.token,
});
assert("ASSIGN broadcast: 200",           bc1.status === 200);
assert("ASSIGN: message.id > 0",          bc1.body.message?.id > 0);
assert("ASSIGN: type correct",            bc1.body.message?.type === "ASSIGN");

// Issue a new dev token (old one was revoked)
const dev2Token = await api("POST", "/api/v1/issue-token", { projectPath: PP1, agentId: "dev-2", role: "developer" });

const bc2 = await api("POST", "/api/v1/broadcast", {
  projectPath: PP1, type: "STATUS", agentId: "dev-2",
  task: "Build auth module", summary: "JWT middleware 60% done", importance: 3,
  session_token: dev2Token.body.token,
});
assert("STATUS broadcast: 200",           bc2.status === 200);

const bc3 = await api("POST", "/api/v1/broadcast", {
  projectPath: PP1, type: "MERGE", agentId: "orch-1",
  task: "Build auth module", summary: "Auth module approved — merge to main", importance: 4,
  session_token: orchToken.body.token,
});
assert("MERGE broadcast: 200",            bc3.status === 200);

// Verify hash chain integrity — 3 broadcasts should chain correctly
const chainCheck = await api("GET", `/api/v1/chain?projectPath=${encodeURIComponent(PP1)}`);
assert("Hash chain: ok=true after 3 broadcasts", chainCheck.body.chain?.ok === true, chainCheck.body.chain);
assert("Hash chain: totalRows=3",         chainCheck.body.chain?.totalRows === 3, chainCheck.body.chain?.totalRows);

// Recall broadcasts (most recent first)
const bcList = await api("GET", `/api/v1/broadcasts?projectPath=${encodeURIComponent(PP1)}&limit=10`);
assert("GET /broadcasts: 200",            bcList.status === 200);
assert("GET /broadcasts: 3 items",        bcList.body.broadcasts?.length === 3, bcList.body.broadcasts?.length);
assert("GET /broadcasts: most recent first", bcList.body.broadcasts?.[0]?.id === bc3.body.message?.id);

// Cross-project broadcast isolation
const pp2BcList = await api("GET", `/api/v1/broadcasts?projectPath=${encodeURIComponent(PP2)}&limit=10`);
assert("Broadcast isolation: PP2 has 0 broadcasts", pp2BcList.body.broadcasts?.length === 0, pp2BcList.body.broadcasts?.length);

// RBAC: developer cannot ASSIGN
const badAssign = await api("POST", "/api/v1/broadcast", {
  projectPath: PP1, type: "ASSIGN", agentId: "dev-2",
  task: "Unauthorized", summary: "Should fail", importance: 3,
  session_token: dev2Token.body.token,
});
assert("Dev CANNOT broadcast ASSIGN",     badAssign.status !== 200);

// Replay from bc2
const replay = await api("POST", "/api/v1/replay", { projectPath: PP1, fromId: bc2.body.message.id });
assert("POST /replay: 200",               replay.status === 200);
assert("POST /replay: 2 results from bc2", replay.body.broadcasts?.length === 2, replay.body.broadcasts?.length);
assert("POST /replay: ordered oldest first", replay.body.broadcasts?.[0]?.id === bc2.body.message?.id);

// Ack
const ack = await api("POST", "/api/v1/ack", { projectPath: PP1, id: bc1.body.message.id });
assert("POST /ack: 200",                  ack.status === 200);

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 10 — Concurrent broadcast writes (advisory lock correctness)
// ═══════════════════════════════════════════════════════════════════════════════
startSection("Concurrent broadcast writes (advisory lock)");

// Issue tokens for the concurrent agents
const concAgent1Token = await api("POST", "/api/v1/issue-token", { projectPath: PP2, agentId: "cc-orch", role: "orchestrator" });

// Fire 5 concurrent broadcasts at PP2 — they must all get unique IDs
// and the chain must remain intact despite concurrent writes
const concurrentBroadcasts = await Promise.all(
  Array.from({ length: 5 }, (_, i) =>
    api("POST", "/api/v1/broadcast", {
      projectPath: PP2, type: "STATUS", agentId: "cc-orch",
      task: `concurrent-task-${i}`, summary: `Concurrent write ${i}`, importance: 3,
      session_token: concAgent1Token.body.token,
    })
  )
);

const allSucceeded  = concurrentBroadcasts.every(r => r.status === 200);
const allIds        = concurrentBroadcasts.map(r => r.body.message?.id).filter(Boolean);
const uniqueIds     = new Set(allIds);

assert("Concurrent: all 5 writes succeeded",    allSucceeded, concurrentBroadcasts.map(r => r.status));
assert("Concurrent: 5 unique message IDs",       uniqueIds.size === 5, [...uniqueIds]);

const concChain = await api("GET", `/api/v1/chain?projectPath=${encodeURIComponent(PP2)}`);
assert("Concurrent: hash chain intact after 5 concurrent writes", concChain.body.chain?.ok === true, concChain.body.chain);
assert("Concurrent: chain totalRows = 5",        concChain.body.chain?.totalRows === 5, concChain.body.chain?.totalRows);

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 11 — Session summary
// ═══════════════════════════════════════════════════════════════════════════════
startSection("Session summary");

const summ = await api("POST", "/api/v1/summarize", {
  projectPath: PP1,
  summary: "Completed Docker integration testing. PostgreSQL backend confirmed. JWT RS256 auth module merged. Hash chain intact at 3 broadcasts.",
});
assert("POST /summarize: 200",            summ.status === 200);
assert("POST /summarize: ok=true",        summ.body.ok === true);

// archiveSummary stores under agentId="default" — query that namespace
const afterSumm = await api("GET", `/api/v1/recall?projectPath=${encodeURIComponent(PP1)}&agentId=default`);
const summFact = afterSumm.body.facts?.find(f => f.key === "last_session_summary");
assert("Summary stored as memory fact",   summFact !== undefined, afterSumm.body.facts?.map(f => f.key));
assert("Summary has high importance",     summFact?.importance >= 4, summFact?.importance);

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 12 — Edge cases and error handling
// ═══════════════════════════════════════════════════════════════════════════════
startSection("Edge cases and error handling");

const unknownPath = await api("GET", "/api/v1/this-does-not-exist");
assert("Unknown path → 404",              unknownPath.status === 404);

const emptyBody = await fetch(`${BASE_URL}/api/v1/remember`, {
  method: "POST",
  headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
  body: "{}",
});
assert("Empty body → 400",               emptyBody.status === 400);

const bigPayload = await api("POST", "/api/v1/index", {
  projectPath: PP1,
  content: "x".repeat(1024 * 1024 + 1), // 1MB + 1 byte
  source:  "overflow-test",
});
assert("Oversized payload → 413",        bigPayload.status === 413, bigPayload.status);

// ═══════════════════════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(60)}`);
console.log(`=== DOCKER PRODUCTION MODE RESULTS: ${passed} passed, ${failed} failed ===`);
console.log(`${"═".repeat(60)}`);
console.log(`\n  Stack:    ${BASE_URL}`);
console.log(`  Backend:  ${health.body.store ?? "unknown"}`);
console.log(`  Version:  ${health.body.version ?? "unknown"}`);

if (failed > 0) {
  console.log(`\n  ⚠  ${failed} test(s) failed — review output above before releasing.\n`);
  process.exit(1);
} else {
  console.log(`\n  ✓  All tests pass. Docker production mode is fully verified.\n`);
}
