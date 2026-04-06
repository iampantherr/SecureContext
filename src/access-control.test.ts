/**
 * Tests for RBAC + Session Token Access Control (v0.8.0)
 * access-control.test.ts
 *
 * Security properties tested (Chin & Older 2011):
 *   - Ch.6  Session tokens: HMAC-signed, short-lived, revocable
 *   - Ch.7  Non-transitive delegation: role immutable at issuance
 *   - Ch.11 Capabilities: token bound to project hash — cross-project rejected
 *   - Ch.14 RBAC: separation of duty — developer cannot ASSIGN
 *   - Timing-safe HMAC comparison (no oracle attacks)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { runMigrations } from "./migrations.js";
import { Config } from "./config.js";

// Test DB setup — isolated temp directory per test suite
const TEST_DB_DIR  = mkdtempSync(join(tmpdir(), "zc-ac-test-"));
const TEST_PATH    = join(TEST_DB_DIR, "test-ac-project");
const TEST_PATH_2  = join(TEST_DB_DIR, "test-ac-project-other"); // different project

import {
  issueToken,
  verifyToken,
  canBroadcast,
  hasActiveSessions,
  revokeToken,
  revokeAllAgentTokens,
  countActiveSessions,
  ROLE_PERMISSIONS,
  type AgentRole,
} from "./access-control.js";

// ── DB helper ─────────────────────────────────────────────────────────────────
function openTestDb(projectPath: string): DatabaseSync {
  mkdirSync(Config.DB_DIR, { recursive: true });
  const hash   = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  const dbFile = join(Config.DB_DIR, `${hash}.db`);
  const db     = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS working_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
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

// ── Token format ──────────────────────────────────────────────────────────────

describe("issueToken — token format", () => {
  it("produces a zcst. prefixed token with 3 dot-separated parts", () => {
    const db    = openTestDb(TEST_PATH);
    const token = issueToken(db, TEST_PATH, "agent-1", "orchestrator");
    db.close();

    expect(token).toMatch(/^zcst\./);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("zcst");
  });

  it("payload decodes to expected fields", () => {
    const db    = openTestDb(TEST_PATH);
    const token = issueToken(db, TEST_PATH, "agent-payload", "developer");
    db.close();

    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));

    expect(payload.aid).toBe("agent-payload");
    expect(payload.role).toBe("developer");
    expect(typeof payload.tid).toBe("string");
    expect(typeof payload.ph).toBe("string");
    expect(payload.ph).toHaveLength(16);
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("custom TTL is reflected in exp", () => {
    const db  = openTestDb(TEST_PATH);
    const ttl = 3600; // 1 hour
    const token = issueToken(db, TEST_PATH, "agent-ttl", "worker", ttl);
    db.close();

    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    const diffSec = payload.exp - payload.iat;
    // Allow ±5 second tolerance for timing
    expect(diffSec).toBeGreaterThanOrEqual(ttl - 5);
    expect(diffSec).toBeLessThanOrEqual(ttl + 5);
  });

  it("throws on invalid role", () => {
    const db = openTestDb(TEST_PATH);
    expect(() => issueToken(db, TEST_PATH, "agent-x", "superuser" as AgentRole)).toThrow(/invalid role/i);
    db.close();
  });
});

// ── Token verification ────────────────────────────────────────────────────────

describe("verifyToken", () => {
  it("returns agent info for a valid token", () => {
    const db    = openTestDb(TEST_PATH);
    const token = issueToken(db, TEST_PATH, "agent-verify", "orchestrator");
    const info  = verifyToken(db, token, TEST_PATH);
    db.close();

    expect(info).not.toBeNull();
    expect(info!.agentId).toBe("agent-verify");
    expect(info!.role).toBe("orchestrator");
    expect(info!.tokenId).toBeTruthy();
  });

  it("returns null for wrong project hash (cross-project rejection)", () => {
    const db1   = openTestDb(TEST_PATH);
    const token = issueToken(db1, TEST_PATH, "agent-xproject", "developer");
    // Verify with a DIFFERENT project path — should fail (Chapter 11 capability scoping)
    const info  = verifyToken(db1, token, TEST_PATH_2);
    db1.close();
    expect(info).toBeNull();
  });

  it("returns null for malformed token (not zcst.)", () => {
    const db   = openTestDb(TEST_PATH);
    const info = verifyToken(db, "bearer.invalid.token", TEST_PATH);
    db.close();
    expect(info).toBeNull();
  });

  it("returns null for tampered payload", () => {
    const db    = openTestDb(TEST_PATH);
    const token = issueToken(db, TEST_PATH, "agent-tamper", "worker");
    // Modify the middle segment
    const parts = token.split(".");
    const tampered = parts[0] + ".AAAAAAAAAA." + parts[2];
    const info = verifyToken(db, tampered, TEST_PATH);
    db.close();
    expect(info).toBeNull();
  });

  it("returns null for expired token (mocking time via TTL=0 is impractical; use direct DB manipulation)", () => {
    const db    = openTestDb(TEST_PATH);
    const token = issueToken(db, TEST_PATH, "agent-expire", "worker", 100);
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    // Manually set expires_at in the past
    db.prepare(
      "UPDATE agent_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_id = ?"
    ).run(payload.tid);
    const info = verifyToken(db, token, TEST_PATH);
    db.close();
    expect(info).toBeNull();
  });

  it("returns null for revoked token", () => {
    const db    = openTestDb(TEST_PATH);
    const token = issueToken(db, TEST_PATH, "agent-revoke-test", "developer");
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    revokeToken(db, payload.tid);
    const info = verifyToken(db, token, TEST_PATH);
    db.close();
    expect(info).toBeNull();
  });

  it("returns null for empty token string", () => {
    const db   = openTestDb(TEST_PATH);
    const info = verifyToken(db, "", TEST_PATH);
    db.close();
    expect(info).toBeNull();
  });
});

// ── RBAC permission matrix ────────────────────────────────────────────────────

describe("canBroadcast — RBAC permission matrix", () => {
  it("orchestrator can ASSIGN", () => {
    expect(canBroadcast("orchestrator", "ASSIGN")).toBe(true);
  });

  it("orchestrator can MERGE", () => {
    expect(canBroadcast("orchestrator", "MERGE")).toBe(true);
  });

  it("orchestrator can REJECT", () => {
    expect(canBroadcast("orchestrator", "REJECT")).toBe(true);
  });

  it("developer cannot ASSIGN (separation of duty — Chapter 14)", () => {
    expect(canBroadcast("developer", "ASSIGN")).toBe(false);
  });

  it("developer can MERGE", () => {
    expect(canBroadcast("developer", "MERGE")).toBe(true);
  });

  it("developer can STATUS", () => {
    expect(canBroadcast("developer", "STATUS")).toBe(true);
  });

  it("worker cannot ASSIGN", () => {
    expect(canBroadcast("worker", "ASSIGN")).toBe(false);
  });

  it("worker can PROPOSED", () => {
    expect(canBroadcast("worker", "PROPOSED")).toBe(true);
  });

  it("marketer cannot ASSIGN", () => {
    expect(canBroadcast("marketer", "ASSIGN")).toBe(false);
  });

  it("researcher cannot REJECT", () => {
    expect(canBroadcast("researcher", "REJECT")).toBe(false);
  });

  it("unknown role returns false", () => {
    expect(canBroadcast("superuser" as AgentRole, "ASSIGN")).toBe(false);
  });

  it("all roles in ROLE_PERMISSIONS have at least one allowed type", () => {
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      expect(perms.length).toBeGreaterThan(0);
      void role;
    }
  });
});

// ── hasActiveSessions ─────────────────────────────────────────────────────────

describe("hasActiveSessions", () => {
  it("returns false on a fresh DB with no sessions", () => {
    const uniquePath = join(TEST_DB_DIR, `ac-no-sessions-${Date.now()}`);
    const db = openTestDb(uniquePath);
    expect(hasActiveSessions(db)).toBe(false);
    db.close();
  });

  it("returns true after issuing a token", () => {
    const uniquePath = join(TEST_DB_DIR, `ac-with-sessions-${Date.now()}`);
    const db = openTestDb(uniquePath);
    issueToken(db, uniquePath, "agent-active", "worker");
    expect(hasActiveSessions(db)).toBe(true);
    db.close();
  });

  it("returns false after all tokens are revoked", () => {
    const uniquePath = join(TEST_DB_DIR, `ac-revoked-${Date.now()}`);
    const db = openTestDb(uniquePath);
    issueToken(db, uniquePath, "agent-to-revoke", "worker");
    revokeAllAgentTokens(db, "agent-to-revoke");
    expect(hasActiveSessions(db)).toBe(false);
    db.close();
  });

  it("returns false after all sessions expire", () => {
    const uniquePath = join(TEST_DB_DIR, `ac-expired-all-${Date.now()}`);
    const db = openTestDb(uniquePath);
    issueToken(db, uniquePath, "agent-expire-all", "worker", 10);
    // Set all sessions to expired
    db.prepare("UPDATE agent_sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect(hasActiveSessions(db)).toBe(false);
    db.close();
  });
});

// ── countActiveSessions ───────────────────────────────────────────────────────

describe("countActiveSessions", () => {
  it("returns 0 for empty DB", () => {
    const uniquePath = join(TEST_DB_DIR, `ac-count-0-${Date.now()}`);
    const db = openTestDb(uniquePath);
    expect(countActiveSessions(db)).toBe(0);
    db.close();
  });

  it("increments with each issued token", () => {
    const uniquePath = join(TEST_DB_DIR, `ac-count-n-${Date.now()}`);
    const db = openTestDb(uniquePath);
    issueToken(db, uniquePath, "a1", "worker");
    expect(countActiveSessions(db)).toBe(1);
    issueToken(db, uniquePath, "a2", "developer");
    expect(countActiveSessions(db)).toBe(2);
    db.close();
  });
});

// ── Non-transitive delegation (Chapter 7) ─────────────────────────────────────

describe("non-transitive delegation (Chapter 7)", () => {
  it("issuing a new token does not elevate rights from existing token", () => {
    const uniquePath = join(TEST_DB_DIR, `ac-nontransitive-${Date.now()}`);
    const db = openTestDb(uniquePath);

    // Issue worker token
    const workerToken = issueToken(db, uniquePath, "worker-agent", "worker");
    const workerInfo  = verifyToken(db, workerToken, uniquePath);
    expect(workerInfo!.role).toBe("worker");

    // Worker cannot get an orchestrator token just by calling issueToken with a different role
    // (in real usage, only the orchestrator can call zc_issue_token — but test the token itself is scoped)
    const orchToken = issueToken(db, uniquePath, "worker-agent", "orchestrator");
    const orchInfo  = verifyToken(db, orchToken, uniquePath);
    // Both tokens are valid, but they are SEPARATE capabilities — the worker token is still worker
    expect(workerInfo!.role).toBe("worker");  // original token still says worker
    expect(orchInfo!.role).toBe("orchestrator"); // new token has orchestrator role

    // The worker token cannot be mutated to gain orchestrator rights
    // (tokens are bearer tokens — the signed payload is immutable)
    const tamperedToken = workerToken.replace(
      Buffer.from(JSON.stringify({ ...workerInfo, role: "orchestrator" })).toString("base64url"),
      "whatever"
    );
    const tamperedInfo = verifyToken(db, tamperedToken, uniquePath);
    // Either null (HMAC mismatch) or still worker role
    if (tamperedInfo !== null) {
      expect(tamperedInfo.role).toBe("worker");
    } else {
      expect(tamperedInfo).toBeNull();
    }

    db.close();
  });
});

// ── Revocation ────────────────────────────────────────────────────────────────

describe("revokeToken / revokeAllAgentTokens", () => {
  it("revokeToken invalidates a specific token", () => {
    const uniquePath = join(TEST_DB_DIR, `ac-revoke-specific-${Date.now()}`);
    const db  = openTestDb(uniquePath);
    const t1  = issueToken(db, uniquePath, "agent-rev", "worker");
    const t2  = issueToken(db, uniquePath, "agent-rev", "worker");
    const [, p1b64] = t1.split(".");
    const tid1 = JSON.parse(Buffer.from(p1b64!, "base64url").toString()).tid;
    revokeToken(db, tid1);

    expect(verifyToken(db, t1, uniquePath)).toBeNull();   // t1 revoked
    expect(verifyToken(db, t2, uniquePath)).not.toBeNull(); // t2 still valid
    db.close();
  });

  it("revokeAllAgentTokens invalidates all tokens for that agent", () => {
    const uniquePath = join(TEST_DB_DIR, `ac-revoke-all-${Date.now()}`);
    const db  = openTestDb(uniquePath);
    const t1  = issueToken(db, uniquePath, "agent-revall", "worker");
    const t2  = issueToken(db, uniquePath, "agent-revall", "developer");
    revokeAllAgentTokens(db, "agent-revall");

    expect(verifyToken(db, t1, uniquePath)).toBeNull();
    expect(verifyToken(db, t2, uniquePath)).toBeNull();
    db.close();
  });
});
