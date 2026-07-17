/**
 * S3 (v0.46.0) — TEAM / MULTI-USER MEMORY: per-user API keys, shared
 * workspaces, and write attribution.
 *
 * MODEL
 * -----
 * - The operator's master key (ZC_API_KEY) keeps working exactly as before and
 *   is the ONLY key that can manage users/keys/workspaces (control plane).
 * - Each team member gets their own API key (`zck_<48 hex>`), stored HASHED
 *   (sha256) in `api_keys_pg`. A user key authenticates the same data-plane
 *   endpoints; every write it makes is attributed (`working_memory.created_by`).
 * - A WORKSPACE is a shared memory scope addressed as the virtual project path
 *   `workspace:<slug>`. It is hashed exactly like a filesystem project path, so
 *   every existing store code path (memory, KB, broadcasts, graph) works on it
 *   unchanged. User keys must be members to touch a workspace; the master key
 *   always may. Normal filesystem projects stay open to any authenticated key
 *   (single-machine trust model — RLS/agent tokens already guard agent writes).
 *
 * SAFETY
 * ------
 * - Kill switch: ZC_TEAM_AUTH=0 → user-key lookup disabled (master key only);
 *   everything behaves exactly as v0.45.
 * - PG unavailable / tables missing → resolveIdentity degrades to master-only.
 * - Key plaintext is returned ONCE at creation and never stored or logged.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { withClient } from "./pg_pool.js";

export type ApiIdentity =
  | { kind: "operator" }
  | { kind: "user"; userId: string; keyId: number };

const KEY_PREFIX = "zck_";
const WORKSPACE_RE = /^workspace:[a-z0-9][a-z0-9_-]{0,63}$/;

export function teamAuthEnabled(): boolean {
  return process.env["ZC_TEAM_AUTH"] !== "0";
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function generateUserKey(): string {
  return KEY_PREFIX + randomBytes(24).toString("hex");
}

export function isWorkspacePath(projectPath: string): boolean {
  return WORKSPACE_RE.test(projectPath);
}

export function workspaceIdFromPath(projectPath: string): string | null {
  return isWorkspacePath(projectPath) ? projectPath.slice("workspace:".length) : null;
}

/** Timing-safe equality against the master ZC_API_KEY (read per-call like api-server). */
export function isMasterKey(supplied: string | undefined): boolean {
  const master = process.env["ZC_API_KEY"];
  if (!master) return true; // open dev mode — everyone is the operator
  if (!supplied) return false;
  try {
    const a = Buffer.from(hashApiKey(supplied), "hex");
    const b = Buffer.from(hashApiKey(master), "hex");
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// 30s positive cache so a busy session doesn't hit PG on every request.
// Negative results are NOT cached (a just-created key must work immediately;
// brute-force is already throttled by the per-IP rate limit).
const identityCache = new Map<string, { identity: ApiIdentity; until: number }>();
const IDENTITY_CACHE_MS = 30_000;

/** Test hook. */
export function _clearIdentityCacheForTesting(): void {
  identityCache.clear();
}

/**
 * Resolve a supplied bearer value to an identity:
 *  master key → operator; known active user key → user; anything else → null.
 */
export async function resolveIdentity(supplied: string | undefined): Promise<ApiIdentity | null> {
  if (isMasterKey(supplied)) return { kind: "operator" };
  if (!supplied || !teamAuthEnabled()) return null;
  if (!supplied.startsWith(KEY_PREFIX)) return null;

  const h = hashApiKey(supplied);
  const cached = identityCache.get(h);
  if (cached && cached.until > Date.now()) return cached.identity;

  try {
    const identity = await withClient(async (c) => {
      const r = await c.query<{ key_id: number; user_id: string }>(
        `SELECT k.key_id, k.user_id
           FROM api_keys_pg k
           JOIN users_pg u ON u.user_id = k.user_id
          WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND u.disabled_at IS NULL`,
        [h],
      );
      const row = r.rows[0];
      if (!row) return null;
      // Best-effort usage stamp (throttled by the cache: at most once per 30s per key).
      void c.query(`UPDATE api_keys_pg SET last_used_at = now() WHERE key_id = $1`, [row.key_id])
        .catch(() => { /* non-fatal */ });
      return { kind: "user" as const, userId: row.user_id, keyId: Number(row.key_id) };
    });
    if (identity) identityCache.set(h, { identity, until: Date.now() + IDENTITY_CACHE_MS });
    return identity;
  } catch {
    // PG down / tables missing — master-only mode.
    return null;
  }
}

/**
 * Workspace access gate for data-plane requests. Throws {statusCode, message}
 * shaped like ApiError (the caller maps it). Operator always passes; user keys
 * must be members. Non-workspace paths always pass.
 */
export async function assertWorkspaceAccess(projectPath: string, identity: ApiIdentity): Promise<void> {
  const wsId = workspaceIdFromPath(projectPath);
  if (!wsId) return;
  if (identity.kind === "operator") return;
  const ok = await withClient(async (c) => {
    const r = await c.query(
      `SELECT 1 FROM workspace_members_pg WHERE workspace_id = $1 AND user_id = $2`,
      [wsId, identity.userId],
    );
    return (r.rowCount ?? 0) > 0;
  });
  if (!ok) {
    const err = new Error(`Not a member of workspace '${wsId}'`) as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
}

// ─── Control-plane CRUD (master key only — enforced by the API layer) ───────

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export async function createUser(userId: string, displayName?: string): Promise<{ user_id: string }> {
  if (!SLUG_RE.test(userId)) throw badReq("userId must match [a-z0-9][a-z0-9_-]{0,63}");
  await withClient((c) => c.query(
    `INSERT INTO users_pg(user_id, display_name) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, users_pg.display_name), disabled_at = NULL`,
    [userId, displayName ?? null],
  ));
  return { user_id: userId };
}

export async function listUsers(): Promise<Array<{ user_id: string; display_name: string | null; created_at: string; disabled: boolean; keys: number }>> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT u.user_id, u.display_name, u.created_at, (u.disabled_at IS NOT NULL) AS disabled,
              COUNT(k.key_id) FILTER (WHERE k.revoked_at IS NULL)::int AS keys
         FROM users_pg u LEFT JOIN api_keys_pg k ON k.user_id = u.user_id
        GROUP BY u.user_id ORDER BY u.created_at`,
    );
    return r.rows.map((x) => ({ ...x, created_at: new Date(x.created_at).toISOString() }));
  });
}

/** Creates a key; the PLAINTEXT is returned once and never persisted. */
export async function createApiKey(userId: string, label?: string): Promise<{ key_id: number; api_key: string; key_prefix: string }> {
  const plaintext = generateUserKey();
  const prefix = plaintext.slice(0, 12);
  const keyId = await withClient(async (c) => {
    const u = await c.query(`SELECT 1 FROM users_pg WHERE user_id = $1 AND disabled_at IS NULL`, [userId]);
    if ((u.rowCount ?? 0) === 0) throw badReq(`Unknown or disabled user '${userId}' — create the user first`);
    const r = await c.query<{ key_id: number }>(
      `INSERT INTO api_keys_pg(user_id, key_hash, key_prefix, label) VALUES ($1, $2, $3, $4) RETURNING key_id`,
      [userId, hashApiKey(plaintext), prefix, label ?? null],
    );
    return Number(r.rows[0]!.key_id);
  });
  return { key_id: keyId, api_key: plaintext, key_prefix: prefix };
}

export async function revokeApiKey(keyId: number): Promise<boolean> {
  const n = await withClient(async (c) => {
    const r = await c.query(`UPDATE api_keys_pg SET revoked_at = now() WHERE key_id = $1 AND revoked_at IS NULL`, [keyId]);
    return r.rowCount ?? 0;
  });
  identityCache.clear(); // revocation must take effect immediately
  return n > 0;
}

export async function listApiKeys(): Promise<Array<{ key_id: number; user_id: string; key_prefix: string; label: string | null; created_at: string; last_used_at: string | null; revoked: boolean }>> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT key_id, user_id, key_prefix, label, created_at, last_used_at, (revoked_at IS NOT NULL) AS revoked
         FROM api_keys_pg ORDER BY created_at DESC LIMIT 200`,
    );
    return r.rows.map((x) => ({
      ...x, key_id: Number(x.key_id),
      created_at: new Date(x.created_at).toISOString(),
      last_used_at: x.last_used_at ? new Date(x.last_used_at).toISOString() : null,
    }));
  });
}

export async function createWorkspace(workspaceId: string, name: string | undefined, createdBy: string | null): Promise<{ workspace_id: string; projectPath: string }> {
  if (!SLUG_RE.test(workspaceId)) throw badReq("workspaceId must match [a-z0-9][a-z0-9_-]{0,63}");
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO workspaces_pg(workspace_id, name, created_by) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, workspaces_pg.name)`,
      [workspaceId, name ?? workspaceId, createdBy],
    );
    if (createdBy) {
      await c.query(
        `INSERT INTO workspace_members_pg(workspace_id, user_id, role) VALUES ($1, $2, 'admin')
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [workspaceId, createdBy],
      );
    }
  });
  return { workspace_id: workspaceId, projectPath: `workspace:${workspaceId}` };
}

export async function addWorkspaceMember(workspaceId: string, userId: string, role: "member" | "admin" = "member"): Promise<void> {
  await withClient(async (c) => {
    const w = await c.query(`SELECT 1 FROM workspaces_pg WHERE workspace_id = $1`, [workspaceId]);
    if ((w.rowCount ?? 0) === 0) throw badReq(`Unknown workspace '${workspaceId}'`);
    const u = await c.query(`SELECT 1 FROM users_pg WHERE user_id = $1 AND disabled_at IS NULL`, [userId]);
    if ((u.rowCount ?? 0) === 0) throw badReq(`Unknown or disabled user '${userId}'`);
    await c.query(
      `INSERT INTO workspace_members_pg(workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [workspaceId, userId, role === "admin" ? "admin" : "member"],
    );
  });
}

export async function removeWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
  const n = await withClient(async (c) => {
    const r = await c.query(`DELETE FROM workspace_members_pg WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
    return r.rowCount ?? 0;
  });
  return n > 0;
}

export async function listWorkspaces(forUserId?: string): Promise<Array<{ workspace_id: string; name: string; created_by: string | null; members: string[] }>> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT w.workspace_id, w.name, w.created_by,
              COALESCE(ARRAY_AGG(m.user_id ORDER BY m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS members
         FROM workspaces_pg w LEFT JOIN workspace_members_pg m ON m.workspace_id = w.workspace_id
        GROUP BY w.workspace_id ORDER BY w.workspace_id`,
    );
    const rows = r.rows as Array<{ workspace_id: string; name: string; created_by: string | null; members: string[] }>;
    return forUserId ? rows.filter((w) => w.members.includes(forUserId)) : rows;
  });
}

function badReq(message: string): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = 400;
  return e;
}
