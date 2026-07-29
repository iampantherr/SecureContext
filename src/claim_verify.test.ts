/**
 * Tests run against THIS repository's real git history, not fixtures. A fixture
 * would only prove the code agrees with my assumptions — the failure mode that
 * produced most of this session's bugs.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { verifyClaim } from "./claim_verify.js";

const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const headSha = (() => {
  try {
    return execFileSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch { return ""; }
})();

describe("claim verification — refutes what the repo can settle", () => {
  it("verifies a real commit and a really-committed file", () => {
    if (!headSha) return;                      // not a work tree in this environment
    // Deliberately a long-committed file. The first version of this test named
    // src/claim_verify.ts — which was still UNCOMMITTED when the test ran — and
    // the verifier correctly refuted it. My own test made exactly the false claim
    // this module exists to catch, which is the best evidence it works.
    const v = verifyClaim(REPO, { commit: headSha, files: ["src/memory.ts"] });
    expect(v.refuted).toBe(0);
    expect(v.verified).toBeGreaterThanOrEqual(2);
    expect(v.ok).toBe(true);
  });

  it("REFUTES a commit that does not exist", () => {
    if (!headSha) return;
    const v = verifyClaim(REPO, { commit: "deadbee" });
    expect(v.ok).toBe(false);
    expect(v.refuted).toBe(1);
    expect(v.checks.find((c) => c.status === "refuted")!.detail).toMatch(/no such commit/i);
  });

  it("REFUTES a file that is not committed — the SF-1 defect class", () => {
    if (!headSha) return;
    const v = verifyClaim(REPO, { commit: "HEAD", files: ["reports/never_committed_xyz.md"] });
    expect(v.ok).toBe(false);
    expect(v.refuted).toBe(1);
  });
});

describe("claim verification — never upgrades unverifiable to verified", () => {
  // This is the distinction the whole module exists for. The A2A acceptance gate
  // reported PASS 42/42 on five submissions; three were later failed by a literal
  // close-out. Every one of those passes rested on assertions no gate had checked.
  it("flags a test count as UNVERIFIABLE, not verified", () => {
    const v = verifyClaim(REPO, { summary: "21/21 tests passing" });
    expect(v.verified).toBe(0);
    expect(v.unverifiable).toBeGreaterThan(0);
    expect(v.checks.every((c) => c.status !== "verified")).toBe(true);
  });

  it("flags latency, blanket passes and self-assessment separately", () => {
    const v = verifyClaim(REPO, { summary: "all ACs green, no regressions, /health in 3.3s" });
    const kinds = v.checks.filter((c) => c.status === "unverifiable").map((c) => c.detail);
    expect(kinds.some((d) => /blanket pass/.test(d))).toBe(true);
    expect(kinds.some((d) => /absence-of-regression/.test(d))).toBe(true);
    expect(kinds.some((d) => /latency/.test(d))).toBe(true);
  });

  it("an all-unverifiable claim has ZERO verified assertions", () => {
    const v = verifyClaim(REPO, { summary: "everything is green and verified end to end" });
    expect(v.verified).toBe(0);
    // ok===true only means "nothing was refuted" — it must never be read as a pass,
    // which is why the notice always names the unchecked count.
    expect(v.notice).toMatch(/CANNOT be checked/);
  });

  it("degrades to unverifiable outside a git work tree instead of passing", () => {
    const v = verifyClaim("/definitely/not/a/repo/xyz", { commit: "abc1234", files: ["a.ts"] });
    expect(v.verified).toBe(0);
    expect(v.unverifiable).toBeGreaterThan(0);
    expect(v.refuted).toBe(0);            // absence of a repo refutes nothing
  });
});
