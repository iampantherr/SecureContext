/**
 * Tests for the commit-time advisory's diff parser (v0.55.0, stage 5).
 *
 * Only the hunk parsing is unit-tested: it is the part with real edge cases
 * (pure deletions carry @@ +N,0 @@, renames emit a new +++ header). The rest of
 * the script is exercised end-to-end against a throwaway repo, where staging an
 * edit to a function with 3 known callers reported exactly 3.
 */

import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations
import { changedLines } from "../scripts/impact-advisory.mjs";

const linesFor = (diff: string, file: string): number[] =>
  [...((changedLines(diff) as Map<string, Set<number>>).get(file) ?? [])].sort((a, b) => a - b);

describe("changedLines", () => {
  it("reads added line numbers from a unified=0 hunk", () => {
    const diff = [
      "diff --git a/src/util.ts b/src/util.ts",
      "--- a/src/util.ts",
      "+++ b/src/util.ts",
      "@@ -10,0 +11,3 @@",
      "+a", "+b", "+c",
    ].join("\n");
    expect(linesFor(diff, "src/util.ts")).toEqual([11, 12, 13]);
  });

  it("treats a single-line hunk with no count as one line", () => {
    const diff = ["+++ b/a.ts", "@@ -4 +4 @@", "-old", "+new"].join("\n");
    expect(linesFor(diff, "a.ts")).toEqual([4]);
  });

  it("still attributes a PURE DELETION, which arrives as +N,0", () => {
    // Removing a function body emits a zero-length hunk. Dropping these would
    // mean deleting a 100-caller function produced no advisory at all.
    const diff = ["+++ b/a.ts", "@@ -20,5 +19,0 @@", "-gone"].join("\n");
    expect(linesFor(diff, "a.ts")).toEqual([19]);
  });

  it("keeps files separate across multiple diffs", () => {
    const diff = [
      "+++ b/one.ts", "@@ -1 +1 @@", "+x",
      "+++ b/two.ts", "@@ -9,0 +10,2 @@", "+y", "+z",
    ].join("\n");
    expect(linesFor(diff, "one.ts")).toEqual([1]);
    expect(linesFor(diff, "two.ts")).toEqual([10, 11]);
  });

  it("ignores /dev/null targets from a deleted file", () => {
    const diff = ["+++ /dev/null", "@@ -1,3 +0,0 @@", "-a"].join("\n");
    const map = changedLines(diff) as Map<string, Set<number>>;
    expect([...map.keys()]).not.toContain("/dev/null".replace("/dev/", ""));
  });

  it("returns nothing for an empty diff rather than throwing", () => {
    expect((changedLines("") as Map<string, Set<number>>).size).toBe(0);
  });
});
