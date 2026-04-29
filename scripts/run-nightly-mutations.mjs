#!/usr/bin/env node
/**
 * Nightly mutation cycle entrypoint (v0.18.0)
 * ============================================
 *
 * Standalone script to run the mutation engine across all active skills
 * for a project. Designed to be invoked by:
 *
 *   - OS cron (Linux/macOS):
 *       0 2 * * *   ZC_POSTGRES_PASSWORD=… ZC_TELEMETRY_BACKEND=postgres \
 *                   ZC_MUTATOR_MODEL=batch-sonnet ANTHROPIC_API_KEY=sk-… \
 *                   /usr/bin/node /path/to/SecureContext/scripts/run-nightly-mutations.mjs \
 *                   --project /path/to/your/project >> /var/log/zc-nightly.log 2>&1
 *
 *   - Windows Task Scheduler:
 *       Action: Start a program
 *       Program: node.exe
 *       Args: C:\path\to\SecureContext\scripts\run-nightly-mutations.mjs --project C:\your\project
 *       Trigger: Daily at 02:00 local
 *
 * What it does:
 *   1. Loads project DB (SQLite + PG mirror per ZC_TELEMETRY_BACKEND)
 *   2. Selects bottom-N skills by recent avg outcome_score (default top-3)
 *   3. For each, runs `runMutationCycle` with the configured mutator
 *   4. Records ALL candidates to skill_mutations (SQLite + PG)
 *   5. Promotes winners; archives parents
 *   6. Emits structured JSON summary to stdout for log scraping
 *   7. Exits with code 0 on success, non-zero on hard error
 *
 * Cost (per nightly run with batch-sonnet):
 *   3 skills × 5 candidates × $0.012/cycle = ~$0.18/night → ~$5.40/month
 *
 * Cost (with local-mock — for testing):
 *   $0
 *
 * If ZC_MUTATOR_MODEL=batch-sonnet is set, the script BLOCKS while waiting
 * for the Anthropic batch to complete (24h SLA). For unattended overnight
 * runs that's fine; for ad-hoc runs use ZC_MUTATOR_MODEL=realtime-sonnet.
 *
 * Cross-project promotion check (S2.5-4):
 *   After all per-project cycles complete, queries `findGlobalPromotionCandidates`
 *   and emits candidates as a separate `global_candidates` block in the
 *   summary. Operators can review + promote via `zc_skill_propose_mutation`
 *   on the global skill or accept candidates manually.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// ─── Args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { project: null, topN: 3, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) { args.project = argv[i + 1]; i++; }
    else if (argv[i] === "--top-n" && argv[i + 1]) { args.topN = Number(argv[i + 1]); i++; }
    else if (argv[i] === "--dry-run") { args.dryRun = true; }
    else if (argv[i] === "--help") {
      console.log(`Usage: node run-nightly-mutations.mjs --project <path> [--top-n N] [--dry-run]`);
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

// ─── Resolve project DB ─────────────────────────────────────────────────────

const projectHash = createHash("sha256").update(PROJECT_PATH).digest("hex").slice(0, 16);
const dbDir = join(homedir(), ".claude", "zc-ctx", "sessions");
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, `${projectHash}.db`);

const startedAt = new Date();
const summary = {
  started_at:        startedAt.toISOString(),
  project_path:      PROJECT_PATH,
  project_hash:      projectHash,
  mutator:           process.env.ZC_MUTATOR_MODEL ?? "local-mock",
  backend:           process.env.ZC_TELEMETRY_BACKEND ?? "sqlite",
  dry_run:           args.dryRun,
  cycles:            [],
  global_candidates: [],
  total_cost_usd:    0,
  total_duration_ms: 0,
  ended_at:          null,
  error:             null,
};

// ─── Run ────────────────────────────────────────────────────────────────────

try {
  const { runMigrations } = await import("../dist/migrations.js");
  const { listActiveSkills } = await import("../dist/skills/storage_dual.js");
  const { selectUnderperformingSkills, runMutationCycle } = await import("../dist/skills/orchestrator.js");
  const { getMutator } = await import("../dist/skills/mutator.js");

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);

  // PG migrations if backend=postgres|dual
  if (summary.backend === "postgres" || summary.backend === "dual") {
    const { runPgMigrations } = await import("../dist/pg_migrations.js");
    await runPgMigrations();
  }

  const skills = await listActiveSkills(db);
  if (skills.length === 0) {
    console.log("No active skills — nothing to mutate.");
    summary.cycles = [];
  } else {
    const targets = selectUnderperformingSkills(db, skills, args.topN);
    console.log(`Selected ${targets.length} underperforming skill(s) for mutation: ${targets.map((t) => t.skill_id).join(", ")}`);
    const mutator = await getMutator();
    console.log(`Using mutator: ${mutator.id}`);

    for (const skill of targets) {
      if (args.dryRun) {
        summary.cycles.push({
          skill_id: skill.skill_id,
          dry_run: true,
          baseline_only: true,
        });
        continue;
      }
      console.log(`\n--- Cycle: ${skill.skill_id} ---`);
      const result = await runMutationCycle(db, skill, { mutator });
      summary.cycles.push(result);
      summary.total_cost_usd += result.total_cost_usd;
      console.log(`  baseline=${result.baseline_score.toFixed(3)} best=${result.best_candidate_score.toFixed(3)} promoted=${result.promoted}`);
      if (result.reason) console.log(`  reason: ${result.reason}`);
    }
  }

  // Cross-project promotion check (PG only)
  if (summary.backend === "postgres" || summary.backend === "dual") {
    try {
      const { findGlobalPromotionCandidates } = await import("../dist/skills/storage_pg.js");
      const cands = await findGlobalPromotionCandidates(0.10, 2);
      summary.global_candidates = cands;
      if (cands.length > 0) {
        console.log(`\n--- Cross-project promotion candidates ---`);
        for (const c of cands) {
          console.log(`  ${c.name} — best ${c.best_skill_id} (avg ${c.best_avg.toFixed(3)} > global ${c.global_avg.toFixed(3)}) on ${c.project_count} project(s)`);
        }
      }
    } catch (e) {
      console.warn(`Cross-project query failed (non-fatal): ${e.message}`);
    }
  }

  db.close();
  summary.ended_at         = new Date().toISOString();
  summary.total_duration_ms = Date.now() - startedAt.getTime();

  console.log(`\n=== Nightly mutation summary ===`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
} catch (e) {
  summary.error = e.message;
  summary.ended_at = new Date().toISOString();
  console.error("Nightly cycle failed:", e);
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
