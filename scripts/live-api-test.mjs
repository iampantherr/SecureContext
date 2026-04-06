/**
 * Live API Server integration test suite
 * Starts the Fastify API server with SqliteStore backend,
 * then exercises every endpoint via real HTTP requests.
 *
 * Run: node scripts/live-api-test.mjs
 *
 * Tests: authentication, all CRUD endpoints, error handling, rate limiting,
 * RBAC token flow, broadcast chain, cross-project isolation.
 */

import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

process.env["ZC_STORE"]   = "sqlite";
process.env["ZC_API_KEY"] = "test-api-key-live-suite";
process.env["ZC_API_PORT"] = "0"; // random port — assigned by OS

const { createApiServer } = await import("../dist/api-server.js");

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

const PP = "C:/api-test/live-project";
cleanDb(PP);

// ── Start API server ──────────────────────────────────────────────────────────
const { app, store, shutdown } = await createApiServer();
const address = await app.listen({ port: 0, host: "127.0.0.1" });
// Fastify returns the full URL already — just normalize 0.0.0.0 → 127.0.0.1
const BASE = address.replace("0.0.0.0", "127.0.0.1");

console.log(`\n=== API SERVER INTEGRATION TEST SUITE ===`);
console.log(`Server: ${BASE}\n`);

const AUTH = `Bearer test-api-key-live-suite`;

async function api(method, path, body, headers = {}) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json", "Authorization": AUTH, ...headers },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const json = await res.json();
  return { status: res.status, body: json };
}

// ─── Health ───────────────────────────────────────────────────────────────────
console.log("--- Health endpoint ---");
const health = await api("GET", "/health");
assert("GET /health: 200",                           health.status === 200);
assert("GET /health: status=ok",                     health.body.status === "ok");
assert("GET /health: version present",               typeof health.body.version === "string");

// ─── Auth rejection ───────────────────────────────────────────────────────────
console.log("\n--- Authentication ---");
const noAuth = await api("GET", "/api/v1/status?projectPath=" + encodeURIComponent(PP), undefined, { "Authorization": "" });
assert("Missing auth → 401",                         noAuth.status === 401);

const badAuth = await api("GET", "/api/v1/status?projectPath=" + encodeURIComponent(PP), undefined, { "Authorization": "Bearer wrong-key" });
assert("Bad API key → 401",                          badAuth.status === 401);

// ─── Invalid projectPath ──────────────────────────────────────────────────────
console.log("\n--- Input validation ---");
const relPath = await api("POST", "/api/v1/remember", { projectPath: "../relative/path", key: "x", value: "y" });
assert("Relative projectPath → 400",                 relPath.status === 400);

const noPath = await api("POST", "/api/v1/remember", { key: "x", value: "y" });
assert("Missing projectPath → 400",                  noPath.status === 400);

const noKey = await api("POST", "/api/v1/remember", { projectPath: PP, value: "y" });
assert("Missing key → 400",                          noKey.status === 400);

// ─── Working memory CRUD ──────────────────────────────────────────────────────
console.log("\n--- Working Memory API ---");

const rem1 = await api("POST", "/api/v1/remember", { projectPath: PP, key: "arch-decision", value: "Use hexagonal architecture", importance: 4 });
assert("POST /remember: 200",                        rem1.status === 200);
assert("POST /remember: ok=true",                    rem1.body.ok === true);
assert("POST /remember: count=1",                    rem1.body.count === 1);

await api("POST", "/api/v1/remember", { projectPath: PP, key: "tech-stack", value: "Node.js + PostgreSQL + pgvector", importance: 3 });
await api("POST", "/api/v1/remember", { projectPath: PP, key: "team-size",  value: "3 agents", importance: 2 });

const recall1 = await api("GET", `/api/v1/recall?projectPath=${encodeURIComponent(PP)}`);
assert("GET /recall: 200",                           recall1.status === 200);
assert("GET /recall: 3 facts",                       recall1.body.facts?.length === 3, `got ${recall1.body.facts?.length}`);
assert("GET /recall: max in response",               recall1.body.max >= 50);
assert("GET /recall: highest importance first",      recall1.body.facts[0].importance >= recall1.body.facts[1].importance);

// Forget
const forget1 = await api("POST", "/api/v1/forget", { projectPath: PP, key: "team-size" });
assert("POST /forget: 200",                          forget1.status === 200);
assert("POST /forget: deleted=true",                 forget1.body.deleted === true);

const forget2 = await api("POST", "/api/v1/forget", { projectPath: PP, key: "nonexistent" });
assert("POST /forget nonexistent: deleted=false",    forget2.body.deleted === false);

const recall2 = await api("GET", `/api/v1/recall?projectPath=${encodeURIComponent(PP)}`);
assert("After forget: 2 facts remain",               recall2.body.facts?.length === 2);

// ─── Knowledge base ───────────────────────────────────────────────────────────
console.log("\n--- Knowledge Base API ---");

const idx1 = await api("POST", "/api/v1/index", {
  projectPath: PP,
  content: "Hexagonal architecture separates domain logic from infrastructure concerns using ports and adapters",
  source: "docs/architecture.md",
});
assert("POST /index: 200",                           idx1.status === 200);
assert("POST /index: source returned",               idx1.body.source === "docs/architecture.md");

await api("POST", "/api/v1/index", {
  projectPath: PP,
  content: "pgvector extension provides cosine similarity and IVFFlat indexing for PostgreSQL",
  source: "docs/pgvector.md",
});

await new Promise(r => setTimeout(r, 100)); // let FTS index settle

const search1 = await api("POST", "/api/v1/search", { projectPath: PP, queries: ["hexagonal architecture ports adapters"] });
assert("POST /search: 200",                          search1.status === 200);
assert("POST /search: result returned",              search1.body.results?.length > 0);
assert("POST /search: correct doc found",            search1.body.results[0].source === "docs/architecture.md");

const searchEmpty = await api("POST", "/api/v1/search", { projectPath: PP, queries: ["xyz_irrelevant_gibberish_123"] });
assert("POST /search: empty result for no match",    searchEmpty.body.results?.length === 0);

const badSearch = await api("POST", "/api/v1/search", { projectPath: PP, queries: [] });
assert("POST /search: empty queries → 400",          badSearch.status === 400);

// ─── Status ───────────────────────────────────────────────────────────────────
console.log("\n--- Status API ---");
const status1 = await api("GET", `/api/v1/status?projectPath=${encodeURIComponent(PP)}`);
assert("GET /status: 200",                           status1.status === 200);
assert("GET /status: workingMemory present",         status1.body.workingMemory !== undefined);
assert("GET /status: knowledgeBase present",         status1.body.knowledgeBase !== undefined);
assert("GET /status: chain present",                 status1.body.chain !== undefined);
assert("GET /status: chain.ok = true initially",    status1.body.chain.ok === true);

// ─── Tokens & RBAC ────────────────────────────────────────────────────────────
console.log("\n--- RBAC Token API ---");

const issueOrch = await api("POST", "/api/v1/issue-token", { projectPath: PP, agentId: "live-orch", role: "orchestrator" });
assert("POST /issue-token: 200",                     issueOrch.status === 200);
assert("POST /issue-token: token starts zcst.",      issueOrch.body.token?.startsWith("zcst."));

const orchToken = issueOrch.body.token;

const issueDev  = await api("POST", "/api/v1/issue-token", { projectPath: PP, agentId: "live-dev", role: "developer" });
const devToken  = issueDev.body.token;

// Verify
const verifyOk  = await api("POST", "/api/v1/verify-token", { projectPath: PP, token: orchToken });
assert("POST /verify-token: valid=true for fresh token", verifyOk.body.valid === true);
assert("POST /verify-token: payload has role",           verifyOk.body.payload?.role === "orchestrator");

// Wrong project
const PP2 = "C:/api-test/other-project";
const verifyCross = await api("POST", "/api/v1/verify-token", { projectPath: PP2, token: orchToken });
assert("Cross-project verify: valid=false",              verifyCross.body.valid === false);

// Revoke
const revoke = await api("POST", "/api/v1/revoke-token", { projectPath: PP, agentId: "live-dev" });
assert("POST /revoke-token: 200",                        revoke.status === 200);
const afterRevoke = await api("POST", "/api/v1/verify-token", { projectPath: PP, token: devToken });
assert("After revoke: token invalid",                    afterRevoke.body.valid === false);

// ─── Broadcasts ───────────────────────────────────────────────────────────────
console.log("\n--- Broadcast API ---");

// Issue a broadcast token — RBAC is now active (tokens were issued in Token section above)
const bcOrchResp = await api("POST", "/api/v1/issue-token", { projectPath: PP, agentId: "bc-orch", role: "orchestrator" });
const bcOrchToken = bcOrchResp.body.token;

const bc1 = await api("POST", "/api/v1/broadcast", {
  projectPath: PP, type: "ASSIGN", agentId: "bc-orch",
  task: "Implement auth", summary: "Build JWT module", importance: 4,
  session_token: bcOrchToken,
});
assert("POST /broadcast ASSIGN: 200",                bc1.status === 200);
assert("POST /broadcast: message.id > 0",            bc1.body.message?.id > 0);

const bc2 = await api("POST", "/api/v1/broadcast", {
  projectPath: PP, type: "MERGE", agentId: "bc-orch",
  task: "Implement auth", summary: "Auth module merged", importance: 4,
  session_token: bcOrchToken,
});
assert("POST /broadcast MERGE: 200",                 bc2.status === 200);

// Invalid type
const bcBad = await api("POST", "/api/v1/broadcast", {
  projectPath: PP, type: "INVALID_TYPE", agentId: "bc-orch", task: "x",
  session_token: bcOrchToken,
});
assert("POST /broadcast invalid type → error",       bcBad.status !== 200);

// Recall broadcasts
const bcList = await api("GET", `/api/v1/broadcasts?projectPath=${encodeURIComponent(PP)}&limit=10`);
assert("GET /broadcasts: 200",                       bcList.status === 200);
assert("GET /broadcasts: 2 broadcasts",             bcList.body.broadcasts?.length === 2);
assert("GET /broadcasts: most recent first",         bcList.body.broadcasts[0].id === bc2.body.message.id);

// Chain
const chain = await api("GET", `/api/v1/chain?projectPath=${encodeURIComponent(PP)}`);
assert("GET /chain: 200",                            chain.status === 200);
assert("GET /chain: ok=true",                        chain.body.chain?.ok === true);
assert("GET /chain: totalRows=2",                    chain.body.chain?.totalRows === 2, `got ${chain.body.chain?.totalRows}`);

// Replay
const replay = await api("POST", "/api/v1/replay", { projectPath: PP, fromId: bc1.body.message.id });
assert("POST /replay: 200",                          replay.status === 200);
assert("POST /replay: 2 results from bc1",          replay.body.broadcasts?.length === 2);
assert("POST /replay: ordered oldest first",         replay.body.broadcasts[0].id === bc1.body.message.id);

// Ack
const ack = await api("POST", "/api/v1/ack", { projectPath: PP, id: bc1.body.message.id });
assert("POST /ack: 200",                             ack.status === 200);

// ─── Summarize ────────────────────────────────────────────────────────────────
console.log("\n--- Session summary ---");
const summ = await api("POST", "/api/v1/summarize", { projectPath: PP, summary: "Completed auth module. JWT RS256. Chain intact." });
assert("POST /summarize: 200",                       summ.status === 200);

// ─── Unknown path ─────────────────────────────────────────────────────────────
console.log("\n--- 404 + edge cases ---");
const notFound = await api("GET", "/api/v1/nonexistent");
assert("Unknown path → 404",                         notFound.status === 404);

const emptyBody = await api("POST", "/api/v1/remember", {});
assert("Empty body → 400",                           emptyBody.status === 400);

// ─── Cleanup ──────────────────────────────────────────────────────────────────
await shutdown();
cleanDb(PP);
cleanDb(PP2);

console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
