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
 * Extract only safe, non-content metadata from a tool response.
 * NEVER returns the actual file content or command output.
 */
function extractSafeEvent(toolName, toolInput, toolResponse) {
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
  if (!safeEvent) process.exit(0);

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
