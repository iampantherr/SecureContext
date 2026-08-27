import { describe, it, expect } from "vitest";
import { buildThreatReviewPrompt, parseThreatReview, threatHeadline } from "./threat_review.js";

describe("v0.63.0 V2 — threat review", () => {
  it("prompt names the abuse lens, not capability, and includes the body", () => {
    const p = buildThreatReviewPrompt("deploy-skill", "Deploys the app", "# Steps\n1. run tests\n");
    expect(p).toMatch(/threat-modeling a SKILL DOCUMENT/);
    expect(p).toMatch(/abuse potential, not capability/);
    expect(p).toMatch(/run tests/);
  });

  it("parses all three risk levels", () => {
    expect(parseThreatReview('{"risk":"low","rationale":"fine"}').risk).toBe("low");
    expect(parseThreatReview('{"risk":"medium","rationale":"broad"}').risk).toBe("medium");
    expect(parseThreatReview('{"risk":"high","rationale":"exfil step 4"}').risk).toBe("high");
  });

  it("unknown risk value degrades to medium, never silently to low", () => {
    expect(parseThreatReview('{"risk":"critical","rationale":"x"}').risk).toBe("medium");
    expect(parseThreatReview('{"rationale":"missing risk"}').risk).toBe("medium");
  });

  it("tolerates fence-wrapped prose responses (extractJsonPayload path)", () => {
    const wrapped = 'Here is my verdict:\n```json\n{"risk":"high","rationale":"fetches and executes remote code"}\n```\nDone.';
    const v = parseThreatReview(wrapped);
    expect(v.risk).toBe("high");
    expect(v.rationale).toMatch(/remote code/);
  });

  it("headline: high flags loudly, medium quietly, low and null are silent", () => {
    expect(threatHeadline({ risk: "high", rationale: "exfiltrates env vars in step 3" })).toMatch(/⚠ ABUSE-RISK\[high\]/);
    expect(threatHeadline({ risk: "medium", rationale: "overbroad permissions" })).toMatch(/abuse-review medium/);
    expect(threatHeadline({ risk: "low", rationale: "" })).toBe("");
    expect(threatHeadline(null)).toBe("");
  });

  it("rationale is capped", () => {
    const v = parseThreatReview(JSON.stringify({ risk: "high", rationale: "x".repeat(1000) }));
    expect(v.rationale.length).toBeLessThanOrEqual(300);
  });
});
