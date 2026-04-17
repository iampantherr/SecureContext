/**
 * PostToolUse hook — auto-reindex after Edit/Write (v0.10.0 Harness)
 * ====================================================================
 *
 * After an Edit or Write tool call succeeds, re-summarize the edited file
 * so the KB's L0/L1 for that path stays fresh. Also removes the file from
 * session_read_log (the agent has a legitimate reason to Read it again now
 * that it's been modified).
 *
 * Why: the harness promise is that zc_file_summary is always-current. If the
 * agent edits foo.ts and then calls zc_file_summary(foo.ts), the OLD summary
 * is misleading. This hook closes that loop.
 *
 * Fire-and-forget: the re-summarization runs in the background so it never
 * blocks the agent's next turn.
 *
 * Install:
 *   Copy this file to ~/.claude/hooks/postedit-reindex.mjs
 *   Register in ~/.claude/settings.json under hooks.PostToolUse with
 *   matcher "Edit|Write|MultiEdit"
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input;
try { input = JSON.parse(raw); } catch { process.exit(0); }

const toolName = input.tool_name ?? input.toolName ?? "";
if (!["Edit", "Write", "MultiEdit"].includes(toolName)) process.exit(0);

const toolArgs = input.tool_input ?? input.arguments ?? {};
const path = toolArgs.file_path ?? toolArgs.path ?? "";
if (!path) process.exit(0);

const sessionId   = input.session_id ?? input.sessionId ?? "default";
const projectPath = input.cwd ?? process.cwd();

try {
  const st = statSync(path);
  // Skip reindex for files above the configured size cap — walker also skips them
  if (st.size > 256 * 1024) process.exit(0);

  const scPath = process.env.ZC_CTX_DIST ??
    resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", "AI_projects/SecureContext/dist");
  const scBase = `file://${scPath.replace(/\\/g, "/")}`;
  const { summarizeFile } = await import(`${scBase}/summarizer.js`);
  const { indexContent }  = await import(`${scBase}/knowledge.js`);
  const { clearSessionReadLog } = await import(`${scBase}/harness.js`);

  const content = readFileSync(path, "utf8");
  // Relative path key (same scheme as indexProject)
  const relPath = path.replace(projectPath, "").replace(/^[\/\\]+/, "").replace(/\\/g, "/");
  const source  = `file:${relPath}`;

  // Summarize (semantic if Ollama, truncation fallback otherwise)
  const sum = await summarizeFile(relPath, content);
  indexContent(projectPath, content, source, "internal", "internal", sum.l0, sum.l1);

  // Edit clears the dedup entry — agent can Read the fresh version if needed
  clearSessionReadLog(projectPath, sessionId);
} catch {
  // Silent — never break the agent on hook failure
}

process.exit(0);
