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
import { computeCost, computeToolCallCost, isInfraTool, type CostCalculation } from "./pricing.js";
import { redactSecrets, scanForSecrets } from "./security/secret_scanner.js";
import { auditLog } from "./security/audit_log.js";
import { canonicalize, type ChainableRow } from "./security/hmac_chain.js";
import { runMigrations } from "./migrations.js";
import { ChainedTableSqlite } from "./security/chained_table_sqlite.js";
import { verifyChainRows } from "./security/chained_table.js";

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

// v0.12.0 note: the per-process _lastHashCache from v0.11.0 was removed.
// With BEGIN IMMEDIATE in ChainedTableSqlite the SELECT happens inside the
// write transaction (sub-millisecond) and the cache was per-process so it
// didn't help across multiple agents anyway. Removing it eliminates the
// cache-staleness bug that the v0.11.0 fix had to work around.

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
 *
 * v0.12.0: Now async (Option 4 from Sprint 2 prep design). The SQLite path
 * is still synchronous internally — the async wrapper allows future Postgres
 * backends without API change. Per-agent HMAC subkey (Tier 1 fix) is applied
 * via ChainedTableSqlite + computeChainHash from chained_table.ts.
 *
 * v0.12.1: When ZC_TELEMETRY_MODE=api, routes through the SecureContext
 * HTTP API's Reference Monitor (Tier 2 fix). The API verifies the writer's
 * session_token + agent_id binding before persisting, blocking cross-agent
 * forgery. Falls back to local-mode if no session_token is available
 * (e.g. RBAC unconfigured).
 */
export async function recordToolCall(input: ToolCallInput): Promise<ToolCallRecord | null> {
  // v0.18.9: 'auto' is the new default — picks API mode when ZC_API_URL +
  // ZC_API_KEY are both set (HA-friendly: only the API server has direct PG
  // creds; many MCP servers POST to it). Falls back to direct local writes
  // when the API isn't reachable. Explicit values ('local'|'api'|'dual') still
  // override.
  const rawMode = (process.env.ZC_TELEMETRY_MODE || "auto").toLowerCase();
  const mode = rawMode === "auto"
    ? ((process.env.ZC_API_URL && process.env.ZC_API_KEY) ? "api" : "local")
    : rawMode;
  if (mode === "api" || mode === "dual") {
    const apiResult = await _recordToolCallViaApiPath(input);
    // dual: also write locally; api-only: return what we got
    if (mode === "api") return apiResult;
    // dual mode falls through to also do local write below
  }
  return _recordToolCallLocal(input);
}

async function _recordToolCallViaApiPath(input: ToolCallInput): Promise<ToolCallRecord | null> {
  // Lazy import so SQLite-only deployments don't pay the import cost
  const { getOrFetchSessionToken, recordToolCallViaApi } = await import("./telemetry_client.js");
  const role = process.env.ZC_AGENT_ROLE || "developer";
  const token = await getOrFetchSessionToken(input.projectPath, input.agentId, role);
  if (!token) {
    // Token unavailable — fall back to local. One-time logged at fetch time.
    return _recordToolCallLocal(input);
  }
  const r = await recordToolCallViaApi(input, token);
  if (r === null) {
    // API failed — local fallback so telemetry isn't lost. (At-least-once
    // semantics: this could double-write in dual mode; acceptable for now.)
    return _recordToolCallLocal(input);
  }
  return r;
}

/**
 * Local-mode dispatch — chooses the storage backend (SQLite vs Postgres)
 * based on `ZC_TELEMETRY_BACKEND` env var. Default 'sqlite' preserves
 * v0.15.0 behavior. 'postgres' routes through ChainedTablePostgres.
 * 'dual' writes to BOTH (migration mode for verifying parity).
 */
async function _recordToolCallLocal(input: ToolCallInput): Promise<ToolCallRecord | null> {
  const backend = (process.env.ZC_TELEMETRY_BACKEND || "sqlite").toLowerCase();
  if (backend === "postgres" || backend === "dual") {
    const pgResult = await _recordToolCallPostgres(input);
    if (backend === "postgres") return pgResult;
    // dual mode: also do SQLite below for parity verification
  }
  return _recordToolCallSqlite(input);
}

/**
 * v0.16.0 Postgres backend for tool_calls.
 * Same chain content (HKDF-keyed HMAC) as SQLite — rows are interchangeable.
 * Uses FOR UPDATE atomic INSERT pattern (see ChainedTablePostgres).
 *
 * Returns null on Postgres-unavailable / write-error so the caller can
 * fall back to SQLite if needed (in dual mode the SQLite write still happens).
 */
async function _recordToolCallPostgres(input: ToolCallInput): Promise<ToolCallRecord | null> {
  const trace = input.traceId ?? newTraceId("call");
  try {
    const projectHash = sha256ProjectHash(input.projectPath);
    const inputTokens  = input.inputTokens  ?? Math.ceil((input.inputChars  ?? 0) / 4);
    const outputTokens = input.outputTokens ?? Math.ceil((input.outputChars ?? 0) / 4);
    const cachedTokens = input.cachedTokens ?? 0;
    // v0.17.1 — use computeToolCallCost which bills the LLM's perspective:
    //   tool-call-args at output rate (LLM generated them in prior turn)
    //   tool-response  at input rate (LLM ingests them on next turn)
    // Naive computeCost treated tool response as LLM output → over-reported
    // by ~5× on Opus. See src/pricing.ts for the full rationale.
    let cost = computeToolCallCost(input.model, inputTokens, outputTokens, {
      batch: input.batch,
      cached_input_tokens: cachedTokens,
    });
    // v0.17.1 Tier 2 — infrastructure tools (zc_recall_context, zc_file_summary,
    // zc_project_card, zc_status) show $0 so infra-tool noise doesn't pollute
    // the orchestrator's delegate-vs-DIY cost comparison. Token counts stay
    // accurate so audits can recompute if needed.
    if (isInfraTool(input.toolName)) {
      cost = { ...cost, cost_usd: 0 };
    }

    // Lazy imports — keep SQLite-only deployments from paying the pg cost
    const { ChainedTablePostgres } = await import("./security/chained_table_postgres.js");
    const { runPgMigrations } = await import("./pg_migrations.js");
    // Run migrations idempotently on every call (cheap after first run)
    await runPgMigrations();

    const ts = new Date().toISOString();
    const canonicalFields = buildCanonicalFields({
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

    const chain = new ChainedTablePostgres({
      tableName:   "tool_calls_pg",
      scopeWhere:  "project_hash = $1",
      scopeParams: [projectHash],
    });

    const result = await chain.appendChainedWith(
      { agentId: input.agentId, projectHash, canonicalFields },
      async ({ prevHash, rowHash, client }) => {
        const r = await client.query(`
          INSERT INTO tool_calls_pg (
            call_id, session_id, agent_id, project_hash,
            task_id, skill_id,
            tool_name, model,
            input_tokens, output_tokens, cached_tokens,
            cost_usd, cost_known,
            latency_ms, status, error_class,
            ts, prev_hash, row_hash, trace_id
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6,
            $7, $8,
            $9, $10, $11,
            $12, $13,
            $14, $15, $16,
            $17, $18, $19, $20
          ) RETURNING id
        `, [
          input.callId, input.sessionId, input.agentId, projectHash,
          input.taskId ?? null, input.skillId ?? null,
          input.toolName, input.model,
          inputTokens, outputTokens, cachedTokens,
          cost.cost_usd, cost.known ? 1 : 0,
          input.latencyMs, input.status, input.errorClass ?? null,
          ts, prevHash, rowHash, trace,
        ]);
        return { id: r.rows[0]?.id ?? 0 };
      }
    );

    logger.debug("telemetry", "tool_call_recorded_pg", {
      call_id: input.callId, tool_name: input.toolName, id: result.id,
    }, trace);

    // Synthesize a ToolCallRecord shape from inputs + chain result.
    return {
      id:            result.id,
      call_id:       input.callId,
      session_id:    input.sessionId,
      agent_id:      input.agentId,
      project_hash:  projectHash,
      task_id:       input.taskId ?? null,
      skill_id:      input.skillId ?? null,
      tool_name:     input.toolName,
      model:         input.model,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cachedTokens,
      cost_usd:      cost.cost_usd,
      cost_known:    cost.known ? 1 : 0,
      latency_ms:    input.latencyMs,
      status:        input.status,
      error_class:   input.errorClass ?? null,
      ts,
      prev_hash:     result.prevHash,
      row_hash:      result.rowHash,
      trace_id:      trace,
    };
  } catch (e) {
    logger.error("telemetry", "tool_call_pg_failed", {
      call_id: input.callId, error: (e as Error).message,
    }, trace);
    return null;
  }
}

async function _recordToolCallSqlite(input: ToolCallInput): Promise<ToolCallRecord | null> {
  const trace = input.traceId ?? newTraceId("call");
  try {
    const projectHash = sha256ProjectHash(input.projectPath);

    // Estimate tokens if not provided (heuristic: 4 chars per token)
    const inputTokens  = input.inputTokens  ?? Math.ceil((input.inputChars  ?? 0) / 4);
    const outputTokens = input.outputTokens ?? Math.ceil((input.outputChars ?? 0) / 4);
    const cachedTokens = input.cachedTokens ?? 0;

    // v0.17.1 — see _recordToolCallPostgres for the tool-call cost rationale.
    let cost = computeToolCallCost(input.model, inputTokens, outputTokens, {
      batch: input.batch,
      cached_input_tokens: cachedTokens,
    });
    if (isInfraTool(input.toolName)) {
      cost = { ...cost, cost_usd: 0 };
    }

    const db = openProjectDb(input.projectPath);
    try {
      const chain = new ChainedTableSqlite(db, {
        tableName:   "tool_calls",
        scopeWhere:  "project_hash = ?",
        scopeParams: [projectHash],
      });

      // Stamp ts here so the canonicalization (which includes ts) and the
      // INSERT (which writes the same ts) match exactly.
      const ts = new Date().toISOString();
      const canonicalFields = buildCanonicalFields({
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

      await chain.appendChainedWith(
        { agentId: input.agentId, projectHash, canonicalFields },
        ({ prevHash, rowHash, db: txnDb }) => {
          txnDb.prepare(`
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
        }
      );

      logger.debug("telemetry", "tool_call_recorded", {
        call_id: input.callId,
        tool_name: input.toolName,
        model: input.model,
        cost_usd: cost.cost_usd,
        latency_ms: input.latencyMs,
        status: input.status,
      }, trace);

      return readToolCall(db, input.callId);
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
  sessionId?:   string;        // v0.20.0 — for context-budget suffix
}): string {
  const inTok  = input.inputTokens  ?? 0;
  const outTok = input.outputTokens ?? 0;
  const cost   = input.cost?.cost_usd ?? 0;
  const known  = input.cost?.known ?? false;
  const dollarPart = known ? `$${cost.toFixed(4)}` : "$?";
  const base = `[cost: ${inTok} in, ${outTok} out, ${dollarPart}, ${input.latencyMs}ms]`;
  // v0.20.0 — context budget suffix. Records this call's tokens into the
  // session's running total + appends "[ctx: X% / 200K — TIER]" so the agent
  // sees its budget in real time. Tier A item #3 from the harness plan.
  if (input.sessionId) {
    try {
      // Lazy import to avoid pulling context_budget.ts into pure-telemetry deployments
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ctx = require("./context_budget.js") as typeof import("./context_budget.js");
      ctx.recordContextUsage(input.sessionId, inTok, outTok, cost);
      return `${base} ${ctx.formatBudgetSuffix(input.sessionId)}`;
    } catch { /* fall through silently */ }
  }
  return base;
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

    // v0.12.0: per-agent HMAC subkey verification (Tier 1).
    // verifyChainRows expects each row to expose its own agentIdForVerify
    // so the verifier can derive the correct per-agent HMAC subkey.
    const rowsForVerify = rows.map((r) => ({ ...r, agentIdForVerify: r.agent_id }));
    return verifyChainRows(rowsForVerify, (row) => canonicalize(buildCanonicalFields({
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
    })));
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

/** Test-only: no-op kept for backward compat with tests written against v0.11.0
 * (the cache it cleared was removed in v0.12.0 — see top-of-file note). */
export function _resetTelemetryCacheForTesting(): void {
  // noop in v0.12.0+
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

/**
 * Build the canonical-fields array hashed into the chain. Returns an array
 * (not a string) so it can flow into the ChainedTable interface unchanged.
 */
function buildCanonicalFields(input: {
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
}): Array<string | number> {
  return [
    input.callId,
    input.sessionId,
    input.agentId,
    input.projectHash,
    input.toolName,
    input.model,
    input.inputTokens,
    input.outputTokens,
    input.cost.toFixed(8),
    input.latencyMs,
    input.status,
    input.ts,
  ];
}

function readToolCall(db: DatabaseSync, callId: string): ToolCallRecord | null {
  const row = db.prepare(`SELECT * FROM tool_calls WHERE call_id = ?`).get(callId) as unknown as ToolCallRecord | undefined;
  return row ?? null;
}
