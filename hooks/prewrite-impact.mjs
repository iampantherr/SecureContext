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

let input;
try { input = JSON.parse(raw); } catch { allow(); }

const toolName = input.tool_name ?? input.toolName ?? "";
if (!/^(Edit|Write|MultiEdit)$/.test(toolName)) allow();
if (process.env.ZC_IMPACT_ON_WRITE === "0") allow();

const args = input.tool_input ?? input.arguments ?? {};
const rawPath = args.file_path ?? args.path ?? "";
if (!rawPath) allow();
if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(rawPath)) allow();

const MIN_CALLERS = Number(process.env.ZC_IMPACT_MIN_CALLERS ?? "3");
const sessionId = input.session_id ?? input.sessionId ?? "default";

/** Repo root for the FILE, not the session cwd (same lesson as the read hook). */

const sessionCwd = input.cwd ?? process.cwd();
const projectPath = resolveProjectRoot(rawPath, sessionCwd);
const rel = rawPath.toLowerCase().startsWith(projectPath.toLowerCase())
  ? rawPath.slice(projectPath.length).replace(/^[\\/]+/, "").replace(/\\/g, "/")
  : rawPath.replace(/\\/g, "/");

try {
  const scPath = process.env.ZC_REPO_DIR
    ? join(process.env.ZC_REPO_DIR, "dist")
    : join(process.env.USERPROFILE ?? process.env.HOME ?? "", "AI_projects", "SecureContext", "dist");
  const url = (f) => `file://${join(scPath, f).replace(/\\/g, "/")}`;

  const harness = await import(url("harness.js"));
  const seenKey = `impact-write:${rel}`;
  // Once per file per session: the point is to make the cascade visible before
  // the first change, not to tax every subsequent one.
  if (harness.wasReadThisSession?.(projectPath, sessionId, seenKey)) allow();

  const { createStore } = await import(url("store.js"));
  const { renderImpact } = await import(url("indexing/call_edges.js"));
  const store = await createStore();
  const impact = await store.callImpactFor(projectPath, { file: rel });

  // Unbuilt layer: say nothing. A banner on every edit would train agents to
  // skip the block, and "not built" is not "nothing depends on this".
  if (!impact.built || impact.targets.length === 0) allow();

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
  if (crossFile.length === 0) allow();

  const body = renderImpact(
    { targets: crossFile, dynamicSites: impact.dynamicSites, built: true },
    { file: rel },
    { crossFileOnly: true, limit: 10 },
  );

  try { harness.recordSessionRead?.(projectPath, sessionId, seenKey); } catch { /* best effort */ }

  // Telemetry: without this the write hook was invisible — an operator watching
  // pretool_events_pg could not tell "never fires" from "fires and helps"
  // (found 2026-08-04 observing a live run). Mirrors preread-dedup's emitter:
  // awaited with a short timeout, failures loud on stderr, never blocks the deny.
  try {
    const apiUrl = (process.env.ZC_API_URL ?? "").replace(/\/$/, "");
    if (apiUrl) {
      const resp = await fetch(`${apiUrl}/api/v1/telemetry/pretool-event`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.ZC_API_KEY ? { Authorization: `Bearer ${process.env.ZC_API_KEY}` } : {}),
        },
        body: JSON.stringify({
          projectPath, agentId: process.env.ZC_AGENT_ID || "default",
          toolName: toolName, filePath: rawPath,
          outcome: "impact_write_deny",
          detail: `${crossFile.length} cross-file target(s): ${crossFile.map((t) => t.symbol).slice(0, 5).join(", ")}`,
        }),
        signal: AbortSignal.timeout(1500),
      });
      if (!resp.ok) process.stderr.write(`[zc-ctx telemetry] impact_write_deny REJECTED ${resp.status}\n`);
    }
  } catch (e) {
    process.stderr.write(`[zc-ctx telemetry] impact_write_deny failed: ${String(e).slice(0, 160)}\n`);
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `[zc-ctx] Before changing ${rel} — other files call this.\n\n` +
        body +
        `\n\nRe-issue the same edit to proceed; this fires once per file per session. ` +
        `Check the callers above still hold. Set ZC_IMPACT_ON_WRITE=0 to disable.`,
    },
  }));
  process.exit(0);
} catch {
  allow();   // a hook bug must never block an edit
}
