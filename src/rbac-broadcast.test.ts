/**
 * Tests for RBAC enforcement in broadcastFact (v0.9.0 — default-on)
 * rbac-broadcast.test.ts
 *
 * v0.9.0 REMOVES "open mode" (no sessions = no RBAC). Enforcement is always on
 * unless the operator sets ZC_RBAC_ENFORCE=0 — that opt-out path is covered in
 * security-tests/run-all.mjs (Category 9) with a spawned child process.
 *
 * Tests here:
 *   - RBAC is always enforced: no session_token → reject
 *   - Orchestrator token can ASSIGN
 *   - Worker role cannot ASSIGN
 *   - Agent_id binding: broadcast agent_id must match token's bound aid (v0.9.0 new)
 *   - Invalid / expired / revoked tokens rejected
 *   - Hash chain: sequential broadcasts form valid chain
 *   - Hash chain: manual DB row modification breaks chain
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

// vi.hoisted runs BEFORE any import is evaluated. This is the only reliable way
// to set env vars that must be in place when config.ts's module-level snapshot
// runs. These are RBAC-focused tests — channel-key enforcement is exercised
// separately in security-tests/run-all.mjs (Category 9) via a spawned process.
const { TEST_DB_DIR } = vi.hoisted(() => {
  // node: specifiers are resolvable by require inside a hoisted block
  const { mkdtempSync: mk } = require("node:fs");
  const { tmpdir: td }      = require("node:os");
  const { join: jn }        = require("node:path");
  const dir = mk(jn(td(), "zc-rbac-bc-test-"));
  process.env["ZC_TEST_DB_DIR"] = dir;
  process.env["ZC_CHANNEL_KEY_REQUIRED"] = "0";
  return { TEST_DB_DIR: dir };
});

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

// ── v0.9.0: RBAC is always enforced (no "open mode") ─────────────────────────

describe("RBAC default-on — enforcement cannot be bypassed by not registering sessions", () => {
  it("broadcast without session_token is rejected even on a fresh project", () => {
    const projectPath = makeProjectPath(`no-token-${Date.now()}`);
    // No issueToken call — the old open-mode shortcut is gone in v0.9.0
    expect(() => broadcastFact(projectPath, "STATUS", "agent-legacy", {
      summary: "would have worked in v0.8.0",
    })).toThrow(/session_token is required/i);
  });

  it("broadcast with channel_key but no session_token is still rejected", () => {
    const projectPath = makeProjectPath(`ck-no-token-${Date.now()}`);
    setChannelKey(projectPath, "testchannelkey1234567890");
    expect(() => broadcastFact(projectPath, "STATUS", "agent-ck", {
      summary:     "channel key alone is not enough anymore",
      channel_key: "testchannelkey1234567890",
    })).toThrow(/session_token is required/i);
  });
});

// ── RBAC enforcement (positive + RBAC-type rejection) ───────────────────────

describe("RBAC enforcement — role-permission matrix", () => {
  it("requires session_token (error message)", () => {
    const projectPath = makeProjectPath(`rbac-required-${Date.now()}`);
    const db = openProjectDb(projectPath);
    issueToken(db, projectPath, "orch-1", "orchestrator");
    db.close();

    expect(() => broadcastFact(projectPath, "STATUS", "orch-1", {
      summary: "no token",
    })).toThrow(/session_token is required/i);
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
    })).toThrow(/is not permitted to broadcast type/i);
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
    })).toThrow(/invalid, expired, revoked/i);
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
    })).toThrow(/invalid, expired, revoked/i);
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
    })).toThrow(/invalid, expired, revoked/i);
  });
});

// ── v0.9.0: agent_id binding (capability confinement) ───────────────────────

describe("agent_id binding — a token is scoped to one agent", () => {
  it("rejects broadcast when agent_id does not match token's bound aid", () => {
    const projectPath = makeProjectPath(`agentid-mismatch-${Date.now()}`);
    const db = openProjectDb(projectPath);
    const workerToken = issueToken(db, projectPath, "developer-1", "developer");
    db.close();

    // developer-1's token used to post as orchestrator — the spoofing attempt
    // the v0.9.0 binding closes. Role is still developer so STATUS would be
    // allowed by the matrix, but the agent_id swap is caught first.
    expect(() => broadcastFact(projectPath, "STATUS", "orchestrator", {
      summary:       "spoofing orchestrator",
      session_token: workerToken,
    })).toThrow(/AGENT_ID_MISMATCH/);
  });

  it("rejects broadcast when agent_id is another worker's name (lateral spoofing)", () => {
    const projectPath = makeProjectPath(`agentid-lateral-${Date.now()}`);
    const db = openProjectDb(projectPath);
    const workerToken = issueToken(db, projectPath, "developer-1", "developer");
    issueToken(db, projectPath, "developer-2", "developer");
    db.close();

    expect(() => broadcastFact(projectPath, "STATUS", "developer-2", {
      summary:       "developer-1 posing as developer-2",
      session_token: workerToken,
    })).toThrow(/AGENT_ID_MISMATCH/);
  });

  it("accepts broadcast when agent_id matches token's bound aid", () => {
    const projectPath = makeProjectPath(`agentid-match-${Date.now()}`);
    const db = openProjectDb(projectPath);
    const token = issueToken(db, projectPath, "developer-1", "developer");
    db.close();

    const msg = broadcastFact(projectPath, "STATUS", "developer-1", {
      summary:       "legitimate self-identification",
      session_token: token,
    });
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.agent_id).toBe("developer-1");
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
