#!/usr/bin/env node
/**
 * v0.22.8 — One-shot backfill: copy local SQLite source_meta rows to PG.
 *
 * Why: prior to v0.22.8, every L0/L1 file summary written by
 * indexContent() in src/knowledge.ts landed in the per-project SQLite DB
 * only. PG `source_meta` was used for a different code path
 * (session_summary + memory keys via store-postgres.ts) so file-level
 * summaries never made it to PG. The dashboard, which reads PG, was
 * blind to the entire indexed corpus on each operator's machine.
 *
 * v0.22.8 starts dual-writing on every NEW indexing call. This script
 * brings the existing rows along.
 *
 * Usage:
 *   node scripts/backfill-source-meta-to-pg.mjs                # all projects
 *   node scripts/backfill-source-meta-to-pg.mjs <project_hash> # one project
 *   node scripts/backfill-source-meta-to-pg.mjs --dry-run      # preview only
 *
 * Reads PG creds from ~/.claude/settings.json's mcpServers.zc-ctx.env if
 * not in the operator's shell. Reads SQLite project DBs from
 * ~/.claude/zc-ctx/sessions/<project_hash>.db.
 *
 * Idempotent: uses ON CONFLICT (project_hash, source) DO UPDATE so re-running
 * is safe and refreshes any stale rows from later SQLite writes.
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";
const { Pool } = pg;

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");
const PROJECT_FILTER = ARGS.find((a) => /^[0-9a-f]{16}$/.test(a)) ?? null;

// ── Discover PG creds ────────────────────────────────────────────────────────
const settingsFile = join(homedir(), ".claude", "settings.json");
let pgEnv = {
  host:     process.env.ZC_POSTGRES_HOST,
  port:     process.env.ZC_POSTGRES_PORT,
  user:     process.env.ZC_POSTGRES_USER,
  password: process.env.ZC_POSTGRES_PASSWORD,
  database: process.env.ZC_POSTGRES_DB,
};
if (existsSync(settingsFile) && (!pgEnv.host || !pgEnv.password)) {
  try {
    const sj = JSON.parse(readFileSync(settingsFile, "utf8"));
    const e = sj.mcpServers?.["zc-ctx"]?.env ?? {};
    if (!pgEnv.host)     pgEnv.host     = e.ZC_POSTGRES_HOST;
    if (!pgEnv.port)     pgEnv.port     = e.ZC_POSTGRES_PORT;
    if (!pgEnv.user)     pgEnv.user     = e.ZC_POSTGRES_USER;
    if (!pgEnv.password) pgEnv.password = e.ZC_POSTGRES_PASSWORD;
    if (!pgEnv.database) pgEnv.database = e.ZC_POSTGRES_DB;
  } catch {}
}

if (!pgEnv.host || !pgEnv.password) {
  console.error("FATAL: no PG creds available. Set ZC_POSTGRES_* in env or settings.json.");
  process.exit(1);
}

const pool = new Pool({
  host:     pgEnv.host,
  port:     parseInt(pgEnv.port ?? "5432", 10),
  user:     pgEnv.user ?? "postgres",
  password: pgEnv.password,
  database: pgEnv.database ?? "securecontext",
});

// ── Discover SQLite project DBs ──────────────────────────────────────────────
const sessionsDir = join(homedir(), ".claude", "zc-ctx", "sessions");
if (!existsSync(sessionsDir)) {
  console.error(`FATAL: ${sessionsDir} does not exist. No projects to backfill.`);
  process.exit(1);
}

let dbFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".db"));
if (PROJECT_FILTER) {
  dbFiles = dbFiles.filter((f) => f.startsWith(PROJECT_FILTER));
  if (dbFiles.length === 0) {
    console.error(`FATAL: no SQLite DB matches project_hash=${PROJECT_FILTER}`);
    process.exit(1);
  }
}

console.log(`Found ${dbFiles.length} project DB(s) to scan.`);
if (DRY_RUN) console.log("DRY-RUN: no PG writes will be performed.");
console.log("");

// ── Backfill each project ────────────────────────────────────────────────────
let totalScanned = 0;
let totalInserted = 0;
let totalSkipped = 0;
let totalErrors = 0;

for (const dbFile of dbFiles) {
  const projectHash = dbFile.replace(/\.db$/, "");
  const dbPath = join(sessionsDir, dbFile);
  process.stdout.write(`[${projectHash}] `);

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    console.log(`SKIP (cannot open: ${e.message})`);
    totalSkipped++;
    continue;
  }

  let rows;
  try {
    rows = db.prepare(
      `SELECT source, source_type, retention_tier, created_at, l0_summary, l1_summary
       FROM source_meta WHERE source LIKE 'file:%'`,
    ).all();
  } catch (e) {
    console.log(`SKIP (no source_meta table: ${e.message})`);
    totalSkipped++;
    db.close();
    continue;
  } finally {
    // db is closed below after we use the rows; close on error cases above
  }

  if (rows.length === 0) {
    console.log(`0 file summaries — skipping`);
    db.close();
    continue;
  }

  process.stdout.write(`${rows.length} file summaries... `);
  totalScanned += rows.length;

  if (DRY_RUN) {
    console.log("DRY-RUN");
    db.close();
    continue;
  }

  let inserted = 0;
  let errors = 0;
  for (const r of rows) {
    try {
      await pool.query(
        `INSERT INTO source_meta(project_hash, source, source_type, retention_tier, created_at, l0_summary, l1_summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(project_hash, source) DO UPDATE SET
           source_type    = EXCLUDED.source_type,
           retention_tier = EXCLUDED.retention_tier,
           created_at     = EXCLUDED.created_at,
           l0_summary     = EXCLUDED.l0_summary,
           l1_summary     = EXCLUDED.l1_summary`,
        [
          projectHash,
          r.source,
          r.source_type ?? "internal",
          r.retention_tier ?? "internal",
          r.created_at ?? new Date().toISOString(),
          r.l0_summary ?? "",
          r.l1_summary ?? "",
        ],
      );
      inserted++;
    } catch (e) {
      errors++;
      if (errors <= 3) {
        console.log(`\n    ERR on ${r.source}: ${e.message}`);
      }
    }
  }
  totalInserted += inserted;
  totalErrors += errors;
  console.log(`copied ${inserted}, errors ${errors}`);
  db.close();
}

await pool.end();

console.log("");
console.log("─".repeat(60));
console.log(`Summary:`);
console.log(`  Scanned:  ${totalScanned} file summaries across ${dbFiles.length} project(s)`);
console.log(`  Inserted: ${totalInserted}`);
console.log(`  Errors:   ${totalErrors}`);
console.log(`  Skipped:  ${totalSkipped} project DBs`);
console.log("");

if (totalErrors > 0) {
  console.log("Some rows failed to insert — check error messages above.");
  process.exit(1);
}
