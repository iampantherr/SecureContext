/**
 * RBAC + Session Token Access Control
 * Chin & Older (2011):
 * - Ch.14 RBAC: role-permission matrix with separation of duty
 * - Ch.6 Session Tokens: short-lived HMAC-signed bearer tokens
 * - Ch.11 Capabilities: session token = unforgeable, non-forgeable capability
 * - Ch.7 Non-Transitive Delegation: workers cannot re-elevate to orchestrator
 *
 * Token format: zcst.{base64url(JSON_payload)}.{hmac_sha256_hex}
 *
 * Payload:
 *   { tid, aid, role, ph, iat, exp }
 *   tid = UUID v4 token ID
 *   aid = agent_id
 *   role = AgentRole
 *   ph  = project hash (16 chars SHA256)
 *   iat = issued-at unix seconds
 *   exp = expires-at unix seconds
 *
 * Signing key: 32-byte random stored in project_meta as 'zc_token_signing_key'.
 * Auto-generated on first issueToken call. NEVER exposed via any MCP tool.
 */

import { DatabaseSync } from "node:sqlite";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Config } from "./config.js";
import type { BroadcastType } from "./memory.js";

// ── RBAC permission matrix (Chapter 14) ──────────────────────────────────────
export const ROLE_PERMISSIONS: Record<string, BroadcastType[]> = {
  orchestrator: ["ASSIGN", "MERGE", "REJECT", "REVISE", "STATUS"],
  developer:    ["STATUS", "PROPOSED", "DEPENDENCY", "MERGE"],
  marketer:     ["STATUS", "PROPOSED", "DEPENDENCY", "MERGE"],
  researcher:   ["STATUS", "PROPOSED", "DEPENDENCY", "MERGE"],
  worker:       ["STATUS", "PROPOSED", "DEPENDENCY", "MERGE"],
};

export type AgentRole = keyof typeof ROLE_PERMISSIONS;

const VALID_ROLES = new Set(Object.keys(ROLE_PERMISSIONS));

// ── Token payload interface ───────────────────────────────────────────────────
interface TokenPayload {
  tid:  string;       // UUID v4 — unique token ID
  aid:  string;       // agent_id
  role: AgentRole;
  ph:   string;       // project hash (16 chars SHA256)
  iat:  number;       // issued-at unix seconds
  exp:  number;       // expires-at unix seconds
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Base64url encode a buffer or string (no padding) */
function b64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64url");
}

/** Base64url decode to a string */
function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/** Generate a UUID v4 */
function uuidV4(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant bits
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8), hex.slice(8, 12),
    hex.slice(12, 16), hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Compute the project hash (16-char SHA256 prefix) */
function projectHash(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

/**
 * Get or generate the HMAC signing key for this project.
 * Key is stored in project_meta as 'zc_token_signing_key' (hex-encoded 32 bytes).
 * NEVER returned to callers — only used internally for sign/verify.
 */
function getOrCreateSigningKey(db: DatabaseSync): Buffer {
  const row = db.prepare(
    "SELECT value FROM project_meta WHERE key = 'zc_token_signing_key'"
  ).get() as { value: string } | undefined;

  if (row) {
    return Buffer.from(row.value, "hex");
  }

  // Auto-generate on first use (Chapter 6 — symmetric key management)
  const key = randomBytes(32);
  db.prepare(
    "INSERT OR REPLACE INTO project_meta(key, value) VALUES ('zc_token_signing_key', ?)"
  ).run(key.toString("hex"));
  return key;
}

/** Sign a payload and return the full token string */
function signToken(payload: TokenPayload, signingKey: Buffer): string {
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", signingKey)
    .update(payloadB64)
    .digest("hex");
  return `zcst.${payloadB64}.${sig}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Issue a new RBAC session token for an agent.
 * Stores the session record in agent_sessions.
 * Returns the signed token string.
 *
 * Chapter 6: short-lived tickets reduce exposure window.
 * Chapter 14: role is bound at issuance — cannot be elevated later (Ch.7).
 */
export function issueToken(
  db:          DatabaseSync,
  projectPath: string,
  agentId:     string,
  role:        AgentRole,
  ttlSeconds:  number = Config.SESSION_TOKEN_TTL_SECONDS
): string {
  if (!VALID_ROLES.has(role)) {
    throw new Error(
      `Invalid role '${role}'. Valid roles: ${Object.keys(ROLE_PERMISSIONS).join(", ")}`
    );
  }

  const signingKey = getOrCreateSigningKey(db);
  const nowSec     = Math.floor(Date.now() / 1000);
  const tid        = uuidV4();
  const ph         = projectHash(projectPath);

  const payload: TokenPayload = {
    tid,
    aid:  agentId,
    role,
    ph,
    iat:  nowSec,
    exp:  nowSec + ttlSeconds,
  };

  const token    = signToken(payload, signingKey);
  const tokenSig = token.split(".")[2]!; // the HMAC hex portion

  const issuedAt  = new Date(nowSec * 1000).toISOString();
  const expiresAt = new Date((nowSec + ttlSeconds) * 1000).toISOString();

  db.prepare(`
    INSERT OR REPLACE INTO agent_sessions(token_id, agent_id, role, token_hmac, issued_at, expires_at, revoked)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(tid, agentId, role, tokenSig, issuedAt, expiresAt);

  return token;
}

/**
 * Verify a token string against the project's signing key.
 * Checks HMAC (timing-safe), expiry, and revocation status.
 * Returns null on ANY failure — never throws.
 *
 * Chapter 6: bearer token verification.
 * Chapter 11: unforgeable capability — passes only if HMAC valid.
 */
export function verifyToken(
  db:          DatabaseSync,
  token:       string,
  projectPath: string
): { agentId: string; role: AgentRole; tokenId: string } | null {
  try {
    if (!token || !token.startsWith("zcst.")) return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [, payloadB64, sigHex] = parts as [string, string, string];

    // Decode and parse payload
    let payload: TokenPayload;
    try {
      payload = JSON.parse(b64urlDecode(payloadB64)) as TokenPayload;
    } catch {
      return null;
    }

    // Validate payload fields
    if (!payload.tid || !payload.aid || !payload.role || !payload.ph) return null;
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;

    // Project binding: reject tokens for a different project (Chapter 11 — scoped capability)
    const expectedPh = projectHash(projectPath);
    if (payload.ph !== expectedPh) return null;

    // Expiry check
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec > payload.exp) return null;

    // HMAC verification — timing-safe (Chapter 6 — no oracle attacks)
    const signingKey = getOrCreateSigningKey(db);
    const expectedSig = createHmac("sha256", signingKey)
      .update(payloadB64)
      .digest("hex");

    const expectedBuf = Buffer.from(expectedSig, "hex");
    const actualBuf   = Buffer.from(sigHex, "hex");

    if (expectedBuf.length !== actualBuf.length) return null;
    if (!timingSafeEqual(expectedBuf, actualBuf)) return null;

    // Revocation check (Chapter 6 — token revocation)
    type SessionRow = { revoked: number; expires_at: string };
    const session = db.prepare(
      `SELECT revoked, expires_at FROM agent_sessions WHERE token_id = ?`
    ).get(payload.tid) as SessionRow | undefined;

    if (!session) return null;           // token_id not found in sessions
    if (session.revoked !== 0) return null; // explicitly revoked

    // Double-check DB expiry (belt-and-suspenders)
    if (new Date(session.expires_at).getTime() < Date.now()) return null;

    return {
      agentId: payload.aid,
      role:    payload.role,
      tokenId: payload.tid,
    };
  } catch {
    return null;
  }
}

/**
 * Check if a role is allowed to broadcast a given type.
 * Chapter 14 RBAC: separation of duty enforced here.
 */
export function canBroadcast(role: AgentRole, type: BroadcastType): boolean {
  const allowed = ROLE_PERMISSIONS[role];
  if (!allowed) return false;
  return allowed.includes(type);
}

/**
 * Check if any non-revoked, non-expired sessions exist for this project.
 * Used to determine if RBAC enforcement should be active.
 * Returns false on any error (fail-open for backward compatibility).
 */
export function hasActiveSessions(db: DatabaseSync): boolean {
  try {
    const nowIso = new Date().toISOString();
    const row = db.prepare(`
      SELECT COUNT(*) as n FROM agent_sessions
      WHERE revoked = 0 AND expires_at > ?
    `).get(nowIso) as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Revoke a specific token by token_id.
 * Chapter 6: token revocation.
 */
export function revokeToken(db: DatabaseSync, tokenId: string): void {
  db.prepare(
    `UPDATE agent_sessions SET revoked = 1 WHERE token_id = ?`
  ).run(tokenId);
}

/**
 * Revoke all tokens for a given agent_id.
 * Used when an agent is decommissioned.
 * Chapter 14: RBAC administrative operation.
 */
export function revokeAllAgentTokens(db: DatabaseSync, agentId: string): void {
  db.prepare(
    `UPDATE agent_sessions SET revoked = 1 WHERE agent_id = ?`
  ).run(agentId);
}

/**
 * Count active (non-revoked, non-expired) sessions.
 * Used by zc_status to show RBAC state.
 */
export function countActiveSessions(db: DatabaseSync): number {
  try {
    const nowIso = new Date().toISOString();
    const row = db.prepare(`
      SELECT COUNT(*) as n FROM agent_sessions
      WHERE revoked = 0 AND expires_at > ?
    `).get(nowIso) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}
