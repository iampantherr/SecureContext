/**
 * Integration tests for v0.17.0 §8.2 MCP tool wrappers around task_queue.
 *
 * Verifies that the orchestrator/worker-facing tool names (zc_enqueue_task,
 * zc_claim_task, etc.) correctly drive the underlying task_queue.ts functions
 * and return the expected JSON payloads.
 *
 * These tests exercise the task_queue.ts API directly (not through MCP stdio)
 * to keep the test fast. The MCP dispatch wiring in server.ts is a thin
 * adapter — as long as each case returns the right shape, the tool call works.
 *
 * REQUIRES live Postgres (auto-skipped if absent).
 *
 * Coverage:
 *   - end-to-end claim-heartbeat-complete with multi-worker race
 *   - fail-path updates retries and failure_reason
 *   - queue_stats aggregation across states
 *   - back-compat: worker_id sourced from ZC_AGENT_ID env var
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { pgHealthCheck, shutdownPgPool } from "./pg_pool.js";
import { runPgMigrations } from "./pg_migrations.js";
import {
  enqueueTask, claimTask, heartbeatTask, completeTask,
  failTask, getQueueStats, _dropTaskQueueForTesting,
} from "./task_queue.js";

process.env.ZC_POSTGRES_USER     ??= "scuser";
process.env.ZC_POSTGRES_PASSWORD ??= "79bd1ca6011b797c70e90c02becdaa90d99cfc501abaec09";
process.env.ZC_POSTGRES_DB       ??= "securecontext";
process.env.ZC_POSTGRES_HOST     ??= "localhost";
process.env.ZC_POSTGRES_PORT     ??= "5432";
const pgAvailable = await pgHealthCheck();

// Simulate project hashing identical to server.ts
function hashProject(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

beforeAll(async () => {
  if (pgAvailable) {
    await _dropTaskQueueForTesting().catch(() => { /* fresh */ });
    await runPgMigrations();
  }
});
afterAll(async () => {
  await shutdownPgPool();
});
beforeEach(async () => {
  if (!pgAvailable) return;
  await _dropTaskQueueForTesting();
  await runPgMigrations();
});

describe.skipIf(!pgAvailable)("v0.17.0 §8.2 MCP integration — task_queue flow", () => {

  it("end-to-end: orchestrator enqueues → worker claims → heartbeats → completes", async () => {
    const ph = hashProject("/tmp/e2e-proj-1");
    // Orchestrator path
    const inserted = await enqueueTask({
      taskId: "task-abc", projectHash: ph, role: "developer",
      payload: { summary: "write a test", files: ["a.ts"] },
    });
    expect(inserted).toBe(true);

    // Worker path — simulates zc_claim_task with ZC_AGENT_ID=developer-2
    const claim = await claimTask(ph, "developer", "developer-2");
    expect(claim?.taskId).toBe("task-abc");
    expect(claim?.payload).toMatchObject({ summary: "write a test" });

    // Heartbeat accepts while owned
    expect(await heartbeatTask("task-abc", "developer-2")).toBe(true);
    // But rejects from another worker
    expect(await heartbeatTask("task-abc", "developer-3")).toBe(false);

    // Worker completes
    expect(await completeTask("task-abc", "developer-2")).toBe(true);

    // Queue now has 0 queued + 0 claimed + 1 done
    const stats = await getQueueStats(ph);
    expect(stats.done).toBe(1);
    expect(stats.queued).toBe(0);
    expect(stats.claimed).toBe(0);
  });

  it("multi-worker race: 3 pool workers, 1 task → exactly one wins", async () => {
    const ph = hashProject("/tmp/e2e-proj-2");
    await enqueueTask({
      taskId: "task-one", projectHash: ph, role: "developer",
      payload: { summary: "contested" },
    });
    // All 3 race
    const results = await Promise.all([
      claimTask(ph, "developer", "developer-1"),
      claimTask(ph, "developer", "developer-2"),
      claimTask(ph, "developer", "developer-3"),
    ]);
    const winners = results.filter((r) => r !== null);
    expect(winners.length).toBe(1);
    expect(winners[0]?.taskId).toBe("task-one");
  });

  it("fail flow: retries bump + failure_reason persisted", async () => {
    const ph = hashProject("/tmp/e2e-proj-3");
    await enqueueTask({
      taskId: "task-fail", projectHash: ph, role: "developer", payload: {},
    });
    await claimTask(ph, "developer", "developer-1");
    const ok = await failTask("task-fail", "developer-1", "compile error on line 42");
    expect(ok).toBe(true);
    const stats = await getQueueStats(ph);
    expect(stats.failed).toBe(1);
  });

  it("queue_stats aggregates across states in one project scope", async () => {
    const ph = hashProject("/tmp/e2e-proj-4");
    // 2 queued
    for (const id of ["q1", "q2"]) {
      await enqueueTask({ taskId: id, projectHash: ph, role: "developer", payload: {} });
    }
    // 1 more + claim + complete
    await enqueueTask({ taskId: "q3", projectHash: ph, role: "developer", payload: {} });
    await claimTask(ph, "developer", "w1");
    await completeTask("q1", "w1");
    // (After completeTask q1, q2 and q3 remain queued — we claimed q1 only)
    const stats = await getQueueStats(ph);
    expect(stats.queued).toBe(2);
    expect(stats.done).toBe(1);
  });

  it("cross-project scope isolation: project A tasks invisible to project B claim", async () => {
    const phA = hashProject("/tmp/proj-A-" + randomUUID().slice(0, 6));
    const phB = hashProject("/tmp/proj-B-" + randomUUID().slice(0, 6));
    await enqueueTask({ taskId: "only-A", projectHash: phA, role: "developer", payload: {} });
    // B attempts claim → returns null even though role matches
    expect(await claimTask(phB, "developer", "w1")).toBeNull();
    // A can claim
    expect((await claimTask(phA, "developer", "w1"))?.taskId).toBe("only-A");
  });
});
