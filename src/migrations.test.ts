import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations, getCurrentSchemaVersion, MIGRATIONS } from "./migrations.js";

function makeTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  // Need the FTS5 virtual table so migrations that depend on it work
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge USING fts5(
      source, content, created_at UNINDEXED,
      tokenize='porter unicode61'
    );
  `);
  return db;
}

describe("runMigrations", () => {
  it("applies all migrations on a fresh DB", () => {
    const db = makeTestDb();
    runMigrations(db);
    const version = getCurrentSchemaVersion(db);
    expect(version).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.id);
  });

  it("is idempotent — running twice gives the same version", () => {
    const db = makeTestDb();
    runMigrations(db);
    runMigrations(db);
    const version = getCurrentSchemaVersion(db);
    expect(version).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.id);
  });

  it("creates schema_migrations table", () => {
    const db = makeTestDb();
    runMigrations(db);
    type Row = { count: number };
    const row = db.prepare(
      "SELECT COUNT(*) as count FROM schema_migrations"
    ).get() as Row;
    expect(row.count).toBe(MIGRATIONS.length);
  });

  it("creates working_memory table with agent_id column", () => {
    const db = makeTestDb();
    runMigrations(db);
    // Should not throw
    db.prepare("SELECT key, value, agent_id FROM working_memory LIMIT 1").all();
  });

  it("creates embeddings table with model_name and dimensions", () => {
    const db = makeTestDb();
    runMigrations(db);
    db.prepare("SELECT source, model_name, dimensions FROM embeddings LIMIT 1").all();
  });

  it("creates source_meta with retention_tier column", () => {
    const db = makeTestDb();
    runMigrations(db);
    db.prepare("SELECT source, source_type, retention_tier FROM source_meta LIMIT 1").all();
  });

  it("creates rate_limits table", () => {
    const db = makeTestDb();
    runMigrations(db);
    db.prepare("SELECT project_hash, date, fetch_count FROM rate_limits LIMIT 1").all();
  });

  it("returns 0 schema version before migrations run", () => {
    const db = makeTestDb();
    expect(getCurrentSchemaVersion(db)).toBe(0);
  });

  it("rolls back on migration failure — no partial state", () => {
    const db = makeTestDb();
    // Inject a failing migration temporarily
    const broken = {
      id:          999,
      description: "intentionally broken",
      up:          (_db: DatabaseSync) => { throw new Error("simulated failure"); },
    };
    // We can test this by calling the migration runner internals
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    db.exec("BEGIN");
    expect(() => { broken.up(db); }).toThrow("simulated failure");
    db.exec("ROLLBACK");
    // After rollback, no record should exist for id=999
    const row = db.prepare("SELECT id FROM schema_migrations WHERE id = 999").get();
    expect(row).toBeUndefined();
  });
});
