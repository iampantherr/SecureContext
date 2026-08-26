/**
 * Skill-uplift measurement (v0.61.0 — mutation engine M3e)
 * ==========================================================
 *
 * Operator's rule: a skill earns its keep only if it beats the BARE model.
 * A candidate can be accurate, judged excellent, and still be worthless —
 * because a competent agent with no skill document would do just as well.
 * Every promote-worthy result therefore carries an uplift metric so the
 * operator decides "does this earn its keep?" with numbers, not vibes.
 *
 * Two measurements, matched to what the cycle has available:
 *
 * 1. REPLAY uplift (fixtures/anchors exist): run the SAME scenarios through
 *    the simulator with NO skill document at all, score against the same
 *    rubric, and report skill-accuracy vs bare-accuracy. Direct A/B.
 *
 * 2. JUDGE uplift (judge-only path, nothing to replay): a dedicated judge
 *    call scores the body's MARGINAL value over base-model knowledge —
 *    0 = generic advice the model already knows, 1 = dense, non-guessable,
 *    project-specific knowledge — naming redundant vs genuinely-additive
 *    content so the operator sees WHY.
 *
 * Both are informational gates: they annotate the queue headline; they never
 * auto-reject. The operator remains the decision-maker.
 */
import type { SkillFixture } from "./types.js";
import { runClaudeHeadless, extractJsonPayload } from "./mutators/cli_headless.js";
import { scoreFixtureMatch } from "./scoring.js";

export interface UpliftResult {
  /** "replay": A/B on real fixtures/anchors. "ab": A/B on synthesized held-out
   *  scenarios (judge-only path). "judge": rating-only fallback when scenario
   *  synthesis fails. */
  kind:      "replay" | "ab" | "judge";
  /** Skill-side score (replay accuracy of the candidate, or judge's skill score) */
  skill:     number;
  /** Bare-model score on the same rubric (replay kind only) */
  bare?:     number;
  /** skill − bare (replay kind only) */
  delta?:    number;
  /** Short label for HOW the numbers were produced (e.g. per-set deltas for
   *  the dual blind/informed A/B). Rendered in the headline parenthetical. */
  basis?:    string;
  rationale: string;
}

/**
 * Simulate a competent agent handling one fixture scenario with NO skill
 * document, and score it against the fixture's expected rubric.
 * Returns null on any model/parse failure (uplift is best-effort).
 */
function bareModelAccuracy(fixture: SkillFixture): number | null {
  const keys = Object.keys(fixture.expected);
  const prompt = [
    `You are simulating a competent AI agent (Claude-class, general knowledge`,
    `only) handling the scenario below WITHOUT any skill or procedure document.`,
    `Faithfully estimate what such an agent would actually achieve — neither`,
    `generous nor harsh. If general knowledge plausibly gets it right, say so;`,
    `if the scenario hinges on project-specific facts an outsider cannot know,`,
    `the outcome must reflect that miss.`,
    ``,
    `## Scenario`,
    "```json",
    JSON.stringify(fixture.input).slice(0, 4_000),
    "```",
    ``,
    `Reply with ONLY a JSON object. It MUST include each of these keys with`,
    `your honest value for what the agent would achieve:`,
    keys.map((k) => `- ${k}`).join("\n"),
  ].join("\n");
  try {
    const raw = runClaudeHeadless(prompt, {
      model: process.env["ZC_REPLAY_CLI_MODEL"] || undefined,
      timeoutMs: parseInt(process.env["ZC_REPLAY_TIMEOUT_MS"] ?? "", 10) || 240_000,
    });
    const outcome = JSON.parse(extractJsonPayload(raw)) as Record<string, unknown>;
    return scoreFixtureMatch(outcome, fixture.expected).score;
  } catch {
    return null;
  }
}

/**
 * REPLAY uplift: bare-model accuracy over the replay set vs the candidate's
 * replay accuracy (computed by the caller from per_fixture results).
 */
export function measureReplayUplift(replaySet: SkillFixture[], candidateAccuracy: number): UpliftResult | null {
  const accs = replaySet.map(bareModelAccuracy).filter((a): a is number => a !== null);
  if (accs.length === 0) return null;
  const bare = accs.reduce((s, a) => s + a, 0) / accs.length;
  const delta = candidateAccuracy - bare;
  return {
    kind: "replay",
    skill: candidateAccuracy,
    bare,
    delta,
    rationale: `same ${accs.length} scenario(s) replayed with NO skill document scored ${bare.toFixed(2)}`,
  };
}

/**
 * JUDGE uplift: marginal value of the body over base-model knowledge.
 * Returns null on failure — never throws, never blocks the cycle.
 */
export function judgeSkillUplift(body: string, description: string): UpliftResult | null {
  const prompt = [
    `You are auditing a skill document (a procedure AI agents load before a`,
    `task) for MARGINAL VALUE: how much does it add over what a competent`,
    `Claude-class agent already knows and would do unprompted?`,
    ``,
    `Scoring rubric (uplift_score, 0-1):`,
    `- 0.0-0.3: generic best practice the model reliably does anyway`,
    `  (e.g. "validate inputs", "check the error message", "write tests")`,
    `- 0.4-0.6: mostly known, but encodes some ordering/emphasis or a few`,
    `  specifics an agent might miss under pressure`,
    `- 0.7-1.0: dense non-guessable knowledge: exact endpoints/IDs/commands,`,
    `  bespoke state machines, non-obvious failure modes, project-specific`,
    `  sequences an outsider could not reconstruct`,
    ``,
    `Be adversarial toward the skill: assume a strong base model and ask what`,
    `it would genuinely get wrong WITHOUT this document.`,
    ``,
    `## Skill description`,
    description.slice(0, 1_000),
    ``,
    `## Skill body`,
    "```markdown",
    body.slice(0, 14_000),
    "```",
    ``,
    `Reply with ONLY a JSON object:`,
    `{"uplift_score": 0.0, "additive": ["<top facts the base model would NOT know>"], "redundant": ["<sections a base model already does>"], "rationale": "<=200 chars"}`,
  ].join("\n");
  try {
    const raw = runClaudeHeadless(prompt, { timeoutMs: parseInt(process.env["ZC_MUTATOR_TIMEOUT_MS"] ?? "", 10) || 240_000 });
    const v = JSON.parse(extractJsonPayload(raw)) as { uplift_score?: number; rationale?: string; additive?: string[]; redundant?: string[] };
    const score = Math.max(0, Math.min(1, Number(v.uplift_score ?? 0)));
    const additive = (v.additive ?? []).slice(0, 3).join("; ").slice(0, 200);
    return {
      kind: "judge",
      skill: score,
      rationale: `${String(v.rationale ?? "").slice(0, 200)}${additive ? ` | additive: ${additive}` : ""}`,
    };
  } catch {
    return null;
  }
}

/**
 * TRUE A/B for a skill body with no fixtures (operator ask 2026-08-26: the
 * judge-only path must still show base-model-vs-skill NUMBERS, not a rating).
 *
 * A scenario-maker call (examiner role — the proposer never sees these)
 * synthesizes `n` concrete evaluation scenarios with a rubric from the skill's
 * domain, then BOTH sides are simulated on the same rubric:
 *   bare  = agent with general knowledge only
 *   skill = agent following this body
 * Returns null if scenario synthesis fails (caller falls back to judge rating).
 */
export function measureAbUplift(body: string, description: string, n = 2): UpliftResult | null {
  // Two scenario sets with opposite biases, equal-weight averaged (operator
  // decision 2026-08-26):
  //   BLIND: the scenario-maker sees ONLY the description — it cannot copy
  //     the body's own claims into the rubric, so a skill full of unfalsifiable
  //     self-description gets no free pass. Bias: understates niche knowledge.
  //   INFORMED: the scenario-maker sees the body (original method) — it finds
  //     exactly where the document's knowledge matters. Bias: overstates,
  //     and treats the body as ground truth.
  // Averaging keeps a genuinely-additive skill able to beat the bare model
  // without the test certifying nearly every skill as better.
  const evalSet = (mode: "blind" | "informed") => {
    const scenarios = deriveEvalScenarios(mode, body, description, n);
    const pairs = scenarios.map((f) => {
      const bare = bareModelAccuracy(f);
      const withSkill = skillModelAccuracy(body, f);
      return bare !== null && withSkill !== null ? { bare, withSkill } : null;
    }).filter((p): p is { bare: number; withSkill: number } => p !== null);
    if (pairs.length === 0) return null;
    return {
      bare:  pairs.reduce((s, p) => s + p.bare, 0) / pairs.length,
      skill: pairs.reduce((s, p) => s + p.withSkill, 0) / pairs.length,
      n:     pairs.length,
    };
  };
  const blind    = evalSet("blind");
  const informed = evalSet("informed");
  const sets = [blind, informed].filter((s): s is NonNullable<typeof s> => s !== null);
  if (sets.length === 0) return null;
  const bare  = sets.reduce((s, x) => s + x.bare, 0) / sets.length;
  const skill = sets.reduce((s, x) => s + x.skill, 0) / sets.length;
  const fmt = (s: { bare: number; skill: number } | null) =>
    s ? `Δ${s.skill - s.bare >= 0 ? "+" : ""}${(s.skill - s.bare).toFixed(2)}` : "failed";
  return {
    kind: "ab",
    skill,
    bare,
    delta: skill - bare,
    // The per-set deltas ride in the basis so the operator sees the SPREAD:
    // a big informed-Δ with a near-zero blind-Δ means the skill only wins on
    // tests built from its own claims.
    basis: `blind ${fmt(blind)} / informed ${fmt(informed)}`,
    rationale: `equal-weight avg of two held-out scenario sets: BLIND (test-maker saw only the description; ${blind ? blind.n : 0} scenario(s), ${fmt(blind)}) and INFORMED (test-maker saw the body; ${informed ? informed.n : 0} scenario(s), ${fmt(informed)})`,
  };
}

/**
 * Scenario-maker: concrete eval scenarios + rubric.
 * "informed" sees the body (finds where the document's knowledge matters);
 * "blind" sees only the description (tests the claimed domain from the
 * outside — it cannot build the rubric from the body's own assertions).
 */
function deriveEvalScenarios(mode: "blind" | "informed", body: string, description: string, n: number): SkillFixture[] {
  const sourceSection = mode === "informed"
    ? [
        `## Skill description`,
        description.slice(0, 800),
        ``,
        `## Skill body`,
        "```markdown",
        body.slice(0, 12_000),
        "```",
      ]
    : [
        `## Skill description (this is ALL you get — the document body is`,
        `deliberately withheld so your test cannot be built from its claims)`,
        description.slice(0, 800),
        ``,
        `Design scenarios from the DOMAIN this description names: realistic,`,
        `specific situations a practitioner in that domain actually faces.`,
      ];
  const prompt = [
    `You are constructing EVALUATION scenarios for a skill document (a`,
    `procedure AI agents load before a task). The scenarios will be used to`,
    `measure whether the document beats an agent with no document at all — so`,
    `design situations where domain-specific knowledge matters, not generic`,
    `situations any competent agent handles.`,
    ``,
    `Rules:`,
    `- input.scenario: concrete and self-contained (an agent can act on it`,
    `  without extra context).`,
    `- expected: 2-4 plain rubric keys a CORRECT handling must achieve`,
    `  (booleans preferred). Keys must be objectively checkable from the`,
    `  scenario, not matters of style.`,
    ``,
    ...sourceSection,
    ``,
    `Reply with ONLY a JSON array of exactly ${n} scenarios:`,
    `[{"fixture_id":"ab-eval-1","description":"<=100 chars","input":{"scenario":"..."},"expected":{...}}]`,
  ].join("\n");
  try {
    const raw = runClaudeHeadless(prompt, { timeoutMs: parseInt(process.env["ZC_MUTATOR_TIMEOUT_MS"] ?? "", 10) || 240_000 });
    const arr = JSON.parse(extractJsonPayload(raw)) as SkillFixture[];
    return arr.slice(0, n).map((f, i) => ({
      fixture_id:  `ab-eval-${mode}-${i + 1}`,
      description: String(f.description ?? "").slice(0, 200),
      input:       (f.input && typeof f.input === "object") ? f.input : { scenario: String(f.input ?? "") },
      expected:    (f.expected && typeof f.expected === "object") ? f.expected : {},
    })).filter((f) => Object.keys(f.expected).length > 0);
  } catch {
    return [];
  }
}

/** Simulate an agent following `body` on one scenario; score vs the rubric. */
function skillModelAccuracy(body: string, fixture: SkillFixture): number | null {
  const keys = Object.keys(fixture.expected);
  const prompt = [
    `You are simulating an AI agent that follows the skill document below,`,
    `applied to the scenario in INPUT. Judge the document as written — do not`,
    `fix its gaps: if the instructions would miss something here, the outcome`,
    `must reflect that miss.`,
    ``,
    `## Skill document`,
    "```markdown",
    body.slice(0, 14_000),
    "```",
    ``,
    `## INPUT (scenario)`,
    "```json",
    JSON.stringify(fixture.input).slice(0, 4_000),
    "```",
    ``,
    `Reply with ONLY a JSON object. It MUST include each of these keys with`,
    `your honest value for what the agent would achieve:`,
    keys.map((k) => `- ${k}`).join("\n"),
  ].join("\n");
  try {
    const raw = runClaudeHeadless(prompt, {
      model: process.env["ZC_REPLAY_CLI_MODEL"] || undefined,
      timeoutMs: parseInt(process.env["ZC_REPLAY_TIMEOUT_MS"] ?? "", 10) || 240_000,
    });
    const outcome = JSON.parse(extractJsonPayload(raw)) as Record<string, unknown>;
    return scoreFixtureMatch(outcome, fixture.expected).score;
  } catch {
    return null;
  }
}

/** Compact headline suffix, one vocabulary across kinds. Machine-parseable —
 *  the dashboard extracts it into the base-vs-skill badge (parseUpliftSegment). */
export function upliftHeadline(u: UpliftResult): string {
  if (u.kind === "replay" || u.kind === "ab") {
    const sign = (u.delta ?? 0) >= 0 ? "+" : "";
    const flag = (u.delta ?? 0) < 0.1 ? " ⚠ LOW-UPLIFT" : "";
    const basis = u.basis ? `, ${u.basis}` : (u.kind === "ab" ? ", held-out scenarios" : ", real fixtures");
    return ` · uplift ${sign}${(u.delta ?? 0).toFixed(2)} (skill ${u.skill.toFixed(2)} vs bare ${u.bare?.toFixed(2)}${basis})${flag}`;
  }
  const flag = u.skill < 0.4 ? " ⚠ LOW-UPLIFT" : "";
  return ` · uplift(judge) ${u.skill.toFixed(2)} vs bare model${flag}`;
}

/**
 * Parse an uplift segment back out of a stored headline. Used by the
 * dashboard to render the base-vs-skill comparison as a first-class element
 * instead of buried prose. Returns null when the headline has no segment.
 */
export function parseUpliftSegment(headline: string): { skill: number; bare: number | null; delta: number | null; basis: string; low: boolean } | null {
  const ab = /· uplift ([+-]\d+\.\d+) \(skill (\d+\.\d+) vs bare (\d+\.\d+)(?:, ([^)]+))?\)( ⚠ LOW-UPLIFT)?/.exec(headline);
  if (ab) {
    return { skill: Number(ab[2]), bare: Number(ab[3]), delta: Number(ab[1]), basis: ab[4] ?? "fixtures", low: Boolean(ab[5]) };
  }
  const j = /· uplift\(judge\) (\d+\.\d+) vs bare model( ⚠ LOW-UPLIFT)?/.exec(headline);
  if (j) {
    return { skill: Number(j[1]), bare: null, delta: null, basis: "judge rating (no A/B run)", low: Boolean(j[2]) };
  }
  return null;
}
