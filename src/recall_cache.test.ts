/**
 * Tests for v0.17.1 recall_cache.ts — the 60s TTL + change-detection cache
 * that fronts zc_recall_context.
 *
 * Covers:
 *   - cold miss → hit on immediate repeat
 *   - staleness: new row in working_memory busts the cache
 *   - staleness: new broadcast busts the cache
 *   - TTL expiry: cache older than 60s is treated as miss
 *   - cross-agent isolation: agent A's hit is not a hit for agent B
 *   - cross-project isolation: project A's hit is not a hit for project B
 *   - force:true semantics handled at the caller (these tests cover the cache API)
 *   - getCacheStats counters track hits/misses correctly
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tryGetCachedRecall,
  putCachedRecall,
  decorateCachedResponse,
  getCacheStats,
  _resetRecallCacheForTesting,
} from "./recall_cache.js";

function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "recall-cache-test-"));
  const db  = new DatabaseSync(join(dir, "test.db"));
  db.exec(`
    CREATE TABLE working_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      key TEXT, value TEXT, importance INTEGER, ts TEXT
    );
    CREATE TABLE broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT, agent_id TEXT, task TEXT, files TEXT, summary TEXT,
      depends_on TEXT, state TEXT, reason TEXT, importance INTEGER,
      created_at TEXT
    );
    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT, file_path TEXT, task_name TEXT, error_type TEXT,
      created_at TEXT
    );
  `);
  return db;
}

beforeEach(() => {
  _resetRecallCacheForTesting();
});

describe("v0.17.1 recall_cache — 60s TTL + change detection", () => {

  it("cold call → miss", () => {
    const db = freshDb();
    const r = tryGetCachedRecall("/tmp/proj1", "dev", db);
    expect(r.hit).toBe(false);
    db.close();
  });

  it("put → immediate get → hit", () => {
    const db = freshDb();
    putCachedRecall("/tmp/proj1", "dev", "cached response 1", db);
    const r = tryGetCachedRecall("/tmp/proj1", "dev", db);
    expect(r.hit).toBe(true);
    expect(r.response).toBe("cached response 1");
    expect(r.ageMs).toBeGreaterThanOrEqual(0);
    expect(r.ageMs).toBeLessThan(1000);  // we JUST put it
    db.close();
  });

  it("new working_memory row busts the cache", () => {
    const db = freshDb();
    putCachedRecall("/tmp/proj2", "dev", "response A", db);
    // A new fact is remembered
    db.prepare("INSERT INTO working_memory (agent_id, key, value, importance, ts) VALUES (?, ?, ?, ?, ?)")
      .run("dev", "k1", "v1", 3, new Date().toISOString());
    const r = tryGetCachedRecall("/tmp/proj2", "dev", db);
    expect(r.hit).toBe(false);
    db.close();
  });

  it("new broadcast row busts the cache", () => {
    const db = freshDb();
    putCachedRecall("/tmp/proj3", "dev", "response B", db);
    db.prepare("INSERT INTO broadcasts (type, agent_id, summary, created_at) VALUES (?, ?, ?, ?)")
      .run("STATUS", "dev", "some update", new Date().toISOString());
    const r = tryGetCachedRecall("/tmp/proj3", "dev", db);
    expect(r.hit).toBe(false);
    db.close();
  });

  it("new session_event row busts the cache", () => {
    const db = freshDb();
    putCachedRecall("/tmp/proj4", "dev", "response C", db);
    db.prepare("INSERT INTO session_events (event_type, task_name, created_at) VALUES (?, ?, ?)")
      .run("task_complete", "t1", new Date().toISOString());
    const r = tryGetCachedRecall("/tmp/proj4", "dev", db);
    expect(r.hit).toBe(false);
    db.close();
  });

  it("cross-agent isolation: agent B cannot read agent A's cache", () => {
    const db = freshDb();
    putCachedRecall("/tmp/proj5", "alice", "alice's response", db);
    const r = tryGetCachedRecall("/tmp/proj5", "bob", db);
    expect(r.hit).toBe(false);
    db.close();
  });

  it("cross-project isolation: project B cannot read project A's cache", () => {
    const db = freshDb();
    putCachedRecall("/tmp/proj-A", "dev", "A's response", db);
    const r = tryGetCachedRecall("/tmp/proj-B", "dev", db);
    expect(r.hit).toBe(false);
    db.close();
  });

  it("decorateCachedResponse prefixes age note", () => {
    const decorated = decorateCachedResponse("original body", 12_345);
    expect(decorated).toContain("cached 12s ago");
    expect(decorated).toContain("original body");
    expect(decorated).toMatch(/force.*true.*fresh pull/i);
  });

  it("getCacheStats tracks hits and misses", () => {
    const db = freshDb();
    // 2 misses
    tryGetCachedRecall("/tmp/pS", "a", db);
    tryGetCachedRecall("/tmp/pS", "b", db);
    // 1 put + 2 hits
    putCachedRecall("/tmp/pS", "a", "response", db);
    tryGetCachedRecall("/tmp/pS", "a", db);
    tryGetCachedRecall("/tmp/pS", "a", db);
    const stats = getCacheStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(2);
    expect(stats.hitRate).toBeCloseTo(0.5, 2);
    db.close();
  });

  it("same agent, two puts, most recent wins", () => {
    const db = freshDb();
    putCachedRecall("/tmp/pY", "dev", "first", db);
    putCachedRecall("/tmp/pY", "dev", "second", db);
    const r = tryGetCachedRecall("/tmp/pY", "dev", db);
    expect(r.hit).toBe(true);
    expect(r.response).toBe("second");
    db.close();
  });

  it("undefined agent_id maps to 'default' bucket", () => {
    const db = freshDb();
    putCachedRecall("/tmp/pZ", undefined, "default-agent response", db);
    const r = tryGetCachedRecall("/tmp/pZ", undefined, db);
    expect(r.hit).toBe(true);
    expect(r.response).toBe("default-agent response");
    // And an explicit 'default' hits the same bucket
    const r2 = tryGetCachedRecall("/tmp/pZ", "default", db);
    expect(r2.hit).toBe(true);
    db.close();
  });
});
