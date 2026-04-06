/**
 * Tests for RBAC enforcement in broadcastFact (v0.8.0)
 * rbac-broadcast.test.ts
 *
 * Tests:
 *   - Backward compat: no sessions → no RBAC enforcement
 *   - With sessions: session_token required
 *   - Orchestrator token can ASSIGN
 *   - Developer token cannot ASSIGN (RBAC violation)
 *   - Expired token rejected
 *   - Revoked token rejected
 *   - Hash chain: sequential broadcasts form valid chain
 *   - Hash chain: manual DB row modification breaks chain
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

// Unique DB dir per suite
const TEST_DB_DIR = mkdtempSync(join(tmpdir(), "zc-rbac-bc-test-"));

// Important: set env BEFORE importing config/memory modules
process.env["ZC_TEST_DB_DIR"] = TEST_DB_DIR;

import { broadcastFact, getBroadcastChainStatus, setChannelKey } from "./memory.js";
import { issueToken, revokeToken } from "./access-control.js";
import { verifyChain } from "./chain.js";
import { runMigrations } from "./migrations.js";
import { Config } from "./config.js";

function makeProjectPath(suffix: string): string {
  return join(TEST_DB_DIR, `rbac-bc-${suffix}`);
}

function openProjectDb(projectPath: string): DatabaseSync {
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

// ── Backward compatibility (no sessions → no RBAC) ───────────────────────────

describe("backward compatibility — no sessions registered", () => {
  it("broadcastFact succeeds without session_token when no sessions exist", () => {
    const projectPath = makeProjectPath(`open-${Date.now()}`);
    // No issueToken called — no sessions in DB
    const msg = broadcastFact(projectPath, "STATUS", "agent-legacy", {
      task:    "legacy task",
      summary: "working as before",
    });
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.type).toBe("STATUS");
  });

  it("broadcastFact with channel_key only (existing behavior) still works", () => {
    const projectPath = makeProjectPath(`ck-only-${Date.now()}`);
    // Set channel key — no RBAC sessions
    setChannelKey(projectPath, "testchannelkey1234567890");

    const msg = broadcastFact(projectPath, "STATUS", "agent-ck", {
      summary:     "channel key only",
      channel_key: "testchannelkey1234567890",
    });
    expect(msg.id).toBeGreaterThan(0);
  });
});

// ── RBAC enforcement (sessions registered) ───────────────────────────────────

describe("RBAC enforcement — sessions registered", () => {
  it("requires session_token when sessions are active", () => {
    const projectPath = makeProjectPath(`rbac-active-${Date.now()}`);
    const db = openProjectDb(projectPath);
    issueToken(db, projectPath, "orch-1", "orchestrator");
    db.close();

    // No session_token supplied — should throw
    expect(() => broadcastFact(projectPath, "STATUS", "some-agent", {
      summary: "no token",
    })).toThrow(/session_token required/i);
  });

  it("orchestrator token can broadcast ASSIGN", () => {
    const projectPath = makeProjectPath(`orch-assign-${Date.now()}`);
    const db = openProjectDb(projectPath);
    const token = issueToken(db, projectPath, "orchestrator-1", "orchestrator");
    db.close();

    const msg = broadcastFact(projectPath, "ASSIGN", "orchestrator-1", {
      task:          "implement feature",
      summary:       "please build the auth module",
      session_token: token,
    });
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.type).toBe("ASSIGN");
  });

  it("developer token cannot broadcast ASSIGN (RBAC violation)", () => {
    const projectPath = makeProjectPath(`dev-no-assign-${Date.now()}`);
    const db = openProjectDb(projectPath);
    const token = issueToken(db, projectPath, "developer-1", "developer");
    db.close();

    expect(() => broadcastFact(projectPath, "ASSIGN", "developer-1", {
      task:          "trying to assign",
      summary:       "I am not allowed",
      session_token: token,
    })).toThrow(/RBAC violation/i);
  });

  it("developer token can broadcast STATUS", () => {
    const projectPath = makeProjectPath(`dev-status-${Date.now()}`);
    const db = openProjectDb(projectPath);
    const token = issueToken(db, projectPath, "developer-1", "developer");
    db.close();

    const msg = broadcastFact(projectPath, "STATUS", "developer-1", {
      summary:       "in progress",
      session_token: token,
    });
    expect(msg.id).toBeGreaterThan(0);
  });

  it("developer token can broadcast MERGE", () => {
    const projectPath = makeProjectPath(`dev-merge-${Date.now()}`);
    const db = openProjectDb(projectPath);
    const token = issueToken(db, projectPath, "developer-1", "developer");
    db.close();

    const msg = broadcastFact(projectPath, "MERGE", "developer-1", {
      summary:       "changes approved",
      session_token: token,
    });
    expect(msg.id).toBeGreaterThan(0);
  });

  it("invalid session_token is rejected", () => {
    const projectPath = makeProjectPath(`invalid-token-${Date.now()}`);
    const db = openProjectDb(projectPath);
    issueToken(db, projectPath, "orch", "orchestrator");
    db.close();

    expect(() => broadcastFact(projectPath, "STATUS", "some-agent", {
      summary:       "trying with bad token",
      session_token: "zcst.FAKE.FAKEHMAC",
    })).toThrow(/invalid.*expired.*revoked/i);
  });

  it("expired token is rejected (with a still-active orchestrator session keeping RBAC alive)", () => {
    const projectPath = makeProjectPath(`expired-token-${Date.now()}`);
    const db = openProjectDb(projectPath);

    // Keep an active orchestrator session so RBAC remains enforced
    issueToken(db, projectPath, "orch-active", "orchestrator");

    // Issue and expire a worker token
    const token = issueToken(db, projectPath, "agent-exp", "worker", 100);
    const [, p64] = token.split(".");
    const payload = JSON.parse(Buffer.from(p64!, "base64url").toString());
    db.prepare("UPDATE agent_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_id = ?").run(payload.tid);
    db.close();

    // The expired token should be rejected — RBAC is active because orchestrator session exists
    expect(() => broadcastFact(projectPath, "STATUS", "agent-exp", {
      summary:       "expired",
      session_token: token,
    })).toThrow(/invalid.*expired.*revoked/i);
  });

  it("revoked token is rejected (with a still-active orchestrator session keeping RBAC alive)", () => {
    const projectPath = makeProjectPath(`revoked-token-${Date.now()}`);
    const db = openProjectDb(projectPath);

    // Keep an active orchestrator session so RBAC remains enforced
    issueToken(db, projectPath, "orch-active-2", "orchestrator");

    // Issue and revoke a worker token
    const token = issueToken(db, projectPath, "agent-rev", "worker");
    const [, p64] = token.split(".");
    const payload = JSON.parse(Buffer.from(p64!, "base64url").toString());
    revokeToken(db, payload.tid);
    db.close();

    // The revoked token should be rejected — RBAC is active because orchestrator session exists
    expect(() => broadcastFact(projectPath, "STATUS", "agent-rev", {
      summary:       "revoked",
      session_token: token,
    })).toThrow(/invalid.*expired.*revoked/i);
  });
});

// ── Hash chain integrity ──────────────────────────────────────────────────────

describe("hash chain integrity", () => {
  it("sequential broadcasts form a valid chain", () => {
    const projectPath = makeProjectPath(`chain-valid-${Date.now()}`);
    const db = openProjectDb(projectPath);
    const token = issueToken(db, projectPath, "orch", "orchestrator");
    db.close();

    broadcastFact(projectPath, "ASSIGN",  "orch",     { task: "t1", summary: "do this",  session_token: token });
    broadcastFact(projectPath, "STATUS",  "orch",     { task: "t1", summary: "working",   session_token: token });
    broadcastFact(projectPath, "MERGE",   "orch",     { task: "t1", summary: "done",      session_token: token });

    const status = getBroadcastChainStatus(projectPath);
    expect(status.ok).toBe(true);
    expect(status.totalRows).toBeGreaterThanOrEqual(3);
  });

  it("manual DB row modification breaks the chain", () => {
    const projectPath = makeProjectPath(`chain-tamper-${Date.now()}`);
    const db = openProjectDb(projectPath);
    const token = issueToken(db, projectPath, "orch", "orchestrator");
    db.close();

    broadcastFact(projectPath, "ASSIGN", "orch", { task: "t2", summary: "original",   session_token: token });
    broadcastFact(projectPath, "STATUS", "orch", { task: "t2", summary: "continuing", session_token: token });

    // Tamper with first row
    const hash2    = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
    const dbFile2  = join(Config.DB_DIR, `${hash2}.db`);
    const tamperDb = new DatabaseSync(dbFile2);
    tamperDb.prepare("UPDATE broadcasts SET summary = 'TAMPERED' WHERE id = (SELECT id FROM broadcasts ORDER BY id LIMIT 1)").run();
    tamperDb.close();

    const status = getBroadcastChainStatus(projectPath);
    expect(status.ok).toBe(false);
    expect(status.brokenAt).toBeDefined();
  });
});
