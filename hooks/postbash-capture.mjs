/**
 * PostToolUse hook — bash output auto-capture (v0.10.0 Harness)
 * ===============================================================
 *
 * After a Bash tool call, if the stdout is longer than the threshold,
 * archive the full output into the KB (FTS-searchable) and replace it in
 * the agent's context with a compact head/tail summary. The summary +
 * exit code carry the essential info; the full output is queryable via
 * zc_search when needed.
 *
 * Why: a single `npm test` can produce 2000+ lines (~8000 tokens) that
 * parks in the agent's context window forever. On long sessions this is
 * the #1 source of context bloat. Auto-capturing gives ~98% reduction with
 * no loss of recoverability.
 *
 * Install:
 *   Copy this file to ~/.claude/hooks/postbash-capture.mjs
 *   Register in ~/.claude/settings.json under hooks.PostToolUse with
 *   matcher "Bash"
 */

import { resolve } from "node:path";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input;
try { input = JSON.parse(raw); } catch { process.exit(0); }

const toolName = input.tool_name ?? input.toolName ?? "";
if (toolName !== "Bash") process.exit(0);

const toolArgs   = input.tool_input ?? input.arguments ?? {};
const toolResult = input.tool_response ?? input.toolResponse ?? input.response ?? {};

const command = toolArgs.command ?? "";
const stdout  = toolResult.stdout ?? toolResult.output ?? "";
const exit    = Number(toolResult.exit_code ?? toolResult.exitCode ?? 0);

if (!command || !stdout) process.exit(0);

// Threshold check — fall through if not big enough to bother
const threshold = parseInt(process.env.ZC_BASH_CAPTURE_LINES ?? "50", 10);
const lineCount = (stdout.match(/\n/g) ?? []).length + 1;
if (lineCount < threshold) process.exit(0);

const projectPath = input.cwd ?? process.cwd();

try {
  const scPath = process.env.ZC_CTX_DIST ??
    resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", "AI_projects/SecureContext/dist");
  const scBase = `file://${scPath.replace(/\\/g, "/")}`;
  const { captureToolOutput } = await import(`${scBase}/harness.js`);

  // Side-effect only: archive the bash output into PG/SQLite so it's
  // FTS-searchable via zc_search. We do NOT try to modify the agent's
  // tool output — Claude Code's current PostToolUse hook schema rejects
  // {decision:"modify", modifiedOutput:...} with "Hook JSON output
  // validation failed: (root): Invalid input". Discovered live during
  // A2A_communication session.
  // The original UX (auto-replace with summary) is sacrificed in favor
  // of agent reliability — the archive still happens, agent retrieves
  // via zc_search when needed.
  captureToolOutput(projectPath, command, stdout, exit);
  process.exit(0);
} catch {
  process.exit(0);
}
