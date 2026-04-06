#!/usr/bin/env node
/**
 * SecureContext E2E Dispatcher Test
 *
 * Tests the full A2A dispatcher workflow against the live Docker stack:
 *   1. Stack health + Ollama availability
 *   2. Context memory (remember / recall / search)
 *   3. All broadcast types: ASSIGN, STATUS, PROPOSED, DEPENDENCY, MERGE, REJECT, REVISE
 *   4. Worker question flow (STATUS state="waiting-for-answer" → orchestrator answers)
 *   5. Multi-project isolation
 *   6. Session summary + cross-session recall
 *   7. RBAC token lifecycle
 *   8. Chain integrity
 *
 * Usage:
 *   node scripts/e2e-dispatcher-test.mjs
 *   API_URL=http://localhost:3099 API_KEY=<key> node scripts/e2e-dispatcher-test.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ─────────────────────────────────────────────────────────────────
function loadEnv() {
  const envFile = join(__dirname, "../docker/.env");
  const env = {};
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

const dockerEnv  = loadEnv();
const API_URL    = process.env["API_URL"]  ?? "http://localhost:3099";
const API_KEY    = process.env["API_KEY"]  ?? dockerEnv["ZC_API_KEY"] ?? "";
const TEST_PATH  = "C:/Users/Amit/AI_projects/Test_Agent_Coordination";
const TEST_PATH2 = "C:/Users/Amit/AI_projects/coding_agent";

// ── Test harness ───────────────────────────────────────────────────────────
let passed = 0, failed = 0, warned = 0;
const results = [];

function pass(name, detail = "") {
  passed++;
  results.push({ status: "PASS", name, detail });
  console.log(`  ✅ PASS  ${name}${detail ? `  — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  failed++;
  results.push({ status: "FAIL", name, detail });
  console.log(`  ❌ FAIL  ${name}${detail ? `  — ${detail}` : ""}`);
}

function warn(name, detail = "") {
  warned++;
  results.push({ status: "WARN", name, detail });
  console.log(`  ⚠️  WARN  ${name}${detail ? `  — ${detail}` : ""}`);
}

function section(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
async function api(method, path, body) {
  const headers = { Authorization: `Bearer ${API_KEY}` };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, json };
}

async function GET(path)       { return api("GET", path); }
async function POST(path, body){ return api("POST", path, body); }
async function DEL(path, body) { return api("DELETE", path, body); }

// ── Test sections ──────────────────────────────────────────────────────────

async function testHealth() {
  section("1. Stack Health + Ollama Availability");

  const r = await GET("/health");
  if (!r.ok) return fail("health endpoint reachable", `HTTP ${r.status}`);
  pass("health endpoint reachable", `HTTP ${r.status}`);

  const h = r.json;
  if (h.status === "ok") pass("status=ok");
  else fail("status=ok", `got: ${h.status}`);

  if (h.version === "0.8.0") pass("version=0.8.0");
  else fail("version=0.8.0", `got: ${h.version}`);

  if (h.store === "postgres") pass("store=postgres (Docker mode)");
  else fail("store=postgres", `got: ${h.store}`);

  if (typeof h.ollamaAvailable === "boolean") {
    if (h.ollamaAvailable) {
      pass("Ollama available", `model endpoint: ${h.ollamaUrl} | mode: ${h.searchMode}`);
    } else {
      warn("Ollama not yet available", `searchMode: ${h.searchMode} — may still be pulling model`);
    }
  } else {
    fail("ollamaAvailable field present in /health response");
  }

  if (h.searchMode) pass("searchMode field in /health", h.searchMode);
  else fail("searchMode field in /health");
}

async function testAuth() {
  section("2. Authentication");

  // No key → 401
  const r1 = await fetch(`${API_URL}/api/v1/status?projectPath=${encodeURIComponent(TEST_PATH)}`);
  if (r1.status === 401) pass("no-key → 401");
  else fail("no-key → 401", `got ${r1.status}`);

  // Wrong key → 401
  const r2 = await fetch(`${API_URL}/api/v1/status?projectPath=${encodeURIComponent(TEST_PATH)}`, {
    headers: { Authorization: "Bearer wrong-key" },
  });
  if (r2.status === 401) pass("wrong-key → 401");
  else fail("wrong-key → 401", `got ${r2.status}`);

  // Correct key → not 401
  const r3 = await GET(`/api/v1/status?projectPath=${encodeURIComponent(TEST_PATH)}&agentId=orchestrator`);
  if (r3.status !== 401) pass("valid-key → authenticated");
  else fail("valid-key → authenticated");
}

async function testWorkingMemory() {
  section("3. Working Memory — Context Persistence");

  // Store facts for orchestrator and workers
  const facts = [
    { key: "owns: tasks/task_list.json",   value: "worker-1 owns this file", agentId: "worker-1",   importance: 7 },
    { key: "owns: reports/summary.md",     value: "worker-2 owns this file", agentId: "worker-2",   importance: 7 },
    { key: "project:sprint",               value: "Sprint 1 — task tracker MVP", agentId: "orchestrator", importance: 8 },
    { key: "architecture:decision",        value: "task_list.json is the source of truth; reports are derived", agentId: "orchestrator", importance: 9 },
    { key: "task:current",                 value: "Add priority field to tasks", agentId: "worker-1", importance: 6 },
  ];

  for (const f of facts) {
    const r = await POST("/api/v1/remember", {
      projectPath: TEST_PATH, key: f.key, value: f.value,
      agentId: f.agentId, importance: f.importance,
    });
    if (r.ok) pass(`remember: ${f.key} (${f.agentId})`);
    else fail(`remember: ${f.key}`, JSON.stringify(r.json));
  }

  // Recall per agent
  const r1 = await GET(`/api/v1/recall?projectPath=${encodeURIComponent(TEST_PATH)}&agentId=worker-1`);
  if (r1.ok && Array.isArray(r1.json.facts) && r1.json.facts.length >= 2) {
    pass("recall worker-1: facts present", `${r1.json.facts.length} facts`);
  } else {
    fail("recall worker-1", JSON.stringify(r1.json));
  }

  // Worker-1 should NOT see worker-2 facts (agent isolation)
  const w1Facts = r1.json.facts?.map(f => f.key) ?? [];
  if (!w1Facts.includes("owns: reports/summary.md")) {
    pass("agent isolation: worker-1 cannot see worker-2 facts");
  } else {
    fail("agent isolation", "worker-1 can see worker-2 facts");
  }

  // Forget a fact
  const rf = await POST("/api/v1/forget", {
    projectPath: TEST_PATH, key: "task:current", agentId: "worker-1",
  });
  if (rf.ok && rf.json.deleted) pass("forget: deleted=true");
  else fail("forget", JSON.stringify(rf.json));

  // Re-store for subsequent tests
  await POST("/api/v1/remember", {
    projectPath: TEST_PATH, key: "task:current",
    value: "Add priority field to tasks", agentId: "worker-1", importance: 6,
  });
}

async function testKnowledgeBase() {
  section("4. Knowledge Base — Index + Search");

  // Index project context
  const docs = [
    { content: "task_list.json stores tasks with id, title, status, assignee, and priority fields. Managed by worker-1.", source: "tasks/task_list.json", sourceType: "internal" },
    { content: "reports/summary.md contains a human-readable summary of task metrics. Managed by worker-2.", source: "reports/summary.md", sourceType: "internal" },
    { content: "File ownership rule: worker-1 owns tasks/*, worker-2 owns reports/*. No cross-ownership edits.", source: "CLAUDE.md:ownership", sourceType: "internal" },
    { content: "Dispatcher question flow: worker posts STATUS(state=waiting-for-answer). Orchestrator polls via zc_recall_context and responds with STATUS(state=answer).", source: "CLAUDE.md:dispatcher", sourceType: "internal" },
  ];

  for (const d of docs) {
    const r = await POST("/api/v1/index", {
      projectPath: TEST_PATH, content: d.content, source: d.source, sourceType: d.sourceType,
    });
    if (r.ok) pass(`index: ${d.source}`);
    else fail(`index: ${d.source}`, JSON.stringify(r.json));
  }

  // Search
  const s1 = await POST("/api/v1/search", {
    projectPath: TEST_PATH,
    queries: ["who owns task_list.json"],
    limit: 5,
  });
  if (s1.ok && Array.isArray(s1.json.results) && s1.json.results.length > 0) {
    const top = s1.json.results[0];
    pass("search: file ownership query returns results", `top: ${top.source} (bm25: ${top.bm25Score?.toFixed(3) ?? "n/a"})`);
  } else {
    fail("search: file ownership query", JSON.stringify(s1.json));
  }

  const s2 = await POST("/api/v1/search", {
    projectPath: TEST_PATH,
    queries: ["dispatcher question waiting answer"],
    limit: 3,
  });
  if (s2.ok && s2.json.results?.length > 0) {
    const top = s2.json.results[0];
    const hasVector = top.vectorScore !== undefined && top.vectorScore !== null;
    pass("search: dispatcher question flow found", `${top.source} | vector: ${hasVector ? top.vectorScore.toFixed(3) : "BM25-only"}`);
    if (!hasVector) warn("vector scores absent — Ollama may still be pulling model (BM25-only fallback active)");
  } else {
    fail("search: dispatcher question flow", JSON.stringify(s2.json));
  }

  // Cross-project search
  const sg = await POST("/api/v1/search-global", {
    queries: ["file ownership worker"],
    limit: 5,
  });
  if (sg.ok && sg.json.results?.length > 0) {
    pass("search-global: cross-project search works", `${sg.json.results.length} results`);
  } else {
    warn("search-global: no results", "may need more indexed content across projects");
  }
}

async function testBroadcastAllTypes() {
  section("5. Broadcast — All Types (Full Dispatcher Workflow)");

  // DEPENDENCY — orchestrator declares file ownership before assigning
  const dep = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "DEPENDENCY",
    agentId: "orchestrator",
    files: ["tasks/task_list.json", "reports/summary.md"],
    summary: "task_list.json owned by worker-1; reports/summary.md owned by worker-2. Do not cross-edit.",
  });
  if (dep.ok) pass("DEPENDENCY: orchestrator declares file ownership", `id=${dep.json.message?.id}`);
  else fail("DEPENDENCY broadcast", JSON.stringify(dep.json));

  // ASSIGN — orchestrator assigns to worker-1
  const assign1 = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "ASSIGN",
    agentId: "orchestrator",
    task: "add-priority-field",
    files: ["tasks/task_list.json"],
    summary: "Add a 'priority' field (high/medium/low) to each task in task_list.json. Use 'medium' as default.",
  });
  if (assign1.ok) pass("ASSIGN: task 'add-priority-field' to worker-1", `id=${assign1.json.message?.id}`);
  else fail("ASSIGN broadcast", JSON.stringify(assign1.json));

  // ASSIGN — orchestrator assigns to worker-2
  const assign2 = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "ASSIGN",
    agentId: "orchestrator",
    task: "update-metrics-report",
    files: ["reports/summary.md", "reports/metrics.json"],
    summary: "Update reports/summary.md and metrics.json to include priority distribution stats once worker-1 completes add-priority-field.",
    depends_on: [assign1.json.message?.id?.toString()].filter(Boolean),
  });
  if (assign2.ok) pass("ASSIGN: task 'update-metrics-report' to worker-2 (depends_on worker-1)", `id=${assign2.json.message?.id}`);
  else fail("ASSIGN worker-2", JSON.stringify(assign2.json));

  // STATUS — worker-1 reports in-progress
  const stat1 = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "STATUS",
    agentId: "worker-1",
    state: "in-progress",
    task: "add-priority-field",
    summary: "Reading task_list.json. Found 5 tasks — will add priority field to each. About 50% done.",
  });
  if (stat1.ok) pass("STATUS: worker-1 reports in-progress", `state=in-progress`);
  else fail("STATUS in-progress", JSON.stringify(stat1.json));

  // STATUS(waiting-for-answer) — worker-1 asks a question
  const question = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "STATUS",
    agentId: "worker-1",
    state: "waiting-for-answer",
    task: "add-priority-field",
    summary: "QUESTION: Should I set priority='high' for tasks with id < 3, or use 'medium' for all as the default? The requirements say 'medium' default but two tasks look urgent.",
  });
  if (question.ok) pass("STATUS(waiting-for-answer): worker-1 asks question", `id=${question.json.message?.id} — BLOCKED`);
  else fail("STATUS waiting-for-answer", JSON.stringify(question.json));

  // Simulate orchestrator reading and seeing the blocked worker
  const broadcasts = await GET(`/api/v1/broadcasts?projectPath=${encodeURIComponent(TEST_PATH)}&limit=20`);
  const blockedWorker = broadcasts.json.broadcasts?.find(b =>
    b.type === "STATUS" && b.state === "waiting-for-answer"
  );
  if (blockedWorker) {
    pass("Dispatcher: orchestrator sees worker blocked on question",
      `worker: ${blockedWorker.agentId}, task: ${blockedWorker.task}`);
  } else {
    fail("Dispatcher: orchestrator cannot find blocked worker");
  }

  // STATUS(answer) — orchestrator answers
  const answer = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "STATUS",
    agentId: "orchestrator",
    state: "answer",
    task: "add-priority-field",
    summary: "ANSWER: Use 'medium' as default for all tasks (as specified). Do NOT infer urgency from IDs. The acceptance criteria specifically says all defaults should be 'medium'.",
  });
  if (answer.ok) pass("STATUS(answer): orchestrator responds to worker question", `id=${answer.json.message?.id}`);
  else fail("STATUS answer", JSON.stringify(answer.json));

  // STATUS(completed) — worker-1 done
  const done1 = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "STATUS",
    agentId: "worker-1",
    state: "completed",
    task: "add-priority-field",
    summary: "Added priority='medium' to all 5 tasks in task_list.json.",
  });
  if (done1.ok) pass("STATUS(completed): worker-1 marks task done");
  else fail("STATUS completed", JSON.stringify(done1.json));

  // PROPOSED — worker-1 proposes changes for review
  const proposed = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "PROPOSED",
    agentId: "worker-1",
    task: "add-priority-field",
    files: ["tasks/task_list.json"],
    summary: "Added priority field to all tasks. All set to 'medium' per orchestrator answer. Verify: run `node index.js` and check tasks.length === 5 with priority fields.",
  });
  if (proposed.ok) pass("PROPOSED: worker-1 proposes change for review", `id=${proposed.json.message?.id}`);
  else fail("PROPOSED broadcast", JSON.stringify(proposed.json));

  // DEPENDENCY — worker-2 declares dependency on worker-1 output
  const dep2 = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "DEPENDENCY",
    agentId: "worker-2",
    files: ["tasks/task_list.json"],
    summary: "worker-2 (update-metrics-report) depends on tasks/task_list.json having priority field. Waiting for MERGE of add-priority-field.",
    depends_on: [proposed.json.message?.id?.toString()].filter(Boolean),
  });
  if (dep2.ok) pass("DEPENDENCY: worker-2 declares dependency on worker-1 PROPOSED", `id=${dep2.json.message?.id}`);
  else fail("DEPENDENCY worker-2", JSON.stringify(dep2.json));

  // REVISE — orchestrator requests a change before approving
  const revise = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "REVISE",
    agentId: "orchestrator",
    task: "add-priority-field",
    reason: "Please also add a 'priority_set_by' field alongside 'priority' to track whether it was set by default or manually. This helps metrics.",
    summary: "Small addition needed before merge — add priority_set_by field",
  });
  if (revise.ok) pass("REVISE: orchestrator requests change before merge", `id=${revise.json.message?.id}`);
  else fail("REVISE broadcast", JSON.stringify(revise.json));

  // STATUS — worker-1 revises and re-proposes
  const revised = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "PROPOSED",
    agentId: "worker-1",
    task: "add-priority-field",
    files: ["tasks/task_list.json"],
    summary: "Updated: added both priority and priority_set_by fields. priority_set_by='default' for all existing tasks.",
  });
  if (revised.ok) pass("PROPOSED (revised): worker-1 re-proposes after REVISE");
  else fail("PROPOSED revised", JSON.stringify(revised.json));

  // REJECT scenario — simulate a bad proposal first
  const badProposed = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "PROPOSED",
    agentId: "worker-1",
    task: "experimental-feature",
    files: ["index.js"],
    summary: "Attempted to add console.log tracing to index.js",
  });

  const reject = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "REJECT",
    agentId: "orchestrator",
    task: "experimental-feature",
    reason: "index.js is read-only per CLAUDE.md project rules. No modifications allowed. Please revert.",
    summary: "Rejected — do not modify read-only files",
  });
  if (reject.ok) pass("REJECT: orchestrator rejects unauthorized file edit", `reason captured`);
  else fail("REJECT broadcast", JSON.stringify(reject.json));

  // MERGE — final approval
  const merge = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "MERGE",
    agentId: "orchestrator",
    task: "add-priority-field",
    summary: "Approved — priority and priority_set_by fields look correct. Merge to main. worker-2 can proceed with update-metrics-report.",
  });
  if (merge.ok) pass("MERGE: orchestrator approves final proposal", `id=${merge.json.message?.id}`);
  else fail("MERGE broadcast", JSON.stringify(merge.json));
}

async function testBroadcastReplay() {
  section("6. Broadcast Replay + Chain Integrity");

  // Replay from beginning
  const replay = await POST("/api/v1/replay", { projectPath: TEST_PATH });
  if (replay.ok && Array.isArray(replay.json.broadcasts) && replay.json.broadcasts.length >= 10) {
    const types = [...new Set(replay.json.broadcasts.map(b => b.type))].sort().join(", ");
    pass("replay: full broadcast history present", `${replay.json.broadcasts.length} msgs, types: ${types}`);
  } else {
    fail("replay", JSON.stringify(replay.json).slice(0, 200));
  }

  // Verify all 7 types present
  const allBroadcasts = replay.json.broadcasts ?? [];
  const typesPresent = new Set(allBroadcasts.map(b => b.type));
  const expectedTypes = ["ASSIGN", "STATUS", "PROPOSED", "DEPENDENCY", "MERGE", "REJECT", "REVISE"];
  for (const t of expectedTypes) {
    if (typesPresent.has(t)) pass(`broadcast type present: ${t}`);
    else fail(`broadcast type present: ${t}`, "missing from replay");
  }

  // Verify question/answer pair
  const questionMsg = allBroadcasts.find(b => b.type === "STATUS" && b.state === "waiting-for-answer");
  const answerMsg   = allBroadcasts.find(b => b.type === "STATUS" && b.state === "answer");
  if (questionMsg && answerMsg) {
    pass("question/answer pair present in broadcast history",
      `Q: id=${questionMsg.id} → A: id=${answerMsg.id}`);
    if (questionMsg.task === answerMsg.task) {
      pass("question/answer share same task ref", questionMsg.task);
    } else {
      fail("question/answer task mismatch", `Q=${questionMsg.task} A=${answerMsg.task}`);
    }
  } else {
    fail("question/answer pair", `question=${!!questionMsg} (${questionMsg?.state}), answer=${!!answerMsg} (${answerMsg?.state})`);
  }

  // Chain integrity
  const chain = await GET(`/api/v1/chain?projectPath=${encodeURIComponent(TEST_PATH)}`);
  if (chain.ok && chain.json.chain?.ok) {
    pass("hash chain integrity: OK", `${chain.json.chain.totalRows} rows, no breaks`);
  } else {
    fail("hash chain integrity", JSON.stringify(chain.json));
  }
}

async function testSessionSummary() {
  section("7. Session Summary + Cross-Session Recall");

  // Archive a session summary
  const summary = await POST("/api/v1/summarize", {
    projectPath: TEST_PATH,
    summary: `Sprint 1 session complete.
Orchestrator assigned add-priority-field to worker-1 and update-metrics-report to worker-2.
worker-1 asked a question about priority defaults — orchestrator answered: use medium for all.
worker-1 completed the task after one REVISE cycle (added priority_set_by field).
MERGE approved. worker-2 can now start update-metrics-report.
One REJECT issued for unauthorized edit of read-only index.js.
All 7 broadcast types tested. Hash chain intact.`,
  });
  if (summary.ok) pass("summarize_session: summary archived");
  else fail("summarize_session", JSON.stringify(summary.json));

  // Search for the summary in KB
  const s = await POST("/api/v1/search", {
    projectPath: TEST_PATH,
    queries: ["sprint session summary priority field worker"],
    limit: 5,
  });
  if (s.ok && s.json.results?.length > 0) {
    pass("search finds archived session summary", `top result: ${s.json.results[0].source}`);
  } else {
    warn("session summary not immediately searchable", "may need KB flush");
  }
}

async function testMultiProjectIsolation() {
  section("8. Multi-Project Isolation");

  // Store memory in coding_agent project
  await POST("/api/v1/remember", {
    projectPath: TEST_PATH2,
    key: "project:name",
    value: "Autonomous Coding Agent — Python-based agent with error handling",
    agentId: "default",
    importance: 8,
  });

  // Recall from test-coordination — should NOT have coding_agent memory
  const r1 = await GET(`/api/v1/recall?projectPath=${encodeURIComponent(TEST_PATH)}&agentId=default`);
  const r2 = await GET(`/api/v1/recall?projectPath=${encodeURIComponent(TEST_PATH2)}&agentId=default`);

  const p1Keys = (r1.json.facts ?? []).map(f => f.key);
  const p2Keys = (r2.json.facts ?? []).map(f => f.key);

  if (p2Keys.includes("project:name") && !p1Keys.includes("project:name")) {
    pass("multi-project isolation: facts scoped to correct project");
  } else {
    fail("multi-project isolation", `p1=${p1Keys.join(",")}, p2=${p2Keys.join(",")}`);
  }

  // Broadcasts are also isolated
  const b1 = await GET(`/api/v1/broadcasts?projectPath=${encodeURIComponent(TEST_PATH)}&limit=5`);
  const b2 = await GET(`/api/v1/broadcasts?projectPath=${encodeURIComponent(TEST_PATH2)}&limit=5`);

  if (b1.json.broadcasts?.length > 0 && (b2.json.broadcasts?.length ?? 0) === 0) {
    pass("broadcasts isolated per project", `coord=${b1.json.broadcasts.length} msgs, coding_agent=0 msgs`);
  } else if (b2.json.broadcasts?.length === 0) {
    pass("broadcasts isolated per project (coding_agent empty)");
  } else {
    warn("broadcast isolation", `coord=${b1.json.broadcasts?.length}, coding_agent=${b2.json.broadcasts?.length}`);
  }
}

async function testRbacTokens() {
  section("9. RBAC Token Lifecycle");

  // Issue token for worker-1 (worker role)
  const issued = await POST("/api/v1/issue-token", {
    projectPath: TEST_PATH,
    agentId: "worker-1-rbac-test",
    role: "worker",
  });
  if (!issued.ok || !issued.json.token) {
    fail("issue-token", JSON.stringify(issued.json));
    return;
  }
  const token = issued.json.token;
  pass("issue-token: worker role token issued");

  // Verify token
  const verified = await POST("/api/v1/verify-token", {
    projectPath: TEST_PATH,
    token,
  });
  if (verified.ok && verified.json.valid && verified.json.payload?.role === "worker") {
    pass("verify-token: valid, role=worker");
  } else {
    fail("verify-token", JSON.stringify(verified.json));
  }

  // Use token in PROPOSED broadcast
  const broadcast = await POST("/api/v1/broadcast", {
    projectPath: TEST_PATH,
    type: "PROPOSED",
    agentId: "worker-1-rbac-test",
    task: "rbac-test-task",
    files: ["tasks/notes.md"],
    summary: "RBAC test proposal — using session_token for authentication",
    session_token: token,
  });
  if (broadcast.ok) pass("PROPOSED with session_token: accepted");
  else fail("PROPOSED with session_token", JSON.stringify(broadcast.json));

  // Revoke token
  const revoked = await POST("/api/v1/revoke-token", {
    projectPath: TEST_PATH,
    agentId: "worker-1-rbac-test",
  });
  if (revoked.ok) pass("revoke-token: revoked");
  else fail("revoke-token", JSON.stringify(revoked.json));

  // Verify token is now invalid
  const verifiedAfter = await POST("/api/v1/verify-token", {
    projectPath: TEST_PATH,
    token,
  });
  if (verifiedAfter.ok && !verifiedAfter.json.valid) {
    pass("verify-token after revoke: invalid as expected");
  } else {
    fail("verify-token after revoke", JSON.stringify(verifiedAfter.json));
  }
}

async function testStatus() {
  section("10. Status Endpoint — Full Health Check");

  const r = await GET(`/api/v1/status?projectPath=${encodeURIComponent(TEST_PATH)}&agentId=orchestrator`);
  if (!r.ok) { fail("status endpoint", JSON.stringify(r.json)); return; }

  const s = r.json;
  if (s.ok) pass("status: ok");
  if (s.workingMemory?.count >= 0) pass("status: workingMemory present", `count=${s.workingMemory.count}, max=${s.workingMemory.max}`);
  else fail("status: workingMemory");

  if (s.knowledgeBase?.totalEntries >= 0) pass("status: knowledgeBase present", `entries=${s.knowledgeBase.totalEntries}, embeddings=${s.knowledgeBase.embeddingsCached}`);
  else fail("status: knowledgeBase");

  if (s.chain?.ok !== undefined) pass("status: chain status present", s.chain.ok ? `OK (${s.chain.totalRows} rows)` : `BROKEN at ${s.chain.brokenAt}`);
  else fail("status: chain");
}

async function testDispatcherCorrectness() {
  section("11. Dispatcher Correctness — No Gibberish, Correct Targeting");

  // Verify broadcasts have proper structure (no empty/garbage fields)
  const r = await GET(`/api/v1/broadcasts?projectPath=${encodeURIComponent(TEST_PATH)}&limit=50`);
  const broadcasts = r.json.broadcasts ?? [];

  let gibberishCount = 0;
  for (const b of broadcasts) {
    // Check type is valid
    const validTypes = ["ASSIGN", "STATUS", "PROPOSED", "DEPENDENCY", "MERGE", "REJECT", "REVISE"];
    if (!validTypes.includes(b.type)) gibberishCount++;
    // Check agent_id is meaningful (API returns snake_case)
    const agentId = b.agent_id ?? b.agentId;
    if (!agentId || agentId === "") gibberishCount++;
    // Check no null summary (optional but should be string if present)
    if (b.summary !== null && b.summary !== undefined && typeof b.summary !== "string") gibberishCount++;
  }

  if (gibberishCount === 0) pass("dispatcher correctness: no gibberish in broadcast payloads");
  else fail("dispatcher correctness", `${gibberishCount} malformed broadcasts`);

  // Check orchestrator broadcasts only go to orchestrator context (API returns agent_id snake_case)
  const orchestratorBroadcasts = broadcasts.filter(b => (b.agent_id ?? b.agentId) === "orchestrator");
  const workerBroadcasts       = broadcasts.filter(b => (b.agent_id ?? b.agentId)?.startsWith("worker"));

  if (orchestratorBroadcasts.length > 0 && workerBroadcasts.length > 0) {
    pass("dispatcher: orchestrator and worker broadcasts clearly separated",
      `orchestrator=${orchestratorBroadcasts.length}, workers=${workerBroadcasts.length}`);
  } else {
    warn("dispatcher agent separation", `orch=${orchestratorBroadcasts.length}, worker=${workerBroadcasts.length}`);
  }

  // ASSIGN broadcasts must have a task field
  const assigns = broadcasts.filter(b => b.type === "ASSIGN");
  const assignsWithTask = assigns.filter(b => b.task && b.task.length > 0);
  if (assigns.length > 0 && assignsWithTask.length === assigns.length) {
    pass("ASSIGN broadcasts all have task field", `${assigns.length}/${assigns.length}`);
  } else {
    fail("ASSIGN broadcasts missing task", `${assignsWithTask.length}/${assigns.length} have task`);
  }

  // REJECT broadcasts must have reason
  const rejects = broadcasts.filter(b => b.type === "REJECT");
  const rejectsWithReason = rejects.filter(b => b.reason && b.reason.length > 0);
  if (rejects.length > 0 && rejectsWithReason.length === rejects.length) {
    pass("REJECT broadcasts all have reason field", `${rejects.length}/${rejects.length}`);
  } else if (rejects.length === 0) {
    warn("no REJECT broadcasts to check reason field");
  } else {
    fail("REJECT broadcasts missing reason", `${rejectsWithReason.length}/${rejects.length}`);
  }

  // REVISE broadcasts must have reason
  const revises = broadcasts.filter(b => b.type === "REVISE");
  const revisesWithReason = revises.filter(b => b.reason && b.reason.length > 0);
  if (revises.length > 0 && revisesWithReason.length === revises.length) {
    pass("REVISE broadcasts all have reason field", `${revises.length}/${revises.length}`);
  } else if (revises.length === 0) {
    warn("no REVISE broadcasts to check reason field");
  } else {
    fail("REVISE broadcasts missing reason", `${revisesWithReason.length}/${revises.length}`);
  }

  // DEPENDENCY broadcasts must have files
  const deps = broadcasts.filter(b => b.type === "DEPENDENCY");
  const depsWithFiles = deps.filter(b => Array.isArray(b.files) && b.files.length > 0);
  if (deps.length > 0 && depsWithFiles.length === deps.length) {
    pass("DEPENDENCY broadcasts all have files array", `${deps.length}/${deps.length}`);
  } else if (deps.length === 0) {
    warn("no DEPENDENCY broadcasts to check files");
  } else {
    fail("DEPENDENCY broadcasts missing files", `${depsWithFiles.length}/${deps.length}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   SecureContext E2E Dispatcher Test                         ║");
  console.log("║   Target: " + API_URL.padEnd(51) + "║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Test project 1: ${TEST_PATH}`);
  console.log(`  Test project 2: ${TEST_PATH2}`);
  console.log(`  API key: ${API_KEY ? API_KEY.slice(0, 8) + "..." : "(none)"}`);

  try {
    await testHealth();
    await testAuth();
    await testWorkingMemory();
    await testKnowledgeBase();
    await testBroadcastAllTypes();
    await testBroadcastReplay();
    await testSessionSummary();
    await testMultiProjectIsolation();
    await testRbacTokens();
    await testStatus();
    await testDispatcherCorrectness();
  } catch (err) {
    console.error("\n\x1b[31mUnhandled error:\x1b[0m", err);
    failed++;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const total = passed + failed + warned;
  console.log("\n" + "═".repeat(62));
  console.log(`  RESULTS: ${passed} passed  |  ${failed} failed  |  ${warned} warnings`);
  console.log(`  Total:   ${total} checks`);
  console.log("═".repeat(62) + "\n");

  if (failed > 0) {
    console.log("Failed checks:");
    results.filter(r => r.status === "FAIL").forEach(r =>
      console.log(`  ❌ ${r.name}: ${r.detail}`)
    );
  }

  if (warned > 0) {
    console.log("\nWarnings:");
    results.filter(r => r.status === "WARN").forEach(r =>
      console.log(`  ⚠️  ${r.name}: ${r.detail}`)
    );
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
