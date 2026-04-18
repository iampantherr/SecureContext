/**
 * Tests for src/outcomes.ts — Sprint 1 Phase C
 *
 * Per §13:
 *   - Unit: recordOutcome, resolveGitCommitOutcome, resolveUserPromptOutcome,
 *           resolveFollowUpOutcomes, verifyOutcomesChain, getOutcomesForToolCall
 *   - Integration: chain integrity across multiple outcomes; resolvers integrate
 *     with tool_calls rows written via telemetry.recordToolCall
 *   - Failure-mode: empty inputs, neutral sentiment, no matching call, bad path
 *   - Red-team:
 *       RT-S1-09: tampered outcomes row detected by chain verification
 *       RT-S1-10: chain extends correctly across many outcomes
 *       RT-S1-11: raw user prompt text is NOT persisted in evidence
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  recordOutcome,
  resolveGitCommitOutcome,
  resolveUserPromptOutcome,
  resolveFollowUpOutcomes,
  verifyOutcomesChain,
  getOutcomesForToolCall,
} from "./outcomes.js";
import {
  recordToolCall,
  newCallId,
  _resetTelemetryCacheForTesting,
} from "./telemetry.js";
import {
  _resetCacheForTesting as resetMachineSecret,
  MACHINE_SECRET_PATH,
} from "./security/machine_secret.js";
import { _resetPricingVerificationForTesting } from "./pricing.js";

// pricing baseline is keyed to machine_secret; rotating one invalidates the other.
const PRICING_SIG_PATH = join(homedir(), ".claude", "zc-ctx", ".pricing_signature");
function cleanPricingBaseline(): void {
  try { if (existsSync(PRICING_SIG_PATH)) unlinkSync(PRICING_SIG_PATH); } catch {}
}

let testProject: string;

function projectDbPath(projectPath: string): string {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(homedir(), ".claude", "zc-ctx", "sessions", hash + ".db");
}

function cleanProjectDb(projectPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = projectDbPath(projectPath) + suffix;
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
}

function cleanMachineSecret(): void {
  try { if (existsSync(MACHINE_SECRET_PATH)) unlinkSync(MACHINE_SECRET_PATH); } catch {}
}

/** Seed a tool_call so outcome resolvers have something to reference. */
function seedToolCall(opts: {
  projectPath: string;
  sessionId:   string;
  toolName?:   string;
}): string {
  const callId = newCallId();
  recordToolCall({
    callId,
    sessionId: opts.sessionId,
    agentId:   "agent-x",
    projectPath: opts.projectPath,
    toolName:  opts.toolName ?? "Read",
    model:     "claude-sonnet-4-6",
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 10,
    status:    "ok",
  });
  return callId;
}

beforeEach(() => {
  testProject = mkdtempSync(join(tmpdir(), "zc-out-"));
  cleanProjectDb(testProject);
  cleanMachineSecret();
  cleanPricingBaseline();
  resetMachineSecret();
  _resetPricingVerificationForTesting();
  _resetTelemetryCacheForTesting();
});

afterEach(() => {
  cleanProjectDb(testProject);
  cleanMachineSecret();
  cleanPricingBaseline();
  resetMachineSecret();
  _resetPricingVerificationForTesting();
  _resetTelemetryCacheForTesting();
  try { rmSync(testProject, { recursive: true, force: true }); } catch {}
});

describe("outcomes", () => {

  // ── recordOutcome (unit) ────────────────────────────────────────────────

  it("recordOutcome persists an outcome row with expected shape", () => {
    const callId = seedToolCall({ projectPath: testProject, sessionId: "s1" });
    const r = recordOutcome({
      projectPath:  testProject,
      refType:      "tool_call",
      refId:        callId,
      outcomeKind:  "accepted",
      signalSource: "user_prompt",
      confidence:   0.75,
      evidence:     { note: "looks good" },
    });
    expect(r).not.toBeNull();
    expect(r!.ref_id).toBe(callId);
    expect(r!.outcome_kind).toBe("accepted");
    expect(r!.signal_source).toBe("user_prompt");
    expect(r!.confidence).toBe(0.75);
    expect(r!.outcome_id).toMatch(/^out-/);
    expect(r!.row_hash).toMatch(/^[0-9a-f]{64}$/);
    // First row links to the GENESIS sentinel; later rows link to a 64-char hash
    expect(r!.prev_hash).toMatch(/^(genesis|[0-9a-f]{64})$/);
  });

  it("recordOutcome defaults confidence to 1.0 when not provided", () => {
    const r = recordOutcome({
      projectPath:  testProject,
      refType:      "tool_call",
      refId:        "anyref",
      outcomeKind:  "shipped",
      signalSource: "git_commit",
    });
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe(1.0);
  });

  it("recordOutcome stores null evidence when not provided", () => {
    const r = recordOutcome({
      projectPath:  testProject,
      refType:      "tool_call",
      refId:        "anyref",
      outcomeKind:  "errored",
      signalSource: "manual",
    });
    expect(r!.evidence).toBeNull();
  });

  it("recordOutcome stores scoreDelta when provided", () => {
    const r = recordOutcome({
      projectPath:  testProject,
      refType:      "tool_call",
      refId:        "anyref",
      outcomeKind:  "accepted",
      signalSource: "user_prompt",
      scoreDelta:   0.2,
    });
    expect(r!.score_delta).toBeCloseTo(0.2, 6);
  });

  it("recordOutcome never throws on bad input — returns null", () => {
    // outcome_kind NOT NULL but we force a path that trips the DB -
    // pass null-ish field via cast; must not throw
    const r = recordOutcome({
      projectPath:  testProject,
      refType:      "tool_call",
      refId:        null as unknown as string,   // force DB failure
      outcomeKind:  "accepted",
      signalSource: "user_prompt",
    });
    // Either null (DB rejected) or a record — both are acceptable; no throw
    expect(typeof r === "object").toBe(true);
  });

  // ── resolveGitCommitOutcome ─────────────────────────────────────────────

  it("resolveGitCommitOutcome records shipped outcome when commit hash detected", () => {
    const callId = seedToolCall({
      projectPath: testProject,
      sessionId: "s-git",
      toolName: "Bash",
    });
    const r = resolveGitCommitOutcome({
      projectPath: testProject,
      sessionId:   "s-git",
      bashOutput:  "[main abc1234] Fix typo\n 1 file changed",
    });
    expect(r).not.toBeNull();
    expect(r!.outcome_kind).toBe("shipped");
    expect(r!.signal_source).toBe("git_commit");
    expect(r!.ref_id).toBe(callId);
    expect(r!.confidence).toBeCloseTo(0.95, 2);

    const evidence = JSON.parse(r!.evidence!);
    expect(evidence.commit_hash).toBe("abc1234");
    expect(evidence.branch).toBe("main");
    expect(evidence.session_id).toBe("s-git");
  });

  it("resolveGitCommitOutcome returns null when no commit pattern in output", () => {
    seedToolCall({ projectPath: testProject, sessionId: "s-none" });
    const r = resolveGitCommitOutcome({
      projectPath: testProject,
      sessionId:   "s-none",
      bashOutput:  "nothing to commit, working tree clean",
    });
    expect(r).toBeNull();
  });

  it("resolveGitCommitOutcome returns null when no recent tool_call in session", () => {
    // Valid commit output but no prior tool_call in this session
    const r = resolveGitCommitOutcome({
      projectPath: testProject,
      sessionId:   "s-orphan",
      bashOutput:  "[feat/x deadbeef] Add feature",
    });
    expect(r).toBeNull();
  });

  it("resolveGitCommitOutcome handles full 40-char git hash", () => {
    seedToolCall({ projectPath: testProject, sessionId: "s-40", toolName: "Bash" });
    const r = resolveGitCommitOutcome({
      projectPath: testProject,
      sessionId:   "s-40",
      bashOutput:  "[release-1.0 abcdef1234567890abcdef1234567890abcdef12] Release v1.0",
    });
    expect(r).not.toBeNull();
    const evidence = JSON.parse(r!.evidence!);
    expect(evidence.commit_hash).toBe("abcdef1234567890abcdef1234567890abcdef12");
  });

  // ── resolveUserPromptOutcome ────────────────────────────────────────────

  it("resolveUserPromptOutcome records accepted for positive sentiment", () => {
    const callId = seedToolCall({ projectPath: testProject, sessionId: "s-pos" });
    const r = resolveUserPromptOutcome({
      projectPath: testProject,
      sessionId:   "s-pos",
      userMessage: "thanks, that works perfectly",
    });
    expect(r).not.toBeNull();
    expect(r!.outcome_kind).toBe("accepted");
    expect(r!.ref_id).toBe(callId);
    expect(r!.confidence).toBeCloseTo(0.5, 2);
  });

  it("resolveUserPromptOutcome records rejected for negative sentiment", () => {
    seedToolCall({ projectPath: testProject, sessionId: "s-neg" });
    const r = resolveUserPromptOutcome({
      projectPath: testProject,
      sessionId:   "s-neg",
      userMessage: "no, that's wrong — revert it",
    });
    expect(r).not.toBeNull();
    expect(r!.outcome_kind).toBe("rejected");
  });

  it("resolveUserPromptOutcome returns null for neutral sentiment", () => {
    seedToolCall({ projectPath: testProject, sessionId: "s-neu" });
    const r = resolveUserPromptOutcome({
      projectPath: testProject,
      sessionId:   "s-neu",
      userMessage: "can you also add a test for edge cases",
    });
    expect(r).toBeNull();
  });

  it("resolveUserPromptOutcome returns null for empty message", () => {
    seedToolCall({ projectPath: testProject, sessionId: "s-empty" });
    const r = resolveUserPromptOutcome({
      projectPath: testProject,
      sessionId:   "s-empty",
      userMessage: "",
    });
    expect(r).toBeNull();
  });

  it("resolveUserPromptOutcome returns null when positive AND negative tokens present", () => {
    seedToolCall({ projectPath: testProject, sessionId: "s-mix" });
    const r = resolveUserPromptOutcome({
      projectPath: testProject,
      sessionId:   "s-mix",
      userMessage: "thanks but no, this is wrong",
    });
    expect(r).toBeNull();
  });

  it("[RT-S1-11] resolveUserPromptOutcome NEVER persists raw user message text", () => {
    seedToolCall({ projectPath: testProject, sessionId: "s-priv" });
    const secret = "my-API-KEY-is-sk-proj-abc123xyz-do-not-leak";
    const r = resolveUserPromptOutcome({
      projectPath: testProject,
      sessionId:   "s-priv",
      userMessage: `thanks! ${secret}`,
    });
    expect(r).not.toBeNull();
    expect(r!.evidence).not.toContain(secret);
    expect(r!.evidence).not.toContain("my-API-KEY");
    // Only sentiment + length should be stored
    const evidence = JSON.parse(r!.evidence!);
    expect(evidence).toHaveProperty("sentiment", "positive");
    expect(evidence).toHaveProperty("message_length");
    expect(evidence.message_length).toBe(`thanks! ${secret}`.length);
    expect(Object.keys(evidence).sort()).toEqual(["message_length", "sentiment"]);
  });

  // ── resolveFollowUpOutcomes ─────────────────────────────────────────────

  it("resolveFollowUpOutcomes detects Read after zc_file_summary within window", () => {
    // Seed a zc_file_summary tool_call
    const summaryCallId = newCallId();
    recordToolCall({
      callId: summaryCallId,
      sessionId: "s-fu",
      agentId: "a",
      projectPath: testProject,
      toolName: "zc_file_summary",
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 20,
      status: "ok",
    });

    const outcomes = resolveFollowUpOutcomes({
      projectPath: testProject,
      sessionId:   "s-fu",
      newToolName: "Read",
      newToolInput: { file_path: "/tmp/foo.ts" },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].outcome_kind).toBe("insufficient");
    expect(outcomes[0].signal_source).toBe("follow_up");
    expect(outcomes[0].ref_id).toBe(summaryCallId);
    expect(outcomes[0].confidence).toBeCloseTo(0.85, 2);

    const evidence = JSON.parse(outcomes[0].evidence!);
    expect(evidence.file_path).toBe("/tmp/foo.ts");
    expect(evidence.summary_call_id).toBe(summaryCallId);
    expect(evidence).toHaveProperty("delay_seconds");
  });

  it("resolveFollowUpOutcomes returns [] when new tool is not Read", () => {
    recordToolCall({
      callId: newCallId(),
      sessionId: "s-fu2",
      agentId: "a",
      projectPath: testProject,
      toolName: "zc_file_summary",
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 20,
      status: "ok",
    });
    const outcomes = resolveFollowUpOutcomes({
      projectPath: testProject,
      sessionId:   "s-fu2",
      newToolName: "Bash",
      newToolInput: { command: "ls" },
    });
    expect(outcomes).toHaveLength(0);
  });

  it("resolveFollowUpOutcomes returns [] when no file_path in input", () => {
    const outcomes = resolveFollowUpOutcomes({
      projectPath: testProject,
      sessionId:   "s-fu3",
      newToolName: "Read",
      newToolInput: {},
    });
    expect(outcomes).toHaveLength(0);
  });

  it("resolveFollowUpOutcomes accepts both file_path and path keys", () => {
    recordToolCall({
      callId: newCallId(),
      sessionId: "s-fu4",
      agentId: "a",
      projectPath: testProject,
      toolName: "zc_file_summary",
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 20,
      status: "ok",
    });
    const outcomes = resolveFollowUpOutcomes({
      projectPath: testProject,
      sessionId:   "s-fu4",
      newToolName: "Read",
      newToolInput: { path: "/tmp/bar.ts" },   // alt key
    });
    expect(outcomes).toHaveLength(1);
  });

  it("resolveFollowUpOutcomes returns [] when no prior zc_file_summary in session", () => {
    // Seed only a non-summary call
    seedToolCall({ projectPath: testProject, sessionId: "s-fu5", toolName: "Bash" });
    const outcomes = resolveFollowUpOutcomes({
      projectPath: testProject,
      sessionId:   "s-fu5",
      newToolName: "Read",
      newToolInput: { file_path: "/tmp/x.ts" },
    });
    expect(outcomes).toHaveLength(0);
  });

  // ── getOutcomesForToolCall ──────────────────────────────────────────────

  it("getOutcomesForToolCall returns outcomes in insertion order", () => {
    const callId = seedToolCall({ projectPath: testProject, sessionId: "s-get" });
    recordOutcome({
      projectPath: testProject,
      refType: "tool_call",
      refId: callId,
      outcomeKind: "accepted",
      signalSource: "user_prompt",
    });
    recordOutcome({
      projectPath: testProject,
      refType: "tool_call",
      refId: callId,
      outcomeKind: "shipped",
      signalSource: "git_commit",
    });
    const outcomes = getOutcomesForToolCall(testProject, callId);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].outcome_kind).toBe("accepted");
    expect(outcomes[1].outcome_kind).toBe("shipped");
  });

  it("getOutcomesForToolCall returns [] for unknown call_id", () => {
    const outcomes = getOutcomesForToolCall(testProject, "nope");
    expect(outcomes).toHaveLength(0);
  });

  // ── Integration: chain integrity ────────────────────────────────────────

  it("[RT-S1-10] chain extends correctly across many outcomes", () => {
    for (let i = 0; i < 20; i++) {
      recordOutcome({
        projectPath: testProject,
        refType:     "tool_call",
        refId:       `call-${i}`,
        outcomeKind: i % 2 === 0 ? "accepted" : "rejected",
        signalSource: "user_prompt",
        confidence:  0.5 + (i % 5) * 0.1,
        evidence:    { i },
      });
    }
    const result = verifyOutcomesChain(testProject);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(20);
  });

  it("[RT-S1-09] tampered outcomes row detected by chain verification", () => {
    for (let i = 0; i < 5; i++) {
      recordOutcome({
        projectPath: testProject,
        refType:     "tool_call",
        refId:       `c-${i}`,
        outcomeKind: "accepted",
        signalSource: "user_prompt",
        confidence:  0.5,
      });
    }
    expect(verifyOutcomesChain(testProject).ok).toBe(true);

    // Attacker tampers: flips an "accepted" to "shipped" to inflate shipping rate
    const dbPath = projectDbPath(testProject);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.prepare(`UPDATE outcomes SET outcome_kind = 'shipped' WHERE ref_id = ?`).run("c-2");
    db.close();

    const result = verifyOutcomesChain(testProject);
    expect(result.ok).toBe(false);
    expect(result.brokenKind).toBe("hash-mismatch");
  });

  it("verifyOutcomesChain returns ok=true for empty table", () => {
    const result = verifyOutcomesChain(testProject);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(0);
  });

  it("chain integrity holds when outcomes are interleaved with tool_calls", () => {
    // Record 10 tool_calls with interleaved outcomes — outcomes chain
    // is independent of tool_calls chain; both must verify independently.
    for (let i = 0; i < 10; i++) {
      const cid = seedToolCall({ projectPath: testProject, sessionId: `s-${i}` });
      recordOutcome({
        projectPath: testProject,
        refType:     "tool_call",
        refId:       cid,
        outcomeKind: "accepted",
        signalSource: "user_prompt",
      });
    }
    expect(verifyOutcomesChain(testProject).ok).toBe(true);
    expect(verifyOutcomesChain(testProject).totalRows).toBe(10);
  });

  // ── Integration: resolvers write hash-chained rows ──────────────────────

  it("all three resolvers produce verifiable chained outcomes", () => {
    // git_commit resolver
    seedToolCall({ projectPath: testProject, sessionId: "s-mix-git", toolName: "Bash" });
    resolveGitCommitOutcome({
      projectPath: testProject,
      sessionId:   "s-mix-git",
      bashOutput:  "[main abc1234] Ship feature",
    });

    // user_prompt resolver
    seedToolCall({ projectPath: testProject, sessionId: "s-mix-up" });
    resolveUserPromptOutcome({
      projectPath: testProject,
      sessionId:   "s-mix-up",
      userMessage: "works great, thanks!",
    });

    // follow_up resolver
    recordToolCall({
      callId: newCallId(),
      sessionId: "s-mix-fu",
      agentId: "a",
      projectPath: testProject,
      toolName: "zc_file_summary",
      model: "claude-sonnet-4-6",
      inputTokens: 100, outputTokens: 50, latencyMs: 20, status: "ok",
    });
    resolveFollowUpOutcomes({
      projectPath: testProject,
      sessionId:   "s-mix-fu",
      newToolName: "Read",
      newToolInput: { file_path: "/tmp/q.ts" },
    });

    const result = verifyOutcomesChain(testProject);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(3);
  });

  // ── Performance ─────────────────────────────────────────────────────────

  it("[PERF] recordOutcome p95 latency < 50ms", () => {
    // Warm DB
    recordOutcome({
      projectPath: testProject,
      refType: "tool_call",
      refId: "warm",
      outcomeKind: "accepted",
      signalSource: "user_prompt",
    });

    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = Date.now();
      recordOutcome({
        projectPath: testProject,
        refType: "tool_call",
        refId: `perf-${i}`,
        outcomeKind: "accepted",
        signalSource: "user_prompt",
        confidence: 0.5,
      });
      samples.push(Date.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(50);
  });
});
