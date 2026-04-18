/**
 * PostToolUse hook — outcome resolvers (v0.11.0 Sprint 1)
 * ========================================================
 *
 * Fires after each MCP tool call, invokes the appropriate outcome resolver:
 *
 *   Tool=Bash  with "[branch hash]" in stdout → resolveGitCommitOutcome
 *                                                (records "shipped" outcome)
 *   Tool=Read  with file_path                  → resolveFollowUpOutcomes
 *                                                (detects Read-after-summary)
 *
 * SESSION SCOPING:
 *   The hook runs in its own process and has no direct access to the MCP
 *   server's internal MCP_SESSION_ID. We infer it by querying the most
 *   recent tool_call row in the project DB: that's the call we just
 *   completed, so its session_id is the current session. If no row exists
 *   (first call of the session, race), we no-op cleanly.
 *
 * SECURITY:
 *   - Read-only DB query to determine session_id; no writes outside the
 *     already-permitted outcomes.ts path (which respects Sprint 0 HMAC chain).
 *   - All errors swallowed — a hook failure must never crash Claude Code.
 *   - No external network; no shell exec; no symlink traversal.
 *
 * Install:
 *   Copy this file to ~/.claude/hooks/posttool-outcomes.mjs
 *   Register in ~/.claude/settings.json under hooks.PostToolUse with
 *   matcher "Bash|Read"
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
  // Read hook payload
  let raw = "";
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) raw += line + "\n";

  let event;
  try { event = JSON.parse(raw); } catch { process.exit(0); }

  const toolName     = event?.tool_name   ?? event?.toolName ?? "";
  const toolInput    = event?.tool_input  ?? event?.arguments ?? {};
  const toolResponse = event?.tool_response ?? event?.toolResponse ?? event?.response ?? {};
  const projectPath  = event?.cwd ?? process.cwd();

  // Fast reject: only Bash and Read matter for the Sprint 1 resolvers
  if (toolName !== "Bash" && toolName !== "Read") process.exit(0);

  // Determine session id by reading the most recent tool_call row
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

  // Import the SC outcomes module from the installed dist/
  try {
    const scPath = process.env.ZC_CTX_DIST ??
      resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", "AI_projects/SecureContext/dist");
    const scBase = `file://${scPath.replace(/\\/g, "/")}`;
    const { resolveGitCommitOutcome, resolveFollowUpOutcomes } =
      await import(`${scBase}/outcomes.js`);

    if (toolName === "Bash") {
      const stdout = toolResponse?.stdout ?? toolResponse?.output ?? "";
      // Only invoke if stdout non-empty — saves a no-op DB round-trip
      if (stdout && typeof stdout === "string" && stdout.includes("[")) {
        resolveGitCommitOutcome({ projectPath, sessionId, bashOutput: stdout });
      }
    } else if (toolName === "Read") {
      // newToolInput should carry the file_path (or path)
      if (toolInput?.file_path || toolInput?.path) {
        resolveFollowUpOutcomes({
          projectPath,
          sessionId,
          newToolName: "Read",
          newToolInput: toolInput,
        });
      }
    }
  } catch {
    // swallow — hook must never break Claude
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
