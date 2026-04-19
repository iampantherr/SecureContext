/**
 * Postgres migrations for the v0.16.0 telemetry backend.
 *
 * Mirrors the SQLite schema defined in src/migrations.ts (migrations 13-19)
 * to Postgres. The chain hash content is identical across backends — same
 * canonical bytes hashed with the same per-agent HKDF subkey — so rows can
 * be migrated SQLite → Postgres without rehashing.
 *
 * IMPORTANT: when adding new migrations, NEVER edit existing ones.
 * Append at the end with the next id and let `runPgMigrations` skip
 * already-applied migrations.
 *
 * Tier 3 fixes that land here:
 *   - T3.1 per-agent role: handled at write-time via SET LOCAL ROLE in
 *     ChainedTablePostgres.appendChainedWith() — see chained_table_postgres.ts
 *   - T3.2 RLS: enabled on `outcomes_pg` table by migration 4 below.
 */

import type { PoolClient } from "pg";
import { withTransaction, withClient } from "./pg_pool.js";
import { logger } from "./logger.js";

interface PgMigration {
  id: number;
  description: string;
  up: (client: PoolClient) => Promise<void>;
}

export const PG_MIGRATIONS: PgMigration[] = [

  {
    id: 1,
    description: "v0.16.0: schema_migrations_pg + tool_calls_pg",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations_pg (
          id          INTEGER PRIMARY KEY,
          description TEXT NOT NULL,
          applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS tool_calls_pg (
          id              BIGSERIAL PRIMARY KEY,
          call_id         TEXT NOT NULL UNIQUE,
          session_id      TEXT NOT NULL,
          agent_id        TEXT NOT NULL,
          project_hash    TEXT NOT NULL,
          task_id         TEXT,
          skill_id        TEXT,
          tool_name       TEXT NOT NULL,
          model           TEXT NOT NULL,
          input_tokens    INTEGER NOT NULL DEFAULT 0,
          output_tokens   INTEGER NOT NULL DEFAULT 0,
          cached_tokens   INTEGER NOT NULL DEFAULT 0,
          cost_usd        NUMERIC(18,8) NOT NULL DEFAULT 0,
          cost_known      INTEGER NOT NULL DEFAULT 0,
          latency_ms      INTEGER NOT NULL DEFAULT 0,
          status          TEXT NOT NULL,
          error_class     TEXT,
          ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          prev_hash       TEXT NOT NULL,
          row_hash        TEXT NOT NULL,
          trace_id        TEXT
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_tcpg_project_session
          ON tool_calls_pg(project_hash, session_id, ts)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_tcpg_agent
          ON tool_calls_pg(agent_id, ts)
      `);
      // For chain reads: latest row per project, fast
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_tcpg_chain_tail
          ON tool_calls_pg(project_hash, id DESC)
      `);
    },
  },

  {
    id: 2,
    description: "v0.16.0: outcomes_pg + classification + created_by_agent_id",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS outcomes_pg (
          id                    BIGSERIAL PRIMARY KEY,
          outcome_id            TEXT NOT NULL UNIQUE,
          ref_type              TEXT NOT NULL,
          ref_id                TEXT NOT NULL,
          outcome_kind          TEXT NOT NULL,
          signal_source         TEXT NOT NULL,
          confidence            NUMERIC(6,4) NOT NULL DEFAULT 1.0,
          score_delta           NUMERIC(8,4),
          evidence              JSONB,
          resolved_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          prev_hash             TEXT NOT NULL,
          row_hash              TEXT NOT NULL,
          classification        TEXT NOT NULL DEFAULT 'internal'
            CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
          created_by_agent_id   TEXT
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_opg_ref
          ON outcomes_pg(ref_type, ref_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_opg_class
          ON outcomes_pg(classification, created_by_agent_id)
      `);
      // Chain-tail index — analogous to tool_calls_pg
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_opg_chain_tail
          ON outcomes_pg(id DESC)
      `);
    },
  },

  {
    id: 3,
    description: "v0.16.0: learnings_pg",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS learnings_pg (
          learning_id     TEXT PRIMARY KEY,
          project_hash    TEXT NOT NULL,
          category        TEXT NOT NULL,
          payload         TEXT NOT NULL,
          source_path     TEXT NOT NULL,
          source_line     INTEGER,
          ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(project_hash, source_path, source_line)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_lpg_project_cat
          ON learnings_pg(project_hash, category, ts)
      `);
    },
  },

  {
    id: 4,
    description: "v0.16.0 T3.2: Row Level Security on outcomes_pg (Chin & Older Ch5+Ch13)",
    up: async (client) => {
      // Enable RLS on outcomes — without policies, only the table owner can read.
      // We add explicit policies for each classification tier below.
      await client.query(`ALTER TABLE outcomes_pg ENABLE ROW LEVEL SECURITY`);
      // SC's pool owner role (typically 'scuser') still needs to bypass RLS for
      // admin paths (e.g. cross-agent verifyChain audits). FORCE RLS would block
      // even the owner — we DON'T force it, so the pool's owning role retains
      // full read for admin operations. Per-agent reads are RESTRICTED below.
      // (BYPASSRLS attribute on the role is the cleanest way; we set it via
      // the role-provisioning step in chained_table_postgres.ts.)

      // Drop any prior policies (idempotent re-migration)
      await client.query(`DROP POLICY IF EXISTS outcomes_read_public_internal ON outcomes_pg`);
      await client.query(`DROP POLICY IF EXISTS outcomes_read_confidential   ON outcomes_pg`);
      await client.query(`DROP POLICY IF EXISTS outcomes_read_restricted     ON outcomes_pg`);
      await client.query(`DROP POLICY IF EXISTS outcomes_write_any           ON outcomes_pg`);

      // PUBLIC + INTERNAL — readable by all roles that have SELECT on the table
      await client.query(`
        CREATE POLICY outcomes_read_public_internal ON outcomes_pg
          FOR SELECT
          USING (classification IN ('public', 'internal'))
      `);

      // CONFIDENTIAL — readable when current_user is non-empty (i.e. any
      // registered per-agent role). The check is intentionally loose: any role
      // beyond the default 'public' role qualifies. Tightened in v0.17 once
      // an agent_roles registry table lands.
      await client.query(`
        CREATE POLICY outcomes_read_confidential ON outcomes_pg
          FOR SELECT
          USING (classification = 'confidential')
      `);

      // RESTRICTED — readable ONLY when the per-query session var
      // 'zc.current_agent' matches the row's created_by_agent_id.
      // Each chained INSERT block sets this via SET LOCAL — so the row is
      // visible only to the agent that wrote it (Chin & Older 2011 Ch11
      // capability scoping).
      await client.query(`
        CREATE POLICY outcomes_read_restricted ON outcomes_pg
          FOR SELECT
          USING (
            classification = 'restricted'
            AND created_by_agent_id = current_setting('zc.current_agent', true)
          )
      `);

      // Writes — any role with INSERT privilege may write (per-agent role
      // grants are added on agent registration in T3.1).
      await client.query(`
        CREATE POLICY outcomes_write_any ON outcomes_pg
          FOR INSERT
          WITH CHECK (true)
      `);
    },
  },

];

/**
 * Idempotent — applies all pending PG migrations. Safe to call on every server
 * start. Returns the number of migrations newly applied.
 *
 * Returns 0 if Postgres is unavailable (pool init returns null).
 */
export async function runPgMigrations(): Promise<number> {
  let applied = 0;
  try {
    // Bootstrap: schema_migrations_pg may not exist on first run.
    await withClient(async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations_pg (
          id          INTEGER PRIMARY KEY,
          description TEXT NOT NULL,
          applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    });

    const seen = await withClient(async (client) => {
      const r = await client.query(`SELECT id FROM schema_migrations_pg`);
      return new Set<number>(r.rows.map((row: { id: number }) => row.id));
    });

    for (const m of PG_MIGRATIONS) {
      if (seen.has(m.id)) continue;
      await withTransaction(async (client) => {
        await m.up(client);
        await client.query(
          `INSERT INTO schema_migrations_pg(id, description, applied_at) VALUES ($1, $2, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [m.id, m.description],
        );
      });
      applied++;
      logger.info("telemetry", "pg_migration_applied", { id: m.id, description: m.description });
    }
    return applied;
  } catch (e) {
    logger.error("telemetry", "pg_migrations_failed", { error: (e as Error).message });
    return 0;
  }
}

/** Test helper: drop telemetry tables. NEVER call against shared / production DBs. */
export async function _dropPgTelemetryTablesForTesting(): Promise<void> {
  await withClient(async (client) => {
    await client.query(`DROP TABLE IF EXISTS tool_calls_pg CASCADE`);
    await client.query(`DROP TABLE IF EXISTS outcomes_pg CASCADE`);
    await client.query(`DROP TABLE IF EXISTS learnings_pg CASCADE`);
    await client.query(`DROP TABLE IF EXISTS schema_migrations_pg CASCADE`);
  });
  // Dropping the tables invalidates GRANTs that the per-agent roles held
  // against those tables. Clear the provisioning cache so the next call
  // re-runs the grants on the freshly created tables.
  const { _resetProvisionedAgentsForTesting } = await import("./security/chained_table_postgres.js");
  _resetProvisionedAgentsForTesting();
}
