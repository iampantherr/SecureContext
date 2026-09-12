#!/usr/bin/env node
/**
 * PreToolUse hook — cascade impact BEFORE an edit (v0.55.0)
 * ========================================================
 *
 * The problem this exists for, in the operator's words: "the agent just focuses
 * on the current function and enhancing its functionality but fails to consider
 * all the cascading dependent functions."
 *
 * The PreRead hook already delivers impact — but only to an agent that READS the
 * file first. An agent can Edit a file it never read (it has the L0/L1 summary,
 * or it is writing new code), and then nothing fires. The exact failure the
 * feature was built to prevent stayed reachable through the write path.
 *
 * What this does:
 *   Edit/MultiEdit → locate the function containing old_string, report who calls
 *                    THAT function.
 *   Write          → an overwrite changes everything in the file, so report every
 *                    symbol in it that has cross-file callers.
 *
 * Deliberately proportionate, because a gate that fires on everything gets
 * disabled within a week:
 *   - only CROSS-FILE callers count (a function used only inside its own file is
 *     visible in the file you are already editing)
 *   - only at or above ZC_IMPACT_MIN_CALLERS (default 3)
 *   - ONCE per file per session — after the agent has seen the cascade, it gets
 *     out of the way
 *
 * It denies with the impact as the reason, which returns the text to the model
 * and lets the turn continue (permissionDecision "deny", NOT continue:false —
 * that ends the turn, a lesson from the read hook).
 *
 * Fail-OPEN on every internal error: a hook bug must never block an edit.
 * Kill switch: ZC_IMPACT_ON_WRITE=0.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolveProjectRoot } from "./_project-hash.mjs";
import { resolve, join } from "node:path";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

const allow = () => process.exit(0);
// ZC_HOOK_DEBUG=1 traces every decision to stderr (2026-09-12: a silent allow is the
// failure mode this hook keeps falling into; make each exit nameable).
const dbg = (m) => { if (process.env.ZC_HOOK_DEBUG) process.stderr.write("[prewrite-impact] " + m + "\n"); };

// 2026-09-12 — MANDATE. Measured over the A2A management-plane phase (Sep 7-10):
// the developer edited 1,556 times and called zc_impact 4 times; this hook
// denied nothing because the project's graph was never built and "unbuilt" was
// a silent allow. Now: the caller map is SHOWN before a file's first edit in a
// session whether or not anything calls it (deny-once, the deny text IS the
// map), and an unbuilt graph is a deny-once-per-session that names the fix.
// Proportionate still: once per file, never on the second attempt.
async function denyWith(outcome, detail, reason, telemetry) {
  try {
    const apiUrl = (process.env.ZC_API_URL ?? "").replace(/\/$/, "");
    if (apiUrl) {
      const resp = await fetch(`${apiUrl}/api/v1/telemetry/pretool-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(process.env.ZC_API_KEY ? { Authorization: `Bearer ${process.env.ZC_API_KEY}` } : {}) },
        body: JSON.stringify({ ...telemetry, outcome, detail }),
        signal: AbortSignal.timeout(1500),
      });
      if (!resp.ok) process.stderr.write(`[zc-ctx telemetry] ${outcome} REJECTED ${resp.status}\n`);
    }
  } catch (e) { process.stderr.write(`[zc-ctx telemetry] ${outcome} failed: ${String(e).slice(0, 160)}\n`); }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}

let input;
try { input = JSON.parse(raw); } catch { allow(); }

const toolName = input.tool_name ?? input.toolName ?? "";
if (!/^(Edit|Write|MultiEdit)$/.test(toolName)) allow();
if (process.env.ZC_IMPACT_ON_WRITE === "0") allow();

const args = input.tool_input ?? input.arguments ?? {};
const rawPath = args.file_path ?? args.path ?? "";
if (!rawPath) allow();
// v0.64 — .py included: the A2A hub is Python and the call graph indexes it;
// a JS-only filter made the hook a no-op on the exact fleet it was installed for.
if (!/\.(ts|tsx|js|jsx|mjs|cjs|py)$/i.test(rawPath)) allow();

const MIN_CALLERS = Number(process.env.ZC_IMPACT_MIN_CALLERS ?? "1");   // 2026-09-12: was 3; one caller is one thing you can break
const sessionId = input.session_id ?? input.sessionId ?? "default";

/** Repo root for the FILE, not the session cwd (same lesson as the read hook). */

const sessionCwd = input.cwd ?? process.cwd();
const localRoot = resolveProjectRoot(rawPath, sessionCwd);
// v0.64 — WSL agents: the store is keyed by the WINDOWS project path (agents
// export ZC_PROJECT_PATH to pin it), but this hook runs with WSL /mnt/c paths.
// Hashing the WSL form finds no graph → "unbuilt" → silent allow — the hook
// becomes a no-op exactly where it was installed to enforce (caught 2026-08-30
// while wiring the hook into the A2A fleet). Store key: ZC_PROJECT_PATH when
// set; file operations keep the LOCAL path.
const projectPath = process.env.ZC_PROJECT_PATH || localRoot;
// 2026-09-12 — compare with one slash style: resolveProjectRoot returns backslashes on
// Windows while the tool may pass forward slashes; a failed prefix match sent the
// ABSOLUTE path to the graph (keyed by repo-relative paths) → "0 targets" on a built graph.
const _fwd = (s) => String(s).split("\\").join("/");
const _mnt = (q) => { const m = /^([A-Za-z]):\/(.*)$/.exec(_fwd(q)); return m ? "/mnt/" + m[1].toLowerCase() + "/" + m[2] : _fwd(q); };
// 2026-09-12 — rel is measured from the LONGEST matching root: the file's git root, ZC_PROJECT_PATH
// as given, or ZC_PROJECT_PATH in /mnt form (WSL agents). A project nested inside a parent git
// repo otherwise yields "Project/index.js" against a graph keyed by "index.js" → 0 targets.
const _raw = _fwd(rawPath);
const _roots = [localRoot, process.env.ZC_PROJECT_PATH, process.env.ZC_PROJECT_PATH && _mnt(process.env.ZC_PROJECT_PATH)]
  .filter(Boolean).map(_fwd).filter((r) => _raw.toLowerCase().startsWith(r.toLowerCase().replace(/\/+$/, "") + "/"))
  .sort((x, y) => y.length - x.length);
const rel = _roots.length ? _raw.slice(_roots[0].replace(/\/+$/, "").length + 1) : _raw;

try {
  const scPath = process.env.ZC_REPO_DIR
    ? join(process.env.ZC_REPO_DIR, "dist")
    : join(process.env.USERPROFILE ?? process.env.HOME ?? "", "AI_projects", "SecureContext", "dist");
  const url = (f) => `file://${join(scPath, f).replace(/\\/g, "/")}`;

  const harness = await import(url("harness.js"));
  const seenKey = `impact-write:${rel}`;
  // Once per file per session: the point is to make the cascade visible before
  // the first change, not to tax every subsequent one.
  dbg(`project=${projectPath} rel=${rel} session=${sessionId}`);
  if (harness.wasReadThisSession?.(projectPath, sessionId, seenKey)) { dbg("seen this session → allow"); allow(); }

  const { createStore } = await import(url("store.js"));
  const { renderImpact } = await import(url("indexing/call_edges.js"));
  const store = await createStore();
  const impact = await store.callImpactFor(projectPath, { file: rel });
  dbg(`impact built=${impact.built} targets=${impact.targets.length} dynamic=${impact.dynamicSites}`);

  const telemetry = { projectPath, agentId: process.env.ZC_AGENT_ID || "default", toolName, filePath: rawPath };
  // 2026-09-12 — UNBUILT is not "nothing depends on this". Deny ONCE per session
  // with the remedy; after that, allow (a hook that blocks forever gets disabled,
  // and postedit-reindex builds the graph as files are touched anyway).
  if (!impact.built) {
    const unbuiltKey = "impact-unbuilt-notified";
    if (harness.wasReadThisSession?.(projectPath, sessionId, unbuiltKey)) allow();
    try { harness.recordSessionRead?.(projectPath, sessionId, unbuiltKey); } catch { /* best effort */ }
    await denyWith("impact_unbuilt_deny", `graph not built for ${projectPath}`,
      `[zc-ctx] The call graph for this project is NOT BUILT, so nobody can say what depends on ${rel}. ` +
      `Build it once: zc_index_project() (or ask the operator to index the project), then re-issue this edit. ` +
      `Until it is built, every zc_impact answer is "unknown" — and unknown is not "safe to change". ` +
      `This notice appears once per session.`, telemetry);
  }

  let targets = impact.targets;

  // For an Edit, narrow to the function actually being changed. A file-wide
  // report on a one-line edit is noise, and noise is what gets a gate turned off.
  const oldString = args.old_string ?? (Array.isArray(args.edits) ? args.edits[0]?.old_string : null);
  if (toolName !== "Write" && oldString && existsSync(rawPath)) {
    try {
      const content = readFileSync(rawPath, "utf8");
      const idx = content.indexOf(oldString);
      if (idx >= 0) {
        const line = content.slice(0, idx).split("\n").length;
        const { extractFileCalls } = await import(url("indexing/call_graph.js"));
        const parsed = await extractFileCalls(content, rel);
        const enclosing = (parsed?.decls ?? []).filter((d) => line >= d.line && line <= d.endLine);
        if (enclosing.length > 0) {
          // Innermost declaration containing the edit.
          const inner = enclosing.sort((a, b) => (b.line - a.line))[0];
          const narrowed = targets.filter((t) => t.symbol === inner.symbol);
          if (narrowed.length > 0) targets = narrowed;
        }
      }
    } catch { /* fall back to the file-wide view */ }
  }

  const crossFile = targets.filter(
    (t) => t.callers >= MIN_CALLERS && t.files.some((f) => f !== rel),
  );
  // 2026-09-12 — no early allow: the map is shown once per file even when it is
  // empty. "0 callers, graph built" is a fact the agent must have seen; before
  // this change it was indistinguishable from "hook never ran".
  const body = targets.length
    ? renderImpact({ targets, dynamicSites: impact.dynamicSites, built: true }, { file: rel }, { crossFileOnly: false, limit: 10 })
    : `The call graph is BUILT and lists no static callers for the functions in ${rel}` +
      (impact.dynamicSites ? ` (${impact.dynamicSites} dynamic call site(s) could not be resolved — check them by hand).` : ".");
  const outcome = crossFile.length ? "impact_write_deny" : "impact_write_shown";

  try { harness.recordSessionRead?.(projectPath, sessionId, seenKey); } catch { /* best effort */ }
  await denyWith(outcome,
    crossFile.length ? `${crossFile.length} cross-file target(s): ${crossFile.map((t) => t.symbol).slice(0, 5).join(", ")}` : `0 cross-file targets; ${targets.length} target(s) in-file`,
    `[zc-ctx] Before changing ${rel} — the caller map (mandatory before any edit):\n\n` + body +
    `\n\nRe-issue the same edit to proceed; this shows once per file per session. ` +
    `State the caller count in your MERGE note. Set ZC_IMPACT_ON_WRITE=0 to disable.`, telemetry);

} catch (e) {
  // A hook bug must never block an edit — but it must never be SILENT either:
  // a swallowed error here is indistinguishable from "nothing depends on this"
  // (2026-09-12: both test runs allowed with no output). stderr + telemetry.
  process.stderr.write(`[zc-ctx prewrite-impact] error (allowing): ${String(e && e.stack || e).slice(0, 400)}\n`);
  try {
    const apiUrl = (process.env.ZC_API_URL ?? "").replace(/\/$/, "");
    if (apiUrl) await fetch(`${apiUrl}/api/v1/telemetry/pretool-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(process.env.ZC_API_KEY ? { Authorization: `Bearer ${process.env.ZC_API_KEY}` } : {}) },
      body: JSON.stringify({ projectPath, agentId: process.env.ZC_AGENT_ID || "default", toolName, filePath: rawPath, outcome: "error", detail: String(e).slice(0, 200) }),
      signal: AbortSignal.timeout(1500),
    });
  } catch { /* telemetry is best effort */ }
  allow();
}
