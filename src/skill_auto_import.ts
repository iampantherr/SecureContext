/**
 * v0.20.0 — Auto-import skills/*.skill.md files into skills_pg.
 *
 * Closes the gap surfaced in the v0.19.0 E2E report: the role-to-skill
 * extractor produced 25 .skill.md files on disk, but they were invisible
 * to the mutator + skill_candidate detector because skills_pg was empty.
 *
 * What this does:
 *   1. Walk SKILLS_DIR (default: <repo_root>/skills) for *.skill.md
 *   2. Parse YAML frontmatter + body (simple parser — no js-yaml dep)
 *   3. UPSERT into skills_pg keyed by skill_id (or compute name@version@scope)
 *   4. Compute body_hmac via the existing HMAC chain primitive (or fallback
 *      to plain SHA256 for v0.20.0 — full chain integration is v0.21+)
 *   5. Idempotent: re-running skips skills whose body hasn't changed
 *
 * Run on:
 *   - API container startup (in api-server.ts setup hook)
 *   - Manual via POST /dashboard/skills/import (force=true to re-run)
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { withClient } from "./pg_pool.js";
import { logger } from "./logger.js";
// v0.20.1 — use the project's HMAC-keyed body hash. Earlier v0.20.0 used
// plain SHA256, which the skill loader rejects with "body HMAC mismatch —
// refusing to load (possible tampering or machine-secret rotation)" when
// downstream code (mutator, dashboard) tries to load the skill. Caught in
// live test on Test_Agent_Coordination after the mutator generated 5
// candidates and the dashboard tried to render the parent skill body.
import { computeSkillBodyHmac, buildSkill } from "./skills/loader.js";
// v0.23.3 — route the actual write through storage_dual.upsertSkill so the
// Phase 1 lint + security_scan gates fire on every auto-imported skill, and
// every attempt produces an audit row in skill_security_scans_pg. Until
// v0.23.3 the auto-import did raw INSERT/UPDATE and bypassed both gates,
// which is why pre-v0.23.0 skills had no scan history in the dashboard.
import { upsertSkill as upsertSkillThroughGates } from "./skills/storage_dual.js";
import type { Skill, SkillFrontmatter as CanonicalFm, SkillScope } from "./skills/types.js";

// Resolve the skills/ dir relative to the running module. In the Docker
// container this is /app/skills (copied during the build); in dev/native
// it's <repo_root>/skills.
function resolveSkillsDir(): string {
  if (process.env.ZC_SKILLS_DIR) return process.env.ZC_SKILLS_DIR;
  // Distributed location: dist/skill_auto_import.js → ../skills
  // Source location: src/skill_auto_import.ts → ../skills (compiled away)
  try {
    const fname = fileURLToPath(import.meta.url);
    const dir = dirname(fname);
    // Try ../skills (covers both dist + src under repo root)
    const repoRoot = join(dir, "..");
    const candidate = join(repoRoot, "skills");
    if (existsSync(candidate)) return candidate;
  } catch { /* not running as ESM module — fall back below */ }
  // Last resort: relative to cwd
  return join(process.cwd(), "skills");
}

interface SkillFrontmatter {
  id?:                  string;
  name?:                string;
  version?:             string | number;
  scope?:               string;
  description?:         string;
  intended_roles?:      string[];
  mutation_guidance?:   string;
  tags?:                string[];
  acceptance_criteria?: Record<string, unknown>;
}

interface ParsedSkill {
  filename:    string;
  full_path:   string;
  frontmatter: SkillFrontmatter;
  body:        string;
  parse_error: string | null;
}

/**
 * Minimal YAML frontmatter parser. Doesn't do everything js-yaml does, but
 * handles our skill-file shape: scalars, arrays inline ([a, b, c]), and
 * multi-line strings via `|` indicator.
 *
 * Skill files are author-controlled, not adversarial input — we don't need
 * a hardened parser. If a skill file has unparseable YAML, we surface the
 * error in the import report and skip the file.
 */
function parseFrontmatter(raw: string): { fm: SkillFrontmatter; body: string; error: string | null } {
  if (!raw.startsWith("---\n")) return { fm: {}, body: raw, error: "missing frontmatter --- delimiter" };
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { fm: {}, body: raw, error: "unterminated frontmatter (no closing ---)" };
  const fmText = raw.slice(4, end);
  const body   = raw.slice(end + 5);
  const fm: SkillFrontmatter = {};
  // Walk lines; support `key: value`, `key: [a, b, c]`, `key: |\n  ...`
  const lines = fmText.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const m = line.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
    if (!m) { i++; continue; }
    const [, key, rest] = m;
    if (rest === "|") {
      // Multi-line block scalar — collect indented lines
      const block: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
        block.push(lines[i].replace(/^ {2}/, ""));
        i++;
      }
      (fm as Record<string, unknown>)[key] = block.join("\n").trimEnd();
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      // Inline array
      const inner = rest.slice(1, -1).trim();
      (fm as Record<string, unknown>)[key] = inner ? inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")) : [];
    } else {
      // Plain scalar — strip quotes if any
      (fm as Record<string, unknown>)[key] = rest.replace(/^["']|["']$/g, "");
    }
    i++;
  }
  return { fm, body, error: null };
}

function listSkillFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (entry.startsWith("_") || entry.startsWith(".")) continue;  // staging dirs, hidden
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".skill.md")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Parse one skill file into structured form. */
export function parseSkillFile(fullPath: string): ParsedSkill {
  try {
    const raw = readFileSync(fullPath, "utf-8");
    const { fm, body, error } = parseFrontmatter(raw);
    return { filename: basename(fullPath), full_path: fullPath, frontmatter: fm, body, parse_error: error };
  } catch (e) {
    return { filename: basename(fullPath), full_path: fullPath, frontmatter: {}, body: "", parse_error: (e as Error).message };
  }
}

// v0.20.1 — delegate to the canonical computeSkillBodyHmac from loader.ts.
// Async because it derives a subkey from the machine secret. Idempotency
// for the auto-import is unchanged: same body → same HMAC → row skipped.

interface ImportSummary {
  scanned:      number;
  inserted:     number;
  updated:      number;
  skipped_same: number;
  parse_errors: number;
  validation_errors: number;
  details:      Array<{ file: string; result: string; reason?: string; skill_id?: string }>;
}

/**
 * Walk the skills directory, parse each file, UPSERT into skills_pg.
 * Idempotent. Body hash detection: skip if existing body_hmac matches.
 */
export async function autoImportSkills(opts: { dir?: string; verbose?: boolean } = {}): Promise<ImportSummary> {
  const dir = opts.dir ?? resolveSkillsDir();
  const result: ImportSummary = {
    scanned: 0, inserted: 0, updated: 0, skipped_same: 0,
    parse_errors: 0, validation_errors: 0, details: [],
  };

  const files = listSkillFiles(dir);
  for (const f of files) {
    result.scanned++;
    const parsed = parseSkillFile(f);
    if (parsed.parse_error) {
      result.parse_errors++;
      result.details.push({ file: parsed.filename, result: "parse_error", reason: parsed.parse_error });
      continue;
    }
    const fm = parsed.frontmatter;

    // Required fields
    const name    = fm.name ?? basename(f).replace(/\.skill\.md$/, "");
    const version = String(fm.version ?? "1");
    const scope   = String(fm.scope ?? "global");
    const skillId = fm.id ?? `${name}@${version}@${scope}`;
    const description = String(fm.description ?? "(no description)");
    if (!name || !version || !scope) {
      result.validation_errors++;
      result.details.push({ file: parsed.filename, result: "validation_error", reason: "missing name/version/scope" });
      continue;
    }
    const bodyHmac = await computeSkillBodyHmac(parsed.body);

    try {
      // v0.23.3 — gate-enabled write path.
      //
      // 1. Check existing rows for the skill_id (active OR archived) — same
      //    branching as v0.23.1 to avoid PK violations on archived rows and
      //    to keep imports idempotent.
      // 2. For "actually need to write" branches (INSERT, UPDATE), build a
      //    proper Skill object and call storage_dual.upsertSkill(_, skill,
      //    "auto-import"). That routes through the lint + security_scan gates
      //    AND writes a row to skill_security_scans_pg. Without this routing,
      //    auto-imported skills bypass the gates entirely (the v0.23.0 design
      //    flaw — caught in dashboard click-through where every pre-v0.23
      //    skill showed "No security scans recorded").
      // 3. For "no-op" branches (skipped_same, archived_match, archived_stale),
      //    skip the upsert entirely so we don't double-scan unchanged content.

      // Step 1: peek at existing rows
      const existing = await withClient(async (c) => {
        const r = await c.query<{ body_hmac: string; archived_at: string | null }>(
          `SELECT body_hmac, archived_at FROM skills_pg WHERE skill_id=$1`,
          [skillId],
        );
        return r.rows[0] ?? null;
      });

      // Step 2: branch
      let upserted: "inserted" | "updated" | "skipped_same" | "skipped_archived_match" | "skipped_archived_stale";
      if (!existing) {
        // Fresh INSERT — gate
        const skill: Skill = await buildSkill(
          {
            ...fm,
            name,
            version,
            scope: scope as SkillScope,
            description,
          } as CanonicalFm,
          parsed.body,
          { source_path: f },
        );
        // Preserve the file's explicit `id:` if it sets a non-default skill_id
        if (fm.id && typeof fm.id === "string") skill.skill_id = fm.id;
        const memDb = new DatabaseSync(":memory:");
        try {
          await upsertSkillThroughGates(memDb, skill, "auto-import");
          upserted = "inserted";
        } finally {
          memDb.close();
        }
      } else if (existing.archived_at === null && existing.body_hmac === bodyHmac) {
        upserted = "skipped_same";
      } else if (existing.archived_at === null) {
        // Active row, body differs → re-gate and UPDATE
        const skill: Skill = await buildSkill(
          {
            ...fm,
            name,
            version,
            scope: scope as SkillScope,
            description,
          } as CanonicalFm,
          parsed.body,
          { source_path: f },
        );
        if (fm.id && typeof fm.id === "string") skill.skill_id = fm.id;
        const memDb = new DatabaseSync(":memory:");
        try {
          await upsertSkillThroughGates(memDb, skill, "auto-import");
          upserted = "updated";
        } finally {
          memDb.close();
        }
      } else if (existing.body_hmac === bodyHmac) {
        upserted = "skipped_archived_match";
      } else {
        upserted = "skipped_archived_stale";
      }
      if      (upserted === "inserted")     result.inserted++;
      else if (upserted === "updated")      result.updated++;
      else if (upserted === "skipped_same") result.skipped_same++;
      else if (upserted === "skipped_archived_match") {
        result.skipped_same++;  // count toward "no work to do"
        result.details.push({
          file: parsed.filename, result: "skipped_archived_match",
          skill_id: skillId,
          reason: "skill at this version was archived; on-disk body matches archived body — no action",
        });
        continue;
      }
      else if (upserted === "skipped_archived_stale") {
        result.validation_errors++;
        result.details.push({
          file: parsed.filename, result: "stale_version_on_disk",
          skill_id: skillId,
          reason: "this skill_id was archived (likely promoted past); on-disk body differs but version was not bumped — bump the version field in the source file or move/remove the file",
        });
        logger.warn("skills", "auto_import_stale_version", {
          skill_id: skillId, file: parsed.filename,
        });
        continue;
      }
      result.details.push({ file: parsed.filename, result: upserted, skill_id: skillId });
    } catch (e) {
      result.validation_errors++;
      result.details.push({ file: parsed.filename, result: "db_error", reason: (e as Error).message });
      logger.error("skills", "auto_import_db_failure", {
        skill_id: skillId, error: (e as Error).message,
      });
    }
  }

  logger.info("skills", "auto_import_complete", {
    dir,
    scanned: result.scanned, inserted: result.inserted, updated: result.updated,
    skipped_same: result.skipped_same, errors: result.parse_errors + result.validation_errors,
  });
  if (opts.verbose) {
    for (const d of result.details) console.log(`  [${d.result}] ${d.file}${d.reason ? `: ${d.reason}` : ""}`);
  }
  return result;
}

/**
 * v0.23.3 — One-time backfill: scan every ACTIVE skill that has NO scan
 * history yet. Idempotent (re-running won't double-scan since the WHERE
 * clause filters skills with at least one prior scan).
 *
 * Why this exists: pre-v0.23.0 skills were inserted via the raw-SQL
 * auto-import path that bypassed the security_scan gate. The dashboard's
 * 🛡 Security button shows "No security scans recorded" for all of them.
 * Spotted in user click-through after v0.23.2 shipped.
 *
 * Runs on container startup AFTER autoImportSkills, so freshly-inserted
 * skills (which already produced a scan via storage_dual.upsertSkill) are
 * skipped automatically.
 */
export async function backfillSecurityScans(): Promise<{ scanned: number; passed: number; failed: number }> {
  const result = { scanned: 0, passed: 0, failed: 0 };
  const { scanSkillBody } = await import("./skills/security_scan.js");
  const rows = await withClient(async (c) => {
    const r = await c.query<{ skill_id: string; frontmatter: unknown; body: string; body_hmac: string }>(
      `SELECT s.skill_id, s.frontmatter, s.body, s.body_hmac
         FROM skills_pg s
    LEFT JOIN skill_security_scans_pg sc ON sc.skill_id = s.skill_id
        WHERE s.archived_at IS NULL AND sc.skill_id IS NULL`,
    );
    return r.rows;
  });
  if (rows.length === 0) return result;

  logger.info("skills", "scan_backfill_start", { count: rows.length });
  for (const row of rows) {
    result.scanned++;
    const fm = typeof row.frontmatter === "string" ? JSON.parse(row.frontmatter) : row.frontmatter;
    const skill: Skill = {
      skill_id: row.skill_id,
      frontmatter: fm as CanonicalFm,
      body: row.body,
      body_hmac: row.body_hmac,
      source_path: null,
      promoted_from: null,
      created_at: new Date().toISOString(),
      archived_at: null,
      archive_reason: null,
    };
    try {
      const scan = await scanSkillBody(skill);
      const failureRows = scan.checks.filter((c) => !c.passed)
        .map((c) => ({ name: c.name, severity: c.severity, detail: c.detail ?? null }));
      await withClient(async (c) => {
        await c.query(
          `INSERT INTO skill_security_scans_pg
             (skill_id, candidate_hmac, body_hash, score, passed, failures, source)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            skill.skill_id,
            skill.body_hmac,
            scan.body_hash,
            scan.score,
            scan.passed,
            JSON.stringify(failureRows),
            "auto-import",
          ],
        );
      });
      if (scan.passed) result.passed++;
      else result.failed++;
    } catch (e) {
      result.failed++;
      // eslint-disable-next-line no-console
      console.error(`[scan-backfill] ${skill.skill_id}: ${(e as Error).message}`);
      logger.error("skills", "scan_backfill_failure", { skill_id: skill.skill_id, error: (e as Error).message });
    }
  }
  logger.info("skills", "scan_backfill_complete", result);
  return result;
}

/**
 * v0.24.2 — One-time backfill: classify intended_roles for any active
 * skill that has empty/undefined intended_roles. Idempotent — only touches
 * skills with no roles assigned.
 *
 * Why this exists: v0.24.0 marketplace pull set intended_roles=undefined,
 * orphaning all 17 anthropic-* skills. Operator caught this in
 * dashboard click-through. Without this backfill, those skills exist in
 * skills_pg but never get auto-injected at agent session start.
 *
 * Runs on container startup. Future marketplace pulls call the classifier
 * inline (see marketplace_pull.ts) so this backfill should converge to
 * a no-op once any historic gap is closed.
 */
export async function backfillIntendedRoles(): Promise<{ scanned: number; updated: number; skipped: number }> {
  const result = { scanned: 0, updated: 0, skipped: 0 };
  const rows = await withClient(async (c) => {
    const r = await c.query<{ skill_id: string; frontmatter: unknown; body: string; body_hmac: string }>(
      `SELECT skill_id, frontmatter, body, body_hmac
         FROM skills_pg
        WHERE archived_at IS NULL
          AND (frontmatter->'intended_roles' IS NULL
               OR frontmatter->'intended_roles' = 'null'::jsonb
               OR (jsonb_typeof(frontmatter->'intended_roles') = 'array'
                   AND jsonb_array_length(frontmatter->'intended_roles') = 0))`,
    );
    return r.rows;
  });
  if (rows.length === 0) return result;

  const { classifyRoles } = await import("./skills/role_classifier.js");
  logger.info("skills", "role_backfill_start", { count: rows.length });
  for (const row of rows) {
    result.scanned++;
    const fm = typeof row.frontmatter === "string" ? JSON.parse(row.frontmatter) : row.frontmatter;
    const skill: Skill = {
      skill_id: row.skill_id,
      frontmatter: fm as CanonicalFm,
      body: row.body,
      body_hmac: row.body_hmac,
      source_path: null,
      promoted_from: null,
      created_at: new Date().toISOString(),
      archived_at: null,
      archive_reason: null,
    };
    try {
      const r = await classifyRoles(skill);
      if (r.intended_roles.length === 0) {
        result.skipped++;
        continue;
      }
      // Update skills_pg.frontmatter.intended_roles in place. We use
      // jsonb_set to avoid round-tripping the full frontmatter — also
      // means no body_hmac change (HMAC covers body, not frontmatter).
      await withClient(async (c) => {
        await c.query(
          `UPDATE skills_pg
              SET frontmatter = jsonb_set(frontmatter, '{intended_roles}', $1::jsonb)
            WHERE skill_id = $2 AND archived_at IS NULL`,
          [JSON.stringify(r.intended_roles), row.skill_id],
        );
      });
      result.updated++;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[role-backfill] ${skill.skill_id}: ${(e as Error).message}`);
    }
  }
  logger.info("skills", "role_backfill_complete", result);
  return result;
}
