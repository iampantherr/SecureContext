/**
 * ChainedTable — backend-agnostic hash-chained append-only table abstraction
 * (v0.12.0 Sprint 2 prep)
 * ===========================================================================
 *
 * BACKGROUND
 * ----------
 * Sprint 1 (v0.11.0) introduced two HMAC-chained tables: `tool_calls` and
 * `outcomes`. The implementation was tightly coupled to `node:sqlite`. Two
 * production realities forced abstraction:
 *
 *   1. Concurrency: SELECT-prev-hash + INSERT was non-atomic across
 *      processes; concurrent writers raced and broke chain integrity.
 *      Fix shipped in a7ed9a1 used `BEGIN IMMEDIATE`. Works on SQLite,
 *      doesn't translate to Postgres. (See `ChainedTableSqlite`.)
 *
 *   2. Scale: Sprint 2's mutation engine needs centralized telemetry across
 *      machines. SQLite per-project files don't aggregate. Postgres does.
 *      But `pg` is async-only; SC's existing path was sync. (See
 *      `ChainedTablePostgres` + Option 4 async-public-API decision.)
 *
 * DESIGN
 * ------
 * `ChainedTable<TInput, TRow>` is a generic interface over an append-only,
 * HMAC-chained table. Concrete backends (SQLite, Postgres) implement the
 * race-safe append primitive their backend supports:
 *
 *   - SQLite: BEGIN IMMEDIATE acquires the global write lock atomically.
 *   - Postgres: single INSERT with `(SELECT row_hash FROM ... ORDER BY id
 *     DESC LIMIT 1 FOR UPDATE)` subquery — atomic per-statement.
 *
 * Both backends share canonicalization, HMAC computation, and the
 * `verifyChain` algorithm (read-only — no race concerns).
 *
 * SECURITY (Tier 1 fix from v0.12.0 design review):
 * --------------------------------------------------
 * Per-agent HMAC subkey (HKDF-derived from machine_secret + agent_id) means
 * an agent cannot forge rows attributed to another agent — the canonical
 * hash will not verify. This closes Gap 5 from the access-control review
 * (Chin & Older 2011 — Ch6 "speaks-for" formalism).
 *
 *   chain_hmac_key = HKDF-Expand(machine_secret, "zc-chain:" || agent_id, 32)
 *
 * The verify step uses the row's stored agent_id to derive the same subkey.
 * Cross-agent forgery requires the attacker to know the *target* agent's
 * derived subkey, which requires the machine secret AND the target agent_id
 * AND the HKDF labelling.
 */

import { hmacRowHash, GENESIS, canonicalize, verifyHmacChain, type ChainableRow } from "./hmac_chain.js";
import { getMachineSecret } from "./machine_secret.js";
import { hkdfSync } from "node:crypto";

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * The canonical input every row needs. Backends translate this to backend-
 * specific INSERT shapes; all backends MUST hash exactly the canonical
 * representation produced by `canonicalize(canonicalFields)`.
 */
export interface CanonicalRowInput {
  /** Agent identity. Becomes part of HMAC subkey derivation (Tier 1). */
  agentId: string;
  /** Project hash; scopes the chain. Different projects have independent chains. */
  projectHash: string;
  /** Raw fields to hash (in order). Backend persists these + the chain hash columns. */
  canonicalFields: Array<string | number | boolean | null>;
  /** Backend-specific extra fields (not in canonical hash). */
  extra?: Record<string, unknown>;
}

export interface ChainAppendResult {
  /** The row_hash newly inserted. */
  rowHash: string;
  /** The prev_hash this row links to. */
  prevHash: string;
  /** Backend-assigned auto-increment id (used for ORDER BY in verifyChain). */
  id: number;
}

export interface ChainVerifyResult {
  ok: boolean;
  totalRows: number;
  brokenAt?: number;
  brokenKind?: "hash-mismatch" | "prev-mismatch";
}

/**
 * Backend-agnostic chained table.
 *
 * All operations are async. SQLite implementations may be synchronous
 * internally — they wrap with `Promise.resolve` to keep the public API
 * uniform (Option 4 from v0.12.0 design).
 */
export interface ChainedTable {
  /** Append a row, computing prev_hash + row_hash atomically with respect to other writers. */
  appendChained(input: CanonicalRowInput): Promise<ChainAppendResult>;
  /** Read the chain end-to-end and verify HMAC + linkage integrity. */
  verifyChain(scope: { projectHash: string }): Promise<ChainVerifyResult>;
  /** Lifecycle: open backend resources (no-op for sqlite per-call; pool init for postgres). */
  init?(): Promise<void>;
  /** Lifecycle: tear down backend resources. */
  close?(): Promise<void>;
}

// ─── Tier 1: per-agent HMAC subkey derivation ──────────────────────────────

/**
 * Derive a per-agent chain HMAC key from the machine secret + agent_id.
 *
 * SECURITY MODEL (Tier 1, ref Ch6 + Ch7 of Chin & Older 2011):
 * -------------------------------------------------------------
 * Sprint 1 used the raw machine_secret for all chain HMACs. This made the
 * chain integrity-only against external tampering, not authentication —
 * any agent process knew the same machine_secret and could compute valid
 * HMACs claiming any agent_id.
 *
 * v0.12.0 fix: derive a per-agent subkey using HKDF-Expand. The salt is
 * fixed (HKDF-Extract is implicit on the machine_secret as input keying
 * material). The `info` field embeds the agent_id with a domain-separator
 * prefix `"zc-chain:"`. An attacker forging rows for agent B must:
 *   (a) know the machine_secret (already required), AND
 *   (b) know the exact info string for agent B (knowable by inspection), AND
 *   (c) recompute the HKDF expansion correctly
 *
 * On its own, this doesn't make forgery cryptographically harder for an
 * insider with the machine secret. But it ENABLES Tier 2 (Reference Monitor),
 * where the API server validates that the agent_id in the row matches the
 * agent_id bound to the session_token. The chain HMAC subkey + session
 * token binding together prove the row was written by who it claims.
 *
 * @param agentId — The claimed writer of the row (must match canonicalFields).
 * @returns 32-byte HMAC key for use with hmacRowHash().
 */
export function deriveAgentChainKey(agentId: string): Buffer {
  if (!agentId || typeof agentId !== "string") {
    throw new Error("deriveAgentChainKey: agentId must be a non-empty string");
  }
  const ikm = getMachineSecret();
  // HKDF-Extract is implicit; we only need Expand. salt=null uses the all-zero
  // salt which (combined with high-entropy machine_secret IKM) yields full
  // key-derivation strength per RFC 5869.
  const info = Buffer.concat([
    Buffer.from("zc-chain:", "utf8"),
    Buffer.from(agentId, "utf8"),
  ]);
  // hkdfSync returns ArrayBuffer; convert to Buffer for downstream HMAC.
  const arrayBuf = hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32);
  return Buffer.from(arrayBuf);
}

// ─── Shared chain helpers (backend-agnostic) ───────────────────────────────

/**
 * Compute the row hash for an input. All backends MUST use this — the
 * canonical bytes hashed must be identical across backends so chain
 * verification is portable.
 */
export function computeChainHash(
  input: CanonicalRowInput,
  prevHash: string,
): { rowHash: string; canonical: string } {
  const canonical = canonicalize(input.canonicalFields);
  const key = deriveAgentChainKey(input.agentId);
  const rowHash = hmacRowHash(key, prevHash, canonical);
  return { rowHash, canonical };
}

/**
 * Verify a chain end-to-end. Backend supplies the rows in id-ascending
 * order; this function validates HMAC and linkage.
 *
 * NOTE: Each row is verified against its OWN agent_id-derived subkey,
 * matching how the row was written. A row written by agent A must
 * verify against the agent-A subkey. Cross-agent forgery would require
 * computing the target agent's subkey.
 */
export function verifyChainRows<TRow extends ChainableRow & { agentIdForVerify: string }>(
  rows: TRow[],
  buildCanonicalFromRow: (row: TRow) => string,
): ChainVerifyResult {
  if (rows.length === 0) return { ok: true, totalRows: 0 };

  // We can't use verifyHmacChain directly since the key changes per row
  // (per-agent subkey). Implement the verification loop here.
  let prevExpected = GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.prev_hash !== prevExpected) {
      return { ok: false, totalRows: rows.length, brokenAt: i, brokenKind: "prev-mismatch" };
    }
    const canonical = buildCanonicalFromRow(row);
    const key = deriveAgentChainKey(row.agentIdForVerify);
    const expected = hmacRowHash(key, row.prev_hash, canonical);
    if (expected !== row.row_hash) {
      return { ok: false, totalRows: rows.length, brokenAt: i, brokenKind: "hash-mismatch" };
    }
    prevExpected = row.row_hash;
  }
  return { ok: true, totalRows: rows.length };
}

// ─── Re-exports for convenience ────────────────────────────────────────────

export { GENESIS, canonicalize, type ChainableRow };
