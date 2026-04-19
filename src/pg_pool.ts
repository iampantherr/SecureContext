/**
 * Postgres connection pool (v0.16.0 Sprint 3 Phase 2)
 * ====================================================
 *
 * Single shared `pg.Pool` for the SC process. Used by:
 *   - `ChainedTablePostgres` for hash-chained writes to tool_calls / outcomes
 *   - The api-server's broadcast endpoint when telemetry routes to Postgres
 *
 * SECURITY (Tier 3 fix T3.1 hooks):
 *   The pool's owning role (ZC_POSTGRES_USER, default 'scuser') has the
 *   broad telemetry-write privilege. Per-query, we issue
 *     BEGIN; SET LOCAL ROLE <agent_role>; INSERT ...; COMMIT
 *   so the actual INSERT runs under a per-agent identity. See
 *   `ChainedTablePostgres.appendChainedWith()` for the BEGIN block.
 *
 * Connection string priority:
 *   1. `ZC_POSTGRES_URL` env var (full conninfo URL)
 *   2. `ZC_POSTGRES_*` env vars (host/port/user/password/db/ssl)
 *   3. Defaults that match the bundled `securecontext-postgres` Docker container
 *
 * Lifecycle:
 *   - First call lazy-initializes the pool
 *   - Pool is process-singleton; closed at SIGTERM via shutdownPgPool()
 *   - 60-second idle timeout per connection
 *   - 30-second statement timeout (defense against hung queries)
 */

import { Pool, type PoolConfig, type PoolClient } from "pg";
import { logger } from "./logger.js";

let _pool: Pool | null = null;
let _initError: Error | null = null;

function buildPoolConfig(): PoolConfig {
  const url = process.env.ZC_POSTGRES_URL;
  if (url && url.length > 0) {
    return {
      connectionString: url,
      max: parsePositiveInt(process.env.ZC_POSTGRES_POOL_MAX, 10),
      idleTimeoutMillis: 60_000,
      statement_timeout: 30_000,  // 30s — generous; chain writes are sub-50ms
      // ssl handled by libpq via the URL itself (?sslmode=...)
    };
  }
  return {
    host:     process.env.ZC_POSTGRES_HOST     || "localhost",
    port:     parsePositiveInt(process.env.ZC_POSTGRES_PORT, 5432),
    user:     process.env.ZC_POSTGRES_USER     || "scuser",
    password: process.env.ZC_POSTGRES_PASSWORD || "",
    database: process.env.ZC_POSTGRES_DB       || "securecontext",
    max:      parsePositiveInt(process.env.ZC_POSTGRES_POOL_MAX, 10),
    idleTimeoutMillis: 60_000,
    statement_timeout: 30_000,
    // sslmode controlled by env; default no SSL (matches local Docker)
    ssl: process.env.ZC_POSTGRES_SSL === "1"
      ? { rejectUnauthorized: process.env.ZC_POSTGRES_SSL_REJECT_UNAUTHORIZED !== "0" }
      : false,
  };
}

function parsePositiveInt(v: string | undefined, dflt: number): number {
  if (!v) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Get the shared Postgres pool, creating it lazily on first call.
 * Returns null if Postgres is intentionally disabled
 * (no password configured + no URL — common dev-only state).
 *
 * The pool emits 'error' events; we install a listener that logs but
 * doesn't crash the process — pg may transparently reconnect.
 */
export function getPgPool(): Pool | null {
  if (_pool) return _pool;
  if (_initError) return null;  // sticky failure within the process

  const cfg = buildPoolConfig();
  if (!cfg.connectionString && !cfg.password) {
    // No URL + no password = caller hasn't configured Postgres. Treat as
    // intentional skip (rather than throwing) — telemetry falls back to SQLite.
    logger.warn("telemetry", "pg_pool_skipped_no_creds", {});
    _initError = new Error("Postgres pool unavailable: no ZC_POSTGRES_URL and no ZC_POSTGRES_PASSWORD set");
    return null;
  }

  try {
    _pool = new Pool(cfg);
    _pool.on("error", (err) => {
      // Idle-client errors — log + let pg auto-reconnect on next checkout
      logger.warn("telemetry", "pg_pool_idle_error", { error: err.message });
    });
    logger.info("telemetry", "pg_pool_created", {
      host: (cfg.host ?? "url").toString(),
      max: cfg.max,
    });
    return _pool;
  } catch (e) {
    _initError = e as Error;
    logger.error("telemetry", "pg_pool_init_failed", { error: (e as Error).message });
    return null;
  }
}

/** Test/diagnostic: forget the cached pool + error so a new init can be attempted. */
export function _resetPgPoolForTesting(): void {
  if (_pool) {
    // Don't await — tests run synchronously
    _pool.end().catch(() => { /* ignore */ });
  }
  _pool = null;
  _initError = null;
}

/** Graceful shutdown — call on SIGTERM/SIGINT. */
export async function shutdownPgPool(): Promise<void> {
  if (_pool) {
    try { await _pool.end(); } catch (e) {
      logger.warn("telemetry", "pg_pool_shutdown_error", { error: (e as Error).message });
    }
    _pool = null;
  }
}

/**
 * Borrow a client + run `body(client)`, releasing in finally.
 * The underlying pool guarantees a fresh client (or recycled idle one);
 * `body` should keep its work tight to avoid blocking the pool.
 */
export async function withClient<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPgPool();
  if (!pool) throw new Error("Postgres pool unavailable (see ZC_POSTGRES_* env vars)");
  const client = await pool.connect();
  try {
    return await body(client);
  } finally {
    client.release();
  }
}

/**
 * Run a body inside an explicit transaction. ROLLBACK on throw, COMMIT on
 * success. Returns whatever `body` returns.
 */
export async function withTransaction<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const r = await body(client);
      await client.query("COMMIT");
      return r;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* ignore secondary error */ }
      throw e;
    }
  });
}

/** Sanity check: are we able to round-trip a SELECT? Returns true/false. */
export async function pgHealthCheck(): Promise<boolean> {
  try {
    return await withClient(async (client) => {
      const r = await client.query("SELECT 1 AS ok");
      return r.rows.length === 1 && r.rows[0].ok === 1;
    });
  } catch {
    return false;
  }
}
