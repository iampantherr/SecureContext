/**
 * R8f — mature-project memory fixture.
 *
 * Seeds a dedicated project (ZZ_MATURE) with ~250 working-memory facts shaped
 * like the live A2A project the R8 work was measured on: three namespaces
 * (orchestrator / developer / default), ~87% importance-5 (deliberate inflation),
 * ~500-char values, key prefixes OWNERSHIP_/LEARNING_/FEEDBACK_/DECISION_/ckpt_,
 * and created_at spread over the past 8 weeks (backdated via psql, same
 * mechanism as memory-bench --seed). This is the scale scenario the feature
 * E2Es never covered: features were tested at birth, never memory at age.
 *
 * Usage (AFTER the operator confirms no live A2A session is running):
 *   node scripts/seed-mature-memory.mjs           # seed (idempotent: purges first)
 *   node scripts/seed-mature-memory.mjs --purge   # remove all fixture data
 *
 * Then: node scripts/recall-size-check.mjs        # the regression assertion
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PROJECT = "C:/Users/Amit/AI_projects/ZZ_MATURE";
const API = process.env.ZC_API_URL || "http://localhost:3099";
const KEY = process.env.ZC_API_KEY || readEnvKey();
const PSQL = ["exec", "securecontext-postgres", "psql", "-U", "scuser", "-d", "securecontext", "-tAc"];

function readEnvKey() {
  try {
    const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const m = env.match(/^ZC_API_KEY=(.+)$/m);
    return m ? m[1].trim() : "";
  } catch { return ""; }
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function psql(sql) {
  return execFileSync("docker", [...PSQL, sql], { encoding: "utf8" }).trim();
}

// Deterministic pseudo-random (no Math.random — reproducible fixture).
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

const TOPICS = [
  "hub handler worktree path resolution", "role prompt outcome focus rewrite",
  "docker compose port collision on 3099", "dispatcher nudge timing for opus",
  "evidence gate rejects bare scores", "skill menu drops missing intended_roles",
  "postgres RLS policy for tool_calls", "frontend sidebar agent status polling",
  "broadcast chain HMAC verification", "pulse animation on merge events",
  "CR lifecycle tests_failed retry path", "telemetry route rate limiting",
  "agent card generator jinja template", "SOC compromise drill findings",
  "stale build grid acceptance criteria", "audit chain root cause 4140",
];
const VERBS = ["decided", "confirmed", "measured", "fixed", "verified", "blocked-on", "assigned", "completed"];

function factValue(i, topic) {
  // ~480-500 chars, mirrors the live project's value sizes.
  const base = `${pick(VERBS)} ${topic} — detail ${i}: `;
  const filler =
    "the change was applied across hub/main.py and the frontend route, verified against the staging " +
    "compose stack, and the follow-up items were recorded for the next session. Key constraint: the " +
    "internal key auth must not be bypassed by the analytics route, and the worktree path must resolve " +
    "relative to the repo root rather than the agent CWD. See the MERGE broadcast for the task id and " +
    "the commit hash recorded at checkpoint time for full traceability of this decision.";
  return (base + filler).slice(0, 495);
}

const NAMESPACES = [
  { agent: "orchestrator", count: 108, prefixes: ["LEARNING", "DECISION", "AUDIT", "SOC", "PULSE"] },
  { agent: "developer",    count: 60,  prefixes: ["ckpt", "FIX", "LEARNING", "DECISION"] },
  { agent: "default",      count: 82,  prefixes: ["OWNERSHIP_DEV", "OWNERSHIP_QA", "FEEDBACK_NOTE", "STATE"] },
];

async function seedAll() {
  await purge();
  console.log("seeding ZZ_MATURE (~250 facts, 87% ★5, 8-week spread)…");
  let total = 0;
  for (const ns of NAMESPACES) {
    for (let i = 0; i < ns.count; i++) {
      const topic = pick(TOPICS);
      const prefix = pick(ns.prefixes);
      const key = `${prefix}_${topic.split(" ")[0].toUpperCase()}_${i}`;
      // 87% ★5 (the measured inflation), rest 3-4.
      const importance = rnd() < 0.87 ? 5 : (rnd() < 0.5 ? 4 : 3);
      await api("POST", "/api/v1/remember", {
        projectPath: PROJECT, key, value: factValue(i, topic), importance, agentId: ns.agent,
      });
      total++;
      if (total % 50 === 0) console.log(`  ${total} facts…`);
    }
  }
  // Backdate created_at across 8 weeks (deterministic spread). last_retrieved_at
  // stays NULL → staleness demotion has real signal for old facts.
  const h = psql(`SELECT project_hash FROM working_memory WHERE agent_id='orchestrator' AND key LIKE '%_0' ORDER BY created_at DESC LIMIT 1`);
  if (!/^[0-9a-f]{16}$/.test(h)) throw new Error(`could not resolve ZZ_MATURE project_hash (got '${h}')`);
  console.log(`backdating created_at (hash ${h})…`);
  psql(`UPDATE working_memory SET created_at = NOW() - ((ABS(HASHTEXT(key)) % 56) || ' days')::interval WHERE project_hash='${h}'`);
  // A known cluster INSIDE "last week" for the temporal-recall scenario.
  psql(`UPDATE working_memory SET created_at = NOW() - INTERVAL '3 days' WHERE project_hash='${h}' AND key LIKE 'LEARNING_%' AND agent_id='orchestrator'`);
  console.log(`done: ${total} facts seeded. hash=${h}`);
  console.log("next: node scripts/recall-size-check.mjs");
}

async function purge() {
  const h = psql(`SELECT project_hash FROM working_memory WHERE key LIKE 'OWNERSHIP_DEV_%' AND agent_id='default' AND value LIKE '%worktree path must resolve%' LIMIT 1`);
  if (/^[0-9a-f]{16}$/.test(h)) {
    console.log(`purging prior ZZ_MATURE data (hash ${h})…`);
    for (const t of ["working_memory", "knowledge_entries", "embeddings", "source_meta", "memory_contradictions_pg"]) {
      try { psql(`DELETE FROM ${t} WHERE project_hash='${h}'`); } catch { /* table may not exist */ }
    }
  }
}

const arg = process.argv[2];
if (arg === "--purge") await purge();
else await seedAll();
