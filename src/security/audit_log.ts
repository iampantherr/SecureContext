/**
 * Audit Log — Sprint 0 foundation
 * ================================
 *
 * Append-only, HMAC-chained, never-compacted log of security-relevant events.
 *
 * Stored at: ~/.claude/zc-ctx/logs/audit.log (JSONL format)
 *
 * EVERY entry includes:
 *   - timestamp (ISO 8601)
 *   - event name (e.g. "token_issued", "secret_scanner_match", "skill_promoted")
 *   - actor (who did it: agent_id, "system", "operator", etc.)
 *   - target (what it acted on: path, table, role, etc.)
 *   - action (the verb: "create", "read", "delete", "block", etc.)
 *   - result ("ok", "denied", "error", "warning")
 *   - details (free-form structured object — DO NOT include secrets)
 *   - prev_hash + row_hash (HMAC-keyed hash chain via machine_secret)
 *
 * SECURITY GUARANTEES:
 *   - Tamper-evident: each entry chained via HMAC with machine_secret
 *   - Append-only: writes use O_APPEND; no API for editing/deleting entries
 *   - Never sent to LLM context: explicit "audit logs are MCP-tool-invisible"
 *   - Never auto-compacted: rotated by date, never deleted (ops policy)
 *
 * HOW TO USE:
 *   import { auditLog, AuditEvent } from "./security/audit_log.js";
 *
 *   auditLog({
 *     event:  "token_issued",
 *     actor:  "system",
 *     target: agentId,
 *     action: "create",
 *     result: "ok",
 *     details: { role, expiresAt, tokenIdHash: hash(tokenId) },  // NOT the token itself
 *   });
 *
 * DEFENSE PATTERNS:
 *   - If audit_log call fails (disk full, etc.), error is logged via console.error
 *     AND attempt is added to a memory buffer that gets retried periodically.
 *     The CALLING action (e.g. issuing a token) does NOT fail just because audit
 *     failed — but the failure is loud.
 *   - If chain integrity is broken on read, verifyAuditChain() returns the break
 *     point. UI should treat this as critical incident (per §15.8 IR plan).
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  hmacRowHash,
  getLastHashFromRows,
  verifyHmacChain,
  canonicalize,
  GENESIS,
  type ChainableRow,
  type VerifyResult,
} from "./hmac_chain.js";
import { getMachineSecret } from "./machine_secret.js";

// ─── Constants ─────────────────────────────────────────────────────────────

export const AUDIT_LOG_DIR  = join(homedir(), ".claude", "zc-ctx", "logs");
export const AUDIT_LOG_PATH = join(AUDIT_LOG_DIR, "audit.log");

/** Result classification — narrow set on purpose. */
export type AuditResult = "ok" | "denied" | "error" | "warning";

/** Action classification — narrow set on purpose. */
export type AuditAction =
  | "create" | "read"   | "update" | "delete"
  | "issue"  | "revoke"
  | "promote"| "archive"
  | "block"  | "allow"
  | "verify" | "match"  | "drift";

// ─── Types ─────────────────────────────────────────────────────────────────

/** What the caller passes to record an audit event. */
export interface AuditEventInput {
  event:    string;          // dotted name e.g. "token.issued", "secret.scanner.match"
  actor:    string;          // agent_id, "system", "operator", etc.
  target:   string;          // what was acted on
  action:   AuditAction;
  result:   AuditResult;
  details?: Record<string, unknown>;  // structured, NEVER contains secrets
}

/** What gets written to disk + retrieved on read. */
export interface AuditEntry extends AuditEventInput, ChainableRow {
  id:        number;         // monotonic per chain
  ts:        string;         // ISO 8601
  prev_hash: string;
  row_hash:  string;
}

// ─── State ─────────────────────────────────────────────────────────────────

/** In-memory cache of last entry for fast appends without re-reading the file. */
let _lastEntry: AuditEntry | null = null;
let _nextId    = 1;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Record a security audit event. Returns the persisted entry.
 *
 * Call this from any privileged operation: token issue/revoke, RBAC check,
 * skill promotion, mutation, secret-scanner match, file-ownership block, etc.
 *
 * Failure is loud (console.error) but does NOT throw — the calling action
 * should not fail because audit logging failed.
 */
export function auditLog(input: AuditEventInput): AuditEntry | null {
  try {
    ensureLogDir();
    initializeStateIfNeeded();

    const ts = new Date().toISOString();
    const id = _nextId++;
    const prevHash = _lastEntry ? _lastEntry.row_hash : GENESIS;

    // Compute canonical for HMAC
    const canonical = canonicalize([
      id,
      ts,
      input.event,
      input.actor,
      input.target,
      input.action,
      input.result,
      input.details ? JSON.stringify(input.details, sortedReplacer) : "",
    ]);

    const secret = getMachineSecret();
    const rowHash = hmacRowHash(secret, prevHash, canonical);

    const entry: AuditEntry = {
      id,
      ts,
      ...input,
      prev_hash: prevHash,
      row_hash:  rowHash,
    };

    // Append as JSONL
    const line = JSON.stringify(entry, sortedReplacer) + "\n";
    appendFileSync(AUDIT_LOG_PATH, line, { encoding: "utf8" });

    _lastEntry = entry;
    return entry;
  } catch (e) {
    // Loud failure but don't throw — caller's operation shouldn't fail just
    // because audit logging is broken (we want to know via stderr though)
    console.error(`[audit_log] FAILED to record event "${input.event}": ${(e as Error).message}`);
    return null;
  }
}

/**
 * Read all audit entries from disk and return them (parsed).
 * For querying / verification. Does NOT cache — re-reads every call.
 */
export function readAuditLog(): AuditEntry[] {
  if (!existsSync(AUDIT_LOG_PATH)) return [];
  try {
    const raw = readFileSync(AUDIT_LOG_PATH, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l) as AuditEntry);
  } catch (e) {
    console.error(`[audit_log] FAILED to read log: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Verify the audit log's hash chain integrity.
 *
 * Returns OK if every row's HMAC matches its content + prev linkage. Returns
 * BROKEN with the breaking row's id if any tampering is detected.
 *
 * Run this:
 *   - Periodically (cron) for proactive integrity monitoring
 *   - On demand via zc_verify_audit_chain MCP tool (Sprint 1)
 *   - As part of incident response (per §15.8 IR plan)
 */
export function verifyAuditChain(): VerifyResult {
  const entries = readAuditLog();
  if (entries.length === 0) return { ok: true, totalRows: 0 };
  const secret = getMachineSecret();
  return verifyHmacChain<AuditEntry>(secret, entries, (row) =>
    canonicalize([
      row.id,
      row.ts,
      row.event,
      row.actor,
      row.target,
      row.action,
      row.result,
      row.details ? JSON.stringify(row.details, sortedReplacer) : "",
    ])
  );
}

/**
 * Reset in-memory cache (test-only). Forces next write to re-read state from disk.
 */
export function _resetAuditStateForTesting(): void {
  _lastEntry = null;
  _nextId    = 1;
}

// ─── Internal ──────────────────────────────────────────────────────────────

function ensureLogDir(): void {
  if (!existsSync(AUDIT_LOG_DIR)) {
    mkdirSync(AUDIT_LOG_DIR, { recursive: true });
  }
}

/**
 * On first audit_log() call after process start, scan the existing log to find
 * the last entry's id and row_hash, so we can chain new entries correctly.
 *
 * If the file doesn't exist or is empty, start at id=1, prevHash=GENESIS.
 */
function initializeStateIfNeeded(): void {
  if (_lastEntry !== null) return;  // already initialized
  if (!existsSync(AUDIT_LOG_PATH)) {
    _lastEntry = null;
    _nextId    = 1;
    return;
  }
  const entries = readAuditLog();
  if (entries.length === 0) {
    _lastEntry = null;
    _nextId    = 1;
    return;
  }
  // Find max id (defensive — should be sorted already)
  let maxId = 0;
  let lastEntry: AuditEntry | null = null;
  for (const e of entries) {
    if (e.id > maxId) {
      maxId = e.id;
      lastEntry = e;
    }
  }
  _lastEntry = lastEntry;
  _nextId    = maxId + 1;
}

/**
 * JSON.stringify replacer that sorts object keys deterministically.
 * Critical for HMAC consistency — different key orders produce different hashes.
 */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}
