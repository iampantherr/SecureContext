/**
 * Every test here reproduces a REAL defect that shipped through a green suite on
 * 2026-07-29. The point is not that the logic is self-consistent — that is what
 * the failing tests already proved they could not tell us. The point is that
 * each historical silent failure is now caught by a detector.
 */
import { describe, it, expect } from "vitest";
import { verifyWrite, emptyResultAnomaly } from "./effect_verify.js";

describe("detector A — write-readback catches silent coercion", () => {
  it("catches the kind:'constraint' → 'fact' coercion (defect 1)", () => {
    // The actual bug: zc_remember validated kind against a stale 4-value
    // whitelist, fell back to the auto-classifier, and returned {ok:true}.
    // Three live E2E rounds were spent finding it.
    const r = verifyWrite(
      { key: "SC1_PROTECTED_PATHS", kind: "constraint", importance: 3 },
      { key: "SC1_PROTECTED_PATHS", kind: "fact",       importance: 3 },
      { key: "exact", kind: "exact", importance: "exact" },
      { operation: "zc_remember" }
    );
    expect(r.ok).toBe(false);
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]!.field).toBe("kind");
    expect(r.discrepancies[0]!.severity).toBe("error");
    expect(r.notice).toContain("constraint");
    expect(r.notice).toContain("fact");
  });

  it("stays silent when the write round-trips honestly", () => {
    const r = verifyWrite(
      { key: "K", kind: "antipattern", importance: 4 },
      { key: "K", kind: "antipattern", importance: 4 },
      { key: "exact", kind: "exact", importance: "exact" },
      { operation: "zc_remember" }
    );
    expect(r.ok).toBe(true);
    expect(r.discrepancies).toHaveLength(0);
    expect(r.notice).toBe("");
  });

  it("tolerates PG returning numbers as strings", () => {
    const r = verifyWrite({ importance: 5 }, { importance: "5" },
      { importance: "exact" }, { operation: "zc_remember" });
    expect(r.ok).toBe(true);
  });
});

describe("detector A — write-readback catches silent clamping", () => {
  it("catches an UNMARKED truncation (defect 2)", () => {
    // The actual bug: broadcast summaries clamped to 1000 chars with no marker.
    // A task brief arrived cut mid-sentence; the worker lost its acceptance
    // criteria and built against invented ones.
    const requested = "ACCEPTANCE CRITERIA: " + "x".repeat(2000);
    const r = verifyWrite(
      { summary: requested },
      { summary: requested.slice(0, 1000) },
      { summary: "lossy-marked" },
      { operation: "zc_broadcast" }
    );
    expect(r.ok).toBe(false);
    expect(r.discrepancies[0]!.detail).toContain("UNRECOVERABLE");
    expect(r.notice).toMatch(/lost \d+ characters/);
  });

  it("accepts a truncation that announces itself, as a warning not an error", () => {
    const requested = "y".repeat(6000);
    const stored = "y".repeat(3900) + " …[TRUNCATED — 2100 more chars; ask the sender for the full text]";
    const r = verifyWrite({ summary: requested }, { summary: stored },
      { summary: "lossy-marked" }, { operation: "zc_broadcast" });
    expect(r.ok).toBe(true);                       // announced ⇒ not a silent failure
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]!.severity).toBe("warning");
  });
});

describe("detector B — empty-result anomaly", () => {
  it("flags a query that returned nothing where it always returned something (defects 3, 4)", () => {
    // Defect 3: migrationsTouching() returned [] because \b became a backspace
    // character, silently disabling a migration replay.
    // Defect 4: a base-class stub returned [] so an unimplemented PG method
    // rendered as HTTP 200 with empty data.
    const a = emptyResultAnomaly("migrationsTouching", 0, [8, 8, 8, 9, 8, 8, 8, 8]);
    expect(a.anomalous).toBe(true);
    expect(a.notice).toContain("returned 0 results");
    expect(a.notice).toContain("8–9");
  });

  it("does NOT flag an operation that is legitimately empty much of the time", () => {
    const a = emptyResultAnomaly("listPendingApprovals", 0, [0, 0, 1, 0, 0, 2, 0, 0, 0, 0]);
    expect(a.anomalous).toBe(false);
  });

  it("stays quiet without enough history to judge", () => {
    expect(emptyResultAnomaly("newThing", 0, [5, 5]).anomalous).toBe(false);
  });

  it("never fires on a non-empty result", () => {
    expect(emptyResultAnomaly("x", 3, [10, 10, 10, 10, 10, 10, 10, 10]).anomalous).toBe(false);
  });
});

describe("the module does not reproduce the failure it detects", () => {
  it("reports every discrepancy in the notice, never just the first", () => {
    const r = verifyWrite(
      { kind: "constraint", importance: 3, agent_id: "default" },
      { kind: "fact",       importance: 5, agent_id: "orchestrator" },
      { kind: "exact", importance: "exact", agent_id: "exact" },
      { operation: "zc_remember" }
    );
    expect(r.discrepancies).toHaveLength(3);
    for (const f of ["kind", "importance", "agent_id"]) expect(r.notice).toContain(f);
  });

  it("ignores fields with no declared contract, so new columns cannot make writes noisy", () => {
    const r = verifyWrite(
      { kind: "fact", some_new_column: "a" },
      { kind: "fact", some_new_column: "b" },
      { kind: "exact" },
      { operation: "zc_remember" }
    );
    expect(r.ok).toBe(true);
    expect(r.discrepancies).toHaveLength(0);
  });
});
