/**
 * zc-ctx PostToolUse Hook
 *
 * SECURITY INVARIANTS (never violate):
 * 1. This file NEVER writes outside ~/.claude/zc-ctx/
 * 2. This file NEVER stores file contents, command output, or tool responses
 * 3. This file ONLY stores: file paths, task names, error type strings
 * 4. This file NEVER modifies itself or other hook files
 * 5. This file NEVER makes network requests
 *
 * Purpose: Capture minimal session metadata to enable context continuity.
 * Specifically: which files were written/edited, which tasks completed, which errors occurred.
 */

import { createInterface } from "node:readline";
import { mkdirSync, appendFileSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ZC_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");
const EVENT_LOG_MAX_BYTES = 512 * 1024; // 512 KB — rotate when exceeded
const EVENT_LOG_KEEP_BYTES = 384 * 1024; // keep newest 384 KB after rotation

function getSessionLogPath(projectPath) {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(ZC_DIR, `${hash}.events.jsonl`);
}

/**
 * Append a JSONL line to the event log, rotating if over EVENT_LOG_MAX_BYTES.
 * Rotation keeps the newest EVENT_LOG_KEEP_BYTES of lines (whole-line granularity).
 * SECURITY: Never reads or exposes log content — only manages file size.
 */
function appendEventLine(logPath, line) {
  try {
    if (existsSync(logPath) && statSync(logPath).size > EVENT_LOG_MAX_BYTES) {
      // Keep only the newest tail — slice to KEEP_BYTES then align to a line boundary
      const content = readFileSync(logPath, "utf8");
      const trimmed = content.slice(-EVENT_LOG_KEEP_BYTES);
      const firstNewline = trimmed.indexOf("\n");
      const aligned = firstNewline !== -1 ? trimmed.slice(firstNewline + 1) : trimmed;
      writeFileSync(logPath, aligned, "utf8");
    }
    appendFileSync(logPath, line, "utf8");
  } catch {
    // Never crash Claude Code due to a hook error
  }
}

// SECURITY: Strip all newlines, carriage returns, and null bytes from strings
// stored in JSONL. Without this, a file_path containing \n would inject a
// fake JSONL record into the event log (log injection / JSONL poisoning).
function sanitizeForJsonl(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\x00]/g, " ").slice(0, 500);
}

/**
 * SECURITY: Redact known credential-adjacent parameter names from any tool_input
 * object before it touches the event log. This is a defence-in-depth measure —
 * the current extractSafeEvent() does not log zc_broadcast inputs, but future
 * additions must not accidentally expose channel keys or other secrets.
 *
 * Case-insensitive match on parameter names. Values are replaced with "[REDACTED]".
 */
const REDACTED_PARAM_NAMES = new Set([
  "channel_key", "key", "password", "secret", "token",
  "session_token", "registration_secret",
  "api_key", "apikey", "auth", "credential", "passphrase",
]);

function redactSensitiveParams(toolInput) {
  if (typeof toolInput !== "object" || toolInput === null) return toolInput;
  const out = {};
  for (const [k, v] of Object.entries(toolInput)) {
    out[k] = REDACTED_PARAM_NAMES.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

/** Get the SQLite DB path for a project (mirrors logic in memory.ts) */
function getProjectDbPath(projectPath) {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(ZC_DIR, `${hash}.db`);
}

/**
 * Auto-write a working_memory row to the project SQLite DB.
 * Silently no-ops if DB doesn't exist or schema is not ready.
 * All SQLite writes are wrapped in try/catch — hook must NEVER crash Claude Code.
 */
function autoRememberInDb(dbPath, key, value, importance, agentId) {
  try {
    if (!existsSync(dbPath)) return; // Don't create DB if plugin hasn't initialized it
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 3000");
    db.prepare(`
      INSERT INTO working_memory(key, value, importance, agent_id, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key, agent_id) DO UPDATE SET
        value      = excluded.value,
        importance = excluded.importance,
        created_at = excluded.created_at
    `).run(
      key.slice(0, 100),
      String(value).slice(0, 500),
      importance,
      agentId,
      new Date().toISOString()
    );
    db.close();
  } catch {
    // Never crash Claude Code due to hook error
  }
}

/**
 * Extract only safe, non-content metadata from a tool response.
 * NEVER returns the actual file content or command output.
 */
function extractSafeEvent(toolName, toolInput, toolResponse) {
  // SECURITY: Redact sensitive parameters before any field is accessed.
  // Even though current cases (Write/Edit/Bash/TodoWrite) don't have sensitive params,
  // this ensures any future case addition cannot accidentally log credentials.
  toolInput = redactSensitiveParams(toolInput);
  const now = new Date().toISOString();

  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    const filePath = toolInput?.file_path ?? toolInput?.path ?? null;
    if (!filePath) return null;
    // SECURITY: sanitize file_path to prevent JSONL injection
    return { event_type: "file_write", file_path: sanitizeForJsonl(filePath), created_at: now };
  }

  if (toolName === "Bash") {
    const exitCode = toolResponse?.exit_code ?? toolResponse?.exitCode;
    if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
      const stderr = toolResponse?.stderr ?? toolResponse?.error ?? "";
      // SECURITY: sanitize errorType to prevent JSONL injection
      const errorType = sanitizeForJsonl(String(stderr).split("\n")[0]);
      return { event_type: "error", error_type: errorType, created_at: now };
    }
    return null;
  }

  if (toolName === "TodoWrite") {
    const todos = toolInput?.todos ?? [];
    const completedTasks = todos
      .filter((t) => t.status === "completed")
      // SECURITY: sanitize task names to prevent JSONL injection
      .map((t) => sanitizeForJsonl(String(t.content ?? "")).slice(0, 80));
    if (completedTasks.length === 0) return null;
    return { event_type: "task_complete", task_name: completedTasks.join(", "), created_at: now };
  }

  // Auto-extract MERGE broadcasts to working memory
  if (toolName === "zc_broadcast") {
    // Note: toolInput has already had sensitive params redacted above
    const type    = toolInput?.type;
    const summary = toolInput?.summary;
    const agentId = toolInput?.agent_id;
    if (type === "MERGE" && summary && agentId && String(summary).length > 10) {
      // Return null so no JSONL event is written, but mark for merge auto-remember
      // The actual DB write happens in main() where we have access to projectPath
      return { _autoMerge: true, agentId: String(agentId), summary: String(summary) };
    }
    return null;
  }

  return null;
}

async function main() {
  const lines = [];
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    lines.push(line);
  }

  let event;
  try {
    event = JSON.parse(lines.join("\n"));
  } catch {
    process.exit(0);
  }

  const toolName = event?.tool_name ?? "";
  const toolInput = event?.tool_input ?? {};
  const toolResponse = event?.tool_response ?? {};
  const projectPath = event?.cwd ?? process.cwd();

  const safeEvent = extractSafeEvent(toolName, toolInput, toolResponse);

  // Handle auto-merge memory extraction (no JSONL event needed)
  if (safeEvent && safeEvent._autoMerge) {
    const dbPath = getProjectDbPath(projectPath);
    const date   = new Date().toISOString().slice(0, 10);
    autoRememberInDb(
      dbPath,
      `merge:${safeEvent.agentId}:${date}`,
      safeEvent.summary,
      4,
      "auto"
    );
    process.exit(0);
  }

  if (!safeEvent) {
    // Auto-remember file writes (low importance, auto-namespaced)
    if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
      const rawInput = redactSensitiveParams(toolInput);
      const filePath = rawInput?.file_path ?? rawInput?.path ?? null;
      if (filePath && typeof filePath === "string") {
        const dbPath   = getProjectDbPath(projectPath);
        const fileName = filePath.split("/").pop() || filePath.split("\\").pop() || filePath;
        const date     = new Date().toISOString().slice(0, 16);
        autoRememberInDb(
          dbPath,
          `auto:${filePath}`,
          `Modified: ${fileName} at ${date}`,
          2,
          "auto"
        );
      }
    }
    process.exit(0);
  }

  // Write to JSONL event log — only inside ~/.claude/zc-ctx/ (with rotation)
  try {
    mkdirSync(ZC_DIR, { recursive: true });
    const logPath = getSessionLogPath(projectPath);
    appendEventLine(logPath, JSON.stringify(safeEvent) + "\n");
  } catch {
    // Never crash Claude Code due to a hook error
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
