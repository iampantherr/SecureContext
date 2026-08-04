/**
 * The project hash, for the hook family.
 * ======================================
 *
 * Mirrors `projectHash` / `normalizeProjectPath` in src/store.ts. Hooks do NOT
 * import from dist/ on purpose: they must keep working when a build is broken
 * or mid-write, which is exactly when their telemetry matters most. So this is
 * a deliberate second copy, and `project-hash.test.mjs` asserts the two agree
 * on a shared vector table — the drift is caught mechanically rather than
 * trusted not to happen.
 *
 * Why this file exists at all: the same derivation had been re-typed inline in
 * five hooks and roughly twenty-five places in src/server.ts, in two mutually
 * incompatible flavours (raw path vs realpathSync'd path). Measured consequence
 * on a live machine: RevClear and Test_Agent_Coordination each had TWO
 * databases, because a forward-slash spelling of the path hashed differently
 * from the backslash one. Memory written through one was invisible through the
 * other, with no error at any layer.
 *
 * NOTE on realpathSync: two hooks used to resolve the path first, with a
 * comment claiming it matched what the MCP server computes. It did not — the
 * server hashed the raw path. Measured across 56 projects on the author's
 * machine, realpathSync was the identity function for every one of them, so
 * dropping it changes no existing hash. It is dropped because a resolution that
 * silently disagrees with the canonical definition is worse than no resolution.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

/** Canonical spelling of a project path. Keep in step with src/store.ts. */
export function normalizeProjectPath(projectPath) {
  let s = String(projectPath ?? "");
  if (/^[a-zA-Z]:/.test(s)) s = s.replace(/\//g, "\\");
  const stripped = s.replace(/[\\/]+$/, "");
  return stripped === "" || /^[a-zA-Z]:$/.test(stripped) ? s.slice(0, stripped.length + 1) : stripped;
}

/** 16-hex-char project discriminator. Keep in step with src/store.ts. */
export function projectHash(projectPath) {
  return createHash("sha256").update(normalizeProjectPath(projectPath)).digest("hex").slice(0, 16);
}

/**
 * Repo root for a FILE (first .git walking up), falling back to the session
 * cwd. Was duplicated verbatim in preread-dedup.mjs and prewrite-impact.mjs.
 */
export function resolveProjectRoot(absPath, fallback) {
  try {
    if (!/^([a-zA-Z]:[\/]|\/)/.test(absPath)) return fallback;
    let dir = resolve(absPath, "..");
    for (let i = 0; i < 40; i++) {
      if (existsSync(join(dir, ".git"))) return dir;
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* fall through */ }
  return fallback;
}
