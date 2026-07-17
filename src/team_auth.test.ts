/**
 * S3 (v0.46.0) — unit tests for the team-auth pure helpers.
 * PG-backed CRUD (users/keys/workspaces) is covered by the live API E2E;
 * these prove the security-relevant pure logic deterministically.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  hashApiKey, generateUserKey, isMasterKey, isWorkspacePath,
  workspaceIdFromPath, teamAuthEnabled, resolveIdentity,
  _clearIdentityCacheForTesting,
} from "./team_auth.js";

const ENV_KEYS = ["ZC_API_KEY", "ZC_TEAM_AUTH"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  _clearIdentityCacheForTesting();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("key generation + hashing", () => {
  it("generates zck_-prefixed 48-hex keys, unique per call", () => {
    const a = generateUserKey();
    const b = generateUserKey();
    expect(a).toMatch(/^zck_[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });

  it("hashApiKey is a stable sha256 hex", () => {
    expect(hashApiKey("abc")).toBe(hashApiKey("abc"));
    expect(hashApiKey("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey("abc")).not.toBe(hashApiKey("abd"));
  });
});

describe("isMasterKey", () => {
  it("matches only the exact configured key", () => {
    process.env.ZC_API_KEY = "super-secret-master";
    expect(isMasterKey("super-secret-master")).toBe(true);
    expect(isMasterKey("super-secret-masteR")).toBe(false);
    expect(isMasterKey("")).toBe(false);
    expect(isMasterKey(undefined)).toBe(false);
  });

  it("open dev mode (no key configured) treats everyone as operator", () => {
    delete process.env.ZC_API_KEY;
    expect(isMasterKey(undefined)).toBe(true);
    expect(isMasterKey("anything")).toBe(true);
  });
});

describe("workspace paths", () => {
  it("accepts valid slugs", () => {
    expect(isWorkspacePath("workspace:team-alpha")).toBe(true);
    expect(isWorkspacePath("workspace:a")).toBe(true);
    expect(isWorkspacePath("workspace:pro_ject-2")).toBe(true);
    expect(workspaceIdFromPath("workspace:team-alpha")).toBe("team-alpha");
  });

  it("rejects invalid or dangerous shapes", () => {
    expect(isWorkspacePath("workspace:")).toBe(false);
    expect(isWorkspacePath("workspace:-leading-dash")).toBe(false);
    expect(isWorkspacePath("workspace:UPPER")).toBe(false);
    expect(isWorkspacePath("workspace:has space")).toBe(false);
    expect(isWorkspacePath("workspace:" + "x".repeat(80))).toBe(false);
    expect(isWorkspacePath("C:\\Users\\Amit\\project")).toBe(false);
    expect(isWorkspacePath("/tmp/project")).toBe(false);
    expect(workspaceIdFromPath("/tmp/project")).toBeNull();
  });
});

describe("resolveIdentity (no PG needed for these branches)", () => {
  it("master key → operator", async () => {
    process.env.ZC_API_KEY = "master-1";
    expect(await resolveIdentity("master-1")).toEqual({ kind: "operator" });
  });

  it("non-zck garbage → null without touching PG", async () => {
    process.env.ZC_API_KEY = "master-1";
    expect(await resolveIdentity("not-a-key")).toBeNull();
    expect(await resolveIdentity(undefined)).toBeNull();
  });

  it("kill switch ZC_TEAM_AUTH=0 → user keys rejected even if well-formed", async () => {
    process.env.ZC_API_KEY = "master-1";
    process.env.ZC_TEAM_AUTH = "0";
    expect(teamAuthEnabled()).toBe(false);
    expect(await resolveIdentity(generateUserKey())).toBeNull();
  });
});
