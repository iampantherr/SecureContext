/**
 * ChainedTablePostgres — Postgres implementation of the ChainedTable interface.
 *
 * Concurrency strategy: a single statement that combines the chain-link SELECT
 * and the INSERT, with `FOR UPDATE` on the latest row to serialize concurrent
 * writers. This is the Postgres analog of SQLite's `BEGIN IMMEDIATE`:
 *
 *   BEGIN;
 *   SET LOCAL ROLE <agent_role>;        -- T3.1: per-query identity
 *   INSERT INTO ... (..., prev_hash, row_hash)
 *     VALUES (..., $prev_hash, $row_hash);
 *   COMMIT;                              -- releases ROLE + the row lock
 *
 * Because the prev_hash needs to be known before computing row_hash, we
 * actually do this in two statements inside the transaction:
 *
 *   BEGIN;
 *   SET LOCAL ROLE <agent_role>;
 *   SELECT row_hash FROM <table> WHERE <scope> ORDER BY id DESC
 *     LIMIT 1 FOR UPDATE;
 *   -- compute row_hash in app code (HKDF-keyed HMAC)
 *   INSERT INTO <table> (..., prev_hash, row_hash, classification, ...)
 *     VALUES (..., $1, $2, $3, ...);
 *   COMMIT;
 *
 * The FOR UPDATE on the SELECT holds an EXCLUSIVE row lock for the duration
 * of the transaction. Other writers block until COMMIT, then they pick up the
 * NEW latest row. Atomic in the same sense as SQLite's IMMEDIATE.
 *
 * SECURITY (Tier 3 fixes):
 *   T3.1 — `SET LOCAL ROLE` runs every INSERT under the per-agent role,
 *           not the pool's broad role. RLS policies (T3.2) check
 *           current_setting('zc.current_agent', true).
 *   T3.2 — `SET LOCAL "zc.current_agent" = '<agent_id>'` provides the
 *           current_agent value used by the 'restricted' RLS policy.
 *
 *   Both SETs are LOCAL — they auto-reset on COMMIT/ROLLBACK so the next
 *   client checked out from the pool starts clean.
 */

import type { PoolClient } from "pg";
import {
  computeChainHash,
  GENESIS,
  type ChainedTable,
  type CanonicalRowInput,
  type ChainAppendResult,
  type ChainVerifyResult,
} from "./chained_table.js";
import { withTransaction } from "../pg_pool.js";
import { logger } from "../logger.js";

/** Insert callback receives the computed chain slot + connected client. */
export type PostgresInsertCallback = (slot: {
  prevHash: string;
  rowHash:  string;
  client:   PoolClient;
}) => Promise<{ id: number } | void>;

export interface PostgresChainOpts {
  /** Postgres table name. */
  tableName:    string;
  /** WHERE clause for "latest row in this scope". May be empty for single-chain tables. */
  scopeWhere?:  string;
  /** Bind values for scopeWhere ($1, $2, ...). */
  scopeParams?: ReadonlyArray<unknown>;
}

/**
 * Per-agent Postgres role provisioning cache.
 * On first use of an agent_id, we ensure the role exists and has INSERT
 * permission on the telemetry tables. Idempotent — `CREATE ROLE IF NOT EXISTS`
 * pattern (Postgres uses DO/EXCEPTION since CREATE ROLE doesn't have IF NOT EXISTS).
 */
const _provisionedAgents = new Set<string>();

/**
 * Sanitize an agent_id into a Postgres role identifier. Roles must match
 * `[A-Za-z_][A-Za-z0-9_]*` and be ≤ 63 chars (NAMEDATALEN). We hash overflow.
 */
function agentRoleName(agentId: string): string {
  // Lowercase + replace non-alnum with _
  let safe = agentId.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (safe.length === 0 || !/^[a-z_]/.test(safe)) safe = "a_" + safe;
  // Per-SC namespace prefix to avoid collision with operator-managed roles
  const role = "zc_agent_" + safe;
  // Postgres role names are ≤ 63 chars; if too long, hash the suffix
  if (role.length > 63) {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const h = createHash("sha256").update(agentId).digest("hex").slice(0, 12);
    return "zc_agent_" + safe.slice(0, 50) + "_" + h;
  }
  return role;
}

/**
 * Lazily provision a Postgres role for an agent. Safe to call repeatedly.
 *
 * Grants INSERT on tool_calls_pg + outcomes_pg + learnings_pg.
 * Does NOT grant unrestricted SELECT — RLS policies on outcomes_pg gate reads
 * by classification. tool_calls_pg has no RLS (telemetry rows are project-internal).
 *
 * Runs on its own connection (via withClient) so the role + grants are
 * COMMITTED in their own transaction. The subsequent SET LOCAL ROLE in
 * the writer transaction sees them. Inlining GRANT into the writer
 * transaction triggered "permission denied" because of how Postgres
 * checks privileges at SET ROLE time vs INSERT time.
 */
async function provisionAgentRole(_unused: PoolClient, agentId: string): Promise<string> {
  const role = agentRoleName(agentId);
  if (_provisionedAgents.has(role)) return role;

  const { withClient } = await import("../pg_pool.js");
  const quoted = `"${role.replace(/"/g, '""')}"`;
  try {
    await withClient(async (provClient) => {
      // CREATE ROLE — idempotent via DO/EXCEPTION
      await provClient.query(`
        DO $$
        BEGIN
          CREATE ROLE ${quoted} NOLOGIN NOINHERIT;
        EXCEPTION
          WHEN duplicate_object THEN NULL;
        END
        $$
      `);
      // GRANT writes (telemetry rows are project-scoped; no RLS on tool_calls_pg).
      // SELECT + INSERT for chain reads + writes. SELECT FOR UPDATE
      // (used by ChainedTablePostgres for the prev_hash lookup) additionally
      // requires UPDATE OR DELETE OR INSERT privilege on the table — INSERT
      // alone isn't enough on some PG versions/configs, so we grant SELECT
      // explicitly and ensure INSERT + UPDATE both exist.
      await provClient.query(`GRANT SELECT, INSERT, UPDATE ON tool_calls_pg TO ${quoted}`);
      await provClient.query(`GRANT SELECT, INSERT, UPDATE ON outcomes_pg   TO ${quoted}`);
      await provClient.query(`GRANT INSERT ON learnings_pg  TO ${quoted}`);
      // CRITICAL: schema USAGE — without it, the role can't even REFERENCE
      // tables in public schema. Defaults vary by Postgres version + setup.
      await provClient.query(`GRANT USAGE ON SCHEMA public TO ${quoted}`);
      // SELECT for read-back: tool_calls_pg is broadly readable (project-scoped).
      // outcomes_pg has RLS policies (T3.2) so the SELECT grant just allows
      // the table-level access; the RLS predicates filter per-row.
      await provClient.query(`GRANT SELECT ON tool_calls_pg TO ${quoted}`);
      await provClient.query(`GRANT SELECT ON outcomes_pg   TO ${quoted}`);
      // BIGSERIAL allocation requires sequence USAGE
      await provClient.query(`GRANT USAGE ON SEQUENCE tool_calls_pg_id_seq TO ${quoted}`);
      await provClient.query(`GRANT USAGE ON SEQUENCE outcomes_pg_id_seq   TO ${quoted}`);
      // Pool's owner role needs to be able to SET ROLE to per-agent roles.
      // GRANT <role> TO <pool_user> establishes that membership.
      // current_user inside our connection is the pool's owning role.
      const me = await provClient.query(`SELECT current_user AS u`);
      const owner = me.rows[0]?.u;
      if (owner && owner !== role) {
        await provClient.query(`GRANT ${quoted} TO "${String(owner).replace(/"/g, '""')}"`);
      }
    });
    _provisionedAgents.add(role);
    logger.info("telemetry", "pg_agent_role_provisioned", { agent_id: agentId, role });
  } catch (e) {
    logger.warn("telemetry", "pg_agent_role_provision_failed", {
      agent_id: agentId, role, error: (e as Error).message,
    });
  }
  return role;
}

/** Test helper: clear the per-process role-provisioning cache. */
export function _resetProvisionedAgentsForTesting(): void {
  _provisionedAgents.clear();
}

// ─── Implementation ───────────────────────────────────────────────────────

export class ChainedTablePostgres implements ChainedTable {
  constructor(private readonly opts: PostgresChainOpts) {}

  async appendChained(input: CanonicalRowInput): Promise<ChainAppendResult> {
    return this.appendChainedWith(input, async () => {
      throw new Error("ChainedTablePostgres.appendChained requires a doInsert callback — call appendChainedWith");
    });
  }

  /**
   * Run the locked SELECT + INSERT within a single transaction, with
   * SET LOCAL ROLE (T3.1) and SET LOCAL zc.current_agent (T3.2).
   *
   * The doInsert callback receives the connected client + computed chain
   * slot. The callback's INSERT MUST include the prev_hash + row_hash and
   * RETURNING id (we capture the id from the returned row).
   */
  async appendChainedWith(
    input:    CanonicalRowInput,
    doInsert: PostgresInsertCallback,
  ): Promise<ChainAppendResult> {
    // T3.1 step 1 — provision + GRANT in their own connection/transaction
    // BEFORE the writer transaction begins. This ensures the grants are
    // visible to the SET LOCAL ROLE in the writer transaction.
    const role = await provisionAgentRole(null as unknown as PoolClient, input.agentId);

    return withTransaction(async (client) => {
      // T3.1 step 2 — switch to the per-agent role for the duration of this txn
      // (SET LOCAL is auto-reset on COMMIT/ROLLBACK).
      // Role name sanitized in agentRoleName(); safe to interpolate.
      await client.query(`SET LOCAL ROLE "${role.replace(/"/g, '""')}"`);
      // T3.2 — bind agent identity for RLS policies. The 'restricted' policy
      // on outcomes_pg reads this via current_setting('zc.current_agent', true).
      await client.query(`SELECT set_config('zc.current_agent', $1, true)`, [input.agentId]);

      // Lock the latest row in scope so the prev_hash we read can't change
      // before our INSERT
      const prevHash = await this._getLastHashLocked(client);
      const { rowHash } = computeChainHash(input, prevHash);

      const result = await doInsert({ prevHash, rowHash, client });
      const id = result?.id ?? 0;

      return { rowHash, prevHash, id };
    });
  }

  async verifyChain(_scope: { projectHash: string }): Promise<ChainVerifyResult> {
    throw new Error("verifyChain must be called via the application's verify function (which knows the canonical-field layout). See verifyToolCallChain / verifyOutcomesChain.");
  }

  async init():  Promise<void> { /* pool lifecycle managed externally */ }
  async close(): Promise<void> { /* pool lifecycle managed externally */ }

  // ── Internal ────────────────────────────────────────────────────────────

  /**
   * Read the latest row_hash in scope inside the locking transaction.
   * Uses FOR UPDATE on the row to prevent concurrent writers from racing.
   */
  private async _getLastHashLocked(client: PoolClient): Promise<string> {
    const where = this.opts.scopeWhere ? `WHERE ${this.opts.scopeWhere}` : "";
    const sql = `
      SELECT row_hash FROM ${this.opts.tableName}
      ${where}
      ORDER BY id DESC LIMIT 1
      FOR UPDATE
    `;
    const params = (this.opts.scopeParams ?? []) as unknown[];
    const r = await client.query(sql, params);
    return r.rows[0]?.row_hash || GENESIS;
  }
}
