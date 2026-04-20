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
import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function normalizeProjectPath(projectPath) {
  try { return realpathSync(projectPath); }
  catch { return projectPath; }
}

function projectDbPath(projectPath) {
  const hash = createHash("sha256").update(normalizeProjectPath(projectPath)).digest("hex").slice(0, 16);
  return join(homedir(), ".claude", "zc-ctx", "sessions", hash + ".db");
}

// v0.17.0 — when ZC_TELEMETRY_BACKEND=postgres|dual the session's tool_calls
// live in tool_calls_pg, not SQLite. Query PG for the latest session_id in that
// case; otherwise fall back to SQLite. Returns null if neither store has rows.
async function resolveSessionId(projectPath) {
  const backend = (process.env.ZC_TELEMETRY_BACKEND || "sqlite").toLowerCase();
  if (backend === "postgres" || backend === "dual") {
    try {
      // pg is installed in the SC repo's node_modules; hook runs from
      // ~/.claude/hooks/ which has no node_modules of its own.
      let pg;
      try { pg = await import("pg"); }
      catch {
        const candidates = [];
        if (process.env.ZC_REPO_DIR) candidates.push(join(process.env.ZC_REPO_DIR, "node_modules/pg/lib/index.js"));
        candidates.push(join(homedir(), "AI_projects/SecureContext/node_modules/pg/lib/index.js"));
        candidates.push("C:/Users/Amit/AI_projects/SecureContext/node_modules/pg/lib/index.js");
        for (const p of candidates) {
          if (!existsSync(p)) continue;
          try { pg = await import("file:///" + p.replace(/\\/g, "/")); break; } catch { /* try next */ }
        }
      }
      if (pg) {
        const Pool = pg.Pool || (pg.default && pg.default.Pool);
        if (Pool) {
          const pool = new Pool({
            host:     process.env.ZC_POSTGRES_HOST     || "localhost",
            port:     Number(process.env.ZC_POSTGRES_PORT || 5432),
            user:     process.env.ZC_POSTGRES_USER     || "scuser",
            password: process.env.ZC_POSTGRES_PASSWORD || "",
            database: process.env.ZC_POSTGRES_DB       || "securecontext",
            max: 2,
            idleTimeoutMillis: 3_000,
          });
          try {
            const projectHashStr = createHash("sha256").update(normalizeProjectPath(projectPath)).digest("hex").slice(0, 16);
            const r = await pool.query(
              "SELECT session_id FROM tool_calls_pg WHERE project_hash = $1 ORDER BY id DESC LIMIT 1",
              [projectHashStr],
            );
            if (r.rows[0]?.session_id) return r.rows[0].session_id;
          } finally {
            try { await pool.end(); } catch { /* noop */ }
          }
        }
      }
      if (backend === "postgres") return null;  // PG-only
      // dual mode: fall through to SQLite
    } catch {
      if (backend === "postgres") return null;
    }
  }

  // SQLite path
  const dbPath = projectDbPath(projectPath);
  if (!existsSync(dbPath)) return null;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 3000");
    const row = db.prepare("SELECT session_id FROM tool_calls ORDER BY id DESC LIMIT 1").get();
    db.close();
    return row?.session_id ?? null;
  } catch {
    return null;
  }
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

  // Determine session id — backend-aware (PG or SQLite per ZC_TELEMETRY_BACKEND)
  const sessionId = await resolveSessionId(projectPath);
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
        // v0.17.0: await so the hook process doesn't exit before the async
        // resolver writes to PG. Previously the promise was fire-and-forget
        // — when outcomes.ts became async (v0.12.0) the writes silently
        // dropped because process.exit happened first.
        await resolveGitCommitOutcome({ projectPath, sessionId, bashOutput: stdout });
      }
    } else if (toolName === "Read") {
      // newToolInput should carry the file_path (or path)
      if (toolInput?.file_path || toolInput?.path) {
        await resolveFollowUpOutcomes({
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
