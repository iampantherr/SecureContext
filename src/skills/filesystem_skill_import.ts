/**
 * v0.26.0 Step 2 — Filesystem-skill watcher (Anthropic directory layout).
 *
 * Walks ~/.claude/skills/<name>/SKILL.md (and per-project .claude/skills/)
 * mirrors each skill into skills_pg with:
 *   - body_hmac of SKILL.md
 *   - script_hmacs JSONB { "scripts/foo.py": "<hmac>", ... }
 *   - skill_dir = absolute path of source directory
 *
 * This is the entry point for the FS-source-of-truth model where Claude Code
 * natively discovers skills under ~/.claude/skills/ and the bundled scripts
 * are the leverage layer (per Anthropic's progressive-disclosure design).
 *
 * Step 2 deliberately does NOT include:
 *   - Quarantine on scan failure (Step 3)
 *   - HMAC verify-before-execute (Step 4)
 *   - allowed_tools enforcement (Step 5)
 *   - Chained scan log (Step 6)
 * It just mirrors + hashes. Those layers extend this module additively.
 *
 * IDEMPOTENCY: same body + same script_hmacs → no-op. Different body or any
 * script changed → re-upsert (so dashboard reflects edits + Step 4 detects
 * tampering on next admission).
 */

import { readdirSync, readFileSync, existsSync, statSync, renameSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, isAbsolute, resolve as resolvePath, basename, dirname as pathDirname } from "node:path";
import { homedir } from "node:os";
import { createHmac } from "node:crypto";
import { withClient } from "../pg_pool.js";
import { logger } from "../logger.js";
import { getMachineSecret } from "../security/machine_secret.js";
import { scanScriptFile, type ScriptScanResult } from "./script_scanner.js";
import { recordAdmissionEvent } from "./admission_log.js";

/**
 * Anthropic SKILL.md frontmatter — minimal required fields per spec.
 * We accept additional fields (intended_roles, tags, etc.) when present.
 */
export interface AnthropicSkillFrontmatter {
  name:          string;
  description:   string;
  // Step 5 additions (read but enforced separately):
  allowed_tools?:           string[];
  user_invocable?:          boolean;
  disable_model_invocation?: boolean;
  // v0.27.0 — explicit operator opt-in for skills that legitimately need
  // subprocess shell=True or os.system-equivalent (e.g. dev-server
  // orchestration in anthropic-webapp-testing). Without this flag the
  // AST scanner's shell_exec findings are block-severity. WITH this flag
  // they're downgraded to warn-severity and the skill is admitted.
  // Operators MUST manually review the skill's source before setting.
  shell_exec_ok?: boolean;
  // v0.27.0 — explicit operator opt-in for skills that bundle scripts in
  // languages the scanner doesn't yet support (bash .sh, ruby .rb, etc.).
  // Without this flag, files with unrecognized executable extensions are
  // blocked as `unsupported_language`. WITH this flag, they're admitted
  // unscanned (operator vouches for them). Data files (.xml, .json, etc.)
  // are already exempt via the scanner's data-file whitelist regardless
  // of this flag.
  unsupported_scripts_ok?: boolean;
  // Our extensions (optional):
  version?:       string;
  scope?:         string;
  intended_roles?: string[];
  tags?:          string[];
}

export interface ParsedFsSkill {
  /** Skill directory absolute path */
  skill_dir:   string;
  /** Skill name (from frontmatter, or directory name as fallback) */
  name:        string;
  /** Path to SKILL.md (always inside skill_dir) */
  skill_md:    string;
  /** Parsed frontmatter */
  fm:          AnthropicSkillFrontmatter;
  /** SKILL.md body content (after frontmatter) */
  body:        string;
  /** Map of relative script path → HMAC */
  script_hmacs: Record<string, string>;
  /** Parse error (null if OK) */
  parse_error: string | null;
}

/**
 * Atomic-move a skill directory to ~/.claude/skills.quarantine/ when its
 * admission scan fails. Writes a .quarantine-reason.txt at the destination
 * with the operator-readable reason. Returns { ok, newPath, error }.
 */
function quarantineSkillDir(skillDir: string, reason: string): { ok: boolean; newPath: string; error?: string } {
  // Quarantine root is the SIBLING of the skill's parent (e.g. ~/.claude/skills/X/ → ~/.claude/skills.quarantine/X/)
  const parentDir = pathDirname(skillDir);                  // ~/.claude/skills
  const parentName = basename(parentDir);                   // "skills"
  const quarantineRoot = join(pathDirname(parentDir), parentName + ".quarantine");
  const skillName = basename(skillDir);
  // Suffix with timestamp so re-quarantining the same name doesn't collide
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const newPath = join(quarantineRoot, `${skillName}__${ts}`);
  try {
    mkdirSync(quarantineRoot, { recursive: true });
    // Try renameSync first (atomic, fast); fall back to copy+delete if the
    // mount points are separate "devices" (Docker bind-mounts trigger EXDEV
    // even when both paths are the same host filesystem).
    try {
      renameSync(skillDir, newPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EXDEV") throw e;
      // Cross-device fallback: recursive copy + rm
      copyDirRecursive(skillDir, newPath);
      rmSync(skillDir, { recursive: true, force: true });
    }
    writeFileSync(
      join(newPath, ".quarantine-reason.txt"),
      `Quarantined at ${new Date().toISOString()}\nOriginal path: ${skillDir}\nReason: ${reason}\n`,
      "utf8",
    );
    return { ok: true, newPath };
  } catch (e) {
    return { ok: false, newPath, error: (e as Error).message };
  }
}

/** Recursive copy used by quarantineSkillDir when renameSync hits EXDEV. */
function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    const st = statSync(s);
    if (st.isDirectory()) copyDirRecursive(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

/**
 * Mirror a quarantined skill to skills_pg with quarantined=TRUE so the
 * dashboard can surface it. Body + frontmatter are persisted so the
 * operator can review what was inside without going to disk.
 */
/**
 * v0.26.0 Step 5 — Record a quarantined skill in PG when the frontmatter is
 * SO malformed we can't even derive a proper skill_id from it. Uses the
 * directory basename as the name fallback, with @0.0.0@quarantine as version.
 */
async function recordQuarantineForParseError(originalDir: string, newPath: string, reason: string): Promise<void> {
  const dirName = basename(originalDir);
  // Synthetic skill_id (we never expect this row to be referenced as a real skill)
  const skillId = `${dirName}@0.0.0@quarantine`;
  try {
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO skills_pg
           (skill_id, name, version, scope, description, frontmatter, body, body_hmac, source_path, created_at, skill_dir, script_hmacs, quarantined, quarantine_reason)
         VALUES ($1,$2,'0.0.0','quarantine',$3,$4::jsonb,'',$5,$6,now(),$7,'{}'::jsonb,TRUE,$3)
         ON CONFLICT (skill_id) DO UPDATE SET
           skill_dir = EXCLUDED.skill_dir,
           quarantined = TRUE,
           quarantine_reason = EXCLUDED.quarantine_reason`,
        [
          skillId,
          dirName,                                                      // name (best-effort)
          reason,                                                       // description AND quarantine_reason
          JSON.stringify({ parse_error: reason, dir: originalDir }),    // frontmatter
          "00".repeat(32),                                              // body_hmac (zeros — this row is never executed)
          join(originalDir, "SKILL.md"),                                // source_path
          newPath,                                                      // skill_dir (post-quarantine path)
        ],
      );
    });
  } catch (e) {
    logger.error("skills", "fs_skill_parse_error_pg_write_failed", { skill_id: skillId, error: (e as Error).message });
  }
}

async function recordQuarantine(parsed: ParsedFsSkill, newPath: string, reason: string): Promise<void> {
  const version = parsed.fm.version ?? "1.0.0";
  const scope = parsed.fm.scope ?? "global";
  const skillId = `${parsed.fm.name}@${version}@${scope}`;
  const secret = getMachineSecret();
  // We use a sentinel body_hmac (just the SHA of the body without the script HMAC layer)
  // because the skill is rejected — we don't need to satisfy storage_dual's verify-on-load.
  const bodyHmac = createHmac("sha256", secret).update("body:").update(parsed.body).digest("hex");
  try {
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO skills_pg
           (skill_id, name, version, scope, description, frontmatter, body, body_hmac, source_path, created_at, skill_dir, script_hmacs, quarantined, quarantine_reason)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,now(),$10,$11::jsonb,TRUE,$12)
         ON CONFLICT (skill_id) DO UPDATE SET
           skill_dir = EXCLUDED.skill_dir,
           script_hmacs = EXCLUDED.script_hmacs,
           quarantined = TRUE,
           quarantine_reason = EXCLUDED.quarantine_reason,
           body = EXCLUDED.body,
           frontmatter = EXCLUDED.frontmatter`,
        [
          skillId, parsed.fm.name, version, scope,
          parsed.fm.description,
          JSON.stringify(parsed.fm),
          parsed.body, bodyHmac,
          parsed.skill_md,
          newPath, JSON.stringify(parsed.script_hmacs), reason,
        ],
      );
    });
  } catch (e) {
    logger.error("skills", "fs_skill_quarantine_pg_write_failed", { skill_id: skillId, error: (e as Error).message });
  }
}


/**
 * Minimal YAML frontmatter parser tailored for SKILL.md.
 * Supports: scalars, inline arrays [a, b, c], block scalars `key: |\n  ...`,
 * booleans true/false, and double-quoted strings.
 * Returns parse error on malformed content; caller decides whether to skip.
 */
function parseFrontmatter(raw: string): { fm: AnthropicSkillFrontmatter; body: string; error: string | null; rawFm: Record<string, unknown> } {
  // Allow CRLF + LF line endings (Windows-friendly)
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { fm: { name: "", description: "" }, body: normalized, error: "missing leading --- delimiter", rawFm: {} };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { fm: { name: "", description: "" }, body: normalized, error: "missing closing --- delimiter", rawFm: {} };
  }
  const fmText = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const fm: Record<string, unknown> = {};
  const lines = fmText.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const m = line.match(/^([a-z_][a-z0-9_-]*)\s*:\s*(.*)$/i);
    if (!m) { i++; continue; }
    const [, key, restRaw] = m;
    const rest = restRaw.trim();
    // YAML block scalars: `|` literal (keep newlines) and `>` folded (single
    // newlines fold to spaces), each optionally with a chomping indicator
    // (`-` strip / `+` keep). The skill-creator and many hand-authored skills
    // emit `description: >-` for long descriptions; before this branch handled
    // `>`, the parser fell through and set the field to the literal ">-" string,
    // so the skill admitted with a garbage description (or failed downstream).
    const blockScalar = rest.match(/^([|>])[+-]?$/);
    if (blockScalar) {
      const style = blockScalar[1];
      const block: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
        block.push(lines[i].replace(/^ {2}/, ""));
        i++;
      }
      if (style === ">") {
        // Folded: a run of non-blank lines joins with single spaces; a blank
        // line is a paragraph break preserved as a newline.
        fm[key] = block.join(" ").replace(/\s+/g, " ").trim();
      } else {
        fm[key] = block.join("\n").trimEnd();
      }
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      fm[key] = inner ? inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")) : [];
    } else if (rest === "true" || rest === "false") {
      fm[key] = (rest === "true");
    } else {
      fm[key] = rest.replace(/^["']|["']$/g, "");
    }
    i++;
  }
  // v0.26.0 Step 5 — return both the narrowed final form (with undefined
  // for type-mismatched optional fields) AND the raw parsed dict, so the
  // validator can detect type mismatches that the narrowing would otherwise
  // silently swallow.
  const finalFm: AnthropicSkillFrontmatter = {
    name: String(fm.name ?? ""),
    description: String(fm.description ?? ""),
    allowed_tools: Array.isArray(fm.allowed_tools) ? fm.allowed_tools as string[] : undefined,
    user_invocable: typeof fm.user_invocable === "boolean" ? fm.user_invocable : undefined,
    disable_model_invocation: typeof fm.disable_model_invocation === "boolean" ? fm.disable_model_invocation : undefined,
    // v0.27.0 — operator-explicit opt-in for legitimate subprocess shell use
    shell_exec_ok: typeof fm.shell_exec_ok === "boolean" ? fm.shell_exec_ok : undefined,
    unsupported_scripts_ok: typeof fm.unsupported_scripts_ok === "boolean" ? fm.unsupported_scripts_ok : undefined,
    version: fm.version ? String(fm.version) : undefined,
    scope: fm.scope ? String(fm.scope) : undefined,
    intended_roles: Array.isArray(fm.intended_roles) ? fm.intended_roles as string[] : undefined,
    tags: Array.isArray(fm.tags) ? fm.tags as string[] : undefined,
  };
  return { fm: finalFm, body, error: null, rawFm: fm };
}

/**
 * Recursively list every file inside a directory, returning paths
 * RELATIVE to that directory. Used to walk skill scripts/ and resources/.
 *
 * SECURITY: rejects any path that, after realpath resolution, would escape
 * the root. This blocks symlink-escape attacks (RT-S1-12 family).
 */
function listFilesRecursive(rootAbs: string, baseAbs?: string): string[] {
  const base = baseAbs ?? rootAbs;
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(rootAbs); } catch { return out; }
  for (const name of entries) {
    // v0.30.3 — skip caches/build artifacts that universally don't belong in
    // admission scans (Python bytecode, Node modules, test caches, VCS).
    // Without this, Python's __pycache__ generated by every script run would
    // appear as "unsupported_language" artifacts and quarantine the skill.
    if (
      name === "__pycache__" ||
      name === "node_modules" ||
      name === ".git" ||
      name === ".pytest_cache" ||
      name === ".mypy_cache" ||
      name === ".ruff_cache" ||
      name === ".venv" ||
      name === "venv"
    ) continue;
    const full = join(rootAbs, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    // Reject symlinks that escape the skill root. statSync follows symlinks
    // by default — use realpath to confirm.
    try {
      const resolved = resolvePath(full);
      if (!resolved.startsWith(resolvePath(base))) {
        // Symlink escape — skip
        continue;
      }
    } catch { continue; }
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(full, base));
    } else if (st.isFile()) {
      // Return path relative to BASE (skill root), not the recursing root
      out.push(full.slice(base.length + 1).replace(/\\/g, "/"));
    }
  }
  return out;
}

/**
 * Compute HMAC-SHA256 of a file's content using the machine secret.
 * Same primitive as src/skills/loader.computeSkillBodyHmac, but for
 * arbitrary script files.
 */
async function hmacFile(absPath: string): Promise<string> {
  const secret = getMachineSecret();  // returns Buffer
  const content = readFileSync(absPath);
  return createHmac("sha256", secret)
    .update("script:")  // distinct namespace from body hashes
    .update(content)
    .digest("hex");
}

/**
 * v0.26.0 Step 5 — Validate Anthropic SKILL.md frontmatter schema.
 *
 * Returns an error string if any field violates the spec, null otherwise.
 * Called from parseFsSkill so malformed skills are rejected at admission
 * (and end up quarantined with a descriptive reason instead of being
 * silently accepted).
 *
 * Anthropic spec (https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills/skill-design):
 *   - name:                       required, 1–64 chars, lowercase/dashes/underscores
 *   - description:                required, ≤ 1024 chars
 *   - allowed_tools:              optional, array of tool name strings
 *   - user_invocable:             optional, boolean (default true)
 *   - disable_model_invocation:   optional, boolean (default false)
 */
export function validateAnthropicFrontmatter(
  fm: AnthropicSkillFrontmatter,
  rawFm?: Record<string, unknown>,
): string | null {
  // name
  if (!fm.name || typeof fm.name !== "string") return "frontmatter.name must be a non-empty string";
  if (fm.name.length > 64) return `frontmatter.name too long (${fm.name.length} chars; max 64)`;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(fm.name)) {
    return `frontmatter.name must be lowercase alphanumeric with - and _ only (got: ${fm.name})`;
  }
  // description
  if (!fm.description || typeof fm.description !== "string") {
    return "frontmatter.description must be a non-empty string";
  }
  if (fm.description.length > 1024) {
    return `frontmatter.description too long (${fm.description.length} chars; max 1024 per Anthropic spec)`;
  }
  // For Step-5 optional fields, prefer the raw parsed dict so we see the ORIGINAL
  // value (e.g. "yes" or "1") rather than the narrowed `undefined`. This is what
  // catches type mismatches that the typing layer would silently swallow.
  const src = (rawFm ?? fm) as Record<string, unknown>;

  // allowed_tools — must be array of strings if present
  if (src.allowed_tools !== undefined) {
    if (!Array.isArray(src.allowed_tools)) {
      return `frontmatter.allowed_tools must be an array of strings (got: ${typeof src.allowed_tools})`;
    }
    for (const t of src.allowed_tools as unknown[]) {
      if (typeof t !== "string" || !t.trim()) return `frontmatter.allowed_tools entries must be non-empty strings (got: ${JSON.stringify(t)})`;
    }
  }
  // user_invocable — must be boolean if present
  if (src.user_invocable !== undefined && typeof src.user_invocable !== "boolean") {
    return `frontmatter.user_invocable must be a boolean (true|false); got ${typeof src.user_invocable}: ${JSON.stringify(src.user_invocable)}`;
  }
  // disable_model_invocation — must be boolean if present
  if (src.disable_model_invocation !== undefined && typeof src.disable_model_invocation !== "boolean") {
    return `frontmatter.disable_model_invocation must be a boolean (true|false); got ${typeof src.disable_model_invocation}: ${JSON.stringify(src.disable_model_invocation)}`;
  }
  return null;
}

/**
 * Parse one filesystem skill directory.
 * Returns ParsedFsSkill with parse_error set if anything failed.
 */
export async function parseFsSkill(skillDir: string): Promise<ParsedFsSkill> {
  const result: ParsedFsSkill = {
    skill_dir: skillDir,
    name: "",
    skill_md: join(skillDir, "SKILL.md"),
    fm: { name: "", description: "" },
    body: "",
    script_hmacs: {},
    parse_error: null,
  };

  if (!existsSync(result.skill_md)) {
    result.parse_error = "SKILL.md missing";
    return result;
  }

  let raw: string;
  try { raw = readFileSync(result.skill_md, "utf8"); }
  catch (e) { result.parse_error = `read SKILL.md failed: ${(e as Error).message}`; return result; }

  const { fm, body, error, rawFm } = parseFrontmatter(raw);
  if (error) { result.parse_error = error; return result; }
  // v0.26.0 Step 5 — Strict frontmatter validation per Anthropic spec.
  // Pass rawFm so the validator sees the ORIGINAL parsed value (catches
  // type mismatches the narrowing layer would otherwise drop to undefined).
  const validationError = validateAnthropicFrontmatter(fm, rawFm);
  if (validationError) { result.parse_error = validationError; return result; }

  result.fm = fm;
  result.body = body;
  result.name = fm.name;

  // Hash all bundled files (scripts/, references/, etc. — any non-SKILL.md file)
  const allFiles = listFilesRecursive(skillDir).filter((p) => p !== "SKILL.md");
  for (const relPath of allFiles) {
    try {
      const abs = join(skillDir, relPath);
      result.script_hmacs[relPath] = await hmacFile(abs);
    } catch (e) {
      // Single file hash failure shouldn't kill the whole skill —
      // mark with sentinel so caller can audit
      result.script_hmacs[relPath] = `ERROR:${(e as Error).message}`;
    }
  }

  return result;
}

/**
 * Walk all filesystem skill roots, parse each skill directory, mirror to
 * skills_pg. Idempotent: skills with matching body_hmac + script_hmacs are
 * left alone.
 */
export interface FsImportSummary {
  scanned:     number;
  inserted:    number;
  updated:     number;
  skipped_same: number;
  errors:      number;
  details:     Array<{ skill_dir: string; result: string; reason?: string }>;
}

export async function importFilesystemSkills(opts: {
  globalRoot?: string;
  projectPaths?: string[];
} = {}): Promise<FsImportSummary> {
  const summary: FsImportSummary = {
    scanned: 0, inserted: 0, updated: 0, skipped_same: 0, errors: 0, details: [],
  };

  const roots = [
    opts.globalRoot ?? join(homedir(), ".claude", "skills"),
    ...(opts.projectPaths ?? []).map((p) => join(p, ".claude", "skills")),
  ].filter((r) => existsSync(r));

  if (roots.length === 0) {
    logger.info("skills", "fs_import_no_roots", {});
    return summary;
  }

  // Lazy-load loader to compute body_hmac via the existing machine_secret primitive
  const { computeSkillBodyHmac, buildSkill } = await import("./loader.js");
  const { upsertSkill } = await import("./storage_dual.js");
  const { DatabaseSync } = await import("node:sqlite");

  for (const root of roots) {
    // Each subdirectory is a candidate skill
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const skillDir = join(root, name);
      let st;
      try { st = statSync(skillDir); } catch { continue; }
      if (!st.isDirectory()) continue;
      summary.scanned++;

      const parsed = await parseFsSkill(skillDir);
      if (parsed.parse_error) {
        // v0.26.0 Step 5 — quarantine on parse/validation failure so Claude Code's
        // native loader can't see the malformed skill either. Same atomic-move
        // mechanism as Step 3's script-scan quarantine, but tagged with the
        // schema reason.
        const quarantined = quarantineSkillDir(skillDir, `frontmatter validation: ${parsed.parse_error}`);
        if (quarantined.ok) {
          // Best-effort PG mirror so the dashboard can show the quarantined row.
          // Use a synthetic ID so we don't collide with a name-less skill.
          await recordQuarantineForParseError(skillDir, quarantined.newPath, parsed.parse_error);
          // v0.26.0 Step 6 — anchor in the chained admission log
          await recordAdmissionEvent({
            event: "quarantined_frontmatter",
            skill_name: basename(skillDir),
            skill_version: null,
            skill_scope: null,
            skill_dir: quarantined.newPath,
            body_hmac: null,
            script_count: 0,
            quarantined: true,
            reason: parsed.parse_error,
          });
          summary.errors++;
          summary.details.push({ skill_dir: skillDir, result: "quarantined_parse_error", reason: parsed.parse_error });
          logger.warn("skills", "fs_skill_quarantined_parse_error", {
            skill_dir: skillDir, moved_to: quarantined.newPath, reason: parsed.parse_error,
          });
        } else {
          summary.errors++;
          summary.details.push({ skill_dir: skillDir, result: "parse_error_quarantine_failed", reason: `${parsed.parse_error}; quarantine: ${quarantined.error}` });
          logger.error("skills", "fs_skill_parse_error_quarantine_failed", {
            skill_dir: skillDir, parse_error: parsed.parse_error, quarantine_error: quarantined.error,
          });
        }
        continue;
      }

      // v0.26.0 Step 3 — scan every bundled script. If any script fails the
      // AST-based admission scan, quarantine the whole skill (atomic mv to
      // ~/.claude/skills.quarantine/) and mirror to PG with quarantined=TRUE.
      // This blocks malicious scripts BEFORE Claude Code's native loader
      // sees the skill directory.
      const scriptPaths = Object.keys(parsed.script_hmacs)
        .filter((p) => p.startsWith("scripts/"))
        .map((relPath) => join(skillDir, relPath));
      let scriptScanResults: ScriptScanResult[] = scriptPaths.map((p) => scanScriptFile(p));
      // v0.27.0 — if SKILL.md frontmatter declares shell_exec_ok: true (operator
      // pre-approved subprocess shell=True / os.system use), downgrade those
      // specific block findings to warn so they don't trigger quarantine.
      // Other block findings (eval, pickle, dynamic_import) stay block-severity.
      if (parsed.fm.shell_exec_ok === true) {
        const SHELL_EXEC_PATTERNS = new Set(["subprocess_shell_true", "os_shell_exec", "shell_exec"]);
        scriptScanResults = scriptScanResults.map((r) => ({
          ...r,
          violations: r.violations.map((v) => SHELL_EXEC_PATTERNS.has(v.pattern) && v.severity === "block"
            ? { ...v, severity: "warn" as const }
            : v),
          passed: r.violations.filter((v) =>
            v.severity === "block" && !SHELL_EXEC_PATTERNS.has(v.pattern)
          ).length === 0,
        }));
      }
      // v0.27.0 — if SKILL.md declares unsupported_scripts_ok: true (operator
      // pre-approved bundled scripts in unscanned languages, e.g. .sh in
      // anthropic-web-artifacts-builder), downgrade `unsupported_language`
      // findings to warn. Other findings still apply.
      if (parsed.fm.unsupported_scripts_ok === true) {
        scriptScanResults = scriptScanResults.map((r) => ({
          ...r,
          violations: r.violations.map((v) => v.pattern === "unsupported_language" && v.severity === "block"
            ? { ...v, severity: "warn" as const }
            : v),
          passed: r.violations.filter((v) =>
            v.severity === "block" && v.pattern !== "unsupported_language"
          ).length === 0,
        }));
      }
      const failedScans = scriptScanResults.filter((r) => !r.passed);
      if (failedScans.length > 0) {
        const reason = failedScans.map((r) => {
          const blocks = r.violations.filter((v) => v.severity === "block");
          return `${basename(r.scriptPath)}: ${blocks.map((b) => `${b.pattern}@L${b.line}`).join(", ")}`;
        }).join("; ");
        const quarantined = quarantineSkillDir(skillDir, reason);
        if (quarantined.ok) {
          // Mirror to PG with quarantined=TRUE so dashboard can surface it
          await recordQuarantine(parsed, quarantined.newPath, reason);
          // v0.26.0 Step 6 — anchor in the chained admission log
          await recordAdmissionEvent({
            event: "quarantined_scan",
            skill_name: parsed.fm.name,
            skill_version: parsed.fm.version ?? "1.0.0",
            skill_scope: parsed.fm.scope ?? "global",
            skill_dir: quarantined.newPath,
            body_hmac: null,
            script_count: Object.keys(parsed.script_hmacs).length,
            quarantined: true,
            reason,
          });
          summary.errors++;
          summary.details.push({
            skill_dir: skillDir, result: "quarantined", reason: `script scan failed: ${reason}`,
          });
          logger.warn("skills", "fs_skill_quarantined", {
            skill_dir: skillDir, moved_to: quarantined.newPath, reason,
          });
          continue;
        } else {
          summary.errors++;
          summary.details.push({
            skill_dir: skillDir, result: "quarantine_failed",
            reason: `script scan failed (${reason}), AND quarantine move failed: ${quarantined.error}`,
          });
          logger.error("skills", "fs_skill_quarantine_move_failed", {
            skill_dir: skillDir, reason: quarantined.error,
          });
          continue;
        }
      }

      const version = parsed.fm.version ?? "1.0.0";
      const scope = parsed.fm.scope ?? "global";
      const skillId = `${parsed.fm.name}@${version}@${scope}`;

      // Check existing row
      const existing = await withClient(async (c) => {
        const r = await c.query<{ body_hmac: string; script_hmacs: unknown; skill_dir: string | null }>(
          `SELECT body_hmac, script_hmacs, skill_dir FROM skills_pg WHERE skill_id=$1`,
          [skillId],
        );
        return r.rows[0] ?? null;
      });

      const bodyHmac = await computeSkillBodyHmac(parsed.body);
      const scriptHmacsJson = JSON.stringify(parsed.script_hmacs);
      // v0.27.0 — compare script_hmacs key-by-key, not as raw JSON strings.
      // JSON.stringify of the PG-returned JSONB and JSON.stringify of our
      // freshly-built JS object don't necessarily have identical key order,
      // so a naive ===  fires false-positive "updated" on every boot. Compare
      // as canonical maps: same set of keys + same value for each.
      const existingScripts = (existing?.script_hmacs && typeof existing.script_hmacs === "object")
        ? existing.script_hmacs as Record<string, string>
        : null;
      const scriptsAreSame = existingScripts !== null && (() => {
        const a = existingScripts;
        const b = parsed.script_hmacs;
        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        if (aKeys.length !== bKeys.length) return false;
        for (const k of aKeys) {
          if (a[k] !== b[k]) return false;
        }
        return true;
      })();

      // Idempotent skip: same body_hmac AND same script_hmacs (key-by-key) AND same dir
      if (existing
          && existing.body_hmac === bodyHmac
          && scriptsAreSame
          && existing.skill_dir === skillDir) {
        // v0.26.0 Step 6 — do NOT log "skipped_idempotent" on every restart,
        // it would dominate the chain noise. Skip the audit log for idempotent
        // no-ops. (Real admit/update/quarantine events are still logged.)
        summary.skipped_same++;
        summary.details.push({ skill_dir: skillDir, result: "skipped_same" });
        continue;
      }

      // Build proper Skill object + upsert via gate-enabled path
      const skill = await buildSkill(
        {
          ...parsed.fm,
          name: parsed.fm.name,
          version,
          scope: scope as "global",
        },
        parsed.body,
        { source_path: parsed.skill_md },
      );

      const memDb = new DatabaseSync(":memory:");
      try {
        await upsertSkill(memDb, skill, "filesystem");
        // After upsertSkill writes the row, patch in skill_dir + script_hmacs
        // (these are Step-2-specific columns not handled by upsertSkill yet)
        await withClient(async (c) => {
          // Passing the scan IS the re-admission: clear any stale quarantine
          // flag, or a skill restored from quarantine stays blocked by the
          // HMAC verify hook forever even though this import just admitted it.
          await c.query(
            `UPDATE skills_pg
                SET skill_dir = $1,
                    script_hmacs = $2::jsonb,
                    quarantined = FALSE,
                    quarantine_reason = NULL
              WHERE skill_id = $3`,
            [skillDir, scriptHmacsJson, skillId],
          );
        });
        // v0.26.0 Step 6 — anchor in the chained admission log
        await recordAdmissionEvent({
          event: existing ? "updated" : "admitted",
          skill_name: parsed.fm.name,
          skill_version: version,
          skill_scope: scope,
          skill_dir: skillDir,
          body_hmac: bodyHmac,
          script_count: Object.keys(parsed.script_hmacs).length,
          quarantined: false,
          reason: null,
        });
        if (existing) {
          summary.updated++;
          summary.details.push({ skill_dir: skillDir, result: "updated" });
        } else {
          summary.inserted++;
          summary.details.push({ skill_dir: skillDir, result: "inserted" });
        }
      } catch (e) {
        summary.errors++;
        summary.details.push({ skill_dir: skillDir, result: "upsert_error", reason: (e as Error).message });
        logger.error("skills", "fs_skill_upsert_failure", {
          skill_dir: skillDir, error: (e as Error).message,
        });
      } finally {
        memDb.close();
      }
    }
  }

  logger.info("skills", "fs_import_complete", {
    scanned: summary.scanned, inserted: summary.inserted, updated: summary.updated,
    skipped_same: summary.skipped_same, errors: summary.errors,
    roots,
  });
  return summary;
}
