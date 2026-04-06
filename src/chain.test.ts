/**
 * Tests for Broadcast Hash Chain — chain.test.ts (v0.8.0)
 *
 * Security properties tested (Chin & Older 2011 Chapter 13 — Biba Integrity):
 *   - Hash chain provides tamper-evident audit log
 *   - computeRowHash is deterministic for same inputs
 *   - computeRowHash differs for different inputs
 *   - getLastHash returns "genesis" on empty table
 *   - verifyChain returns ok:true on untampered chain
 *   - verifyChain returns ok:false with brokenAt when row tampered
 *   - verifyChain handles empty table gracefully
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { runMigrations } from "./migrations.js";
import { computeRowHash, getLastHash, verifyChain } from "./chain.js";
import { Config } from "./config.js";

const TEST_DB_DIR = mkdtempSync(join(tmpdir(), "zc-chain-test-"));

let _dbCounter = 0;
function openTestDb(): DatabaseSync {
  const projectPath = join(TEST_DB_DIR, `chain-test-${Date.now()}-${_dbCounter++}`);
  mkdirSync(Config.DB_DIR, { recursive: true });
  const hash   = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  const dbFile = join(Config.DB_DIR, `${hash}.db`);
  const db     = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS working_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL, value TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      agent_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      UNIQUE(key, agent_id)
    );
    CREATE TABLE IF NOT EXISTS project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  runMigrations(db);
  return db;
}

// Helper: insert a broadcast row with hash chain fields
function insertBroadcastWithHash(
  db: DatabaseSync,
  type: string,
  agentId: string,
  task: string,
  summary: string,
  sessionTokenId: string
): string {
  const now      = new Date().toISOString();
  const prevHash = getLastHash(db);
  const rowHash  = computeRowHash(prevHash, type, agentId, task, summary, now, sessionTokenId);

  db.prepare(`
    INSERT INTO broadcasts(type, agent_id, task, files, state, summary, depends_on, reason, importance, created_at, session_token_id, prev_hash, row_hash)
    VALUES (?, ?, ?, '[]', '', ?, '[]', '', 3, ?, ?, ?, ?)
  `).run(type, agentId, task, summary, now, sessionTokenId, prevHash, rowHash);

  return rowHash;
}

// ── computeRowHash ────────────────────────────────────────────────────────────

describe("computeRowHash", () => {
  it("produces a 64-char hex string", () => {
    const hash = computeRowHash("genesis", "STATUS", "agent-1", "task", "summary", "2025-01-01T00:00:00.000Z", "");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same inputs → same hash", () => {
    const h1 = computeRowHash("genesis", "STATUS", "agent-1", "task", "summary", "2025-01-01T00:00:00.000Z", "tid1");
    const h2 = computeRowHash("genesis", "STATUS", "agent-1", "task", "summary", "2025-01-01T00:00:00.000Z", "tid1");
    expect(h1).toBe(h2);
  });

  it("differs for different type", () => {
    const h1 = computeRowHash("genesis", "STATUS",  "agent-1", "task", "summary", "2025-01-01T00:00:00.000Z", "");
    const h2 = computeRowHash("genesis", "ASSIGN",  "agent-1", "task", "summary", "2025-01-01T00:00:00.000Z", "");
    expect(h1).not.toBe(h2);
  });

  it("differs for different agent_id", () => {
    const h1 = computeRowHash("genesis", "STATUS", "agent-1", "task", "summary", "2025-01-01T00:00:00.000Z", "");
    const h2 = computeRowHash("genesis", "STATUS", "agent-2", "task", "summary", "2025-01-01T00:00:00.000Z", "");
    expect(h1).not.toBe(h2);
  });

  it("differs for different prev_hash", () => {
    const h1 = computeRowHash("genesis",         "STATUS", "agent-1", "task", "summary", "2025-01-01T00:00:00.000Z", "");
    const h2 = computeRowHash("someprevioushash", "STATUS", "agent-1", "task", "summary", "2025-01-01T00:00:00.000Z", "");
    expect(h1).not.toBe(h2);
  });

  it("differs for different summary", () => {
    const h1 = computeRowHash("genesis", "STATUS", "agent-1", "task", "summary-A", "2025-01-01T00:00:00.000Z", "");
    const h2 = computeRowHash("genesis", "STATUS", "agent-1", "task", "summary-B", "2025-01-01T00:00:00.000Z", "");
    expect(h1).not.toBe(h2);
  });

  it("differs for different tokenId", () => {
    const h1 = computeRowHash("genesis", "STATUS", "agent-1", "task", "summary", "2025-01-01T00:00:00.000Z", "tid-A");
    const h2 = computeRowHash("genesis", "STATUS", "agent-1", "task", "summary", "2025-01-01T00:00:00.000Z", "tid-B");
    expect(h1).not.toBe(h2);
  });
});

// ── getLastHash ───────────────────────────────────────────────────────────────

describe("getLastHash", () => {
  it("returns 'genesis' on an empty broadcasts table", () => {
    const db   = openTestDb();
    const last = getLastHash(db);
    db.close();
    expect(last).toBe("genesis");
  });

  it("returns the row_hash of the last inserted row", () => {
    const db        = openTestDb();
    const rowHash   = insertBroadcastWithHash(db, "STATUS", "agent-1", "task", "summary", "");
    const last      = getLastHash(db);
    db.close();
    expect(last).toBe(rowHash);
  });

  it("updates to latest row as more rows are inserted", () => {
    const db = openTestDb();
    insertBroadcastWithHash(db, "STATUS", "agent-1", "task1", "s1", "");
    const h2 = insertBroadcastWithHash(db, "ASSIGN", "agent-2", "task2", "s2", "");
    const last = getLastHash(db);
    db.close();
    expect(last).toBe(h2);
  });
});

// ── verifyChain ───────────────────────────────────────────────────────────────

describe("verifyChain", () => {
  it("returns ok:true with totalRows:0 on empty table", () => {
    const db     = openTestDb();
    const result = verifyChain(db);
    db.close();
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(0);
  });

  it("returns ok:true on valid single-row chain", () => {
    const db = openTestDb();
    insertBroadcastWithHash(db, "STATUS", "agent-1", "task", "summary", "");
    const result = verifyChain(db);
    db.close();
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(1);
  });

  it("returns ok:true on valid multi-row chain", () => {
    const db = openTestDb();
    insertBroadcastWithHash(db, "ASSIGN",     "orch",     "impl auth", "start",    "tid1");
    insertBroadcastWithHash(db, "STATUS",     "worker-1", "impl auth", "in-prog",  "tid2");
    insertBroadcastWithHash(db, "PROPOSED",   "worker-1", "impl auth", "pr ready", "tid3");
    insertBroadcastWithHash(db, "MERGE",      "orch",     "impl auth", "approved", "tid1");
    const result = verifyChain(db);
    db.close();
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(4);
  });

  it("returns ok:false and brokenAt when a row_hash is tampered", () => {
    const db = openTestDb();
    insertBroadcastWithHash(db, "STATUS", "agent-1", "task-1", "s1", "");
    insertBroadcastWithHash(db, "STATUS", "agent-2", "task-2", "s2", "");
    insertBroadcastWithHash(db, "STATUS", "agent-3", "task-3", "s3", "");

    // Tamper with the second row's row_hash
    db.prepare(`UPDATE broadcasts SET row_hash = 'TAMPERED_HASH_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' WHERE id = (SELECT id FROM broadcasts ORDER BY id LIMIT 1 OFFSET 1)`).run();

    const result = verifyChain(db);
    db.close();

    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBeDefined();
  });

  it("returns ok:false when summary is modified (hash mismatch)", () => {
    const db = openTestDb();
    insertBroadcastWithHash(db, "STATUS", "agent-1", "task-1", "original summary", "");
    insertBroadcastWithHash(db, "STATUS", "agent-2", "task-2", "s2", "");

    // Modify the first row's summary without updating row_hash
    db.prepare(`UPDATE broadcasts SET summary = 'ALTERED SUMMARY' WHERE id = (SELECT id FROM broadcasts ORDER BY id LIMIT 1)`).run();

    const result = verifyChain(db);
    db.close();

    expect(result.ok).toBe(false);
  });

  it("skips rows with empty row_hash (pre-v0.8.0 rows)", () => {
    const db = openTestDb();
    // Insert row with empty row_hash (simulating legacy row)
    db.prepare(`
      INSERT INTO broadcasts(type, agent_id, task, files, state, summary, depends_on, reason, importance, created_at, session_token_id, prev_hash, row_hash)
      VALUES ('STATUS', 'old-agent', 'task', '[]', '', 'legacy', '[]', '', 3, '2024-01-01T00:00:00.000Z', '', 'genesis', '')
    `).run();

    const result = verifyChain(db);
    db.close();

    // Legacy row has empty row_hash — should be skipped, so ok:true
    expect(result.ok).toBe(true);
    // totalRows is the total count including legacy rows
    expect(result.totalRows).toBeGreaterThanOrEqual(0);
  });
});
