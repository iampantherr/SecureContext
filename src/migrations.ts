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

  // ── v0.7.1 migrations ────────────────────────────────────────────────────

  {
    id: 9,
    description: "Purge legacy SHA256 channel key hashes — scrypt upgrade required (security fix)",
    up: (db) => {
      // v0.7.0 stored the channel key as plain SHA256(key) with no salt — not a KDF.
      // This is vulnerable to offline brute force: ~10B guesses/sec on a GPU.
      // v0.7.1 replaces SHA256 with scrypt (N=65536, r=8, p=1, 256-bit random salt).
      // New format: "scrypt:v1:{N}:{r}:{p}:{salt_hex}:{hash_hex}"
      //
      // This migration deletes any stored key that is NOT in the new scrypt format.
      // Effect: users who had a channel key configured must re-run set_key once.
      // This is a deliberate, secure breaking change — SHA256 hashes must not be trusted.
      db.exec(`
        DELETE FROM project_meta
        WHERE key = 'zc_channel_key_hash'
          AND value NOT LIKE 'scrypt:v1:%'
      `);
    },
  },

  // ── v0.8.0 migrations ────────────────────────────────────────────────────

  {
    id: 10,
    description: "v0.8.0: agent_sessions RBAC table + hash chain columns on broadcasts + L0/L1 tiers on source_meta",
    up: (db) => {
      // Agent session registry (Chapter 6 session tokens + Chapter 14 RBAC)
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_sessions (
          token_id    TEXT    PRIMARY KEY,
          agent_id    TEXT    NOT NULL,
          role        TEXT    NOT NULL CHECK(role IN ('orchestrator','developer','marketer','researcher','worker')),
          token_hmac  TEXT    NOT NULL,
          issued_at   TEXT    NOT NULL,
          expires_at  TEXT    NOT NULL,
          revoked     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_as_agent ON agent_sessions(agent_id, revoked);
      `);

      // Hash chain columns (Chapter 13 Biba integrity chain)
      try { db.exec(`ALTER TABLE broadcasts ADD COLUMN session_token_id TEXT NOT NULL DEFAULT ''`); } catch {}
      try { db.exec(`ALTER TABLE broadcasts ADD COLUMN prev_hash TEXT NOT NULL DEFAULT 'genesis'`); } catch {}
      try { db.exec(`ALTER TABLE broadcasts ADD COLUMN row_hash TEXT NOT NULL DEFAULT ''`); } catch {}
      try { db.exec(`ALTER TABLE broadcasts ADD COLUMN acked_at TEXT`); } catch {}

      // L0/L1 tier columns (tiered context loading)
      try { db.exec(`ALTER TABLE source_meta ADD COLUMN l0_summary TEXT NOT NULL DEFAULT ''`); } catch {}
      try { db.exec(`ALTER TABLE source_meta ADD COLUMN l1_summary TEXT NOT NULL DEFAULT ''`); } catch {}
    },
  },

  {
    id: 11,
    description: "Expand broadcasts type CHECK to include LAUNCH_ROLE and RETIRE_ROLE for on-demand agent spawning (COALESCE-safe)",
    up: (db) => {
      // SQLite cannot ALTER a CHECK constraint — must recreate the table.
      // Copy data, drop old, create new with expanded CHECK, restore data.
      //
      // v0.10.3 fix: pre-v0.7.0 broadcasts tables had no NOT NULL constraints,
      // so existing rows can contain NULLs in columns that ARE NOT NULL in the
      // new schema. A naive `INSERT INTO broadcasts_new SELECT * FROM broadcasts`
      // fails with "NOT NULL constraint failed: broadcasts_new.task" on any DB
      // with legacy rows. Use explicit column list + COALESCE to coerce NULLs
      // to the new-schema defaults.
      db.exec(`
        CREATE TABLE IF NOT EXISTS broadcasts_new (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          type             TEXT    NOT NULL
                                   CHECK(type IN ('ASSIGN','STATUS','PROPOSED','DEPENDENCY','MERGE','REJECT','REVISE','LAUNCH_ROLE','RETIRE_ROLE')),
          agent_id         TEXT    NOT NULL DEFAULT 'default',
          task             TEXT    NOT NULL DEFAULT '',
          files            TEXT    NOT NULL DEFAULT '[]',
          state            TEXT    NOT NULL DEFAULT '',
          summary          TEXT    NOT NULL DEFAULT '',
          depends_on       TEXT    NOT NULL DEFAULT '[]',
          reason           TEXT    NOT NULL DEFAULT '',
          importance       INTEGER NOT NULL DEFAULT 3,
          created_at       TEXT    NOT NULL,
          session_token_id TEXT    NOT NULL DEFAULT '',
          prev_hash        TEXT    NOT NULL DEFAULT 'genesis',
          row_hash         TEXT    NOT NULL DEFAULT '',
          acked_at         TEXT
        );
        INSERT INTO broadcasts_new (
          id, type, agent_id, task, files, state, summary, depends_on, reason,
          importance, created_at, session_token_id, prev_hash, row_hash, acked_at
        )
        SELECT
          id,
          COALESCE(type,             'STATUS'),
          COALESCE(agent_id,         'default'),
          COALESCE(task,             ''),
          COALESCE(files,            '[]'),
          COALESCE(state,            ''),
          COALESCE(summary,          ''),
          COALESCE(depends_on,       '[]'),
          COALESCE(reason,           ''),
          COALESCE(importance,       3),
          COALESCE(created_at,       strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          COALESCE(session_token_id, ''),
          COALESCE(prev_hash,        'genesis'),
          COALESCE(row_hash,         ''),
          acked_at
        FROM broadcasts;
        DROP TABLE broadcasts;
        ALTER TABLE broadcasts_new RENAME TO broadcasts;
        CREATE INDEX IF NOT EXISTS idx_bc_type  ON broadcasts(type);
        CREATE INDEX IF NOT EXISTS idx_bc_agent ON broadcasts(agent_id);
      `);
    },
  },

  {
    id: 12,
    description: "v0.10.0 Harness Engineering: project_card, session_read_log, tool_output_digest",
    up: (db) => {
      // ── project_card ─────────────────────────────────────────────────────────
      // Per-project "card" — the 500-token orientation summary returned by
      // zc_project_card(). Singleton row (CHECK(id=1)): each project DB describes
      // ITS OWN project. Fields are opaque TEXT so the agent/operator controls
      // what goes in. hot_files is a JSON array of top-N frequently-edited paths.
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_card (
          id          INTEGER PRIMARY KEY CHECK(id = 1),
          stack       TEXT    NOT NULL DEFAULT '',
          layout      TEXT    NOT NULL DEFAULT '',
          state       TEXT    NOT NULL DEFAULT '',
          gotchas     TEXT    NOT NULL DEFAULT '',
          hot_files   TEXT    NOT NULL DEFAULT '[]',
          updated_at  TEXT    NOT NULL
        );
      `);

      // ── session_read_log ─────────────────────────────────────────────────────
      // Per-session file-read log. Powers the PreToolUse Read dedup hook:
      // before a Read fires, the hook queries this table — if the path is
      // already present for the current session, block and force the agent
      // to use zc_file_summary / zc_search instead. Session boundary = a
      // SessionStart event, which wipes rows for the previous session_id.
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_read_log (
          session_id  TEXT NOT NULL,
          path        TEXT NOT NULL,
          read_at     TEXT NOT NULL,
          PRIMARY KEY (session_id, path)
        );
        CREATE INDEX IF NOT EXISTS idx_srl_session ON session_read_log(session_id);
      `);

      // ── tool_output_digest ───────────────────────────────────────────────────
      // Bash-output archive. PostToolUse bash hook summarizes long outputs and
      // stores them here (plus a full-content row in `knowledge` for FTS).
      // hash = sha256(cmd + stdout) — dedup identical re-runs.
      // summary kept compact for injection back into agent context.
      // full_ref = the `source` key in the knowledge table (FTS-searchable).
      db.exec(`
        CREATE TABLE IF NOT EXISTS tool_output_digest (
          hash        TEXT    PRIMARY KEY,
          command     TEXT    NOT NULL,
          summary     TEXT    NOT NULL,
          exit_code   INTEGER NOT NULL,
          full_ref    TEXT    NOT NULL,
          created_at  TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tod_cmd ON tool_output_digest(command, created_at DESC);
      `);
    },
  },

  {
    id: 13,
    description: "v0.11.0 Sprint 1: tool_calls table — per-tool-call telemetry (highest-resolution cost data)",
    up: (db) => {
      // Per-tool-call telemetry. The highest-resolution source of truth for
      // cost / latency / outcome attribution. All aggregations (per-task,
      // per-session, per-role, per-skill, per-model) roll up from this table
      // via SQL views — never duplicate-store the rolled-up values.
      //
      // Hash-chained for tamper detection (per §15.4 Sprint 1 + §15.5):
      //   row_hash = HMAC-SHA256(machine_secret, prev_hash || canonical(row))
      // An attacker with DB write access cannot forge valid row_hash without
      // the machine secret — silent log manipulation is detectable.
      db.exec(`
        CREATE TABLE IF NOT EXISTS tool_calls (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic, used by chain ordering
          call_id        TEXT    NOT NULL UNIQUE,            -- UUID, externally addressable
          session_id     TEXT    NOT NULL,           -- Claude Code session ID
          agent_id       TEXT    NOT NULL,           -- e.g. "RevClear-developer"
          project_hash   TEXT    NOT NULL,           -- SHA256(projectPath)[:16]
          task_id        TEXT,                       -- nullable; from broadcast or skill
          skill_id       TEXT,                       -- nullable; if invoked under a skill
          tool_name      TEXT    NOT NULL,           -- e.g. "mcp__zc-ctx__zc_file_summary"
          model          TEXT    NOT NULL,           -- e.g. "claude-opus-4-7"
          input_tokens   INTEGER NOT NULL DEFAULT 0,
          output_tokens  INTEGER NOT NULL DEFAULT 0,
          cached_tokens  INTEGER NOT NULL DEFAULT 0,
          cost_usd       REAL    NOT NULL DEFAULT 0,
          cost_known     INTEGER NOT NULL DEFAULT 1, -- 0 if pricing unknown / tampered
          latency_ms     INTEGER NOT NULL DEFAULT 0,
          status         TEXT    NOT NULL DEFAULT 'ok',  -- ok | error | timeout
          error_class    TEXT,                       -- transient | permission | logic | unknown
          ts             TEXT    NOT NULL,           -- ISO 8601
          prev_hash      TEXT    NOT NULL DEFAULT 'genesis',
          row_hash       TEXT    NOT NULL DEFAULT '',
          trace_id       TEXT                        -- cross-log correlation
        );
        CREATE INDEX IF NOT EXISTS idx_tc_session   ON tool_calls(session_id, ts);
        CREATE INDEX IF NOT EXISTS idx_tc_task      ON tool_calls(task_id) WHERE task_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_tc_skill     ON tool_calls(skill_id) WHERE skill_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_tc_role      ON tool_calls(agent_id, model);
        CREATE INDEX IF NOT EXISTS idx_tc_tool_name ON tool_calls(tool_name, ts);
        CREATE INDEX IF NOT EXISTS idx_tc_ts        ON tool_calls(ts DESC);
        CREATE INDEX IF NOT EXISTS idx_tc_trace     ON tool_calls(trace_id) WHERE trace_id IS NOT NULL;
      `);

      // Pre-aggregated SQL views for common cost-attribution queries.
      // SQLite views are computed on demand (no materialization); query speed
      // is fine at our scale (~1k rows/day per active project).
      db.exec(`
        CREATE VIEW IF NOT EXISTS v_session_cost AS
          SELECT
            session_id,
            agent_id,
            COUNT(*) AS calls,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cost_usd) AS cost_usd,
            MIN(ts) AS started_at,
            MAX(ts) AS last_call_at
          FROM tool_calls
          GROUP BY session_id, agent_id;

        CREATE VIEW IF NOT EXISTS v_task_cost AS
          SELECT
            task_id,
            COUNT(*) AS calls,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cost_usd) AS cost_usd
          FROM tool_calls
          WHERE task_id IS NOT NULL
          GROUP BY task_id;

        CREATE VIEW IF NOT EXISTS v_role_cost AS
          SELECT
            agent_id,
            model,
            COUNT(*) AS calls,
            SUM(cost_usd) AS cost_usd,
            AVG(latency_ms) AS avg_latency_ms
          FROM tool_calls
          GROUP BY agent_id, model;

        CREATE VIEW IF NOT EXISTS v_tool_cost AS
          SELECT
            tool_name,
            model,
            COUNT(*) AS calls,
            SUM(cost_usd) AS cost_usd,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            AVG(latency_ms) AS avg_latency_ms
          FROM tool_calls
          GROUP BY tool_name, model;
      `);
    },
  },

  {
    id: 14,
    description: "v0.11.0 Sprint 1: outcomes table — deferred outcome tags joined to actions",
    up: (db) => {
      // Joined to tool_calls or other ref tables via (ref_type, ref_id).
      // Outcomes resolve LATER than the action they describe (e.g. a tool
      // call from 09:00 might get a "shipped" outcome at 14:00 when the
      // commit is verified). The temporal disconnect is intentional.
      //
      // Also hash-chained for tamper detection of the learning signal
      // (an attacker manipulating outcomes could poison the future
      // mutation engine — chain prevents silent forgery).
      db.exec(`
        CREATE TABLE IF NOT EXISTS outcomes (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic, used by chain ordering
          outcome_id     TEXT    NOT NULL UNIQUE,            -- UUID, externally addressable
          ref_type       TEXT    NOT NULL,           -- "tool_call" | "task" | "skill_run" | "session"
          ref_id         TEXT    NOT NULL,           -- FK into the referenced table
          outcome_kind   TEXT    NOT NULL,           -- shipped | reverted | accepted | rejected
                                                     -- | sufficient | insufficient | errored
          signal_source  TEXT    NOT NULL,           -- git_commit | user_prompt | follow_up | manual
          score_delta    REAL,                       -- nullable; how this changed parent score
          confidence     REAL    NOT NULL DEFAULT 1.0,  -- 0-1; lower for inferred outcomes
          evidence       TEXT,                       -- JSON: structured supporting evidence
          resolved_at    TEXT    NOT NULL,           -- ISO 8601 (when determined, not when action occurred)
          prev_hash      TEXT    NOT NULL DEFAULT 'genesis',
          row_hash       TEXT    NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_o_ref      ON outcomes(ref_type, ref_id);
        CREATE INDEX IF NOT EXISTS idx_o_kind     ON outcomes(outcome_kind, resolved_at);
        CREATE INDEX IF NOT EXISTS idx_o_resolved ON outcomes(resolved_at DESC);

        -- Per-tool-call outcome rollup (most useful query: "which tool calls
        -- had a positive outcome?" → joins to tool_calls via call_id)
        CREATE VIEW IF NOT EXISTS v_tool_call_outcomes AS
          SELECT
            tc.call_id,
            tc.session_id,
            tc.tool_name,
            tc.cost_usd,
            o.outcome_kind,
            o.signal_source,
            o.confidence,
            o.resolved_at
          FROM tool_calls tc
          LEFT JOIN outcomes o
            ON o.ref_type = 'tool_call' AND o.ref_id = tc.call_id;
      `);
    },
  },

  {
    id: 15,
    description: "v0.11.0 Sprint 1: learnings table — structured mirror of dispatcher's JSONL learnings/",
    up: (db) => {
      // Mirror of <project>/learnings/{metrics,decisions,failures,...}.jsonl
      // populated by the PostToolUse `learnings-indexer.mjs` hook on every
      // write to those files.
      //
      // The JSONL files remain canonical (cat-able, grep-able by humans);
      // this table provides the query power (cross-project aggregation,
      // outcome correlation, pattern mining for the Sprint 2 mutation engine).
      //
      // Idempotency: dedup by (project_hash, source_path, source_line). The
      // indexer hook can safely re-run without creating duplicate rows.
      db.exec(`
        CREATE TABLE IF NOT EXISTS learnings (
          learning_id    TEXT    PRIMARY KEY,        -- UUID
          project_hash   TEXT    NOT NULL,           -- SHA256(projectPath)[:16]
          category       TEXT    NOT NULL,           -- metric | decision | failure | insight | experiment
          payload        TEXT    NOT NULL,           -- the JSON line (verbatim from JSONL)
          source_path    TEXT    NOT NULL,           -- e.g. "learnings/failures.jsonl"
          source_line    INTEGER,                    -- line number in source (for dedup)
          ts             TEXT    NOT NULL,           -- write timestamp
          UNIQUE (project_hash, source_path, source_line)
        );
        CREATE INDEX IF NOT EXISTS idx_l_project_cat ON learnings(project_hash, category, ts);
        CREATE INDEX IF NOT EXISTS idx_l_category    ON learnings(category, ts DESC);
      `);
    },
  },

  // ── v0.14.0 migrations ────────────────────────────────────────────────

  {
    id: 16,
    description: "v0.14.0: provenance column on working_memory (EXTRACTED|INFERRED|AMBIGUOUS|UNKNOWN)",
    up: (db) => {
      // Per Chin & Older 2011 Ch6 + Ch7 ('speaks-for' formalism): every claim
      // should carry its trust chain. Provenance flags the source's epistemic
      // status so downstream consumers can downweight INFERRED facts when
      // stakes are high (e.g. mutation engine ranking).
      //
      // Values:
      //   EXTRACTED  — read directly from a primary source (file, AST, git)
      //   INFERRED   — produced by an LLM or similarity heuristic
      //   AMBIGUOUS  — multiple plausible readings, user/agent should review
      //   UNKNOWN    — legacy rows from before v0.14.0 (default for migration)
      //
      // Stored as TEXT with a CHECK constraint so insert errors fail loud.
      // Defensive: idempotent — if provenance already exists (re-migration
      // attempt), no-op.
      const tbl = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='working_memory'`
      ).get();
      if (!tbl) return;
      const cols = db.prepare(`PRAGMA table_info(working_memory)`).all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "provenance")) return;
      db.exec(`
        ALTER TABLE working_memory ADD COLUMN provenance TEXT NOT NULL DEFAULT 'UNKNOWN'
          CHECK (provenance IN ('EXTRACTED', 'INFERRED', 'AMBIGUOUS', 'UNKNOWN'));
        CREATE INDEX IF NOT EXISTS idx_wm_provenance ON working_memory(provenance, created_at);
      `);
    },
  },

  {
    id: 17,
    description: "v0.14.0: provenance column on source_meta (file-summary trust tier)",
    up: (db) => {
      // source_meta holds L0/L1 file summaries. AST-extracted summaries
      // (Phase B) should be tagged EXTRACTED — they're deterministic.
      // LLM-summarized files are INFERRED. Truncated-only fallback is
      // AMBIGUOUS (no semantic interpretation, just a slice).
      //
      // Defensive: source_meta may not exist on legacy fixtures that
      // skipped migration 1. In that case, no-op — the column will be
      // added when source_meta is eventually created.
      const tbl = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='source_meta'`
      ).get();
      if (!tbl) return;
      // Don't re-ALTER if column already present (idempotent)
      const cols = db.prepare(`PRAGMA table_info(source_meta)`).all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "provenance")) return;
      db.exec(`
        ALTER TABLE source_meta ADD COLUMN provenance TEXT NOT NULL DEFAULT 'UNKNOWN'
          CHECK (provenance IN ('EXTRACTED', 'INFERRED', 'AMBIGUOUS', 'UNKNOWN'));
        CREATE INDEX IF NOT EXISTS idx_src_provenance ON source_meta(provenance);
      `);
    },
  },

  {
    id: 18,
    description: "v0.15.0 §8.1: structured ASSIGN broadcast columns (acceptance_criteria, complexity, file_ownership, dependencies, required_skills, estimated_tokens)",
    up: (db) => {
      // Per HARNESS_EVOLUTION_PLAN.md §8.1: extend ASSIGN broadcasts with
      // structured fields so dispatcher (Sprint 3 work-stealing queue) can
      // route by complexity, enforce file ownership, and resolve task
      // dependencies. All NULLABLE — backward-compatible with existing ASSIGN
      // broadcasts that don't provide them.
      const tbl = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='broadcasts'`
      ).get();
      if (!tbl) return;
      const cols = db.prepare(`PRAGMA table_info(broadcasts)`).all() as Array<{ name: string }>;
      const have = new Set(cols.map((c) => c.name));
      // Each ALTER is independent so partial-migration on a previously-failed
      // run can resume cleanly.
      if (!have.has("acceptance_criteria"))      db.exec(`ALTER TABLE broadcasts ADD COLUMN acceptance_criteria TEXT`);
      if (!have.has("complexity_estimate"))      db.exec(`ALTER TABLE broadcasts ADD COLUMN complexity_estimate INTEGER`);
      if (!have.has("file_ownership_exclusive")) db.exec(`ALTER TABLE broadcasts ADD COLUMN file_ownership_exclusive TEXT`);
      if (!have.has("file_ownership_read_only")) db.exec(`ALTER TABLE broadcasts ADD COLUMN file_ownership_read_only TEXT`);
      if (!have.has("task_dependencies"))        db.exec(`ALTER TABLE broadcasts ADD COLUMN task_dependencies TEXT`);
      if (!have.has("required_skills"))          db.exec(`ALTER TABLE broadcasts ADD COLUMN required_skills TEXT`);
      if (!have.has("estimated_tokens"))         db.exec(`ALTER TABLE broadcasts ADD COLUMN estimated_tokens INTEGER`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_b_complexity ON broadcasts(complexity_estimate, type)`);
    },
  },

  {
    id: 19,
    description: "v0.15.0 §8.6 T3.2: MAC-style classification labels on outcomes (public|internal|confidential|restricted)",
    up: (db) => {
      // Per HARNESS_EVOLUTION_PLAN.md §8.6 T3.2 + Chin & Older 2011 Ch5+Ch13:
      // outcomes.evidence may contain inferred-from-user-message data
      // (sentiment classifier, follow-up resolver). Classification labels
      // let consumers filter rows when querying:
      //   public/internal → readable by any agent on this project
      //   confidential    → readable by registered agents on this project
      //   restricted      → readable ONLY by created_by_agent_id
      //
      // SQLite enforces the read filter at the application layer (no RLS).
      // Postgres RLS policy ships with the Postgres backend (v0.16.0).
      //
      // Defensive: idempotent + handles missing outcomes table.
      const tbl = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='outcomes'`
      ).get();
      if (!tbl) return;
      const cols = db.prepare(`PRAGMA table_info(outcomes)`).all() as Array<{ name: string }>;
      const have = new Set(cols.map((c) => c.name));
      if (!have.has("classification")) {
        db.exec(`ALTER TABLE outcomes ADD COLUMN classification TEXT NOT NULL DEFAULT 'internal'
                 CHECK (classification IN ('public', 'internal', 'confidential', 'restricted'))`);
      }
      if (!have.has("created_by_agent_id")) {
        // NULL allowed for legacy rows + non-restricted entries
        db.exec(`ALTER TABLE outcomes ADD COLUMN created_by_agent_id TEXT`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_o_classification ON outcomes(classification, created_by_agent_id)`);
    },
  },

  {
    id: 20,
    description: "v0.18.0 Sprint 2: skills table — versioned hash-protected skill registry",
    up: (db) => {
      // Each skill is a (name, version, scope) tuple with HMAC-protected body.
      // Soft-delete via archived_at lets the mutation engine version-bump
      // without losing history. UNIQUE active row ensures only one
      // (name, scope) is "live" at a time.
      db.exec(`
        CREATE TABLE IF NOT EXISTS skills (
          skill_id        TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          version         TEXT NOT NULL,
          scope           TEXT NOT NULL,
          description     TEXT NOT NULL,
          frontmatter     TEXT NOT NULL,           -- JSON-serialized SkillFrontmatter
          body            TEXT NOT NULL,
          body_hmac       TEXT NOT NULL,
          source_path     TEXT,
          promoted_from   TEXT,
          created_at      TEXT NOT NULL,
          archived_at     TEXT,
          archive_reason  TEXT
        );
      `);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_active ON skills(name, scope) WHERE archived_at IS NULL;`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skills_name_scope ON skills(name, scope);`);
    },
  },

  {
    id: 21,
    description: "v0.18.0 Sprint 2: skill_runs — execution telemetry per skill invocation",
    up: (db) => {
      // Each invocation of a skill produces one row. outcome_score is the
      // composite (accuracy + cost + speed) used by the mutation engine
      // to rank candidates. failure_trace captures the structured failure
      // shape so the mutator has signal to work with.
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_runs (
          run_id         TEXT PRIMARY KEY,
          skill_id       TEXT NOT NULL,
          session_id     TEXT NOT NULL,
          task_id        TEXT,
          inputs         TEXT NOT NULL,           -- JSON
          outcome_score  REAL,
          total_cost     REAL,
          total_tokens   INTEGER,
          duration_ms    INTEGER,
          status         TEXT NOT NULL CHECK(status IN ('succeeded','failed','timeout')),
          failure_trace  TEXT,
          ts             TEXT NOT NULL
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sr_skill_ts ON skill_runs(skill_id, ts);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sr_status ON skill_runs(status, ts);`);
    },
  },

  {
    id: 22,
    description: "v0.18.0 Sprint 2: skill_mutations — proposal + replay + promotion ledger",
    up: (db) => {
      // Each candidate produced by the mutation engine gets a row.
      // candidate_hmac proves the body wasn't modified between proposal
      // and replay (RT-S2-09). promoted=true rows have promoted_to_skill_id
      // pointing at the new active row in skills.
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_mutations (
          mutation_id           TEXT PRIMARY KEY,
          parent_skill_id       TEXT NOT NULL,
          candidate_body        TEXT NOT NULL,
          candidate_hmac        TEXT NOT NULL,
          proposed_by           TEXT NOT NULL,
          judged_by             TEXT,
          judge_score           REAL,
          judge_rationale       TEXT,
          replay_score          REAL,
          promoted              INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
          promoted_to_skill_id  TEXT,
          created_at            TEXT NOT NULL,
          resolved_at           TEXT
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sm_parent ON skill_mutations(parent_skill_id, created_at);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sm_promoted ON skill_mutations(promoted, created_at);`);
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
