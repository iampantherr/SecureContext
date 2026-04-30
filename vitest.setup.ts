/**
 * v0.20.0 — vitest global setup.
 *
 * Two responsibilities:
 *
 *   1. Force ZC_POSTGRES_DB to a test-isolated database (default
 *      'securecontext_test') so destructive test helpers and synthetic
 *      data inserts can't pollute the production 'securecontext' DB.
 *      Operators can override via ZC_TEST_POSTGRES_DB.
 *
 *   2. Auto-create the test database if missing — connects to the default
 *      'postgres' admin DB, runs CREATE DATABASE IF NOT EXISTS analog
 *      (Postgres doesn't support IF NOT EXISTS on CREATE DATABASE; we use
 *      pg_database lookup + conditional CREATE).
 *
 * If ZC_POSTGRES_PASSWORD isn't set (i.e. tests are running in pure-SQLite
 * mode), this is a no-op — PG-backed tests will skip themselves.
 *
 * The destructive test helpers in pg_migrations.ts now refuse to run unless
 * ZC_POSTGRES_DB matches /test/i — this setup ensures that condition is met
 * before any test imports the migration module.
 */

import pg from "pg";

const TEST_DB_NAME = process.env.ZC_TEST_POSTGRES_DB ?? "securecontext_test";

// Override the prod DB target with the test DB before ANY test code runs.
// This must happen before pg_pool.ts captures process.env.
process.env.ZC_POSTGRES_DB = TEST_DB_NAME;

// Best-effort create the test DB. Skip silently if PG isn't configured.
async function ensureTestDb() {
  if (!process.env.ZC_POSTGRES_PASSWORD && !process.env.ZC_POSTGRES_URL) {
    return;  // SQLite-only test mode
  }
  const adminClient = new pg.Client({
    host:     process.env.ZC_POSTGRES_HOST     ?? "localhost",
    port:     parseInt(process.env.ZC_POSTGRES_PORT ?? "5432", 10),
    user:     process.env.ZC_POSTGRES_USER     ?? "scuser",
    password: process.env.ZC_POSTGRES_PASSWORD ?? "",
    database: "postgres",  // admin DB to issue CREATE DATABASE
    connectionTimeoutMillis: 3000,
  });
  try {
    await adminClient.connect();
    const r = await adminClient.query("SELECT 1 FROM pg_database WHERE datname=$1", [TEST_DB_NAME]);
    if (r.rows.length === 0) {
      // CREATE DATABASE can't run in a transaction — must use raw exec
      await adminClient.query(`CREATE DATABASE ${TEST_DB_NAME}`);
      // eslint-disable-next-line no-console
      console.log(`[vitest setup] Created isolated test DB: ${TEST_DB_NAME}`);
    }
  } catch (e) {
    // Don't fail the whole suite — individual PG-backed tests can skip themselves
    // eslint-disable-next-line no-console
    console.warn(`[vitest setup] Could not ensure test DB '${TEST_DB_NAME}': ${(e as Error).message}`);
  } finally {
    try { await adminClient.end(); } catch { /* ignore */ }
  }
}

// Vitest globalSetup contract: export `setup` and `teardown`. The `setup`
// function runs once before all test files. We use it to:
//   1. Force ZC_POSTGRES_DB to the test DB name (already done at module load)
//   2. Auto-create the test database if missing
export async function setup(): Promise<void> {
  await ensureTestDb();
}
export async function teardown(): Promise<void> {
  // No teardown — leave the test DB in place for inspection between runs.
}
