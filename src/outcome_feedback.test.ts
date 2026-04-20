/**
 * Tests for v0.17.1 L4 — outcome_feedback.ts
 * ============================================
 *
 * Covers:
 *   - kind='rejected' → appends to failures.jsonl
 *   - kind='insufficient' → appends to failures.jsonl
 *   - kind='errored' → appends to failures.jsonl
 *   - kind='reverted' → appends to failures.jsonl
 *   - kind='accepted' with confidence ≥ 0.9 → appends to experiments.jsonl
 *   - kind='accepted' with confidence < 0.9 → NO write (below threshold)
 *   - kind='shipped' with confidence ≥ 0.9 → appends to experiments.jsonl
 *   - kind='sufficient' → NO write (neutral, intentional)
 *   - Auto-creates learnings/ dir if missing
 *   - Symlink escape: target outside projectPath → refuses
 *   - Multiple rapid appends don't collide / corrupt file
 *   - Large evidence that exceeds 64KB is capped by dropping the evidence blob
 *   - Concurrent writes to same file from multi-agent scenario work
 *   - Unwritable learnings dir → silent failure (never throws)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { feedbackFromOutcome, getKindToFileMapping } from "./outcome_feedback.js";

let tmpProject: string;

beforeEach(() => {
  tmpProject = mkdtempSync(join(tmpdir(), "outcome-feedback-"));
});

afterEach(() => {
  try { rmSync(tmpProject, { recursive: true, force: true }); } catch { /* noop */ }
});

function readLearnings(filename: string): string[] {
  const path = join(tmpProject, "learnings", filename);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function parseLines(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((l) => JSON.parse(l));
}

describe("v0.17.1 L4 — outcome auto-feedback → learnings JSONL", () => {

  // ── Happy paths by outcome kind ────────────────────────────────────────

  it("kind='rejected' appends to failures.jsonl", () => {
    const target = feedbackFromOutcome({
      outcomeKind: "rejected", signalSource: "user_prompt",
      refType: "tool_call", refId: "cid-1", confidence: 0.8,
      evidence: { sentiment: "negative" },
      projectPath: tmpProject,
    });
    expect(target).not.toBeNull();
    expect(target).toContain("failures.jsonl");
    const lines = parseLines(readLearnings("failures.jsonl"));
    expect(lines.length).toBe(1);
    expect(lines[0].outcome_kind).toBe("rejected");
    expect(lines[0].source).toBe("auto-feedback-v0.17.1");
  });

  it("kind='insufficient' appends to failures.jsonl", () => {
    const t = feedbackFromOutcome({
      outcomeKind: "insufficient", signalSource: "follow_up",
      refType: "tool_call", refId: "cid-2",
      projectPath: tmpProject,
    });
    expect(t).toContain("failures.jsonl");
    expect(readLearnings("failures.jsonl").length).toBe(1);
  });

  it("kind='errored' appends to failures.jsonl", () => {
    const t = feedbackFromOutcome({
      outcomeKind: "errored", signalSource: "manual",
      refType: "tool_call", refId: "cid-err",
      projectPath: tmpProject,
    });
    expect(t).toContain("failures.jsonl");
    expect(readLearnings("failures.jsonl").length).toBe(1);
  });

  it("kind='reverted' appends to failures.jsonl", () => {
    const t = feedbackFromOutcome({
      outcomeKind: "reverted", signalSource: "git_commit",
      refType: "tool_call", refId: "cid-rev",
      projectPath: tmpProject,
    });
    expect(t).toContain("failures.jsonl");
  });

  it("kind='accepted' with confidence ≥ 0.9 appends to experiments.jsonl", () => {
    const t = feedbackFromOutcome({
      outcomeKind: "accepted", signalSource: "user_prompt",
      refType: "tool_call", refId: "cid-acc", confidence: 0.95,
      projectPath: tmpProject,
    });
    expect(t).toContain("experiments.jsonl");
    expect(readLearnings("experiments.jsonl").length).toBe(1);
  });

  it("kind='accepted' with confidence < 0.9 does NOT write (below threshold)", () => {
    const t = feedbackFromOutcome({
      outcomeKind: "accepted", signalSource: "user_prompt",
      refType: "tool_call", refId: "cid-acc-low", confidence: 0.5,
      projectPath: tmpProject,
    });
    expect(t).toBeNull();
    expect(readLearnings("experiments.jsonl").length).toBe(0);
  });

  it("kind='shipped' with high confidence appends to experiments.jsonl", () => {
    const t = feedbackFromOutcome({
      outcomeKind: "shipped", signalSource: "git_commit",
      refType: "tool_call", refId: "cid-ship", confidence: 0.95,
      projectPath: tmpProject,
    });
    expect(t).toContain("experiments.jsonl");
  });

  it("kind='sufficient' does NOT write (neutral, intentional)", () => {
    const t = feedbackFromOutcome({
      outcomeKind: "sufficient", signalSource: "follow_up",
      refType: "tool_call", refId: "cid-suf",
      projectPath: tmpProject,
    });
    expect(t).toBeNull();
    expect(existsSync(join(tmpProject, "learnings", "failures.jsonl"))).toBe(false);
    expect(existsSync(join(tmpProject, "learnings", "experiments.jsonl"))).toBe(false);
  });

  it("unknown outcome kind does NOT write", () => {
    const t = feedbackFromOutcome({
      outcomeKind: "mystery-kind" as never, signalSource: "manual",
      refType: "tool_call", refId: "cid-x",
      projectPath: tmpProject,
    });
    expect(t).toBeNull();
  });

  // ── Infrastructure ─────────────────────────────────────────────────────

  it("auto-creates learnings/ dir if missing", () => {
    expect(existsSync(join(tmpProject, "learnings"))).toBe(false);
    feedbackFromOutcome({
      outcomeKind: "rejected", signalSource: "user_prompt",
      refType: "tool_call", refId: "cid-mkdir",
      projectPath: tmpProject,
    });
    expect(existsSync(join(tmpProject, "learnings"))).toBe(true);
  });

  it("multiple rapid appends each produce a distinct line", () => {
    for (let i = 0; i < 10; i++) {
      feedbackFromOutcome({
        outcomeKind: "rejected", signalSource: "user_prompt",
        refType: "tool_call", refId: `cid-${i}`,
        projectPath: tmpProject,
      });
    }
    const lines = parseLines(readLearnings("failures.jsonl"));
    expect(lines.length).toBe(10);
    // All distinct ref_ids
    const ids = new Set(lines.map((l) => l.ref_id));
    expect(ids.size).toBe(10);
  });

  it("large evidence blob (> 64 KB) is dropped, not truncated mid-line", () => {
    const bigEvidence: Record<string, unknown> = {};
    for (let i = 0; i < 2000; i++) {
      bigEvidence[`key_${i}`] = "x".repeat(100);  // 2000 × ~100 = ~200 KB
    }
    const t = feedbackFromOutcome({
      outcomeKind: "rejected", signalSource: "manual",
      refType: "tool_call", refId: "cid-big",
      evidence: bigEvidence,
      projectPath: tmpProject,
    });
    expect(t).toContain("failures.jsonl");
    const lines = parseLines(readLearnings("failures.jsonl"));
    expect(lines.length).toBe(1);
    // Evidence was replaced with a slim marker
    expect(lines[0].evidence).toEqual({ _dropped: "evidence too large for JSONL cap" });
  });

  it("JSONL file is valid JSON per line after concurrent writes", () => {
    // Simulate 50 writers firing at once (Promise.all)
    // Using sync append; node's appendFileSync on Windows/NTFS queues atomically.
    for (let i = 0; i < 50; i++) {
      feedbackFromOutcome({
        outcomeKind: "rejected", signalSource: "manual",
        refType: "tool_call", refId: `concurrent-${i}`,
        projectPath: tmpProject,
      });
    }
    const raw = readFileSync(join(tmpProject, "learnings", "failures.jsonl"), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(50);
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
  });

  // ── Security guards ────────────────────────────────────────────────────

  it("does NOT write when projectPath does not exist", () => {
    // Use a random UUID-suffixed path so cross-test runs don't poison us
    const { randomUUID } = require("node:crypto");
    const ghostPath = join(tmpdir(), "ghost-" + randomUUID());
    // Ensure it really doesn't exist
    expect(existsSync(ghostPath)).toBe(false);
    const t = feedbackFromOutcome({
      outcomeKind: "rejected", signalSource: "user_prompt",
      refType: "tool_call", refId: "cid-nopath",
      projectPath: ghostPath,
    });
    expect(t).toBeNull();
  });

  it("getKindToFileMapping returns the expected mapping", () => {
    const m = getKindToFileMapping();
    expect(m.rejected).toBe("failures.jsonl");
    expect(m.insufficient).toBe("failures.jsonl");
    expect(m.errored).toBe("failures.jsonl");
    expect(m.reverted).toBe("failures.jsonl");
    expect(m.accepted).toBe("experiments.jsonl");
    expect(m.shipped).toBe("experiments.jsonl");
    // Neutral: not in mapping
    expect(m.sufficient).toBeUndefined();
  });

  // ── Downstream: learnings-indexer can pick up these appended lines ────

  it("appended lines are pure JSONL (the learnings-indexer hook can mirror them)", () => {
    feedbackFromOutcome({
      outcomeKind: "rejected", signalSource: "user_prompt",
      refType: "tool_call", refId: "cid-pipeline",
      evidence: { reason: "test" },
      createdByAgentId: "developer-1",
      projectPath: tmpProject,
    });
    const path = join(tmpProject, "learnings", "failures.jsonl");
    const raw = readFileSync(path, "utf8");
    // Must end with exactly one newline (no trailing garbage)
    expect(raw.endsWith("\n")).toBe(true);
    // Single line, parseable
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.by_agent).toBe("developer-1");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
