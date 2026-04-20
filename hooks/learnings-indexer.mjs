/**
 * PostToolUse hook — learnings-indexer (v0.17.0+)
 * =================================================================
 *
 * Mirrors JSONL writes to <project>/learnings/*.jsonl into the project's
 * SQLite `learnings` table AND (when ZC_TELEMETRY_BACKEND=postgres|dual)
 * the Postgres `learnings_pg` table, so that zc_search + zc_logs can query
 * across cross-session learnings structurally (by category, by time)
 * rather than grep'ing JSONL files. The JSONL files remain canonical —
 * this is a searchable MIRROR, idempotent on
 * (project_hash, source_path, source_line).
 *
 * v0.17.0 fixes previously-missed cases:
 *   (1) Bash appends (`echo "..." >> learnings/foo.jsonl`): earlier versions
 *       only matched Write/Edit/MultiEdit/NotebookEdit; if the agent used
 *       Bash redirection the mirror silently did nothing. Now matches Bash
 *       and greps the command for `>>` or `>` redirections to a JSONL under
 *       a learnings/ directory, then re-scans that file.
 *   (2) Postgres mirror: previously hook only wrote to SQLite. PG
 *       learnings_pg could only be populated via scripts/backfill-learnings.mjs.
 *       Now the hook writes to PG too when the backend is postgres|dual.
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
 *   matcher "Write|Edit|MultiEdit|NotebookEdit|Bash"
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

function normalizeProjectPath(projectPath) {
  // v0.17.0 — normalize to OS-native form (realpath handles slash direction +
  // case + symlinks) so the hash matches what MCP server + agents compute.
  try { return realpathSync(projectPath); }
  catch { return projectPath; }
}

function projectHash(projectPath) {
  return createHash("sha256").update(normalizeProjectPath(projectPath)).digest("hex").slice(0, 16);
}

function projectDbPath(projectPath) {
  return join(ZC_DIR, projectHash(projectPath) + ".db");
}

function categoryFromFilename(filename) {
  const stem = filename.replace(/\.jsonl$/i, "").toLowerCase();
  if (stem === "metrics")       return "metric";
  if (stem === "decisions")     return "decision";
  if (stem === "failures")      return "failure";
  if (stem === "experiments")   return "experiment";
  return "insight";
}

/**
 * SECURITY: resolve the target path and confirm it sits under
 * <project>/learnings/ even across symlinks. Returns null on any rejection.
 */
function resolveInsideLearnings(projectPath, filePath) {
  try {
    const projectReal  = realpathSync(projectPath);
    const learningsDir = resolve(projectReal, "learnings");
    const learningsDirAlt = learningsDir.endsWith(sep) ? learningsDir : learningsDir + sep;
    const target = resolve(projectReal, filePath);
    if (!existsSync(target)) return null;
    const realTarget = realpathSync(target);
    if (!(realTarget.startsWith(learningsDirAlt) || realTarget === learningsDir)) return null;
    if (!realTarget.toLowerCase().endsWith(".jsonl")) return null;
    return realTarget;
  } catch {
    return null;
  }
}

/**
 * v0.17.0 — parse a bash command and pull out any files the command
 * redirects into (`>> path` or `> path` forms). Only returns paths that
 * look like they sit inside a learnings/ directory and end in .jsonl.
 * Paths are returned relative-or-absolute as they appear in the command;
 * the caller still runs them through `resolveInsideLearnings` for the
 * security check.
 */
function extractLearningsTargetsFromBash(command) {
  if (!command || typeof command !== "string") return [];
  const out = new Set();
  // `>> path` or `> path` (not `2>&1` etc). Path can be quoted or bare.
  // We're intentionally permissive — resolveInsideLearnings is the security gate.
  const re = /(?:^|[^0-9&>])>>?\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    const path = m[1] || m[2] || m[3];
    if (!path) continue;
    // Fast reject: must contain "learnings" + end in .jsonl
    if (!/learnings[\\/][^\\/]+\.jsonl$/i.test(path)) continue;
    out.add(path);
  }
  return [...out];
}

/**
 * Upsert each line from the JSONL file as a learning row in SQLite.
 * Returns the count of newly-indexed lines AND the rows themselves so
 * the caller can mirror to PG.
 */
function indexJsonlFileSqlite(db, projectPath, realTarget) {
  let content;
  try {
    content = readFileSync(realTarget, "utf8");
  } catch {
    return { inserted: 0, rows: [] };
  }
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

  const lines = content.split(/\r?\n/);
  const ph = projectHash(projectPath);
  const sourceRel = "learnings/" + basename(realTarget);
  const now = new Date().toISOString();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO learnings
      (learning_id, project_hash, category, payload, source_path, source_line, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const category = categoryFromFilename(basename(realTarget));
  let inserted = 0;
  const insertedRows = [];
  const cap = Math.min(lines.length, MAX_LINES_PER_RUN);

  for (let i = 0; i < cap; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const payload = Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES
      ? line.slice(0, MAX_LINE_BYTES)
      : line;
    const lineNum = i + 1;
    try {
      const learningId = `learn-${randomUUID().slice(0, 12)}`;
      const result = insertStmt.run(learningId, ph, category, payload, sourceRel, lineNum, now);
      if (result.changes > 0) {
        inserted++;
        insertedRows.push({ learningId, ph, category, payload, sourceRel, lineNum, ts: now });
      }
    } catch {
      // skip the problem row; continue
    }
  }
  return { inserted, rows: insertedRows };
}

/**
 * v0.17.0 — mirror newly-inserted rows to Postgres learnings_pg.
 * Only runs when ZC_TELEMETRY_BACKEND is postgres|dual. Silent on errors
 * (PG unavailable → SQLite mirror still landed; backfill script is still
 * available as a manual catch-up).
 */
async function mirrorToPostgres(rows) {
  if (rows.length === 0) return;
  const backend = (process.env.ZC_TELEMETRY_BACKEND || "sqlite").toLowerCase();
  if (backend !== "postgres" && backend !== "dual") return;
  const debug = process.env.ZC_HOOK_DEBUG === "1";
  if (debug) console.error(`[learnings-indexer] mirrorToPostgres rows=${rows.length} backend=${backend}`);
  let pool;
  try {
    // Hook runs from ~/.claude/hooks/ which doesn't have its own node_modules.
    // Try bare import first (works when SC is installed as a global npm package
    // or when NODE_PATH is set), then fall back to the SecureContext repo's
    // node_modules via ZC_REPO_DIR env var, then a couple of well-known paths.
    let pg;
    try {
      pg = await import("pg");
    } catch {
      const candidates = [];
      if (process.env.ZC_REPO_DIR) candidates.push(join(process.env.ZC_REPO_DIR, "node_modules/pg/lib/index.js"));
      candidates.push(join(homedir(), "AI_projects/SecureContext/node_modules/pg/lib/index.js"));
      candidates.push("C:/Users/Amit/AI_projects/SecureContext/node_modules/pg/lib/index.js");
      for (const p of candidates) {
        if (!existsSync(p)) continue;
        try { pg = await import("file:///" + p.replace(/\\/g, "/")); break; } catch { /* try next */ }
      }
      if (!pg) {
        if (debug) console.error(`[learnings-indexer] pg module not resolvable from any known path; PG mirror skipped`);
        return;
      }
    }
    const Pool = pg.Pool || (pg.default && pg.default.Pool);
    if (!Pool) {
      if (debug) console.error(`[learnings-indexer] could not resolve Pool constructor; keys=${Object.keys(pg)}`);
      return;
    }
    pool = new Pool({
      host:     process.env.ZC_POSTGRES_HOST     || "localhost",
      port:     Number(process.env.ZC_POSTGRES_PORT || 5432),
      user:     process.env.ZC_POSTGRES_USER     || "scuser",
      password: process.env.ZC_POSTGRES_PASSWORD || "",
      database: process.env.ZC_POSTGRES_DB       || "securecontext",
      max: 2,
      idleTimeoutMillis: 5_000,
    });
    let mirrored = 0;
    for (const r of rows) {
      try {
        const res = await pool.query(
          `INSERT INTO learnings_pg (learning_id, project_hash, category, payload, source_path, source_line, ts)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (project_hash, source_path, source_line) DO NOTHING`,
          [r.learningId, r.ph, r.category, r.payload, r.sourceRel, r.lineNum],
        );
        if (res.rowCount > 0) mirrored++;
      } catch (e) {
        if (debug) console.error(`[learnings-indexer] PG insert failed for ${r.sourceRel}:${r.lineNum} — ${e.message}`);
      }
    }
    if (debug) console.error(`[learnings-indexer] mirrored ${mirrored}/${rows.length} rows to PG`);
  } catch (e) {
    if (debug) console.error(`[learnings-indexer] mirrorToPostgres top-level error: ${e.message}`);
  } finally {
    try { await pool?.end(); } catch { /* noop */ }
  }
}

/** Open SQLite DB, verify schema, run the indexer, return newly-inserted rows. */
function indexOneFile(projectPath, realTarget) {
  const dbPath = projectDbPath(projectPath);
  if (!existsSync(dbPath)) return { inserted: 0, rows: [] };
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 3000");
    const tbl = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='learnings'`
    ).get();
    if (!tbl) { db.close(); return { inserted: 0, rows: [] }; }
    const result = indexJsonlFileSqlite(db, projectPath, realTarget);
    db.close();
    return result;
  } catch {
    try { db?.close(); } catch { /* noop */ }
    return { inserted: 0, rows: [] };
  }
}

async function main() {
  let raw = "";
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) raw += line + "\n";

  let event;
  try { event = JSON.parse(raw); } catch { process.exit(0); }

  const toolName = event?.tool_name ?? event?.toolName ?? "";
  const toolInput = event?.tool_input ?? event?.arguments ?? {};
  const projectPath = event?.cwd ?? process.cwd();

  // Collect candidate file paths based on tool type.
  const candidates = [];

  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) {
    const filePath = toolInput?.file_path ?? toolInput?.path ?? null;
    if (typeof filePath === "string" && /[\\/]learnings[\\/]/i.test(filePath) && /\.jsonl$/i.test(filePath)) {
      candidates.push(filePath);
    }
  } else if (toolName === "Bash") {
    // v0.17.0 — parse the bash command for learnings/*.jsonl redirection targets
    const command = toolInput?.command ?? "";
    const paths = extractLearningsTargetsFromBash(command);
    for (const p of paths) candidates.push(p);
  } else {
    process.exit(0);
  }

  if (candidates.length === 0) process.exit(0);

  // Process each candidate; collect all newly-inserted rows for PG mirror.
  const allRows = [];
  for (const filePath of candidates) {
    const realTarget = resolveInsideLearnings(projectPath, filePath);
    if (!realTarget) continue;
    const { rows } = indexOneFile(projectPath, realTarget);
    allRows.push(...rows);
  }

  // v0.17.0 — also mirror to Postgres when telemetry backend is postgres|dual
  if (allRows.length > 0) {
    await mirrorToPostgres(allRows);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
