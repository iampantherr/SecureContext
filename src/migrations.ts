/**
 * Schema migration system for SecureContext.
 *
 * DESIGN:
 * - Each migration has a unique integer ID and is applied exactly once.
 * - Applied migrations are recorded in a `schema_migrations` table.
 * - Each migration runs inside a transaction — if it fails, the DB rolls back
 *   cleanly. No partial migrations ever land in the DB.
 * - Migrations are idempotent: re-running a failed migration is safe.
 * - New migrations are added to the MIGRATIONS array; existing ones are never edited.
 *
 * USAGE:
 *   import { runMigrations } from "./migrations.js";
 *   runMigrations(db); // call once after openDb()
 */

import { DatabaseSync } from "node:sqlite";

export interface Migration {
  id: number;
  description: string;
  up: (db: DatabaseSync) => void;
}

export const MIGRATIONS: Migration[] = [

  // ── v0.6.0 migrations ────────────────────────────────────────────────────

  {
    id: 1,
    description: "Add source_type to knowledge FTS5 via source_meta table",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS source_meta (
          source      TEXT    PRIMARY KEY,
          source_type TEXT    NOT NULL DEFAULT 'internal',
          created_at  TEXT    NOT NULL
        );
      `);
    },
  },

  {
    id: 2,
    description: "Add working_memory table with agent_id namespacing and eviction index",
    up: (db) => {
      // Create with agent_id if table doesn't exist yet
      db.exec(`
        CREATE TABLE IF NOT EXISTS working_memory (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          key        TEXT    NOT NULL,
          value      TEXT    NOT NULL,
          importance INTEGER NOT NULL DEFAULT 3,
          agent_id   TEXT    NOT NULL DEFAULT 'default',
          created_at TEXT    NOT NULL,
          UNIQUE(key, agent_id)
        );
        CREATE INDEX IF NOT EXISTS idx_wm_evict
          ON working_memory(agent_id, importance ASC, created_at ASC);
      `);
      // Add agent_id to existing tables upgrading from v0.5.0 (safe: silently ignored if already present)
      try { db.exec(`ALTER TABLE working_memory ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'`); } catch {}
    },
  },

  {
    id: 3,
    description: "Add model_name and dimensions columns to embeddings for version tracking",
    up: (db) => {
      // SQLite doesn't support ADD COLUMN with constraints on existing tables easily.
      // We create the table fresh if it doesn't exist, or add columns if it does.
      db.exec(`
        CREATE TABLE IF NOT EXISTS embeddings (
          source      TEXT    PRIMARY KEY,
          vector      BLOB    NOT NULL,
          model_name  TEXT    NOT NULL DEFAULT 'unknown',
          dimensions  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT    NOT NULL
        );
      `);
      // Try to add columns to existing tables (safe: fails silently if already present)
      try { db.exec(`ALTER TABLE embeddings ADD COLUMN model_name TEXT NOT NULL DEFAULT 'unknown'`); } catch {}
      try { db.exec(`ALTER TABLE embeddings ADD COLUMN dimensions INTEGER NOT NULL DEFAULT 0`); } catch {}
    },
  },

  {
    id: 4,
    description: "Add retention_tier column to source_meta for tiered content expiry",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS source_meta (
          source         TEXT    PRIMARY KEY,
          source_type    TEXT    NOT NULL DEFAULT 'internal',
          retention_tier TEXT    NOT NULL DEFAULT 'internal',
          created_at     TEXT    NOT NULL
        );
      `);
      // Add retention_tier to existing source_meta if upgrading from v0.5.0
      try { db.exec(`ALTER TABLE source_meta ADD COLUMN retention_tier TEXT NOT NULL DEFAULT 'internal'`); } catch {}
    },
  },

  {
    id: 5,
    description: "Add rate_limits table for persistent per-project fetch budget",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          project_hash TEXT    NOT NULL,
          date         TEXT    NOT NULL,
          fetch_count  INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (project_hash, date)
        );
      `);
    },
  },

  {
    id: 6,
    description: "Add db_stats view for zc_status tool",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS db_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO db_meta(key, value) VALUES ('schema_version', '6');
        INSERT OR REPLACE INTO db_meta(key, value) VALUES ('created_at', datetime('now'));
      `);
    },
  },

  {
    id: 7,
    description: "Add project_meta table for cross-project search labels",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },

  // ── v0.7.0 migrations ────────────────────────────────────────────────────

  {
    id: 8,
    description: "Add broadcasts table for A2A shared coordination channel",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS broadcasts (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          type       TEXT    NOT NULL
                             CHECK(type IN ('ASSIGN','STATUS','PROPOSED','DEPENDENCY','MERGE','REJECT','REVISE')),
          agent_id   TEXT    NOT NULL DEFAULT 'default',
          task       TEXT    NOT NULL DEFAULT '',
          files      TEXT    NOT NULL DEFAULT '[]',
          state      TEXT    NOT NULL DEFAULT '',
          summary    TEXT    NOT NULL DEFAULT '',
          depends_on TEXT    NOT NULL DEFAULT '[]',
          reason     TEXT    NOT NULL DEFAULT '',
          importance INTEGER NOT NULL DEFAULT 3,
          created_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bc_type       ON broadcasts(type);
        CREATE INDEX IF NOT EXISTS idx_bc_agent      ON broadcasts(agent_id);
        CREATE INDEX IF NOT EXISTS idx_bc_created_at ON broadcasts(created_at DESC);
      `);
    },
  },

];

/**
 * Apply all pending migrations to the given database.
 * Each migration is wrapped in a transaction for atomicity.
 * Already-applied migrations are skipped.
 */
export function runMigrations(db: DatabaseSync): void {
  // Ensure the migrations tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL
    );
  `);

  for (const migration of MIGRATIONS) {
    const existing = db.prepare(
      "SELECT id FROM schema_migrations WHERE id = ?"
    ).get(migration.id);

    if (existing) continue; // already applied

    // Wrap each migration in a transaction for atomicity
    // If migration.up() throws, the transaction rolls back automatically
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_migrations(id, description, applied_at) VALUES (?, ?, ?)"
      ).run(migration.id, migration.description, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration ${migration.id} ("${migration.description}") failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

/** Returns the highest applied migration ID, or 0 if none applied yet. */
export function getCurrentSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare(
      "SELECT MAX(id) as v FROM schema_migrations"
    ).get() as { v: number | null };
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}
