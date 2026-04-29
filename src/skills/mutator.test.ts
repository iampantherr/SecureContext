/**
 * Tests for v0.18.0 — mutator.ts + LocalMockMutator + RealtimeSonnetMutator.
 *
 * Covers:
 *   - allowlist enforcement (RT-S2-05): unknown ZC_MUTATOR_MODEL → falls back to local-mock
 *   - prompt builder includes parent body + failures + fixtures + acceptance
 *   - parseProposerResponse handles raw JSON, code-fenced JSON, and rejects malformed
 *   - hashCandidates produces verifiable HMACs (RT-S2-09 enabling)
 *   - preSubmissionSecretScan rejects payloads with API keys (RT-S2-07)
 *   - LocalMockMutator: deterministic candidates + judge pick
 *   - candidateToSkill: bumps version + signs body
 *   - getMutator factory honors env override
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveMutatorId, KNOWN_MUTATORS, getMutator,
  buildProposerPrompt, parseProposerResponse, hashCandidates,
  preSubmissionSecretScan, candidateToSkill,
} from "./mutator.js";
import { LocalMockMutator } from "./mutators/local_mock.js";
import { buildSkill, verifySkillHmac } from "./loader.js";
import type { Skill, MutationContext } from "./types.js";

const ORIGINAL_ENV = process.env.ZC_MUTATOR_MODEL;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.ZC_MUTATOR_MODEL;
  else process.env.ZC_MUTATOR_MODEL = ORIGINAL_ENV;
});

async function makeParent(): Promise<Skill> {
  return buildSkill(
    {
      name: "audit_file", version: "1.0.0", scope: "global",
      description: "audit a file",
      acceptance_criteria: { min_outcome_score: 0.7, min_pass_rate: 0.8 },
    },
    "# Audit File\n\nDo the audit.",
  );
}

function makeCtx(parent: Skill): MutationContext {
  return {
    parent,
    recent_runs: [],
    failure_traces: ["TypeError on input.foo", "Timeout after 30s"],
    fixtures: [
      { fixture_id: "f1", description: "happy", input: { x: 1 }, expected: { ok: true } },
      { fixture_id: "f2", description: "edge", input: { x: 0 }, expected: { ok: true } },
    ],
  };
}

// ─── Allowlist (RT-S2-05) ───────────────────────────────────────────────────

describe("v0.18.0 mutator — allowlist (RT-S2-05)", () => {

  it("known ids are accepted", () => {
    expect(KNOWN_MUTATORS.has("realtime-sonnet")).toBe(true);
    expect(KNOWN_MUTATORS.has("batch-sonnet")).toBe(true);
    expect(KNOWN_MUTATORS.has("local-mock")).toBe(true);
  });

  it("unknown id falls back to local-mock", () => {
    expect(resolveMutatorId("https://evil.com/api")).toBe("local-mock");
    expect(resolveMutatorId("totally-fake-model")).toBe("local-mock");
  });

  it("env var ZC_MUTATOR_MODEL is respected when known", () => {
    process.env.ZC_MUTATOR_MODEL = "realtime-sonnet";
    expect(resolveMutatorId()).toBe("realtime-sonnet");
  });

  it("env var with unknown value falls back to local-mock", () => {
    process.env.ZC_MUTATOR_MODEL = "https://attacker.example.com/api";
    expect(resolveMutatorId()).toBe("local-mock");
  });

  it("undefined env defaults to local-mock", () => {
    delete process.env.ZC_MUTATOR_MODEL;
    expect(resolveMutatorId()).toBe("local-mock");
  });

  it("getMutator factory returns LocalMockMutator on default", async () => {
    delete process.env.ZC_MUTATOR_MODEL;
    const m = await getMutator();
    expect(m.id).toBe("local-mock");
  });
});

// ─── Prompt builder ─────────────────────────────────────────────────────────

describe("v0.18.0 mutator — buildProposerPrompt", () => {

  it("includes parent body, failures, fixtures, and acceptance criteria", async () => {
    const parent = await makeParent();
    const ctx = makeCtx(parent);
    const prompt = buildProposerPrompt(ctx);

    expect(prompt).toContain(parent.body);
    expect(prompt).toContain("TypeError on input.foo");
    expect(prompt).toContain("Timeout after 30s");
    expect(prompt).toContain("fixture");
    expect(prompt).toContain("min_outcome_score");
    expect(prompt).toContain("Generate exactly 5 candidates");
  });

  it("caps failures at 10", async () => {
    const parent = await makeParent();
    const ctx = makeCtx(parent);
    ctx.failure_traces = Array.from({ length: 25 }, (_, i) => `Failure ${i}`);
    const prompt = buildProposerPrompt(ctx);
    expect(prompt).toContain("Failure 0");
    expect(prompt).toContain("Failure 9");
    expect(prompt).not.toContain("Failure 10");
  });
});

// ─── parseProposerResponse ─────────────────────────────────────────────────

describe("v0.18.0 mutator — parseProposerResponse", () => {

  it("parses raw JSON array of candidates", () => {
    const raw = JSON.stringify([
      { candidate_body: "body1", rationale: "r1" },
      { candidate_body: "body2", rationale: "r2" },
    ]);
    const r = parseProposerResponse(raw);
    expect(r.length).toBe(2);
    expect(r[0].candidate_body).toBe("body1");
  });

  it("strips code fences", () => {
    const raw = '```json\n' + JSON.stringify([{ candidate_body: "b", rationale: "r" }]) + '\n```';
    const r = parseProposerResponse(raw);
    expect(r.length).toBe(1);
  });

  it("includes self_rated_score when provided", () => {
    const raw = JSON.stringify([{ candidate_body: "b", rationale: "r", self_rated_score: 0.85 }]);
    const r = parseProposerResponse(raw);
    expect(r[0].self_rated_score).toBe(0.85);
  });

  it("filters out invalid items", () => {
    const raw = JSON.stringify([
      { candidate_body: "ok", rationale: "ok" },
      { candidate_body: 123, rationale: "wrong type" },     // invalid
      { rationale: "no body" },                              // missing
      { candidate_body: "good", rationale: "good" },
    ]);
    const r = parseProposerResponse(raw);
    expect(r.length).toBe(2);
  });

  it("throws on non-array", () => {
    expect(() => parseProposerResponse("{}")).toThrow();
  });

  it("throws when no valid candidates", () => {
    expect(() => parseProposerResponse("[]")).toThrow();
    expect(() => parseProposerResponse("[{\"foo\":\"bar\"}]")).toThrow();
  });
});

// ─── HMAC of candidates (RT-S2-09 enabling) ────────────────────────────────

describe("v0.18.0 mutator — hashCandidates", () => {

  it("produces stable HMACs that verify back to the body", async () => {
    const candidates = [
      { candidate_body: "body A", rationale: "r" },
      { candidate_body: "body B", rationale: "r" },
    ];
    const hashes = await hashCandidates(candidates);
    expect(hashes.length).toBe(2);
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(await verifySkillHmac("body A", hashes[0])).toBe(true);
    expect(await verifySkillHmac("body B", hashes[1])).toBe(true);
    // Tampering detected
    expect(await verifySkillHmac("body A modified", hashes[0])).toBe(false);
  });
});

// ─── Pre-submission secret scan (RT-S2-07) ─────────────────────────────────

describe("v0.18.0 mutator — preSubmissionSecretScan (RT-S2-07)", () => {

  it("clean prompt → not matched", async () => {
    const r = await preSubmissionSecretScan("Just a regular prompt with no secrets.");
    expect(r.matched).toBe(false);
  });

  it("prompt with Anthropic API key → matched", async () => {
    const r = await preSubmissionSecretScan("Use this key: sk-ant-api01-abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef");
    expect(r.matched).toBe(true);
  });

  it("prompt with AWS access key → matched", async () => {
    const r = await preSubmissionSecretScan("AKIAIOSFODNN7EXAMPLE is the access key");
    expect(r.matched).toBe(true);
  });
});

// ─── LocalMockMutator ──────────────────────────────────────────────────────

describe("v0.18.0 LocalMockMutator", () => {

  it("returns 5 candidates", async () => {
    const parent = await makeParent();
    const ctx = makeCtx(parent);
    const mutator = new LocalMockMutator();
    const result = await mutator.mutate(ctx);
    expect(result.candidates.length).toBe(5);
  });

  it("each candidate has body + rationale", async () => {
    const parent = await makeParent();
    const ctx = makeCtx(parent);
    const result = await new LocalMockMutator().mutate(ctx);
    for (const c of result.candidates) {
      expect(typeof c.candidate_body).toBe("string");
      expect(c.candidate_body.length).toBeGreaterThan(0);
      expect(typeof c.rationale).toBe("string");
    }
  });

  it("judge_pick_index is in [0,4]", async () => {
    const parent = await makeParent();
    const ctx = makeCtx(parent);
    const result = await new LocalMockMutator().mutate(ctx);
    expect(result.judge_pick_index).toBeGreaterThanOrEqual(0);
    expect(result.judge_pick_index).toBeLessThan(5);
  });

  it("deterministic for same parent body", async () => {
    const parent1 = await makeParent();
    const parent2 = await makeParent();
    const c1 = await new LocalMockMutator().mutate(makeCtx(parent1));
    const c2 = await new LocalMockMutator().mutate(makeCtx(parent2));
    expect(c1.judge_pick_index).toBe(c2.judge_pick_index);
  });

  it("zero cost (no API calls)", async () => {
    const parent = await makeParent();
    const r = await new LocalMockMutator().mutate(makeCtx(parent));
    expect(r.proposer_cost_usd).toBe(0);
    expect(r.total_cost_usd).toBe(0);
  });

  it("proposer_model id is 'local-mock'", async () => {
    const parent = await makeParent();
    const r = await new LocalMockMutator().mutate(makeCtx(parent));
    expect(r.proposer_model).toBe("local-mock");
  });
});

// ─── candidateToSkill ──────────────────────────────────────────────────────

describe("v0.18.0 mutator — candidateToSkill", () => {

  it("bumps patch version and signs the new body", async () => {
    const parent = await makeParent();
    const candidate = { candidate_body: "new body", rationale: "r" };
    const newSkill = await candidateToSkill(parent, candidate);
    expect(newSkill.frontmatter.version).toBe("1.0.1");
    expect(newSkill.body).toBe("new body");
    expect(newSkill.promoted_from).toBe(parent.skill_id);
    expect(newSkill.skill_id).toBe("audit_file@1.0.1@global");
    expect(await verifySkillHmac(newSkill.body, newSkill.body_hmac)).toBe(true);
  });

  it("preserves frontmatter except version", async () => {
    const parent = await makeParent();
    const newSkill = await candidateToSkill(parent, { candidate_body: "x", rationale: "r" });
    expect(newSkill.frontmatter.name).toBe(parent.frontmatter.name);
    expect(newSkill.frontmatter.scope).toBe(parent.frontmatter.scope);
    expect(newSkill.frontmatter.acceptance_criteria).toEqual(parent.frontmatter.acceptance_criteria);
  });
});

// ─── Realtime/Batch mutators: just smoke (no live API) ────────────────────

describe("v0.18.0 RealtimeSonnetMutator (smoke — no API call)", () => {

  it("throws when ANTHROPIC_API_KEY not set", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { RealtimeSonnetMutator } = await import("./mutators/realtime_sonnet.js");
    const parent = await makeParent();
    await expect(new RealtimeSonnetMutator().mutate(makeCtx(parent))).rejects.toThrow(/ANTHROPIC_API_KEY/);
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  });

  it("id is 'realtime-sonnet'", async () => {
    const { RealtimeSonnetMutator } = await import("./mutators/realtime_sonnet.js");
    expect(new RealtimeSonnetMutator().id).toBe("realtime-sonnet");
  });
});

describe("v0.18.0 BatchSonnetMutator (smoke — no API call)", () => {

  it("throws when ANTHROPIC_API_KEY not set", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { BatchSonnetMutator } = await import("./mutators/batch_sonnet.js");
    const parent = await makeParent();
    await expect(new BatchSonnetMutator().mutate(makeCtx(parent))).rejects.toThrow(/ANTHROPIC_API_KEY/);
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  });

  it("id is 'batch-sonnet'", async () => {
    const { BatchSonnetMutator } = await import("./mutators/batch_sonnet.js");
    expect(new BatchSonnetMutator().id).toBe("batch-sonnet");
  });

  it("BatchTimeoutError exposes batch_id + elapsed_ms", async () => {
    const { BatchTimeoutError } = await import("./mutators/batch_sonnet.js");
    const e = new BatchTimeoutError("b1", 1234);
    expect(e.batch_id).toBe("b1");
    expect(e.elapsed_ms).toBe(1234);
    expect(e.message).toContain("b1");
  });
});
