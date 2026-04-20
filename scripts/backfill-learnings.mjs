#!/usr/bin/env node
/**
 * Backfill existing <project>/learnings/*.jsonl into the SQLite `learnings`
 * table (and Postgres learnings_pg if ZC_TELEMETRY_BACKEND=postgres|dual).
 *
 * The PostToolUse `learnings-indexer.mjs` hook only mirrors NEW writes — it
 * doesn't discover pre-existing JSONL rows. Run this once after installing
 * SecureContext on an existing project, or periodically as a safety net.
 *
 * Usage:
 *   node scripts/backfill-learnings.mjs --project C:\path\to\project
 *   node scripts/backfill-learnings.mjs --project ... --dry-run
 *
 * Exit codes:
 *   0 — success (newly mirrored count in output)
 *   1 — bad args / missing project
 *
 * This script is idempotent — the UNIQUE(project_hash, source_path, source_line)
 * constraint skips already-mirrored rows.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
function getArg(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const projectArg = getArg("--project") ?? process.env.ZC_PROJECT_PATH ?? process.cwd();
const dryRun     = argv.includes("--dry-run");

if (!existsSync(projectArg)) {
  console.error(`Project path does not exist: ${projectArg}`);
  process.exit(1);
}

const projectPath = resolve(projectArg);
const learningsDir = join(projectPath, "learnings");
if (!existsSync(learningsDir)) {
  console.log(`No learnings/ directory at ${projectPath} — nothing to backfill.`);
  process.exit(0);
}

const projectHash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);

function categoryFromFilename(name) {
  const stem = name.toLowerCase().replace(/\.jsonl$/, "");
  if (stem === "metrics")               return "metric";
  if (stem === "decisions")             return "decision";
  if (stem === "failures")              return "failure";
  if (stem === "experiments")           return "experiment";
  return "insight";
}

// ─── SQLite backfill ──────────────────────────────────────────────────────────
const dbFile = join(homedir(), ".claude", "zc-ctx", "sessions", `${projectHash}.db`);
if (!existsSync(dbFile)) {
  console.log(`Session DB does not exist yet: ${dbFile}`);
  console.log(`Run a SecureContext tool call first to initialize it, then re-run backfill.`);
  process.exit(0);
}
mkdirSync(join(homedir(), ".claude", "zc-ctx", "sessions"), { recursive: true });

const db = new DatabaseSync(dbFile);
db.exec("PRAGMA journal_mode = WAL");

// Verify learnings table exists (migrations should have run)
try {
  db.prepare("SELECT 1 FROM learnings LIMIT 1").get();
} catch {
  console.error(`Table 'learnings' not found in ${dbFile}.`);
  console.error(`Run the MCP server once to apply migrations before backfilling.`);
  process.exit(1);
}

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO learnings
    (learning_id, project_hash, category, payload, source_path, source_line, ts)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const jsonlFiles = readdirSync(learningsDir).filter((f) => f.toLowerCase().endsWith(".jsonl"));
console.log(`[backfill] project: ${projectPath}`);
console.log(`[backfill] project_hash: ${projectHash}`);
console.log(`[backfill] files found: ${jsonlFiles.join(", ") || "(none)"}`);

let totalInserted = 0;
let totalScanned  = 0;
const now = new Date().toISOString();

for (const file of jsonlFiles) {
  const full = join(learningsDir, file);
  let content = readFileSync(full, "utf8");
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  const lines = content.split(/\r?\n/);
  const category = categoryFromFilename(file);
  const sourceRel = `learnings/${file}`;

  let thisFileInserted = 0;
  let thisFileScanned  = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    thisFileScanned++;
    totalScanned++;
    if (dryRun) continue;
    const r = insertStmt.run(
      `learn-${randomUUID().slice(0, 12)}`,
      projectHash,
      category,
      line.slice(0, 20000),
      sourceRel,
      i + 1,
      now,
    );
    if (r.changes > 0) {
      thisFileInserted++;
      totalInserted++;
    }
  }
  console.log(`  ${file.padEnd(30)} scanned=${thisFileScanned}, newly_mirrored=${thisFileInserted}, category=${category}`);
}

db.close();

console.log(``);
console.log(`[backfill] SQLite done. Total scanned=${totalScanned}, newly mirrored=${totalInserted}${dryRun ? " (DRY RUN — not written)" : ""}`);

// ─── Postgres mirror (optional) ───────────────────────────────────────────────
const backend = (process.env.ZC_TELEMETRY_BACKEND ?? "sqlite").toLowerCase();
if (backend === "postgres" || backend === "dual") {
  console.log(`[backfill] ZC_TELEMETRY_BACKEND=${backend} — mirroring to learnings_pg`);
  try {
    const pg = await import("pg");
    const { Pool } = pg.default;
    const pool = new Pool({
      host:     process.env.ZC_POSTGRES_HOST     || "localhost",
      port:     Number(process.env.ZC_POSTGRES_PORT || 5432),
      user:     process.env.ZC_POSTGRES_USER     || "scuser",
      password: process.env.ZC_POSTGRES_PASSWORD || "",
      database: process.env.ZC_POSTGRES_DB       || "securecontext",
      max: 2,
    });
    let pgInserted = 0;
    let pgScanned  = 0;
    for (const file of jsonlFiles) {
      const full = join(learningsDir, file);
      let content = readFileSync(full, "utf8");
      if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
      const lines = content.split(/\r?\n/);
      const category = categoryFromFilename(file);
      const sourceRel = `learnings/${file}`;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.trim()) continue;
        pgScanned++;
        if (dryRun) continue;
        const r = await pool.query(
          `INSERT INTO learnings_pg (learning_id, project_hash, category, payload, source_path, source_line, ts)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (project_hash, source_path, source_line) DO NOTHING`,
          [`learn-${randomUUID().slice(0, 12)}`, projectHash, category, line.slice(0, 20000), sourceRel, i + 1],
        );
        if (r.rowCount > 0) pgInserted++;
      }
    }
    await pool.end();
    console.log(`[backfill] Postgres done. Scanned=${pgScanned}, newly mirrored=${pgInserted}${dryRun ? " (DRY RUN)" : ""}`);
  } catch (e) {
    console.warn(`[backfill] Postgres mirror failed: ${e.message} — SQLite backfill still succeeded.`);
  }
}
