/**
 * Tests for v0.18.1 — promotion_queue.ts (SQLite path; PG mirror covered in storage_dual integration).
 *
 * Covers:
 *   - enqueuePromotion inserts a pending row
 *   - duplicate (candidate_skill_id, proposed_target) → idempotent (no overwrite)
 *   - listPending returns only status='pending' (not approved/rejected)
 *   - approvePromotion sets status + decided_at/by/rationale
 *   - rejectPromotion sets status + decided_at/by/rationale
 *   - approvePromotion of already-decided row → returns false
 *   - listPending excludes decided rows
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../migrations.js";
import {
  enqueuePromotion, listPending, approvePromotion, rejectPromotion,
} from "./promotion_queue.js";

let tmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  mkdirSync(join(homedir(), ".claude", "zc-ctx"), { recursive: true });
  tmpDir = mkdtempSync(join(tmpdir(), "promq-"));
  db = new DatabaseSync(join(tmpDir, "test.db"));
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  // Force SQLite-only path for these tests
  process.env.ZC_TELEMETRY_BACKEND = "sqlite";
});

afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  delete process.env.ZC_TELEMETRY_BACKEND;
});

describe("v0.18.1 — promotion_queue", () => {

  it("enqueuePromotion inserts a pending row", async () => {
    const r = await enqueuePromotion(db, {
      candidate_skill_id: "audit@1.0.5@project:abc1234567890123",
      proposed_target: "global",
      surfaced_by: "cron",
      best_avg: 0.91,
      global_avg: 0.65,
      project_count: 3,
    });
    expect(r.inserted).toBe(true);
    const pending = await listPending(db);
    expect(pending.length).toBe(1);
    expect(pending[0].candidate_skill_id).toBe("audit@1.0.5@project:abc1234567890123");
    expect(pending[0].status).toBe("pending");
    expect(pending[0].best_avg).toBeCloseTo(0.91, 4);
    expect(pending[0].project_count).toBe(3);
  });

  it("duplicate enqueue → idempotent (returns inserted=false)", async () => {
    await enqueuePromotion(db, {
      candidate_skill_id: "x@1.0.0@project:abc",
      proposed_target: "global",
      surfaced_by: "cron",
      best_avg: 0.85, global_avg: 0.60, project_count: 2,
    });
    const r2 = await enqueuePromotion(db, {
      candidate_skill_id: "x@1.0.0@project:abc",
      proposed_target: "global",
      surfaced_by: "manual",  // different surfaced_by, but same key
      best_avg: 0.99, global_avg: 0.99, project_count: 99,
    });
    expect(r2.inserted).toBe(false);
    // Original record preserved
    const pending = await listPending(db);
    expect(pending[0].best_avg).toBeCloseTo(0.85, 4);
    expect(pending[0].surfaced_by).toBe("cron");
  });

  it("listPending excludes approved/rejected", async () => {
    await enqueuePromotion(db, {
      candidate_skill_id: "a@1@project:p1", proposed_target: "global",
      surfaced_by: "cron", best_avg: 0.9, global_avg: 0.5, project_count: 2,
    });
    await enqueuePromotion(db, {
      candidate_skill_id: "b@1@project:p1", proposed_target: "global",
      surfaced_by: "cron", best_avg: 0.9, global_avg: 0.5, project_count: 2,
    });
    await approvePromotion(db, "a@1@project:p1", "operator-amit", "looks good");
    const pending = await listPending(db);
    expect(pending.length).toBe(1);
    expect(pending[0].candidate_skill_id).toBe("b@1@project:p1");
  });

  it("approvePromotion sets status + decision metadata", async () => {
    await enqueuePromotion(db, {
      candidate_skill_id: "a@1@project:p1", proposed_target: "global",
      surfaced_by: "cron", best_avg: 0.9, global_avg: 0.5, project_count: 2,
    });
    const ok = await approvePromotion(db, "a@1@project:p1", "operator", "approved by reviewer");
    expect(ok).toBe(true);
    const row = db.prepare(`SELECT * FROM skill_promotion_queue WHERE candidate_skill_id = 'a@1@project:p1'`).get() as Record<string, unknown>;
    expect(row.status).toBe("approved");
    expect(row.decided_by).toBe("operator");
    expect(row.decision_rationale).toBe("approved by reviewer");
    expect(row.decided_at).not.toBeNull();
  });

  it("rejectPromotion sets status='rejected' + rationale", async () => {
    await enqueuePromotion(db, {
      candidate_skill_id: "a@1@project:p1", proposed_target: "global",
      surfaced_by: "cron", best_avg: 0.9, global_avg: 0.5, project_count: 2,
    });
    const ok = await rejectPromotion(db, "a@1@project:p1", "operator", "looks A-specific, not general");
    expect(ok).toBe(true);
    const row = db.prepare(`SELECT * FROM skill_promotion_queue WHERE candidate_skill_id = 'a@1@project:p1'`).get() as Record<string, unknown>;
    expect(row.status).toBe("rejected");
    expect(row.decision_rationale).toBe("looks A-specific, not general");
  });

  it("decide on already-decided row → returns false", async () => {
    await enqueuePromotion(db, {
      candidate_skill_id: "a@1@project:p1", proposed_target: "global",
      surfaced_by: "cron", best_avg: 0.9, global_avg: 0.5, project_count: 2,
    });
    expect(await approvePromotion(db, "a@1@project:p1", "op", "yes")).toBe(true);
    // Re-approving doesn't do anything
    expect(await approvePromotion(db, "a@1@project:p1", "op", "yes again")).toBe(false);
    expect(await rejectPromotion(db, "a@1@project:p1", "op", "changed mind")).toBe(false);
  });

  it("approvePromotion on nonexistent row → returns false", async () => {
    const ok = await approvePromotion(db, "nope@1@project:x", "op", "no");
    expect(ok).toBe(false);
  });
});
