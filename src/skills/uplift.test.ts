import { describe, it, expect } from "vitest";
import { upliftHeadline, parseUpliftSegment, type UpliftResult } from "./uplift.js";

describe("v0.61.0 M3e — uplift headline round-trip", () => {
  it("dual-set ab uplift round-trips with per-set deltas in the basis", () => {
    const u: UpliftResult = {
      kind: "ab", skill: 0.85, bare: 0.43, delta: 0.42,
      basis: "blind Δ+0.30 / informed Δ+0.54",
      rationale: "equal-weight avg of two held-out scenario sets",
    };
    const h = "promote-worthy (…)" + upliftHeadline(u);
    const p = parseUpliftSegment(h);
    expect(p).not.toBeNull();
    expect(p!.skill).toBeCloseTo(0.85);
    expect(p!.bare).toBeCloseTo(0.43);
    expect(p!.delta).toBeCloseTo(0.42);
    expect(p!.basis).toBe("blind Δ+0.30 / informed Δ+0.54");
    expect(p!.low).toBe(false);
  });

  it("low-uplift flag survives the round-trip", () => {
    const u: UpliftResult = { kind: "ab", skill: 0.5, bare: 0.48, delta: 0.02, basis: "blind Δ+0.01 / informed Δ+0.03", rationale: "" };
    const p = parseUpliftSegment("x" + upliftHeadline(u));
    expect(p!.low).toBe(true);
  });

  it("judge-rating fallback parses with null bare/delta", () => {
    const u: UpliftResult = { kind: "judge", skill: 0.85, rationale: "" };
    const p = parseUpliftSegment("x" + upliftHeadline(u));
    expect(p!.skill).toBeCloseTo(0.85);
    expect(p!.bare).toBeNull();
    expect(p!.delta).toBeNull();
  });

  it("headline without an uplift segment parses to null", () => {
    expect(parseUpliftSegment("promote-worthy (delta 0.3) — judge best 0.9")).toBeNull();
  });
});
