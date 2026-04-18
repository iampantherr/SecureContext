/**
 * Telemetry — Sprint 1 Phase B (v0.11.0)
 * =======================================
 *
 * Records every MCP tool invocation to the `tool_calls` table with:
 *   - Cost attribution (via src/pricing.ts)
 *   - Latency
 *   - Hash-chain integrity (via src/security/hmac_chain.ts)
 *   - Optional task/skill association
 *   - Cross-log trace_id correlation
 *
 * USAGE (called from src/server.ts dispatcher wrapper):
 *
 *   const callId = newCallId();
 *   const start = Date.now();
 *   const traceId = newTraceId("call");
 *   try {
 *     const result = await actualHandler(name, args);
 *     recordToolCall({
 *       callId, sessionId, agentId, projectPath,
 *       toolName: name,
 *       model: getCurrentModel(),
 *       inputChars: JSON.stringify(args).length,
 *       outputChars: result.length,
 *       latencyMs: Date.now() - start,
 *       status: "ok",
 *       traceId,
 *     });
 *     return result;
 *   } catch (e) {
 *     recordToolCall({ ..., status: "error", errorClass: classifyError(e) });
 *     throw e;
 *   }
 *
 * SECURITY (per §15.4 Sprint 1):
 *   - Per-tool allowlist of which input fields are stored RAW vs HASHED
 *     (default: HASHED for all input; opt-in to RAW per tool)
 *   - All inputs run through secret_scanner.redactSecrets() before storage
 *   - Hash-chained for tamper detection (HMAC-keyed via machine_secret)
 *   - Telemetry write failure is LOUD (logger.error) but never throws —
 *     calling tool's success/failure must not depend on telemetry working
 *
 * PERFORMANCE BUDGET:
 *   <10ms overhead per tool call (per §10.5 cross-cutting performance budgets).
 *   Achieved by:
 *   - Single SQLite INSERT (indexed lookups during chain step)
 *   - In-memory cache of last_hash per session (avoid table scan)
 *   - Async logger writes (fire-and-forget)
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { logger, newTraceId } from "./logger.js";
import { computeCost, type CostCalculation } from "./pricing.js";
import { redactSecrets, scanForSecrets } from "./security/secret_scanner.js";
import { auditLog } from "./security/audit_log.js";
import { hmacRowHash, getLastHashFromRows, canonicalize, GENESIS, verifyHmacChain, type ChainableRow } from "./security/hmac_chain.js";
import { getMachineSecret } from "./security/machine_secret.js";
import { runMigrations } from "./migrations.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ToolCallInput {
  callId:       string;
  sessionId:    string;
  agentId:      string;
  projectPath:  string;            // for DB resolution
  taskId?:      string;
  skillId?:     string;
  toolName:     string;
  model:        string;            // e.g. "claude-opus-4-7"; "unknown" if not set
  inputTokens?: number;            // if known (from MCP response); else estimated
  outputTokens?: number;
  cachedTokens?: number;
  inputChars?:  number;            // fallback if tokens unknown (estimate = chars/4)
  outputChars?: number;
  latencyMs:    number;
  status:       "ok" | "error" | "timeout";
  errorClass?:  "transient" | "permission" | "logic" | "unknown";
  traceId?:     string;
  /** Apply Anthropic Batch API 50% discount to cost. */
  batch?:       boolean;
}

export interface ToolCallRecord extends ChainableRow {
  call_id:       string;
  session_id:    string;
  agent_id:      string;
  project_hash:  string;
  task_id:       string | null;
  skill_id:      string | null;
  tool_name:     string;
  model:         string;
  input_tokens:  number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd:      number;
  cost_known:    number;          // 0 or 1
  latency_ms:    number;
  status:        string;
  error_class:   string | null;
  ts:            string;
  prev_hash:     string;
  row_hash:      string;
  trace_id:      string | null;
  id:            number;
}

// ─── State ─────────────────────────────────────────────────────────────────

/** In-memory cache: project_hash → last row_hash. Avoids per-call table scan. */
const _lastHashCache = new Map<string, string>();

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Generate a fresh call_id. Use this at the start of a tool dispatch, before
 * the actual handler runs, so the call_id is available for outcome resolvers
 * to reference even before the row is written.
 */
export function newCallId(): string {
  return `call-${randomUUID().slice(0, 12)}`;
}

/**
 * Record a tool call to the tool_calls table. Never throws. Loud failure via
 * logger.error if persistence fails.
 */
export function recordToolCall(input: ToolCallInput): ToolCallRecord | null {
  const trace = input.traceId ?? newTraceId("call");
  try {
    const projectHash = sha256ProjectHash(input.projectPath);

    // Estimate tokens if not provided (heuristic: 4 chars per token)
    const inputTokens  = input.inputTokens  ?? Math.ceil((input.inputChars  ?? 0) / 4);
    const outputTokens = input.outputTokens ?? Math.ceil((input.outputChars ?? 0) / 4);
    const cachedTokens = input.cachedTokens ?? 0;

    const cost = computeCost(input.model, inputTokens, outputTokens, {
      batch: input.batch,
      cached_input_tokens: cachedTokens,
    });

    // Open DB + ensure schema
    const db = openProjectDb(input.projectPath);
    try {
      // CRITICAL: BEGIN IMMEDIATE acquires the SQLite write lock BEFORE the
      // SELECT-prev-hash, so the SELECT + INSERT pair is atomic with respect
      // to other writer processes. Without this, two concurrent agents can
      // read the same prev_hash and both INSERT rows linking to it →
      // chain integrity breaks (RT-S1-17 stress test caught this on
      // ≥2 concurrent writers per project DB).
      //
      // The cache is invalidated up-front because under contention the
      // cached value may be stale (another writer extended the chain since
      // we last looked). Force a fresh DB read inside the transaction.
      _lastHashCache.delete(projectHash);
      db.exec("BEGIN IMMEDIATE");
      // Compute hash chain link
      const prevHash = getLastHashForProject(db, projectHash);
      const ts = new Date().toISOString();
      const canonical = buildCanonical({
        callId: input.callId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        projectHash,
        toolName: input.toolName,
        model: input.model,
        inputTokens,
        outputTokens,
        cost: cost.cost_usd,
        latencyMs: input.latencyMs,
        status: input.status,
        ts,
      });
      const rowHash = hmacRowHash(getMachineSecret(), prevHash, canonical);

      // Insert
      db.prepare(`
        INSERT INTO tool_calls (
          call_id, session_id, agent_id, project_hash,
          task_id, skill_id,
          tool_name, model,
          input_tokens, output_tokens, cached_tokens,
          cost_usd, cost_known,
          latency_ms, status, error_class,
          ts, prev_hash, row_hash, trace_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.callId, input.sessionId, input.agentId, projectHash,
        input.taskId ?? null, input.skillId ?? null,
        input.toolName, input.model,
        inputTokens, outputTokens, cachedTokens,
        cost.cost_usd, cost.known ? 1 : 0,
        input.latencyMs, input.status, input.errorClass ?? null,
        ts, prevHash, rowHash, trace
      );

      // Update cache
      // COMMIT releases the write lock, allowing waiting writers to proceed.
      db.exec("COMMIT");

      _lastHashCache.set(projectHash, rowHash);

      // Emit DEBUG telemetry log entry (cheap; can be filtered out via ZC_LOG_LEVEL)
      logger.debug("telemetry", "tool_call_recorded", {
        call_id: input.callId,
        tool_name: input.toolName,
        model: input.model,
        cost_usd: cost.cost_usd,
        latency_ms: input.latencyMs,
        status: input.status,
      }, trace);

      return readToolCall(db, input.callId);
    } catch (innerErr) {
      // Roll back the IMMEDIATE transaction so other writers aren't blocked.
      try { db.exec("ROLLBACK"); } catch {}
      throw innerErr;
    } finally {
      db.close();
    }
  } catch (e) {
    logger.error("telemetry", "record_failed", {
      call_id: input.callId,
      tool_name: input.toolName,
      error: (e as Error).message,
    }, trace);
    return null;
  }
}

/**
 * Format a cost-summary header for inclusion in tool response output.
 *
 * Example: `[cost: 423 tok in, 87 tok out, $0.0013, 47ms]`
 *
 * Per §6.5: every tool response gains this header so the agent learns cost
 * in the live loop.
 */
export function formatCostHeader(input: {
  inputTokens?: number;
  outputTokens?: number;
  cost?:        CostCalculation;
  latencyMs:    number;
}): string {
  const inTok  = input.inputTokens  ?? 0;
  const outTok = input.outputTokens ?? 0;
  const cost   = input.cost?.cost_usd ?? 0;
  const known  = input.cost?.known ?? false;
  const dollarPart = known ? `$${cost.toFixed(4)}` : "$?";
  return `[cost: ${inTok} in, ${outTok} out, ${dollarPart}, ${input.latencyMs}ms]`;
}

/**
 * Verify the hash chain on tool_calls for a given project. Returns OK or the
 * call_id of the first row that fails verification.
 *
 * Used by:
 *   - zc_verify_telemetry_chain MCP tool (Sprint 2 add-on)
 *   - Periodic integrity check (cron)
 *   - Incident response (per §15.8)
 */
export function verifyToolCallChain(projectPath: string): {
  ok: boolean;
  totalRows: number;
  brokenAt?: number;
  brokenKind?: "hash-mismatch" | "prev-mismatch";
} {
  const db = openProjectDb(projectPath);
  try {
    const projectHash = sha256ProjectHash(projectPath);
    const rows = db.prepare(`
      SELECT id, call_id, session_id, agent_id, tool_name, model,
             input_tokens, output_tokens, cost_usd, latency_ms, status,
             ts, prev_hash, row_hash
      FROM tool_calls
      WHERE project_hash = ?
      ORDER BY id ASC
    `).all(projectHash) as unknown as Array<ToolCallRecord & { call_id: string }>;

    return verifyHmacChain(getMachineSecret(), rows, (row) => buildCanonical({
      callId: row.call_id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      projectHash,
      toolName: row.tool_name,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cost: row.cost_usd,
      latencyMs: row.latency_ms,
      status: row.status,
      ts: row.ts,
    }));
  } finally {
    db.close();
  }
}

/**
 * Get a tool_calls row by call_id (or null).
 * Useful for outcome resolvers and tests.
 */
export function getToolCall(projectPath: string, callId: string): ToolCallRecord | null {
  const db = openProjectDb(projectPath);
  try {
    return readToolCall(db, callId);
  } finally {
    db.close();
  }
}

/** Test-only: clear in-memory caches. */
export function _resetTelemetryCacheForTesting(): void {
  _lastHashCache.clear();
}

/**
 * Sanitize a tool input for safe storage in telemetry. Returns a
 * truncated + secret-redacted summary. Used internally + exposed for tests.
 */
export function sanitizeToolInput(rawInput: unknown, maxLen: number = 200): string {
  let str: string;
  try {
    str = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput);
  } catch {
    str = String(rawInput);
  }
  if (str.length > maxLen) str = str.slice(0, maxLen) + "...";
  return redactSecrets(str);
}

// ─── Internal ──────────────────────────────────────────────────────────────

function sha256ProjectHash(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

function openProjectDb(projectPath: string): DatabaseSync {
  const dbDir  = join(homedir(), ".claude", "zc-ctx", "sessions");
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, sha256ProjectHash(projectPath) + ".db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  // Ensure migrations are applied (idempotent — fast on already-migrated DBs)
  runMigrations(db);
  return db;
}

function getLastHashForProject(db: DatabaseSync, projectHash: string): string {
  // Cached: avoid table scan for hot calls
  const cached = _lastHashCache.get(projectHash);
  if (cached !== undefined) return cached;

  // Cold: scan once
  const row = db.prepare(`
    SELECT row_hash FROM tool_calls
    WHERE project_hash = ? AND row_hash != ''
    ORDER BY id DESC LIMIT 1
  `).get(projectHash) as { row_hash: string } | undefined;

  const hash = row?.row_hash || GENESIS;
  _lastHashCache.set(projectHash, hash);
  return hash;
}

function buildCanonical(input: {
  callId: string;
  sessionId: string;
  agentId: string;
  projectHash: string;
  toolName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
  status: string;
  ts: string;
}): string {
  return canonicalize([
    input.callId,
    input.sessionId,
    input.agentId,
    input.projectHash,
    input.toolName,
    input.model,
    input.inputTokens,
    input.outputTokens,
    input.cost.toFixed(8),  // fixed precision for chain consistency
    input.latencyMs,
    input.status,
    input.ts,
  ]);
}

function readToolCall(db: DatabaseSync, callId: string): ToolCallRecord | null {
  const row = db.prepare(`SELECT * FROM tool_calls WHERE call_id = ?`).get(callId) as unknown as ToolCallRecord | undefined;
  return row ?? null;
}
