/**
 * zc-ctx Stop Hook — Session Boundary Marker
 *
 * Fires when a Claude Code conversation ends (Stop event).
 * Writes a lightweight "session_ended" marker to the JSONL event log so that
 * zc_recall_context() can surface session boundaries in future conversations.
 *
 * SECURITY INVARIANTS (same as posttooluse.mjs):
 * 1. NEVER writes outside ~/.claude/zc-ctx/
 * 2. NEVER stores conversation content or file data
 * 3. NEVER makes network requests
 * 4. NEVER modifies itself or other hook files
 */

import { createInterface } from "node:readline";
import { mkdirSync, appendFileSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const ZC_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");
const EVENT_LOG_MAX_BYTES = 512 * 1024;
const EVENT_LOG_KEEP_BYTES = 384 * 1024;

function getSessionLogPath(projectPath) {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(ZC_DIR, `${hash}.events.jsonl`);
}

function appendEventLine(logPath, line) {
  try {
    if (existsSync(logPath) && statSync(logPath).size > EVENT_LOG_MAX_BYTES) {
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

  const projectPath = event?.cwd ?? process.cwd();
  const now = new Date().toISOString();

  try {
    mkdirSync(ZC_DIR, { recursive: true });
    const logPath = getSessionLogPath(projectPath);
    appendEventLine(logPath, JSON.stringify({ event_type: "session_ended", created_at: now }) + "\n");
  } catch {
    // Never crash Claude Code due to a hook error
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
