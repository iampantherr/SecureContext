/**
 * Live E2E against compiled dist/ — Sprint 1 v0.11.0 real-pipeline proof
 *
 * Uses the actual build, actual ~/.claude/zc-ctx/ paths, actual machine_secret,
 * actual HMAC chain, actual migrations. Simulates what happens when an MCP
 * server running Sprint 1 code handles a real session of tool calls + outcomes.
 *
 * Purpose: prove the end-to-end pipeline works against REAL disk state. Once
 * a fresh Claude Code session spawns an MCP server from the current dist/,
 * everything validated here will fire automatically.
 *
 * Scenarios exercised:
 *   1. Agent starts a session (record 5 varied tool_calls)
 *   2. Agent summarizes a file then reads it — follow_up resolver triggers
 *   3. Agent edits a file then commits — git_commit resolver triggers
 *   4. User says "thanks!" — user_prompt resolver triggers
 *   5. Agent writes to learnings/*.jsonl — learnings-indexer hook mirrors
 *   6. Chain verification on both tool_calls and outcomes
 *   7. zc_logs read of telemetry + outcomes components
 *
 * Each step prints PASS/FAIL. Final summary = green iff every step PASS.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  recordToolCall,
  newCallId,
  verifyToolCallChain,
  formatCostHeader,
} from "../dist/telemetry.js";
import {
  recordOutcome,
  resolveGitCommitOutcome,
  resolveUserPromptOutcome,
  resolveFollowUpOutcomes,
  verifyOutcomesChain,
  getOutcomesForToolCall,
} from "../dist/outcomes.js";
import { readLogs, log, _setMinLevelForTesting } from "../dist/logger.js";
import { computeCost } from "../dist/pricing.js";

const SESSION = "live-e2e-" + Date.now();
const AGENT   = "live-agent";
const PROJECT = join(tmpdir(), "zc-live-e2e-" + Date.now());

const HOOK_LEARNINGS = join(homedir(), ".claude", "hooks", "learnings-indexer.mjs");
const HOOK_POSTTOOL  = join(homedir(), ".claude", "hooks", "posttool-outcomes.mjs");
const HOOK_PROMPT    = join(homedir(), ".claude", "hooks", "userpromptsubmit-outcome.mjs");

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

function section(title) {
  console.log(`\n━━━ ${title} ${"━".repeat(Math.max(0, 65 - title.length))}`);
}

function projectDbPath(p) {
  const hash = createHash("sha256").update(p).digest("hex").slice(0, 16);
  return join(homedir(), ".claude", "zc-ctx", "sessions", hash + ".db");
}

function cleanup() {
  // Remove the isolated live-e2e DB and project dir
  const p = projectDbPath(PROJECT);
  for (const sfx of ["", "-wal", "-shm"]) {
    try { if (existsSync(p + sfx)) rmSync(p + sfx, { force: true }); } catch {}
  }
  try { if (existsSync(PROJECT)) rmSync(PROJECT, { recursive: true, force: true }); } catch {}
}

async function main() {
  console.log("Live E2E — Sprint 1 v0.11.0 pipeline against compiled dist/");
  console.log("Project: " + PROJECT);
  console.log("DB:      " + projectDbPath(PROJECT));

  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(join(PROJECT, "learnings"), { recursive: true });
  _setMinLevelForTesting("DEBUG");

  // ── Step 1. Record 5 varied tool_calls ──────────────────────────────
  section("Step 1. Record varied tool_calls");
  const callIds = [];
  const scenarios = [
    { tool: "zc_file_summary", model: "claude-sonnet-4-6", inTok: 300, outTok: 80, lat: 40 },
    { tool: "Read",            model: "claude-sonnet-4-6", inTok: 50,  outTok: 1200, lat: 15 },
    { tool: "Edit",            model: "claude-sonnet-4-6", inTok: 500, outTok: 60,  lat: 22 },
    { tool: "Bash",            model: "claude-sonnet-4-6", inTok: 100, outTok: 200, lat: 180 },
    { tool: "zc_search",       model: "claude-opus-4-7",   inTok: 400, outTok: 300, lat: 65 },
  ];
  for (const s of scenarios) {
    const cid = newCallId();
    callIds.push({ cid, tool: s.tool });
    const r = recordToolCall({
      callId: cid, sessionId: SESSION, agentId: AGENT, projectPath: PROJECT,
      toolName: s.tool, model: s.model,
      inputTokens: s.inTok, outputTokens: s.outTok,
      latencyMs: s.lat, status: "ok",
    });
    check(`recordToolCall(${s.tool}) → row`, r !== null);
    if (r) {
      check(`  ${s.tool} cost > 0`, r.cost_usd > 0);
      check(`  ${s.tool} cost_known=1`, r.cost_known === 1);
      check(`  ${s.tool} chain hashes present`, r.prev_hash.length > 0 && r.row_hash.length === 64);
    }
  }

  // ── Step 2. formatCostHeader is parseable ──────────────────────────
  section("Step 2. Cost header format");
  const cost = computeCost("claude-sonnet-4-6", 1000, 500);
  const header = formatCostHeader({ inputTokens: 1000, outputTokens: 500, cost, latencyMs: 47 });
  check("header contains token counts", /1000 in, 500 out/.test(header));
  check("header contains USD amount", /\$0\.0105/.test(header), header);
  check("header contains latency", /47ms/.test(header));

  // ── Step 3. Chain integrity on live-written rows ───────────────────
  section("Step 3. Chain verification on live-written tool_calls");
  const tc = verifyToolCallChain(PROJECT);
  check("tool_calls chain ok", tc.ok, `${tc.totalRows} rows`);
  check("tool_calls has 5 rows", tc.totalRows === 5);

  // ── Step 4. Follow-up resolver ─────────────────────────────────────
  section("Step 4. Follow-up resolver (summary → Read)");
  const fu = resolveFollowUpOutcomes({
    projectPath: PROJECT, sessionId: SESSION,
    newToolName: "Read", newToolInput: { file_path: "/tmp/example.ts" },
  });
  check("follow_up returned 1 outcome", fu.length === 1, fu.length + " outcomes");
  if (fu.length) {
    check("follow_up kind=insufficient", fu[0].outcome_kind === "insufficient");
    check("follow_up links to zc_file_summary call", fu[0].ref_id === callIds[0].cid);
    check("follow_up confidence=0.85", Math.abs(fu[0].confidence - 0.85) < 0.001);
  }

  // ── Step 5. Git commit resolver ────────────────────────────────────
  section("Step 5. Git commit resolver (Bash output detection)");
  const gc = resolveGitCommitOutcome({
    projectPath: PROJECT, sessionId: SESSION,
    bashOutput: "[main abc1234] E2E test commit\n 2 files changed, 15 insertions(+)",
  });
  check("git_commit returned outcome", gc !== null);
  if (gc) {
    check("git_commit kind=shipped", gc.outcome_kind === "shipped");
    check("git_commit links to most recent call (zc_search)", gc.ref_id === callIds[4].cid);
    const ev = JSON.parse(gc.evidence);
    check("git_commit evidence has commit_hash", ev.commit_hash === "abc1234");
    check("git_commit evidence has branch=main", ev.branch === "main");
  }

  // ── Step 6. User prompt resolver ───────────────────────────────────
  section("Step 6. User prompt resolver (positive sentiment)");
  const up = resolveUserPromptOutcome({
    projectPath: PROJECT, sessionId: SESSION,
    userMessage: "thanks, that works perfectly!",
  });
  check("user_prompt returned outcome", up !== null);
  if (up) {
    check("user_prompt kind=accepted", up.outcome_kind === "accepted");
    check("user_prompt confidence=0.5", Math.abs(up.confidence - 0.5) < 0.001);
    const ev = JSON.parse(up.evidence);
    check("user_prompt evidence has sentiment", ev.sentiment === "positive");
    check("user_prompt evidence does NOT contain raw text", !JSON.stringify(ev).includes("thanks"));
  }

  // ── Step 7. Outcomes chain verify ──────────────────────────────────
  section("Step 7. Outcomes chain verification");
  const oc = verifyOutcomesChain(PROJECT);
  check("outcomes chain ok", oc.ok, `${oc.totalRows} rows`);
  check("3 outcomes recorded", oc.totalRows === 3);

  // ── Step 8. Learnings-indexer hook ─────────────────────────────────
  section("Step 8. learnings-indexer hook fires + mirrors JSONL");
  const learningsFile = join(PROJECT, "learnings", "metrics.jsonl");
  writeFileSync(
    learningsFile,
    `{"metric":"pass_rate","value":0.95,"session":"${SESSION}"}\n` +
    `{"metric":"cycle_time_ms","value":12500,"session":"${SESSION}"}\n`
  );
  const hookResult = spawnSync("node", [HOOK_LEARNINGS], {
    input: JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: learningsFile },
      cwd: PROJECT,
    }),
    encoding: "utf8",
    timeout: 10_000,
  });
  check("hook exit=0", hookResult.status === 0, `status=${hookResult.status}`);

  // Verify mirror
  const db = new DatabaseSync(projectDbPath(PROJECT));
  const learnings = db.prepare(
    `SELECT category, payload, source_path, source_line FROM learnings ORDER BY source_line`
  ).all();
  db.close();
  check("learnings rows = 2", learnings.length === 2);
  if (learnings.length === 2) {
    check("category=metric", learnings[0].category === "metric");
    check("source_path=learnings/metrics.jsonl", learnings[0].source_path === "learnings/metrics.jsonl");
    check("payload preserves JSON", JSON.parse(learnings[0].payload).metric === "pass_rate");
  }

  // ── Step 9. posttool-outcomes hook (simulated Bash call with git commit) ──
  section("Step 9. posttool-outcomes hook fires resolver on Bash event");
  const oc_before = verifyOutcomesChain(PROJECT).totalRows;
  const postBash = spawnSync("node", [HOOK_POSTTOOL], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'feature'" },
      tool_response: { stdout: "[feat/x deadbeef] Add feature\n 1 file changed", exit_code: 0 },
      cwd: PROJECT,
    }),
    encoding: "utf8",
    timeout: 10_000,
  });
  check("posttool hook exit=0", postBash.status === 0);
  const oc_after = verifyOutcomesChain(PROJECT).totalRows;
  check("outcomes grew by 1 after hook", oc_after === oc_before + 1, `before=${oc_before} after=${oc_after}`);

  // ── Step 10. userpromptsubmit-outcome hook ─────────────────────────
  section("Step 10. userpromptsubmit-outcome hook");
  const oc_before2 = verifyOutcomesChain(PROJECT).totalRows;
  const promptHook = spawnSync("node", [HOOK_PROMPT], {
    input: JSON.stringify({
      prompt: "that's perfect, thanks so much!",
      cwd: PROJECT,
    }),
    encoding: "utf8",
    timeout: 10_000,
  });
  check("prompt hook exit=0", promptHook.status === 0);
  const oc_after2 = verifyOutcomesChain(PROJECT).totalRows;
  check("outcomes grew by 1 after prompt hook", oc_after2 === oc_before2 + 1,
        `before=${oc_before2} after=${oc_after2}`);

  // ── Step 11. Logger files written ──────────────────────────────────
  section("Step 11. Logger output on disk");
  const today = new Date().toISOString().slice(0, 10);
  const logDir = join(homedir(), ".claude", "zc-ctx", "logs");
  const telLog = join(logDir, `telemetry.${today}.log`);
  const outLog = join(logDir, `outcomes.${today}.log`);
  check("telemetry log file exists", existsSync(telLog));
  check("outcomes log file exists", existsSync(outLog));
  if (existsSync(telLog)) {
    const size = statSync(telLog).size;
    check("telemetry log non-empty", size > 0, `${size} bytes`);
  }

  // ── Step 12. readLogs returns our entries ─────────────────────────
  section("Step 12. readLogs() query");
  const telEntries = readLogs({ component: "telemetry", minLevel: "DEBUG", limit: 200 });
  const outEntries = readLogs({ component: "outcomes",  minLevel: "DEBUG", limit: 200 });
  check("readLogs(telemetry) returned entries", telEntries.length > 0, `${telEntries.length} entries`);
  check("readLogs(outcomes) returned entries", outEntries.length > 0, `${outEntries.length} entries`);
  const hasOurEvent = telEntries.some((e) => e.event === "tool_call_recorded");
  check("telemetry log contains tool_call_recorded events", hasOurEvent);

  // ── Step 13. getOutcomesForToolCall retrieval ──────────────────────
  section("Step 13. getOutcomesForToolCall lookup");
  const retrievedForSummary = getOutcomesForToolCall(PROJECT, callIds[0].cid);
  const retrievedForSearch  = getOutcomesForToolCall(PROJECT, callIds[4].cid);
  check("outcomes for summary call found", retrievedForSummary.length >= 1);
  check("outcomes for search call found",  retrievedForSearch.length  >= 1);

  // ── Summary ────────────────────────────────────────────────────────
  section("Summary");
  console.log(`  PASS: ${pass}`);
  console.log(`  FAIL: ${fail}`);
  if (failures.length) {
    console.log("\n  Failures:");
    for (const f of failures) console.log("    - " + f);
  }

  cleanup();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nFAIL (unhandled):", e);
  cleanup();
  process.exit(1);
});
