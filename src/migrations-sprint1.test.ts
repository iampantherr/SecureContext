/**
 * Tests for migrations 13/14/15 (Sprint 1 — telemetry tables)
 *
 * Per §13 testing strategy:
 *   - Unit: migrations apply cleanly + create expected tables/indexes/views
 *   - Integration: insert, query, view-rollup all work
 *   - Failure-mode: re-running migrations is idempotent
 *   - Performance: 10k tool_calls insert + p99 query < 100ms (per acceptance §6.5)
 *
 * Note: this is the SQLite path. Postgres parallel tests will follow when
 * we wire the new tables into store-postgres.ts (out of scope for this
 * migration-only test).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations, getCurrentSchemaVersion } from "./migrations.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "zc-mig-s1-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function newDb(): DatabaseSync {
  const db = new DatabaseSync(join(tmpDir, "test.db"));
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

function getTableNames(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>)
    .map(r => r.name);
}

function getViewNames(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='view' ORDER BY name`).all() as Array<{ name: string }>)
    .map(r => r.name);
}

function getIndexNames(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>)
    .map(r => r.name);
}

describe("migrations sprint 1 — tool_calls / outcomes / learnings", () => {
  // ── Unit: schema applies cleanly ────────────────────────────────────────

  it("applies migrations 13/14/15 cleanly on a fresh DB", () => {
    const db = newDb();
    runMigrations(db);
    expect(getCurrentSchemaVersion(db)).toBeGreaterThanOrEqual(15);
    db.close();
  });

  it("creates all 3 new tables", () => {
    const db = newDb();
    runMigrations(db);
    const tables = getTableNames(db);
    expect(tables).toContain("tool_calls");
    expect(tables).toContain("outcomes");
    expect(tables).toContain("learnings");
    db.close();
  });

  it("creates all 5 SQL views (cost roll-ups)", () => {
    const db = newDb();
    runMigrations(db);
    const views = getViewNames(db);
    expect(views).toContain("v_session_cost");
    expect(views).toContain("v_task_cost");
    expect(views).toContain("v_role_cost");
    expect(views).toContain("v_tool_cost");
    expect(views).toContain("v_tool_call_outcomes");
    db.close();
  });

  it("creates all expected indexes", () => {
    const db = newDb();
    runMigrations(db);
    const indexes = getIndexNames(db);
    // tool_calls indexes
    expect(indexes).toContain("idx_tc_session");
    expect(indexes).toContain("idx_tc_task");
    expect(indexes).toContain("idx_tc_skill");
    expect(indexes).toContain("idx_tc_role");
    expect(indexes).toContain("idx_tc_tool_name");
    expect(indexes).toContain("idx_tc_ts");
    expect(indexes).toContain("idx_tc_trace");
    // outcomes indexes
    expect(indexes).toContain("idx_o_ref");
    expect(indexes).toContain("idx_o_kind");
    expect(indexes).toContain("idx_o_resolved");
    // learnings indexes
    expect(indexes).toContain("idx_l_project_cat");
    expect(indexes).toContain("idx_l_category");
    db.close();
  });

  // ── Failure-mode: idempotency ────────────────────────────────────────────

  it("re-running migrations is idempotent (no duplicate / no errors)", () => {
    const db = newDb();
    runMigrations(db);
    const v1 = getCurrentSchemaVersion(db);
    runMigrations(db);  // run again
    const v2 = getCurrentSchemaVersion(db);
    expect(v2).toBe(v1);
    db.close();
  });

  // ── Integration: insert + query ──────────────────────────────────────────

  it("can INSERT and SELECT a tool_calls row", () => {
    const db = newDb();
    runMigrations(db);

    db.prepare(`
      INSERT INTO tool_calls (
        call_id, session_id, agent_id, project_hash,
        tool_name, model, input_tokens, output_tokens,
        cost_usd, latency_ms, ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "call-1", "sess-1", "agent-1", "hash-1",
      "zc_status", "claude-sonnet-4-6", 100, 50,
      0.001, 47, "2026-04-18T13:00:00Z"
    );

    const row = db.prepare(`SELECT * FROM tool_calls WHERE call_id = ?`).get("call-1") as Record<string, unknown>;
    expect(row.session_id).toBe("sess-1");
    expect(row.tool_name).toBe("zc_status");
    expect(row.cost_usd).toBe(0.001);
    expect(row.latency_ms).toBe(47);
    db.close();
  });

  it("can INSERT and SELECT an outcomes row", () => {
    const db = newDb();
    runMigrations(db);

    db.prepare(`
      INSERT INTO outcomes (
        outcome_id, ref_type, ref_id, outcome_kind,
        signal_source, confidence, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "out-1", "tool_call", "call-1", "shipped",
      "git_commit", 0.95, "2026-04-18T13:30:00Z"
    );

    const row = db.prepare(`SELECT * FROM outcomes WHERE outcome_id = ?`).get("out-1") as Record<string, unknown>;
    expect(row.ref_type).toBe("tool_call");
    expect(row.outcome_kind).toBe("shipped");
    expect(row.confidence).toBe(0.95);
    db.close();
  });

  it("can INSERT learnings + dedup via UNIQUE constraint", () => {
    const db = newDb();
    runMigrations(db);

    db.prepare(`
      INSERT INTO learnings (learning_id, project_hash, category, payload, source_path, source_line, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("l-1", "hash-1", "decision", '{"decision":"x"}', "learnings/decisions.jsonl", 1, "2026-04-18T00:00:00Z");

    // Attempting to insert a duplicate (same project_hash + source_path + source_line) should fail
    expect(() => {
      db.prepare(`
        INSERT INTO learnings (learning_id, project_hash, category, payload, source_path, source_line, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("l-2", "hash-1", "decision", '{"different":"y"}', "learnings/decisions.jsonl", 1, "2026-04-18T00:00:01Z");
    }).toThrow(/UNIQUE/);

    // Different source_line is fine
    db.prepare(`
      INSERT INTO learnings (learning_id, project_hash, category, payload, source_path, source_line, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("l-3", "hash-1", "decision", '{"another":"z"}', "learnings/decisions.jsonl", 2, "2026-04-18T00:00:02Z");

    const count = (db.prepare(`SELECT COUNT(*) as n FROM learnings`).get() as { n: number }).n;
    expect(count).toBe(2);
    db.close();
  });

  // ── Integration: views work ──────────────────────────────────────────────

  it("v_session_cost rolls up per (session_id, agent_id)", () => {
    const db = newDb();
    runMigrations(db);

    // Insert 3 calls for 2 sessions
    const insert = db.prepare(`
      INSERT INTO tool_calls (
        call_id, session_id, agent_id, project_hash,
        tool_name, model, input_tokens, output_tokens, cost_usd, latency_ms, ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("c1", "s1", "a1", "p", "t", "m", 100, 50, 0.10, 50, "2026-04-18T01:00:00Z");
    insert.run("c2", "s1", "a1", "p", "t", "m", 200, 80, 0.30, 60, "2026-04-18T02:00:00Z");
    insert.run("c3", "s2", "a1", "p", "t", "m", 50,  20, 0.05, 30, "2026-04-18T03:00:00Z");

    const rows = db.prepare(`SELECT * FROM v_session_cost ORDER BY session_id`).all() as Array<{ session_id: string; calls: number; cost_usd: number }>;
    expect(rows.length).toBe(2);

    const s1 = rows.find(r => r.session_id === "s1")!;
    expect(s1.calls).toBe(2);
    expect(s1.cost_usd).toBeCloseTo(0.40, 5);

    const s2 = rows.find(r => r.session_id === "s2")!;
    expect(s2.calls).toBe(1);
    expect(s2.cost_usd).toBeCloseTo(0.05, 5);
    db.close();
  });

  it("v_tool_call_outcomes joins tool_calls with outcomes via ref_id", () => {
    const db = newDb();
    runMigrations(db);

    db.prepare(`INSERT INTO tool_calls (call_id, session_id, agent_id, project_hash, tool_name, model, input_tokens, output_tokens, cost_usd, latency_ms, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "c1", "s1", "a1", "p", "Read", "m", 100, 50, 0.10, 50, "2026-04-18T01:00:00Z"
    );
    db.prepare(`INSERT INTO outcomes (outcome_id, ref_type, ref_id, outcome_kind, signal_source, confidence, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "o1", "tool_call", "c1", "insufficient", "follow_up", 0.85, "2026-04-18T01:00:30Z"
    );

    const row = db.prepare(`SELECT * FROM v_tool_call_outcomes WHERE call_id = ?`).get("c1") as Record<string, unknown>;
    expect(row.outcome_kind).toBe("insufficient");
    expect(row.tool_name).toBe("Read");
    expect(row.confidence).toBe(0.85);
    db.close();
  });

  // ── Performance: 10k inserts + query latency ────────────────────────────

  it("[PERF] inserts 10,000 tool_calls quickly + p99 query < 100ms", () => {
    const db = newDb();
    runMigrations(db);

    const t0 = Date.now();
    db.exec("BEGIN");
    const insert = db.prepare(`
      INSERT INTO tool_calls (
        call_id, session_id, agent_id, project_hash,
        tool_name, model, input_tokens, output_tokens, cost_usd, latency_ms, ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < 10000; i++) {
      insert.run(
        `call-${i}`,
        `sess-${i % 50}`,
        `agent-${i % 5}`,
        "hash-perf",
        i % 2 === 0 ? "Read" : "zc_file_summary",
        i % 2 === 0 ? "claude-opus-4-7" : "claude-sonnet-4-6",
        100 + (i % 100),
        50 + (i % 50),
        0.001 * (i % 100),
        20 + (i % 200),
        new Date(Date.now() + i * 1000).toISOString()
      );
    }
    db.exec("COMMIT");
    const insertMs = Date.now() - t0;
    // 10k inserts in < 5 seconds (very loose budget)
    expect(insertMs).toBeLessThan(5000);

    // Common query: per-session cost
    const queries: number[] = [];
    for (let i = 0; i < 50; i++) {
      const tq0 = Date.now();
      db.prepare(`SELECT * FROM v_session_cost WHERE session_id = ?`).all(`sess-${i}`);
      queries.push(Date.now() - tq0);
    }
    queries.sort((a, b) => a - b);
    const p99 = queries[Math.floor(queries.length * 0.99)] || queries[queries.length - 1];
    expect(p99).toBeLessThan(100);  // p99 < 100ms per acceptance criteria

    db.close();
  });
});
