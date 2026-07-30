#!/usr/bin/env node
/**
 * Commit-time impact advisory (v0.55.0, stage 5)
 * ==============================================
 *
 * Reads the staged diff, works out which FUNCTIONS the changed lines belong to,
 * and reports who calls them. The point is the moment: an agent about to commit
 * a change to a 126-caller helper should learn that before the commit, not from
 * a caller breaking later.
 *
 * ADVISORY, NEVER BLOCKING. Exit code is always 0, including on internal
 * errors. High fan-in is a fact about a codebase, not a defect, and a gate that
 * fires on facts gets disabled within a week — after which it protects nothing.
 * The only thing this is allowed to do is tell you something true.
 *
 * Usage:
 *   node scripts/impact-advisory.mjs                 # staged changes
 *   node scripts/impact-advisory.mjs --ref HEAD~1    # a previous commit
 *   node scripts/impact-advisory.mjs --threshold 5   # only report fan-in >= N
 *
 * As a pre-commit hook (opt-in, still non-blocking):
 *   echo 'node scripts/impact-advisory.mjs' >> .git/hooks/pre-commit
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where SecureContext itself is installed — the modules this script imports. */
const DIST = join(HERE, "..", "dist");

/**
 * The repository being committed to, resolved from the CURRENT DIRECTORY.
 *
 * Not from this script's location. Installed as a pre-commit hook in another
 * project, deriving the repo from the script path made it analyse SecureContext
 * and report SecureContext's callers for somebody else's commit — a confident
 * answer about entirely the wrong codebase.
 */
function resolveRepo() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return join(HERE, "..");
  }
}
const REPO = resolveRepo();

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const THRESHOLD = Number(argOf("--threshold", "1"));
const REF = argOf("--ref", null);

const git = (...args) =>
  execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Changed line numbers per file, from a unified=0 diff. Exported for tests. */
export function changedLines(diff) {
  const byFile = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) { file = f[1]; if (!byFile.has(file)) byFile.set(file, new Set()); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      // count === 0 means a pure deletion at this point; attribute it to the
      // surrounding line so removing a function body is still reported.
      for (let i = 0; i < Math.max(count, 1); i++) byFile.get(file).add(start + i);
    }
  }
  return byFile;
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

async function main() {
  if (!existsSync(join(DIST, "indexing", "call_graph.js"))) {
    console.log("[impact] dist/ not built — skipping advisory (run `npm run build`).");
    return;
  }

  const diff = REF
    ? git("diff", "--unified=0", `${REF}~1`, REF)
    : git("diff", "--cached", "--unified=0");

  const byFile = changedLines(diff);
  const files = [...byFile.keys()].filter((f) => SOURCE.test(f) && !/\.test\.(ts|mjs)$/.test(f));
  if (files.length === 0) return;   // nothing worth saying

  const { extractFileCalls } = await import(pathToFileURL(join(DIST, "indexing", "call_graph.js")).href);
  const { getSymbolImpact, getFileImpact, HIGH_FAN_IN } =
    await import(pathToFileURL(join(DIST, "indexing", "call_edges.js")).href);
  const { openDb } = await import(pathToFileURL(join(DIST, "knowledge.js")).href);

  const db = openDb(REPO);
  try {
    // A layer that was never built must not be reported as "nothing depends on
    // this" — the advisory says so and stops, rather than reassuring falsely.
    if (!getFileImpact(db, files[0]).built) {
      console.log("[impact] call graph not built for this project — no advisory. " +
                  "Run zc_index_project or zc_graph_rebuild to enable it.");
      return;
    }

    const touched = [];
    for (const file of files) {
      const abs = join(REPO, file);
      if (!existsSync(abs)) continue;                 // deleted file
      const parsed = await extractFileCalls(readFileSync(abs, "utf8"), file);
      if (!parsed) continue;
      const lines = byFile.get(file);
      for (const d of parsed.decls) {
        let hit = false;
        for (const l of lines) { if (l >= d.line && l <= d.endLine) { hit = true; break; } }
        if (hit) touched.push({ file, symbol: d.symbol });
      }
    }

    const findings = [];
    for (const t of touched) {
      const impacts = getSymbolImpact(db, t.symbol).filter((i) => i.declaredIn === t.file);
      for (const i of impacts) {
        if (i.callers < THRESHOLD) continue;
        findings.push({ ...t, ...i });
      }
    }

    if (findings.length === 0) {
      if (touched.length > 0) {
        console.log(`[impact] ${touched.length} changed function(s), none with recorded callers. ` +
                    `Note that dynamic dispatch and cross-repo callers are not all visible.`);
      }
      return;
    }

    findings.sort((a, b) => b.callers - a.callers);
    console.log("");
    console.log("─".repeat(70));
    console.log("  IMPACT ADVISORY — functions in this change that others call");
    console.log("─".repeat(70));
    for (const f of findings) {
      const high = f.callers >= HIGH_FAN_IN ? "   ⚠ HIGH FAN-IN" : "";
      console.log(`  ${f.symbol}()  [${f.file}]`);
      console.log(`      ← ${f.callers} caller${f.callers === 1 ? "" : "s"} in ` +
                  `${f.files.length} file${f.files.length === 1 ? "" : "s"} ` +
                  `(${f.sites} call site${f.sites === 1 ? "" : "s"})${high}`);
      console.log(`      ${f.files.slice(0, 5).join(", ")}${f.files.length > 5 ? `, +${f.files.length - 5} more` : ""}`);
    }
    console.log("─".repeat(70));
    console.log("  Advisory only — nothing is blocked. Verify the callers still hold.");
    console.log("");
  } finally {
    db.close();
  }
}

// Only run when invoked directly, so tests can import changedLines().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // Never fail a commit because the advisory broke.
    console.log(`[impact] advisory skipped: ${String(e).slice(0, 160)}`);
  });
}
