/**
 * Skill body + frontmatter linter (v0.23.0 Phase 1 #4)
 * =====================================================
 *
 * Catches structural issues in skill bodies BEFORE they land in skills_pg.
 * Three categories:
 *
 *   ERRORS  — must-fix; the skill is rejected at load/promotion time
 *   WARNINGS — should-fix; logged but skill still loads/promotes
 *   INFO    — informational; surfaced in operator dashboard only
 *
 * Wired into:
 *   - loader.ts:loadSkill          — runs lint after HMAC verify; errors throw
 *   - storage_dual.ts:upsertSkill  — runs lint before insert; errors reject
 *   - scripts/lint-skills.mjs      — CI/operator script: `npm run lint:skills`
 *   - dashboard panel              — surfaces warnings to the operator
 *
 * The marketplace pull (Phase 2) ALSO runs every external skill through this
 * gate before it touches skills_pg, ensuring no upstream skill bypasses the
 * quality bar by virtue of coming from a "trusted" source.
 *
 * Design: rules are pure regex / structural checks, no LLM. Fast (<5ms per
 * skill body), deterministic, runs on every skill load. The skill-polisher
 * (Phase 1 #2) is the LLM-driven counterpart that REWRITES descriptions to
 * pass these rules — so a polish + lint cycle yields a high-quality skill
 * that's safe to promote.
 */

import type { SkillFrontmatter } from "./types.js";

export interface LintResult {
  /** True iff there are no errors. Warnings don't break this. */
  ok: boolean;
  /** Each warning is a short human-readable string for the operator. */
  warnings: string[];
  /** Errors block the skill from loading or promoting. */
  errors: string[];
}

/**
 * Run all lint rules against a skill's frontmatter + body.
 *
 * Conventions:
 *   - Single trip, ordered: cheapest checks first (length, regex), then
 *     parsing-aware ones.
 *   - Each rule is independent — a body that fails N rules surfaces all N.
 *   - No I/O, no async — safe to call inside synchronous indexContent paths.
 */
export function lintSkillBody(
  body: string,
  frontmatter: SkillFrontmatter,
): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Rule 1: description must be non-empty + ≥ 30 chars ────────────────────
  // Why: skill matching at agent spawn time uses the description as the
  // primary signal. Below 30 chars is too short to disambiguate from a
  // similarly-named skill ("Read file" vs "Read file safely with size cap").
  if (!frontmatter.description || frontmatter.description.length < 30) {
    errors.push(
      `frontmatter.description too short (${frontmatter.description?.length ?? 0} chars; minimum 30) — agents match skills by description so this needs to be discriminating`,
    );
  }

  // ── Rule 2: description should not be all-caps (low-quality signal) ───────
  if (frontmatter.description && /^[A-Z\s\d.,;:!?-]{30,}$/.test(frontmatter.description)) {
    warnings.push("frontmatter.description is all-caps; agents have an easier time with normal sentence case");
  }

  // ── Rule 3: name must be lowercase-with-hyphens (agentskills.io spec) ─────
  if (frontmatter.name && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(frontmatter.name)) {
    errors.push(
      `frontmatter.name "${frontmatter.name}" violates agentskills.io spec (lowercase letters, digits, hyphens; no leading/trailing hyphen)`,
    );
  }

  // ── Rule 4: body should have ## Examples section (recommended structure) ──
  if (!/^##\s+Examples?\b/m.test(body)) {
    warnings.push("body missing `## Examples` section — examples teach by demonstration; helps agents pattern-match the right skill to a task");
  }

  // ── Rule 5: body should have ## Guidelines OR ## Constraints section ──────
  if (!/^##\s+(Guidelines|Constraints|Rules)\b/m.test(body)) {
    warnings.push("body missing `## Guidelines` (or `## Constraints` / `## Rules`) section — constraints help the agent know what NOT to do");
  }

  // ── Rule 6: body length sanity (too short = uninformative; too long = bloat)
  const bodyLen = body.trim().length;
  if (bodyLen < 100) {
    errors.push(`body too short (${bodyLen} chars; minimum 100) — a skill body that thin can't encode a useful procedure`);
  } else if (bodyLen > 16000) {
    errors.push(`body too long (${bodyLen} chars; maximum 16000) — beyond this the skill is hard for the operator to review and the LLM hard to follow`);
  } else if (bodyLen > 8000) {
    warnings.push(`body is long (${bodyLen} chars) — consider extracting sub-skills or moving examples to fixtures`);
  }

  // ── Rule 7: body should not contain raw secrets (defensive — full scan in #1) ──
  // This is just a fast keyword check; the full security scan (Phase 1 #1)
  // is the comprehensive scan. Catching obvious leaks here saves operator time.
  const secretMarkers = [
    /sk-(live|test|proj)-[a-zA-Z0-9]{20,}/,        // OpenAI-style API key
    /sk-ant-[a-zA-Z0-9-]{40,}/,                     // Anthropic API key
    /AKIA[A-Z0-9]{16}/,                              // AWS Access Key ID
    /ghp_[a-zA-Z0-9]{36}/,                           // GitHub PAT (classic)
    /github_pat_[a-zA-Z0-9_]{80,}/,                  // GitHub PAT (fine-grained)
    /xoxb-\d+-\d+-[a-zA-Z0-9]+/,                     // Slack bot token
  ];
  for (const re of secretMarkers) {
    const m = body.match(re);
    if (m) {
      errors.push(`body contains what looks like a credential (matched ${re.source.slice(0, 30)}...); skill bodies must not contain real secrets`);
      break;
    }
  }

  // ── Rule 8: intended_roles is non-empty if specified ──────────────────────
  // Why: intended_roles drives mutator-pool routing. An empty array breaks
  // routing without any error, leaving failures in mutator-general queue.
  if (frontmatter.intended_roles !== undefined && frontmatter.intended_roles.length === 0) {
    warnings.push("frontmatter.intended_roles is an empty array — either remove the field or list at least one role; otherwise mutator routing falls back to mutator-general");
  }

  // ── Rule 9: requires_network=true must have an allowlist ──────────────────
  if (frontmatter.requires_network === true) {
    if (!frontmatter.network_allowlist || frontmatter.network_allowlist.length === 0) {
      errors.push("requires_network=true but network_allowlist is empty — skills with network access MUST declare which URLs they may fetch (security gate)");
    }
  }

  return {
    ok: errors.length === 0,
    warnings,
    errors,
  };
}

/**
 * Format a LintResult for human display (operator log + dashboard).
 * Returns a markdown-flavored string. Empty string if no warnings/errors.
 */
export function formatLintResult(result: LintResult, skillId: string): string {
  if (result.errors.length === 0 && result.warnings.length === 0) return "";
  const lines: string[] = [`Lint report for ${skillId}:`];
  if (result.errors.length > 0) {
    lines.push("");
    lines.push("ERRORS (block load/promotion):");
    for (const e of result.errors) lines.push(`  - ${e}`);
  }
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("WARNINGS (should fix):");
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}
