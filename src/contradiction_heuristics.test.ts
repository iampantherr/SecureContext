/**
 * S1 (v0.44.0) — temporal supersession heuristics tests.
 * Covers hasUpdateMarkers, the numeric auto-resolve branch, and preferLatestAdjust.
 */
import { describe, it, expect } from "vitest";
import {
  autoResolveVictim,
  hasUpdateMarkers,
  detectConflict,
  preferLatestAdjust,
  numbersDiffer,
  isSeriesPair,
  diffNumberIsQuantity,
  isCheckableClaim,
  NUMERIC_CONFLICT_SIM,
} from "./contradiction_heuristics.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

describe("isCheckableClaim — operational markers are not claims (v0.49.0)", () => {
  it("excludes ownership / checkpoint / session-summary keys", () => {
    expect(isCheckableClaim({ key: "OWNERSHIP_QA_F3F4_2026-07-23", value: "qa OWNS TASK_F3F4" })).toBe(false);
    expect(isCheckableClaim({ key: "ckpt_v0480_shipped", value: "v0.48.0 SHIPPED: commit fa2efaa" })).toBe(false);
    expect(isCheckableClaim({ key: "last_session_summary", value: "..." })).toBe(false);
    expect(isCheckableClaim({ key: "[SESSION_SUMMARY]abc", value: "..." })).toBe(false);
  });
  it("keeps ordinary knowledge claims checkable", () => {
    expect(isCheckableClaim({ key: "cache_ttl", value: "Cache TTL is 15 minutes" })).toBe(true);
    expect(isCheckableClaim({ key: "service_name", value: "the service is zeroclaw-orchestrator" })).toBe(true);
  });
  it("detectConflict returns null when either side is an operational marker", () => {
    const own1 = { key: "OWNERSHIP_QA_A_2026-07-23", value: "qa OWNS TASK_A = full browser gate", created_at: daysAgo(1) };
    const own2 = { key: "OWNERSHIP_QA_B_2026-07-22", value: "qa OWNS TASK_B = P1 IAM final", created_at: daysAgo(2) };
    expect(detectConflict(own1, own2, 0.95)).toBeNull();
    const ck1 = { key: "ckpt_v0480_shipped", value: "v0.48.0 SHIPPED: commit fa2efaa, tag v0.48.0", created_at: daysAgo(2) };
    const ck2 = { key: "ckpt_v0481_shipped", value: "v0.48.1 SHIPPED: commit 4795277, tag v0.48.1", created_at: daysAgo(1) };
    expect(detectConflict(ck1, ck2, 0.9)).toBeNull();
  });
});

describe("hasUpdateMarkers", () => {
  it("detects explicit change announcements", () => {
    expect(hasUpdateMarkers("entries now expire after 60 minutes")).toBe(true);
    expect(hasUpdateMarkers("migrated to pg-boss")).toBe(true);
    expect(hasUpdateMarkers("rate limit changed to 400 rpm")).toBe(true);
    expect(hasUpdateMarkers("this replaces the old queue")).toBe(true);
  });
  it("stays quiet on plain assertions", () => {
    expect(hasUpdateMarkers("cache entries expire after 15 minutes")).toBe(false);
    expect(hasUpdateMarkers("the retry limit is 3 attempts")).toBe(false);
  });
});

describe("autoResolveVictim — numeric supersession", () => {
  const oldFact = { key: "ttl_old", value: "Cache TTL: entries expire after 15 minutes.", kind: "decision", created_at: daysAgo(25) };
  const newFact = { key: "ttl_new", value: "Cache TTL: entries now expire after 60 minutes.", kind: "decision", created_at: daysAgo(4) };

  it("retires the older side when the newer value announces the change", () => {
    expect(autoResolveVictim(oldFact, newFact, "numeric_conflict")).toBe("ttl_old");
    expect(autoResolveVictim(newFact, oldFact, "numeric_conflict")).toBe("ttl_old"); // order-independent
  });

  it("stays triage-only without an update marker on the newer value", () => {
    const bareNew = { ...newFact, value: "Cache TTL: entries expire after 60 minutes." };
    expect(autoResolveVictim(oldFact, bareNew, "numeric_conflict")).toBeNull();
  });

  it("stays triage-only when BOTH carry markers (ambiguous)", () => {
    const oldMarked = { ...oldFact, value: "Cache TTL: entries now expire after 15 minutes." };
    expect(autoResolveVictim(oldMarked, newFact, "numeric_conflict")).toBeNull();
  });

  it("requires strict time ordering (same-burst writes stay ambiguous)", () => {
    const t = new Date().toISOString();
    expect(autoResolveVictim({ ...oldFact, created_at: t }, { ...newFact, created_at: t }, "numeric_conflict")).toBeNull();
  });

  it("does not touch resolution_conflict (unchanged behaviour)", () => {
    expect(autoResolveVictim(oldFact, newFact, "resolution_conflict")).toBeNull();
  });
});

describe("preferLatestAdjust", () => {
  // Orthogonal unit vectors → sim 0; identical → sim 1. Simple dot-product cosine.
  const cos = (a: Float32Array, b: Float32Array) => {
    let d = 0; for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!;
    return d;
  };
  const v = (x: number, y: number) => new Float32Array([x, y]);

  const oldFact = { key: "ttl_old", value: "product cache entries expire after 15 minutes", kind: "decision", created_at: daysAgo(25) };
  const newFact = { key: "ttl_new", value: "product cache entries now expire after 60 minutes", kind: "decision", created_at: daysAgo(4) };
  const unrelated = { key: "queue", value: "background jobs use pg-boss", kind: "decision", created_at: daysAgo(10) };

  it("demotes the older side of a near-identical numeric conflict below the newer", () => {
    // old ranks ABOVE new (higher score) — the measured KU failure shape.
    const top = [
      { fact: oldFact, score: 0.80, vec: v(1, 0), ev: Date.parse(oldFact.created_at) },
      { fact: newFact, score: 0.74, vec: v(1, 0), ev: Date.parse(newFact.created_at) }, // sim=1
      { fact: unrelated, score: 0.50, vec: v(0, 1), ev: Date.parse(unrelated.created_at) },
    ];
    const adj = preferLatestAdjust(top, cos, 0.05);
    expect(adj.get("ttl_old")).toBeCloseTo(0.74 - 0.05, 5);
    expect(adj.has("ttl_new")).toBe(false);
    expect(adj.has("queue")).toBe(false);
  });

  it("no adjustment when the newer already ranks above", () => {
    const top = [
      { fact: newFact, score: 0.80, vec: v(1, 0), ev: Date.parse(newFact.created_at) },
      { fact: oldFact, score: 0.60, vec: v(1, 0), ev: Date.parse(oldFact.created_at) },
    ];
    expect(preferLatestAdjust(top, cos, 0.05).size).toBe(0);
  });

  it("no adjustment below the similarity floor", () => {
    // sim = 0 (orthogonal) even though numbers differ
    const top = [
      { fact: oldFact, score: 0.80, vec: v(1, 0), ev: Date.parse(oldFact.created_at) },
      { fact: newFact, score: 0.74, vec: v(0, 1), ev: Date.parse(newFact.created_at) },
    ];
    expect(preferLatestAdjust(top, cos, 0.05).size).toBe(0);
  });

  it("skips facts with missing vectors or invalid event times", () => {
    const top = [
      { fact: oldFact, score: 0.80, vec: undefined, ev: Date.parse(oldFact.created_at) },
      { fact: newFact, score: 0.74, vec: v(1, 0), ev: NaN },
    ];
    expect(preferLatestAdjust(top, cos, 0.05).size).toBe(0);
  });

  it("sanity: the cache-TTL pair carries a conflict signal at high sim", () => {
    expect(numbersDiffer(oldFact.value, newFact.value)).toBe(true);
    expect(detectConflict(oldFact, newFact, Math.max(NUMERIC_CONFLICT_SIM, 0.9))).not.toBeNull();
  });
});

describe("isSeriesPair (numeric-conflict series guard)", () => {
  it("detects templated append-only series entries (identical template, >=2 differing numbers)", () => {
    expect(isSeriesPair(
      "Work log 12: hiring pipeline status recorded for iteration 41; owners confirmed and follow-ups filed in the tracker.",
      "Work log 26: hiring pipeline status recorded for iteration 42; owners confirmed and follow-ups filed in the tracker."
    )).toBe(true);
  });

  it("does NOT treat a single-number value update as a series", () => {
    expect(isSeriesPair(
      "API rate limit is 100 requests per minute",
      "API rate limit is 400 requests per minute"
    )).toBe(false);
  });

  it("does NOT treat text-changing updates as a series", () => {
    expect(isSeriesPair(
      "Cache TTL decision: product cache entries expire after 15 minutes.",
      "Cache TTL decision: product cache entries now expire after 60 minutes to cut origin load."
    )).toBe(false);
  });

  it("series entries no longer flag as numeric_conflict", () => {
    const a = { key: "worklog_12", value: "Work log 12: vendor contract note recorded for iteration 41; owners confirmed and follow-ups filed in the tracker.", kind: "fact", created_at: daysAgo(10) };
    const b = { key: "worklog_26", value: "Work log 26: vendor contract note recorded for iteration 42; owners confirmed and follow-ups filed in the tracker.", kind: "fact", created_at: daysAgo(3) };
    expect(detectConflict(a, b, 0.97)).toBeNull();
  });

  it("single-number conflicts still flag", () => {
    const a = { key: "lim_a", value: "API rate limit is 100 requests per minute", kind: "fact", created_at: daysAgo(10) };
    const b = { key: "lim_b", value: "API rate limit is 400 requests per minute", kind: "fact", created_at: daysAgo(1) };
    expect(detectConflict(a, b, 0.95)?.reason).toBe("numeric_conflict");
  });
});

describe("tightened numeric_conflict (S1 boilerplate guard)", () => {
  it("cross-topic boilerplate notes do NOT flag despite high sim", () => {
    const filler = "the change was applied across hub/main.py and the frontend route, verified against the staging compose stack.";
    const a = { key: "n1", value: "decided hub handler worktree path resolution — detail 3: " + filler, kind: "fact", created_at: daysAgo(9) };
    const b = { key: "n2", value: "confirmed docker compose port collision — detail 7: " + filler, kind: "fact", created_at: daysAgo(2) };
    expect(detectConflict(a, b, 0.93)).toBeNull();
  });

  it("marked update on ONE side still flags (cache-TTL shape)", () => {
    const a = { key: "c1", value: "Cache TTL decision: product cache entries expire after 15 minutes.", kind: "fact", created_at: daysAgo(25) };
    const b = { key: "c2", value: "Cache TTL decision: product cache entries now expire after 60 minutes to cut origin load.", kind: "fact", created_at: daysAgo(4) };
    expect(detectConflict(a, b, 0.95)?.reason).toBe("numeric_conflict");
  });

  it("same template with one changed number still flags (retry-limit shape)", () => {
    const a = { key: "r1", value: "Order webhook retry limit is 3 attempts", kind: "fact", created_at: daysAgo(9) };
    const b = { key: "r2", value: "Order webhook retry limit is 8 attempts", kind: "fact", created_at: daysAgo(1) };
    expect(detectConflict(a, b, 0.96)?.reason).toBe("numeric_conflict");
  });
});

describe("diffNumberIsQuantity (enumerator vs quantity)", () => {
  it("quantity followed by unit word → true", () => {
    expect(diffNumberIsQuantity("retry limit is 3 attempts", "retry limit is 8 attempts")).toBe(true);
  });
  it("enumerator followed by punctuation → false", () => {
    expect(diffNumberIsQuantity("note — detail 3: applied the change", "note — detail 7: applied the change")).toBe(false);
  });
  it("mature-fixture-style boilerplate pair does not flag", () => {
    const filler = "the change was applied across hub/main.py, verified against the staging compose stack, and follow-ups were recorded.";
    const a = { key: "m1", value: "measured pulse animation on merge events — detail 15: " + filler, kind: "fact", created_at: new Date(Date.now() - 9 * 86400e3).toISOString() };
    const b = { key: "m2", value: "measured pulse animation on merge events — detail 87: " + filler, kind: "fact", created_at: new Date(Date.now() - 2 * 86400e3).toISOString() };
    expect(detectConflict(a, b, 0.98)).toBeNull();
  });
});

describe("per-branch numeric floors (S1 calibrated)", () => {
  const gwOld = { key: "g1", value: "Gateway request timeout is 30 seconds", kind: "fact", created_at: daysAgo(9) };
  const gwNew = { key: "g2", value: "Gateway request timeout is now 90 seconds after the load-test results", kind: "fact", created_at: daysAgo(1) };
  it("marked update flags at measured clause-diluted sim (0.84, 0.80)", () => {
    expect(detectConflict(gwOld, gwNew, 0.8413)?.reason).toBe("numeric_conflict");
    expect(detectConflict(gwOld, gwNew, 0.7971)?.reason).toBe("numeric_conflict");
  });
  it("marked update still requires the scan candidate floor", () => {
    expect(detectConflict(gwOld, gwNew, 0.55)).toBeNull();
  });
  it("bare template branch keeps the strict floor", () => {
    const a = { key: "r1", value: "Order webhook retry limit is 3 attempts", kind: "fact", created_at: daysAgo(9) };
    const b = { key: "r2", value: "Order webhook retry limit is 8 attempts", kind: "fact", created_at: daysAgo(1) };
    expect(detectConflict(a, b, 0.80)).toBeNull();
    expect(detectConflict(a, b, 0.90)?.reason).toBe("numeric_conflict");
  });
});
