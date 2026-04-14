import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Override DB_DIR to a temp dir so tests don't touch ~/.claude
process.env["ZC_TEST_DB_DIR"] = mkdtempSync(join(tmpdir(), "zc-test-"));

// Must import AFTER setting env so Config picks up the test dir
import {
  rememberFact,
  recallWorkingMemory,
  forgetFact,
  archiveSessionSummary,
  formatWorkingMemoryForContext,
  getMemoryStats,
} from "./memory.js";

const TEST_PATH = join(process.env["ZC_TEST_DB_DIR"]!, "test-project");

describe("rememberFact / recallWorkingMemory", () => {
  it("stores and retrieves a fact", () => {
    rememberFact(TEST_PATH, "test_key", "test_value", 3);
    const wm = recallWorkingMemory(TEST_PATH);
    const fact = wm.find((f) => f.key === "test_key");
    expect(fact).toBeDefined();
    expect(fact!.value).toBe("test_value");
    expect(fact!.importance).toBe(3);
  });

  it("upserts on duplicate key — value replaced, count unchanged", () => {
    rememberFact(TEST_PATH, "upsert_key", "first",  3);
    rememberFact(TEST_PATH, "upsert_key", "second", 5);
    const wm = recallWorkingMemory(TEST_PATH);
    const matches = wm.filter((f) => f.key === "upsert_key");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.value).toBe("second");
    expect(matches[0]!.importance).toBe(5);
  });

  it("namespaces facts by agent_id — no collision", () => {
    rememberFact(TEST_PATH, "shared_key", "agent1_value", 3, "agent-1");
    rememberFact(TEST_PATH, "shared_key", "agent2_value", 3, "agent-2");
    const wm1 = recallWorkingMemory(TEST_PATH, "agent-1");
    const wm2 = recallWorkingMemory(TEST_PATH, "agent-2");
    expect(wm1.find((f) => f.key === "shared_key")!.value).toBe("agent1_value");
    expect(wm2.find((f) => f.key === "shared_key")!.value).toBe("agent2_value");
  });

  it("clamps importance to 1–5", () => {
    rememberFact(TEST_PATH, "clamp_low",  "val", 0);
    rememberFact(TEST_PATH, "clamp_high", "val", 99);
    const wm = recallWorkingMemory(TEST_PATH);
    const low  = wm.find((f) => f.key === "clamp_low");
    const high = wm.find((f) => f.key === "clamp_high");
    expect(low!.importance).toBeGreaterThanOrEqual(1);
    expect(high!.importance).toBeLessThanOrEqual(5);
  });

  it("sanitizes control characters in key and value", () => {
    rememberFact(TEST_PATH, "key\nwith\nnewlines", "val\r\nwith\x00null", 3);
    const wm = recallWorkingMemory(TEST_PATH);
    const fact = wm.find((f) => f.key.startsWith("key"));
    expect(fact).toBeDefined();
    expect(fact!.key).not.toContain("\n");
    expect(fact!.value).not.toContain("\x00");
  });

  it("truncates key to 100 chars and value to 500 chars", () => {
    const longKey   = "k".repeat(200);
    const longValue = "v".repeat(1000);
    rememberFact(TEST_PATH, longKey, longValue, 3);
    const wm = recallWorkingMemory(TEST_PATH);
    const fact = wm.find((f) => f.key.startsWith("kk"));
    expect(fact!.key.length).toBeLessThanOrEqual(100);
    expect(fact!.value.length).toBeLessThanOrEqual(500);
  });

  it("orders by importance desc", () => {
    const agent = "order-test-agent";
    rememberFact(TEST_PATH, "low",    "v", 1, agent);
    rememberFact(TEST_PATH, "high",   "v", 5, agent);
    rememberFact(TEST_PATH, "medium", "v", 3, agent);
    const wm = recallWorkingMemory(TEST_PATH, agent);
    expect(wm[0]!.importance).toBeGreaterThanOrEqual(wm[1]!.importance ?? 0);
  });
});

describe("forgetFact", () => {
  it("returns true when key existed and was deleted", () => {
    const agent = "forget-test";
    rememberFact(TEST_PATH, "to_delete", "value", 3, agent);
    const result = forgetFact(TEST_PATH, "to_delete", agent);
    expect(result).toBe(true);
    const wm = recallWorkingMemory(TEST_PATH, agent);
    expect(wm.find((f) => f.key === "to_delete")).toBeUndefined();
  });

  it("returns false when key did not exist", () => {
    const result = forgetFact(TEST_PATH, "nonexistent_key_xyz");
    expect(result).toBe(false);
  });
});

describe("getMemoryStats", () => {
  it("returns correct count and max", () => {
    const agent = "stats-test-agent";
    rememberFact(TEST_PATH, "s1", "v", 5, agent);
    rememberFact(TEST_PATH, "s2", "v", 4, agent);
    rememberFact(TEST_PATH, "s3", "v", 1, agent);
    const stats = getMemoryStats(TEST_PATH, agent);
    expect(stats.count).toBe(3);
    expect(stats.max).toBe(100);
    expect(stats.criticalCount).toBe(2); // ★4 and ★5
  });
});

describe("formatWorkingMemoryForContext", () => {
  it("returns empty message when no facts", () => {
    const result = formatWorkingMemoryForContext([]);
    expect(result).toContain("Empty");
  });

  it("groups facts by priority sections", () => {
    const facts = [
      { key: "k1", value: "v1", importance: 5, created_at: "" },
      { key: "k2", value: "v2", importance: 3, created_at: "" },
      { key: "k3", value: "v3", importance: 1, created_at: "" },
    ];
    const result = formatWorkingMemoryForContext(facts);
    expect(result).toContain("Critical");
    expect(result).toContain("Normal");
    expect(result).toContain("Ephemeral");
  });
});
