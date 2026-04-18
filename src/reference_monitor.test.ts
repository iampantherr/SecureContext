/**
 * Tests for v0.12.1 Reference Monitor (Tier 2).
 *
 * Validates the HTTP API enforcement point for telemetry writes:
 *   - /api/v1/telemetry/tool_call requires Authorization: Bearer <session_token>
 *   - The token's bound agent_id MUST match body.agentId (cross-agent forgery blocked)
 *   - Same for /api/v1/telemetry/outcome (with token-presence check; no per-row agent)
 *
 * Red-team IDs:
 *   RT-S2-02: agent A holding token-A cannot POST a row claiming agent B
 *   RT-S2-03: a missing/malformed Authorization header gets 401
 *   RT-S2-04: a revoked token gets 401
 *   RT-S2-05: a token from project X cannot write to project Y
 *   RT-S2-06: end-to-end via the client helper recordToolCallViaApi
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createApiServer } from "./api-server.js";
import { issueToken, revokeToken } from "./access-control.js";
import type { FastifyInstance as _FI } from "fastify";
import { runMigrations } from "./migrations.js";
import {
  _resetCacheForTesting as resetMachineSecret,
  MACHINE_SECRET_PATH,
} from "./security/machine_secret.js";
import { _resetPricingVerificationForTesting } from "./pricing.js";
import { _resetTelemetryCacheForTesting, newCallId } from "./telemetry.js";
import {
  recordToolCallViaApi,
  _resetSessionTokenCacheForTesting,
} from "./telemetry_client.js";
const PRICING_SIG_PATH = join(homedir(), ".claude", "zc-ctx", ".pricing_signature");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverApp: any;
let port: number;
let baseUrl: string;
let projectA: string;
let projectB: string;
let testApiKey: string;

function projectDbPath(p: string): string {
  const hash = createHash("sha256").update(p).digest("hex").slice(0, 16);
  return join(homedir(), ".claude", "zc-ctx", "sessions", hash + ".db");
}

function cleanProjectDb(p: string): void {
  for (const sfx of ["", "-wal", "-shm"]) {
    try { if (existsSync(projectDbPath(p) + sfx)) unlinkSync(projectDbPath(p) + sfx); } catch {}
  }
}

function cleanPricingBaseline(): void {
  try { if (existsSync(PRICING_SIG_PATH)) unlinkSync(PRICING_SIG_PATH); } catch {}
}

function cleanMachineSecret(): void {
  try { if (existsSync(MACHINE_SECRET_PATH)) unlinkSync(MACHINE_SECRET_PATH); } catch {}
}

/**
 * Issue a session_token directly against the project DB (bypassing the API)
 * so we can construct test scenarios with controlled tokens.
 */
function mintTokenForTest(projectPath: string, agentId: string, role: string): string {
  const dbPath = projectDbPath(projectPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  const token = issueToken(db, projectPath, agentId, role as never);
  db.close();
  return token;
}

beforeAll(async () => {
  // Start a local fastify instance on a random port for these tests
  port = 13099 + Math.floor(Math.random() * 1000);
  testApiKey = randomBytes(32).toString("hex");
  process.env.ZC_API_KEY = testApiKey;
  baseUrl = `http://localhost:${port}`;
  process.env.ZC_API_URL = baseUrl;  // tell telemetry_client where to find us

  const { app } = await createApiServer();
  await new Promise<void>((resolve, reject) => {
    app.listen({ port, host: "127.0.0.1" }, (err) => err ? reject(err) : resolve());
  });
  serverApp = app;
});

afterAll(async () => {
  try { await serverApp.close(); } catch {}
  delete process.env.ZC_API_KEY;
  delete process.env.ZC_API_URL;
});

beforeEach(() => {
  projectA = mkdtempSync(join(tmpdir(), "zc-rm-A-"));
  projectB = mkdtempSync(join(tmpdir(), "zc-rm-B-"));
  cleanProjectDb(projectA);
  cleanProjectDb(projectB);
  cleanMachineSecret();
  cleanPricingBaseline();
  resetMachineSecret();
  _resetPricingVerificationForTesting();
  _resetTelemetryCacheForTesting();
  _resetSessionTokenCacheForTesting();
});

afterEach(() => {
  cleanProjectDb(projectA);
  cleanProjectDb(projectB);
  cleanMachineSecret();
  cleanPricingBaseline();
  resetMachineSecret();
  _resetPricingVerificationForTesting();
  _resetTelemetryCacheForTesting();
  _resetSessionTokenCacheForTesting();
  try { rmSync(projectA, { recursive: true, force: true }); } catch {}
  try { rmSync(projectB, { recursive: true, force: true }); } catch {}
});

describe("Reference Monitor — telemetry endpoints", () => {

  // ── Happy path ─────────────────────────────────────────────────────────

  it("POST /api/v1/telemetry/tool_call with valid token + matching agentId succeeds", async () => {
    const aliceToken = mintTokenForTest(projectA, "alice", "developer");
    const callId = newCallId();
    const res = await fetch(`${baseUrl}/api/v1/telemetry/tool_call`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({
        projectPath: projectA, callId, sessionId: "s1", agentId: "alice",
        toolName: "Read", model: "claude-sonnet-4-6",
        inputTokens: 50, outputTokens: 25, latencyMs: 5, status: "ok",
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; record?: { call_id?: string } };
    expect(json.ok).toBe(true);
    expect(json.record?.call_id).toBe(callId);
  });

  it("POST /api/v1/telemetry/outcome with valid token succeeds", async () => {
    const orchToken = mintTokenForTest(projectA, "orchestrator", "orchestrator");
    const res = await fetch(`${baseUrl}/api/v1/telemetry/outcome`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${orchToken}`,
      },
      body: JSON.stringify({
        projectPath: projectA,
        refType: "tool_call", refId: "fake-call-1",
        outcomeKind: "accepted", signalSource: "user_prompt",
        confidence: 0.5, evidence: { sentiment: "positive" },
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; record?: { outcome_kind?: string } };
    expect(json.ok).toBe(true);
    expect(json.record?.outcome_kind).toBe("accepted");
  });

  // ── RT-S2-02: cross-agent forgery via API ─────────────────────────────

  it("[RT-S2-02] alice's token cannot write a row claiming bob — 403", async () => {
    const aliceToken = mintTokenForTest(projectA, "alice", "developer");
    const res = await fetch(`${baseUrl}/api/v1/telemetry/tool_call`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({
        projectPath: projectA, callId: newCallId(), sessionId: "s2",
        agentId: "bob",   // ← forgery attempt
        toolName: "Edit", model: "claude-sonnet-4-6",
        inputTokens: 100, outputTokens: 5, latencyMs: 10, status: "ok",
      }),
    });
    expect(res.status).toBe(403);
    const json = await res.json() as { error?: string };
    expect(json.error).toMatch(/Agent ID mismatch/i);
    expect(json.error).toMatch(/cross-agent forgery blocked/i);
  });

  // ── RT-S2-03: missing/malformed Auth header ──────────────────────────

  it("[RT-S2-03] missing Authorization header is rejected with 401", async () => {
    const res = await fetch(`${baseUrl}/api/v1/telemetry/tool_call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: projectA, callId: newCallId(), sessionId: "s",
        agentId: "alice", toolName: "Read", model: "claude-sonnet-4-6",
        inputTokens: 1, outputTokens: 1, latencyMs: 1, status: "ok",
      }),
    });
    expect(res.status).toBe(401);
    const json = await res.json() as { error?: string };
    expect(json.error).toMatch(/Missing or malformed Authorization header/i);
  });

  it("[RT-S2-03] malformed Authorization header (no Bearer prefix) is rejected with 401", async () => {
    const aliceToken = mintTokenForTest(projectA, "alice", "developer");
    const res = await fetch(`${baseUrl}/api/v1/telemetry/tool_call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": aliceToken,  // missing "Bearer " prefix
      },
      body: JSON.stringify({
        projectPath: projectA, callId: newCallId(), sessionId: "s",
        agentId: "alice", toolName: "Read", model: "claude-sonnet-4-6",
        inputTokens: 1, outputTokens: 1, latencyMs: 1, status: "ok",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("[RT-S2-03] empty Bearer is rejected with 401", async () => {
    const res = await fetch(`${baseUrl}/api/v1/telemetry/tool_call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer ",
      },
      body: JSON.stringify({
        projectPath: projectA, callId: newCallId(), sessionId: "s",
        agentId: "alice", toolName: "Read", model: "claude-sonnet-4-6",
        inputTokens: 1, outputTokens: 1, latencyMs: 1, status: "ok",
      }),
    });
    expect(res.status).toBe(401);
  });

  // ── RT-S2-04: revoked token ──────────────────────────────────────────

  it("[RT-S2-04] a revoked token is rejected with 401", async () => {
    const aliceToken = mintTokenForTest(projectA, "alice", "developer");

    // Revoke directly in the DB
    const dbPath = projectDbPath(projectA);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    // Get the token_id from the token (zcst.<payload>.<sig> — payload is base64 JSON)
    const parts = aliceToken.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    revokeToken(db, payload.tid);
    db.close();

    const res = await fetch(`${baseUrl}/api/v1/telemetry/tool_call`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({
        projectPath: projectA, callId: newCallId(), sessionId: "s",
        agentId: "alice", toolName: "Read", model: "claude-sonnet-4-6",
        inputTokens: 1, outputTokens: 1, latencyMs: 1, status: "ok",
      }),
    });
    expect(res.status).toBe(401);
    const json = await res.json() as { error?: string };
    expect(json.error).toMatch(/invalid|expired|revoked/i);
  });

  // ── RT-S2-05: cross-project token ────────────────────────────────────

  it("[RT-S2-05] a token from project A cannot write to project B", async () => {
    const aliceTokenForA = mintTokenForTest(projectA, "alice", "developer");

    const res = await fetch(`${baseUrl}/api/v1/telemetry/tool_call`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${aliceTokenForA}`,
      },
      body: JSON.stringify({
        projectPath: projectB,   // ← different project
        callId: newCallId(), sessionId: "s",
        agentId: "alice", toolName: "Read", model: "claude-sonnet-4-6",
        inputTokens: 1, outputTokens: 1, latencyMs: 1, status: "ok",
      }),
    });
    expect(res.status).toBe(401);
    // verifyToken returns null when project_hash doesn't match (Chapter 11 — scoped capability)
  });

  // ── RT-S2-06: end-to-end via client helper ───────────────────────────

  it("[RT-S2-06] recordToolCallViaApi succeeds end-to-end with valid token", async () => {
    const aliceToken = mintTokenForTest(projectA, "alice", "developer");
    const callId = newCallId();
    const r = await recordToolCallViaApi(
      {
        callId, sessionId: "s-e2e", agentId: "alice",
        projectPath: projectA, toolName: "zc_search",
        model: "claude-sonnet-4-6",
        inputTokens: 200, outputTokens: 80, latencyMs: 30, status: "ok",
      },
      aliceToken,
    );
    expect(r).not.toBeNull();
    expect(r!.call_id).toBe(callId);

    // And the row really landed in the DB (via Reference Monitor)
    const dbPath = projectDbPath(projectA);
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT call_id, agent_id, tool_name FROM tool_calls WHERE call_id = ?").get(callId) as { call_id: string; agent_id: string; tool_name: string };
    db.close();
    expect(row).toBeDefined();
    expect(row.agent_id).toBe("alice");
    expect(row.tool_name).toBe("zc_search");
  });

  it("recordToolCallViaApi returns null on cross-agent forgery (server returns 403)", async () => {
    const aliceToken = mintTokenForTest(projectA, "alice", "developer");
    const r = await recordToolCallViaApi(
      {
        callId: newCallId(), sessionId: "s-forge", agentId: "bob",
        projectPath: projectA, toolName: "Edit",
        model: "claude-sonnet-4-6",
        inputTokens: 10, outputTokens: 5, latencyMs: 5, status: "ok",
      },
      aliceToken,
    );
    expect(r).toBeNull();
  });
});

// Note: startServer is the runtime entry point of api-server.ts. We need
// to expose it — see the import. If it's not exported, that's a 1-line
// addition.
