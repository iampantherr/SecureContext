/**
 * Tests for v0.18.1 — CliClaudeMutator (Pro-plan, no-API-key path).
 *
 * Covers:
 *   - Enqueues a task with role='mutator' + payload containing skill_id, traces, fixtures
 *   - Polls broadcasts; returns candidates from a matching mutation-result broadcast
 *   - Ignores unrelated broadcasts (different mutation_id, wrong type, wrong state)
 *   - Times out cleanly if no broadcast arrives in window → CliMutatorTimeoutError
 *   - Pre-submission secret scan rejects payloads containing API keys (RT-S2-07)
 *   - judge_pick_index = highest self_rated_score
 *   - Filters out invalid candidates from the broadcast (missing fields → drop)
 *   - Throws when broadcast has 0 valid candidates
 *   - Watermark: only picks up broadcasts AFTER the enqueue (not stale ones)
 *   - getMutator factory wires cli-claude correctly
 *   - Allowlist accepts cli-claude
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CliClaudeMutator, CliMutatorTimeoutError, type BroadcastSource } from "./cli_claude.js";
import { buildSkill } from "../loader.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { _resetCacheForTesting as resetMachineSecret } from "../../security/machine_secret.js";
import type { MutationContext, Skill } from "../types.js";

beforeEach(() => {
  mkdirSync(join(homedir(), ".claude", "zc-ctx"), { recursive: true });
  resetMachineSecret();
});

async function makeParent(): Promise<Skill> {
  return buildSkill(
    {
      name: "audit", version: "1.0.0", scope: "global",
      description: "audit",
      acceptance_criteria: { min_outcome_score: 0.7, min_pass_rate: 0.8 },
      fixtures: [
        { fixture_id: "f1", description: "happy", input: { x: 1 }, expected: { ok: true } },
      ],
    },
    "# Audit\nDo it.",
  );
}

function ctx(parent: Skill): MutationContext {
  return {
    parent,
    recent_runs: [],
    failure_traces: ["TypeError on x.foo", "Timeout after 30s"],
    fixtures: parent.frontmatter.fixtures ?? [],
  };
}

/** Mock broadcast source that lets the test inject responses. */
class MockBroadcastSource implements BroadcastSource {
  public broadcasts: Array<{ id: number; type: string; agent_id: string; state?: string; summary?: string }> = [];
  public lastId = 0;
  pollBroadcasts(sinceId: number) {
    return Promise.resolve(this.broadcasts.filter((b) => b.id > sinceId));
  }
  currentMaxId() {
    return Promise.resolve(this.lastId);
  }
  /** Helper for tests: drop in a broadcast with fresh id. */
  inject(b: Omit<typeof this.broadcasts[0], "id">) {
    this.lastId++;
    this.broadcasts.push({ ...b, id: this.lastId });
  }
}

describe("v0.18.1 CliClaudeMutator", () => {

  it("enqueues with role='mutator' and correct payload shape", async () => {
    const parent = await makeParent();
    const enqueued: Array<{ taskId: string; projectPath: string; role: string; payload: Record<string, unknown> }> = [];
    const enqueueFn = async (p: { taskId: string; projectPath: string; role: string; payload: Record<string, unknown> }) => { enqueued.push(p); return true; };
    const broadcasts = new MockBroadcastSource();
    const m = new CliClaudeMutator({ project_path: "/tmp/proj", timeout_ms: 200, poll_interval_ms: 50 }, { broadcastSource: broadcasts, enqueueFn });

    // Pre-inject a successful response
    setTimeout(() => {
      broadcasts.inject({
        type: "STATUS", agent_id: "skill-mutator-1", state: "mutation-result",
        summary: JSON.stringify({
          mutation_id: "<placeholder>", // we'll fill in below
          candidates: [
            { candidate_body: "body 1", rationale: "r1", self_rated_score: 0.8 },
            { candidate_body: "body 2", rationale: "r2", self_rated_score: 0.9 },
          ],
        }),
      });
    }, 10);

    // We need the SAME mutation_id the mutator chose. To make this test deterministic,
    // we patch the broadcast injection to discover the id from `enqueued` after enqueue fires.
    const promise = m.mutate(ctx(parent));
    // Wait briefly for enqueue to complete, then patch broadcast with the right id
    await new Promise((r) => setTimeout(r, 30));
    const real_id = enqueued[0]?.taskId;
    if (real_id) {
      // Replace placeholder broadcast with the right mutation_id
      broadcasts.broadcasts = broadcasts.broadcasts.filter((b) => !b.summary?.includes("<placeholder>"));
      broadcasts.inject({
        type: "STATUS", agent_id: "skill-mutator-1", state: "mutation-result",
        summary: JSON.stringify({
          mutation_id: real_id,
          candidates: [
            { candidate_body: "body 1", rationale: "r1", self_rated_score: 0.8 },
            { candidate_body: "body 2", rationale: "r2", self_rated_score: 0.9 },
          ],
          proposer_model: "claude-sonnet-4-6",
        }),
      });
    }
    const result = await promise;

    // Enqueued correctly
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].role).toBe("mutator");
    expect(enqueued[0].projectPath).toBe("/tmp/proj");
    expect(enqueued[0].payload.kind).toBe("skill-mutation");
    expect(enqueued[0].payload.skill_id).toBe(parent.skill_id);
    expect(enqueued[0].payload.failure_traces).toBeInstanceOf(Array);
    expect(enqueued[0].payload.fixtures).toBeInstanceOf(Array);
    expect(enqueued[0].payload.instructions).toContain("zc_broadcast");

    // Result has candidates from broadcast
    expect(result.candidates.length).toBe(2);
    expect(result.candidates[0].candidate_body).toBe("body 1");
    expect(result.proposer_cost_usd).toBe(0);
    expect(result.proposer_model).toBe("claude-sonnet-4-6");
    // Best by self-rated score = candidate 2 (0.9)
    expect(result.judge_pick_index).toBe(1);
  });

  it("times out cleanly when no response broadcast arrives", async () => {
    const parent = await makeParent();
    const broadcasts = new MockBroadcastSource();
    const enqueueFn = async () => true;
    const m = new CliClaudeMutator({ project_path: "/tmp/p", timeout_ms: 100, poll_interval_ms: 20 }, { broadcastSource: broadcasts, enqueueFn });
    await expect(m.mutate(ctx(parent))).rejects.toThrow(CliMutatorTimeoutError);
  });

  it("ignores broadcasts with wrong mutation_id", async () => {
    const parent = await makeParent();
    const broadcasts = new MockBroadcastSource();
    const enqueueFn = async () => true;
    broadcasts.inject({
      type: "STATUS", agent_id: "x", state: "mutation-result",
      summary: JSON.stringify({ mutation_id: "different-id", candidates: [{ candidate_body: "x", rationale: "y" }] }),
    });
    const m = new CliClaudeMutator({ project_path: "/tmp/p", timeout_ms: 200, poll_interval_ms: 30 }, { broadcastSource: broadcasts, enqueueFn });
    await expect(m.mutate(ctx(parent))).rejects.toThrow(CliMutatorTimeoutError);
  });

  it("ignores broadcasts with wrong state (e.g. 'mutation-progress' not 'mutation-result')", async () => {
    const parent = await makeParent();
    const enqueued: Array<{ taskId: string }> = [];
    const enqueueFn = async (p: { taskId: string }) => { enqueued.push(p); return true; };
    const broadcasts = new MockBroadcastSource();
    setTimeout(() => {
      const id = enqueued[0]?.taskId;
      if (id) broadcasts.inject({
        type: "STATUS", agent_id: "x", state: "mutation-progress",
        summary: JSON.stringify({ mutation_id: id, candidates: [] }),
      });
    }, 30);
    const m = new CliClaudeMutator({ project_path: "/tmp/p", timeout_ms: 150, poll_interval_ms: 20 }, { broadcastSource: broadcasts, enqueueFn });
    await expect(m.mutate(ctx(parent))).rejects.toThrow(CliMutatorTimeoutError);
  });

  it("ignores broadcasts with wrong type (e.g. ASSIGN, MERGE)", async () => {
    const parent = await makeParent();
    const enqueued: Array<{ taskId: string }> = [];
    const enqueueFn = async (p: { taskId: string }) => { enqueued.push(p); return true; };
    const broadcasts = new MockBroadcastSource();
    setTimeout(() => {
      const id = enqueued[0]?.taskId;
      if (id) broadcasts.inject({
        type: "MERGE", agent_id: "x", state: "mutation-result",
        summary: JSON.stringify({ mutation_id: id, candidates: [{ candidate_body: "b", rationale: "r" }] }),
      });
    }, 30);
    const m = new CliClaudeMutator({ project_path: "/tmp/p", timeout_ms: 150, poll_interval_ms: 20 }, { broadcastSource: broadcasts, enqueueFn });
    await expect(m.mutate(ctx(parent))).rejects.toThrow(CliMutatorTimeoutError);
  });

  it("only picks up broadcasts AFTER the watermark (not stale ones)", async () => {
    const parent = await makeParent();
    // Pre-existing broadcast BEFORE enqueue — should be ignored by the watermark
    const enqueued: Array<{ taskId: string }> = [];
    const enqueueFn = async (p: { taskId: string }) => { enqueued.push(p); return true; };
    const broadcasts = new MockBroadcastSource();
    // Inject a broadcast BEFORE we even start mutating
    broadcasts.inject({
      type: "STATUS", agent_id: "x", state: "mutation-result",
      summary: JSON.stringify({ mutation_id: "stale", candidates: [{ candidate_body: "b", rationale: "r" }] }),
    });
    // Then time out (no fresh broadcast)
    const m = new CliClaudeMutator({ project_path: "/tmp/p", timeout_ms: 100, poll_interval_ms: 20 }, { broadcastSource: broadcasts, enqueueFn });
    await expect(m.mutate(ctx(parent))).rejects.toThrow(CliMutatorTimeoutError);
  });

  it("filters out invalid candidates (missing required fields)", async () => {
    const parent = await makeParent();
    const enqueued: Array<{ taskId: string }> = [];
    const enqueueFn = async (p: { taskId: string }) => { enqueued.push(p); return true; };
    const broadcasts = new MockBroadcastSource();
    setTimeout(() => {
      const id = enqueued[0]?.taskId;
      if (id) broadcasts.inject({
        type: "STATUS", agent_id: "x", state: "mutation-result",
        summary: JSON.stringify({
          mutation_id: id,
          candidates: [
            { candidate_body: "valid", rationale: "v" },         // ok
            { candidate_body: 123, rationale: "wrong type" },     // invalid
            { rationale: "no body" },                              // missing
            { candidate_body: "another valid", rationale: "v2" },  // ok
          ],
        }),
      });
    }, 30);
    const m = new CliClaudeMutator({ project_path: "/tmp/p", timeout_ms: 200, poll_interval_ms: 20 }, { broadcastSource: broadcasts, enqueueFn });
    const result = await m.mutate(ctx(parent));
    expect(result.candidates.length).toBe(2);  // 2 invalid filtered out
  });

  it("throws when broadcast has 0 valid candidates", async () => {
    const parent = await makeParent();
    const enqueued: Array<{ taskId: string }> = [];
    const enqueueFn = async (p: { taskId: string }) => { enqueued.push(p); return true; };
    const broadcasts = new MockBroadcastSource();
    setTimeout(() => {
      const id = enqueued[0]?.taskId;
      if (id) broadcasts.inject({
        type: "STATUS", agent_id: "x", state: "mutation-result",
        summary: JSON.stringify({
          mutation_id: id,
          candidates: [{ rationale: "no body" }],  // all invalid
        }),
      });
    }, 30);
    const m = new CliClaudeMutator({ project_path: "/tmp/p", timeout_ms: 200, poll_interval_ms: 20 }, { broadcastSource: broadcasts, enqueueFn });
    await expect(m.mutate(ctx(parent))).rejects.toThrow(/0 valid candidates/);
  });

  it("pre-submission secret scan rejects API key in failure_traces (RT-S2-07)", async () => {
    const parent = await makeParent();
    const broadcasts = new MockBroadcastSource();
    const enqueueFn = async () => true;
    const m = new CliClaudeMutator({ project_path: "/tmp/p", timeout_ms: 100, poll_interval_ms: 20 }, { broadcastSource: broadcasts, enqueueFn });
    const ctxWithSecret = ctx(parent);
    ctxWithSecret.failure_traces = ["leaked: sk-ant-api01-abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"];
    await expect(m.mutate(ctxWithSecret)).rejects.toThrow(/scan rejected/);
  });

  it("CliMutatorTimeoutError exposes mutation_id + elapsed_ms", () => {
    const e = new CliMutatorTimeoutError("mut-x", 123);
    expect(e.mutation_id).toBe("mut-x");
    expect(e.elapsed_ms).toBe(123);
    expect(e.message).toContain("mut-x");
  });

  it("allowlist accepts cli-claude", async () => {
    const { resolveMutatorId, KNOWN_MUTATORS } = await import("../mutator.js");
    expect(KNOWN_MUTATORS.has("cli-claude")).toBe(true);
    expect(resolveMutatorId("cli-claude")).toBe("cli-claude");
  });

  it("getMutator(cli-claude, deps={projectPath}) returns CliClaudeMutator", async () => {
    const { getMutator } = await import("../mutator.js");
    const m = await getMutator("cli-claude", { projectPath: "/tmp/proj" });
    expect(m.id).toBe("cli-claude");
  });

  it("getMutator(cli-claude) without projectPath throws", async () => {
    const { getMutator } = await import("../mutator.js");
    await expect(getMutator("cli-claude", {})).rejects.toThrow(/projectPath/);
  });
});
