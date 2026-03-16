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
import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const ZC_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");
const EVENT_LOG_MAX_BYTES = 512 * 1024; // 512 KB per session log — auto-rotate after

function getSessionLogPath(projectPath) {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(ZC_DIR, `${hash}.events.jsonl`);
}

/**
 * Extract only safe, non-content metadata from a tool response.
 * NEVER returns the actual file content or command output.
 */
function extractSafeEvent(toolName, toolInput, toolResponse) {
  const now = new Date().toISOString();

  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    // Only capture: that a file was touched, which path
    const filePath = toolInput?.file_path ?? toolInput?.path ?? null;
    if (!filePath) return null;
    return { event_type: "file_write", file_path: filePath, created_at: now };
  }

  if (toolName === "Bash") {
    // Only capture errors — and only the error type, not the output
    const exitCode = toolResponse?.exit_code ?? toolResponse?.exitCode;
    if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
      // Extract just the error class from stderr (first line, truncated to 120 chars)
      const stderr = toolResponse?.stderr ?? toolResponse?.error ?? "";
      const errorType = String(stderr).split("\n")[0].slice(0, 120);
      return { event_type: "error", error_type: errorType, created_at: now };
    }
    return null; // Successful bash commands: capture nothing
  }

  if (toolName === "TodoWrite") {
    // Only capture task completion events — not task content
    const todos = toolInput?.todos ?? [];
    const completedTasks = todos
      .filter((t) => t.status === "completed")
      .map((t) => String(t.content ?? "").slice(0, 80));
    if (completedTasks.length === 0) return null;
    return { event_type: "task_complete", task_name: completedTasks.join(", "), created_at: now };
  }

  return null; // All other tools: capture nothing
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

  // Write to JSONL event log — only inside ~/.claude/zc-ctx/
  try {
    mkdirSync(ZC_DIR, { recursive: true });
    const logPath = getSessionLogPath(projectPath);
    const line = JSON.stringify(safeEvent) + "\n";
    appendFileSync(logPath, line, "utf8");
  } catch {
    // Never crash Claude Code due to a hook error
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
