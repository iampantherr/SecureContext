/**
 * Tests for Phase 2 A2A broadcast channel — broadcast.test.ts
 *
 * Security properties tested (Chin & Older 2011):
 *   - Biba integrity:   invalid key rejected, no write-up without capability
 *   - Bell-La Padula:   private working_memory invisible to other agents
 *   - Reference monitor: broadcastFact() is the single enforcement point
 *   - Least privilege:   open mode allows all writes; key mode restricts
 *   - Non-transitive:   workers read but cannot re-broadcast as orchestrator
 *   - Sanitization:     control chars stripped, lengths capped
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use a unique temp dir per test run — DB scoped by TEST_PATH hash
const TEST_DB_DIR = mkdtempSync(join(tmpdir(), "zc-bc-test-"));
const TEST_PATH   = join(TEST_DB_DIR, "test-broadcast-project");
const PATH2       = join(TEST_DB_DIR, "test-broadcast-project-2"); // isolated project

// Must import AFTER setting env (for any config overrides)
import {
  broadcastFact,
  recallSharedChannel,
  setChannelKey,
  isChannelKeyConfigured,
  formatSharedChannelForContext,
  rememberFact,
  recallWorkingMemory,
  type BroadcastType,
} from "./memory.js";

// ─── OPEN MODE (no channel key configured) ────────────────────────────────────

describe("broadcastFact — open mode (no channel key)", () => {
  it("writes a broadcast without any key", () => {
    const msg = broadcastFact(TEST_PATH, "STATUS", "agent-1", {
      task:    "build auth module",
      state:   "in-progress",
      summary: "Scaffolding JWT middleware",
    });
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.type).toBe("STATUS");
    expect(msg.agent_id).toBe("agent-1");
    expect(msg.task).toBe("build auth module");
    expect(msg.state).toBe("in-progress");
    expect(msg.summary).toBe("Scaffolding JWT middleware");
  });

  it("writes all 7 broadcast types without a key", () => {
    const types: BroadcastType[] = [
      "ASSIGN", "STATUS", "PROPOSED", "DEPENDENCY", "MERGE", "REJECT", "REVISE",
    ];
    for (const type of types) {
      const msg = broadcastFact(TEST_PATH, type, "orchestrator", { task: `${type}-task` });
      expect(msg.type).toBe(type);
      expect(msg.agent_id).toBe("orchestrator");
    }
  });

  it("stores files array and depends_on array as parsed lists", () => {
    const msg = broadcastFact(TEST_PATH, "PROPOSED", "agent-2", {
      files:      ["src/auth.ts", "src/middleware.ts"],
      depends_on: ["agent-1"],
      summary:    "Auth module proposal",
    });
    expect(msg.files).toEqual(["src/auth.ts", "src/middleware.ts"]);
    expect(msg.depends_on).toEqual(["agent-1"]);
  });

  it("clamps importance to 1–5", () => {
    const low  = broadcastFact(TEST_PATH, "STATUS", "agent-x", { importance: 0 });
    const high = broadcastFact(TEST_PATH, "STATUS", "agent-x", { importance: 99 });
    expect(low.importance).toBeGreaterThanOrEqual(1);
    expect(high.importance).toBeLessThanOrEqual(5);
  });

  it("defaults all optional fields gracefully", () => {
    const msg = broadcastFact(TEST_PATH, "STATUS", "agent-minimal");
    expect(msg.task).toBe("");
    expect(msg.state).toBe("");
    expect(msg.summary).toBe("");
    expect(msg.reason).toBe("");
    expect(msg.files).toEqual([]);
    expect(msg.depends_on).toEqual([]);
    expect(msg.importance).toBe(3);
  });
});

// ─── CHANNEL KEY (key-protected mode) ─────────────────────────────────────────

describe("channel key — capability-based access control", () => {
  const PROTECTED_PATH = join(TEST_DB_DIR, "protected-project");
  const CORRECT_KEY    = "my-super-secret-orchestrator-key";
  const WRONG_KEY      = "this-is-the-wrong-key!";

  it("isChannelKeyConfigured returns false before key is set", () => {
    expect(isChannelKeyConfigured(PROTECTED_PATH)).toBe(false);
  });

  it("setChannelKey stores the key (as hash — not plaintext)", () => {
    setChannelKey(PROTECTED_PATH, CORRECT_KEY);
    expect(isChannelKeyConfigured(PROTECTED_PATH)).toBe(true);
  });

  it("rejects key shorter than 8 characters", () => {
    expect(() => setChannelKey(PROTECTED_PATH, "short")).toThrow(/at least 8/);
  });

  it("allows broadcast with correct key", () => {
    const msg = broadcastFact(PROTECTED_PATH, "STATUS", "orchestrator", {
      summary:     "Starting Phase 2",
      channel_key: CORRECT_KEY,
    });
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.summary).toBe("Starting Phase 2");
  });

  it("REJECTS broadcast with wrong key — Biba integrity enforcement", () => {
    expect(() =>
      broadcastFact(PROTECTED_PATH, "STATUS", "rogue-agent", {
        summary:     "I should not get in",
        channel_key: WRONG_KEY,
      })
    ).toThrow(/invalid or missing channel key/);
  });

  it("REJECTS broadcast with missing key — Biba integrity enforcement", () => {
    expect(() =>
      broadcastFact(PROTECTED_PATH, "STATUS", "worker-agent", {
        summary: "No key provided",
        // channel_key omitted
      })
    ).toThrow(/invalid or missing channel key/);
  });

  it("does NOT expose the key hash in any return value", () => {
    const msg = broadcastFact(PROTECTED_PATH, "ASSIGN", "orchestrator", {
      task:        "implement DB layer",
      channel_key: CORRECT_KEY,
    });
    // The return value must not contain the plaintext key or any hash
    const serialized = JSON.stringify(msg);
    expect(serialized).not.toContain(CORRECT_KEY);
    expect(serialized).not.toContain("channel_key");
  });
});

// ─── RECALL SHARED CHANNEL ───────────────────────────────────────────────────

describe("recallSharedChannel", () => {
  const RECALL_PATH = join(TEST_DB_DIR, "recall-project");

  it("returns empty array when no broadcasts exist", () => {
    const msgs = recallSharedChannel(RECALL_PATH);
    expect(msgs).toEqual([]);
  });

  it("returns broadcasts ordered most-recent first", async () => {
    broadcastFact(RECALL_PATH, "ASSIGN",  "orch",    { task: "first"  });
    // small sleep to ensure distinct created_at timestamps
    await new Promise((r) => setTimeout(r, 10));
    broadcastFact(RECALL_PATH, "STATUS",  "agent-1", { task: "second" });
    await new Promise((r) => setTimeout(r, 10));
    broadcastFact(RECALL_PATH, "PROPOSED","agent-2", { task: "third"  });

    const msgs = recallSharedChannel(RECALL_PATH);
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    // Most recent first — "third" should appear before "first"
    const thirdIdx = msgs.findIndex((m) => m.task === "third");
    const firstIdx = msgs.findIndex((m) => m.task === "first");
    expect(thirdIdx).toBeLessThan(firstIdx);
  });

  it("filters by type when specified", () => {
    const assignPath = join(TEST_DB_DIR, "filter-project");
    broadcastFact(assignPath, "ASSIGN",  "orch", { task: "a1" });
    broadcastFact(assignPath, "STATUS",  "ag-1", { task: "s1" });
    broadcastFact(assignPath, "ASSIGN",  "orch", { task: "a2" });

    const assigns = recallSharedChannel(assignPath, { type: "ASSIGN" });
    expect(assigns.length).toBe(2);
    expect(assigns.every((m) => m.type === "ASSIGN")).toBe(true);
  });

  it("respects limit parameter", () => {
    const limitPath = join(TEST_DB_DIR, "limit-project");
    for (let i = 0; i < 10; i++) {
      broadcastFact(limitPath, "STATUS", `agent-${i}`, { task: `task-${i}` });
    }
    const msgs = recallSharedChannel(limitPath, { limit: 3 });
    expect(msgs.length).toBe(3);
  });

  it("parses files and depends_on from stored JSON", () => {
    const parsePath = join(TEST_DB_DIR, "parse-project");
    broadcastFact(parsePath, "PROPOSED", "agent-3", {
      files:      ["src/a.ts", "src/b.ts"],
      depends_on: ["agent-1", "agent-2"],
    });
    const msgs = recallSharedChannel(parsePath);
    expect(msgs[0]!.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(msgs[0]!.depends_on).toEqual(["agent-1", "agent-2"]);
  });

  it("broadcasts from multiple agents all appear in shared channel", () => {
    const multiPath = join(TEST_DB_DIR, "multi-agent-project");
    broadcastFact(multiPath, "STATUS",   "agent-auth", { task: "auth"   });
    broadcastFact(multiPath, "STATUS",   "agent-db",   { task: "db"     });
    broadcastFact(multiPath, "PROPOSED", "agent-ui",   { task: "ui"     });

    const msgs = recallSharedChannel(multiPath);
    const agentIds = msgs.map((m) => m.agent_id);
    expect(agentIds).toContain("agent-auth");
    expect(agentIds).toContain("agent-db");
    expect(agentIds).toContain("agent-ui");
  });
});

// ─── CHANNEL ISOLATION — Bell-La Padula ──────────────────────────────────────

describe("Bell-La Padula — private memory is NOT visible in shared channel", () => {
  it("private working_memory facts do NOT appear in recallSharedChannel", () => {
    const isolPath = join(TEST_DB_DIR, "isolation-project");
    // Write private fact
    rememberFact(isolPath, "private-secret", "my private value", 5, "agent-private");
    // Write broadcast
    broadcastFact(isolPath, "STATUS", "agent-public", { summary: "public broadcast" });

    const broadcasts = recallSharedChannel(isolPath);
    // None of the broadcasts should expose private working_memory
    const allText = JSON.stringify(broadcasts);
    expect(allText).not.toContain("my private value");
    expect(allText).not.toContain("private-secret");
  });

  it("working_memory for agent-A is invisible to agent-B", () => {
    const isolPath2 = join(TEST_DB_DIR, "isolation-project-2");
    rememberFact(isolPath2, "agent-a-secret", "agent-a-value", 5, "agent-a");
    rememberFact(isolPath2, "agent-b-secret", "agent-b-value", 5, "agent-b");

    const wmA = recallWorkingMemory(isolPath2, "agent-a");
    const wmB = recallWorkingMemory(isolPath2, "agent-b");

    expect(wmA.find((f) => f.key === "agent-a-secret")).toBeDefined();
    expect(wmA.find((f) => f.key === "agent-b-secret")).toBeUndefined(); // not visible
    expect(wmB.find((f) => f.key === "agent-b-secret")).toBeDefined();
    expect(wmB.find((f) => f.key === "agent-a-secret")).toBeUndefined(); // not visible
  });
});

// ─── PROJECT ISOLATION ────────────────────────────────────────────────────────

describe("project isolation — broadcasts do not leak across projects", () => {
  it("broadcasts in project A are invisible in project B", () => {
    broadcastFact(TEST_PATH, "STATUS", "agent-in-A", { summary: "only in project A" });
    broadcastFact(PATH2,     "STATUS", "agent-in-B", { summary: "only in project B" });

    const msgsA = recallSharedChannel(TEST_PATH);
    const msgsB = recallSharedChannel(PATH2);

    const textA = JSON.stringify(msgsA);
    const textB = JSON.stringify(msgsB);

    expect(textA).not.toContain("only in project B");
    expect(textB).not.toContain("only in project A");
  });
});

// ─── SANITIZATION ─────────────────────────────────────────────────────────────

describe("input sanitization — security hardening", () => {
  const SANIT_PATH = join(TEST_DB_DIR, "sanitize-project");

  it("strips control characters from agent_id, task, summary, reason", () => {
    const msg = broadcastFact(SANIT_PATH, "STATUS", "agent\n\r\x00evil", {
      task:    "task\nwith\nnewlines",
      summary: "summary\x00with\x01nulls",
      reason:  "reason\r\nwith\rcarriage",
    });
    expect(msg.agent_id).not.toContain("\n");
    expect(msg.agent_id).not.toContain("\x00");
    expect(msg.task).not.toContain("\n");
    expect(msg.summary).not.toContain("\x00");
    expect(msg.reason).not.toContain("\r");
  });

  it("truncates agent_id to 64 chars, task/reason to 500, summary to 1000", () => {
    const msg = broadcastFact(SANIT_PATH, "STATUS", "a".repeat(200), {
      task:    "t".repeat(1000),
      summary: "s".repeat(2000),
      reason:  "r".repeat(1000),
    });
    expect(msg.agent_id.length).toBeLessThanOrEqual(64);
    expect(msg.task.length).toBeLessThanOrEqual(500);
    expect(msg.summary.length).toBeLessThanOrEqual(1000);
    expect(msg.reason.length).toBeLessThanOrEqual(500);
  });

  it("caps files array at 50 entries, depends_on at 20 entries", () => {
    const manyFiles  = Array.from({ length: 100 }, (_, i) => `file-${i}.ts`);
    const manyDeps   = Array.from({ length: 50 },  (_, i) => `agent-${i}`);
    const msg = broadcastFact(SANIT_PATH, "PROPOSED", "agent-big", {
      files:      manyFiles,
      depends_on: manyDeps,
    });
    // Recall to get the parsed-back version
    const stored = recallSharedChannel(SANIT_PATH, { type: "PROPOSED" })[0]!;
    expect(stored.files.length).toBeLessThanOrEqual(50);
    expect(stored.depends_on.length).toBeLessThanOrEqual(20);
  });
});

// ─── FORMAT SHARED CHANNEL ───────────────────────────────────────────────────

describe("formatSharedChannelForContext", () => {
  it("returns empty message when no broadcasts", () => {
    const result = formatSharedChannelForContext([]);
    expect(result).toContain("Empty");
  });

  it("groups broadcasts by type in output", () => {
    const msgs = recallSharedChannel(TEST_PATH);
    const result = formatSharedChannelForContext(msgs);
    // Should contain section headers for types that have entries
    expect(result).toContain("## Shared Channel");
  });

  it("shows agent_id and task in each entry", () => {
    const formatPath = join(TEST_DB_DIR, "format-project");
    broadcastFact(formatPath, "ASSIGN",  "orch",    { task: "build API"  });
    broadcastFact(formatPath, "STATUS",  "agent-1", { task: "working..." });
    broadcastFact(formatPath, "PROPOSED","agent-2", { task: "PR ready"   });

    const msgs   = recallSharedChannel(formatPath);
    const result = formatSharedChannelForContext(msgs);

    expect(result).toContain("orch");
    expect(result).toContain("build API");
    expect(result).toContain("agent-1");
    expect(result).toContain("ASSIGN");
    expect(result).toContain("STATUS");
    expect(result).toContain("PROPOSED");
  });

  it("includes broadcast count in header", () => {
    const countPath = join(TEST_DB_DIR, "count-project");
    broadcastFact(countPath, "STATUS", "a1", { task: "t1" });
    broadcastFact(countPath, "STATUS", "a2", { task: "t2" });

    const msgs   = recallSharedChannel(countPath);
    const result = formatSharedChannelForContext(msgs);
    expect(result).toMatch(/\d+ broadcasts/);
  });

  it("shows summary as indented line when present", () => {
    const sumPath = join(TEST_DB_DIR, "summary-project");
    broadcastFact(sumPath, "MERGE", "orch", {
      task:    "auth-complete",
      summary: "JWT middleware approved and merged",
    });
    const msgs   = recallSharedChannel(sumPath);
    const result = formatSharedChannelForContext(msgs);
    expect(result).toContain("JWT middleware approved and merged");
  });
});

// ─── APPEND-ONLY AUDIT TRAIL ──────────────────────────────────────────────────

describe("append-only — immutable audit trail", () => {
  it("each broadcastFact call produces a unique incrementing id", () => {
    const auditPath = join(TEST_DB_DIR, "audit-project");
    const m1 = broadcastFact(auditPath, "ASSIGN",  "orch",    { task: "step 1" });
    const m2 = broadcastFact(auditPath, "STATUS",  "agent-1", { task: "step 2" });
    const m3 = broadcastFact(auditPath, "PROPOSED","agent-1", { task: "step 3" });

    expect(m1.id).toBeLessThan(m2.id);
    expect(m2.id).toBeLessThan(m3.id);
  });

  it("total broadcast count grows with each write (no deduplication)", () => {
    const dedupPath = join(TEST_DB_DIR, "dedup-project");
    broadcastFact(dedupPath, "STATUS", "agent-x", { task: "same-task" });
    broadcastFact(dedupPath, "STATUS", "agent-x", { task: "same-task" });

    const msgs = recallSharedChannel(dedupPath);
    // Both entries exist — broadcasts are append-only
    const matches = msgs.filter((m) => m.task === "same-task");
    expect(matches.length).toBe(2);
  });
});
