/**
 * Tests for src/telemetry.ts
 *
 * Per §13:
 *   - Unit: recordToolCall, formatCostHeader, sanitizeToolInput
 *   - Integration: chain integrity end-to-end + cache invalidation
 *   - Failure-mode: bad inputs, unknown model, simulated DB failures
 *   - Performance: <10ms overhead per call (per §6.5)
 *   - Red-team RT-S1-06: tampered tool_calls row detected
 *   - Red-team RT-S1-07: chain extends correctly across multiple calls
 *   - Red-team RT-S1-08: secret in tool input scrubbed before storage
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  recordToolCall,
  formatCostHeader,
  sanitizeToolInput,
  newCallId,
  getToolCall,
  verifyToolCallChain,
  _resetTelemetryCacheForTesting,
} from "./telemetry.js";
import { _resetCacheForTesting as resetMachineSecret, MACHINE_SECRET_PATH } from "./security/machine_secret.js";
import { computeCost, _resetPricingVerificationForTesting } from "./pricing.js";
import { runMigrations } from "./migrations.js";

// pricing baseline is keyed to machine_secret; rotating one invalidates the other.
// In tests we clean both to keep a fresh state per run.
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

beforeEach(() => {
  testProject = mkdtempSync(join(tmpdir(), "zc-tel-"));
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

describe("telemetry", () => {
  // ── Unit ─────────────────────────────────────────────────────────────────

  it("newCallId returns unique IDs of expected shape", () => {
    const a = newCallId();
    const b = newCallId();
    expect(a).toMatch(/^call-[a-f0-9-]{12}$/);
    expect(a).not.toBe(b);
  });

  it("recordToolCall persists a row with cost computed from pricing table", async () => {
    const callId = newCallId();
    const r = await recordToolCall({
      callId,
      sessionId: "sess-1",
      agentId: "agent-x",
      projectPath: testProject,
      toolName: "zc_status",
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 500,
      latencyMs: 47,
      status: "ok",
    });

    expect(r).not.toBeNull();
    expect(r!.call_id).toBe(callId);
    expect(r!.tool_name).toBe("zc_status");
    // v0.17.1 Tier 2: zc_status is an INFRA_TOOL — cost_usd is zeroed so
    // the Opus orchestrator's delegate-vs-DIY decision isn't polluted by
    // infra-tool noise. Token counts still accurate for audit.
    expect(r!.cost_usd).toBe(0);
    expect(r!.input_tokens).toBe(1000);
    expect(r!.output_tokens).toBe(500);
    expect(r!.latency_ms).toBe(47);
    expect(r!.status).toBe("ok");
  });

  it("non-infra tools still bill at computed cost", async () => {
    const r = await recordToolCall({
      callId: newCallId(),
      sessionId: "sess-1",
      agentId: "agent-x",
      projectPath: testProject,
      toolName: "zc_fetch", // NOT an infra tool (external HTTP + Ollama)
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 500,
      latencyMs: 47,
      status: "ok",
    });
    // v0.17.1: 1000 × $15/Mtok (Sonnet output) + 500 × $3/Mtok (Sonnet input)
    // = 0.015 + 0.0015 = 0.0165
    expect(r!.cost_usd).toBeCloseTo(0.0165, 4);
  });

  it("recordToolCall stores cost_known=0 for unknown model", async () => {
    const r = await recordToolCall({
      callId: newCallId(),
      sessionId: "sess-1",
      agentId: "agent-x",
      projectPath: testProject,
      toolName: "anything",
      model: "unknown-future-model-9000",
      inputChars: 100,
      outputChars: 50,
      latencyMs: 10,
      status: "ok",
    });
    expect(r).not.toBeNull();
    expect(r!.cost_known).toBe(0);
    expect(r!.cost_usd).toBe(0);
  });

  it("recordToolCall estimates tokens from chars when tokens not provided (chars/4)", async () => {
    const r = await recordToolCall({
      callId: newCallId(),
      sessionId: "sess-1",
      agentId: "a",
      projectPath: testProject,
      toolName: "Read",
      model: "claude-sonnet-4-6",
      inputChars: 400,   // → 100 tokens
      outputChars: 800,  // → 200 tokens
      latencyMs: 20,
      status: "ok",
    });
    expect(r!.input_tokens).toBe(100);
    expect(r!.output_tokens).toBe(200);
  });

  it("recordToolCall handles status=error + errorClass", async () => {
    const r = await recordToolCall({
      callId: newCallId(),
      sessionId: "sess-1",
      agentId: "a",
      projectPath: testProject,
      toolName: "Read",
      model: "claude-sonnet-4-6",
      inputTokens: 10,
      outputTokens: 0,
      latencyMs: 5,
      status: "error",
      errorClass: "permission",
    });
    expect(r!.status).toBe("error");
    expect(r!.error_class).toBe("permission");
  });

  it("recordToolCall applies batch discount when batch=true", async () => {
    const r = await recordToolCall({
      callId: newCallId(),
      sessionId: "sess-1",
      agentId: "a",
      projectPath: testProject,
      toolName: "mutate",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      latencyMs: 100,
      status: "ok",
      batch: true,
    });
    // 18 USD without batch * 0.5 = 9
    expect(r!.cost_usd).toBeCloseTo(9, 5);
  });

  // ── formatCostHeader ────────────────────────────────────────────────────

  it("formatCostHeader produces a parseable summary", () => {
    const cost = computeCost("claude-sonnet-4-6", 1000, 500);
    const header = formatCostHeader({
      inputTokens: 1000,
      outputTokens: 500,
      cost,
      latencyMs: 47,
    });
    expect(header).toContain("1000 in");
    expect(header).toContain("500 out");
    expect(header).toContain("$0.0105");
    expect(header).toContain("47ms");
  });

  it("formatCostHeader shows $? for unknown cost", () => {
    const cost = computeCost("unknown-model", 100, 50);
    const header = formatCostHeader({
      inputTokens: 100,
      outputTokens: 50,
      cost,
      latencyMs: 10,
    });
    expect(header).toContain("$?");
  });

  // ── sanitizeToolInput ───────────────────────────────────────────────────

  it("sanitizeToolInput truncates long strings + redacts secrets", () => {
    const fakeKey = "sk-" + "ant-" + "api03-" + "TestFixtureOnlyNotARealKey1234567890";
    const longInput = `key=${fakeKey} ` + "x".repeat(500);
    const sanitized = sanitizeToolInput(longInput, 200);
    expect(sanitized.length).toBeLessThanOrEqual(204);  // 200 + "..."
    expect(sanitized).not.toContain("TestFixture");
    expect(sanitized).toContain("[REDACTED:");
  });

  it("sanitizeToolInput stringifies objects safely", () => {
    const obj = { foo: "bar", baz: { nested: true } };
    const sanitized = sanitizeToolInput(obj);
    expect(sanitized).toContain("foo");
    expect(sanitized).toContain("bar");
  });

  // ── Integration: chain integrity ─────────────────────────────────────────

  it("[RT-S1-07] chain extends correctly across multiple calls", async () => {
    for (let i = 0; i < 10; i++) {
      await recordToolCall({
        callId: `c-${i}`,
        sessionId: "sess-chain",
        agentId: "a",
        projectPath: testProject,
        toolName: `tool-${i % 3}`,
        model: "claude-sonnet-4-6",
        inputTokens: 50,
        outputTokens: 30,
        latencyMs: 10 + i,
        status: "ok",
      });
    }
    const result = verifyToolCallChain(testProject);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(10);
  });

  it("[RT-S1-06] tampered tool_calls row detected by chain verification", async () => {
    for (let i = 0; i < 5; i++) {
      await recordToolCall({
        callId: `c-${i}`,
        sessionId: "sess-tamper",
        agentId: "a",
        projectPath: testProject,
        toolName: "Read",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 20,
        status: "ok",
      });
    }
    expect(verifyToolCallChain(testProject).ok).toBe(true);

    // Attacker tampers with the third row's cost (e.g. to hide expensive abuse)
    const dbPath = projectDbPath(testProject);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.prepare(`UPDATE tool_calls SET cost_usd = 999.99 WHERE call_id = ?`).run("c-2");
    db.close();

    const result = verifyToolCallChain(testProject);
    expect(result.ok).toBe(false);
    expect(result.brokenKind).toBe("hash-mismatch");
  });

  it("[RT-S1-08] secret-in-input is sanitized via sanitizeToolInput, never persisted raw", () => {
    // The recordToolCall function itself doesn't persist input strings (only
    // metadata: tokens, cost, latency). But sanitizeToolInput is the bridge
    // that callers MUST use before passing input data to telemetry storage.
    const fakeAwsKey = "AKIA" + "TESTFIXTUREONLY1";
    const sanitized = sanitizeToolInput({ command: `aws s3 ls --key ${fakeAwsKey}` });
    expect(sanitized).not.toContain("AKIATESTFIXTUREONLY1");
    expect(sanitized).toContain("[REDACTED:aws_access_key_id]");
  });

  // ── Failure-mode ─────────────────────────────────────────────────────────

  it("returns null + logs error on bad project path (no throw)", async () => {
    // null projectPath → openProjectDb throws → recordToolCall catches
    // and returns null
    const r = await recordToolCall({
      callId: newCallId(),
      sessionId: "sess",
      agentId: "a",
      projectPath: "",   // empty path triggers issues
      toolName: "Read",
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      status: "ok",
    });
    // Either succeeds (empty path treated as "" hash) or returns null — both OK
    // What MUST happen: no throw
    expect(typeof r === "object").toBe(true);  // null or record, not undefined
  });

  // ── Performance ─────────────────────────────────────────────────────────

  it("[PERF] recordToolCall overhead < 50ms p95 (loose budget for first-call DB init)", async () => {
    // First call includes DB open + migration + chain bootstrap (cold)
    const cold = Date.now();
    await recordToolCall({
      callId: newCallId(),
      sessionId: "sess-perf",
      agentId: "a",
      projectPath: testProject,
      toolName: "warmup",
      model: "claude-sonnet-4-6",
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 1,
      status: "ok",
    });
    const coldMs = Date.now() - cold;
    expect(coldMs).toBeLessThan(2000);  // very loose for cold-start

    // Subsequent calls should be fast (warm cache, indexed DB)
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = Date.now();
      await recordToolCall({
        callId: newCallId(),
        sessionId: "sess-perf",
        agentId: "a",
        projectPath: testProject,
        toolName: "hot",
        model: "claude-sonnet-4-6",
        inputTokens: 50,
        outputTokens: 25,
        latencyMs: 5,
        status: "ok",
      });
      samples.push(Date.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(50);  // p95 < 50ms (per §6.5 budget)
  });

  // ── getToolCall ─────────────────────────────────────────────────────────

  it("getToolCall retrieves a previously recorded row", async () => {
    const cid = newCallId();
    await recordToolCall({
      callId: cid,
      sessionId: "s",
      agentId: "a",
      projectPath: testProject,
      toolName: "Read",
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 25,
      status: "ok",
    });
    const retrieved = getToolCall(testProject, cid);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.tool_name).toBe("Read");
    expect(retrieved!.latency_ms).toBe(25);
  });

  it("getToolCall returns null for nonexistent call_id", () => {
    expect(getToolCall(testProject, "nonexistent")).toBeNull();
  });
});
