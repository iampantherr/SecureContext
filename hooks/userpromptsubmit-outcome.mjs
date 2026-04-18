/**
 * UserPromptSubmit hook — user sentiment outcome (v0.11.0 Sprint 1)
 * ==================================================================
 *
 * Fires when the user submits a prompt. Invokes resolveUserPromptOutcome,
 * which applies a POSITIVE/NEGATIVE regex classifier and, on match, records
 * an "accepted" or "rejected" outcome against the most recent tool_call.
 *
 * Confidence is intentionally low (0.5) because this is a weak inferred
 * signal — the user may be reacting to something other than the last tool.
 *
 * PRIVACY:
 *   - Raw prompt text is NEVER persisted. Only sentiment label + message
 *     length are stored in the outcome's evidence column (verified by
 *     src/outcomes.test.ts RT-S1-11).
 *
 * SESSION SCOPING: same as posttool-outcomes.mjs (infer via most-recent
 * tool_call row).
 *
 * Install:
 *   Copy this file to ~/.claude/hooks/userpromptsubmit-outcome.mjs
 *   Register in ~/.claude/settings.json under hooks.UserPromptSubmit
 *   (no matcher — all prompts).
 */

import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function projectDbPath(projectPath) {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(homedir(), ".claude", "zc-ctx", "sessions", hash + ".db");
}

async function main() {
  let raw = "";
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) raw += line + "\n";

  let event;
  try { event = JSON.parse(raw); } catch { process.exit(0); }

  // UserPromptSubmit payload shape variants across Claude Code versions
  const userMessage =
    event?.prompt ??
    event?.user_message ??
    event?.message ??
    event?.text ??
    "";
  const projectPath = event?.cwd ?? process.cwd();

  if (!userMessage || typeof userMessage !== "string") process.exit(0);
  if (userMessage.length > 10_000) process.exit(0);   // defensive upper cap

  const dbPath = projectDbPath(projectPath);
  if (!existsSync(dbPath)) process.exit(0);

  let sessionId;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 3000");
    const row = db.prepare(
      "SELECT session_id FROM tool_calls ORDER BY id DESC LIMIT 1"
    ).get();
    db.close();
    sessionId = row?.session_id;
  } catch {
    process.exit(0);
  }
  if (!sessionId) process.exit(0);

  try {
    const scPath = process.env.ZC_CTX_DIST ??
      resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", "AI_projects/SecureContext/dist");
    const scBase = `file://${scPath.replace(/\\/g, "/")}`;
    const { resolveUserPromptOutcome } = await import(`${scBase}/outcomes.js`);
    resolveUserPromptOutcome({ projectPath, sessionId, userMessage });
  } catch {
    // swallow
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
