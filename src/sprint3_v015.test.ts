/**
 * Tests for Sprint 3 v0.15.0:
 *   - §8.1 Structured ASSIGN broadcast schema (additive, backward-compat)
 *   - §8.6 T3.2 MAC-style classification labels on outcomes (SQLite filter)
 *
 * Per HARNESS_EVOLUTION_PLAN.md §13 "Sprint 3 explicit test inventory":
 *   - Unit: each new field round-trips through INSERT + SELECT
 *   - Edge cases: legacy ASSIGN without new fields still works (back-compat),
 *     malformed values coerced safely, oversize inputs truncated/dropped
 *   - Real user use cases: dispatcher consumes structured ASSIGN; agent A
 *     can't read agent B's restricted user-prompt outcomes
 *   - Red-team:
 *     RT-S3-02 (T3.2): cross-agent read of 'restricted' outcome blocked
 *     RT-S3-03 (T3.2): legacy rows (UNKNOWN classification) treated as 'internal'
 *     RT-S3-04 (8.1): SQL injection via complexity_estimate blocked by CHECK
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { broadcastFact } from "./memory.js";
import { Config } from "./config.js";
import {
  recordOutcome,
  resolveUserPromptOutcome,
  resolveGitCommitOutcome,
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

const PRICING_SIG_PATH = join(homedir(), ".claude", "zc-ctx", ".pricing_signature");

let testProject: string;

function dbPath(p: string) {
  const h = createHash("sha256").update(p).digest("hex").slice(0, 16);
  return join(homedir(), ".claude", "zc-ctx", "sessions", h + ".db");
}
function clean(p: string) {
  for (const sfx of ["", "-wal", "-shm"]) try { if (existsSync(dbPath(p) + sfx)) unlinkSync(dbPath(p) + sfx); } catch {}
}
function cleanPricing() { try { if (existsSync(PRICING_SIG_PATH)) unlinkSync(PRICING_SIG_PATH); } catch {} }
function cleanSecret()  { try { if (existsSync(MACHINE_SECRET_PATH)) unlinkSync(MACHINE_SECRET_PATH); } catch {} }

beforeEach(() => {
  testProject = mkdtempSync(join(tmpdir(), "zc-s3-"));
  clean(testProject);
  cleanSecret();
  cleanPricing();
  resetMachineSecret();
  _resetPricingVerificationForTesting();
  _resetTelemetryCacheForTesting();
  // Disable RBAC enforcement so broadcast tests don't need to mint tokens
  // — we're testing field schema, not auth. (RBAC is exercised in
  // access-control.test.ts already.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Config as any).RBAC_ENFORCE = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Config as any).CHANNEL_KEY_REQUIRED = false;
});

afterEach(() => {
  clean(testProject);
  cleanSecret();
  cleanPricing();
  resetMachineSecret();
  _resetPricingVerificationForTesting();
  _resetTelemetryCacheForTesting();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Config as any).RBAC_ENFORCE = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Config as any).CHANNEL_KEY_REQUIRED = true;
  try { rmSync(testProject, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────
// §8.1 — Structured ASSIGN broadcast schema
// ─────────────────────────────────────────────────────────────────────────

describe("Sprint 3 §8.1 — structured ASSIGN broadcast schema", () => {

  it("[user case] agent posts a fully-structured ASSIGN; all fields round-trip", () => {
    const r = broadcastFact(testProject, "ASSIGN", "orchestrator", {
      task: "implement-auth",
      summary: "Add JWT-based authentication to /api/login",
      files: ["src/auth.ts", "tests/auth.test.ts"],
      acceptance_criteria: [
        "POST /api/login returns 200 with valid creds",
        "POST /api/login returns 401 with invalid creds",
        "JWT expires in 24h",
      ],
      complexity_estimate: 3,
      file_ownership_exclusive: ["src/auth.ts"],
      file_ownership_read_only: ["src/db.ts"],
      task_dependencies: [42, 43],
      required_skills: ["typescript", "jwt"],
      estimated_tokens: 8500,
    });
    expect(r.id).toBeGreaterThan(0);
    expect(r.acceptance_criteria).toEqual([
      "POST /api/login returns 200 with valid creds",
      "POST /api/login returns 401 with invalid creds",
      "JWT expires in 24h",
    ]);
    expect(r.complexity_estimate).toBe(3);
    expect(r.file_ownership_exclusive).toEqual(["src/auth.ts"]);
    expect(r.file_ownership_read_only).toEqual(["src/db.ts"]);
    expect(r.task_dependencies).toEqual([42, 43]);
    expect(r.required_skills).toEqual(["typescript", "jwt"]);
    expect(r.estimated_tokens).toBe(8500);

    // Verify they actually landed in the DB
    const db = new DatabaseSync(dbPath(testProject));
    const row = db.prepare("SELECT * FROM broadcasts WHERE id = ?").get(r.id) as Record<string, unknown>;
    db.close();
    expect(row.complexity_estimate).toBe(3);
    expect(row.estimated_tokens).toBe(8500);
    expect(JSON.parse(row.acceptance_criteria as string)).toHaveLength(3);
    expect(JSON.parse(row.file_ownership_exclusive as string)).toEqual(["src/auth.ts"]);
  });

  it("[back-compat] legacy ASSIGN without new fields still works", () => {
    const r = broadcastFact(testProject, "ASSIGN", "developer", {
      task: "fix-typo",
      summary: "Fix typo in README",
      files: ["README.md"],
    });
    expect(r.id).toBeGreaterThan(0);
    // New fields default to empty/null
    expect(r.acceptance_criteria).toEqual([]);
    expect(r.complexity_estimate).toBeNull();
    expect(r.file_ownership_exclusive).toEqual([]);
    expect(r.task_dependencies).toEqual([]);
    expect(r.required_skills).toEqual([]);
    expect(r.estimated_tokens).toBeNull();

    // DB stores nulls (not empty JSON arrays — saves bytes for legacy traffic)
    const db = new DatabaseSync(dbPath(testProject));
    const row = db.prepare("SELECT acceptance_criteria, complexity_estimate, task_dependencies FROM broadcasts WHERE id = ?")
      .get(r.id) as Record<string, unknown>;
    db.close();
    expect(row.acceptance_criteria).toBeNull();
    expect(row.complexity_estimate).toBeNull();
    expect(row.task_dependencies).toBeNull();
  });

  it("[edge] complexity_estimate clamped to 1..5; out-of-range → null", () => {
    const r0 = broadcastFact(testProject, "ASSIGN", "a", { complexity_estimate: 0 });
    const r6 = broadcastFact(testProject, "ASSIGN", "a", { complexity_estimate: 6 });
    const rNeg = broadcastFact(testProject, "ASSIGN", "a", { complexity_estimate: -1 });
    const r3 = broadcastFact(testProject, "ASSIGN", "a", { complexity_estimate: 3 });
    expect(r0.complexity_estimate).toBeNull();
    expect(r6.complexity_estimate).toBeNull();
    expect(rNeg.complexity_estimate).toBeNull();
    expect(r3.complexity_estimate).toBe(3);
  });

  it("[edge] complexity_estimate floats are rounded", () => {
    const r = broadcastFact(testProject, "ASSIGN", "a", { complexity_estimate: 3.7 });
    expect(r.complexity_estimate).toBe(4);
  });

  it("[edge] acceptance_criteria oversize cap (20 items, 500 chars each)", () => {
    const tooMany = Array.from({ length: 30 }, (_, i) => `criterion ${i}`);
    const huge    = Array.from({ length: 5  }, () => "x".repeat(800));
    const r = broadcastFact(testProject, "ASSIGN", "a", {
      acceptance_criteria: [...tooMany, ...huge],
    });
    expect(r.acceptance_criteria!.length).toBeLessThanOrEqual(20);
    for (const c of r.acceptance_criteria!) expect(c.length).toBeLessThanOrEqual(500);
  });

  it("[edge] file_ownership entries with path-traversal are rejected", () => {
    const r = broadcastFact(testProject, "ASSIGN", "a", {
      file_ownership_exclusive: ["src/foo.ts", "../../../etc/passwd", "good/path.ts"],
      file_ownership_read_only: ["./valid.md", "..\\evil.bat"],
    });
    expect(r.file_ownership_exclusive).toContain("src/foo.ts");
    expect(r.file_ownership_exclusive).toContain("good/path.ts");
    expect(r.file_ownership_exclusive).not.toContain("../../../etc/passwd");
    expect(r.file_ownership_read_only).toContain("./valid.md");
    expect(r.file_ownership_read_only).not.toContain("..\\evil.bat");
  });

  it("[edge] task_dependencies: only positive integers kept", () => {
    const r = broadcastFact(testProject, "ASSIGN", "a", {
      task_dependencies: [42, 0, -1, 1.5, 100, NaN, Infinity, 7] as unknown as number[],
    });
    expect(r.task_dependencies).toEqual([42, 100, 7]);
  });

  it("[edge] required_skills cap 20 items, 100 chars each", () => {
    const r = broadcastFact(testProject, "ASSIGN", "a", {
      required_skills: Array.from({ length: 30 }, (_, i) => "x".repeat(150) + "_" + i),
    });
    expect(r.required_skills!.length).toBeLessThanOrEqual(20);
    for (const s of r.required_skills!) expect(s.length).toBeLessThanOrEqual(100);
  });

  it("[edge] estimated_tokens negative → null; non-finite → null; >1B clamped", () => {
    const rNeg  = broadcastFact(testProject, "ASSIGN", "a", { estimated_tokens: -100 });
    const rNaN  = broadcastFact(testProject, "ASSIGN", "a", { estimated_tokens: NaN });
    const rBig  = broadcastFact(testProject, "ASSIGN", "a", { estimated_tokens: 1e12 });
    const rOk   = broadcastFact(testProject, "ASSIGN", "a", { estimated_tokens: 50_000 });
    expect(rNeg.estimated_tokens).toBeNull();
    expect(rNaN.estimated_tokens).toBeNull();
    expect(rBig.estimated_tokens).toBe(1_000_000_000);
    expect(rOk.estimated_tokens).toBe(50_000);
  });

  it("[user case] structured ASSIGN coexists with non-ASSIGN broadcasts", () => {
    // Mix types: structured ASSIGN, then a STATUS reply
    broadcastFact(testProject, "ASSIGN", "orchestrator", {
      task: "x", complexity_estimate: 4, required_skills: ["postgres"],
    });
    broadcastFact(testProject, "STATUS", "developer", {
      summary: "in progress", state: "in-progress",
    });
    const db = new DatabaseSync(dbPath(testProject));
    const rows = db.prepare("SELECT type, complexity_estimate FROM broadcasts ORDER BY id").all() as Array<{ type: string; complexity_estimate: number | null }>;
    db.close();
    expect(rows).toEqual([
      { type: "ASSIGN", complexity_estimate: 4 },
      { type: "STATUS", complexity_estimate: null },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §8.6 T3.2 — MAC-style classification on outcomes
// ─────────────────────────────────────────────────────────────────────────

describe("Sprint 3 §8.6 T3.2 — MAC classification on outcomes", () => {

  // Helper: seed a tool_call we can attach outcomes to
  async function seedCall(sessionId: string, agentId = "agent-x"): Promise<string> {
    const cid = newCallId();
    await recordToolCall({
      callId: cid, sessionId, agentId,
      projectPath: testProject, toolName: "Read",
      model: "claude-sonnet-4-6",
      inputTokens: 50, outputTokens: 25, latencyMs: 5, status: "ok",
    });
    return cid;
  }

  it("[unit] default classification is 'internal'", async () => {
    const cid = await seedCall("s1");
    const r = await recordOutcome({
      projectPath: testProject, refType: "tool_call", refId: cid,
      outcomeKind: "accepted", signalSource: "user_prompt",
    });
    expect(r).not.toBeNull();
    const db = new DatabaseSync(dbPath(testProject));
    const row = db.prepare("SELECT classification, created_by_agent_id FROM outcomes WHERE outcome_id = ?")
      .get(r!.outcome_id) as { classification: string; created_by_agent_id: string | null };
    db.close();
    expect(row.classification).toBe("internal");
    expect(row.created_by_agent_id).toBeNull();
  });

  it("[unit] all four classification levels round-trip", async () => {
    const cid = await seedCall("s2");
    for (const cls of ["public", "internal", "confidential", "restricted"] as const) {
      const r = await recordOutcome({
        projectPath: testProject, refType: "tool_call", refId: cid,
        outcomeKind: "accepted", signalSource: "manual",
        classification: cls,
        createdByAgentId: cls === "restricted" ? "alice" : undefined,
      });
      expect(r).not.toBeNull();
      const db = new DatabaseSync(dbPath(testProject));
      const row = db.prepare("SELECT classification FROM outcomes WHERE outcome_id = ?")
        .get(r!.outcome_id) as { classification: string };
      db.close();
      expect(row.classification).toBe(cls);
    }
  });

  it("[edge] 'restricted' without createdByAgentId is downgraded to 'confidential'", async () => {
    const cid = await seedCall("s3");
    const r = await recordOutcome({
      projectPath: testProject, refType: "tool_call", refId: cid,
      outcomeKind: "accepted", signalSource: "manual",
      classification: "restricted",
      // no createdByAgentId
    });
    expect(r).not.toBeNull();
    const db = new DatabaseSync(dbPath(testProject));
    const row = db.prepare("SELECT classification FROM outcomes WHERE outcome_id = ?")
      .get(r!.outcome_id) as { classification: string };
    db.close();
    expect(row.classification).toBe("confidential");
  });

  it("[unit] getOutcomesForToolCall WITHOUT requestingAgentId returns ALL rows (admin/legacy path)", async () => {
    const cid = await seedCall("s4");
    await recordOutcome({ projectPath: testProject, refType: "tool_call", refId: cid, outcomeKind: "accepted", signalSource: "manual", classification: "public" });
    await recordOutcome({ projectPath: testProject, refType: "tool_call", refId: cid, outcomeKind: "accepted", signalSource: "manual", classification: "internal" });
    await recordOutcome({ projectPath: testProject, refType: "tool_call", refId: cid, outcomeKind: "accepted", signalSource: "manual", classification: "confidential" });
    await recordOutcome({ projectPath: testProject, refType: "tool_call", refId: cid, outcomeKind: "accepted", signalSource: "manual", classification: "restricted", createdByAgentId: "alice" });
    const all = getOutcomesForToolCall(testProject, cid);
    expect(all).toHaveLength(4);
  });

  it("[user case] requestingAgentId filter: 'public' + 'internal' visible to all", async () => {
    const cid = await seedCall("s5");
    await recordOutcome({ projectPath: testProject, refType: "tool_call", refId: cid, outcomeKind: "accepted", signalSource: "manual", classification: "public" });
    await recordOutcome({ projectPath: testProject, refType: "tool_call", refId: cid, outcomeKind: "accepted", signalSource: "manual", classification: "internal" });
    const visible = getOutcomesForToolCall(testProject, cid, "anyone");
    expect(visible).toHaveLength(2);
  });

  it("[user case] 'confidential' visible to non-empty agent identity", async () => {
    const cid = await seedCall("s6");
    await recordOutcome({ projectPath: testProject, refType: "tool_call", refId: cid, outcomeKind: "accepted", signalSource: "manual", classification: "confidential" });
    const withId = getOutcomesForToolCall(testProject, cid, "alice");
    const empty  = getOutcomesForToolCall(testProject, cid, "");
    expect(withId).toHaveLength(1);
    expect(empty).toHaveLength(0);  // empty agent_id can't read confidential
  });

  it("[RT-S3-02] cross-agent read of 'restricted' outcome is blocked", async () => {
    const cid = await seedCall("s7");
    // Alice writes a restricted outcome
    await recordOutcome({
      projectPath: testProject, refType: "tool_call", refId: cid,
      outcomeKind: "accepted", signalSource: "user_prompt",
      classification: "restricted", createdByAgentId: "alice",
      evidence: { sentiment: "positive" },
    });
    // Bob tries to read it
    const bobView = getOutcomesForToolCall(testProject, cid, "bob");
    expect(bobView).toHaveLength(0);  // BLOCKED
    // Alice can read her own
    const aliceView = getOutcomesForToolCall(testProject, cid, "alice");
    expect(aliceView).toHaveLength(1);
    expect(aliceView[0].outcome_kind).toBe("accepted");
  });

  it("[RT-S3-02] mixed scenario: Alice + Bob each have a 'restricted' row; each sees only their own", async () => {
    const cidA = await seedCall("sA-mix");
    const cidB = await seedCall("sB-mix");
    await recordOutcome({ projectPath: testProject, refType: "tool_call", refId: cidA, outcomeKind: "accepted", signalSource: "user_prompt", classification: "restricted", createdByAgentId: "alice" });
    await recordOutcome({ projectPath: testProject, refType: "tool_call", refId: cidB, outcomeKind: "rejected", signalSource: "user_prompt", classification: "restricted", createdByAgentId: "bob" });
    expect(getOutcomesForToolCall(testProject, cidA, "alice")).toHaveLength(1);
    expect(getOutcomesForToolCall(testProject, cidA, "bob")).toHaveLength(0);
    expect(getOutcomesForToolCall(testProject, cidB, "alice")).toHaveLength(0);
    expect(getOutcomesForToolCall(testProject, cidB, "bob")).toHaveLength(1);
  });

  it("[RT-S3-03] legacy rows get 'internal' default from migration; remain readable to all agents", async () => {
    const cid = await seedCall("s-legacy");
    // Migration 19 sets the default to 'internal', so a row that doesn't
    // explicitly set classification automatically gets 'internal'. (NOT NULL
    // CHECK constraint blocks NULL — verified separately as a positive
    // safety property: legacy rows are never silently un-classified.)
    await recordOutcome({ projectPath: testProject, refType: "tool_call", refId: cid, outcomeKind: "accepted", signalSource: "manual" });
    const db = new DatabaseSync(dbPath(testProject));
    const row = db.prepare("SELECT classification FROM outcomes WHERE ref_id = ?").get(cid) as { classification: string };
    db.close();
    expect(row.classification).toBe("internal");

    // Therefore any agent can read it
    expect(getOutcomesForToolCall(testProject, cid, "any-agent")).toHaveLength(1);
    // And the application-layer filter accepts 'internal' for any non-empty agent
    expect(getOutcomesForToolCall(testProject, cid, "different-agent")).toHaveLength(1);
  });

  it("[RT-S3-03 follow-up] CHECK constraint REJECTS attempts to NULL out classification (legacy data can't be silently un-tagged)", async () => {
    const cid = await seedCall("s-legacy-null");
    await recordOutcome({ projectPath: testProject, refType: "tool_call", refId: cid, outcomeKind: "accepted", signalSource: "manual" });
    const db = new DatabaseSync(dbPath(testProject));
    expect(() => {
      db.exec("UPDATE outcomes SET classification = NULL");
    }).toThrow(/NOT NULL constraint|CHECK constraint/i);
    db.close();
  });

  it("[user case] resolveUserPromptOutcome auto-tags 'restricted' with the agent_id", async () => {
    const cid = await seedCall("s-up", "agent-alice");
    const r = await resolveUserPromptOutcome({
      projectPath: testProject, sessionId: "s-up",
      userMessage: "thanks, that works perfectly!",
      agentId: "agent-alice",
    });
    expect(r).not.toBeNull();
    const db = new DatabaseSync(dbPath(testProject));
    const row = db.prepare("SELECT classification, created_by_agent_id FROM outcomes WHERE outcome_id = ?")
      .get(r!.outcome_id) as { classification: string; created_by_agent_id: string };
    db.close();
    expect(row.classification).toBe("restricted");
    expect(row.created_by_agent_id).toBe("agent-alice");

    // Bob can't read alice's user-prompt outcome
    expect(getOutcomesForToolCall(testProject, cid, "agent-bob")).toHaveLength(0);
    expect(getOutcomesForToolCall(testProject, cid, "agent-alice")).toHaveLength(1);
  });

  it("[user case] resolveGitCommitOutcome stays 'internal' (commit info isn't sensitive)", async () => {
    const cid = await seedCall("s-git", "agent-x");
    const r = await resolveGitCommitOutcome({
      projectPath: testProject, sessionId: "s-git",
      bashOutput: "[main abc1234] Fix typo",
    });
    expect(r).not.toBeNull();
    const db = new DatabaseSync(dbPath(testProject));
    const row = db.prepare("SELECT classification FROM outcomes WHERE outcome_id = ?")
      .get(r!.outcome_id) as { classification: string };
    db.close();
    // resolveGitCommitOutcome doesn't override → default 'internal'
    expect(row.classification).toBe("internal");
    void cid;
  });

  it("[RT-S3-04] CHECK constraint blocks invalid classification (SQL injection / typo)", async () => {
    const cid = await seedCall("s-check");
    await recordOutcome({ projectPath: testProject, refType: "tool_call", refId: cid, outcomeKind: "accepted", signalSource: "manual" });
    const db = new DatabaseSync(dbPath(testProject));
    expect(() => {
      db.prepare(`UPDATE outcomes SET classification = 'TOP-SECRET' WHERE id = 1`).run();
    }).toThrow(/CHECK constraint/i);
    db.close();
  });

  it("[edge] invalid classification on input coerced to 'internal' (defensive default)", async () => {
    const cid = await seedCall("s-coerce");
    const r = await recordOutcome({
      projectPath: testProject, refType: "tool_call", refId: cid,
      outcomeKind: "accepted", signalSource: "manual",
      // @ts-expect-error
      classification: "SECRET",
    });
    expect(r).not.toBeNull();
    const db = new DatabaseSync(dbPath(testProject));
    const row = db.prepare("SELECT classification FROM outcomes WHERE outcome_id = ?")
      .get(r!.outcome_id) as { classification: string };
    db.close();
    expect(row.classification).toBe("internal");
  });
});
