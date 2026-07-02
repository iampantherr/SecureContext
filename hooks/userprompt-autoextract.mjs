/**
 * zc-ctx UserPromptSubmit Hook — Auto-Extract Prompt Buffer (v0.40.0)
 *
 * Companion to stop-autoextract.mjs. Interactive CLI sessions (the A2A terminal
 * agents) no longer persist full message transcripts — the .jsonl next to the
 * session is a title stub — so the Stop-hook extractor can't read conversation
 * content from disk there. This hook captures the one part of the conversation
 * the hook system hands us directly: the USER PROMPT text. It appends each
 * prompt to a small per-session buffer under ~/.claude/zc-ctx/autoextract/;
 * stop-autoextract.mjs consumes and truncates the buffer at turn end.
 *
 * In practice the prompt side carries most durable memory anyway: constraints,
 * decisions, preferences are TOLD to the agent ("use Stripe — final", "prefer Go").
 *
 * SECURITY CONTRACT: writes ONLY under ~/.claude/zc-ctx/autoextract/; no network;
 * buffer is transient (truncated at each extraction, capped at 64 KB); never
 * blocks or modifies the prompt (always exits 0 with no output).
 */

import { createInterface } from "node:readline";
import { mkdirSync, appendFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const STATE_DIR = join(homedir(), ".claude", "zc-ctx", "autoextract");
const BUF_MAX_BYTES = 64 * 1024;

async function main() {
  if (process.env.ZC_AUTO_EXTRACT === "0") return;
  const lines = [];
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) lines.push(line);
  let event;
  try { event = JSON.parse(lines.join("\n")); } catch { return; }

  const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
  const sessionId = event?.session_id || "unknown";
  if (prompt.length < 40) return; // slash commands, one-word nudges — not memory material

  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const bufPath = join(STATE_DIR, `${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.buf`);
    if (existsSync(bufPath) && statSync(bufPath).size > BUF_MAX_BYTES) return; // cap — extractor will drain it
    appendFileSync(bufPath, `user: ${prompt.slice(0, 8000)}\n`, "utf8");
  } catch { /* never break the session */ }
}

main().catch(() => { /* silent */ });
