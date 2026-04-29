/**
 * agentskills.io format adapter (v0.18.0)
 * ========================================
 *
 * Import/export to the open agentskills.io schema so SC skills can be
 * shared with the broader ecosystem and vice-versa. The "agentskills.io"
 * schema is a minimal markdown + frontmatter convention that's becoming
 * a de-facto interop standard for skill libraries.
 *
 * agentskills.io fields we map:
 *   name             ← name
 *   description      ← description
 *   version          ← version
 *   tags             ← tags
 *   model            (informational only — we don't track per-skill models)
 *   metadata.x       (round-trip preservation in extensions block)
 *   body             ← body (verbatim markdown)
 *
 * SC fields they don't have:
 *   - acceptance_criteria  → preserve in metadata.zc_acceptance_criteria
 *   - fixtures             → preserve in metadata.zc_fixtures
 *   - body_hmac            → recomputed at import (not part of interop)
 *   - scope                → preserve in metadata.zc_scope (defaults to global)
 *
 * On EXPORT: emit canonical agentskills.io markdown.
 * On IMPORT: reconstruct a Skill, preserving SC-specific metadata so a
 * round-trip through agentskills.io is lossless.
 */

import type { Skill, SkillFrontmatter, AcceptanceCriteria, SkillFixture, SkillScope } from "../types.js";
import { buildSkill } from "../loader.js";

/** Shape of an agentskills.io frontmatter block (minimal). */
export interface AgentSkillsIoFrontmatter {
  name:        string;
  version:     string;
  description: string;
  tags?:       string[];
  model?:      string;
  metadata?:   Record<string, unknown>;
}

/** Render a Skill as agentskills.io-compatible markdown. */
export function exportToAgentSkillsIo(skill: Skill): string {
  const fm = skill.frontmatter;
  const metadata: Record<string, unknown> = {
    zc_scope: fm.scope,
    zc_acceptance_criteria: fm.acceptance_criteria ?? null,
    zc_fixtures:           fm.fixtures            ?? [],
    zc_requires_network:   fm.requires_network    ?? false,
    zc_network_allowlist:  fm.network_allowlist   ?? [],
  };

  // We emit a JSON-flat frontmatter (close to YAML for these scalar fields)
  const lines: string[] = ["---"];
  lines.push(`name: ${JSON.stringify(fm.name)}`);
  lines.push(`version: ${JSON.stringify(fm.version)}`);
  lines.push(`description: ${JSON.stringify(fm.description)}`);
  if (fm.tags?.length) {
    lines.push(`tags: ${JSON.stringify(fm.tags)}`);
  }
  // metadata as inline JSON object — many agentskills.io tools accept this
  lines.push(`metadata: ${JSON.stringify(metadata)}`);
  lines.push("---");
  lines.push("");
  lines.push(skill.body);
  return lines.join("\n");
}

/**
 * Parse an agentskills.io markdown file and reconstruct a Skill. Preserves
 * SC-specific metadata if present (round-trip from our own export).
 *
 * `defaultScope` is used when no `metadata.zc_scope` is present (e.g. a
 * skill imported from an external author).
 */
export async function importFromAgentSkillsIo(
  text: string,
  defaultScope: SkillScope = "global",
): Promise<Skill> {
  // Strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== "---") throw new Error("not agentskills.io: missing leading ---");
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { endIdx = i; break; }
  }
  if (endIdx < 0) throw new Error("not agentskills.io: missing closing ---");
  const fmText = lines.slice(1, endIdx).join("\n");
  const body = lines.slice(endIdx + 1).join("\n").replace(/^\n+/, "");

  // Parse simple JSON-style frontmatter we emit (key: value or key: jsonExpr)
  const fmObj = parseSimpleFrontmatter(fmText);

  if (typeof fmObj.name !== "string"        ) throw new Error("agentskills.io: 'name' required");
  if (typeof fmObj.version !== "string"     ) throw new Error("agentskills.io: 'version' required");
  if (typeof fmObj.description !== "string" ) throw new Error("agentskills.io: 'description' required");

  const metadata = (fmObj.metadata as Record<string, unknown>) ?? {};
  const scope: SkillScope =
    typeof metadata.zc_scope === "string" && /^(global|project:[a-f0-9]{8,})$/.test(metadata.zc_scope)
      ? (metadata.zc_scope as SkillScope)
      : defaultScope;

  const frontmatter: SkillFrontmatter = {
    name:        fmObj.name as string,
    version:     fmObj.version as string,
    scope,
    description: fmObj.description as string,
    tags:        Array.isArray(fmObj.tags) ? (fmObj.tags as string[]) : undefined,
    requires_network:   typeof metadata.zc_requires_network === "boolean" ? metadata.zc_requires_network : undefined,
    network_allowlist:  Array.isArray(metadata.zc_network_allowlist) ? (metadata.zc_network_allowlist as string[]) : undefined,
    acceptance_criteria: (metadata.zc_acceptance_criteria as AcceptanceCriteria) ?? undefined,
    fixtures:           Array.isArray(metadata.zc_fixtures) ? (metadata.zc_fixtures as SkillFixture[]) : undefined,
  };

  return buildSkill(frontmatter, body);
}

/**
 * Tiny dedicated frontmatter parser for the format we emit/expect:
 * each line is either `key: jsonValue` or `key: scalar`. Multi-line values
 * are not supported (our exporter never produces them).
 */
function parseSimpleFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][\w_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1];
    const v = m[2].trim();
    // Try JSON parse first (covers strings-with-quotes, arrays, objects)
    try { out[k] = JSON.parse(v); continue; } catch { /* fall through */ }
    // Plain scalar
    if (v === "true")  out[k] = true;
    else if (v === "false") out[k] = false;
    else if (/^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}
