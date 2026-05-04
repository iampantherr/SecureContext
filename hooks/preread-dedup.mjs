/**
 * PreToolUse hook — Read dedup guard + L0/L1 summary redirect (v0.22.2)
 * + per-invocation observability (v0.22.9)
 * =====================================================================
 *
 * Two-stage interception of Read tool calls:
 *
 *   STAGE 1 (existing v0.10.0 dedup): if the file was already Read in this
 *   session → block with a redirect message.
 *
 *   STAGE 2 (NEW in v0.22.2): on FIRST read of an indexed file (one that has
 *   an L0/L1 semantic summary in source_meta), REPLACE the Read response with
 *   the summary unless the agent explicitly opts out. ~95% Read-token cut.
 *
 *   v0.22.9 OBSERVABILITY: every invocation fires telemetry to
 *   /api/v1/telemetry/pretool-event with the outcome (redirect / block_dedup
 *   / block_unindexed / bypass_force_read / bypass_partial_read /
 *   pass_through / error). Diagnoses "is this hook firing at all" — silent-
 *   failure mode that bit us in the post-v0.22.5 audit when read_redirects=0
 *   forever could've meant either "no indexed Reads" or "hook never running."
 *
 *   Bypass mechanisms (any of these makes the Read pass through normally):
 *     1. ZC_SUMMARY_REDIRECT=0 in the agent's env (kill switch)
 *     2. ZC_SUMMARY_REDIRECT not set OR set to 0/false (default OFF until
 *        operator opts in, so legacy behavior is preserved)
 *     3. tool args contain "force_full_read": true
 *     4. tool args have offset OR limit set (intentional partial read)
 *     5. tool args contain "force": true (legacy compat with v0.10.0 hint)
 *     6. file is not indexed (no L0/L1 summary available)
 *
 * Failure mode: any error → fail open, allow Read through.
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
function normalizeForLookup(p, projectRoot) {
  if (!p) return p;
  if (p.startsWith("file:")) return p.slice(5);
  const root = projectRoot.replace(/[\\/]+$/, "");
  if (p.toLowerCase().startsWith(root.toLowerCase())) {
    let rel = p.slice(root.length);
    rel = rel.replace(/^[\\/]+/, "");
    rel = rel.replace(/\\/g, "/");
    return rel;
  }
  return p.replace(/\\/g, "/");
}

const projectPath0 = input.cwd ?? process.cwd();
const path = normalizeForLookup(rawPath, projectPath0);

// ─── Bypass checks ──────────────────────────────────────────────────────────
const forceFullRead = toolArgs.force_full_read === true || toolArgs.force === true;
const partialRead   = toolArgs.offset !== undefined || toolArgs.limit !== undefined;
const summaryRedirectEnabled = process.env.ZC_SUMMARY_REDIRECT === "1";
const dedupEnabled = process.env.ZC_READ_DEDUP_ENABLED !== "0";

const sessionId = input.session_id ?? input.sessionId ?? "default";
const projectPath = projectPath0;

/**
 * v0.22.9 — fire-and-forget telemetry for every hook invocation outcome.
 * Mirrors the v0.22.5 read-redirect telemetry pattern. Lets the dashboard
 * answer "is the PreRead hook firing at all?" — without this, an idle
 * read_redirects table is ambiguous (could mean hook isn't running, or
 * could mean all reads are of unindexed files). With this, the operator
 * can see the FULL outcome distribution.
 */
function emitPretoolEvent(outcome, detail) {
  try {
    const apiUrl = (process.env.ZC_API_URL ?? "").replace(/\/$/, "");
    if (!apiUrl) return;
    const apiKey = process.env.ZC_API_KEY ?? "";
    const agentId = process.env.ZC_AGENT_ID || "default";
    fetch(`${apiUrl}/api/v1/telemetry/pretool-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        projectPath, agentId,
        toolName: "Read",
        filePath: rawPath,
        outcome,
        detail: detail ? String(detail).slice(0, 1024) : null,
      }),
    }).catch(() => { /* fire-and-forget */ });
  } catch { /* never break the hook on telemetry failure */ }
}

try {
  const scPath = process.env.ZC_CTX_DIST ?? resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", "AI_projects/SecureContext/dist");
  const harness = await import(`file://${scPath.replace(/\\/g, "/")}/harness.js`);
  const { wasReadThisSession, recordSessionRead, getFileSummary } = harness;

  // ─── Bypass: force_full_read ────────────────────────────────────────────
  if (forceFullRead) {
    emitPretoolEvent("bypass_force_read", "agent passed force_full_read=true");
    if (dedupEnabled) {
      try { recordSessionRead(projectPath, sessionId, path); } catch { /* ignore */ }
    }
    process.exit(0);
  }

  // ─── Bypass: partial read (offset/limit) ────────────────────────────────
  if (partialRead) {
    emitPretoolEvent("bypass_partial_read", `offset=${toolArgs.offset} limit=${toolArgs.limit}`);
    if (dedupEnabled) {
      try { recordSessionRead(projectPath, sessionId, path); } catch { /* ignore */ }
    }
    process.exit(0);
  }

  // ─── STAGE 1 — DEDUP ────────────────────────────────────────────────────
  if (dedupEnabled && wasReadThisSession(projectPath, sessionId, path)) {
    const hint =
      `[zc-ctx harness] Read blocked: '${path}' was already Read in this session.\n\n` +
      `Use one of:\n` +
      `  - zc_file_summary("${path}")  — L0/L1 summary, no re-Read\n` +
      `  - zc_search(["<your question>"])  — keyword+semantic search\n` +
      `  - zc_check("<your question>", path="${path}")  — memory-first answer\n` +
      `  - Read with offset/limit to read a specific range (bypasses dedup)\n\n` +
      `If you genuinely need to re-Read (e.g. the file was externally modified), ` +
      `add "force_full_read": true to the Read arguments or set ZC_READ_DEDUP_ENABLED=0.`;
    emitPretoolEvent("block_dedup", "duplicate read in same session");
    process.stdout.write(JSON.stringify({
      continue: false,
      decision: "block",
      reason: hint,
    }));
    process.exit(0);
  }

  // ─── STAGE 2 — SUMMARY REDIRECT ─────────────────────────────────────────
  if (summaryRedirectEnabled) {
    let summary = null;
    try {
      // getFileSummary is async since v0.22.8 (PG-first); handle both shapes
      // for forward/backward compat with installed-vs-source dist.
      const result = getFileSummary(projectPath, path);
      if (result && typeof result.then === "function") {
        summary = await result;
      } else {
        summary = result;
      }
    } catch {
      summary = null;
    }

    // 2a — Indexed: serve the summary
    if (summary && (summary.l0 || summary.l1)) {
      const staleHint = summary.stale
        ? "  (⚠️ summary may be stale — file modified after indexing)\n"
        : "";
      const summaryText = `\n## L0 (purpose, 1 line)\n${summary.l0 || "(no L0)"}\n\n## L1 (detail, ~5 lines)\n${summary.l1 || "(no L1)"}\n`;
      const replacement =
        `[zc-ctx L0/L1 SUMMARY — file body NOT loaded]\n\n` +
        `Source: ${rawPath}\n` +
        `Indexed: ${summary.indexedAt}\n` +
        staleHint +
        summaryText +
        `\n─────────────────────────────────────────────────────────────────\n` +
        `If this summary answers your question, proceed.\n\n` +
        `If you need the FULL file content (e.g. to Edit/Write it), retry Read with:\n` +
        `  Read({ file_path: "${rawPath}", force_full_read: true })\n` +
        `  OR pass offset/limit to read a specific range:\n` +
        `  Read({ file_path: "${rawPath}", offset: 1, limit: 200 })\n\n` +
        `(This redirect saves ~95% of Read tokens. Set ZC_SUMMARY_REDIRECT=0 to disable globally.)`;

      // v0.22.5 — fire read_redirects telemetry (the existing per-success path)
      try {
        const apiUrl = (process.env.ZC_API_URL ?? "").replace(/\/$/, "");
        const apiKey = process.env.ZC_API_KEY ?? "";
        if (apiUrl) {
          let fileSize = 0;
          try {
            const isAbs = rawPath.startsWith("/") || /^[a-zA-Z]:/.test(rawPath);
            const full = isAbs ? rawPath : join(projectPath, rawPath);
            fileSize = statSync(full).size;
          } catch { /* file may be in indexed-but-disk-removed state; size 0 */ }
          const fullFileTokens = Math.ceil(fileSize / 4);
          const summaryTokens  = Math.ceil(summaryText.length / 4);
          const agentId = process.env.ZC_AGENT_ID || "default";
          fetch(`${apiUrl}/api/v1/telemetry/read-redirect`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
              projectPath, agentId, filePath: rawPath, fullFileTokens, summaryTokens,
            }),
          }).catch(() => { /* fire-and-forget */ });
        }
      } catch { /* never break the redirect */ }

      // v0.22.9 — also fire the generic pretool-event telemetry
      emitPretoolEvent("redirect", `summary served, l0=${summary.l0?.length ?? 0}b l1=${summary.l1?.length ?? 0}b`);

      process.stdout.write(JSON.stringify({
        continue: false,
        decision: "block",
        reason: replacement,
      }));
      process.exit(0);
    }

    // 2b — Not indexed: block + ask agent to index OR force-read.
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
      emitPretoolEvent("block_unindexed", "no L0/L1 summary in source_meta");
      process.stdout.write(JSON.stringify({
        continue: false,
        decision: "block",
        reason: hint,
      }));
      process.exit(0);
    }
  }

  // ─── Pass-through (ZC_SUMMARY_REDIRECT off, no dedup hit) ──────────────
  if (dedupEnabled) {
    try { recordSessionRead(projectPath, sessionId, path); } catch { /* ignore */ }
  }
  emitPretoolEvent("pass_through", `redirect_enabled=${summaryRedirectEnabled} dedup_enabled=${dedupEnabled}`);
  process.exit(0);
} catch (e) {
  // Never break the agent on hook failure — let the Read through.
  emitPretoolEvent("error", String(e && e.message ? e.message : e).slice(0, 512));
  process.exit(0);
}
