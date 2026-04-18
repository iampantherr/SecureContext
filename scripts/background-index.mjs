#!/usr/bin/env node
/**
 * SecureContext background indexer — v0.10.2
 * ===========================================
 *
 * Spawned by the SessionStart `session-start-index-check.ps1` hook when a
 * project has no indexed source files yet. Runs `indexProject` and writes a
 * JSON "status" file so other processes (like `zc_status` and
 * `zc_recall_context`) can report live progress to the agent.
 *
 * Usage:
 *   node scripts/background-index.mjs <projectPath>
 *   node scripts/background-index.mjs                # uses cwd
 *
 * Behaviour:
 *   1. If the project DB already has file-prefixed entries, exit silently
 *      (already indexed — no-op).
 *   2. If another indexer is already running (status file present, not
 *      finished, < 1h old), exit silently.
 *   3. Otherwise, run indexProject with a progress callback that updates the
 *      status file. Delete the status file on successful completion so the
 *      banner stops showing "in progress" on the next session.
 *
 * Status file location:
 *   ~/.claude/zc-ctx/sessions/<sha256(projectPath)[:16]>.indexing.status
 *
 * Status file shape (JSON):
 *   {
 *     "projectPath":     "<abs path>",
 *     "started_at":      "<ISO timestamp>",
 *     "total_files":     <number | null>,
 *     "completed_files": <number>,
 *     "finished_at":     "<ISO | null>",
 *     "model":           "<ollama model | null>",
 *     "error":           "<string | null>",
 *     "pid":             <pid>
 *   }
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

// Resolve dist relative to this script for self-contained invocation
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir   = resolve(__dirname, "..", "dist");

const { runMigrations }           = await import(`file://${distDir.replace(/\\/g, "/")}/migrations.js`);
const { indexProject, getIndexingStatus } = await import(`file://${distDir.replace(/\\/g, "/")}/harness.js`);

// ─── Inputs ──────────────────────────────────────────────────────────────────

const projectPath = resolve(process.argv[2] ?? process.cwd());
const hash        = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
const DB_DIR      = join(homedir(), ".claude", "zc-ctx", "sessions");
const dbFile      = join(DB_DIR, `${hash}.db`);
const statusFile  = join(DB_DIR, `${hash}.indexing.status`);

mkdirSync(DB_DIR, { recursive: true });

// ─── Preflight: is another indexer running / already indexed? ───────────────

const precheck = getIndexingStatus(projectPath);

if (precheck.state === "indexed") {
  console.error(`[bg-index] ${projectPath} already has ${precheck.fileCountInKb} indexed files — skipping`);
  process.exit(0);
}
if (precheck.state === "indexing") {
  const age = precheck.startedAt
    ? Math.round((Date.now() - new Date(precheck.startedAt).getTime()) / 1000)
    : "?";
  console.error(`[bg-index] another indexer is already running (started ${age}s ago, ${precheck.completedFiles}/${precheck.totalFiles} done)`);
  process.exit(0);
}

// ─── Status file writer ─────────────────────────────────────────────────────

function writeStatus(patch) {
  try {
    const existing = existsSync(statusFile)
      ? JSON.parse(readFileSync(statusFile, "utf8"))
      : {};
    writeFileSync(
      statusFile,
      JSON.stringify({ ...existing, ...patch }, null, 2)
    );
  } catch (e) {
    console.error(`[bg-index] failed to write status file: ${e.message}`);
  }
}

writeStatus({
  projectPath,
  started_at:      new Date().toISOString(),
  total_files:     null,
  completed_files: 0,
  finished_at:     null,
  error:           null,
  pid:             process.pid,
});

// Cleanup status file on any exit path so banner doesn't show stale "in progress"
function cleanup() {
  try { if (existsSync(statusFile)) unlinkSync(statusFile); } catch {}
}
process.on("SIGINT",  () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

// ─── Run indexing with live progress updates ────────────────────────────────

console.error(`[bg-index] starting indexProject for ${projectPath}`);
const t0 = Date.now();

try {
  const res = await indexProject(projectPath, {
    onProgress: (done, total, path) => {
      writeStatus({ completed_files: done, total_files: total });
    },
  });

  const dt = Math.round((Date.now() - t0) / 1000);
  console.error(
    `[bg-index] done in ${dt}s — ${res.filesIndexed} files, ` +
    `${res.semanticCount} semantic via ${res.semanticModel ?? "(none)"}, ` +
    `${res.truncationCount} truncation fallback`
  );

  // Write final status (mostly for debugging/inspection), then delete so the
  // banner snaps back to "full mode" on the next probe.
  writeStatus({
    completed_files: res.filesIndexed,
    total_files:     res.filesIndexed,
    finished_at:     new Date().toISOString(),
    model:           res.semanticModel,
  });
  cleanup();
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[bg-index] FAILED: ${msg}`);
  writeStatus({ error: msg, finished_at: new Date().toISOString() });
  // Don't cleanup on error — leave the file so the status is inspectable
  process.exit(1);
}
