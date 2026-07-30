/**
 * Drift guard: nothing may re-derive the project hash inline.
 *
 * The consolidation this protects was not cosmetic. Before it, sha256(path)
 * .slice(0,16) had been re-typed in 28 places in server.ts, 7 in hooks/, and
 * dozens more in scripts and tests — in two incompatible flavours (raw path vs
 * realpathSync'd). The measured result on a live machine was two projects with
 * TWO databases each, where memory written through one path spelling was
 * invisible through the other, and nothing anywhere raised an error.
 *
 * A comment asking people not to do it again would not have held. This fails
 * the build instead.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC  = dirname(fileURLToPath(import.meta.url));
const REPO = join(SRC, "..");

/**
 * sha256 of something path-shaped, truncated to the project-hash width.
 *
 * The leading identifier is deliberately ANY name, not the literal `createHash`.
 * The first version of this pattern required `createHash(` and therefore matched
 * none of the 28 copies it was written to prevent — every one of them called the
 * function through a locally aliased dynamic import (`ch`, `chB`, `rcCh`,
 * `slHash`, …). It passed cleanly against an injected violation, which is how
 * the hole was found: a guard is only worth its assertion once you have watched
 * it fail.
 */
const INLINE_HASH =
  /[A-Za-z_$][A-Za-z0-9_$]*\(\s*["']sha256["']\s*\)\s*\.update\(\s*[^)]*(?:PROJECT_PATH|projectPath|projectPathArg|pPath)[^)]*\)\s*\.digest\(\s*["']hex["']\s*\)\s*\.(?:slice|substring|substr)\(\s*0\s*,\s*16\s*\)/;

/** Files allowed to contain the derivation. */
const CANONICAL = new Set([
  "src/store.ts",                 // the definition
  "hooks/_project-hash.mjs",      // the hook-family mirror, drift-checked by hooks/project-hash.test.mjs
]);

/**
 * Test and throwaway-script copies that predate the consolidation. They derive a
 * hash to locate a database file, so a divergence here means a test silently
 * inspects the wrong DB rather than failing.
 *
 * Frozen deliberately: the guard below asserts this set does not GROW. Shrinking
 * it is welcome; anything new must use the canonical helper.
 *
 * MEASURED, not estimated: 25 files at the time of the consolidation — 16 in
 * scripts/, 8 test files in src/, 1 in security-tests/. A generous ceiling here
 * would let the problem double before anything complained, which is how the
 * original 28-copy cluster accumulated.
 */
const KNOWN_LEGACY_COUNT = 25;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

const offenders = walk(REPO)
  .map((abs) => ({ rel: relative(REPO, abs).split("\\").join("/"), abs }))
  .filter(({ rel }) => !CANONICAL.has(rel))
  .filter(({ abs }) => INLINE_HASH.test(readFileSync(abs, "utf8")));

const isProduction = (rel: string) =>
  (rel.startsWith("src/") || rel.startsWith("hooks/")) && !/\.test\.(ts|mjs)$/.test(rel);

describe("project hash — single definition", () => {
  it("has no inline derivation anywhere in production code", () => {
    const bad = offenders.map((o) => o.rel).filter(isProduction).sort();
    expect(bad, `Use projectHash() from src/store.ts (or hooks/_project-hash.mjs in hooks). ` +
      `A second copy is free to disagree about the input and nothing reports it.`).toEqual([]);
  });

  it("does not let the legacy test/script copies grow", () => {
    // Not zero, and saying so plainly: these are pre-existing and lower risk,
    // but they must not multiply. Reporting the real number beats pretending
    // the codebase is clean.
    expect(offenders.length).toBeLessThanOrEqual(KNOWN_LEGACY_COUNT);
  });
});
