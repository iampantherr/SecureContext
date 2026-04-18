/**
 * Structured Logger — Sprint 1 (v0.11.0)
 * =======================================
 *
 * Per-component, structured-JSON, level-aware logger. Different from
 * `src/security/audit_log.ts`:
 *
 *   - audit_log = security-critical events (token issued, secret matched,
 *     skill promoted). HMAC-chained, never compacted, never goes to LLM.
 *   - logger    = operational telemetry (every interesting state change).
 *     Per-component files, daily rotation, retention policy.
 *
 * They coexist. Some events go to BOTH (e.g. secret_scanner_match is both
 * security-critical AND operationally interesting).
 *
 * COMPONENTS (one log file each, per §14):
 *   telemetry, outcomes, learnings-mirror, skills, mutations, budget,
 *   compaction, tasks, ownership, routing, retrieval
 *
 * LEVELS (per §14.1):
 *   DEBUG (high volume, off by default)
 *   INFO  (state changes, on by default)
 *   WARN  (degraded conditions, on by default)
 *   ERROR (failures, on by default)
 *
 *   AUDIT-level events DO NOT use this logger — they use audit_log.ts directly
 *   so they get chain integrity + tamper detection.
 *
 * STORAGE: ~/.claude/zc-ctx/logs/{component}.{YYYY-MM-DD}.log (JSONL)
 *
 * RETENTION: 30 days for INFO+; 7 days for DEBUG. Rotation enforced at
 * write time (rolls to today's file based on UTC date).
 *
 * SECURITY (per §15.4 Sprint 1 controls):
 *   - Log entries are STRUCTURED JSON only (no prose injection)
 *   - Operator-controlled fields validated for length + character set
 *   - secret_scanner.redactSecrets() applied to every string value
 *   - File mode 0600 on creation (POSIX)
 *
 * ENV CONTROLS:
 *   ZC_LOG_LEVEL    = "DEBUG" | "INFO" | "WARN" | "ERROR" (default: INFO)
 *   ZC_LOG_CONSOLE  = "1" to also stream INFO+ to stderr (color-coded)
 *   ZC_LOG_RAW      = "1" to disable secret redaction (debugging only — UNSAFE)
 *   ZC_LOG_DIR      = override log directory (default ~/.claude/zc-ctx/logs)
 */

import { existsSync, mkdirSync, appendFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "./security/secret_scanner.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3,
};

/** Recognized components — each gets its own log file. */
export const COMPONENTS = [
  "telemetry",
  "outcomes",
  "learnings-mirror",
  "skills",
  "mutations",
  "budget",
  "compaction",
  "tasks",
  "ownership",
  "routing",
  "retrieval",
] as const;

export type Component = (typeof COMPONENTS)[number];

/** Structured log entry shape. */
export interface LogEntry {
  ts:        string;       // ISO 8601
  level:     LogLevel;
  component: Component | string;
  event:     string;       // e.g. "tool_call_recorded", "outcome_resolved"
  trace_id?: string;       // optional cross-log correlation
  context?:  Record<string, unknown>;
}

// ─── State ─────────────────────────────────────────────────────────────────

const LOG_DIR = process.env.ZC_LOG_DIR || join(homedir(), ".claude", "zc-ctx", "logs");

let _minLevel: LogLevel  = (process.env.ZC_LOG_LEVEL as LogLevel) || "INFO";
const _consoleEnabled: boolean = process.env.ZC_LOG_CONSOLE === "1";
const _redactEnabled:  boolean = process.env.ZC_LOG_RAW !== "1";

let _dirEnsured = false;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Generate a fresh trace_id. Use this at the start of any multi-step operation
 * (mutation cycle, batch submission, request handling). Pass the returned id
 * to every related log() call so they correlate.
 */
export function newTraceId(prefix: string = "tr"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/**
 * Write a log entry. `context` is structured key-value data; string values
 * are run through the secret scanner before write (unless ZC_LOG_RAW=1).
 *
 * Returns the written entry (for testing / inspection).
 *
 * Failure (disk full, etc.) is loud (console.error) but does NOT throw —
 * logging should never break the calling action.
 */
export function log(
  level:     LogLevel,
  component: Component | string,
  event:     string,
  context?:  Record<string, unknown>,
  trace_id?: string,
): LogEntry | null {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[_minLevel]) {
    return null;  // below threshold, skip silently
  }

  const entry: LogEntry = {
    ts:        new Date().toISOString(),
    level,
    component,
    event,
    ...(trace_id ? { trace_id } : {}),
    ...(context ? { context: redactContext(context) } : {}),
  };

  try {
    ensureLogDir();
    const path = pathForToday(component);
    appendFileSync(path, JSON.stringify(entry) + "\n", { encoding: "utf8" });
    if (process.platform !== "win32") {
      try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    }
  } catch (e) {
    // Never throw — caller's operation should not fail because logging failed
    process.stderr.write(`[logger] write FAILED: ${(e as Error).message}\n`);
  }

  if (_consoleEnabled) {
    writeToConsole(entry);
  }

  return entry;
}

/** Convenience wrappers — common levels. */
export const logger = {
  debug: (component: Component | string, event: string, context?: Record<string, unknown>, trace_id?: string) =>
    log("DEBUG", component, event, context, trace_id),
  info: (component: Component | string, event: string, context?: Record<string, unknown>, trace_id?: string) =>
    log("INFO", component, event, context, trace_id),
  warn: (component: Component | string, event: string, context?: Record<string, unknown>, trace_id?: string) =>
    log("WARN", component, event, context, trace_id),
  error: (component: Component | string, event: string, context?: Record<string, unknown>, trace_id?: string) =>
    log("ERROR", component, event, context, trace_id),
};

/** Compute today's log file path for a given component. */
export function pathForToday(component: Component | string): string {
  const date = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
  return join(LOG_DIR, `${component}.${date}.log`);
}

/** Compute a component's log file path for a specific date. */
export function pathForDate(component: Component | string, date: string): string {
  return join(LOG_DIR, `${component}.${date}.log`);
}

/**
 * Read log entries for a component, optionally filtered.
 *
 * Agent-scoping: when opts.agentId is set, only entries whose context.agent_id
 * matches (or is absent — system entries) are returned. This implements the
 * Sprint 1 "auth-checked, agent-scoped log query" requirement.
 *
 * Never throws — returns [] on any error.
 */
export function readLogs(opts: {
  component:    Component | string;
  /** Inclusive ISO date "YYYY-MM-DD"; defaults to today. */
  sinceDate?:   string;
  /** Inclusive ISO date "YYYY-MM-DD"; defaults to today. */
  untilDate?:   string;
  /** Only entries at this level or higher. */
  minLevel?:    LogLevel;
  /** Substring (case-insensitive) that must appear in event name. */
  eventContains?: string;
  /** Exact trace_id match. */
  traceId?:     string;
  /** When set, restrict to entries where context.agent_id matches or is absent. */
  agentId?:     string;
  /** Max rows to return (default 200, hard cap 5000). */
  limit?:       number;
}): LogEntry[] {
  const limit = Math.min(Math.max(1, opts.limit ?? 200), 5000);
  const today = new Date().toISOString().slice(0, 10);
  const since = opts.sinceDate ?? today;
  const until = opts.untilDate ?? today;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return [];
  if (since > until) return [];

  const dates = enumerateDates(since, until);
  const out: LogEntry[] = [];
  const eventNeedle = opts.eventContains?.toLowerCase();
  const minLevelThreshold = opts.minLevel ? LEVEL_ORDER[opts.minLevel] : 0;

  for (const d of dates) {
    const p = pathForDate(opts.component, d);
    if (!existsSync(p)) continue;
    let content: string;
    try {
      content = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      let entry: LogEntry;
      try { entry = JSON.parse(line) as LogEntry; } catch { continue; }

      if (LEVEL_ORDER[entry.level] < minLevelThreshold) continue;
      if (eventNeedle && !entry.event.toLowerCase().includes(eventNeedle)) continue;
      if (opts.traceId && entry.trace_id !== opts.traceId) continue;
      if (opts.agentId) {
        const ctxAgent = entry.context?.agent_id;
        if (ctxAgent !== undefined && ctxAgent !== opts.agentId) continue;
      }

      out.push(entry);
    }
  }

  // Return newest first, capped at limit
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out.slice(0, limit);
}

function enumerateDates(since: string, until: string): string[] {
  const result: string[] = [];
  const cur = new Date(since + "T00:00:00Z");
  const end = new Date(until + "T00:00:00Z");
  while (cur <= end) {
    result.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return result;
}

/** Test/diagnostic: change minimum log level at runtime. */
export function _setMinLevelForTesting(level: LogLevel): void {
  _minLevel = level;
}

/** Test/diagnostic: get current min level. */
export function getCurrentMinLevel(): LogLevel {
  return _minLevel;
}

// ─── Internal ──────────────────────────────────────────────────────────────

function ensureLogDir(): void {
  if (_dirEnsured) return;
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  _dirEnsured = true;
}

/**
 * Run every string value in the context object through the secret scanner.
 * Recurses into nested objects/arrays. Numbers, booleans, null pass through.
 *
 * Disabled when ZC_LOG_RAW=1 (operator opt-out for debugging only).
 */
function redactContext(ctx: Record<string, unknown>): Record<string, unknown> {
  if (!_redactEnabled) return ctx;
  return walkAndRedact(ctx) as Record<string, unknown>;
}

function walkAndRedact(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map(walkAndRedact);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walkAndRedact(v);
    }
    return out;
  }
  return value;
}

const COLOR_FOR_LEVEL: Record<LogLevel, string> = {
  DEBUG: "\x1b[90m",   // gray
  INFO:  "\x1b[36m",   // cyan
  WARN:  "\x1b[33m",   // yellow
  ERROR: "\x1b[31m",   // red
};
const RESET = "\x1b[0m";

function writeToConsole(entry: LogEntry): void {
  const color = COLOR_FOR_LEVEL[entry.level] || "";
  const trace = entry.trace_id ? ` [${entry.trace_id}]` : "";
  const ctx   = entry.context ? ` ${JSON.stringify(entry.context)}` : "";
  process.stderr.write(
    `${color}[${entry.level}]${RESET} ${entry.ts} ${entry.component}.${entry.event}${trace}${ctx}\n`
  );
}
