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
import { createHash } from "node:crypto";
import { withClient } from "./pg_pool.js";
import { logger } from "./logger.js";

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

function computeBodyHmac(body: string): string {
  // v0.20.0 — plain SHA256. Migrating to HMAC-keyed via machine_secret is a
  // v0.21+ task. Plain hash is enough to detect body changes for
  // idempotency; integrity-on-PG is a future hardening.
  return createHash("sha256").update(body).digest("hex");
}

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
    const bodyHmac = computeBodyHmac(parsed.body);

    try {
      // Check existing — idempotent skip if body unchanged
      const upserted = await withClient(async (c) => {
        const existing = await c.query<{ body_hmac: string }>(
          `SELECT body_hmac FROM skills_pg WHERE skill_id=$1 AND archived_at IS NULL`,
          [skillId],
        );
        if (existing.rows[0]?.body_hmac === bodyHmac) {
          return "skipped_same";
        }
        if (existing.rows[0]) {
          // Update body + frontmatter; preserve created_at
          await c.query(
            `UPDATE skills_pg
                SET name=$2, version=$3, scope=$4, description=$5,
                    frontmatter=$6::jsonb, body=$7, body_hmac=$8, source_path=$9
              WHERE skill_id=$1`,
            [skillId, name, version, scope, description, JSON.stringify(fm), parsed.body, bodyHmac, f],
          );
          return "updated";
        }
        await c.query(
          `INSERT INTO skills_pg (
              skill_id, name, version, scope, description,
              frontmatter, body, body_hmac, source_path, created_at
            ) VALUES ($1,$2,$3,$4,$5, $6::jsonb, $7, $8, $9, now())`,
          [skillId, name, version, scope, description, JSON.stringify(fm), parsed.body, bodyHmac, f],
        );
        return "inserted";
      });
      if      (upserted === "inserted")     result.inserted++;
      else if (upserted === "updated")      result.updated++;
      else if (upserted === "skipped_same") result.skipped_same++;
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
