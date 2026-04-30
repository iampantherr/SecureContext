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

  {
    id: 5,
    description: "v0.17.0 §8.2: task_queue_pg (work-stealing with FOR UPDATE SKIP LOCKED)",
    up: async (client) => {
      // Per HARNESS_EVOLUTION_PLAN.md §8.2 — work-stealing queue with
      // Postgres SKIP LOCKED. Workers claim atomically without blocking
      // each other on contention.
      await client.query(`
        CREATE TABLE IF NOT EXISTS task_queue_pg (
          task_id        TEXT PRIMARY KEY,
          project_hash   TEXT NOT NULL,
          role           TEXT NOT NULL,
          payload        JSONB NOT NULL,
          state          TEXT NOT NULL CHECK(state IN ('queued','claimed','done','failed')),
          claimed_by     TEXT,
          claimed_at     TIMESTAMPTZ,
          heartbeat_at   TIMESTAMPTZ,
          retries        INTEGER NOT NULL DEFAULT 0,
          ts             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          done_at        TIMESTAMPTZ,
          failure_reason TEXT
        )
      `);
      // Critical: index for the routing query (project + role + state + ts)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_tq_route
          ON task_queue_pg(project_hash, role, state, ts)
      `);
      // Heartbeat scan (find stale claims)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_tq_heartbeat
          ON task_queue_pg(state, heartbeat_at)
          WHERE state = 'claimed'
      `);
    },
  },

  {
    id: 6,
    description: "v0.18.0 Sprint 2: skills_pg — versioned hash-protected skill registry (mirror of SQLite migration 20)",
    up: async (client) => {
      // Mirrors SQLite skills table 1:1 so a skill can be promoted from
      // per-project (lives in SQLite) → global (lives in PG, queryable from
      // any machine with shared PG). Cross-project promotion (S2.5-4) walks
      // this PG table to find candidates.
      //
      // Note on JSONB: frontmatter is stored as JSONB (richer than SQLite
      // TEXT) so future querying ("which skills have requires_network=true?")
      // is index-able.
      await client.query(`
        CREATE TABLE IF NOT EXISTS skills_pg (
          skill_id        TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          version         TEXT NOT NULL,
          scope           TEXT NOT NULL,
          description     TEXT NOT NULL,
          frontmatter     JSONB NOT NULL,
          body            TEXT NOT NULL,
          body_hmac       TEXT NOT NULL,
          source_path     TEXT,
          promoted_from   TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at     TIMESTAMPTZ,
          archive_reason  TEXT
        )
      `);
      // Active-row uniqueness: only one (name, scope) live at a time
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_pg_active
          ON skills_pg(name, scope)
          WHERE archived_at IS NULL
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skills_pg_name_scope ON skills_pg(name, scope)`);
      // Cross-project promotion lookup
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skills_pg_name ON skills_pg(name) WHERE archived_at IS NULL`);
    },
  },

  {
    id: 7,
    description: "v0.18.0 Sprint 2: skill_runs_pg — execution telemetry (mirror of SQLite migration 21)",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_runs_pg (
          run_id         TEXT PRIMARY KEY,
          skill_id       TEXT NOT NULL,
          project_hash   TEXT NOT NULL,
          session_id     TEXT NOT NULL,
          task_id        TEXT,
          inputs         JSONB NOT NULL,
          outcome_score  NUMERIC(8,6),
          total_cost     NUMERIC(18,8),
          total_tokens   INTEGER,
          duration_ms    INTEGER,
          status         TEXT NOT NULL CHECK (status IN ('succeeded','failed','timeout')),
          failure_trace  TEXT,
          ts             TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sr_pg_skill_ts  ON skill_runs_pg(skill_id, ts DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sr_pg_status   ON skill_runs_pg(status, ts)`);
      // Cross-project query: find runs of a skill across projects
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sr_pg_skill_project ON skill_runs_pg(skill_id, project_hash, ts DESC)`);
    },
  },

  {
    id: 8,
    description: "v0.18.0 Sprint 2: skill_mutations_pg — proposal+replay+promotion ledger (mirror of SQLite migration 22)",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_mutations_pg (
          mutation_id           TEXT PRIMARY KEY,
          parent_skill_id       TEXT NOT NULL,
          project_hash          TEXT NOT NULL,
          candidate_body        TEXT NOT NULL,
          candidate_hmac        TEXT NOT NULL,
          proposed_by           TEXT NOT NULL,
          judged_by             TEXT,
          judge_score           NUMERIC(8,6),
          judge_rationale       TEXT,
          replay_score          NUMERIC(8,6),
          promoted              BOOLEAN NOT NULL DEFAULT FALSE,
          promoted_to_skill_id  TEXT,
          created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          resolved_at           TIMESTAMPTZ
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sm_pg_parent   ON skill_mutations_pg(parent_skill_id, created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sm_pg_promoted ON skill_mutations_pg(promoted, created_at)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sm_pg_project  ON skill_mutations_pg(project_hash, created_at DESC)`);
    },
  },

  {
    id: 9,
    description: "v0.18.1 Sprint 2.5: skill_promotion_queue_pg — operator-gated global promotion queue",
    up: async (client) => {
      // Mirror of SQLite migration 23. PG holds the canonical queue when
      // ZC_TELEMETRY_BACKEND=postgres|dual so cross-machine operators see
      // the same pending list.
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_promotion_queue_pg (
          candidate_skill_id  TEXT NOT NULL,
          proposed_target     TEXT NOT NULL DEFAULT 'global',
          surfaced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          surfaced_by         TEXT NOT NULL CHECK (surfaced_by IN ('cron','manual')),
          best_avg            NUMERIC(8,6),
          global_avg          NUMERIC(8,6),
          project_count       INTEGER,
          status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved','rejected','superseded')),
          decided_at          TIMESTAMPTZ,
          decided_by          TEXT,
          decision_rationale  TEXT,
          PRIMARY KEY (candidate_skill_id, proposed_target)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_spq_pg_status ON skill_promotion_queue_pg(status, surfaced_at)`);
    },
  },

  {
    id: 10,
    description: "v0.18.1: mutation_results_pg — side-channel for full-fidelity mutation candidate bodies (option-b)",
    up: async (client) => {
      // PG mirror of mutation_results (SQLite migration 24). Standard PG types
      // only — works on local PG, docker PG, RDS, Supabase, etc. No extensions
      // required.
      await client.query(`
        CREATE TABLE IF NOT EXISTS mutation_results_pg (
          result_id        TEXT PRIMARY KEY,
          mutation_id      TEXT NOT NULL,
          skill_id         TEXT NOT NULL,
          project_hash     TEXT NOT NULL,
          proposer_model   TEXT,
          proposer_role    TEXT,
          candidate_count  INTEGER NOT NULL,
          best_score       NUMERIC(8,6),
          bodies           TEXT NOT NULL,
          bodies_hash      TEXT NOT NULL,
          headline         TEXT,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          consumed_at      TIMESTAMPTZ,
          consumed_by      TEXT
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_mres_pg_mutation ON mutation_results_pg(mutation_id, created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_mres_pg_skill    ON mutation_results_pg(skill_id, created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_mres_pg_project  ON mutation_results_pg(project_hash, created_at DESC)`);
    },
  },

  {
    id: 11,
    description: "v0.18.2 Sprint 2.6: operator review columns on mutation_results_pg + skill_runs_pg",
    up: async (client) => {
      // Idempotent ADD COLUMN IF NOT EXISTS (PG 9.6+).
      await client.query(`ALTER TABLE mutation_results_pg ADD COLUMN IF NOT EXISTS original_task_id       TEXT`);
      await client.query(`ALTER TABLE mutation_results_pg ADD COLUMN IF NOT EXISTS original_role          TEXT`);
      await client.query(`ALTER TABLE mutation_results_pg ADD COLUMN IF NOT EXISTS consumed_decision      TEXT CHECK (consumed_decision IN ('approved','rejected') OR consumed_decision IS NULL)`);
      await client.query(`ALTER TABLE mutation_results_pg ADD COLUMN IF NOT EXISTS picked_candidate_index INTEGER`);
      await client.query(`ALTER TABLE skill_runs_pg       ADD COLUMN IF NOT EXISTS was_retry_after_promotion BOOLEAN NOT NULL DEFAULT FALSE`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_mres_pg_pending ON mutation_results_pg(project_hash, consumed_at, created_at DESC)`);
    },
  },

  {
    id: 12,
    description: "v0.18.4 Sprint 2.7: mutator_pool column + skill_revisions_pg audit ledger",
    up: async (client) => {
      await client.query(`ALTER TABLE mutation_results_pg ADD COLUMN IF NOT EXISTS mutator_pool TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_mres_pg_pool ON mutation_results_pg(mutator_pool, created_at DESC)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_revisions_pg (
          revision_id      TEXT PRIMARY KEY,
          skill_name       TEXT NOT NULL,
          scope            TEXT NOT NULL,
          from_version     TEXT,
          to_version       TEXT NOT NULL,
          action           TEXT NOT NULL CHECK (action IN ('promote','revert','manual')),
          source_result_id TEXT,
          reverted_to_body_of TEXT,
          decided_by       TEXT NOT NULL,
          rationale        TEXT,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skill_rev_pg_name ON skill_revisions_pg(skill_name, scope, created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skill_rev_pg_source ON skill_revisions_pg(source_result_id)`);
    },
  },

  {
    id: 13,
    description: "v0.18.8 Sprint 2.8: token_savings_snapshots_pg — 4h + daily rollups with per_tool + per_agent JSONB",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS token_savings_snapshots_pg (
          snapshot_id      TEXT PRIMARY KEY,
          project_hash     TEXT NOT NULL,
          cadence          TEXT NOT NULL CHECK (cadence IN ('4h','daily')),
          period_start     TIMESTAMPTZ NOT NULL,
          period_end       TIMESTAMPTZ NOT NULL,
          total_calls            INTEGER NOT NULL,
          total_actual_tokens    BIGINT  NOT NULL,
          total_actual_cost_usd  NUMERIC(18,8) NOT NULL,
          total_estimated_native_tokens BIGINT NOT NULL,
          total_saved_tokens     BIGINT  NOT NULL,
          total_saved_cost_usd   NUMERIC(18,8) NOT NULL,
          reduction_pct          NUMERIC(5,2)  NOT NULL,
          confidence             TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
          per_tool               JSONB NOT NULL,
          per_agent              JSONB NOT NULL,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(project_hash, cadence, period_start)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_savings_snapshots_pg_project ON token_savings_snapshots_pg(project_hash, cadence, period_start DESC)`);
    },
  },

  {
    id: 14,
    description: "v0.18.9 Sprint 2.9: project_paths_pg — hash → path resolution so the dashboard can show real project names instead of truncated hashes (Docker container cannot read the host's agents.json)",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_paths_pg (
          project_hash    TEXT PRIMARY KEY,
          project_path    TEXT NOT NULL,
          first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_project_paths_pg_last_seen ON project_paths_pg(last_seen_at DESC)`);
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
