/**
 * PreToolUse hook — Read dedup guard (v0.10.0 Harness)
 * =====================================================
 *
 * Claude Code fires this hook BEFORE any Read tool call. We intercept it and
 * check whether the file was already Read in the current session (via the
 * session_read_log table). If yes, block the Read and redirect the agent to
 * zc_file_summary or zc_search.
 *
 * Why: re-Reading a file to "verify" is a classic token-waste pattern. The
 * KB has a fresh L0/L1 summary (auto-refreshed by the PostEdit hook); there
 * is no reason to re-Read the same file twice in one session unless you've
 * written to it since.
 *
 * Security notes:
 * - Read-only access to the SQLite DB via the harness module
 * - No network egress, no file writes
 * - Opt-out: set ZC_READ_DEDUP_ENABLED=0
 * - Escape hatch: agent can include the word "force" in the tool call
 *   arguments JSON to override (reserved for legitimate re-Read scenarios)
 *
 * Install:
 *   Copy this file to ~/.claude/hooks/preread-dedup.mjs
 *   Register in ~/.claude/settings.json under hooks.PreToolUse with
 *   matcher "Read"
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Read the hook payload from stdin (Claude Code's hook protocol)
let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  // Malformed payload — let the Read through rather than break the agent
  process.exit(0);
}

// Only act on Read tool calls
const toolName = input.tool_name ?? input.toolName ?? "";
if (toolName !== "Read") process.exit(0);

// Extract the target path
const toolArgs = input.tool_input ?? input.arguments ?? {};
const path = toolArgs.file_path ?? toolArgs.path ?? "";
if (!path) process.exit(0);

// Opt-out guard
if (process.env.ZC_READ_DEDUP_ENABLED === "0") process.exit(0);

// Session ID — Claude Code provides this in the hook payload
const sessionId = input.session_id ?? input.sessionId ?? "default";

// Project path — cwd at the time the hook fires
const projectPath = input.cwd ?? process.cwd();

try {
  // Dynamic import — dist/ may be at different paths depending on install layout
  const scPath = process.env.ZC_CTX_DIST ?? resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", "AI_projects/SecureContext/dist");
  const { wasReadThisSession, recordSessionRead } = await import(`file://${scPath.replace(/\\/g, "/")}/harness.js`);

  if (wasReadThisSession(projectPath, sessionId, path)) {
    // Block the Read, tell the agent what to do instead
    const hint =
      `[zc-ctx harness] Read blocked: '${path}' was already Read in this session.\n\n` +
      `Use one of:\n` +
      `  - zc_file_summary("${path}")  — L0/L1 summary, no re-Read\n` +
      `  - zc_search(["<your question>"])  — keyword+semantic search\n` +
      `  - zc_check("<your question>", path="${path}")  — memory-first answer\n\n` +
      `If you genuinely need to re-Read (e.g. the file was externally modified), ` +
      `add "force": true to the Read arguments or set ZC_READ_DEDUP_ENABLED=0.`;

    process.stdout.write(JSON.stringify({
      continue: false,
      decision: "block",
      reason: hint,
    }));
    process.exit(0);
  }

  // First time this path is Read this session — record it and allow through.
  recordSessionRead(projectPath, sessionId, path);
  process.exit(0);
} catch {
  // Never break the agent on hook failure — let the Read through.
  process.exit(0);
}
