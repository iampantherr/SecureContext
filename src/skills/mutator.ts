/**
 * Mutator abstraction (v0.18.0 Sprint 2 — D4)
 * ============================================
 *
 * Pluggable interface so the proposer model can be swapped via env var
 * (ZC_MUTATOR_MODEL) without touching the orchestrator. Three reference
 * implementations:
 *
 *   - RealtimeSonnetMutator  — Anthropic API direct (sync, costs $0.024/mut)
 *   - BatchSonnetMutator     — Anthropic Batch API (async, 50% discount,
 *                              24h SLA, ~$0.012/mut). Used for nightly
 *                              cron runs in production.
 *   - LocalMockMutator       — for tests. Generates deterministic candidates
 *                              from the parent body via simple text rules.
 *
 * SECURITY:
 *   - Allowlist enforced: ZC_MUTATOR_MODEL must be one of the recognized
 *     values; unknown → fall back to LocalMockMutator + AUDIT log
 *     (RT-S2-05).
 *   - Pre-submission scanner: every batch entry's input is run through
 *     secret_scanner before being sent to the API (RT-S2-07). Match → reject.
 *   - Candidate body output is HMAC'd at receive time so RT-S2-09 holds —
 *     a candidate that's modified between proposal and replay fails.
 *
 * Cost (per D4 spec):
 *   - Realtime Sonnet: ~3k input + ~1k output × Sonnet pricing = ~$0.024
 *   - Batch Sonnet: same tokens × 50% discount = ~$0.012
 *   - 5 candidates per call: bundled in single prompt → still ~$0.024 for
 *     all 5 not 5×.
 */

import type { MutationContext, MutationResult, MutationCandidate, Skill } from "./types.js";
import { computeSkillBodyHmac } from "./loader.js";
import { ANTHROPIC_SKILL_STANDARD } from "./anthropic_standard.js";

/** Pluggable mutator interface — every impl satisfies this. */
export interface Mutator {
  /** Identifier reported in skill_mutations.proposed_by. */
  readonly id: string;
  /** Generate N mutation candidates given a parent + recent failures. */
  mutate(ctx: MutationContext): Promise<MutationResult>;
}

/** Allowlist of known mutator ids — see RT-S2-05 for the security rationale. */
export const KNOWN_MUTATORS = new Set([
  "cli-headless",           // v0.60.0 — direct `claude -p` (subscription-billed, no agents/queue needed)
  "cli-claude",             // v0.18.1 — uses Pro-plan Claude CLI agent (no API key)
  "realtime-sonnet",
  "batch-sonnet",
  "local-mock",
  "realtime-opus",          // future
  "local-deepseek-r1:32b",  // future
  "local-qwen2.5-coder:32b",// future
]);

/** Resolve the operator's chosen mutator id. Falls back to local-mock on unknown. */
export function resolveMutatorId(envOverride?: string): string {
  const raw = (envOverride ?? process.env.ZC_MUTATOR_MODEL ?? "local-mock").trim();
  if (!KNOWN_MUTATORS.has(raw)) {
    // RT-S2-05: log + fall back rather than blindly accepting an arbitrary URL
    return "local-mock";
  }
  return raw;
}

/**
 * Factory — returns the mutator instance matching the env-resolved id.
 *
 * Some mutators (`cli-claude`) need extra context (the project path so they
 * know which broadcast channel to listen on). `factoryDeps` lets the caller
 * thread that context in. Plain mutators ignore it.
 */
export interface MutatorFactoryDeps {
  /** Required for cli-claude. */
  projectPath?: string;
  /** Override role used by cli-claude when enqueuing tasks. Default 'mutator'. */
  cliClaudeRole?: string;
}

export async function getMutator(envOverride?: string, deps: MutatorFactoryDeps = {}): Promise<Mutator> {
  const id = resolveMutatorId(envOverride);
  switch (id) {
    case "cli-headless": {
      const { CliHeadlessMutator } = await import("./mutators/cli_headless.js");
      return new CliHeadlessMutator();
    }
    case "cli-claude": {
      const { CliClaudeMutator } = await import("./mutators/cli_claude.js");
      if (!deps.projectPath) {
        throw new Error(
          "cli-claude mutator requires deps.projectPath — pass it via getMutator(envOverride, {projectPath}). " +
          "Falling back to local-mock if you don't have a project context."
        );
      }
      return new CliClaudeMutator({ project_path: deps.projectPath, role: deps.cliClaudeRole });
    }
    case "realtime-sonnet": {
      const { RealtimeSonnetMutator } = await import("./mutators/realtime_sonnet.js");
      return new RealtimeSonnetMutator();
    }
    case "batch-sonnet": {
      const { BatchSonnetMutator } = await import("./mutators/batch_sonnet.js");
      return new BatchSonnetMutator();
    }
    case "local-mock":
    default: {
      const { LocalMockMutator } = await import("./mutators/local_mock.js");
      return new LocalMockMutator();
    }
  }
}

/**
 * Build the proposer prompt. Used by every mutator that calls an LLM.
 * Kept here so the prompt schema is consistent regardless of model.
 *
 * Format:
 *   - Parent skill body (the current version)
 *   - Recent failure traces (most recent N)
 *   - Acceptance criteria (so the proposer knows the bar)
 *   - Instruction: produce 5 candidates, each with rationale
 *   - Output schema: JSON array of {candidate_body, rationale}
 */
export function buildProposerPrompt(ctx: MutationContext): string {
  const failures = ctx.failure_traces.slice(0, 10);  // cap to N most-recent
  const fxSnippet = ctx.fixtures.slice(0, 3).map((f, i) =>
    `  Fixture ${i + 1}: ${f.fixture_id} — input=${JSON.stringify(f.input)}, expected=${JSON.stringify(f.expected)}`
  ).join("\n");

  // v0.23.0 Phase 1 F — operator exemplars: positive training signal.
  // The MutationContext now carries an optional `exemplars` array — runs
  // the operator marked ⭐ via the dashboard. We include them in the
  // proposer prompt as "this is what good looks like" reference.
  const exemplars = ctx.exemplars ?? [];
  const exemplarSection = exemplars.length > 0
    ? [
        "",
        "## Operator-tagged exemplars (textbook examples of this skill in action):",
        ...exemplars.slice(0, 5).map((e, i) =>
          `${i + 1}. ${e.note ? `Note: ${e.note}\n   ` : ""}Inputs: ${JSON.stringify(e.inputs ?? {}).slice(0, 300)}\n   Evidence: ${JSON.stringify(e.evidence ?? {}).slice(0, 400)}`
        ),
        "",
        "Each candidate should preserve the patterns that made these exemplars work.",
      ].join("\n")
    : "";

  // v0.30.0 — Inject the Anthropic skill-design standard so candidates
  // respect the four invariants, the script-writing rules, the scope
  // matrix, and the small-composable-skills principle. Single source of
  // truth lives in anthropic_standard.ts — both the mutator and the
  // spotter β LLM filer pull from there.
  const standardSection = [
    "",
    "## MANDATORY: the Anthropic skill-design standard",
    "",
    ANTHROPIC_SKILL_STANDARD,
    "",
    "Apply this standard to every candidate you propose:",
    "- Each candidate must respect the four invariants",
    "- Each candidate's body must NOT introduce hardcoded project specifics",
    "  unless the parent skill is already project-scoped",
    "- If the failure traces point at a missing bundled-script, your candidate",
    "  should describe the script (you can't modify scripts in this proposal —",
    "  body only — but a candidate that says 'run scripts/foo.py for X' is",
    "  strictly better than one that inlines Python prose into the body)",
    "- If the procedure has sprawled past 7-8 steps, consider proposing a",
    "  DECOMPOSITION (one candidate may legitimately say 'this should be",
    "  split into N smaller skills'; explain which in the rationale)",
  ].join("\n");

  return [
    "You are improving a skill that has been showing recent failures.",
    "Propose 5 alternate skill bodies that would address the failure traces while still passing the fixtures.",
    "",
    "## Parent skill body (current version):",
    "```",
    ctx.parent.body,
    "```",
    "",
    "## Parent skill frontmatter (for context — DO NOT modify):",
    JSON.stringify({
      name:             ctx.parent.frontmatter.name,
      description:      ctx.parent.frontmatter.description,
      version:          ctx.parent.frontmatter.version,
      scope:            ctx.parent.frontmatter.scope,
      intended_roles:   ctx.parent.frontmatter.intended_roles,
      tags:             ctx.parent.frontmatter.tags,
    }, null, 2),
    "",
    "## Recent failure traces:",
    failures.length > 0 ? failures.map((f, i) => `${i + 1}. ${f}`).join("\n") : "(none)",
    "",
    "## Fixtures the candidate must continue to pass:",
    fxSnippet || "(none)",
    exemplarSection,
    standardSection,
    "",
    "## Acceptance criteria:",
    JSON.stringify(ctx.parent.frontmatter.acceptance_criteria ?? {}, null, 2),
    "",
    "## Output format (JSON only, no commentary):",
    `[
  {"candidate_body": "...the proposed new skill body...", "rationale": "why this is better"},
  ...
]`,
    "",
    "Constraints:",
    "- Each candidate_body is a full replacement for the parent body (markdown).",
    "- Rationales are 1-2 sentences explaining the specific improvement.",
    "- Do NOT include the frontmatter (--- ... ---) — only the body markdown.",
    "- Generate exactly 5 candidates.",
    "- Optimize for clarity, robustness against the failure-traces, and the acceptance criteria.",
    "- Respect the Anthropic skill-design standard above.",
    exemplars.length > 0 ? "- Where applicable, codify the patterns shown in the operator exemplars." : "",
  ].filter((s) => s !== "").join("\n");
}

/**
 * Validate the proposer's JSON output. Returns parsed candidates or throws.
 */
export function parseProposerResponse(raw: string): MutationCandidate[] {
  // Strip code-fence wrappers the model commonly adds
  let text = raw.trim();
  if (text.startsWith("```")) {
    const end = text.lastIndexOf("```");
    text = text.slice(text.indexOf("\n") + 1, end).trim();
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("proposer response is not an array");
  const out: MutationCandidate[] = [];
  for (const item of parsed) {
    if (typeof item?.candidate_body !== "string") continue;
    if (typeof item?.rationale      !== "string") continue;
    out.push({
      candidate_body:    item.candidate_body,
      rationale:         item.rationale,
      self_rated_score:  typeof item.self_rated_score === "number" ? item.self_rated_score : undefined,
    });
  }
  if (out.length === 0) throw new Error("no valid candidates in proposer response");
  return out;
}

/**
 * Tag every candidate with HMAC-of-body so RT-S2-09 (candidate modified
 * between proposal and replay) is detectable. Returns parallel array of HMACs.
 */
export async function hashCandidates(candidates: MutationCandidate[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of candidates) out.push(await computeSkillBodyHmac(c.candidate_body));
  return out;
}

/**
 * Apply the secret scanner to the proposer prompt before any external send.
 * RT-S2-07: ensure no API keys / secrets accidentally enter the request body.
 *
 * Returns null if scan passes; returns the matched pattern info on rejection.
 */
export async function preSubmissionSecretScan(prompt: string): Promise<{ matched: boolean; reason?: string }> {
  const { scanForSecrets } = await import("../security/secret_scanner.js");
  const result = scanForSecrets(prompt, { detectHighEntropy: false });
  if (result.hasSecret) {
    return { matched: true, reason: result.matches.map((m) => m.type).join(", ") };
  }
  return { matched: false };
}

/**
 * Helper: build a Skill object from a candidate body + parent's frontmatter,
 * bumping the version to the next patch level.
 */
export async function candidateToSkill(parent: Skill, candidate: MutationCandidate): Promise<Skill> {
  const newVersion = bumpPatch(parent.frontmatter.version);
  const newFm = { ...parent.frontmatter, version: newVersion };
  const { buildSkill } = await import("./loader.js");
  return buildSkill(newFm, candidate.candidate_body, { promoted_from: parent.skill_id });
}

// Single owner. Four copies existed and had QUIETLY DIVERGED: this file's regex
// variant rejected any non-numeric patch while the three split-based copies
// tolerated it — different outputs for the same malformed version string. The
// majority (split-based) semantic wins; everyone imports from here.
export function bumpPatch(version: string): string {
  const parts = version.split(".");
  if (parts.length !== 3) return version + ".1";
  const patch = parseInt(parts[2], 10);
  return `${parts[0]}.${parts[1]}.${Number.isFinite(patch) ? patch + 1 : 1}`;
}
