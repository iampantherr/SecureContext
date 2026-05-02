/**
 * PreToolUse hook — Read dedup guard + L0/L1 summary redirect (v0.22.2)
 * =====================================================================
 *
 * Two-stage interception of Read tool calls:
 *
 *   STAGE 1 (existing v0.10.0 dedup): if the file was already Read in this
 *   session → block with a redirect message. Reading the same file twice is
 *   a classic token-waste pattern.
 *
 *   STAGE 2 (NEW in v0.22.2): on FIRST read of an indexed file (one that has
 *   an L0/L1 semantic summary in source_meta), REPLACE the Read response with
 *   the summary unless the agent explicitly opts out. Cuts Read tokens
 *   dramatically — a 5,000-token file becomes a ~200-token summary.
 *
 *   Bypass mechanisms (any of these makes the Read pass through normally):
 *     1. ZC_SUMMARY_REDIRECT=0 in the agent's env (kill switch)
 *     2. ZC_SUMMARY_REDIRECT not set OR set to 0/false (default OFF until
 *        operator opts in, so legacy behavior is preserved)
 *     3. tool args contain "force_full_read": true
 *     4. tool args have offset OR limit set (intentional partial read; agent
 *        wants specific lines, summary wouldn't help)
 *     5. tool args contain "force": true (legacy compat with v0.10.0 hint)
 *     6. file is not indexed (no L0/L1 summary available)
 *
 * Response shape when summary is returned:
 *   The agent sees a structured block clearly marked as a summary, with
 *   instructions on how to get the full file. They CANNOT confuse this for
 *   actual file content because:
 *     - The block starts with "[zc-ctx L0/L1 SUMMARY — file body NOT loaded]"
 *     - It tells them how to bypass: pass force_full_read:true OR offset/limit
 *
 * Failure mode: any error → fail open, allow Read through. The agent never
 * gets stuck because of this hook.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// ─── Read the hook payload from stdin (Claude Code's hook protocol) ─────────
let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0); // malformed payload — let the Read through
}

// Only act on Read tool calls
const toolName = input.tool_name ?? input.toolName ?? "";
if (toolName !== "Read") process.exit(0);

const toolArgs = input.tool_input ?? input.arguments ?? {};
const rawPath = toolArgs.file_path ?? toolArgs.path ?? "";
if (!rawPath) process.exit(0);

// v0.22.2 fix — normalize absolute paths to project-root-relative.
// Claude Code's Read tool passes absolute paths (e.g.
// "C:\Users\Amit\AI_projects\Test_Agent_Coordination\utils\format-duration.js")
// but source_meta stores relative ("file:utils/format-duration.js"). Without
// normalization, getFileSummary lookup MISSES indexed files for absolute
// paths and the hook falls into "NOT indexed yet" mode incorrectly.
// Discovered live via E2E: developer agent reported Step 1 returned "NOT
// indexed yet" for a file that IS indexed — root cause was abs-vs-rel mismatch.
function normalizeForLookup(p, projectRoot) {
  if (!p) return p;
  // Already prefixed with file:
  if (p.startsWith("file:")) return p.slice(5);
  // Try stripping the project root prefix (Windows + Unix)
  const root = projectRoot.replace(/[\\/]+$/, "");
  if (p.toLowerCase().startsWith(root.toLowerCase())) {
    let rel = p.slice(root.length);
    rel = rel.replace(/^[\\/]+/, "");        // strip leading slash
    rel = rel.replace(/\\/g, "/");           // win→posix slashes
    return rel;
  }
  // Already relative (or in a different project) — return as-is
  return p.replace(/\\/g, "/");
}

const projectPath0 = input.cwd ?? process.cwd();
const path = normalizeForLookup(rawPath, projectPath0);

// ─── Bypass checks (any true → pass through) ────────────────────────────────
const forceFullRead = toolArgs.force_full_read === true || toolArgs.force === true;
const partialRead   = toolArgs.offset !== undefined || toolArgs.limit !== undefined;
const summaryRedirectEnabled = process.env.ZC_SUMMARY_REDIRECT === "1";
const dedupEnabled = process.env.ZC_READ_DEDUP_ENABLED !== "0";

// Session ID — Claude Code provides this in the hook payload
const sessionId = input.session_id ?? input.sessionId ?? "default";
// Project path — same value used for path normalization above
const projectPath = projectPath0;

try {
  const scPath = process.env.ZC_CTX_DIST ?? resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", "AI_projects/SecureContext/dist");
  const harness = await import(`file://${scPath.replace(/\\/g, "/")}/harness.js`);
  const { wasReadThisSession, recordSessionRead, getFileSummary } = harness;

  // ─── STAGE 1 — DEDUP (v0.10.0) ──────────────────────────────────────────
  // v0.22.2 fix: dedup ALSO bypasses on partialRead (offset/limit). Without
  // this, agents reading a large file in chunks via offset/limit get blocked
  // by dedup on the second chunk onwards. Discovered live during A2A_communication
  // notebook re-import: agent tried to chunk through a 65KB migration file and
  // got dedup-blocked on every chunk after the first.
  if (dedupEnabled && !forceFullRead && !partialRead && wasReadThisSession(projectPath, sessionId, path)) {
    const hint =
      `[zc-ctx harness] Read blocked: '${path}' was already Read in this session.\n\n` +
      `Use one of:\n` +
      `  - zc_file_summary("${path}")  — L0/L1 summary, no re-Read\n` +
      `  - zc_search(["<your question>"])  — keyword+semantic search\n` +
      `  - zc_check("<your question>", path="${path}")  — memory-first answer\n` +
      `  - Read with offset/limit to read a specific range (bypasses dedup)\n\n` +
      `If you genuinely need to re-Read (e.g. the file was externally modified), ` +
      `add "force_full_read": true to the Read arguments or set ZC_READ_DEDUP_ENABLED=0.`;
    process.stdout.write(JSON.stringify({
      continue: false,
      decision: "block",
      reason: hint,
    }));
    process.exit(0);
  }

  // ─── STAGE 2 — SUMMARY REDIRECT (v0.22.2) ───────────────────────────────
  // Only fires when:
  //   1. ZC_SUMMARY_REDIRECT=1 (operator opted in)
  //   2. force_full_read NOT set (agent didn't override)
  //   3. offset/limit NOT set (agent wants whole file, not range)
  //
  // Two sub-cases:
  //   2a. File IS indexed → return L0/L1 summary as the Read response
  //   2b. File NOT indexed → BLOCK + ask agent to index it first (so future
  //       reads in any session benefit). Agent can opt out with force_full_read.
  //       This enforces "build the index as you work" — every file the system
  //       reads gets a summary, compounding savings over time.
  if (summaryRedirectEnabled && !forceFullRead && !partialRead) {
    let summary = null;
    try {
      summary = getFileSummary(projectPath, path);
    } catch {
      summary = null;
    }

    // 2a — Indexed: serve the summary
    if (summary && (summary.l0 || summary.l1)) {
      const staleHint = summary.stale
        ? "  (⚠️ summary may be stale — file modified after indexing)\n"
        : "";
      const replacement =
        `[zc-ctx L0/L1 SUMMARY — file body NOT loaded]\n\n` +
        `Source: ${rawPath}\n` +
        `Indexed: ${summary.indexedAt}\n` +
        staleHint +
        `\n## L0 (purpose, 1 line)\n${summary.l0 || "(no L0)"}\n\n` +
        `## L1 (detail, ~5 lines)\n${summary.l1 || "(no L1)"}\n\n` +
        `─────────────────────────────────────────────────────────────────\n` +
        `If this summary answers your question, proceed.\n\n` +
        `If you need the FULL file content (e.g. to Edit/Write it), retry Read with:\n` +
        `  Read({ file_path: "${rawPath}", force_full_read: true })\n` +
        `  OR pass offset/limit to read a specific range:\n` +
        `  Read({ file_path: "${rawPath}", offset: 1, limit: 200 })\n\n` +
        `(This redirect saves ~95% of Read tokens. Set ZC_SUMMARY_REDIRECT=0 to disable globally.)`;
      process.stdout.write(JSON.stringify({
        continue: false,
        decision: "block",
        reason: replacement,
      }));
      process.exit(0);
    }

    // 2b — Not indexed: block + ask agent to index OR force-read.
    // This is enforcement: every file the system reads should produce a
    // summary so future reads (and other agents/sessions) save tokens.
    // Agent retains full control via force_full_read for cases where
    // indexing would be wasteful (one-off scripts, generated files, etc.).
    {
      const hint =
        `[zc-ctx] '${rawPath}' is NOT indexed yet (no L0/L1 summary in SecureContext).\n\n` +
        `To save tokens for yourself + every future session, build a summary FIRST:\n\n` +
        `  Option A — Index just this file (recommended for code/docs you'll re-read):\n` +
        `    1. zc_file_summary({ name: "${rawPath}" })  — auto-indexes via local LLM if missing\n` +
        `       Wait ~5–15s for indexing to complete, then proceed.\n\n` +
        `  Option B — Bulk-index the whole project (if many files are unindexed):\n` +
        `    1. zc_index_project({ projectPath: "<your-project-root>" })  — kicks off bg indexer\n\n` +
        `  Option C — Skip indexing, read the raw file (use ONLY if the file is throwaway,\n` +
        `             generated, or you'll never re-read it):\n` +
        `    Retry Read with: Read({ file_path: "${path}", force_full_read: true })\n\n` +
        `  Option D — Need a specific line range only:\n` +
        `    Read({ file_path: "${rawPath}", offset: <N>, limit: <M> })  (offset/limit bypasses summary)\n\n` +
        `─────────────────────────────────────────────────────────────────\n` +
        `WHY: every Read of an un-summarized file is a missed savings opportunity. By forcing\n` +
        `summaries to be created on-demand, the index builds as you work. Set\n` +
        `ZC_SUMMARY_REDIRECT=0 to disable globally.`;
      process.stdout.write(JSON.stringify({
        continue: false,
        decision: "block",
        reason: hint,
      }));
      process.exit(0);
    }
  }

  // First-Read path — record it and allow through
  if (dedupEnabled) {
    try { recordSessionRead(projectPath, sessionId, path); } catch { /* ignore */ }
  }
  process.exit(0);
} catch {
  // Never break the agent on hook failure — let the Read through.
  process.exit(0);
}
