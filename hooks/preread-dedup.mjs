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

import { readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import * as nodeCrypto from "node:crypto";
// Single source for the project hash — the drift guard caught this file
// re-deriving it inline (bypass ledger + edit-mode gate), the exact
// recurrence the guard exists to stop. Same normalisation as src/store.ts;
// resolved roots are already canonical, so existing state files keep their hashes.
import { projectHash as sharedProjectHash } from "./_project-hash.mjs";

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

/**
 * v0.55.0 — resolve the project from the FILE, not from the session cwd.
 *
 * Found live: a session running in .../zeroclaw read .../SecureContext/src/embedder.ts.
 * The hook looked the file up in zeroclaw's knowledge base under an absolute path,
 * found nothing, and reported "NOT indexed" for a file that is fully indexed in
 * SecureContext. Worse than the false negative was the advice attached to it —
 * "run zc_file_summary" would have indexed a SecureContext file INTO zeroclaw's KB.
 *
 * Every SC lookup is project-scoped, so the project must come from the path being
 * read. First .git walking up is the repo root; sessions that work across repos
 * (the normal case here) then hit the right database.
 */
function resolveProjectRoot(absPath, fallback) {
  try {
    if (!/^([a-zA-Z]:[\\/]|\/)/.test(absPath)) return fallback;   // relative → already project-local
    let dir = resolve(absPath, "..");
    for (let i = 0; i < 40; i++) {
      if (existsSync(join(dir, ".git"))) return dir;
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* fall through */ }
  return fallback;
}

const sessionCwd = input.cwd ?? process.cwd();
const projectPath0 = resolveProjectRoot(rawPath, sessionCwd);
const path = normalizeForLookup(rawPath, projectPath0);

/**
 * v0.55.1 — ADAPTIVE SUPPRESSION.
 *
 * Measured, not assumed: in an A/B on a comprehension task the redirect served
 * one summary and the agent then bypassed and read the same file in full, every
 * time. The summary prevented ZERO full reads and the run cost +62% billed
 * tokens and +40% turns, because the session paid for the summary, the file, and
 * the extra tool calls.
 *
 * The redirect only pays when the agent's need ENDS at the summary. When a file
 * gets bypassed, that file has demonstrated it needs to be read in full — so
 * stop charging for a summary nobody uses. Records the bypass durably (not just
 * for the session) because the same file tends to be needed in full again.
 *
 * Plain JSON on disk, deliberately: this must work when the API is down, which
 * is exactly when the hook still runs.
 */
const BYPASS_THRESHOLD = Number(process.env.ZC_REDIRECT_BYPASS_THRESHOLD ?? "1");

function bypassStatsPath() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".claude", "zc-ctx", "redirect-bypass", `${sharedProjectHash(projectPath0)}.json`);
}

function readBypassStats() {
  try { return JSON.parse(readFileSync(bypassStatsPath(), "utf8")); }
  catch { return {}; }
}

function fileMtime(rel) {
  try {
    const isAbs = /^[a-zA-Z]:/.test(rawPath) || rawPath.startsWith("/");
    const full = isAbs ? rawPath : join(projectPath0, rel);
    return statSync(full).mtimeMs;
  } catch { return 0; }
}

function recordBypass(rel) {
  try {
    const p = bypassStatsPath();
    mkdirSync(dirname(p), { recursive: true });
    const stats = readBypassStats();
    // v0.55.2 — pin the record to the file's mtime. A bypass proves the CURRENT
    // summary was insufficient for the CURRENT file. When the file changes
    // (usually because the agent edited it after bypassing), postedit-reindex
    // regenerates the summary — and the block must come back to give the fresh
    // summary its chance. Suppression tied to stale evidence would otherwise
    // outlive the thing it was evidence about.
    stats[rel] = { n: (stats[rel]?.n ?? 0) + 1, last: new Date().toISOString(), mtime: fileMtime(rel) };
    writeFileSync(p, JSON.stringify(stats), "utf8");
  } catch { /* never break a read over bookkeeping */ }
}

/** True while the file is UNCHANGED since it proved it needs full reads. */
function redirectSuppressed(rel) {
  try {
    const rec = readBypassStats()[rel];
    if (!rec || (rec.n ?? 0) < BYPASS_THRESHOLD) return false;
    // Legacy records (no mtime) stay suppressed; new ones expire on change.
    return rec.mtime === undefined || rec.mtime === fileMtime(rel);
  } catch { return false; }
}

/**
 * Feed `reason` back to the model as the Read result, and let the turn CONTINUE.
 *
 * The previous shape was `{continue: false, decision: "block", reason}`. In the
 * hook protocol `continue: false` means "stop processing entirely", so every
 * redirected Read ENDED THE AGENT'S TURN. Measured with the real CLI:
 *
 *   "permission_denials":[{"tool_name":"Read",...}]
 *   "terminal_reason":"hook_stopped"
 *   "result":""
 *
 * The summary and impact were delivered and then the agent was stopped before it
 * could use them -- a token saving that cost a whole turn, and the reason a
 * human operator kept seeing sessions halt mid-task.
 *
 * permissionDecision "deny" + permissionDecisionReason returns the text as the
 * tool result. The agent reads the summary, sees the impact, and keeps working.
 */
function denyWithReason(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

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
/**
 * v0.22.10 BUG FIX: emit was fire-and-forget but the hook calls process.exit(0)
 * immediately after, killing the pending POST before it goes out. Result:
 * pretool_events_pg (and read_redirects_pg, same pattern) were silently empty
 * across all agent activity since v0.22.5. The hook WAS firing — just no
 * telemetry was reaching PG. Fix: await the POST with a short timeout so
 * Claude Code's hook protocol still completes promptly, but the telemetry
 * actually flushes.
 */
async function emitPretoolEvent(outcome, detail) {
  try {
    const apiUrl = (process.env.ZC_API_URL ?? "").replace(/\/$/, "");
    if (!apiUrl) return;
    const apiKey = process.env.ZC_API_KEY ?? "";
    const agentId = process.env.ZC_AGENT_ID || "default";
    const resp = await fetch(`${apiUrl}/api/v1/telemetry/pretool-event`, {
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
      // Cap latency: if the API is unreachable, hook still exits quickly.
      // 1500ms is plenty for a localhost POST; far exceeds typical latency.
      signal: AbortSignal.timeout(1500),
    });
    // v0.54.2 - a REJECTED telemetry post is no longer silent.
    //
    // This previously swallowed every failure, including the 400 the API returns
    // for an unknown outcome value. The consequence was concrete: a new hook
    // outcome ('pass_brief_exempt') was rejected, the rejection was discarded,
    // and I could not tell whether my own detector had fired - the observability
    // path silently dropping the very signal that proves observability works.
    //
    // stderr, not stdout: stdout is the hook protocol channel and writing there
    // would corrupt the decision. stderr is captured and breaks nothing.
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      process.stderr.write(
        `[zc-ctx telemetry] pretool-event REJECTED ${resp.status} for outcome='${outcome}': ` +
        `${body.slice(0, 200)}
`);
    }
  } catch (e) {
    // Network/timeout failures stay non-fatal but are no longer invisible.
    process.stderr.write(`[zc-ctx telemetry] pretool-event failed: ${String(e).slice(0, 160)}
`);
  }
}

try {
  const scPath = process.env.ZC_CTX_DIST ?? resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", "AI_projects/SecureContext/dist");
  const harness = await import(`file://${scPath.replace(/\\/g, "/")}/harness.js`);
  const { wasReadThisSession, recordSessionRead, getFileSummary } = harness;

  /**
   * v0.55.0 — cascade impact, attached to whatever the hook is about to return.
   *
   * This is the delivery mechanism the whole call-graph feature depends on.
   * Measured precedent: kb_edges has 15,042 edges and zc_graph_backlinks was
   * called ONCE in four weeks, while the same graph feeding search ranking is
   * used on every query. An opt-in tool does not change behaviour; something
   * that arrives whether or not you asked does. So impact is appended here
   * rather than left for the agent to remember to look up.
   *
   * crossFileOnly: a function called only inside its own file is visible in the
   * file you are already reading. A cross-file caller is the one you cannot see
   * and are about to break.
   *
   * Never throws, never blocks: any failure returns "" and the read proceeds.
   */
  async function impactBlock(filePath) {
    if (process.env.ZC_IMPACT_ON_READ === "0") return "";
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath)) return "";
    try {
      const [{ createStore }, { renderImpact }] = await Promise.all([
        import(`file://${scPath.replace(/\\/g, "/")}/store.js`),
        import(`file://${scPath.replace(/\\/g, "/")}/indexing/call_edges.js`),
      ]);
      const store = await createStore();
      const impact = await store.callImpactFor(projectPath, { file: filePath });
      // Silence is right when the layer is unbuilt: a "graph not built" banner on
      // every Read would train agents to skip the whole block. Absence of the
      // section is honest here because nothing is claimed.
      if (!impact.built) return "";
      if (impact.targets.length === 0 && impact.dynamicSites === 0) return "";
      return "\n\n" + renderImpact(impact, { file: filePath },
        { crossFileOnly: true, limit: 12 });
    } catch {
      return "";
    }
  }

  // ─── Bypass: force_full_read ────────────────────────────────────────────
  if (forceFullRead) {
    await emitPretoolEvent("bypass_force_read", "agent passed force_full_read=true");
    if (dedupEnabled) {
      try { recordSessionRead(projectPath, sessionId, path); } catch { /* ignore */ }
    }
    process.exit(0);
  }

  // ─── Bypass: partial read (offset/limit) ────────────────────────────────
  if (partialRead) {
    // v0.55.1 — a whole-file bypass (offset near 1, huge limit) is the agent
    // declaring "the summary was not enough for this file". Record it durably so
    // the NEXT read of this file skips the summary round-trip entirely.
    // A genuine range read (offset 500, limit 40) is not that signal — the agent
    // may be using the summary exactly as intended.
    const off = Number(toolArgs.offset ?? 1);
    const lim = Number(toolArgs.limit ?? 0);
    if (off <= 2 && lim >= 5000) recordBypass(path);
    await emitPretoolEvent("bypass_partial_read", `offset=${toolArgs.offset} limit=${toolArgs.limit}`);
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
    await emitPretoolEvent("block_dedup", "duplicate read in same session");
    process.stdout.write(JSON.stringify(denyWithReason(hint)));
    process.exit(0);
  }

  // ─── STAGE 1.5 — TASK-BRIEF EXEMPTION ───────────────────────────────────
  //
  // A task brief must be readable IN FULL, always. Found live: an orchestrator
  // moved full task briefs into TASK_*.md files precisely because broadcast
  // summaries were being clamped, and then this hook redirected the worker to a
  // ~5-line summary of its own acceptance criteria. Two features fighting: the
  // workaround for one truncation defeated by another truncation.
  //
  // A summary of a brief is not a brief. Acceptance criteria, scope, and RED-gate
  // requirements are exactly the detail a summary drops, and a worker that acts
  // on the summary builds against invented criteria.
  // Match on the BASENAME, split on either separator. An earlier version put the
  // separator inside the regex as [\/], which in a JS regex literal is a forward
  // slash only — so it never matched a Windows path like C:\...\TASK_FOO.md and
  // the exemption was dead in practice. My own verification used forward slashes
  // and passed, which is exactly how the bug survived. Basename comparison has no
  // separator logic to get wrong.
  const briefBase = String(path).split(/[\\/]/).pop() ?? "";
  const briefLike = /^(TASK|BRIEF|SPEC|ACCEPTANCE|PENDING_WORK|HANDOFF)/i.test(briefBase)
                 && /\.md$/i.test(briefBase);
  if (briefLike) {
    await emitPretoolEvent("pass_brief_exempt", "task brief must be read in full");
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  // ─── STAGE 2 — SUMMARY REDIRECT ─────────────────────────────────────────
  if (summaryRedirectEnabled) {
    // v0.55.3 EDIT MODE — the agent has explicitly declared "I am editing; I
    // need bytes, not summaries" via zc-edit-mode.mjs. While active (and not
    // expired), reads pass through. Blast radius is still enforced by the
    // prewrite-impact hook on the first Edit/Write of each file, so the agent
    // sees cross-file callers before changing anything. The mode auto-expires,
    // so a forgotten one cannot disable the redirect forever.
    try {
      // v0.55.4 — per-agent: the mode only applies to the agent that engaged it.
      const emAgent = (process.env.ZC_AGENT_ID ?? "default").replace(/[^A-Za-z0-9_-]/g, "_");
      const modeFile = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".claude", "zc-ctx", "edit-mode",
        `${sharedProjectHash(projectPath0)}-${emAgent}.json`);
      const m = JSON.parse(readFileSync(modeFile, "utf8"));
      const live = new Date(m.expires) > new Date();
      const covers = !m.files?.length || m.files.some((f) => path === f || path.endsWith("/" + f));
      if (live && covers) {
        await emitPretoolEvent("pass_edit_mode", "agent-declared edit mode; summaries suspended");
        if (dedupEnabled) { try { recordSessionRead(projectPath, sessionId, path); } catch { /* ignore */ } }
        process.exit(0);
      }
    } catch { /* no mode file — normal path */ }

    // v0.55.1 ADAPTIVE SUPPRESSION — this file has been bypassed before, so the
    // summary demonstrably was not enough for it. Serving it again charges for a
    // summary AND the file AND an extra round-trip. Skip straight to the read.
    if (redirectSuppressed(path)) {
      await emitPretoolEvent("pass_bypass_learned", "file previously bypassed; summary suppressed");
      if (dedupEnabled) {
        try { recordSessionRead(projectPath, sessionId, path); } catch { /* ignore */ }
      }
      process.exit(0);
    }

    // v0.55.1 SIZE GATE — below the measured break-even (~477 tokens, ~24 lines)
    // the summary is BIGGER than the file. Redirecting a tiny file can only lose.
    try {
      const isAbs = /^([a-zA-Z]:[\\/]|\/)/.test(rawPath);
      const full = isAbs ? rawPath : join(projectPath, rawPath);
      const bytes = statSync(full).size;
      const minBytes = Number(process.env.ZC_REDIRECT_MIN_BYTES ?? "2000");   // ~500 tokens
      if (bytes < minBytes) {
        await emitPretoolEvent("pass_below_breakeven", `file ${bytes}B < ${minBytes}B`);
        if (dedupEnabled) {
          try { recordSessionRead(projectPath, sessionId, path); } catch { /* ignore */ }
        }
        process.exit(0);
      }
    } catch { /* stat failed — fall through to the normal path */ }

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
      const impactText = await impactBlock(path);
      const replacement =
        `[zc-ctx L0/L1 SUMMARY — file body NOT loaded]\n\n` +
        `Source: ${rawPath}\n` +
        `Indexed: ${summary.indexedAt}\n` +
        staleHint +
        summaryText +
        impactText +
        `\n\n─────────────────────────────────────────────────────────────────\n` +
        `If this summary answers your question, proceed.\n\n` +
        `If you need the FULL file content (e.g. to Edit/Write it), retry Read with:\n` +
        `  Read({ file_path: "${rawPath}", offset: 1, limit: 100000 })\n` +
        `  (offset/limit always bypasses this; use a real range when you know it)\n` +
        `  Some clients also accept force_full_read: true, but most reject unknown\n` +
        `  Read parameters with a validation error — prefer offset/limit.\n\n` +
        `(Editing this file repeatedly? Engage edit mode so reads pass through while you work:
  Bash: node ~/.claude/hooks/zc-edit-mode.mjs on 30   -- auto-expires; write-hook impact still applies.)`;

      // v0.22.5 — fire read_redirects telemetry (the existing per-success path)
      // v0.22.10 BUG FIX: was fire-and-forget but process.exit(0) immediately
      // killed the pending POST. Now awaited with a tight timeout. Same bug
      // class as the pretool-event POST — silent since v0.22.5.
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
          await fetch(`${apiUrl}/api/v1/telemetry/read-redirect`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
              projectPath, agentId, filePath: rawPath, fullFileTokens, summaryTokens,
            }),
            signal: AbortSignal.timeout(1500),
          }).catch(() => { /* swallow but at least we waited */ });
        }
      } catch { /* never break the redirect */ }

      // v0.22.9 — also fire the generic pretool-event telemetry
      await emitPretoolEvent("redirect", `summary served, l0=${summary.l0?.length ?? 0}b l1=${summary.l1?.length ?? 0}b`);

      process.stdout.write(JSON.stringify(denyWithReason(replacement)));
      process.exit(0);
    }

    // 2b — Not indexed: block + ask agent to index OR force-read.
    {
      // Impact does not depend on the L0/L1 summary existing — the call graph is
      // built from source, so an unindexed file can still have known callers.
      // Withholding it here would be the one moment it matters most.
      const impactText = await impactBlock(path);
      const hint =
        `[zc-ctx] '${rawPath}' is NOT indexed yet (no L0/L1 summary in SecureContext).\n` +
        impactText + `\n` +
        `To save tokens for yourself + every future session, build a summary FIRST:\n\n` +
        `  Option A — Index just this file (recommended for code/docs you'll re-read):\n` +
        `    1. zc_file_summary({ name: "${rawPath}" })  — auto-indexes via local LLM if missing\n` +
        `       Wait ~5–15s for indexing to complete, then proceed.\n\n` +
        `  Option B — Bulk-index the whole project (if many files are unindexed):\n` +
        `    1. zc_index_project({ projectPath: "<your-project-root>" })  — kicks off bg indexer\n\n` +
        `  Option C — Skip indexing, read the raw file (use ONLY if the file is throwaway,\n` +
        `             generated, or you'll never re-read it):\n` +
        `    Read({ file_path: "${rawPath}", offset: 1, limit: 100000 })\n` +
        `    offset/limit is the portable bypass. force_full_read: true also works,\n` +
        `    but most clients reject unknown Read parameters with a validation error.\n\n` +
        `  Option D — Need a specific line range only:\n` +
        `    Read({ file_path: "${rawPath}", offset: <N>, limit: <M> })\n\n` +
        `─────────────────────────────────────────────────────────────────\n` +
        `WHY: every Read of an un-summarized file is a missed savings opportunity. By forcing\n` +
        `summaries to be created on-demand, the index builds as you work. Set\n` +
        `ZC_SUMMARY_REDIRECT=0 to disable globally.`;
      await emitPretoolEvent("block_unindexed", "no L0/L1 summary in source_meta");
      process.stdout.write(JSON.stringify(denyWithReason(hint)));
      process.exit(0);
    }
  }

  // ─── Pass-through (ZC_SUMMARY_REDIRECT off, no dedup hit) ──────────────
  if (dedupEnabled) {
    try { recordSessionRead(projectPath, sessionId, path); } catch { /* ignore */ }
  }
  await emitPretoolEvent("pass_through", `redirect_enabled=${summaryRedirectEnabled} dedup_enabled=${dedupEnabled}`);
  process.exit(0);
} catch (e) {
  // Never break the agent on hook failure — let the Read through.
  await emitPretoolEvent("error", String(e && e.message ? e.message : e).slice(0, 512));
  process.exit(0);
}
