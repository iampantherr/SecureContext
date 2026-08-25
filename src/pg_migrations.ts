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

  {
    id: 15,
    description: "v0.19.0 Sprint 2.10: skill_candidates_pg — pending skill proposals from REJECT clusters when no matching skill exists (closes the bootstrap loop: REJECT pattern → operator review → new skill in library)",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_candidates_pg (
          candidate_id        TEXT PRIMARY KEY,
          project_hash        TEXT NOT NULL,
          target_role         TEXT NOT NULL,
          rejection_count     INTEGER NOT NULL,
          first_rejection_at  TIMESTAMPTZ NOT NULL,
          last_rejection_at   TIMESTAMPTZ NOT NULL,
          rejection_outcomes  JSONB NOT NULL,
          headline            TEXT NOT NULL,
          proposed_skill_body TEXT,
          proposed_at         TIMESTAMPTZ,
          status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','generating','ready','approved','rejected','superseded')),
          reviewed_by         TEXT,
          reviewed_at         TIMESTAMPTZ,
          review_notes        TEXT,
          installed_skill_id  TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skill_candidates_status ON skill_candidates_pg(status, created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skill_candidates_project_role ON skill_candidates_pg(project_hash, target_role, status)`);
    },
  },

  {
    id: 16,
    description: "v0.22.0: full skill attribution — agent_id on skill_runs_pg + skill_run_tool_calls_pg correlation + mutation_reviews_pg operator audit",
    up: async (client) => {
      // Per-agent attribution. project_hash already exists on skill_runs_pg
      // (added in migration 7). Without agent_id we cannot ask "which agent
      // benefits most from this skill" — central self-improvement question.
      await client.query(`ALTER TABLE skill_runs_pg ADD COLUMN IF NOT EXISTS agent_id TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sr_pg_agent ON skill_runs_pg(agent_id, ts DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sr_pg_agent_project ON skill_runs_pg(agent_id, project_hash, ts DESC)`);

      // skill_run_tool_calls_pg — links each skill_run to the tool_calls it
      // contained. The MCP server's currentSkillContext accumulates call_ids
      // between zc_skill_show and zc_record_skill_outcome; that list lands
      // here. Lets the dashboard show "what did the agent actually do during
      // this run" — the missing trace for skill failures.
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_run_tool_calls_pg (
          run_id    TEXT NOT NULL,
          call_id   TEXT NOT NULL,
          ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (run_id, call_id)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_srtc_pg_run ON skill_run_tool_calls_pg(run_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_srtc_pg_call ON skill_run_tool_calls_pg(call_id)`);

      // mutation_reviews_pg — operator action log. Every approve/reject/defer
      // on the dashboard logs here so we can audit "who did what when, why."
      // Without this we lose the entire human-in-the-loop trail.
      await client.query(`
        CREATE TABLE IF NOT EXISTS mutation_reviews_pg (
          review_id      TEXT PRIMARY KEY,
          mutation_id    TEXT NOT NULL,
          result_id      TEXT,
          action         TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'defer')),
          operator       TEXT NOT NULL,
          rationale      TEXT,
          ts             TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_mr_pg_mutation ON mutation_reviews_pg(mutation_id, ts DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_mr_pg_operator ON mutation_reviews_pg(operator, ts DESC)`);
    },
  },

  {
    id: 17,
    description: "v0.22.5: read_redirects_pg — track PreRead hook L0/L1 summary intercepts so dashboard reflects the real token savings (every successful redirect saves ~95% on that file's Read tokens, but hooks don't write to tool_calls_pg so this was invisible to the dashboard prior to v0.22.5)",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS read_redirects_pg (
          id                  BIGSERIAL PRIMARY KEY,
          project_hash        TEXT NOT NULL,
          agent_id            TEXT NOT NULL,
          file_path           TEXT NOT NULL,
          full_file_tokens    INTEGER NOT NULL,
          summary_tokens      INTEGER NOT NULL,
          saved_tokens        INTEGER GENERATED ALWAYS AS (full_file_tokens - summary_tokens) STORED,
          ts                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_rr_pg_project_ts ON read_redirects_pg(project_hash, ts DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_rr_pg_agent_ts ON read_redirects_pg(agent_id, ts DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_rr_pg_project_agent_ts ON read_redirects_pg(project_hash, agent_id, ts DESC)`);
    },
  },

  {
    id: 18,
    description: "v0.22.7: summarizer_events_pg — telemetry for every L0/L1 summarization (success, fallback-truncation, error). Source_meta is the per-file STATE table; this is the EVENT log so the operator can see when summaries are created, which model was used, how long they took, and what failed. The state-vs-events split mirrors how tool_calls_pg pairs with the working_memory state.",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS summarizer_events_pg (
          id                  BIGSERIAL PRIMARY KEY,
          project_hash        TEXT NOT NULL,
          agent_id            TEXT NOT NULL DEFAULT 'default',
          source              TEXT NOT NULL,
          source_size_bytes   INTEGER NOT NULL DEFAULT 0,
          l0_length           INTEGER NOT NULL DEFAULT 0,
          l1_length           INTEGER NOT NULL DEFAULT 0,
          duration_ms         INTEGER NOT NULL DEFAULT 0,
          model               TEXT,
          summary_source      TEXT NOT NULL,
          status              TEXT NOT NULL,
          error_message       TEXT,
          ts                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_se_summary_source CHECK (summary_source IN ('ast', 'semantic', 'truncation', 'unknown')),
          CONSTRAINT chk_se_status         CHECK (status IN ('ok', 'fallback_truncation', 'error', 'skipped'))
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_se_pg_project_ts ON summarizer_events_pg(project_hash, ts DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_se_pg_status_ts  ON summarizer_events_pg(status, ts DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_se_pg_agent_ts   ON summarizer_events_pg(agent_id, ts DESC)`);
    },
  },

  {
    id: 19,
    description: "v0.22.9: pretool_events_pg — generic observability for the PreRead/PreEdit hooks. read_redirects_pg only logs the SUCCESS path (file was indexed, redirect happened); this table logs EVERY hook invocation regardless of outcome (redirect, block, bypass, error) so the operator can see if the hook is firing at all and what the outcome distribution looks like. Diagnoses the 'read_redirects=0 forever' silent-failure mode that bit us in the post-v0.22.5 audit.",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS pretool_events_pg (
          id            BIGSERIAL PRIMARY KEY,
          project_hash  TEXT NOT NULL,
          agent_id      TEXT NOT NULL DEFAULT 'default',
          tool_name     TEXT NOT NULL,
          file_path     TEXT,
          outcome       TEXT NOT NULL,
          detail        TEXT,
          ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_pte_outcome CHECK (outcome IN (
            'redirect',
            'block_unindexed',
            'block_dedup',
            'bypass_force_read',
            'bypass_partial_read',
            'pass_through',
            'error'
          ))
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_pte_project_ts ON pretool_events_pg(project_hash, ts DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_pte_outcome_ts ON pretool_events_pg(outcome, ts DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_pte_agent_ts   ON pretool_events_pg(agent_id, ts DESC)`);
    },
  },

  {
    id: 20,
    description: "v0.23.0 Phase 1 #1: skill_security_scans_pg — audit log for the 8-point security scan that gates every skill before it lands in skills_pg. Captures the body hash being scanned, score (0-8), pass/fail, and structured failure detail per check. Operator-visible via the dashboard 'Security scans' panel.",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_security_scans_pg (
          id              BIGSERIAL PRIMARY KEY,
          skill_id        TEXT NOT NULL,
          candidate_hmac  TEXT,
          body_hash       TEXT NOT NULL,
          score           INTEGER NOT NULL,
          passed          BOOLEAN NOT NULL,
          failures        JSONB NOT NULL DEFAULT '[]'::jsonb,
          source          TEXT NOT NULL DEFAULT 'unknown',
          scanned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_sss_score    CHECK (score BETWEEN 0 AND 8),
          CONSTRAINT chk_sss_source   CHECK (source IN ('mutator', 'marketplace', 'operator', 'auto-import', 'unknown'))
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sss_skill_ts   ON skill_security_scans_pg(skill_id, scanned_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sss_passed_ts  ON skill_security_scans_pg(passed, scanned_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sss_source_ts  ON skill_security_scans_pg(source, scanned_at DESC)`);
    },
  },

  {
    id: 21,
    description: "v0.23.0 Phase 1 F: skill_runs_pg.is_exemplar + tagging metadata. Operator clicks ⭐ on the dashboard to flag a skill_run as a textbook example. The mutator pulls these as positive training signal when generating new candidates — turning a human's qualitative judgment into a measurable input to the improvement loop.",
    up: async (client) => {
      // Add columns to skill_runs_pg (idempotent: IF NOT EXISTS)
      await client.query(`ALTER TABLE skill_runs_pg ADD COLUMN IF NOT EXISTS is_exemplar BOOLEAN NOT NULL DEFAULT FALSE`);
      await client.query(`ALTER TABLE skill_runs_pg ADD COLUMN IF NOT EXISTS exemplar_tagged_by TEXT`);
      await client.query(`ALTER TABLE skill_runs_pg ADD COLUMN IF NOT EXISTS exemplar_tagged_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE skill_runs_pg ADD COLUMN IF NOT EXISTS exemplar_note TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skill_runs_exemplar ON skill_runs_pg(skill_id, is_exemplar) WHERE is_exemplar = TRUE`);
    },
  },

  {
    id: 22,
    description: "v0.24.0 Phase 2: skill_marketplace_pulls_pg — audit log for marketplace skill pulls. Every pull attempt (operator-triggered or future cron) writes one row per skill: source repo, source commit SHA at pull time, the candidate's lint+scan verdict, decision (added / rejected_lint / rejected_scan / already_exists / stale_version / error), reason. Operator-visible via the dashboard 'Marketplace pulls' panel; lets the operator see ALL historic pulls — what was added, what was rejected, why — without losing audit trail.",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_marketplace_pulls_pg (
          id                BIGSERIAL PRIMARY KEY,
          pull_id           UUID NOT NULL,
          source            TEXT NOT NULL,
          source_commit     TEXT,
          source_path       TEXT,
          skill_name        TEXT NOT NULL,
          skill_version     TEXT,
          skill_scope       TEXT,
          candidate_skill_id TEXT,
          candidate_body_hash TEXT,
          lint_passed       BOOLEAN,
          lint_errors       JSONB,
          lint_warnings     JSONB,
          scan_score        INTEGER,
          scan_passed       BOOLEAN,
          scan_block_failures JSONB,
          decision          TEXT NOT NULL,
          decision_reason   TEXT,
          pulled_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          pulled_by         TEXT NOT NULL DEFAULT 'operator',
          CONSTRAINT chk_smp_decision CHECK (decision IN (
            'added', 'rejected_lint', 'rejected_scan', 'already_exists',
            'stale_version', 'error'
          ))
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_smp_pull_id    ON skill_marketplace_pulls_pg(pull_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_smp_pulled_at  ON skill_marketplace_pulls_pg(pulled_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_smp_decision   ON skill_marketplace_pulls_pg(decision, pulled_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_smp_skill_name ON skill_marketplace_pulls_pg(skill_name, pulled_at DESC)`);
    },
  },

  {
    id: 23,
    description: "v0.24.1: skill_marketplace_pulls_pg.candidate_body + candidate_frontmatter — store the actual content that was attempted (rejected ones especially). Without this, operator can't see what was inside a rejected skill — they'd have to re-fetch from GitHub. With it: 'View body' button on rejected pulls, operator can decide whether to manually trim + retry.",
    up: async (client) => {
      await client.query(`ALTER TABLE skill_marketplace_pulls_pg ADD COLUMN IF NOT EXISTS candidate_body TEXT`);
      await client.query(`ALTER TABLE skill_marketplace_pulls_pg ADD COLUMN IF NOT EXISTS candidate_frontmatter JSONB`);
    },
  },

  {
    id: 24,
    description: "v0.26.0 Step 2: support Anthropic-style filesystem skills at ~/.claude/skills/<name>/ with bundled scripts. Adds (a) skill_dir TEXT to record absolute path of the source directory, (b) script_hmacs JSONB to fingerprint every script file inside scripts/ for tamper detection, (c) quarantined BOOLEAN + quarantine_reason TEXT to support the Step 3 quarantine model, (d) extends chk_sss_source CHECK constraint to allow source='filesystem'. All additive (default NULL/FALSE); existing flat-file skills are unaffected.",
    up: async (client) => {
      await client.query(`ALTER TABLE skills_pg ADD COLUMN IF NOT EXISTS skill_dir TEXT`);
      await client.query(`ALTER TABLE skills_pg ADD COLUMN IF NOT EXISTS script_hmacs JSONB`);
      await client.query(`ALTER TABLE skills_pg ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT FALSE`);
      await client.query(`ALTER TABLE skills_pg ADD COLUMN IF NOT EXISTS quarantine_reason TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skills_pg_quarantined ON skills_pg (quarantined) WHERE quarantined = TRUE`);
      // Allow source='filesystem' in skill_security_scans_pg (was added in migration 20)
      await client.query(`ALTER TABLE skill_security_scans_pg DROP CONSTRAINT IF EXISTS chk_sss_source`);
      await client.query(`ALTER TABLE skill_security_scans_pg ADD CONSTRAINT chk_sss_source CHECK (source IN ('mutator', 'marketplace', 'operator', 'auto-import', 'unknown', 'filesystem'))`);
    },
  },

  {
    id: 25,
    description: "v0.26.0 Step 6: HMAC-chained skill admission log (tamper-evident audit trail for every admit/quarantine decision)",
    up: async (client) => {
      // Tamper-evident log of every skill admission decision. Each row is HMAC-keyed
      // with the machine_secret. Chained via prev_hash → row_hash so any insertion,
      // deletion, or modification breaks the chain on verification.
      //
      // Additionally, every row is mirrored to ~/.claude/zc-ctx/logs/audit.log as a
      // JSONL line (external anchor). If the DB row is altered/deleted, the audit.log
      // line still attests to the prev_hash, row_hash, and canonical row content —
      // a second-line defense.
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_admission_log_pg (
          id              BIGSERIAL PRIMARY KEY,
          ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          event           TEXT NOT NULL,
            -- one of: admitted, updated, quarantined_scan, quarantined_frontmatter, parse_error
          skill_name      TEXT NOT NULL,
          skill_version   TEXT,
          skill_scope     TEXT,
          skill_dir       TEXT NOT NULL,
          body_hmac       TEXT,
          script_count    INTEGER NOT NULL DEFAULT 0,
          quarantined     BOOLEAN NOT NULL DEFAULT FALSE,
          reason          TEXT,
          prev_hash       TEXT NOT NULL,
          row_hash        TEXT NOT NULL,
          CONSTRAINT chk_sal_event CHECK (event IN ('admitted','updated','quarantined_scan','quarantined_frontmatter','parse_error','skipped_idempotent'))
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skill_admission_log_pg_ts ON skill_admission_log_pg (ts DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skill_admission_log_pg_skill ON skill_admission_log_pg (skill_name, ts DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skill_admission_log_pg_quarantined ON skill_admission_log_pg (quarantined) WHERE quarantined = TRUE`);
    },
  },

  {
    id: 26,
    description: "v0.28.0-α: skill-spotter dry-run tables (signal mining, no LLM yet)",
    up: async (client) => {
      // Tracks each spotter run — when it ran, what window it scanned, how
      // many signals it emitted. Operator-paced via the dashboard "Run
      // spotter" button OR a future cron. v0.28.0-α is dry-run only: signals
      // are surfaced, no candidates are filed and no LLM is invoked. The β
      // step adds the Sonnet-4.6-high-thinking agent that turns signals into
      // skill_candidates_pg rows.
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_spotter_runs_pg (
          run_id           UUID PRIMARY KEY,
          started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finished_at      TIMESTAMPTZ,
          window_days      INTEGER NOT NULL,
          window_start     TIMESTAMPTZ NOT NULL,
          window_end       TIMESTAMPTZ NOT NULL,
          mode             TEXT NOT NULL DEFAULT 'dry-run',
            -- one of: dry-run, llm-proposed (β), llm-approved (γ)
          signals_emitted  INTEGER NOT NULL DEFAULT 0,
          candidates_filed INTEGER NOT NULL DEFAULT 0,
          duration_ms      INTEGER,
          notes            TEXT,
          CONSTRAINT chk_sspr_mode CHECK (mode IN ('dry-run', 'llm-proposed', 'llm-approved'))
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skill_spotter_runs_pg_started ON skill_spotter_runs_pg (started_at DESC)`);

      // Each signal a detector emitted on that run. JSONB evidence holds
      // the session_ids / tool_call_ids the detector grouped together so
      // operator can drill in.
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_spotter_signals_pg (
          signal_id           BIGSERIAL PRIMARY KEY,
          run_id              UUID NOT NULL REFERENCES skill_spotter_runs_pg(run_id) ON DELETE CASCADE,
          signal_type         TEXT NOT NULL,
            -- repeated_tool_sequence | external_script_invocation | (more in γ)
          occurrences         INTEGER NOT NULL,
          confidence          NUMERIC(3,2) NOT NULL DEFAULT 0.5,
          evidence            JSONB NOT NULL,
          proposed_trigger    TEXT,
          proposed_steps      JSONB,
          proposed_name_hint  TEXT,
          effort_estimate     TEXT,
          outcome             TEXT NOT NULL DEFAULT 'observed',
            -- observed (α) | filed_candidate (β+) | rejected_low_signal | rejected_duplicate | rejected_not_procedural
          outcome_reason      TEXT,
          candidate_id        UUID,  -- FK to skill_candidates_pg, populated by β step
          CONSTRAINT chk_ssp_signal_type CHECK (signal_type IN (
            'repeated_tool_sequence',
            'external_script_invocation',
            'repeated_prompt_fragment',
            'uncredited_high_cost_task',
            'rejected_mutation_cluster',
            'repeated_doc_read'
          )),
          CONSTRAINT chk_ssp_outcome CHECK (outcome IN (
            'observed',
            'filed_candidate',
            'rejected_low_signal',
            'rejected_duplicate',
            'rejected_not_procedural',
            'rejected_fits_in_prompt',
            'rejected_variable_instances'
          ))
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skill_spotter_signals_pg_run ON skill_spotter_signals_pg (run_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skill_spotter_signals_pg_type ON skill_spotter_signals_pg (signal_type)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skill_spotter_signals_pg_outcome ON skill_spotter_signals_pg (outcome)`);
    },
  },

  {
    id: 27,
    description: "v0.30.8: evidence JSONB on skill_runs_pg — structured what_worked/what_didnt/recommendation_for_skill from zc_record_skill_outcome (mutator learning signal; mirrors SQLite migration 29)",
    up: async (client) => {
      // Before this column, only 2/91 runs carried any improvement evidence —
      // agents recorded scores but never WHY, starving the mutator. The tool
      // layer now requires what_didnt + recommendation_for_skill on failed or
      // low-scoring (<0.6) runs and persists them here.
      await client.query(`ALTER TABLE skill_runs_pg ADD COLUMN IF NOT EXISTS evidence JSONB`);
    },
  },

  {
    id: 28,
    description: "v0.31.0: kb_edges_pg + kb_backlinks_pg — persistent typed knowledge graph + backlink in-degree, project_hash-scoped (mirrors SQLite migration 30)",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS kb_edges_pg (
          project_hash  TEXT    NOT NULL,
          from_source   TEXT    NOT NULL,
          to_source     TEXT    NOT NULL,
          relation_type TEXT    NOT NULL DEFAULT 'code_ref',
          match_kind    TEXT    NOT NULL DEFAULT 'full_key',
          weight        INTEGER NOT NULL DEFAULT 1,
          computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (project_hash, from_source, to_source, relation_type)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_kbe_pg_to ON kb_edges_pg(project_hash, to_source)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS kb_backlinks_pg (
          project_hash TEXT    NOT NULL,
          source       TEXT    NOT NULL,
          in_degree    INTEGER NOT NULL DEFAULT 0,
          weighted_in  INTEGER NOT NULL DEFAULT 0,
          computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (project_hash, source)
        )
      `);
    },
  },

  {
    id: 29,
    description: "v0.31.0: working_memory epistemology layer (kind|confidence|resolution_status|resolved_at) + provenance parity backfill (mirrors SQLite migrations 31 + 16)",
    up: async (client) => {
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS provenance TEXT NOT NULL DEFAULT 'UNKNOWN'`);
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'fact'`);
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS confidence REAL`);
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS resolution_status TEXT`);
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`);
      // CHECK constraints added separately + guarded (ADD CONSTRAINT has no IF NOT EXISTS pre-PG15)
      await client.query(`DO $$ BEGIN ALTER TABLE working_memory ADD CONSTRAINT chk_wm_provenance CHECK (provenance IN ('EXTRACTED','INFERRED','AMBIGUOUS','UNKNOWN')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
      await client.query(`DO $$ BEGIN ALTER TABLE working_memory ADD CONSTRAINT chk_wm_kind CHECK (kind IN ('fact','decision','hypothesis','prediction')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
      await client.query(`DO $$ BEGIN ALTER TABLE working_memory ADD CONSTRAINT chk_wm_resolution CHECK (resolution_status IN ('open','resolved_correct','resolved_incorrect','resolved_partial')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_wm_kind ON working_memory(project_hash, agent_id, kind, resolution_status)`);
    },
  },

  {
    id: 30,
    description: "v0.31.0: memory_contradictions_pg — suspected-contradiction signals over working memory, project_hash-scoped (mirrors SQLite migration 32)",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS memory_contradictions_pg (
          id            BIGSERIAL PRIMARY KEY,
          project_hash  TEXT NOT NULL,
          agent_id      TEXT NOT NULL,
          key_a         TEXT NOT NULL,
          key_b         TEXT NOT NULL,
          similarity    REAL NOT NULL,
          reason        TEXT NOT NULL,
          detail        TEXT,
          status        TEXT NOT NULL DEFAULT 'open',
          surfaced_by   TEXT NOT NULL,
          surfaced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reviewed_at   TIMESTAMPTZ,
          UNIQUE(project_hash, agent_id, key_a, key_b)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_mc_pg_status ON memory_contradictions_pg(project_hash, agent_id, status, surfaced_at DESC)`);
    },
  },

  {
    id: 31,
    description: "v0.32.0: recency-decay/salience on working_memory (access_count + last_retrieved_at) — secondary recall signal under importance (mirrors SQLite migration 33)",
    up: async (client) => {
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0`);
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS last_retrieved_at TIMESTAMPTZ`);
    },
  },

  {
    id: 32,
    description: "v0.37.0: temporal fact retirement — valid_to/superseded_by/retired_reason on working_memory + resolution_mode on memory_contradictions_pg (mirrors SQLite migration 34)",
    up: async (client) => {
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`);
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS superseded_by TEXT`);
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS retired_reason TEXT`);
      await client.query(`ALTER TABLE memory_contradictions_pg ADD COLUMN IF NOT EXISTS resolution_mode TEXT`);
      await client.query(`ALTER TABLE source_meta ADD COLUMN IF NOT EXISTS entity_scanned_at TIMESTAMPTZ`);  // v0.37.0 entity-extraction marker
      await client.query(`CREATE INDEX IF NOT EXISTS idx_wm_pg_live ON working_memory(project_hash, agent_id, valid_to)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS kb_community_summaries_pg (
          project_hash   TEXT    NOT NULL,
          community_id   INTEGER NOT NULL,
          size           INTEGER NOT NULL,
          sample_sources TEXT    NOT NULL,
          summary        TEXT    NOT NULL,
          computed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (project_hash, community_id)
        )
      `);
    },
  },

  {
    id: 33,
    description: "v0.38.0: per-claim citations — origin column on working_memory (mirrors SQLite migration 35)",
    up: async (client) => {
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS origin TEXT`);
    },
  },

  {
    id: 34,
    description: "v0.39.0: content-addressable embeddings — content_hash for dedup + model migration (mirrors SQLite migration 36)",
    up: async (client) => {
      await client.query(`ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS content_hash TEXT`);
    },
  },

  {
    id: 35,
    description: "M3 (v0.41.0): bi-temporal-lite — optional EVENT-time valid_at/invalid_at on working_memory alongside the transaction timeline (mirrors SQLite migration 37)",
    up: async (client) => {
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS valid_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS invalid_at TIMESTAMPTZ`);
    },
  },

  {
    id: 36,
    description: "R1 (v0.42.0): per-fact TTL — nullable expires_at on working_memory (mirrors SQLite migration 38)",
    up: async (client) => {
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
    },
  },

  {
    id: 37,
    description: "S8 (v0.44.0): durable task graph — depends_on + plan_id on task_queue_pg. A task with unfinished dependencies is not claimable; completing the last dependency unblocks dependents automatically (no coordinator action). plan_id groups a multi-step plan so agents can resume it after a crash. NOTE: the task queue is inherently PG-only (multi-agent coordination requires the shared store) — no SQLite twin exists to mirror.",
    up: async (client) => {
      await client.query(`ALTER TABLE task_queue_pg ADD COLUMN IF NOT EXISTS depends_on TEXT[] NOT NULL DEFAULT '{}'`);
      await client.query(`ALTER TABLE task_queue_pg ADD COLUMN IF NOT EXISTS plan_id TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_tq_plan ON task_queue_pg(project_hash, plan_id) WHERE plan_id IS NOT NULL`);
    },
  },

  {
    id: 38,
    description: "S3 (v0.46.0): team/multi-user memory — users_pg + api_keys_pg (per-user API keys, sha256-hashed, revocable), workspaces_pg + workspace_members_pg (shared memory scopes addressed as workspace:<slug> virtual project paths), and working_memory.created_by attribution (mirrors SQLite migration 39). Control plane (user/key/workspace CRUD) is master-key-only; user keys authenticate the data plane with per-write attribution.",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users_pg (
          user_id      TEXT PRIMARY KEY,
          display_name TEXT,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          disabled_at  TIMESTAMPTZ
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS api_keys_pg (
          key_id       BIGSERIAL PRIMARY KEY,
          user_id      TEXT NOT NULL REFERENCES users_pg(user_id),
          key_hash     TEXT NOT NULL UNIQUE,
          key_prefix   TEXT NOT NULL,
          label        TEXT,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at TIMESTAMPTZ,
          revoked_at   TIMESTAMPTZ
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys_pg(user_id)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspaces_pg (
          workspace_id TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          created_by   TEXT,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspace_members_pg (
          workspace_id TEXT NOT NULL REFERENCES workspaces_pg(workspace_id) ON DELETE CASCADE,
          user_id      TEXT NOT NULL REFERENCES users_pg(user_id),
          role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
          added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (workspace_id, user_id)
        )
      `);
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS created_by TEXT`);
    },
  },

  {
    id: 39,
    description: "D1 (v0.46.1): program memory — programs_pg + program_phases_pg. A PROGRAM is a named multi-phase delivery effort over a project; phases carry ordinal, status, an acceptance-checklist memory key, and an auto-generated close-out checkpoint. Powers zc_program (define/status/close_phase) and the orchestrator handoff test. PG-only by design (multi-agent coordination lives in the shared store; no SQLite twin — same precedent as task_queue_pg).",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS programs_pg (
          program_id   TEXT PRIMARY KEY,
          project_hash TEXT NOT NULL,
          name         TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS program_phases_pg (
          program_id     TEXT NOT NULL REFERENCES programs_pg(program_id) ON DELETE CASCADE,
          phase_id       TEXT NOT NULL,
          ordinal        INTEGER NOT NULL,
          title          TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','open','closed')),
          acceptance_key TEXT,
          opened_at      TIMESTAMPTZ,
          closed_at      TIMESTAMPTZ,
          checkpoint     TEXT,
          PRIMARY KEY (program_id, phase_id)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_pp_project ON programs_pg(project_hash, status)`);
    },
  },

  {
    id: 40,
    description: "Fix (v0.46.1): relax chk_sss_score. v0.37.0 (Tier-1 #6) widened the admission scan from 8 to 11 checks and made the gating RELATIVE (maxScore - score), but the skill_security_scans_pg CHECK constraint still capped score at 8 — so every CLEAN skill (score 9-11) failed its scan-row INSERT and the boot backfill logged failures forever (measured: 'scanned=9 passed=0 failed=9' every boot). New bound 0..32 leaves headroom for future breadth additions; gating stays relative in code.",
    up: async (client) => {
      await client.query(`ALTER TABLE skill_security_scans_pg DROP CONSTRAINT IF EXISTS chk_sss_score`);
      await client.query(`ALTER TABLE skill_security_scans_pg ADD CONSTRAINT chk_sss_score CHECK (score BETWEEN 0 AND 32)`);
    },
  },

  {
    id: 41,
    description: "TKG-T1 (v0.47.0): KB bi-temporality. knowledge_entries.created_at is BUMPED on every re-index, so 'when did we first learn this' was unanswerable and file dates clustered on the last index day (breaking event ordering in temporal Timelines). first_seen_at is IMMUTABLE (set once, backfilled from created_at), last_indexed_at tracks freshness (backfilled from created_at, bumped by index()). Mirrors Graphiti's transaction-time axis on the KB.",
    up: async (client) => {
      await client.query(`ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS last_indexed_at TIMESTAMPTZ`);
      await client.query(`UPDATE knowledge_entries SET first_seen_at = created_at::timestamptz WHERE first_seen_at IS NULL`);
      await client.query(`UPDATE knowledge_entries SET last_indexed_at = created_at::timestamptz WHERE last_indexed_at IS NULL`);
    },
  },

  {
    id: 42,
    description: "TKG-T3 (v0.47.0): world-time invalidation — invalid_from on working_memory records WHEN a fact stopped being true in the world (vs valid_to = when the SYSTEM retired it). Completes the four-timestamp bi-temporal model (created_at/valid_to system time + valid_at/invalid_from world time). Set by the invalidation loop to the superseding fact's timestamp.",
    up: async (client) => {
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS invalid_from TIMESTAMPTZ`);
    },
  },
  {
    id: 44,
    description: "Pinned memory kinds (v0.51.0): widen chk_wm_kind to admit 'constraint' and 'antipattern'. These render first on recall and are exempt from budget truncation (see memory_quality.ts). Caught by a live E2E: the app accepted kind:'constraint', the write returned SUCCESS, and the value was silently coerced by the validation whitelist — while this CHECK would have rejected it outright had it reached the DB. A pinned kind that cannot be stored is not a feature, and a write that reports success while discarding a field is the exact silent-failure class this release is meant to defend against.",
    up: async (client) => {
      await client.query(`ALTER TABLE working_memory DROP CONSTRAINT IF EXISTS chk_wm_kind`);
      await client.query(
        `ALTER TABLE working_memory ADD CONSTRAINT chk_wm_kind ` +
        `CHECK (kind IN ('fact','decision','hypothesis','prediction','constraint','antipattern'))`);
    },
  },
  {
    id: 43,
    description: "Operator inbox (v0.50.0): durable questions from orchestrators to the HUMAN operator, answered from the dashboard and delivered back to the agent terminal by the dispatcher. Born from a live incident (2026-07-27 #2840): an orchestrator's question to the operator was silently dropped by the dispatcher's worker-targeted routing, and only log-tailing prevented an indefinite block. PG-only, like the task queue and zc_program (documented enterprise-feature class).",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS operator_inbox_pg (
          id           BIGSERIAL PRIMARY KEY,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          project_path TEXT NOT NULL,
          project_hash TEXT NOT NULL DEFAULT '',
          broadcast_id BIGINT,
          from_agent   TEXT NOT NULL DEFAULT 'orchestrator',
          question     TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','answered','delivered','dismissed')),
          answer       TEXT,
          answered_at  TIMESTAMPTZ,
          answered_by  TEXT,
          delivered_at TIMESTAMPTZ
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS operator_inbox_status_idx ON operator_inbox_pg (status, created_at DESC)`);
    },
  },
  {
    id: 45,
    description:
      "v0.54.2: widen chk_pte_outcome to Config.PRETOOL_OUTCOMES. The allowed-outcome " +
      "list lived in TWO places - an array in api-server.ts and this CHECK constraint. " +
      "Adding 'pass_brief_exempt' to the array alone left the constraint rejecting the " +
      "insert, so a new hook detector was unobservable: its telemetry was refused by the " +
      "database while the endpoint still answered HTTP 200. Derived from one source now.",
    up: async (client) => {
      const { Config: C } = await import("./config.js");
      const list = C.PRETOOL_OUTCOMES.map((o: string) => `'${o}'`).join(", ");
      await client.query(`ALTER TABLE pretool_events_pg DROP CONSTRAINT IF EXISTS chk_pte_outcome`);
      await client.query(
        `ALTER TABLE pretool_events_pg ADD CONSTRAINT chk_pte_outcome CHECK (outcome IN (${list}))`);
    },
  },
  {
    id: 46,
    description:
      "KB communities in PG (PG-first parity). zc_kb_cluster/zc_kb_community_for read " +
      "local SQLite while proxy-mode zc_index writes PG, so a freshly indexed source was " +
      "invisible to a cluster run seconds later (live E2E 2026-08-04, E2E_ANALYSIS group).",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS kb_communities_pg (
          project_hash TEXT NOT NULL,
          source       TEXT NOT NULL,
          community_id INTEGER NOT NULL,
          computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (project_hash, source)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS kb_communities_pg_cid_idx ON kb_communities_pg (project_hash, community_id)`);
    },
  },
  {
    id: 47,
    description:
      "Broadcast attribution fix: sender_agent_id — agent_id means TARGET on ASSIGN but SENDER " +
      "elsewhere, so stored history misattributed who spoke (A2A #3070 proof case). Backfill " +
      "copies agent_id where it truly was the sender; ASSIGN rows stay NULL (unknown, not fabricated).",
    up: async (client) => {
      await client.query(`ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS sender_agent_id TEXT`);
      await client.query(`UPDATE broadcasts SET sender_agent_id = agent_id WHERE sender_agent_id IS NULL AND type <> 'ASSIGN'`);
    },
  },
  {
    id: 48,
    description:
      "Re-derive chk_pte_outcome from Config.PRETOOL_OUTCOMES (same body as migration 45). " +
      "The v0.55.x hook outcomes (pass_edit_mode, pass_bypass_learned, pass_below_breakeven) " +
      "were emitted but never listed, so the API rejected them and hook telemetry silently " +
      "vanished — observed live 2026-08-04. Also adds impact_write_deny (write-hook telemetry).",
    up: async (client) => {
      const { Config: C } = await import("./config.js");
      const list = C.PRETOOL_OUTCOMES.map((o: string) => `'${o}'`).join(", ");
      await client.query(`ALTER TABLE pretool_events_pg DROP CONSTRAINT IF EXISTS chk_pte_outcome`);
      await client.query(
        `ALTER TABLE pretool_events_pg ADD CONSTRAINT chk_pte_outcome CHECK (outcome IN (${list}))`);
    },
  },
  {
    id: 49,
    description:
      "Executable evidence records (v0.57.0). A finding's evidence was prose plus a screenshot — " +
      "neither re-runnable, and neither recording WHERE a probe ran. Live incident 2026-08-05: a QA " +
      "sweep probed the HUB for a URL the CONSOLE serves, reported a 404 that was real at the wrong " +
      "layer, and proposed a 'fix' that would have broken a working page. target_context is the field " +
      "whose absence made that indistinguishable; probe_command + observed_output make it re-runnable.",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS evidence_pg (
          id              BIGSERIAL PRIMARY KEY,
          project_hash    TEXT NOT NULL,
          agent_id        TEXT NOT NULL DEFAULT 'default',
          claim           TEXT NOT NULL,
          probe_command   TEXT NOT NULL,
          observed_output TEXT NOT NULL,
          target_context  TEXT NOT NULL DEFAULT '',
          skill_run_id    TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS evidence_pg_proj_idx ON evidence_pg (project_hash, id DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS evidence_pg_run_idx ON evidence_pg (skill_run_id)`);
    },
  },
  {
    id: 50,
    description:
      "Run-scoped correlation ids (v0.58.0, graph-engineering B1). A task's trail was spread " +
      "across broadcasts, facts, and logs correlated only by time-window queries — reconstructing " +
      "one task took N manual queries. run_id (minted by the dispatcher at ASSIGN, echoed by " +
      "workers, backfilled by the dispatcher when omitted) makes the trail one queryable object. " +
      "Deliberately NOT part of row_hash, so backfill never breaks the broadcast HMAC chain.",
    up: async (client) => {
      await client.query(`ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS run_id TEXT`);
      await client.query(`ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS run_id TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_broadcasts_run ON broadcasts(run_id) WHERE run_id IS NOT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_wm_run ON working_memory(run_id) WHERE run_id IS NOT NULL`);
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

/**
 * Test helper: drop telemetry tables. NEVER call against shared / production DBs.
 *
 * v0.20.0 — defense in depth. Three guards prevent prod DB nuking:
 *   1. Refuses unless ZC_POSTGRES_DB matches a test sentinel ('test' / 'securecontext_test')
 *      OR the env var ZC_ALLOW_DESTRUCTIVE_TEST_HELPERS=1 is explicitly set
 *   2. Refuses if VITEST env (which vitest sets automatically) is missing
 *   3. Logs the operation regardless, so a forgotten override leaves a paper trail
 *
 * If you trip this guard, you're not running tests against an isolated DB.
 * Set up a test PG (e.g. `securecontext_test` database in the same container)
 * and pass ZC_POSTGRES_DB=securecontext_test in vitest setup.
 */
export async function _dropPgTelemetryTablesForTesting(): Promise<void> {
  const dbName = process.env.ZC_POSTGRES_DB ?? "";
  const isTestDb = /test/i.test(dbName) || dbName.endsWith("_test");
  const inVitest = !!process.env.VITEST;
  const explicitOverride = process.env.ZC_ALLOW_DESTRUCTIVE_TEST_HELPERS === "1";

  if (!isTestDb && !explicitOverride) {
    throw new Error(
      `_dropPgTelemetryTablesForTesting refused: ZC_POSTGRES_DB="${dbName}" doesn't look like a test DB ` +
      `(should match /test/i or end with _test). Vitest must point at a separate database (e.g. securecontext_test) ` +
      `to avoid wiping production data. Set ZC_ALLOW_DESTRUCTIVE_TEST_HELPERS=1 to override (NOT recommended).`,
    );
  }
  if (!inVitest && !explicitOverride) {
    throw new Error(
      `_dropPgTelemetryTablesForTesting refused: VITEST env not set (this should only run from vitest). ` +
      `Set ZC_ALLOW_DESTRUCTIVE_TEST_HELPERS=1 to override.`,
    );
  }
  logger.warn("telemetry", "destructive_test_helper_invoked", {
    db: dbName, in_vitest: inVitest, override: explicitOverride,
  });

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

/**
 * v0.51.0 — migrations that touch a given set of tables, DERIVED from the
 * migration bodies rather than hand-listed.
 *
 * Why this exists: `_dropSkillTablesForTesting` drops the skill tables and then
 * deletes their schema_migrations_pg rows so `runPgMigrations()` re-applies them
 * against the fresh schema. That list of ids was maintained BY HAND, and it
 * drifted twice — silently. Migration 16 (agent_id) was missed and CI failed
 * from v0.22.0; migrations 20 and 27 (evidence JSONB) were missed after that,
 * and the same three storage_dual tests failed again with
 * "column evidence of relation skill_runs_pg does not exist".
 *
 * A hand-copied list of things that must stay in sync with code elsewhere is a
 * bug with a delay fuse. Reading the ids off the migration bodies means adding a
 * new migration cannot forget to update anything.
 */
export function migrationsTouching(tables: readonly string[]): number[] {
  const ids: number[] = [];
  for (const m of PG_MIGRATIONS) {
    const body = String(m.up);
    // Substring, not a word-boundary regex: table names here are unique enough
    // that a substring hit is exactly what we want (it also catches index and
    // constraint names derived from the table, which a migration re-run needs).
    if (tables.some((t) => body.includes(t))) ids.push(m.id);
  }
  return ids;
}

/** The three tables `_dropSkillTablesForTesting` drops, in one place. */
export const SKILL_TABLES = ["skills_pg", "skill_runs_pg", "skill_mutations_pg"] as const;
