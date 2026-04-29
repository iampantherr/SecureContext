/**
 * Skill loader — parses markdown skill files and verifies HMAC.
 *
 * Format (skill .md file):
 *   ---
 *   name: audit_file
 *   version: 0.1.0
 *   scope: global
 *   description: Audit a source file for security issues
 *   requires_network: false
 *   acceptance_criteria:
 *     min_outcome_score: 0.7
 *     min_pass_rate: 0.8
 *   fixtures:
 *     - fixture_id: happy-1
 *       description: standard JS file
 *       input: { file_path: "test.js" }
 *       expected: { issue_count: { ">=": 0 } }
 *   ---
 *   # Skill body — free-form markdown
 *
 *   When invoked with `file_path`, the agent should:
 *   1. Read the file via zc_file_summary first
 *   2. ...
 *
 * Frontmatter parsing uses a small bespoke YAML-subset parser (we want zero
 * new dependencies and we control the file format). For richer YAML we'd
 * pull `js-yaml` but the current schema is flat enough to skip it.
 *
 * SECURITY:
 *   - The body's HMAC is computed against the machine_secret-derived subkey
 *     for "skills". A skill that was modified outside our pipeline (or
 *     across machine secrets) WILL fail HMAC verification at load time.
 *   - Frontmatter is NOT scanned for prompt injection here — that's a
 *     load-time gate (RT-S2-01) handled by the caller before exposing to
 *     an agent.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { resolve, basename } from "node:path";
import type { Skill, SkillFrontmatter, SkillScope, SkillFixture, AcceptanceCriteria } from "./types.js";

const HMAC_SUBKEY_LABEL = "skill-body-v1";

/**
 * Compute the machine-secret-derived subkey used to HMAC skill bodies.
 * Uses HKDF-SHA256 derivation matching the per-agent chain pattern.
 */
async function getSkillBodySubkey(): Promise<Buffer> {
  // Lazy-import to avoid forcing the machine_secret bootstrap on test paths
  // that don't need it.
  const { getMachineSecret } = await import("../security/machine_secret.js");
  const machineSecret = getMachineSecret();
  // HKDF-Extract step (simple sha256 HMAC of the secret with a context label)
  return createHmac("sha256", machineSecret).update(HMAC_SUBKEY_LABEL).digest();
}

/** Compute HMAC-SHA256(skill body, derived subkey). */
export async function computeSkillBodyHmac(body: string): Promise<string> {
  const key = await getSkillBodySubkey();
  return createHmac("sha256", key).update(body, "utf8").digest("hex");
}

/**
 * Parse the frontmatter block (between leading `---` markers) + body of a
 * skill .md file. Returns null if the file doesn't look like a skill
 * (missing frontmatter delimiters).
 */
function splitFrontmatterAndBody(text: string): { frontmatterText: string; body: string } | null {
  // Strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== "---") return null;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { endIdx = i; break; }
  }
  if (endIdx < 0) return null;
  const frontmatterText = lines.slice(1, endIdx).join("\n");
  const body = lines.slice(endIdx + 1).join("\n").replace(/^\s+/, "");
  return { frontmatterText, body };
}

/**
 * Tiny YAML-subset parser — handles the shapes we use: flat scalars,
 * nested objects (one level), lists of scalars, lists of objects.
 *
 * Why a custom parser: avoids adding js-yaml as a dependency. The skill
 * frontmatter spec is constrained on purpose; if it grows, swap this for
 * js-yaml in one place.
 *
 * Returns the parsed object. Throws on malformed input — callers should
 * surface as a load error.
 */
function parseFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n").filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));

  // Stack convention: `indent` is the indent level of the CURRENT container
  // (the line that opened it, e.g. `parent:` at indent 0 → entry indent=0).
  // A new line at indent C pops anything with stack-indent >= C, leaving
  // the container that owns it at the top.
  type Frame = { indent: number; obj: Record<string, unknown> | unknown[] };
  const stack: Frame[] = [{ indent: -1, obj: result }];

  function lookaheadHasChildrenIndentGreaterThan(idx: number, indent: number): { isList: boolean; hasChildren: boolean } {
    const next = lines[idx + 1];
    if (!next) return { isList: false, hasChildren: false };
    const nextIndent = next.search(/\S/);
    if (nextIndent <= indent) return { isList: false, hasChildren: false };
    return { isList: next.trim().startsWith("- "), hasChildren: true };
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const indent = raw.search(/\S/);
    const trimmed = raw.trim();

    // Pop while top.indent >= current — exposes the right parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;

    // List item: `- ...`
    if (trimmed.startsWith("- ") || trimmed === "-") {
      if (!Array.isArray(parent)) {
        throw new Error(`YAML parse error: list item under non-list at line ${i + 1}`);
      }
      const valuePart = trimmed.replace(/^-\s*/, "").trim();
      const m = valuePart.match(/^([A-Za-z_][\w_-]*)\s*:\s*(.*)$/);
      if (m) {
        // List-of-objects: `- key: value` (value optional)
        const obj: Record<string, unknown> = {};
        const k = m[1];
        const v = m[2];
        if (v.length > 0) {
          obj[k] = parseScalar(v);
        } else {
          // Look ahead for nested children inside this object
          const la = lookaheadHasChildrenIndentGreaterThan(i, indent);
          if (la.hasChildren) {
            obj[k] = la.isList ? [] : {};
            // Two-level push: outer object at THIS list-item's indent so siblings
            // at the same indent push it off; inner container at one level deeper
            // so its own children resolve correctly.
            parent.push(obj);
            stack.push({ indent, obj });
            stack.push({ indent: indent + 2, obj: obj[k] as Record<string, unknown> | unknown[] });
            continue;
          }
          obj[k] = null;
        }
        parent.push(obj);
        stack.push({ indent, obj });
        continue;
      }
      // List-of-scalars
      parent.push(parseScalar(valuePart));
      continue;
    }

    // key: value
    const m = trimmed.match(/^([A-Za-z_][\w_-]*)\s*:\s*(.*)$/);
    if (!m) throw new Error(`YAML parse error at line ${i + 1}: ${raw}`);
    const key = m[1];
    const value = m[2];

    if (Array.isArray(parent)) {
      throw new Error(`YAML parse error: key:value under list at line ${i + 1}`);
    }
    if (value.length === 0) {
      // Look ahead at next-line indent to decide list vs object child
      const la = lookaheadHasChildrenIndentGreaterThan(i, indent);
      if (la.hasChildren) {
        const child: Record<string, unknown> | unknown[] = la.isList ? [] : {};
        parent[key] = child;
        stack.push({ indent, obj: child });
      } else {
        parent[key] = null;
      }
    } else {
      parent[key] = parseScalar(value);
    }
  }

  return result;
}

function parseScalar(s: string): unknown {
  s = s.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  // Quoted strings
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // Inline JSON object/array (e.g. `input: { foo: "bar" }`) — best-effort
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try { return JSON.parse(s); } catch { /* fall through */ }
  }
  return s;
}

/** Coerce a parsed-YAML value into our SkillFrontmatter shape. Validates required fields. */
function coerceFrontmatter(parsed: Record<string, unknown>): SkillFrontmatter {
  if (typeof parsed.name !== "string")        throw new Error("frontmatter: 'name' (string) required");
  if (typeof parsed.version !== "string")     throw new Error("frontmatter: 'version' (string) required");
  if (typeof parsed.scope !== "string")       throw new Error("frontmatter: 'scope' (string) required");
  if (typeof parsed.description !== "string") throw new Error("frontmatter: 'description' (string) required");
  // scope must be 'global' or 'project:<hash>'
  if (parsed.scope !== "global" && !/^project:[a-f0-9]{8,}$/.test(parsed.scope)) {
    throw new Error(`frontmatter: invalid scope '${parsed.scope}' (must be 'global' or 'project:<hex>')`);
  }
  const fm: SkillFrontmatter = {
    name:        parsed.name,
    version:     parsed.version,
    scope:       parsed.scope as SkillScope,
    description: parsed.description,
  };
  if (parsed.requires_network !== undefined) fm.requires_network = !!parsed.requires_network;
  if (Array.isArray(parsed.network_allowlist)) fm.network_allowlist = parsed.network_allowlist as string[];
  if (parsed.acceptance_criteria && typeof parsed.acceptance_criteria === "object") {
    fm.acceptance_criteria = parsed.acceptance_criteria as AcceptanceCriteria;
  }
  if (Array.isArray(parsed.fixtures)) {
    fm.fixtures = parsed.fixtures.map((f, i) => {
      const o = f as Record<string, unknown>;
      if (typeof o.fixture_id !== "string") throw new Error(`fixture[${i}]: fixture_id required`);
      return {
        fixture_id:  o.fixture_id,
        description: typeof o.description === "string" ? o.description : "",
        input:       (o.input as Record<string, unknown>) ?? {},
        expected:    (o.expected as Record<string, unknown>) ?? {},
        weight:      typeof o.weight === "number" ? o.weight : undefined,
      } as SkillFixture;
    });
  }
  if (typeof parsed.fixtures_dir === "string") fm.fixtures_dir = parsed.fixtures_dir;
  if (parsed.inputs_schema && typeof parsed.inputs_schema === "object") {
    fm.inputs_schema = parsed.inputs_schema as Record<string, unknown>;
  }
  if (Array.isArray(parsed.tags)) fm.tags = parsed.tags as string[];
  return fm;
}

/**
 * Load a skill from disk path. Computes HMAC over the body. Does NOT verify
 * against a stored HMAC — that's a separate `verifySkillHmac()` step that
 * the storage layer performs when re-loading from DB.
 *
 * Returns null if the file is not a valid skill (missing frontmatter).
 * Throws on parse errors so callers can surface them to operators.
 */
export async function loadSkillFromPath(path: string): Promise<Skill | null> {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const split = splitFrontmatterAndBody(text);
  if (!split) return null;

  const parsed = parseFrontmatter(split.frontmatterText);
  const frontmatter = coerceFrontmatter(parsed);

  // Default scope: if file lives under <project>/.claude/skills/ and frontmatter says 'global',
  // we don't auto-rewrite — operator's choice. The scope is whatever frontmatter says.
  const body = split.body;
  const body_hmac = await computeSkillBodyHmac(body);
  const skill_id = `${frontmatter.name}@${frontmatter.version}@${frontmatter.scope}`;

  return {
    skill_id,
    frontmatter,
    body,
    body_hmac,
    source_path: resolve(path),
    promoted_from: null,
    created_at: new Date().toISOString(),
    archived_at: null,
    archive_reason: null,
  };
}

/**
 * Verify a skill's body matches a stored HMAC. Returns true if they match.
 * Used by the storage layer when reloading from DB to detect tampering.
 */
export async function verifySkillHmac(body: string, expected_hmac: string): Promise<boolean> {
  const actual = await computeSkillBodyHmac(body);
  // Constant-time compare to defeat timing attacks
  if (actual.length !== expected_hmac.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected_hmac.charCodeAt(i);
  return diff === 0;
}

/**
 * Build a new skill from raw frontmatter + body (for in-memory construction
 * or candidate generation in the mutation pipeline).
 */
export async function buildSkill(
  frontmatter: SkillFrontmatter,
  body: string,
  opts: { promoted_from?: string; source_path?: string } = {},
): Promise<Skill> {
  const body_hmac = await computeSkillBodyHmac(body);
  return {
    skill_id: `${frontmatter.name}@${frontmatter.version}@${frontmatter.scope}`,
    frontmatter,
    body,
    body_hmac,
    source_path: opts.source_path ?? null,
    promoted_from: opts.promoted_from ?? null,
    created_at: new Date().toISOString(),
    archived_at: null,
    archive_reason: null,
  };
}

/** Produce the full markdown text (frontmatter + body) for writing to disk. */
export function renderSkillMarkdown(skill: Skill): string {
  const fm = skill.frontmatter;
  const lines: string[] = ["---"];
  lines.push(`name: ${fm.name}`);
  lines.push(`version: ${fm.version}`);
  lines.push(`scope: ${fm.scope}`);
  lines.push(`description: ${fm.description}`);
  if (fm.requires_network !== undefined) lines.push(`requires_network: ${fm.requires_network}`);
  if (fm.network_allowlist?.length) {
    lines.push("network_allowlist:");
    for (const u of fm.network_allowlist) lines.push(`  - ${JSON.stringify(u)}`);
  }
  if (fm.tags?.length) {
    lines.push("tags:");
    for (const t of fm.tags) lines.push(`  - ${JSON.stringify(t)}`);
  }
  if (fm.acceptance_criteria) {
    lines.push("acceptance_criteria:");
    const ac = fm.acceptance_criteria;
    if (ac.min_outcome_score    !== undefined) lines.push(`  min_outcome_score: ${ac.min_outcome_score}`);
    if (ac.max_avg_cost_usd     !== undefined) lines.push(`  max_avg_cost_usd: ${ac.max_avg_cost_usd}`);
    if (ac.max_avg_duration_ms  !== undefined) lines.push(`  max_avg_duration_ms: ${ac.max_avg_duration_ms}`);
    if (ac.min_pass_rate        !== undefined) lines.push(`  min_pass_rate: ${ac.min_pass_rate}`);
  }
  if (fm.fixtures?.length) {
    lines.push("fixtures:");
    for (const f of fm.fixtures) {
      lines.push(`  - fixture_id: ${JSON.stringify(f.fixture_id)}`);
      if (f.description) lines.push(`    description: ${JSON.stringify(f.description)}`);
      lines.push(`    input: ${JSON.stringify(f.input)}`);
      lines.push(`    expected: ${JSON.stringify(f.expected)}`);
      if (f.weight !== undefined) lines.push(`    weight: ${f.weight}`);
    }
  }
  if (fm.fixtures_dir) lines.push(`fixtures_dir: ${JSON.stringify(fm.fixtures_dir)}`);
  lines.push("---");
  lines.push("");
  lines.push(skill.body);
  return lines.join("\n");
}

/** Helper to extract the file basename (skill name + .md) from a Skill. */
export function skillFilename(skill: Skill): string {
  return `${skill.frontmatter.name}.md`;
}
void basename;
