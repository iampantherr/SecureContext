/**
 * Backend selection and Postgres connection resolution (v0.55.0).
 *
 * The bug these guard: createStore() read only ZC_PG_URL — a name used nowhere
 * else — while every PG-native path read ZC_POSTGRES_*. A machine fully
 * configured for Postgres threw "requires ZC_PG_URL" the moment you set
 * ZC_STORE=postgres, so the documented switch did not work with the documented
 * configuration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolvePgConnectionString } from "./store.js";

const PG_VARS = [
  "ZC_POSTGRES_URL", "ZC_PG_URL", "ZC_POSTGRES_HOST", "ZC_POSTGRES_PORT",
  "ZC_POSTGRES_USER", "ZC_POSTGRES_PASSWORD", "ZC_POSTGRES_DB",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(PG_VARS.map((k) => [k, process.env[k]]));
  for (const k of PG_VARS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolvePgConnectionString", () => {
  it("returns null when nothing is configured, rather than a hopeful default", () => {
    // Guessing localhost here would connect to whatever Postgres happens to be
    // running and silently write memory into a stranger's database.
    expect(resolvePgConnectionString()).toBeNull();
  });

  it("builds a URL from the same parts pg_pool.ts uses — the original bug", () => {
    process.env.ZC_POSTGRES_HOST = "localhost";
    process.env.ZC_POSTGRES_USER = "scuser";
    process.env.ZC_POSTGRES_PASSWORD = "secret";
    process.env.ZC_POSTGRES_DB = "securecontext";
    expect(resolvePgConnectionString()).toBe("postgresql://scuser:secret@localhost:5432/securecontext");
  });

  it("applies the documented defaults for port, user and database", () => {
    process.env.ZC_POSTGRES_PASSWORD = "pw";
    expect(resolvePgConnectionString()).toBe("postgresql://scuser:pw@localhost:5432/securecontext");
  });

  it("prefers an explicit URL over the parts", () => {
    process.env.ZC_POSTGRES_URL = "postgresql://a:b@db.example:6000/other";
    process.env.ZC_POSTGRES_HOST = "ignored";
    expect(resolvePgConnectionString()).toBe("postgresql://a:b@db.example:6000/other");
  });

  it("still accepts the legacy ZC_PG_URL alias", () => {
    process.env.ZC_PG_URL = "postgresql://legacy@host/db";
    expect(resolvePgConnectionString()).toBe("postgresql://legacy@host/db");
  });

  it("escapes credentials so a password with URL metacharacters cannot corrupt the DSN", () => {
    process.env.ZC_POSTGRES_HOST = "localhost";
    process.env.ZC_POSTGRES_USER = "user@corp";
    process.env.ZC_POSTGRES_PASSWORD = "p@ss:word/#1";
    const url = resolvePgConnectionString()!;
    expect(url).toContain("user%40corp");
    expect(url).toContain("p%40ss%3Aword%2F%231");
    // Exactly one @ separating credentials from host.
    expect(url.slice("postgresql://".length).split("@").length).toBe(2);
  });
});
