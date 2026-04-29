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

/** Pluggable mutator interface — every impl satisfies this. */
export interface Mutator {
  /** Identifier reported in skill_mutations.proposed_by. */
  readonly id: string;
  /** Generate N mutation candidates given a parent + recent failures. */
  mutate(ctx: MutationContext): Promise<MutationResult>;
}

/** Allowlist of known mutator ids — see RT-S2-05 for the security rationale. */
export const KNOWN_MUTATORS = new Set([
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

/** Factory — returns the mutator instance matching the env-resolved id. */
export async function getMutator(envOverride?: string): Promise<Mutator> {
  const id = resolveMutatorId(envOverride);
  switch (id) {
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

  return [
    "You are improving a skill that has been showing recent failures.",
    "Propose 5 alternate skill bodies that would address the failure traces while still passing the fixtures.",
    "",
    "## Parent skill body (current version):",
    "```",
    ctx.parent.body,
    "```",
    "",
    "## Recent failure traces:",
    failures.length > 0 ? failures.map((f, i) => `${i + 1}. ${f}`).join("\n") : "(none)",
    "",
    "## Fixtures the candidate must continue to pass:",
    fxSnippet || "(none)",
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
  ].join("\n");
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

function bumpPatch(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return version + ".1";
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}
