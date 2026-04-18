/**
 * PostToolUse hook — learnings-indexer (v0.11.0 Sprint 1 Phase D)
 * =================================================================
 *
 * Mirrors JSONL writes to <project>/learnings/*.jsonl into the project's
 * SQLite `learnings` table so that zc_search + zc_logs can query across
 * cross-session learnings structurally (by category, by time) rather than
 * grep'ing JSONL files. The JSONL files remain canonical — this is a
 * searchable MIRROR, idempotent on (project_hash, source_path, source_line).
 *
 * Categories are inferred from the filename stem:
 *   learnings/metrics.jsonl        -> category = "metric"
 *   learnings/decisions.jsonl      -> category = "decision"
 *   learnings/failures.jsonl       -> category = "failure"
 *   learnings/insights.jsonl       -> category = "insight"
 *   learnings/experiments.jsonl    -> category = "experiment"
 *   learnings/customer-insights.jsonl -> category = "insight"
 *   learnings/cross-project.jsonl  -> category = "insight"
 *   (anything else)                -> category = "insight"
 *
 * SECURITY INVARIANTS (per §15.4 Sprint 1):
 *   1. NEVER writes outside ~/.claude/zc-ctx/sessions/<hash>.db
 *   2. NEVER follows symlinks out of the project directory (resolves + prefix check)
 *   3. Raw payload stored verbatim (intentional: JSONL lines are already
 *      project-authored and shape-bounded); bytewise capped at 64 KB / line
 *   4. UNIQUE(project_hash, source_path, source_line) ensures no duplicate
 *      rows even if the hook fires twice on the same file
 *   5. Hook MUST NEVER crash Claude Code — all errors swallowed
 *
 * Install:
 *   Copy this file to ~/.claude/hooks/learnings-indexer.mjs
 *   Register in ~/.claude/settings.json under hooks.PostToolUse with
 *   matcher "Write|Edit|MultiEdit|NotebookEdit"
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, join, basename, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const MAX_LINE_BYTES      = 64 * 1024;      // 64 KB per JSONL line cap
const MAX_LINES_PER_RUN   = 10_000;         // defensive cap on file growth
const ZC_DIR              = join(homedir(), ".claude", "zc-ctx", "sessions");

function projectHash(projectPath) {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

function projectDbPath(projectPath) {
  return join(ZC_DIR, projectHash(projectPath) + ".db");
}

function categoryFromFilename(filename) {
  // filename e.g. "metrics.jsonl", "customer-insights.jsonl"
  const stem = filename.replace(/\.jsonl$/i, "").toLowerCase();
  if (stem === "metrics")       return "metric";
  if (stem === "decisions")     return "decision";
  if (stem === "failures")      return "failure";
  if (stem === "experiments")   return "experiment";
  // insights + customer-insights + cross-project + anything else
  return "insight";
}

/**
 * SECURITY: resolve the target path and confirm it sits under
 * <project>/learnings/ even across symlinks. Returns null on any
 * rejection — no throw, no logging of untrusted paths.
 */
function resolveInsideLearnings(projectPath, filePath) {
  try {
    const absTarget = resolve(filePath);
    // Resolve symlinks — if the target points outside the project we reject
    const realTarget  = existsSync(absTarget) ? realpathSync(absTarget) : absTarget;
    const realProject = existsSync(projectPath) ? realpathSync(projectPath) : resolve(projectPath);

    const learningsDir = realProject + sep + "learnings" + sep;
    const learningsDirAlt = realProject + sep + "learnings";
    // Must live inside <project>/learnings/ and be .jsonl
    if (!(realTarget.startsWith(learningsDir) || realTarget === learningsDirAlt)) return null;
    if (!realTarget.toLowerCase().endsWith(".jsonl")) return null;
    return realTarget;
  } catch {
    return null;
  }
}

/**
 * Upsert each line from the JSONL file as a learning row. Returns the
 * count of newly-indexed lines (existing rows are skipped via UNIQUE).
 */
function indexJsonlFile(db, projectPath, realTarget) {
  let content;
  try {
    content = readFileSync(realTarget, "utf8");
  } catch {
    return 0;
  }
  // Strip BOM
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

  const lines = content.split(/\r?\n/);
  const ph = projectHash(projectPath);
  // Relative source_path for stable dedup across workspaces
  const sourceRel = "learnings/" + basename(realTarget);

  const now = new Date().toISOString();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO learnings
      (learning_id, project_hash, category, payload, source_path, source_line, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const category = categoryFromFilename(basename(realTarget));
  let inserted = 0;
  const cap = Math.min(lines.length, MAX_LINES_PER_RUN);

  for (let i = 0; i < cap; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    // Bytewise cap to defend against pathological JSONL rows
    const payload = Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES
      ? line.slice(0, MAX_LINE_BYTES)
      : line;
    const lineNum = i + 1;   // 1-indexed to match editor UX
    try {
      const result = insertStmt.run(
        `learn-${randomUUID().slice(0, 12)}`,
        ph,
        category,
        payload,
        sourceRel,
        lineNum,
        now,
      );
      if (result.changes > 0) inserted++;
    } catch {
      // swallow — row might violate schema; next rows must still run
    }
  }
  return inserted;
}

async function main() {
  // Read hook payload
  let raw = "";
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) raw += line + "\n";

  let event;
  try { event = JSON.parse(raw); } catch { process.exit(0); }

  const toolName = event?.tool_name ?? event?.toolName ?? "";
  const toolInput = event?.tool_input ?? event?.arguments ?? {};
  const projectPath = event?.cwd ?? process.cwd();

  // Only Write/Edit/MultiEdit/NotebookEdit matter here
  if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) process.exit(0);

  const filePath = toolInput?.file_path ?? toolInput?.path ?? null;
  if (!filePath || typeof filePath !== "string") process.exit(0);

  // Quick reject: must contain "learnings" segment + end with .jsonl
  if (!/[\\/]learnings[\\/]/i.test(filePath) || !/\.jsonl$/i.test(filePath)) process.exit(0);

  // Security-gated path resolve
  const realTarget = resolveInsideLearnings(projectPath, filePath);
  if (!realTarget) process.exit(0);

  // DB must exist — don't initialize one just to index learnings
  const dbPath = projectDbPath(projectPath);
  if (!existsSync(dbPath)) process.exit(0);

  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 3000");
    // Schema presence check — bail if learnings table not there
    const tbl = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='learnings'`
    ).get();
    if (!tbl) {
      db.close();
      process.exit(0);
    }
    indexJsonlFile(db, projectPath, realTarget);
    db.close();
  } catch {
    try { db?.close(); } catch {}
    // never crash Claude
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
