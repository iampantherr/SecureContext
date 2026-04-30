#!/usr/bin/env node
/**
 * v0.18.9 — One-shot migration: copy historical telemetry from per-session
 * SQLite DBs into the centralized Postgres `tool_calls_pg`.
 *
 * Why: prior to v0.18.9, every Claude Code session wrote telemetry into a
 * project-scoped SQLite at `~/.claude/zc-ctx/sessions/<hash>.db`. The
 * dashboard reads from PG, so months of operator activity is invisible.
 *
 * What this does:
 *   1. Walks `~/.claude/zc-ctx/sessions/*.db`
 *   2. For each, runs the SQLite migrations idempotently (auto-heals stale
 *      schemas — DBs missing the `id` column from a forgotten migration)
 *   3. Reads ALL `tool_calls` rows
 *   4. Computes a per-row project_hash based on the DB filename (which equals
 *      the project hash by convention)
 *   5. UPSERTs into `tool_calls_pg` (skips duplicates by call_id UNIQUE)
 *   6. Also populates `project_paths_pg` if a path mapping is available via
 *      A2A_dispatcher/data/agents.json
 *
 * Idempotent: re-running is safe. Already-imported rows are skipped via
 * `ON CONFLICT (call_id) DO NOTHING`.
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-pg.mjs [--dry-run] [--limit=N]
 *
 * Env required:
 *   ZC_POSTGRES_HOST, ZC_POSTGRES_PORT, ZC_POSTGRES_USER,
 *   ZC_POSTGRES_PASSWORD, ZC_POSTGRES_DB
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import pg from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARG = process.argv.find((a) => a.startsWith("--limit="));
const ROW_LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split("=")[1], 10) : Infinity;
const SESSIONS_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");
const AGENTS_JSON  = join(homedir(), "AI_projects", "A2A_dispatcher", "data", "agents.json");

console.log(`v0.18.9 SQLite → Postgres telemetry recovery`);
console.log(`  sessions dir: ${SESSIONS_DIR}`);
console.log(`  dry run:      ${DRY_RUN}`);
console.log(`  row limit:    ${Number.isFinite(ROW_LIMIT) ? ROW_LIMIT : "(none)"}`);

if (!existsSync(SESSIONS_DIR)) {
  console.log("\nNo session DB directory found — nothing to migrate.");
  process.exit(0);
}

// ── Build hash → path map from agents.json (best-effort) ─────────────────
const pathMap = new Map();
if (existsSync(AGENTS_JSON)) {
  try {
    const reg = JSON.parse(readFileSync(AGENTS_JSON, "utf-8"));
    for (const [hash, entry] of Object.entries(reg)) {
      const p = entry?._meta?.projectPath;
      if (typeof p === "string" && p) pathMap.set(hash, p);
    }
    console.log(`  resolved ${pathMap.size} project paths from agents.json`);
  } catch (e) {
    console.log(`  (couldn't parse agents.json: ${e.message})`);
  }
}

// ── Connect to PG ────────────────────────────────────────────────────────
const client = new pg.Client({
  host:     process.env.ZC_POSTGRES_HOST     || "localhost",
  port:     parseInt(process.env.ZC_POSTGRES_PORT || "5432", 10),
  user:     process.env.ZC_POSTGRES_USER     || "scuser",
  password: process.env.ZC_POSTGRES_PASSWORD || "",
  database: process.env.ZC_POSTGRES_DB       || "securecontext",
});
await client.connect();
console.log(`  PG connected as ${process.env.ZC_POSTGRES_USER || "scuser"}\n`);

// ── Walk session DBs ─────────────────────────────────────────────────────
const dbFiles = readdirSync(SESSIONS_DIR)
  .filter((f) => f.endsWith(".db"))
  .sort();

console.log(`Found ${dbFiles.length} session DBs.\n`);

const stats = {
  scanned: 0,
  schema_healed: 0,
  schema_failed: 0,
  rows_total: 0,
  rows_inserted: 0,
  rows_skipped_duplicate: 0,
  rows_failed: 0,
  paths_registered: 0,
};

let rowsProcessed = 0;

for (const fname of dbFiles) {
  if (rowsProcessed >= ROW_LIMIT) break;
  stats.scanned++;
  const full = join(SESSIONS_DIR, fname);
  const projectHashFromName = fname.replace(/\.db$/, "");

  let db;
  try {
    db = new DatabaseSync(full);
  } catch (e) {
    console.log(`  ✗ ${fname}: open failed — ${e.message}`);
    stats.schema_failed++;
    continue;
  }

  // Heal schema (idempotent migrate)
  try {
    const { runMigrations } = await import("../dist/migrations.js");
    runMigrations(db);
    stats.schema_healed++;
  } catch (e) {
    console.log(`  ⚠ ${fname}: schema migration failed — ${e.message} (continuing with existing schema)`);
    stats.schema_failed++;
  }

  // Verify tool_calls table exists
  let cols;
  try {
    cols = db.prepare("PRAGMA table_info(tool_calls)").all();
    if (cols.length === 0) {
      console.log(`  · ${fname}: no tool_calls table — skipping`);
      db.close();
      continue;
    }
  } catch (e) {
    console.log(`  ⚠ ${fname}: PRAGMA failed — ${e.message}`);
    db.close();
    continue;
  }

  const colNames = new Set(cols.map((c) => c.name));
  const hasTaskId   = colNames.has("task_id");
  const hasSkillId  = colNames.has("skill_id");
  const hasCachedTk = colNames.has("cached_tokens");
  const hasCostKnown= colNames.has("cost_known");
  const hasErrClass = colNames.has("error_class");
  const hasTraceId  = colNames.has("trace_id");

  let rows;
  try {
    rows = db.prepare(`
      SELECT call_id, session_id, agent_id, project_hash,
             ${hasTaskId ? "task_id" : "NULL AS task_id"},
             ${hasSkillId ? "skill_id" : "NULL AS skill_id"},
             tool_name, model, input_tokens, output_tokens,
             ${hasCachedTk ? "cached_tokens" : "0 AS cached_tokens"},
             cost_usd,
             ${hasCostKnown ? "cost_known" : "1 AS cost_known"},
             latency_ms, status,
             ${hasErrClass ? "error_class" : "NULL AS error_class"},
             ts, prev_hash, row_hash,
             ${hasTraceId ? "trace_id" : "NULL AS trace_id"}
      FROM tool_calls
    `).all();
  } catch (e) {
    console.log(`  ✗ ${fname}: SELECT failed — ${e.message}`);
    db.close();
    continue;
  }

  stats.rows_total += rows.length;

  let inserted = 0, skipped = 0, failed = 0;
  for (const r of rows) {
    if (rowsProcessed >= ROW_LIMIT) break;
    rowsProcessed++;
    if (DRY_RUN) { inserted++; continue; }
    try {
      const result = await client.query(`
        INSERT INTO tool_calls_pg (
          call_id, session_id, agent_id, project_hash,
          task_id, skill_id, tool_name, model,
          input_tokens, output_tokens, cached_tokens,
          cost_usd, cost_known, latency_ms, status, error_class,
          ts, prev_hash, row_hash, trace_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17::timestamptz, $18, $19, $20
        ) ON CONFLICT (call_id) DO NOTHING
        RETURNING id
      `, [
        r.call_id, r.session_id, r.agent_id, r.project_hash || projectHashFromName,
        r.task_id, r.skill_id, r.tool_name, r.model || "claude-sonnet-4-6",
        r.input_tokens || 0, r.output_tokens || 0, r.cached_tokens || 0,
        r.cost_usd || 0, r.cost_known || 1, r.latency_ms || 0,
        r.status || "ok", r.error_class,
        r.ts, r.prev_hash || "genesis", r.row_hash || "0".repeat(64),
        r.trace_id,
      ]);
      if (result.rowCount === 0) skipped++;
      else inserted++;
    } catch (e) {
      failed++;
      if (failed <= 3) console.log(`     row INSERT failed (call_id=${r.call_id}): ${e.message}`);
    }
  }

  stats.rows_inserted += inserted;
  stats.rows_skipped_duplicate += skipped;
  stats.rows_failed += failed;

  // Register the project path if known
  const knownPath = pathMap.get(projectHashFromName);
  if (knownPath && !DRY_RUN) {
    try {
      await client.query(`
        INSERT INTO project_paths_pg (project_hash, project_path)
        VALUES ($1, $2)
        ON CONFLICT (project_hash) DO UPDATE
          SET project_path = EXCLUDED.project_path, last_seen_at = now()
      `, [projectHashFromName, knownPath]);
      stats.paths_registered++;
    } catch (e) {
      console.log(`     path register failed: ${e.message}`);
    }
  }

  db.close();
  const tag = inserted > 0 ? "✓" : (skipped > 0 ? "·" : (failed > 0 ? "✗" : " "));
  console.log(`  ${tag} ${fname}: ${rows.length} rows → +${inserted} inserted, ${skipped} dup, ${failed} failed${knownPath ? ` (path: ${knownPath.split(/[\\\/]/).pop()})` : ""}`);
}

await client.end();

console.log(`\n--- Migration summary ---`);
console.log(`  DBs scanned:           ${stats.scanned}`);
console.log(`  schema healed:         ${stats.schema_healed}`);
console.log(`  schema failed:         ${stats.schema_failed}`);
console.log(`  rows total:            ${stats.rows_total}`);
console.log(`  rows inserted:         ${stats.rows_inserted}${DRY_RUN ? " (dry-run; not actually written)" : ""}`);
console.log(`  rows skipped (dup):    ${stats.rows_skipped_duplicate}`);
console.log(`  rows failed:           ${stats.rows_failed}`);
console.log(`  project paths registered: ${stats.paths_registered}`);
console.log(`\nDashboard at http://localhost:3099/dashboard should now show your historical projects.`);
