#!/usr/bin/env node
/**
 * Nightly cron entrypoint (v0.18.1 — two-tier model)
 * ===================================================
 *
 * In v0.18.0 this script ran a full mutation cycle on the bottom-N skills.
 * In v0.18.1 the model splits into two layers:
 *
 *   L1 (continuous, per-project): outcome-triggered mutations during the
 *       day. The orchestrator's outcome resolver fires `enqueueTask` with
 *       role='mutator' on real failures (guardrails apply); the dedicated
 *       mutator agent picks them up + processes them in real-time.
 *
 *   L2 (this script, nightly): cross-project promotion review. Walks
 *       `findGlobalPromotionCandidates` to find per-project versions
 *       outperforming the global by ≥10% across ≥2 projects. Inserts
 *       candidates into `skill_promotion_queue`. Broadcasts an ALERT so
 *       the operator sees them at the start of the next session.
 *
 * What this script no longer does:
 *   - Run in-process mutation cycles (that's L1's job now)
 *   - Use the API key (the mutator agent uses Pro-plan auth)
 *   - Block on Anthropic API responses
 *
 * Cost (per nightly run):
 *   - Postgres queries only — $0
 *   - One broadcast — $0
 *
 * Set ZC_NIGHTLY_RUN_PROJECT_LEVEL_TOO=1 to retain v0.18.0 behavior
 * (run mutation cycles on bottom-N skills) for parity / disaster recovery.
 *
 * Operator setup:
 *   - Linux:   crontab → 0 2 * * *  ZC_TELEMETRY_BACKEND=postgres ZC_POSTGRES_PASSWORD=… node /path/to/scripts/run-nightly-mutations.mjs --project /path/to/project
 *   - Windows: Task Scheduler → daily 02:00 → node.exe with same args
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

function parseArgs(argv) {
  const args = { project: null, threshold: 0.10, minProjects: 2, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) { args.project = argv[i + 1]; i++; }
    else if (argv[i] === "--threshold" && argv[i + 1]) { args.threshold = Number(argv[i + 1]); i++; }
    else if (argv[i] === "--min-projects" && argv[i + 1]) { args.minProjects = Number(argv[i + 1]); i++; }
    else if (argv[i] === "--dry-run") { args.dryRun = true; }
    else if (argv[i] === "--help") {
      console.log(`Usage: node run-nightly-mutations.mjs --project <path> [--threshold 0.10] [--min-projects 2] [--dry-run]

v0.18.1 — Nightly cross-project promotion candidate surfacing.
This script does NOT run mutation cycles itself (that's L1, real-time).
It identifies candidates and queues them for operator approval.`);
      process.exit(0);
    }
  }
  if (!args.project) {
    console.error("--project <path> required");
    process.exit(2);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const PROJECT_PATH = args.project;
if (!existsSync(PROJECT_PATH)) {
  console.error(`Project path does not exist: ${PROJECT_PATH}`);
  process.exit(2);
}

const projectHash = createHash("sha256").update(PROJECT_PATH).digest("hex").slice(0, 16);
const dbDir = join(homedir(), ".claude", "zc-ctx", "sessions");
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, `${projectHash}.db`);

const startedAt = new Date();
const summary = {
  started_at:        startedAt.toISOString(),
  project_path:      PROJECT_PATH,
  project_hash:      projectHash,
  threshold:         args.threshold,
  min_projects:      args.minProjects,
  backend:           process.env.ZC_TELEMETRY_BACKEND ?? "sqlite",
  dry_run:           args.dryRun,
  candidates_found:  0,
  candidates_queued: 0,
  cycles:            [],   // populated only when ZC_NIGHTLY_RUN_PROJECT_LEVEL_TOO=1
  ended_at:          null,
  error:             null,
};

try {
  const { runMigrations } = await import("../dist/migrations.js");

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);

  // PG migrations needed for findGlobalPromotionCandidates
  if (summary.backend === "postgres" || summary.backend === "dual") {
    const { runPgMigrations } = await import("../dist/pg_migrations.js");
    await runPgMigrations();
  } else {
    console.warn("⚠ ZC_TELEMETRY_BACKEND is sqlite — cross-project promotion needs Postgres. Skipping L2 surfacing.");
    summary.error = "PG required for cross-project query; set ZC_TELEMETRY_BACKEND=postgres|dual";
    db.close();
    summary.ended_at = new Date().toISOString();
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  // ─── L2: cross-project promotion candidate surfacing ────────────────────
  const { findGlobalPromotionCandidates } = await import("../dist/skills/storage_pg.js");
  const candidates = await findGlobalPromotionCandidates(args.threshold, args.minProjects);
  summary.candidates_found = candidates.length;
  console.log(`Found ${candidates.length} cross-project promotion candidate(s).`);

  if (!args.dryRun && candidates.length > 0) {
    const { enqueuePromotion } = await import("../dist/skills/promotion_queue.js");
    let queued = 0;
    for (const c of candidates) {
      const r = await enqueuePromotion(db, {
        candidate_skill_id: c.best_skill_id,
        proposed_target:    "global",
        surfaced_by:        "cron",
        best_avg:           c.best_avg,
        global_avg:         c.global_avg,
        project_count:      c.project_count,
      });
      if (r.inserted) {
        queued++;
        console.log(`  + queued: ${c.best_skill_id} (best_avg=${c.best_avg.toFixed(3)} > ${c.global_avg.toFixed(3)} on ${c.project_count} project(s))`);
      } else {
        console.log(`  · already queued: ${c.best_skill_id}`);
      }
    }
    summary.candidates_queued = queued;

    // Optional: broadcast an ALERT so the operator sees pending review on next session
    if (queued > 0 && process.env.ZC_NIGHTLY_BROADCAST_ALERT !== "0") {
      try {
        const { broadcastFact } = await import("../dist/memory.js");
        broadcastFact(PROJECT_PATH, "STATUS", "cron-nightly-mutator", {
          state:   "info",
          summary: `${queued} skill(s) pending global-promotion review. Run zc_skill_pending_promotions to view, then zc_skill_approve_promotion / reject as appropriate.`,
          importance: 4,
        });
      } catch (e) {
        console.warn(`  (broadcast failed: ${e.message})`);
      }
    }
  } else if (args.dryRun) {
    console.log("(dry-run: nothing queued)");
    for (const c of candidates) {
      console.log(`  would queue: ${c.best_skill_id} (best_avg=${c.best_avg.toFixed(3)} > ${c.global_avg.toFixed(3)} on ${c.project_count} project(s))`);
    }
  }

  // ─── Optional: legacy v0.18.0 in-process cycles ─────────────────────────
  // Only runs when ZC_NIGHTLY_RUN_PROJECT_LEVEL_TOO=1. Useful as a disaster-
  // recovery path if L1 (real-time mutator) is broken.
  if (process.env.ZC_NIGHTLY_RUN_PROJECT_LEVEL_TOO === "1") {
    console.log("\n⚠ ZC_NIGHTLY_RUN_PROJECT_LEVEL_TOO=1 — running in-process project-level cycles.");
    const { listActiveSkills } = await import("../dist/skills/storage_dual.js");
    const { selectUnderperformingSkills, runMutationCycle } = await import("../dist/skills/orchestrator.js");
    const { getMutator } = await import("../dist/skills/mutator.js");

    const skills = await listActiveSkills(db);
    const targets = await selectUnderperformingSkills(db, skills, 3);
    const mutator = await getMutator(undefined, { projectPath: PROJECT_PATH });
    console.log(`Using mutator: ${mutator.id} on ${targets.length} skill(s)`);
    for (const t of targets) {
      const r = await runMutationCycle(db, t, { mutator, projectPath: PROJECT_PATH });
      summary.cycles.push(r);
    }
  }

  db.close();
  summary.ended_at = new Date().toISOString();
  console.log("\n=== Nightly cron summary ===");
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
} catch (e) {
  summary.error = e.message;
  summary.ended_at = new Date().toISOString();
  console.error("Nightly cron failed:", e);
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
