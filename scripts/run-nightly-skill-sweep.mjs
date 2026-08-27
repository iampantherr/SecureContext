#!/usr/bin/env node
/**
 * Nightly skill sweep (v0.62.0 — mutation engine M4 + M5 host-side + M6)
 * =======================================================================
 *
 * Kills forensic cause #4: the engine previously had NO background
 * improvement pressure — L1 fires only on failure-like outcomes mid-session,
 * and the old nightly script was scheduled nowhere. This one runs HOST-SIDE
 * (where the `claude` CLI is authenticated — the container cannot bill the
 * subscription) under Windows Task Scheduler with StartWhenAvailable, so a
 * shutdown at 02:00 means it fires at next boot instead of silently skipping.
 *
 * Passes, in order (each independent — one failing does not stop the rest):
 *   1. M5 host-side hygiene: sweep stale claimed tasks; surface tasks queued
 *      for roles that no longer exist in roles.json to the operator inbox.
 *   2. L2 cross-project promotion surfacing (unchanged from v0.18.1).
 *   3. M4 body cycles: bottom-K skills by recent avg outcome with >= MIN_RUNS
 *      scored runs, budget-capped, skipping skills that already have a
 *      pending operator review or any mutation in the last 24h.
 *   4. M6 description-tune cycles: active skills whose descriptions exceed
 *      the 1024-char admission limit, same caps/skips.
 *
 * EVERYTHING lands in the operator pending queue — the sweep proposes,
 * the operator disposes. Nothing is auto-applied.
 *
 * Concurrency: a lock file prevents overlapping runs (Task Scheduler retry +
 * a still-running previous sweep must not double-fire cycles).
 * Boot race: PG may still be starting when the missed-run fires right after
 * login — we retry the connection for up to ZC_NIGHTLY_PG_WAIT_MIN minutes.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SC = dirname(dirname(fileURLToPath(import.meta.url)));   // repo root
const summary = {
  started_at: new Date().toISOString(),
  hygiene: null, orphan_roles: null, l2: null, body_cycles: [], desc_cycles: [],
  threat_reviews: null, skipped: [], errors: [], ended_at: null,
};
const LOG_DIR = join(homedir(), ".claude", "zc-ctx", "logs");
mkdirSync(LOG_DIR, { recursive: true });
const log = (msg) => console.log(`[sweep] ${msg}`);
const finish = (code) => {
  summary.ended_at = new Date().toISOString();
  try { appendFileSync(join(LOG_DIR, "nightly-sweep.jsonl"), JSON.stringify(summary) + "\n"); } catch { /* ignore */ }
  console.log(JSON.stringify(summary, null, 2));
  process.exit(code);
};

// ── env bootstrap ───────────────────────────────────────────────────────────
for (const line of readFileSync(join(SC, "docker", ".env"), "utf8").split("\n")) {
  const m = /^POSTGRES_(PASSWORD|PORT|USER|DB)=(.*)$/.exec(line.trim());
  if (m) process.env[`ZC_POSTGRES_${m[1]}`] ??= m[2];
}
process.env.ZC_POSTGRES_HOST ??= "localhost";
process.env.ZC_TELEMETRY_BACKEND = "postgres";
process.env.ZC_MUTATOR_MODEL ??= "cli-headless";
process.env.ZC_JUDGE_MODEL ??= "cli-headless";
process.env.ZC_REPLAY_MODEL ??= "cli-headless";

// NaN-checked (not ||-defaulted) so an explicit 0 disables a pass.
const intEnv = (name, dflt) => { const n = parseInt(process.env[name] ?? "", 10); return Number.isNaN(n) ? dflt : Math.max(0, n); };
const MAX_BODY_CYCLES = intEnv("ZC_NIGHTLY_MAX_CYCLES", 2);
const MAX_DESC_CYCLES = intEnv("ZC_NIGHTLY_MAX_DESC_TUNE", 2);
const MIN_RUNS        = intEnv("ZC_NIGHTLY_MIN_RUNS", 3);
const PROJECT_PATH    = "nightly-cron";
const ROLES_JSON      = process.env.ZC_ROLES_JSON ?? "C:\\Users\\Amit\\AI_projects\\A2A_dispatcher\\roles.json";

// ── lock file (overlap guard; stale after 3h counts as crashed) ─────────────
const LOCK = join(LOG_DIR, "nightly-sweep.lock");
if (existsSync(LOCK)) {
  const age = Date.now() - new Date(readFileSync(LOCK, "utf8").trim() || 0).getTime();
  if (age < 3 * 3600_000) { summary.errors.push(`another sweep is running (lock age ${Math.round(age / 60000)}m)`); finish(0); }
  log(`stale lock (${Math.round(age / 3600000)}h) — previous sweep crashed; continuing`);
}
writeFileSync(LOCK, new Date().toISOString());
const unlock = () => { try { rmSync(LOCK, { force: true }); } catch { /* ignore */ } };
process.on("exit", unlock);

try {
  // ── wait for PG (boot race: Docker may still be coming up) ────────────────
  const { withClient } = await import(`file:///${SC}/dist/pg_pool.js`.replace(/\\/g, "/"));
  const waitMin = parseInt(process.env.ZC_NIGHTLY_PG_WAIT_MIN ?? "10", 10) || 10;
  const deadline = Date.now() + waitMin * 60_000;
  for (;;) {
    try { await withClient((c) => c.query("SELECT 1")); break; }
    catch (e) {
      if (Date.now() > deadline) { summary.errors.push(`postgres unreachable after ${waitMin}m: ${e.message}`); finish(1); }
      log("postgres not ready — retrying in 30s (Docker may still be starting)");
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }

  const { projectHash } = await import(`file:///${SC}/dist/store.js`.replace(/\\/g, "/"));
  const dbDir = join(homedir(), ".claude", "zc-ctx", "sessions");
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(join(dbDir, `${projectHash(PROJECT_PATH)}.db`));
  db.exec("PRAGMA journal_mode = WAL");
  const { runMigrations } = await import(`file:///${SC}/dist/migrations.js`.replace(/\\/g, "/"));
  runMigrations(db);
  const { runPgMigrations } = await import(`file:///${SC}/dist/pg_migrations.js`.replace(/\\/g, "/"));
  await runPgMigrations();

  const inbox = async (text) => {
    try {
      const { createInboxEntry } = await import(`file:///${SC}/dist/operator_inbox.js`.replace(/\\/g, "/"));
      await createInboxEntry({ projectPath: "global", question: text, fromAgent: "nightly-sweep" });
    } catch (e) { summary.errors.push(`inbox write failed: ${e.message}`); }
  };

  // ── 1. M5 host-side hygiene ───────────────────────────────────────────────
  try {
    const { reclaimStaleTasks } = await import(`file:///${SC}/dist/task_queue.js`.replace(/\\/g, "/"));
    const reclaimed = await reclaimStaleTasks(parseInt(process.env.ZC_QUEUE_STALE_SECONDS ?? "300", 10) || 300);
    summary.hygiene = { reclaimed };
    if (reclaimed > 0) log(`hygiene: reclaimed ${reclaimed} stale claimed task(s)`);

    // Orphan-role detection: queued tasks whose role no longer exists.
    let activeRoles = null;
    try {
      const roles = JSON.parse(readFileSync(ROLES_JSON, "utf8"));
      activeRoles = Array.isArray(roles) ? roles.map((r) => r.role ?? r.name ?? r) : Object.keys(roles.roles ?? roles);
    } catch { summary.orphan_roles = { skipped: `roles.json unreadable at ${ROLES_JSON}` }; }
    if (activeRoles) {
      const orphans = await withClient(async (c) => (await c.query(
        `SELECT task_id, role, project_hash, ts FROM task_queue_pg
          WHERE state = 'queued' AND NOT (role = ANY($1)) ORDER BY ts LIMIT 20`,
        [activeRoles])).rows);
      summary.orphan_roles = { active_roles: activeRoles.length, orphans: orphans.length };
      if (orphans.length > 0) {
        log(`hygiene: ${orphans.length} task(s) queued for retired roles`);
        await inbox(`QUEUE HYGIENE: ${orphans.length} task(s) are queued for roles that no longer exist in roles.json — they will never be claimed. ` +
          orphans.map((o) => `${o.task_id} (role=${o.role})`).join(", ") +
          `. Requeue to a live role or cancel them.`);
      }
    }
  } catch (e) { summary.errors.push(`hygiene: ${e.message}`); }

  // ── 2. L2 cross-project promotion surfacing ───────────────────────────────
  try {
    const { findGlobalPromotionCandidates } = await import(`file:///${SC}/dist/skills/storage_pg.js`.replace(/\\/g, "/"));
    const { enqueuePromotion } = await import(`file:///${SC}/dist/skills/promotion_queue.js`.replace(/\\/g, "/"));
    const cands = await findGlobalPromotionCandidates(0.10, 2);
    let queued = 0;
    for (const c of cands) {
      const r = await enqueuePromotion(db, {
        candidate_skill_id: c.best_skill_id, proposed_target: "global", surfaced_by: "cron",
        best_avg: c.best_avg, global_avg: c.global_avg, project_count: c.project_count,
      });
      if (r.inserted) queued++;
    }
    summary.l2 = { found: cands.length, queued };
    if (queued > 0) log(`L2: ${queued} cross-project promotion candidate(s) queued`);
  } catch (e) { summary.errors.push(`L2: ${e.message}`); }

  // ── shared cycle plumbing ────────────────────────────────────────────────
  const { listActiveSkills, getRecentSkillRuns } = await import(`file:///${SC}/dist/skills/storage_dual.js`.replace(/\\/g, "/"));
  const { runMutationCycle } = await import(`file:///${SC}/dist/skills/orchestrator.js`.replace(/\\/g, "/"));
  const skills = await listActiveSkills(db);

  // Skip-set: skills with a pending operator review (queue spam guard) or any
  // mutation in the last 24h (L1 may have just handled them).
  const busy = new Set(await withClient(async (c) => [
    ...(await c.query(`SELECT DISTINCT skill_id FROM mutation_results_pg WHERE consumed_at IS NULL`)).rows.map((r) => r.skill_id),
    ...(await c.query(`SELECT DISTINCT parent_skill_id AS skill_id FROM skill_mutations_pg WHERE created_at > now() - interval '24 hours'`)).rows.map((r) => r.skill_id),
  ]));

  // ── 3. M4 body cycles: bottom-K with evidence ─────────────────────────────
  try {
    const scored = [];
    for (const s of skills) {
      if (busy.has(s.skill_id)) { summary.skipped.push(`${s.skill_id}: pending review or mutated <24h ago`); continue; }
      const runs = (await getRecentSkillRuns(db, s.skill_id, 20)).filter((r) => r.outcome_score !== null);
      if (runs.length < MIN_RUNS) continue;   // no evidence — not "underperforming", just unmeasured
      scored.push({ s, avg: runs.reduce((a, r) => a + r.outcome_score, 0) / runs.length });
    }
    scored.sort((a, b) => a.avg - b.avg);
    for (const { s, avg } of scored.slice(0, MAX_BODY_CYCLES)) {
      log(`body cycle: ${s.skill_id} (avg ${avg.toFixed(2)})`);
      const r = await runMutationCycle(db, s, { projectPath: PROJECT_PATH });
      summary.body_cycles.push({ skill_id: s.skill_id, avg, pending: r.pending_result_id ?? null, reason: r.reason.slice(0, 200) });
    }
  } catch (e) { summary.errors.push(`body cycles: ${e.message}`); }

  // ── 4. M6 description-tune cycles: over-limit descriptions ────────────────
  // File-authoritative: an over-limit description can NEVER belong to an
  // active row (the admission gate rejects it), so the real targets live on
  // DISK — un-admitted skills in the main root and quarantined skills in
  // skills.quarantine (approving a desc-tune for those RESTORES them).
  try {
    const { buildSkill } = await import(`file:///${SC}/dist/skills/loader.js`.replace(/\\/g, "/"));
    const { readdirSync } = await import("node:fs");
    // parseFsSkill REJECTS over-limit descriptions with a parse_error and an
    // empty fm — for the exact files desc-tune exists to fix (live-caught on
    // the first sweep: both quarantine targets were silently skipped). So
    // this scan reads frontmatter tolerantly itself: it only needs
    // name/version/scope/description/body, and over-limit is the TARGET
    // condition, not a defect.
    const readTolerant = (dir) => {
      const raw = readFileSync(join(dir, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
      if (!raw.startsWith("---\n")) return null;
      const end = raw.indexOf("\n---\n", 4);
      if (end === -1) return null;
      const lines = raw.slice(4, end).split("\n");
      const fm = {};
      for (let i = 0; i < lines.length; i++) {
        const m = /^([a-z_][a-z0-9_-]*)\s*:\s*(.*)$/i.exec(lines[i]);
        if (!m) continue;
        const [, key, restRaw] = m;
        const rest = restRaw.trim();
        if (/^[|>][+-]?$/.test(rest)) {
          const block = [];
          let j = i + 1;
          while (j < lines.length && (lines[j].startsWith("  ") || lines[j].trim() === "")) { block.push(lines[j].replace(/^ {2}/, "")); j++; }
          fm[key] = rest.startsWith(">") ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trimEnd();
          i = j - 1;
        } else {
          fm[key] = rest.replace(/^["']|["']$/g, "");
        }
      }
      return { fm, body: raw.slice(end + 5) };
    };
    const roots = [join(homedir(), ".claude", "skills"), join(homedir(), ".claude", "skills.quarantine")];
    const targets = [];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const d of readdirSync(root)) {
        const dir = join(root, d);
        if (!existsSync(join(dir, "SKILL.md"))) continue;
        try {
          const p = readTolerant(dir);
          if (!p || !p.fm.name) continue;
          const desc = String(p.fm.description ?? "");
          if (desc.length <= 1024) continue;
          // A quarantine copy whose clean name is already ACTIVE in the
          // skills root is a stale leftover — tuning it would only hit the
          // restore-collision refusal (live-caught: wiki-watch and
          // learn-from-video were both re-trimmed by hand months ago).
          // Surface it for deletion instead of burning a cycle on it.
          if (root.endsWith("skills.quarantine") && existsSync(join(homedir(), ".claude", "skills", p.fm.name, "SKILL.md"))) {
            summary.skipped.push(`${p.fm.name}: stale quarantine copy (active version exists) — safe to delete ${dir}`);
            continue;
          }
          const skillId = `${p.fm.name}@${p.fm.version ?? "1.0.0"}@${p.fm.scope ?? "global"}`;
          if (busy.has(skillId)) { summary.skipped.push(`${skillId}: pending review or mutated <24h ago`); continue; }
          targets.push({ dir, parsed: p, skillId, desc_len: desc.length });
        } catch { /* unreadable dir — skip */ }
      }
    }
    targets.sort((a, b) => b.desc_len - a.desc_len);
    for (const t of targets.slice(0, MAX_DESC_CYCLES)) {
      log(`desc-tune: ${t.skillId} (${t.desc_len} chars, ${t.dir})`);
      const parent = await buildSkill(
        { name: t.parsed.fm.name, description: String(t.parsed.fm.description ?? ""),
          version: t.parsed.fm.version ?? "1.0.0", scope: t.parsed.fm.scope ?? "global" },
        t.parsed.body,
        { source_path: join(t.dir, "SKILL.md") },
      );
      parent.skill_dir = t.dir;   // the DESC-TUNE[<marker>] contract derives from this
      const r = await runMutationCycle(db, parent, { projectPath: PROJECT_PATH, description_tune: true });
      summary.desc_cycles.push({ skill_id: t.skillId, desc_len: t.desc_len, dir: t.dir, pending: r.pending_result_id ?? null, reason: r.reason.slice(0, 200) });
    }
  } catch (e) { summary.errors.push(`desc cycles: ${e.message}`); }

  // ── 5. V2: threat-review of skills admitted/updated in the last 24h ───────
  // "Every change gets threat-modeled" — human-authored skills enter through
  // the filesystem import, which checks integrity and scripts but never asks
  // what an obedient agent would be DIRECTED to do. Mutation candidates get
  // this review inside the cycle; this pass covers everything else. The 24h
  // window doubles as the dedup (nightly cadence → each admission reviewed
  // once). Advisory only: medium/high → operator inbox.
  try {
    if (process.env.ZC_THREAT_REVIEW !== "0") {
      const recent = await withClient(async (c) => (await c.query(
        `SELECT DISTINCT skill_name FROM skill_admission_log_pg
          WHERE event IN ('admitted','updated') AND ts > now() - interval '24 hours'`)).rows.map((r) => r.skill_name));
      const { threatReviewSkillBody } = await import(`file:///${SC}/dist/skills/threat_review.js`.replace(/\\/g, "/"));
      summary.threat_reviews = [];
      for (const name of recent.slice(0, 3)) {
        const s = skills.find((x) => x.frontmatter.name === name);
        if (!s) continue;
        const t = threatReviewSkillBody(name, s.frontmatter.description ?? "", s.body);
        summary.threat_reviews.push({ name, risk: t?.risk ?? "review-failed", rationale: (t?.rationale ?? "").slice(0, 120) });
        if (t && t.risk !== "low") {
          await inbox(`THREAT-REVIEW: ${name} (admitted/updated <24h ago) — risk ${t.risk.toUpperCase()}: ${t.rationale}. Review the skill body; deterministic gates (HMAC/AST) still hold, this is about what the prose directs agents to do.`);
        }
      }
      if (recent.length > 3) summary.threat_reviews.push({ name: `(+${recent.length - 3} more deferred to next sweep)`, risk: "-", rationale: "" });
    }
  } catch (e) { summary.errors.push(`threat reviews: ${e.message}`); }

  // Per-result PENDING REVIEW inbox notices are emitted by the cycle itself
  // (v0.63.0 V3) — no aggregate summary needed here anymore. L2 promotions
  // still get one line since they queue outside the cycle.
  if ((summary.l2?.queued ?? 0) > 0) {
    await inbox(`NIGHTLY SWEEP: ${summary.l2.queued} cross-project promotion candidate(s) queued for review (zc_skill_pending_promotions).`);
  }
  db.close();
  finish(summary.errors.length > 0 ? 1 : 0);
} catch (e) {
  summary.errors.push(`fatal: ${e.message}`);
  finish(1);
}
