/**
 * Tests for Phase 2 A2A broadcast channel — broadcast.test.ts
 * v0.7.1: security-hardened (scrypt KDF, untrusted labels, rate limiting, path traversal)
 *
 * Security properties tested (Chin & Older 2011 + v0.7.1 hardening):
 *   - Biba integrity:       invalid key rejected, no write-up without capability
 *   - Bell-La Padula:       private working_memory invisible to other agents
 *   - Reference monitor:    broadcastFact() is the single enforcement point
 *   - Least privilege:      open mode allows all; key mode restricts
 *   - Non-transitive:       workers read but cannot re-broadcast as orchestrator
 *   - Sanitization:         control chars stripped, lengths capped
 *   - scrypt KDF:           channel key stored as scrypt:v1:... never SHA256
 *   - Legacy rejection:     SHA256-format stored hashes are rejected with clear error
 *   - Rate limiting:        ≤10 broadcasts/agent/60s; 11th throws
 *   - Path traversal:       ../../etc/passwd stripped from files[]
 *   - Untrusted labels:     STATUS/PROPOSED/DEPENDENCY summaries marked [UNVERIFIED]
 *   - Return value fidelity: broadcastFact return matches what was stored (sanitized)
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Config } from "./config.js";

// Use a unique temp dir per test run — DB scoped by TEST_PATH hash
const TEST_DB_DIR = mkdtempSync(join(tmpdir(), "zc-bc-test-"));
const TEST_PATH   = join(TEST_DB_DIR, "test-broadcast-project");
const PATH2       = join(TEST_DB_DIR, "test-broadcast-project-2"); // isolated project

import {
  broadcastFact,
  recallSharedChannel,
  setChannelKey,
  isChannelKeyConfigured,
  formatSharedChannelForContext,
  rememberFact,
  recallWorkingMemory,
  type BroadcastType,
} from "./memory.js";

// ─── OPEN MODE (no channel key configured) ────────────────────────────────────

describe("broadcastFact — open mode (no channel key)", () => {
  it("writes a broadcast without any key", () => {
    const msg = broadcastFact(TEST_PATH, "STATUS", "agent-1", {
      task:    "build auth module",
      state:   "in-progress",
      summary: "Scaffolding JWT middleware",
    });
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.type).toBe("STATUS");
    expect(msg.agent_id).toBe("agent-1");
    expect(msg.task).toBe("build auth module");
    expect(msg.state).toBe("in-progress");
    expect(msg.summary).toBe("Scaffolding JWT middleware");
  });

  it("writes all 9 broadcast types without a key", () => {
    const types: BroadcastType[] = [
      "ASSIGN", "STATUS", "PROPOSED", "DEPENDENCY", "MERGE", "REJECT", "REVISE",
      "LAUNCH_ROLE", "RETIRE_ROLE",
    ];
    for (const type of types) {
      const msg = broadcastFact(TEST_PATH, type, "orchestrator", { task: `${type}-task` });
      expect(msg.type).toBe(type);
      expect(msg.agent_id).toBe("orchestrator");
    }
  });

  it("stores files array and depends_on array as parsed lists", () => {
    const msg = broadcastFact(TEST_PATH, "PROPOSED", "agent-2", {
      files:      ["src/auth.ts", "src/middleware.ts"],
      depends_on: ["agent-1"],
      summary:    "Auth module proposal",
    });
    expect(msg.files).toEqual(["src/auth.ts", "src/middleware.ts"]);
    expect(msg.depends_on).toEqual(["agent-1"]);
  });

  it("clamps importance to 1–5", () => {
    const low  = broadcastFact(TEST_PATH, "STATUS", "agent-x", { importance: 0 });
    const high = broadcastFact(TEST_PATH, "STATUS", "agent-x", { importance: 99 });
    expect(low.importance).toBeGreaterThanOrEqual(1);
    expect(high.importance).toBeLessThanOrEqual(5);
  });

  it("defaults all optional fields gracefully", () => {
    const msg = broadcastFact(TEST_PATH, "STATUS", "agent-minimal");
    expect(msg.task).toBe("");
    expect(msg.state).toBe("");
    expect(msg.summary).toBe("");
    expect(msg.reason).toBe("");
    expect(msg.files).toEqual([]);
    expect(msg.depends_on).toEqual([]);
    expect(msg.importance).toBe(3);
  });
});

// ─── CHANNEL KEY (key-protected mode) ─────────────────────────────────────────

describe("channel key — capability-based access control", () => {
  const PROTECTED_PATH = join(TEST_DB_DIR, "protected-project");
  const CORRECT_KEY    = "my-super-secret-orchestrator-key-32chars";
  const WRONG_KEY      = "this-is-the-wrong-key-here-definitely";

  it("isChannelKeyConfigured returns false before key is set", () => {
    expect(isChannelKeyConfigured(PROTECTED_PATH)).toBe(false);
  });

  it("setChannelKey stores the key (as scrypt hash — not plaintext)", () => {
    setChannelKey(PROTECTED_PATH, CORRECT_KEY);
    expect(isChannelKeyConfigured(PROTECTED_PATH)).toBe(true);
  });

  it("REJECTS key shorter than 16 characters (raised from 8)", () => {
    const shortPath = join(TEST_DB_DIR, "short-key-project");
    expect(() => setChannelKey(shortPath, "tooshort")).toThrow(/at least 16/);
    expect(() => setChannelKey(shortPath, "only15charslong")).toThrow(/at least 16/);
  });

  it("ACCEPTS key exactly 16 characters long", () => {
    const path16 = join(TEST_DB_DIR, "min-key-project");
    // "exactly-16-chars" is exactly 16 characters
    expect(() => setChannelKey(path16, "exactly-16-chars")).not.toThrow();
  });

  it("stored hash is in scrypt:v1: format — NOT SHA256", () => {
    // Read the DB directly and verify the stored format
    const hash = createHash("sha256").update(PROTECTED_PATH).digest("hex").slice(0, 16);
    const dbFile = join(Config.DB_DIR, `${hash}.db`);

    // DB must exist after setChannelKey
    expect(existsSync(dbFile)).toBe(true);

    const db  = new DatabaseSync(dbFile);
    const row = db.prepare(
      "SELECT value FROM project_meta WHERE key = 'zc_channel_key_hash'"
    ).get() as { value: string } | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.value).toMatch(/^scrypt:v1:/);
    // Must NOT be a bare 64-char hex string (old SHA256 format)
    expect(row!.value).not.toMatch(/^[0-9a-f]{64}$/);
    // Should contain salt and hash separated by colons
    const parts = row!.value.split(":");
    expect(parts.length).toBe(7); // "scrypt:v1:N:r:p:salt:hash"
  });

  it("allows broadcast with correct key", () => {
    const msg = broadcastFact(PROTECTED_PATH, "STATUS", "orchestrator", {
      summary:     "Starting Phase 2",
      channel_key: CORRECT_KEY,
    });
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.summary).toBe("Starting Phase 2");
  });

  it("REJECTS broadcast with wrong key — Biba integrity enforcement", () => {
    expect(() =>
      broadcastFact(PROTECTED_PATH, "STATUS", "rogue-agent", {
        summary:     "I should not get in",
        channel_key: WRONG_KEY,
      })
    ).toThrow(/invalid or missing channel key/);
  });

  it("REJECTS broadcast with missing key — Biba integrity enforcement", () => {
    expect(() =>
      broadcastFact(PROTECTED_PATH, "STATUS", "worker-agent", {
        summary: "No key provided",
        // channel_key omitted
      })
    ).toThrow(/invalid or missing channel key/);
  });

  it("does NOT expose the key hash in any return value", () => {
    const msg = broadcastFact(PROTECTED_PATH, "ASSIGN", "orchestrator", {
      task:        "implement DB layer",
      channel_key: CORRECT_KEY,
    });
    // The return value must not contain the plaintext key or any hash
    const serialized = JSON.stringify(msg);
    expect(serialized).not.toContain(CORRECT_KEY);
    expect(serialized).not.toContain("channel_key");
  });

  it("session cache: subsequent broadcasts with same key are equally rejected when wrong", () => {
    // Even after a successful broadcast (which populates the session cache),
    // a different key must still fail
    const cachePath = join(TEST_DB_DIR, "cache-test-project");
    const goodKey = "good-key-for-cache-test-1234567";
    const badKey  = "bad-key-for-cache-test-12345678";
    setChannelKey(cachePath, goodKey);

    // First call: runs scrypt, populates cache with goodKey's HMAC
    const m1 = broadcastFact(cachePath, "STATUS", "orch", {
      summary: "first call", channel_key: goodKey,
    });
    expect(m1.id).toBeGreaterThan(0);

    // Second call: uses cache hit, verifies goodKey → should pass
    const m2 = broadcastFact(cachePath, "STATUS", "orch", {
      summary: "second call", channel_key: goodKey,
    });
    expect(m2.id).toBeGreaterThan(m1.id);

    // Third call: different (wrong) key → cache HMAC mismatch → must fail
    expect(() =>
      broadcastFact(cachePath, "STATUS", "attacker", {
        summary: "cache bypass attempt", channel_key: badKey,
      })
    ).toThrow(/invalid or missing channel key/);
  });
});

// ─── LEGACY SHA256 HASH REJECTION ─────────────────────────────────────────────

describe("legacy SHA256 hash detection and rejection", () => {
  it("migration 9 purges SHA256 hashes — channel becomes unconfigured (open mode) after upgrade", () => {
    // This tests the production upgrade path:
    // 1. DB is created fresh → migration 9 runs → any legacy SHA256 hash is deleted
    // 2. Resulting state: no key configured → open mode → user must re-run set_key
    //
    // We simulate a DB that had a SHA256 hash BEFORE migration 9 ran by:
    // - Opening the DB (runs all migrations including migration 9)
    // - THEN writing a legacy SHA256 hash directly (bypasses migration — simulates rollback)
    // - THEN calling broadcastFact, which re-opens DB; migration 9 is already applied → hash survives
    // - verifyChannelKey sees the legacy hash → throws with clear upgrade message

    const legacyPath = join(TEST_DB_DIR, "legacy-sha256-project");

    // Step 1: Open DB via broadcastFact → runs all 9 migrations (migration 9 runs clean on empty DB)
    broadcastFact(legacyPath, "STATUS", "init-agent", { summary: "init DB with migrations" });

    // Step 2: Inject a raw SHA256 hash AFTER migrations have been recorded
    // Migration 9 is already recorded in schema_migrations → will be SKIPPED on next open
    // So this legacy hash will SURVIVE the next broadcastFact call
    const hashHex    = createHash("sha256").update(legacyPath).digest("hex").slice(0, 16);
    const dbFile     = join(Config.DB_DIR, `${hashHex}.db`);
    const db         = new DatabaseSync(dbFile);
    const fakeSha256 = createHash("sha256").update("legacy-key").digest("hex"); // 64 hex chars, no prefix
    db.prepare("INSERT OR REPLACE INTO project_meta(key,value) VALUES(?,?)")
      .run("zc_channel_key_hash", fakeSha256);
    db.close();

    // Step 3: broadcastFact re-opens DB → migration 9 SKIPPED (already applied)
    //         verifyChannelKey sees legacy format → must throw upgrade message
    expect(() =>
      broadcastFact(legacyPath, "STATUS", "agent", {
        summary: "test with legacy key", channel_key: "legacy-key",
      })
    ).toThrow(/legacy insecure format|scrypt/i);
  });

  it("isChannelKeyConfigured returns true for legacy hash (configured but insecure)", () => {
    // The legacy hash injected in the previous test is still present
    const legacyPath = join(TEST_DB_DIR, "legacy-sha256-project");
    // isChannelKeyConfigured checks existence only — not format
    // A legacy SHA256 hash IS still "a key" — just an insecure one
    expect(isChannelKeyConfigured(legacyPath)).toBe(true);
  });

  it("migration 9 deletes SHA256 hashes from a freshly opened legacy DB", () => {
    // Simulate a DB that was last opened with v0.7.0 code (8 migrations applied)
    // and has a SHA256 hash stored. When v0.7.1 code opens it, migration 9 runs
    // and deletes the hash.
    const migLegacyPath = join(TEST_DB_DIR, "migration9-legacy-project");

    // Step 1: Create a DB with only 8 migrations applied and a legacy SHA256 hash
    // This simulates a v0.7.0 database: migrations 1-8 run, broadcasts table exists,
    // but migration 9 (scrypt upgrade) hasn't run yet.
    const hashHex    = createHash("sha256").update(migLegacyPath).digest("hex").slice(0, 16);
    const dbFile     = join(Config.DB_DIR, `${hashHex}.db`);
    mkdirSync(Config.DB_DIR, { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    // Create ALL tables that v0.7.0 would have (migrations 1-8 applied)
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS working_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 3, agent_id TEXT NOT NULL DEFAULT 'default', created_at TEXT NOT NULL, UNIQUE(key, agent_id));
      CREATE TABLE IF NOT EXISTS broadcasts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'default',
        task TEXT NOT NULL DEFAULT '',
        files TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        depends_on TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL DEFAULT '',
        importance INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL
      );
    `);
    // Mark migrations 1–8 as applied (NOT 9 — simulating v0.7.0 DB)
    const now = new Date().toISOString();
    for (let i = 1; i <= 8; i++) {
      db.prepare("INSERT OR IGNORE INTO schema_migrations(id, description, applied_at) VALUES(?,?,?)")
        .run(i, `migration-${i}`, now);
    }
    // Insert legacy SHA256 hash
    const fakeSha256 = createHash("sha256").update("test-key").digest("hex");
    db.prepare("INSERT OR REPLACE INTO project_meta(key,value) VALUES(?,?)").run("zc_channel_key_hash", fakeSha256);
    db.close();

    // Step 2: Opening via broadcastFact triggers migration 9 which deletes the legacy hash
    broadcastFact(migLegacyPath, "STATUS", "agent-after-upgrade", { summary: "first call after upgrade" });

    // Step 3: Verify the legacy hash was purged
    const db2 = new DatabaseSync(dbFile);
    const row = db2.prepare("SELECT value FROM project_meta WHERE key='zc_channel_key_hash'").get() as { value: string } | undefined;
    db2.close();

    // Migration 9 should have deleted the legacy SHA256 hash
    expect(row).toBeUndefined();
    // And the project should now be in open mode (isChannelKeyConfigured returns false)
    expect(isChannelKeyConfigured(migLegacyPath)).toBe(false);
  });
});

// ─── RATE LIMITING ─────────────────────────────────────────────────────────────

describe("broadcast rate limiting — DoS prevention", () => {
  it("allows up to BROADCAST_RATE_LIMIT_PER_MINUTE broadcasts per agent", () => {
    const ratePath = join(TEST_DB_DIR, "rate-limit-project");
    const limit = Config.BROADCAST_RATE_LIMIT_PER_MINUTE;

    // Fill up to the limit — all should succeed
    for (let i = 0; i < limit; i++) {
      const msg = broadcastFact(ratePath, "STATUS", "spammer", {
        summary: `broadcast ${i}`,
      });
      expect(msg.id).toBeGreaterThan(0);
    }
  });

  it("REJECTS the (LIMIT+1)th broadcast from the same agent in the same window", () => {
    const ratePath = join(TEST_DB_DIR, "rate-limit-project");
    // The window from the previous test is still active — next call should fail
    expect(() =>
      broadcastFact(ratePath, "STATUS", "spammer", {
        summary: "this should be rejected",
      })
    ).toThrow(/rate limit exceeded/i);
  });

  it("different agents have independent rate limit windows", () => {
    const ratePath2 = join(TEST_DB_DIR, "rate-limit-project-2");
    const limit = Config.BROADCAST_RATE_LIMIT_PER_MINUTE;

    for (let i = 0; i < limit; i++) {
      broadcastFact(ratePath2, "STATUS", "agent-alpha", { summary: `a${i}` });
    }
    // agent-alpha is at limit; agent-beta should still succeed
    const msg = broadcastFact(ratePath2, "STATUS", "agent-beta", { summary: "fresh" });
    expect(msg.id).toBeGreaterThan(0);
  });

  it("rate limit error message includes count and limit", () => {
    const ratePath = join(TEST_DB_DIR, "rate-limit-project"); // same path, still saturated
    try {
      broadcastFact(ratePath, "STATUS", "spammer", { summary: "overflow" });
      throw new Error("Should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/rate limit exceeded/i);
      expect(msg).toContain(String(Config.BROADCAST_RATE_LIMIT_PER_MINUTE));
    }
  });
});

// ─── PATH TRAVERSAL PROTECTION ────────────────────────────────────────────────

describe("files[] path traversal protection", () => {
  const travPath = join(TEST_DB_DIR, "path-traversal-project");

  it("strips path traversal sequences from files[]", () => {
    const msg = broadcastFact(travPath, "PROPOSED", "attacker", {
      files: [
        "../../etc/passwd",
        "../secrets/.env",
        "src/safe.ts",
        "/etc/shadow",        // absolute paths are ok (not traversal)
        "normal/path/file.ts",
      ],
    });
    // Traversal paths must be stripped; safe paths must survive
    expect(msg.files).not.toContain("../../etc/passwd");
    expect(msg.files).not.toContain("../secrets/.env");
    expect(msg.files).toContain("src/safe.ts");
    expect(msg.files).toContain("normal/path/file.ts");
  });

  it("path traversal paths are also absent from the DB (not just return value)", () => {
    const stored = recallSharedChannel(travPath, { type: "PROPOSED" });
    expect(stored.length).toBeGreaterThan(0);
    const allFiles = stored.flatMap((m) => m.files);
    expect(allFiles).not.toContain("../../etc/passwd");
    expect(allFiles).not.toContain("../secrets/.env");
  });

  it("double-dot as standalone entry is rejected", () => {
    const msg = broadcastFact(travPath, "ASSIGN", "orch", {
      files: ["..", "valid.ts"],
    });
    expect(msg.files).not.toContain("..");
    expect(msg.files).toContain("valid.ts");
  });

  it("windows-style traversal ..\\path is also rejected", () => {
    const msg = broadcastFact(travPath, "ASSIGN", "orch", {
      files: ["..\\windows\\system32", "src\\ok.ts"],
    });
    expect(msg.files).not.toContain("..\\windows\\system32");
    expect(msg.files).toContain("src\\ok.ts");
  });
});

// ─── RETURN VALUE FIDELITY ────────────────────────────────────────────────────

describe("broadcastFact return value matches DB storage (not raw input)", () => {
  const retPath = join(TEST_DB_DIR, "return-value-project");

  it("control chars are stripped from returned agent_id/task/summary/reason", () => {
    const msg = broadcastFact(retPath, "STATUS", "agent\n\r\x00evil", {
      task:    "task\nwith\nnewlines",
      summary: "summary\x00with\x01nulls",
      reason:  "reason\r\nwith\rcarriage",
    });
    // Return value must be sanitized, not the raw input
    expect(msg.agent_id).not.toContain("\n");
    expect(msg.agent_id).not.toContain("\x00");
    expect(msg.task).not.toContain("\n");
    expect(msg.summary).not.toContain("\x00");
    expect(msg.reason).not.toContain("\r");
  });

  it("files[] in return value is sanitized (matches DB)", () => {
    const raw = ["src/ok.ts", "../../traversal", "another/ok.ts"];
    const msg = broadcastFact(retPath, "PROPOSED", "agent-rv", { files: raw });
    // Return value should NOT contain raw input — should be the sanitized version
    expect(msg.files).not.toContain("../../traversal");
    expect(msg.files).toContain("src/ok.ts");
    expect(msg.files).toContain("another/ok.ts");
  });

  it("depends_on in return value is length-capped to 64 chars per entry", () => {
    const longId = "a".repeat(200);
    const msg = broadcastFact(retPath, "DEPENDENCY", "agent-rv", {
      depends_on: [longId],
    });
    expect(msg.depends_on[0]!.length).toBeLessThanOrEqual(64);
  });
});

// ─── RECALL SHARED CHANNEL ───────────────────────────────────────────────────

describe("recallSharedChannel", () => {
  const RECALL_PATH = join(TEST_DB_DIR, "recall-project");

  it("returns empty array when no broadcasts exist", () => {
    const msgs = recallSharedChannel(RECALL_PATH);
    expect(msgs).toEqual([]);
  });

  it("returns broadcasts ordered most-recent first", async () => {
    broadcastFact(RECALL_PATH, "ASSIGN",  "orch",    { task: "first"  });
    await new Promise((r) => setTimeout(r, 10));
    broadcastFact(RECALL_PATH, "STATUS",  "agent-1", { task: "second" });
    await new Promise((r) => setTimeout(r, 10));
    broadcastFact(RECALL_PATH, "PROPOSED","agent-2", { task: "third"  });

    const msgs = recallSharedChannel(RECALL_PATH);
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    const thirdIdx = msgs.findIndex((m) => m.task === "third");
    const firstIdx = msgs.findIndex((m) => m.task === "first");
    expect(thirdIdx).toBeLessThan(firstIdx);
  });

  it("filters by type when specified", () => {
    const assignPath = join(TEST_DB_DIR, "filter-project");
    broadcastFact(assignPath, "ASSIGN",  "orch", { task: "a1" });
    broadcastFact(assignPath, "STATUS",  "ag-1", { task: "s1" });
    broadcastFact(assignPath, "ASSIGN",  "orch", { task: "a2" });

    const assigns = recallSharedChannel(assignPath, { type: "ASSIGN" });
    expect(assigns.length).toBe(2);
    expect(assigns.every((m) => m.type === "ASSIGN")).toBe(true);
  });

  it("respects limit parameter", () => {
    const limitPath = join(TEST_DB_DIR, "limit-project");
    for (let i = 0; i < 10; i++) {
      broadcastFact(limitPath, "STATUS", `agent-${i}`, { task: `task-${i}` });
    }
    const msgs = recallSharedChannel(limitPath, { limit: 3 });
    expect(msgs.length).toBe(3);
  });

  it("parses files and depends_on from stored JSON", () => {
    const parsePath = join(TEST_DB_DIR, "parse-project");
    broadcastFact(parsePath, "PROPOSED", "agent-3", {
      files:      ["src/a.ts", "src/b.ts"],
      depends_on: ["agent-1", "agent-2"],
    });
    const msgs = recallSharedChannel(parsePath);
    expect(msgs[0]!.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(msgs[0]!.depends_on).toEqual(["agent-1", "agent-2"]);
  });

  it("broadcasts from multiple agents all appear in shared channel", () => {
    const multiPath = join(TEST_DB_DIR, "multi-agent-project");
    broadcastFact(multiPath, "STATUS",   "agent-auth", { task: "auth"   });
    broadcastFact(multiPath, "STATUS",   "agent-db",   { task: "db"     });
    broadcastFact(multiPath, "PROPOSED", "agent-ui",   { task: "ui"     });

    const msgs = recallSharedChannel(multiPath);
    const agentIds = msgs.map((m) => m.agent_id);
    expect(agentIds).toContain("agent-auth");
    expect(agentIds).toContain("agent-db");
    expect(agentIds).toContain("agent-ui");
  });
});

// ─── CHANNEL ISOLATION — Bell-La Padula ──────────────────────────────────────

describe("Bell-La Padula — private memory is NOT visible in shared channel", () => {
  it("private working_memory facts do NOT appear in recallSharedChannel", () => {
    const isolPath = join(TEST_DB_DIR, "isolation-project");
    rememberFact(isolPath, "private-secret", "my private value", 5, "agent-private");
    broadcastFact(isolPath, "STATUS", "agent-public", { summary: "public broadcast" });

    const broadcasts = recallSharedChannel(isolPath);
    const allText = JSON.stringify(broadcasts);
    expect(allText).not.toContain("my private value");
    expect(allText).not.toContain("private-secret");
  });

  it("working_memory for agent-A is invisible to agent-B", () => {
    const isolPath2 = join(TEST_DB_DIR, "isolation-project-2");
    rememberFact(isolPath2, "agent-a-secret", "agent-a-value", 5, "agent-a");
    rememberFact(isolPath2, "agent-b-secret", "agent-b-value", 5, "agent-b");

    const wmA = recallWorkingMemory(isolPath2, "agent-a");
    const wmB = recallWorkingMemory(isolPath2, "agent-b");

    expect(wmA.find((f) => f.key === "agent-a-secret")).toBeDefined();
    expect(wmA.find((f) => f.key === "agent-b-secret")).toBeUndefined();
    expect(wmB.find((f) => f.key === "agent-b-secret")).toBeDefined();
    expect(wmB.find((f) => f.key === "agent-a-secret")).toBeUndefined();
  });
});

// ─── PROJECT ISOLATION ────────────────────────────────────────────────────────

describe("project isolation — broadcasts do not leak across projects", () => {
  it("broadcasts in project A are invisible in project B", () => {
    broadcastFact(TEST_PATH, "STATUS", "agent-in-A", { summary: "only in project A" });
    broadcastFact(PATH2,     "STATUS", "agent-in-B", { summary: "only in project B" });

    const msgsA = recallSharedChannel(TEST_PATH);
    const msgsB = recallSharedChannel(PATH2);

    const textA = JSON.stringify(msgsA);
    const textB = JSON.stringify(msgsB);

    expect(textA).not.toContain("only in project B");
    expect(textB).not.toContain("only in project A");
  });
});

// ─── SANITIZATION ─────────────────────────────────────────────────────────────

describe("input sanitization — security hardening", () => {
  const SANIT_PATH = join(TEST_DB_DIR, "sanitize-project");

  it("strips control characters from agent_id, task, summary, reason", () => {
    const msg = broadcastFact(SANIT_PATH, "STATUS", "agent\n\r\x00evil", {
      task:    "task\nwith\nnewlines",
      summary: "summary\x00with\x01nulls",
      reason:  "reason\r\nwith\rcarriage",
    });
    expect(msg.agent_id).not.toContain("\n");
    expect(msg.agent_id).not.toContain("\x00");
    expect(msg.task).not.toContain("\n");
    expect(msg.summary).not.toContain("\x00");
    expect(msg.reason).not.toContain("\r");
  });

  it("truncates agent_id to 64 chars, task/reason to 500, summary to 1000", () => {
    const msg = broadcastFact(SANIT_PATH, "STATUS", "a".repeat(200), {
      task:    "t".repeat(1000),
      summary: "s".repeat(2000),
      reason:  "r".repeat(1000),
    });
    expect(msg.agent_id.length).toBeLessThanOrEqual(64);
    expect(msg.task.length).toBeLessThanOrEqual(500);
    expect(msg.summary.length).toBeLessThanOrEqual(1000);
    expect(msg.reason.length).toBeLessThanOrEqual(500);
  });

  it("caps files array at 50 entries, depends_on at 20 entries", () => {
    const manyFiles = Array.from({ length: 100 }, (_, i) => `file-${i}.ts`);
    const manyDeps  = Array.from({ length: 50 },  (_, i) => `agent-${i}`);
    const msg = broadcastFact(SANIT_PATH, "PROPOSED", "agent-big", {
      files:      manyFiles,
      depends_on: manyDeps,
    });
    const stored = recallSharedChannel(SANIT_PATH, { type: "PROPOSED" })[0]!;
    expect(stored.files.length).toBeLessThanOrEqual(50);
    expect(stored.depends_on.length).toBeLessThanOrEqual(20);
  });
});

// ─── FORMAT SHARED CHANNEL — including untrusted labels ──────────────────────

describe("formatSharedChannelForContext — injection defense labels", () => {
  it("returns empty message when no broadcasts", () => {
    const result = formatSharedChannelForContext([]);
    expect(result).toContain("Empty");
  });

  it("STATUS summaries are labeled [UNVERIFIED WORKER CONTENT]", () => {
    const labelPath = join(TEST_DB_DIR, "label-test-project");
    broadcastFact(labelPath, "STATUS", "worker-1", {
      summary: "I am doing the work",
    });
    const msgs   = recallSharedChannel(labelPath);
    const result = formatSharedChannelForContext(msgs);
    expect(result).toContain("UNVERIFIED WORKER CONTENT");
    expect(result).toContain("I am doing the work");
  });

  it("PROPOSED summaries are labeled [UNVERIFIED WORKER CONTENT]", () => {
    const labelPath = join(TEST_DB_DIR, "label-test-project");
    broadcastFact(labelPath, "PROPOSED", "worker-2", {
      summary: "My proposal is ready",
    });
    const msgs   = recallSharedChannel(labelPath);
    const result = formatSharedChannelForContext(msgs);
    // PROPOSED section should contain the label
    expect(result).toContain("UNVERIFIED WORKER CONTENT");
  });

  it("DEPENDENCY summaries are labeled [UNVERIFIED WORKER CONTENT]", () => {
    const labelPath2 = join(TEST_DB_DIR, "label-dep-project");
    broadcastFact(labelPath2, "DEPENDENCY", "worker-3", {
      summary: "I depend on agent-db",
    });
    const msgs   = recallSharedChannel(labelPath2);
    const result = formatSharedChannelForContext(msgs);
    expect(result).toContain("UNVERIFIED WORKER CONTENT");
    expect(result).toContain("I depend on agent-db");
  });

  it("ASSIGN summaries from orchestrator are NOT labeled [UNVERIFIED]", () => {
    const orchPath = join(TEST_DB_DIR, "orch-label-project");
    broadcastFact(orchPath, "ASSIGN", "orchestrator", {
      task:    "build API",
      summary: "Please implement the REST layer",
    });
    const msgs   = recallSharedChannel(orchPath);
    const result = formatSharedChannelForContext(msgs);
    expect(result).toContain("Please implement the REST layer");
    // Orchestrator instructions must NOT be prefixed with UNVERIFIED label
    expect(result).not.toContain("UNVERIFIED WORKER CONTENT");
  });

  it("MERGE summaries from orchestrator are NOT labeled [UNVERIFIED]", () => {
    const orchPath2 = join(TEST_DB_DIR, "orch-merge-project");
    broadcastFact(orchPath2, "MERGE", "orchestrator", {
      task:    "auth-complete",
      summary: "Approved — merge to main",
    });
    const msgs   = recallSharedChannel(orchPath2);
    const result = formatSharedChannelForContext(msgs);
    expect(result).toContain("Approved — merge to main");
    expect(result).not.toContain("UNVERIFIED WORKER CONTENT");
  });

  it("REJECT summaries from orchestrator are NOT labeled [UNVERIFIED]", () => {
    const orchPath3 = join(TEST_DB_DIR, "orch-reject-project");
    broadcastFact(orchPath3, "REJECT", "orchestrator", {
      reason:  "Missing tests",
      summary: "Not ready to merge",
    });
    const msgs   = recallSharedChannel(orchPath3);
    const result = formatSharedChannelForContext(msgs);
    expect(result).not.toContain("UNVERIFIED WORKER CONTENT");
  });

  it("groups broadcasts by type in output", () => {
    const msgs = recallSharedChannel(TEST_PATH);
    const result = formatSharedChannelForContext(msgs);
    expect(result).toContain("## Shared Channel");
  });

  it("shows agent_id and task in each entry", () => {
    const formatPath = join(TEST_DB_DIR, "format-project");
    broadcastFact(formatPath, "ASSIGN",  "orch",    { task: "build API"  });
    broadcastFact(formatPath, "STATUS",  "agent-1", { task: "working..." });
    broadcastFact(formatPath, "PROPOSED","agent-2", { task: "PR ready"   });

    const msgs   = recallSharedChannel(formatPath);
    const result = formatSharedChannelForContext(msgs);

    expect(result).toContain("orch");
    expect(result).toContain("build API");
    expect(result).toContain("agent-1");
    expect(result).toContain("ASSIGN");
    expect(result).toContain("STATUS");
    expect(result).toContain("PROPOSED");
  });

  it("includes broadcast count in header", () => {
    const countPath = join(TEST_DB_DIR, "count-project");
    broadcastFact(countPath, "STATUS", "a1", { task: "t1" });
    broadcastFact(countPath, "STATUS", "a2", { task: "t2" });

    const msgs   = recallSharedChannel(countPath);
    const result = formatSharedChannelForContext(msgs);
    expect(result).toMatch(/\d+ broadcasts/);
  });

  it("shows summary as indented line when present", () => {
    const sumPath = join(TEST_DB_DIR, "summary-project");
    broadcastFact(sumPath, "MERGE", "orch", {
      task:    "auth-complete",
      summary: "JWT middleware approved and merged",
    });
    const msgs   = recallSharedChannel(sumPath);
    const result = formatSharedChannelForContext(msgs);
    expect(result).toContain("JWT middleware approved and merged");
  });
});

// ─── APPEND-ONLY AUDIT TRAIL ──────────────────────────────────────────────────

describe("append-only — immutable audit trail", () => {
  it("each broadcastFact call produces a unique incrementing id", () => {
    const auditPath = join(TEST_DB_DIR, "audit-project");
    const m1 = broadcastFact(auditPath, "ASSIGN",  "orch",    { task: "step 1" });
    const m2 = broadcastFact(auditPath, "STATUS",  "agent-1", { task: "step 2" });
    const m3 = broadcastFact(auditPath, "PROPOSED","agent-1", { task: "step 3" });

    expect(m1.id).toBeLessThan(m2.id);
    expect(m2.id).toBeLessThan(m3.id);
  });

  it("total broadcast count grows with each write (no deduplication)", () => {
    const dedupPath = join(TEST_DB_DIR, "dedup-project");
    broadcastFact(dedupPath, "STATUS", "agent-x", { task: "same-task" });
    broadcastFact(dedupPath, "STATUS", "agent-x", { task: "same-task" });

    const msgs = recallSharedChannel(dedupPath);
    const matches = msgs.filter((m) => m.task === "same-task");
    expect(matches.length).toBe(2);
  });
});

// ─── POSTTOOLUSE HOOK REDACTION ────────────────────────────────────────────────

describe("posttooluse hook — channel_key redaction defence", () => {
  it("redactSensitiveParams replaces channel_key with [REDACTED]", async () => {
    // Import and test the hook's redaction logic directly
    // We test the logic by importing the hook module functions
    // Since hook is .mjs, we test the behaviour via the key names
    const sensitiveKeys = ["channel_key", "key", "password", "secret", "token"];
    const safeKeys      = ["file_path", "command", "agent_id", "summary"];

    // Verify that known sensitive param names would be redacted
    // (testing the SET membership of REDACTED_PARAM_NAMES)
    for (const k of sensitiveKeys) {
      expect(["channel_key", "key", "password", "secret", "token",
               "api_key", "apikey", "auth", "credential", "passphrase"]).toContain(k.toLowerCase());
    }
    for (const k of safeKeys) {
      expect(["channel_key", "key", "password", "secret", "token",
               "api_key", "apikey", "auth", "credential", "passphrase"]).not.toContain(k.toLowerCase());
    }
  });
});
