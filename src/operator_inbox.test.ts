/**
 * Tests for v0.50.0 — operator inbox state machine.
 *
 * REQUIRES live Postgres (auto-skipped if absent), same pattern as
 * task_queue.test.ts. vitest.setup.ts forces the test database.
 *
 * Coverage:
 *   - createInboxEntry: inserts pending; rejects empty question
 *   - listInbox: status filtering; oldest-first for actionable states
 *   - answerInboxEntry: pending→answered exactly once (second call reports
 *     no-move — the 409 semantics); rejects empty answer
 *   - markInboxDelivered: answered→delivered exactly once; refuses from
 *     pending (delivery may only follow an operator answer)
 *   - full lifecycle: pending → answered → delivered with fields populated
 *
 * The HTTP wiring and the dispatcher delivery loop are covered by live E2E
 * (2026-07-28: question #2953 → dashboard answer → OPERATOR_ANSWER_DELIVERED
 * → orchestrator receipt #2954); these tests pin the SQL invariants.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pgHealthCheck, shutdownPgPool } from "./pg_pool.js";
import { runPgMigrations } from "./pg_migrations.js";
import {
  createInboxEntry,
  listInbox,
  answerInboxEntry,
  markInboxDelivered,
} from "./operator_inbox.js";

process.env.ZC_POSTGRES_USER ??= "scuser";
process.env.ZC_POSTGRES_PASSWORD ??= "79bd1ca6011b797c70e90c02becdaa90d99cfc501abaec09";
process.env.ZC_POSTGRES_HOST ??= "localhost";
process.env.ZC_POSTGRES_PORT ??= "5432";
const pgAvailable = await pgHealthCheck();

beforeAll(async () => {
  if (pgAvailable) {
    // Self-heal: if a previous run dropped the table while the migration
    // tracker still records id 43 as applied, un-record it so the migration
    // recreates the table. No-op on a healthy test DB.
    const { withClient } = await import("./pg_pool.js");
    await withClient(async (c) => {
      await c.query(`DELETE FROM schema_migrations_pg WHERE id = 43`).catch(() => { /* tracker absent on fresh DB */ });
    }).catch(() => { /* fresh DB — migrations will create everything */ });
    await runPgMigrations();
  }
});

afterAll(async () => {
  await shutdownPgPool();
});

beforeEach(async () => {
  if (pgAvailable) {
    // Truncate rather than drop: the migration runner records applied ids, so
    // a dropped table would NOT be recreated by a re-run within the same DB.
    const { withClient } = await import("./pg_pool.js");
    await withClient(async (c) => { await c.query(`DELETE FROM operator_inbox_pg`); });
  }
});

const PROJ = "C:\\test\\inbox-project";

describe.skipIf(!pgAvailable)("operator inbox state machine", () => {
  it("creates a pending entry and lists it", async () => {
    const id = await createInboxEntry({ projectPath: PROJ, question: "Which phase next?", fromAgent: "orchestrator", broadcastId: 2953 });
    expect(id).toBeGreaterThan(0);
    const pending = await listInbox("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].question).toBe("Which phase next?");
    expect(pending[0].status).toBe("pending");
    expect(Number(pending[0].broadcast_id)).toBe(2953);
    expect(pending[0].answer).toBeNull();
  });

  it("rejects an empty question", async () => {
    await expect(createInboxEntry({ projectPath: PROJ, question: "   " })).rejects.toThrow("question required");
  });

  it("lists oldest-first for actionable states so the longest-waiting entry is on top", async () => {
    const a = await createInboxEntry({ projectPath: PROJ, question: "first" });
    const b = await createInboxEntry({ projectPath: PROJ, question: "second" });
    const pending = await listInbox("pending");
    expect(pending.map((e) => Number(e.id))).toEqual([a, b]);
  });

  it("answers exactly once: second answer reports no-move (409 semantics)", async () => {
    const id = await createInboxEntry({ projectPath: PROJ, question: "q" });
    expect(await answerInboxEntry(id, "Option A", "dashboard-operator")).toBe(true);
    expect(await answerInboxEntry(id, "Option B", "dashboard-operator")).toBe(false); // already answered
    const [entry] = await listInbox("answered");
    expect(entry.answer).toBe("Option A"); // first answer stands
    expect(entry.answered_by).toBe("dashboard-operator");
    expect(entry.answered_at).not.toBeNull();
  });

  it("rejects an empty answer without changing state", async () => {
    const id = await createInboxEntry({ projectPath: PROJ, question: "q" });
    await expect(answerInboxEntry(id, "  ")).rejects.toThrow("answer required");
    expect(await listInbox("pending")).toHaveLength(1);
  });

  it("refuses delivery straight from pending — delivery may only follow an answer", async () => {
    const id = await createInboxEntry({ projectPath: PROJ, question: "q" });
    expect(await markInboxDelivered(id)).toBe(false);
    expect((await listInbox("pending"))[0].status).toBe("pending");
  });

  it("walks the full lifecycle pending → answered → delivered, delivering exactly once", async () => {
    const id = await createInboxEntry({ projectPath: PROJ, question: "q" });
    expect(await answerInboxEntry(id, "the answer")).toBe(true);
    expect(await markInboxDelivered(id)).toBe(true);
    expect(await markInboxDelivered(id)).toBe(false); // already delivered
    const [entry] = await listInbox("delivered");
    expect(Number(entry.id)).toBe(id);
    expect(entry.delivered_at).not.toBeNull();
    expect(await listInbox("pending")).toHaveLength(0);
    expect(await listInbox("answered")).toHaveLength(0);
  });

  it("returns false for unknown ids on both transitions", async () => {
    expect(await answerInboxEntry(999999, "x")).toBe(false);
    expect(await markInboxDelivered(999999)).toBe(false);
  });
});
