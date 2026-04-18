/**
 * ChainedTableSqlite — SQLite implementation of the ChainedTable interface.
 *
 * Concurrency strategy: `BEGIN IMMEDIATE` acquires the global write lock
 * before the SELECT for prev_hash, serializing concurrent writers atomically.
 * (This was the v0.11.0 → v0.12.0 fix that resolved the chain-race bug
 * caught by stress tests.)
 *
 * The internal DB calls are synchronous (`node:sqlite` has no async API),
 * but the public methods are `async` to match the cross-backend `ChainedTable`
 * contract. The `Promise.resolve` wrappers add ~microseconds per call —
 * negligible vs the 5-50ms DB round-trip.
 */

import { DatabaseSync } from "node:sqlite";
import {
  computeChainHash,
  GENESIS,
  type ChainedTable,
  type CanonicalRowInput,
  type ChainAppendResult,
  type ChainVerifyResult,
} from "./chained_table.js";

/** App-supplied callback that performs the actual INSERT statement.
 *
 * The caller is responsible for any ts/timestamp; the chain abstraction
 * only manages prev_hash + row_hash (the chain integrity invariants).
 * Any other column (ts, tokens, cost, etc.) is the caller's concern.
 */
export type SqliteInsertCallback = (slot: {
  prevHash: string;
  rowHash:  string;
  db:       DatabaseSync;
}) => void;

/**
 * Options controlling how a chain reads "the latest hash" — needed because
 * tool_calls is scoped by project_hash but outcomes is scoped only by table
 * (single chain per DB).
 */
export interface SqliteChainOpts {
  /** Table name to query. */
  tableName: string;
  /** WHERE clause for "find latest row in this scope". May be empty. */
  scopeWhere?: string;
  /** Bind values for scopeWhere. */
  scopeParams?: ReadonlyArray<unknown>;
}

export class ChainedTableSqlite implements ChainedTable {
  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: SqliteChainOpts,
  ) {}

  /**
   * Append a row inside an IMMEDIATE transaction. The caller-supplied
   * `doInsert` runs inside the lock; on success we COMMIT, on throw we
   * ROLLBACK.
   */
  async appendChained(input: CanonicalRowInput): Promise<ChainAppendResult> {
    return this.appendChainedWith(input, () => {
      // Default: caller didn't supply doInsert. The chain values are computed
      // and returned, but no INSERT happens — useful only for tests.
    });
  }

  /**
   * Variant that takes an INSERT callback. This is the primary API.
   * Returns chain values + new row id.
   */
  async appendChainedWith(
    input: CanonicalRowInput,
    doInsert: SqliteInsertCallback,
  ): Promise<ChainAppendResult> {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const prevHash = this._getLastHashLocked();
      const { rowHash } = computeChainHash(input, prevHash);

      doInsert({ prevHash, rowHash, db });

      // Read back the auto-assigned id from the row we just inserted.
      // Safe inside the same transaction — last_insert_rowid() is per-connection.
      const idRow = db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
      db.exec("COMMIT");
      return { rowHash, prevHash, id: idRow.id };
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  async verifyChain(_scope: { projectHash: string }): Promise<ChainVerifyResult> {
    // Backend-agnostic verification is implemented by the application
    // because the canonical-field reconstruction is table-specific.
    // ChainedTableSqlite just exposes the read; the caller (e.g.
    // verifyToolCallChain) reconstructs canonical bytes and calls
    // verifyChainRows from chained_table.ts.
    throw new Error("verifyChain must be called via the application's verify function (which knows the canonical-field layout). See verifyToolCallChain / verifyOutcomesChain.");
  }

  async init(): Promise<void> { /* sqlite per-call open; nothing to init */ }
  async close(): Promise<void> { /* db lifecycle managed by caller */ }

  // ── Internal ───────────────────────────────────────────────────────────

  private _getLastHashLocked(): string {
    // Inside the IMMEDIATE transaction, this read is consistent with respect
    // to concurrent writers (they're blocked by the write lock).
    const where = this.opts.scopeWhere ? `WHERE ${this.opts.scopeWhere}` : "";
    const sql = `SELECT row_hash FROM ${this.opts.tableName}
                 ${where}
                 ORDER BY id DESC LIMIT 1`;
    const stmt = this.db.prepare(sql);
    const row = (this.opts.scopeParams && this.opts.scopeParams.length > 0)
      ? stmt.get(...(this.opts.scopeParams as Array<string | number | bigint | Buffer | null>))
      : stmt.get();
    return (row as { row_hash?: string } | undefined)?.row_hash || GENESIS;
  }
}
