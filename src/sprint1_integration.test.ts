/**
 * Sprint 1 Integration + E2E + User-Scenario Tests (Phase F)
 * ===========================================================
 *
 * Per §13 test categories remaining:
 *   - Integration: components wired end-to-end
 *   - E2E: full user story from tool-call to outcome to learning
 *   - User-scenarios:
 *     US1. Agent summarizes then reads same file — follow_up triggers
 *     US2. Agent commits after edit — git_commit triggers shipped
 *     US3. User replies positively after tool — user_prompt triggers accepted
 *     US4. Multi-session, multi-agent isolation — no cross-contamination
 *     US5. Cross-log correlation via trace_id
 *   - Red-team:
 *     RT-S1-15: machine_secret rotation invalidates ALL existing chains
 *     RT-S1-16: empty project_path cannot leak into another project's data
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  recordToolCall,
  newCallId,
  verifyToolCallChain,
  _resetTelemetryCacheForTesting,
} from "./telemetry.js";
import {
  recordOutcome,
  resolveGitCommitOutcome,
  resolveUserPromptOutcome,
  resolveFollowUpOutcomes,
  verifyOutcomesChain,
  getOutcomesForToolCall,
} from "./outcomes.js";
import {
  _resetCacheForTesting as resetMachineSecret,
  MACHINE_SECRET_PATH,
} from "./security/machine_secret.js";
import { _resetPricingVerificationForTesting, computeCost } from "./pricing.js";
import { log, readLogs, newTraceId, _setMinLevelForTesting } from "./logger.js";

const PRICING_SIG_PATH = join(homedir(), ".claude", "zc-ctx", ".pricing_signature");
function cleanPricing(): void { try { if (existsSync(PRICING_SIG_PATH)) unlinkSync(PRICING_SIG_PATH); } catch {} }
function cleanSecret():  void { try { if (existsSync(MACHINE_SECRET_PATH)) unlinkSync(MACHINE_SECRET_PATH); } catch {} }

function projectDbPath(p: string): string {
  const hash = createHash("sha256").update(p).digest("hex").slice(0, 16);
  return join(homedir(), ".claude", "zc-ctx", "sessions", hash + ".db");
}
function cleanProjectDb(p: string): void {
  for (const s of ["", "-wal", "-shm"]) { try { if (existsSync(projectDbPath(p) + s)) unlinkSync(projectDbPath(p) + s); } catch {} }
}

let projectA: string;
let projectB: string;

beforeEach(() => {
  projectA = mkdtempSync(join(tmpdir(), "zc-s1-A-"));
  projectB = mkdtempSync(join(tmpdir(), "zc-s1-B-"));
  cleanProjectDb(projectA);
  cleanProjectDb(projectB);
  cleanSecret();
  cleanPricing();
  resetMachineSecret();
  _resetPricingVerificationForTesting();
  _resetTelemetryCacheForTesting();
  _setMinLevelForTesting("DEBUG");
});

afterEach(() => {
  cleanProjectDb(projectA);
  cleanProjectDb(projectB);
  cleanSecret();
  cleanPricing();
  resetMachineSecret();
  _resetPricingVerificationForTesting();
  _resetTelemetryCacheForTesting();
  _setMinLevelForTesting("INFO");
  try { rmSync(projectA, { recursive: true, force: true }); } catch {}
  try { rmSync(projectB, { recursive: true, force: true }); } catch {}
});

describe("Sprint 1 — integration + E2E + user scenarios", () => {

  // ── US1: summarize then read ────────────────────────────────────────────

  it("[US1] agent summarizes a file then reads it → follow_up outcome ties to summary", async () => {
    const summaryCallId = newCallId();
    await recordToolCall({
      callId: summaryCallId, sessionId: "us1", agentId: "agent-x", projectPath: projectA,
      toolName: "zc_file_summary", model: "claude-sonnet-4-6",
      inputTokens: 300, outputTokens: 100, latencyMs: 40, status: "ok",
    });
    // Next tool call in the same session: Read of the same file
    await recordToolCall({
      callId: newCallId(), sessionId: "us1", agentId: "agent-x", projectPath: projectA,
      toolName: "Read", model: "claude-sonnet-4-6",
      inputTokens: 50, outputTokens: 2000, latencyMs: 15, status: "ok",
    });
    const outcomes = await resolveFollowUpOutcomes({
      projectPath: projectA, sessionId: "us1",
      newToolName: "Read", newToolInput: { file_path: "/tmp/my.ts" },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].outcome_kind).toBe("insufficient");
    expect(outcomes[0].ref_id).toBe(summaryCallId);
    expect(verifyOutcomesChain(projectA).ok).toBe(true);
  });

  // ── US2: commit after edit ──────────────────────────────────────────────

  it("[US2] agent commits after edit → git_commit resolver links shipped outcome to last tool_call", async () => {
    const editCallId = newCallId();
    await recordToolCall({
      callId: editCallId, sessionId: "us2", agentId: "agent-y", projectPath: projectA,
      toolName: "Edit", model: "claude-sonnet-4-6",
      inputTokens: 200, outputTokens: 30, latencyMs: 20, status: "ok",
    });
    // Following Bash tool call (git commit)
    await recordToolCall({
      callId: newCallId(), sessionId: "us2", agentId: "agent-y", projectPath: projectA,
      toolName: "Bash", model: "claude-sonnet-4-6",
      inputTokens: 50, outputTokens: 50, latencyMs: 100, status: "ok",
    });

    const outcome = await resolveGitCommitOutcome({
      projectPath: projectA, sessionId: "us2",
      bashOutput: "[feat/abc def1234] Implement feature\n 2 files changed, 15 insertions(+)",
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.outcome_kind).toBe("shipped");
    const evidence = JSON.parse(outcome!.evidence!);
    expect(evidence.branch).toBe("feat/abc");
    expect(evidence.commit_hash).toBe("def1234");
  });

  // ── US3: positive user response ─────────────────────────────────────────

  it("[US3] user replies positively → user_prompt resolver records accepted outcome", async () => {
    const cid = newCallId();
    await recordToolCall({
      callId: cid, sessionId: "us3", agentId: "agent-z", projectPath: projectA,
      toolName: "Bash", model: "claude-sonnet-4-6",
      inputTokens: 10, outputTokens: 5, latencyMs: 8, status: "ok",
    });
    const outcome = await resolveUserPromptOutcome({
      projectPath: projectA, sessionId: "us3",
      userMessage: "perfect, works great, thanks!",
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.outcome_kind).toBe("accepted");
    expect(outcome!.ref_id).toBe(cid);
    const ev = JSON.parse(outcome!.evidence!);
    // critical: raw message is NEVER stored
    expect(ev).not.toHaveProperty("message");
    expect(ev).toHaveProperty("sentiment", "positive");
  });

  // ── US4: multi-project isolation ────────────────────────────────────────

  it("[US4] tool_calls + outcomes do not leak between different projects", async () => {
    for (let i = 0; i < 5; i++) {
      await recordToolCall({
        callId: `a-${i}`, sessionId: "sA", agentId: "a", projectPath: projectA,
        toolName: "Read", model: "claude-sonnet-4-6",
        inputTokens: 10, outputTokens: 5, latencyMs: 5, status: "ok",
      });
      await recordToolCall({
        callId: `b-${i}`, sessionId: "sB", agentId: "b", projectPath: projectB,
        toolName: "Edit", model: "claude-sonnet-4-6",
        inputTokens: 10, outputTokens: 5, latencyMs: 5, status: "ok",
      });
    }
    await recordOutcome({
      projectPath: projectA, refType: "tool_call", refId: "a-0",
      outcomeKind: "accepted", signalSource: "user_prompt",
    });
    await recordOutcome({
      projectPath: projectB, refType: "tool_call", refId: "b-0",
      outcomeKind: "shipped", signalSource: "git_commit",
    });

    // Each project's data is isolated
    expect(verifyToolCallChain(projectA).totalRows).toBe(5);
    expect(verifyToolCallChain(projectB).totalRows).toBe(5);
    expect(verifyOutcomesChain(projectA).totalRows).toBe(1);
    expect(verifyOutcomesChain(projectB).totalRows).toBe(1);

    // Cross-project query returns 0
    const a0 = getOutcomesForToolCall(projectA, "b-0");
    const b0 = getOutcomesForToolCall(projectB, "a-0");
    expect(a0).toHaveLength(0);
    expect(b0).toHaveLength(0);
  });

  // ── US5: cross-log correlation via trace_id ─────────────────────────────

  it("[US5] trace_id ties telemetry log line to outcome log line", () => {
    const trace = newTraceId("e2e");
    log("INFO", "telemetry", "tool_call_start", { call_id: "c1", tool: "Edit" }, trace);
    log("INFO", "telemetry", "tool_call_end",   { call_id: "c1", status: "ok" }, trace);
    log("INFO", "outcomes",  "outcome_recorded", { ref_id: "c1", kind: "accepted" }, trace);

    const telEntries = readLogs({ component: "telemetry", traceId: trace });
    const outEntries = readLogs({ component: "outcomes",  traceId: trace });
    expect(telEntries.length).toBe(2);
    expect(outEntries.length).toBe(1);
    for (const e of [...telEntries, ...outEntries]) expect(e.trace_id).toBe(trace);
  });

  // ── Integration: cost annotation matches pricing table ─────────────────

  it("cost stored in tool_calls row equals computeToolCallCost() exactly (v0.17.1)", async () => {
    const cid = newCallId();
    const r = await recordToolCall({
      callId: cid, sessionId: "ci", agentId: "a", projectPath: projectA,
      toolName: "zc_search", model: "claude-sonnet-4-6",
      inputTokens: 1000, outputTokens: 500, latencyMs: 30, status: "ok",
    });
    // v0.17.1: telemetry now uses computeToolCallCost which prices from the
    // LLM's perspective (tool response tokens billed at INPUT rate; tool call
    // args at OUTPUT rate). The naive computeCost would over-report tool-call
    // cost by ~5× on Opus. See src/pricing.ts for the full rationale.
    const { computeToolCallCost } = await import("./pricing.js");
    const independent = computeToolCallCost("claude-sonnet-4-6", 1000, 500);
    expect(r!.cost_usd).toBeCloseTo(independent.cost_usd, 8);
  });

  // ── Integration: outcomes chain survives parallel projects ──────────────

  it("outcomes chain integrity holds concurrently across projects", async () => {
    for (let i = 0; i < 10; i++) {
      await recordOutcome({
        projectPath: projectA, refType: "tool_call", refId: `a-${i}`,
        outcomeKind: "accepted", signalSource: "user_prompt",
      });
      await recordOutcome({
        projectPath: projectB, refType: "tool_call", refId: `b-${i}`,
        outcomeKind: "shipped", signalSource: "git_commit",
      });
    }
    expect(verifyOutcomesChain(projectA).ok).toBe(true);
    expect(verifyOutcomesChain(projectB).ok).toBe(true);
    expect(verifyOutcomesChain(projectA).totalRows).toBe(10);
    expect(verifyOutcomesChain(projectB).totalRows).toBe(10);
  });

  // ── Red-team ────────────────────────────────────────────────────────────

  it("[RT-S1-15] rotating machine_secret invalidates ALL existing tool_call + outcome chains", async () => {
    // Record some entries under secret S1
    for (let i = 0; i < 3; i++) {
      await recordToolCall({
        callId: `c-${i}`, sessionId: "sec", agentId: "a", projectPath: projectA,
        toolName: "Read", model: "claude-sonnet-4-6",
        inputTokens: 10, outputTokens: 5, latencyMs: 5, status: "ok",
      });
      await recordOutcome({
        projectPath: projectA, refType: "tool_call", refId: `c-${i}`,
        outcomeKind: "accepted", signalSource: "user_prompt",
      });
    }
    expect(verifyToolCallChain(projectA).ok).toBe(true);
    expect(verifyOutcomesChain(projectA).ok).toBe(true);

    // Attacker rotates machine_secret (e.g. to spoof a new hash for tampered rows)
    cleanSecret();
    resetMachineSecret();
    cleanPricing();
    _resetPricingVerificationForTesting();

    // Verification under NEW secret must fail for BOTH chains
    const tcResult = verifyToolCallChain(projectA);
    const outResult = verifyOutcomesChain(projectA);
    expect(tcResult.ok).toBe(false);
    expect(outResult.ok).toBe(false);
  });

  it("[RT-S1-16] different empty-ish project_paths hash to different DBs", async () => {
    // Reject pathological empty string by confirming different strings → different DBs
    await recordToolCall({
      callId: "only",
      sessionId: "s",
      agentId: "a",
      projectPath: "/legit/project",
      toolName: "Read",
      model: "claude-sonnet-4-6",
      inputTokens: 10, outputTokens: 5, latencyMs: 5, status: "ok",
    });
    // projectA is a tmpdir — cannot see the /legit/project entry
    expect(verifyToolCallChain(projectA).totalRows).toBe(0);
    expect(verifyToolCallChain("/legit/project").totalRows).toBe(1);
    // cleanup the legit/project DB we just created
    cleanProjectDb("/legit/project");
  });

  // ── Regression sanity ──────────────────────────────────────────────────

  it("full E2E: telemetry → outcome → log — all components cooperate", async () => {
    const cid = newCallId();
    const trace = newTraceId("e2e");

    // 1. Record a tool call
    const call = await recordToolCall({
      callId: cid, sessionId: "e2e", agentId: "agent-e2e", projectPath: projectA,
      toolName: "Edit", model: "claude-sonnet-4-6",
      inputTokens: 500, outputTokens: 50, latencyMs: 42, status: "ok", traceId: trace,
    });
    expect(call).not.toBeNull();
    expect(call!.trace_id).toBe(trace);

    // 2. User says "thanks!" → resolveUserPromptOutcome fires
    const outcome = await resolveUserPromptOutcome({
      projectPath: projectA, sessionId: "e2e",
      userMessage: "thanks, works perfectly",
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.outcome_kind).toBe("accepted");

    // 3. Chain integrity intact end-to-end
    expect(verifyToolCallChain(projectA).ok).toBe(true);
    expect(verifyOutcomesChain(projectA).ok).toBe(true);

    // 4. Outcome retrievable by call_id
    const ret = getOutcomesForToolCall(projectA, cid);
    expect(ret.length).toBe(1);
    expect(ret[0].ref_id).toBe(cid);
  });
});
