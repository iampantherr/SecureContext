/**
 * v0.24.0 Phase 2 — Marketplace pull from anthropics/skills (or any GitHub repo).
 *
 * Operator clicks "🛒 Pull from marketplace" on the dashboard. We:
 *   1. Fetch the repo tree from GitHub (no git binary needed)
 *   2. Walk for SKILL.md files
 *   3. Parse each, map their frontmatter → our SkillFrontmatter
 *   4. For each candidate, run lint + security_scan via storage_dual.upsertSkill
 *      with source="marketplace" — the Phase 1 gates ARE the marketplace gate.
 *      No bypass: an Anthropic-maintained skill that fails the gate is rejected
 *      same as any other source.
 *   5. Record EVERY attempt to skill_marketplace_pulls_pg with verdict
 *      (added / rejected_lint / rejected_scan / already_exists / stale_version
 *       / error) — operator sees full historic audit in the dashboard.
 *
 * GitHub API:
 *   - GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1 — list tree
 *   - GET https://raw.githubusercontent.com/{owner}/{repo}/{commit}/{path}
 *     — fetch raw file content
 *   No auth needed for public repos. Rate limit: 60/h unauthenticated; we
 *   only make ~20 calls per pull so well within budget.
 */

import { randomUUID, createHash } from "node:crypto";
import { withClient } from "../pg_pool.js";
import { logger } from "../logger.js";
import { DatabaseSync } from "node:sqlite";
import { upsertSkill, type SkillUpsertSource } from "./storage_dual.js";
import { buildSkill } from "./loader.js";
import type { Skill, SkillFrontmatter, SkillScope } from "./types.js";

export interface PullOptions {
  /** GitHub repo to pull from. Default: anthropics/skills. */
  source?: string;
  /** Branch to pull. Default: main. */
  branch?: string;
  /** Operator id for the audit log. Default: 'operator'. */
  pulled_by?: string;
}

export interface PullSummary {
  pull_id:        string;
  source:         string;
  source_commit:  string;
  total:          number;
  added:          number;
  rejected_lint:  number;
  rejected_scan:  number;
  already_exists: number;
  stale_version:  number;
  errors:         number;
  duration_ms:    number;
}

interface AnthropicSkillFm {
  name?:        string;
  description?: string;
  version?:     string | number;
  license?:     string;
  [k: string]:  unknown;
}

interface ParsedSkillFile {
  fm:    AnthropicSkillFm;
  body:  string;
  path:  string;
}

/**
 * Minimal frontmatter parser. Anthropic skills use simple key:value YAML —
 * no block scalars in their format. If we encounter exotic YAML, we'd reject
 * (the operator can investigate via the marketplace pulls audit).
 */
function parseSkillFrontmatter(raw: string): ParsedSkillFile | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---\n", 3);
  if (end === -1) return null;
  const fmText = raw.slice(raw.indexOf("\n") + 1, end);
  const body   = raw.slice(end + 5).trimStart();
  const fm: AnthropicSkillFm = {};
  for (const line of fmText.split("\n")) {
    const m = line.match(/^([a-z_][a-z0-9_-]*)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, k, v] = m;
    fm[k] = v.replace(/^["']|["']$/g, "");
  }
  return { fm, body, path: "" };
}

/**
 * Hit the GitHub tree API and return the list of SKILL.md paths + repo's
 * current commit SHA at HEAD-of-branch.
 */
async function listSkillPaths(source: string, branch: string): Promise<{
  paths: string[];
  commit: string;
}> {
  const url = `https://api.github.com/repos/${source}/git/trees/${branch}?recursive=1`;
  const res = await fetch(url, {
    headers: { "Accept": "application/vnd.github+json", "User-Agent": "zc-ctx-marketplace-pull" },
    signal:  AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub tree API ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
  }
  const j = await res.json() as { sha: string; tree: Array<{ path: string; type: string }> };
  const paths = j.tree
    .filter((t) => t.type === "blob" && t.path.endsWith("/SKILL.md") && t.path.startsWith("skills/"))
    .map((t) => t.path);
  return { paths, commit: j.sha };
}

/**
 * Fetch one raw file at the pinned commit (so the pull is reproducible — even
 * if the branch advances mid-pull, we get a consistent snapshot).
 */
async function fetchRaw(source: string, commit: string, path: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${source}/${commit}/${path}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "zc-ctx-marketplace-pull" },
    signal:  AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`raw ${path}: ${res.status}`);
  }
  return res.text();
}

/**
 * Map Anthropic's frontmatter shape to our internal SkillFrontmatter. They
 * don't use version/scope — default to "1"/"global". Their description goes
 * straight through; their `name` becomes our `name` (we prefix with "anthropic-"
 * to avoid collisions with operator-named skills).
 */
function mapToInternalFrontmatter(
  fm: AnthropicSkillFm,
  pathInRepo: string,
): SkillFrontmatter {
  const name = String(fm.name ?? pathInRepo.split("/").slice(-2, -1)[0] ?? "unknown");
  const version = String(fm.version ?? "1");
  const description = String(fm.description ?? "(no description)");
  return {
    name:    `anthropic-${name}`,
    version,
    scope:   "global" as SkillScope,
    description,
    intended_roles: undefined,
    tags:    ["marketplace", "anthropic-skills"],
  };
}

/**
 * Insert a row into the audit table. Best-effort — never throws back to the
 * pull loop (a logging failure shouldn't kill the whole pull).
 */
async function recordPullAttempt(args: {
  pull_id:           string;
  source:            string;
  source_commit:     string;
  source_path:       string;
  skill_name:        string;
  skill_version:     string;
  skill_scope:       string;
  candidate_skill_id: string;
  candidate_body_hash: string | null;
  /** v0.24.1: actual body so operator can see what was attempted (especially for rejected). */
  candidate_body:    string | null;
  /** v0.24.1: parsed frontmatter so operator sees declared metadata. */
  candidate_frontmatter: Record<string, unknown> | null;
  lint_passed:       boolean | null;
  lint_errors:       string[] | null;
  lint_warnings:     string[] | null;
  scan_score:        number | null;
  scan_passed:       boolean | null;
  scan_block_failures: Array<{ name: string; severity: string; detail: string | null }> | null;
  decision:          "added" | "rejected_lint" | "rejected_scan" | "already_exists" | "stale_version" | "error";
  decision_reason:   string;
  pulled_by:         string;
}): Promise<void> {
  try {
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO skill_marketplace_pulls_pg (
           pull_id, source, source_commit, source_path,
           skill_name, skill_version, skill_scope, candidate_skill_id, candidate_body_hash,
           candidate_body, candidate_frontmatter,
           lint_passed, lint_errors, lint_warnings,
           scan_score, scan_passed, scan_block_failures,
           decision, decision_reason, pulled_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                   $10, $11::jsonb,
                   $12, $13::jsonb, $14::jsonb,
                   $15, $16, $17::jsonb,
                   $18, $19, $20)`,
        [
          args.pull_id, args.source, args.source_commit, args.source_path,
          args.skill_name, args.skill_version, args.skill_scope,
          args.candidate_skill_id, args.candidate_body_hash,
          args.candidate_body,
          args.candidate_frontmatter === null ? null : JSON.stringify(args.candidate_frontmatter),
          args.lint_passed,
          args.lint_errors === null ? null : JSON.stringify(args.lint_errors),
          args.lint_warnings === null ? null : JSON.stringify(args.lint_warnings),
          args.scan_score, args.scan_passed,
          args.scan_block_failures === null ? null : JSON.stringify(args.scan_block_failures),
          args.decision, args.decision_reason, args.pulled_by,
        ],
      );
    });
  } catch (e) {
    process.stderr.write(`[marketplace-pull] audit-log write failed: ${(e as Error).message}\n`);
  }
}

/**
 * Run a marketplace pull. Idempotent at the per-skill level: if a skill is
 * already in skills_pg with the same body_hmac, we record decision='already_exists'
 * and skip. Different body → we'd hit the gate; a passed scan would update.
 *
 * Returns a summary the dashboard can render.
 */
export async function pullFromMarketplace(opts: PullOptions = {}): Promise<PullSummary> {
  const startedAt = Date.now();
  const source    = opts.source ?? process.env.ZC_MARKETPLACE_SOURCE ?? "anthropics/skills";
  const branch    = opts.branch ?? "main";
  const pulled_by = opts.pulled_by ?? "operator";
  const pull_id   = randomUUID();

  logger.info("skills", "marketplace_pull_start", { pull_id, source, branch });

  let listing;
  try {
    listing = await listSkillPaths(source, branch);
  } catch (e) {
    // Record one error row so the pull is at least visible in the audit log
    await recordPullAttempt({
      pull_id, source, source_commit: "", source_path: "",
      skill_name: "(repo)", skill_version: "", skill_scope: "global",
      candidate_skill_id: "", candidate_body_hash: null,
      candidate_body: null, candidate_frontmatter: null,
      lint_passed: null, lint_errors: null, lint_warnings: null,
      scan_score: null, scan_passed: null, scan_block_failures: null,
      decision: "error",
      decision_reason: `repo listing failed: ${(e as Error).message}`,
      pulled_by,
    });
    return {
      pull_id, source, source_commit: "",
      total: 0, added: 0, rejected_lint: 0, rejected_scan: 0,
      already_exists: 0, stale_version: 0, errors: 1,
      duration_ms: Date.now() - startedAt,
    };
  }

  const summary: PullSummary = {
    pull_id, source, source_commit: listing.commit,
    total: listing.paths.length,
    added: 0, rejected_lint: 0, rejected_scan: 0,
    already_exists: 0, stale_version: 0, errors: 0,
    duration_ms: 0,
  };

  // SQLite handle for storage_dual.upsertSkill — we run on PG-only backend
  // but the function signature requires it. Skipped at the SQLite branch
  // when ZC_TELEMETRY_BACKEND=postgres.
  const memDb = new DatabaseSync(":memory:");
  try {
    for (const path of listing.paths) {
      let raw: string;
      try {
        raw = await fetchRaw(source, listing.commit, path);
      } catch (e) {
        summary.errors++;
        await recordPullAttempt({
          pull_id, source, source_commit: listing.commit, source_path: path,
          skill_name: path, skill_version: "", skill_scope: "global",
          candidate_skill_id: "", candidate_body_hash: null,
          candidate_body: null, candidate_frontmatter: null,
          lint_passed: null, lint_errors: null, lint_warnings: null,
          scan_score: null, scan_passed: null, scan_block_failures: null,
          decision: "error", decision_reason: `fetch failed: ${(e as Error).message}`,
          pulled_by,
        });
        continue;
      }
      const parsed = parseSkillFrontmatter(raw);
      if (!parsed) {
        summary.errors++;
        await recordPullAttempt({
          pull_id, source, source_commit: listing.commit, source_path: path,
          skill_name: path, skill_version: "", skill_scope: "global",
          candidate_skill_id: "", candidate_body_hash: null,
          candidate_body: raw, candidate_frontmatter: null,
          lint_passed: null, lint_errors: null, lint_warnings: null,
          scan_score: null, scan_passed: null, scan_block_failures: null,
          decision: "error", decision_reason: "frontmatter parse failed",
          pulled_by,
        });
        continue;
      }

      const fm = mapToInternalFrontmatter(parsed.fm, path);
      const candidateBodyHash = createHash("sha256").update(parsed.body).digest("hex");
      let skill: Skill;
      try {
        skill = await buildSkill(fm, parsed.body, { source_path: `marketplace://${source}/${path}` });
        // v0.24.2: classify roles from the built skill (name + description +
        // body). Without this, marketplace skills land in skills_pg with
        // intended_roles=undefined and never get auto-injected at session
        // start. The keyword classifier is local + fast (no API cost);
        // operator can override via the dashboard's Edit frontmatter button
        // if the heuristic gets it wrong.
        const { classifyRoles } = await import("./role_classifier.js");
        const roleResult = await classifyRoles(skill);
        if (roleResult.intended_roles.length > 0) {
          skill.frontmatter.intended_roles = roleResult.intended_roles;
        }
      } catch (e) {
        summary.errors++;
        await recordPullAttempt({
          pull_id, source, source_commit: listing.commit, source_path: path,
          skill_name: fm.name, skill_version: fm.version, skill_scope: fm.scope,
          candidate_skill_id: "", candidate_body_hash: candidateBodyHash,
          candidate_body: parsed.body, candidate_frontmatter: parsed.fm as Record<string, unknown>,
          lint_passed: null, lint_errors: null, lint_warnings: null,
          scan_score: null, scan_passed: null, scan_block_failures: null,
          decision: "error", decision_reason: `buildSkill failed: ${(e as Error).message}`,
          pulled_by,
        });
        continue;
      }

      // Idempotency check: if the skill already exists with same body_hmac,
      // record already_exists and skip without running gates again.
      const existing = await withClient(async (c) => {
        const r = await c.query<{ body_hmac: string; archived_at: string | null }>(
          `SELECT body_hmac, archived_at FROM skills_pg WHERE skill_id=$1`,
          [skill.skill_id],
        );
        return r.rows[0] ?? null;
      });

      if (existing && existing.archived_at === null && existing.body_hmac === skill.body_hmac) {
        summary.already_exists++;
        await recordPullAttempt({
          pull_id, source, source_commit: listing.commit, source_path: path,
          skill_name: fm.name, skill_version: fm.version, skill_scope: fm.scope,
          candidate_skill_id: skill.skill_id, candidate_body_hash: candidateBodyHash,
          candidate_body: skill.body, candidate_frontmatter: skill.frontmatter as unknown as Record<string, unknown>,
          lint_passed: null, lint_errors: null, lint_warnings: null,
          scan_score: null, scan_passed: null, scan_block_failures: null,
          decision: "already_exists",
          decision_reason: "skill_id already in skills_pg with matching body_hmac",
          pulled_by,
        });
        continue;
      }

      if (existing && existing.archived_at !== null) {
        // Archived row at this skill_id — operator has already promoted past
        // this version. Refusing to resurrect.
        summary.stale_version++;
        await recordPullAttempt({
          pull_id, source, source_commit: listing.commit, source_path: path,
          skill_name: fm.name, skill_version: fm.version, skill_scope: fm.scope,
          candidate_skill_id: skill.skill_id, candidate_body_hash: candidateBodyHash,
          candidate_body: skill.body, candidate_frontmatter: skill.frontmatter as unknown as Record<string, unknown>,
          lint_passed: null, lint_errors: null, lint_warnings: null,
          scan_score: null, scan_passed: null, scan_block_failures: null,
          decision: "stale_version",
          decision_reason: `skill_id ${skill.skill_id} was previously archived (likely promoted past); marketplace pull won't resurrect it`,
          pulled_by,
        });
        continue;
      }

      // Run the gates BEFORE upsert so we can record per-check details.
      // upsertSkill itself runs lint + scan but throws on rejection — we
      // want the verdict regardless of outcome for the audit log, so we
      // compute it explicitly first.
      const { lintSkillBody } = await import("./lint.js");
      const lint = lintSkillBody(skill.body, skill.frontmatter);

      const { scanSkillBody } = await import("./security_scan.js");
      const scan = await scanSkillBody(skill);

      const blockFailures = scan.checks.filter((c) => !c.passed && c.severity === "block")
        .map((c) => ({ name: c.name, severity: c.severity, detail: c.detail ?? null }));

      // Decide and record
      if (!lint.ok) {
        summary.rejected_lint++;
        await recordPullAttempt({
          pull_id, source, source_commit: listing.commit, source_path: path,
          skill_name: fm.name, skill_version: fm.version, skill_scope: fm.scope,
          candidate_skill_id: skill.skill_id, candidate_body_hash: candidateBodyHash,
          candidate_body: skill.body, candidate_frontmatter: skill.frontmatter as unknown as Record<string, unknown>,
          lint_passed: false, lint_errors: lint.errors, lint_warnings: lint.warnings,
          scan_score: scan.score, scan_passed: scan.passed, scan_block_failures: blockFailures,
          decision: "rejected_lint",
          decision_reason: `lint failed with ${lint.errors.length} error(s): ${lint.errors.slice(0, 3).join("; ")}`,
          pulled_by,
        });
        continue;
      }

      if (blockFailures.length > 0 || scan.score <= 6) {
        summary.rejected_scan++;
        await recordPullAttempt({
          pull_id, source, source_commit: listing.commit, source_path: path,
          skill_name: fm.name, skill_version: fm.version, skill_scope: fm.scope,
          candidate_skill_id: skill.skill_id, candidate_body_hash: candidateBodyHash,
          candidate_body: skill.body, candidate_frontmatter: skill.frontmatter as unknown as Record<string, unknown>,
          lint_passed: true, lint_errors: [], lint_warnings: lint.warnings,
          scan_score: scan.score, scan_passed: scan.passed, scan_block_failures: blockFailures,
          decision: "rejected_scan",
          decision_reason: blockFailures.length > 0
            ? `block-severity scan failures: ${blockFailures.map((f) => f.name).join(", ")}`
            : `scan score ${scan.score}/8 below threshold`,
          pulled_by,
        });
        continue;
      }

      // Passed both gates — upsert
      try {
        const source_for_upsert: SkillUpsertSource = "marketplace";
        await upsertSkill(memDb, skill, source_for_upsert);
        summary.added++;
        await recordPullAttempt({
          pull_id, source, source_commit: listing.commit, source_path: path,
          skill_name: fm.name, skill_version: fm.version, skill_scope: fm.scope,
          candidate_skill_id: skill.skill_id, candidate_body_hash: candidateBodyHash,
          candidate_body: skill.body, candidate_frontmatter: skill.frontmatter as unknown as Record<string, unknown>,
          lint_passed: true, lint_errors: [], lint_warnings: lint.warnings,
          scan_score: scan.score, scan_passed: scan.passed, scan_block_failures: [],
          decision: "added",
          decision_reason: `lint OK; scan ${scan.score}/8; upserted via storage_dual`,
          pulled_by,
        });
      } catch (e) {
        // Could happen if the gate-runner inside upsertSkill rejects despite
        // our pre-check passing (unlikely but possible — different scan
        // semantics). Record as error.
        summary.errors++;
        await recordPullAttempt({
          pull_id, source, source_commit: listing.commit, source_path: path,
          skill_name: fm.name, skill_version: fm.version, skill_scope: fm.scope,
          candidate_skill_id: skill.skill_id, candidate_body_hash: candidateBodyHash,
          candidate_body: skill.body, candidate_frontmatter: skill.frontmatter as unknown as Record<string, unknown>,
          lint_passed: true, lint_errors: [], lint_warnings: lint.warnings,
          scan_score: scan.score, scan_passed: scan.passed, scan_block_failures: blockFailures,
          decision: "error",
          decision_reason: `upsertSkill threw: ${(e as Error).message}`,
          pulled_by,
        });
      }
    }
  } finally {
    memDb.close();
  }

  summary.duration_ms = Date.now() - startedAt;
  logger.info("skills", "marketplace_pull_complete", { ...summary });
  return summary;
}
