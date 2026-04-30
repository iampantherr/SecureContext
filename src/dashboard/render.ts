/**
 * v0.18.2 Sprint 2.6 — server-rendered HTML for the operator dashboard.
 *
 * Vanilla HTML + HTMX (loaded via CDN). No build step. No JS framework.
 * Designed to graduate cleanly into the AgentShield Security Console later
 * by virtue of the data endpoints (/dashboard/pending etc.) being stable —
 * the HTML wrapper is throwaway, the JSON shape is the contract.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * v0.18.4 Sprint 2.7 — line-based diff renderer for the dashboard.
 *
 * Computes a longest-common-subsequence (LCS) diff between parent_body and
 * candidate_body and renders it as side-by-side HTML with red/green
 * highlighting. Pure-JS, no external diff library — keeps the dashboard
 * dependency-free.
 *
 * For very long bodies (>500 lines either side), falls back to a simple
 * "show both, no highlighting" view to keep render time bounded.
 */
export function renderDiff(parent: string, candidate: string): string {
  const parentLines    = parent.split(/\r?\n/);
  const candidateLines = candidate.split(/\r?\n/);
  if (parentLines.length > 500 || candidateLines.length > 500) {
    // Fallback for huge bodies — just show both
    return `
      <div class="diff-fallback">
        <div class="diff-side">
          <div class="diff-label">Previous version</div>
          <pre>${escapeHtml(parent)}</pre>
        </div>
        <div class="diff-side">
          <div class="diff-label">Proposed</div>
          <pre>${escapeHtml(candidate)}</pre>
        </div>
      </div>
    `;
  }
  // Compute LCS table
  const m = parentLines.length;
  const n = candidateLines.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      lcs[i][j] = parentLines[i - 1] === candidateLines[j - 1]
        ? lcs[i - 1][j - 1] + 1
        : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
  }
  // Backtrack to produce diff ops
  type Op = { kind: "equal" | "del" | "add"; left?: string; right?: string };
  const ops: Op[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && parentLines[i - 1] === candidateLines[j - 1]) {
      ops.unshift({ kind: "equal", left: parentLines[i - 1], right: candidateLines[j - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      ops.unshift({ kind: "add", right: candidateLines[j - 1] });
      j--;
    } else {
      ops.unshift({ kind: "del", left: parentLines[i - 1] });
      i--;
    }
  }
  // Render side-by-side: for each op, show left + right (blank when only one side)
  const leftRows:  string[] = [];
  const rightRows: string[] = [];
  for (const op of ops) {
    if (op.kind === "equal") {
      leftRows.push(`<div class="diff-row diff-equal">${escapeHtml(op.left ?? "")}</div>`);
      rightRows.push(`<div class="diff-row diff-equal">${escapeHtml(op.right ?? "")}</div>`);
    } else if (op.kind === "del") {
      leftRows.push(`<div class="diff-row diff-del">${escapeHtml(op.left ?? "")}</div>`);
      rightRows.push(`<div class="diff-row diff-blank"></div>`);
    } else {
      leftRows.push(`<div class="diff-row diff-blank"></div>`);
      rightRows.push(`<div class="diff-row diff-add">${escapeHtml(op.right ?? "")}</div>`);
    }
  }
  const adds = ops.filter((o) => o.kind === "add").length;
  const dels = ops.filter((o) => o.kind === "del").length;
  return `
    <div class="diff-summary">
      <span class="diff-stat-add">+${adds}</span>
      <span class="diff-stat-del">-${dels}</span>
      lines changed
    </div>
    <div class="diff-grid">
      <div class="diff-side">
        <div class="diff-label">Previous version (parent body)</div>
        <div class="diff-content">${leftRows.join("")}</div>
      </div>
      <div class="diff-side">
        <div class="diff-label">Proposed candidate</div>
        <div class="diff-content">${rightRows.join("")}</div>
      </div>
    </div>
  `;
}

/**
 * v0.18.3 — Resolve project_hash → human-readable project name.
 *
 * The dashboard shows pending mutation results from ALL projects in one
 * stream. Without a name resolver, each row only shows the 16-char hash —
 * functional but unreadable. We map hash → project basename via:
 *
 *   1. ZC_A2A_REGISTRY_PATH env var (operator override)
 *   2. <home>/AI_projects/A2A_dispatcher/data/agents.json (default location)
 *   3. ../A2A_dispatcher/data/agents.json (sibling-of-cwd lookup)
 *
 * Returns a Map<projectHash, basename(projectPath)>. If the registry can't
 * be read, returns an empty map and the dashboard falls back to showing
 * the hash. Multi-project: the same registry file holds an entry per
 * project, so one read serves the whole dashboard.
 */
export async function loadProjectNameMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  // v0.18.9 — query PG project_paths_pg first. This is populated by the API
  // server's /api/v1/telemetry/tool_call handler on every write — so it
  // covers EVERY project that has emitted any telemetry, not just those
  // launched via the A2A dispatcher. Critical for Docker-deployed dashboards
  // (the container can't read the host's agents.json).
  try {
    const { withClient } = await import("../pg_pool.js");
    const rows = await withClient(async (c) => {
      const r = await c.query<{ project_hash: string; project_path: string }>(
        `SELECT project_hash, project_path FROM project_paths_pg`,
      );
      return r.rows;
    });
    for (const r of rows) {
      const name = basename(r.project_path.replace(/\\/g, "/"));
      if (name) map.set(r.project_hash, name);
    }
  } catch { /* PG unavailable — fall through to file-based registry */ }

  // Then merge agents.json — wins on conflict (it's curated by start-agents.ps1
  // and gives the cleanest names; PG entries are best-effort from telemetry).
  const candidates = [
    process.env.ZC_A2A_REGISTRY_PATH,
    join(homedir(), "AI_projects", "A2A_dispatcher", "data", "agents.json"),
    join(process.cwd(), "..", "A2A_dispatcher", "data", "agents.json"),
  ].filter((p): p is string => Boolean(p));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      for (const [hash, entry] of Object.entries(data)) {
        const projectPath = (entry as { _meta?: { projectPath?: string } } | null)?._meta?.projectPath;
        if (typeof projectPath === "string" && projectPath.length > 0) {
          const name = basename(projectPath.replace(/\\/g, "/"));
          if (name) map.set(hash, name);  // overrides PG entry
        }
      }
      break;  // first valid registry wins for the file portion
    } catch { /* try next candidate */ }
  }
  return map;
}

interface MutationCandidatePreview {
  candidate_body:    string;
  rationale:         string;
  self_rated_score:  number;
}

export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SecureContext Operator Console</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://unpkg.com/htmx.org@1.9.10"></script>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 24px;
    background: #0e1116; color: #e6e8eb;
    line-height: 1.5;
  }
  header { display: flex; align-items: baseline; gap: 16px; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #2a2f37; }
  h1 { margin: 0; font-size: 1.5rem; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.85rem; font-weight: 600; background: #1f2937; color: #94a3b8; }
  .badge.alert { background: #7f1d1d; color: #fecaca; animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
  main { max-width: 1100px; margin: 0 auto; }
  .panel { background: #161b22; border: 1px solid #2a2f37; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .panel h2 { margin: 0 0 12px 0; font-size: 1.1rem; font-weight: 600; color: #e6e8eb; }
  .empty { color: #94a3b8; font-style: italic; }
  .result {
    border: 1px solid #2a2f37; border-radius: 6px; padding: 12px; margin-bottom: 12px; background: #0e1116;
  }
  .result-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .result-id { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9rem; color: #38bdf8; }
  .skill-id { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85rem; color: #a78bfa; }
  .project-name { display: inline-block; padding: 2px 8px; border-radius: 4px; background: #064e3b; color: #d1fae5; font-weight: 600; font-size: 0.85rem; cursor: help; }
  .project-name.unresolved { background: #1f2937; color: #94a3b8; font-weight: 400; }
  .meta { color: #94a3b8; font-size: 0.85rem; margin-bottom: 8px; }
  .meta code { background: #1f2937; padding: 1px 4px; border-radius: 3px; }
  details { margin-bottom: 6px; }
  summary { cursor: pointer; padding: 6px 0; font-weight: 500; user-select: none; }
  summary:hover { color: #38bdf8; }
  summary .score { color: #4ade80; font-family: ui-monospace, monospace; font-size: 0.85rem; margin-left: 8px; }
  .candidate-body {
    background: #0a0d12; border: 1px solid #2a2f37; border-radius: 4px; padding: 10px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.82rem;
    white-space: pre-wrap; word-wrap: break-word;
    max-height: 300px; overflow: auto;
  }
  /* v0.18.4 — diff view */
  .diff-summary { font-size: 0.85rem; color: #94a3b8; margin: 8px 0; }
  .diff-stat-add { color: #4ade80; font-family: ui-monospace, monospace; margin-right: 8px; }
  .diff-stat-del { color: #f87171; font-family: ui-monospace, monospace; margin-right: 8px; }
  .diff-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .diff-side { background: #0a0d12; border: 1px solid #2a2f37; border-radius: 4px; overflow: hidden; }
  .diff-label { padding: 4px 8px; background: #1f2937; color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .diff-content { max-height: 400px; overflow: auto; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.78rem; }
  .diff-row { padding: 1px 8px; white-space: pre-wrap; word-wrap: break-word; min-height: 1em; }
  .diff-row.diff-equal { color: #cbd5e1; }
  .diff-row.diff-add   { color: #d1fae5; background: #064e3b; border-left: 2px solid #4ade80; }
  .diff-row.diff-del   { color: #fecaca; background: #7f1d1d; border-left: 2px solid #f87171; text-decoration: line-through; }
  .diff-row.diff-blank { background: #050709; min-height: 1em; }
  .diff-fallback { display: flex; gap: 8px; }
  .diff-fallback .diff-side { flex: 1; }
  .diff-fallback pre { padding: 8px; margin: 0; max-height: 400px; overflow: auto; font-size: 0.78rem; }
  .candidate-tabs { margin-top: 8px; }
  .candidate-tabs > details { margin-bottom: 6px; border: 1px solid #1f2937; border-radius: 4px; padding: 6px; }
  .tab-label { font-size: 0.85rem; color: #94a3b8; cursor: pointer; padding: 2px 4px; }
  .tab-label:hover { color: #38bdf8; }
  /* v0.18.5 — Skills panel + edit form */
  .skill-scope { margin-bottom: 16px; }
  .skill-scope-header { font-size: 0.85rem; color: #94a3b8; margin-bottom: 6px; }
  .skill-row { background: #0e1116; border: 1px solid #1f2937; border-radius: 4px; padding: 10px; margin-bottom: 8px; }
  .skill-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .skill-name { font-weight: 600; font-family: ui-monospace, monospace; font-size: 0.95rem; color: #e6e8eb; }
  .skill-meta { color: #94a3b8; font-size: 0.85rem; margin-top: 4px; }
  .skill-meta .role-tag { background: #1e3a8a; color: #dbeafe; padding: 1px 6px; border-radius: 3px; font-size: 0.78rem; margin-right: 4px; }
  .skill-meta .guidance-preview { color: #cbd5e1; font-style: italic; }
  .edit-btn { background: #1f2937; color: #cbd5e1; border: 1px solid #2a2f37; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
  .edit-btn:hover { background: #2a2f37; color: #38bdf8; }
  .skill-edit-zone { margin-top: 8px; }
  .skill-edit-form { background: #0a0d12; border: 1px solid #2a2f37; border-radius: 4px; padding: 12px; margin-top: 8px; }
  .skill-edit-form .form-banner { background: #1f2937; border-left: 3px solid #fbbf24; padding: 8px 12px; margin-bottom: 12px; font-size: 0.85rem; color: #cbd5e1; border-radius: 0 4px 4px 0; }
  .skill-edit-form label { display: block; margin-bottom: 12px; font-size: 0.85rem; color: #cbd5e1; }
  .skill-edit-form .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .skill-edit-form input[type=text], .skill-edit-form input[type=number], .skill-edit-form textarea {
    width: 100%; padding: 6px 10px; background: #0a0d12; color: #e6e8eb;
    border: 1px solid #2a2f37; border-radius: 4px; font-family: inherit; font-size: 0.9rem;
    margin-top: 2px;
  }
  .skill-edit-form .help { display: block; font-size: 0.78rem; color: #6b7280; margin-top: 2px; }
  .skill-edit-form details.fixtures-readonly { margin: 12px 0; padding: 8px; background: #050709; border: 1px solid #1f2937; border-radius: 4px; }
  .skill-edit-form details.fixtures-readonly summary { cursor: pointer; color: #94a3b8; font-size: 0.85rem; }
  .skill-edit-form hr { border: none; border-top: 1px solid #2a2f37; margin: 16px 0; }
  .skill-edit-response { margin-top: 12px; }
  /* v0.18.8 — skill efficiency column (Loop B) */
  .skill-eff { color: #cbd5e1; font-size: 0.82rem; cursor: help; border-bottom: 1px dotted #6b7280; }
  .skill-eff strong { color: #4ade80; font-family: ui-monospace, monospace; }
  .skill-eff-none { color: #6b7280; }
  .skill-eff-none em { font-style: italic; }
  /* v0.18.7 — token savings panel */
  .savings-controls { display: flex; gap: 16px; margin-bottom: 12px; align-items: center; }
  .savings-controls label { font-size: 0.85rem; color: #cbd5e1; display: flex; gap: 6px; align-items: center; }
  .savings-controls select { padding: 4px 8px; background: #0a0d12; color: #e6e8eb; border: 1px solid #2a2f37; border-radius: 4px; font-family: inherit; font-size: 0.9rem; }
  .savings-summary .savings-header { font-size: 0.85rem; color: #94a3b8; margin-bottom: 12px; line-height: 1.5; }
  .savings-totals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }
  .savings-tile { background: #0e1116; border: 1px solid #2a2f37; border-radius: 6px; padding: 12px; text-align: center; }
  .savings-tile-num { font-size: 1.4rem; font-weight: 700; color: #4ade80; font-family: ui-monospace, monospace; }
  .savings-tile-label { font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }
  .savings-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-bottom: 12px; }
  .savings-table th { text-align: left; padding: 6px 10px; background: #1f2937; color: #94a3b8; text-transform: uppercase; font-size: 0.72rem; letter-spacing: 0.05em; font-weight: 600; border-bottom: 1px solid #2a2f37; }
  .savings-table td { padding: 6px 10px; border-bottom: 1px solid #1f2937; color: #cbd5e1; }
  .savings-table td.savings-cell { color: #4ade80; }
  .savings-methodology { margin-top: 8px; padding: 8px 12px; background: #050709; border: 1px solid #2a2f37; border-radius: 4px; font-size: 0.8rem; color: #94a3b8; }
  .savings-methodology summary { cursor: pointer; }
  .savings-methodology ul { margin: 8px 0 0 0; padding-left: 20px; }
  .savings-methodology li { margin-bottom: 4px; }
  /* v0.18.8 — trend / per-agent / anti-patterns */
  .trend-panel { margin-top: 16px; padding: 12px; background: #0e1116; border: 1px solid #2a2f37; border-radius: 6px; }
  .trend-header { font-size: 0.85rem; color: #cbd5e1; margin-bottom: 8px; }
  .trend-svg { width: 100%; height: 80px; display: block; }
  .trend-axis { display: flex; justify-content: space-between; font-size: 0.72rem; color: #6b7280; margin-top: 4px; }
  .trend-empty { color: #94a3b8; font-style: italic; padding: 8px; background: #050709; border-radius: 4px; font-size: 0.85rem; }
  .per-agent-panel { margin-top: 12px; padding: 8px 12px; background: #0a0d12; border: 1px solid #1f2937; border-radius: 4px; font-size: 0.85rem; }
  .per-agent-panel summary { cursor: pointer; color: #cbd5e1; font-weight: 600; }
  .anti-patterns-panel { margin-top: 12px; padding: 8px 12px; background: #050709; border: 1px solid #2a2f37; border-radius: 4px; font-size: 0.85rem; }
  .anti-patterns-panel summary { cursor: pointer; color: #fbbf24; font-weight: 600; }
  .anti-pattern { padding: 6px 10px; margin-top: 6px; border-radius: 4px; font-size: 0.85rem; }
  .anti-pattern.warn-chip { background: #7f1d1d; color: #fecaca; border-left: 3px solid #f87171; }
  .anti-pattern.info-chip { background: #1f2937; color: #cbd5e1; border-left: 3px solid #fbbf24; }
  .rationale { color: #cbd5e1; font-style: italic; margin-bottom: 6px; padding-left: 12px; border-left: 2px solid #38bdf8; }
  form { margin-top: 16px; padding-top: 12px; border-top: 1px solid #2a2f37; }
  form label { display: block; margin-bottom: 8px; font-size: 0.85rem; color: #cbd5e1; }
  form input[type=text], form input[type=number], form textarea {
    width: 100%; padding: 6px 10px; background: #0a0d12; color: #e6e8eb;
    border: 1px solid #2a2f37; border-radius: 4px; font-family: inherit; font-size: 0.9rem;
  }
  form input[type=text]:focus, form input[type=number]:focus, form textarea:focus {
    outline: none; border-color: #38bdf8;
  }
  form .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  form .checkbox { display: flex; align-items: center; gap: 8px; margin: 12px 0; }
  form .checkbox input { width: auto; }
  form .help { font-size: 0.8rem; color: #94a3b8; margin-top: 4px; }
  form .actions { display: flex; gap: 8px; }
  button { padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: 600; font-family: inherit; font-size: 0.9rem; border: 1px solid; }
  button.approve { background: #166534; color: #d1fae5; border-color: #14532d; }
  button.approve:hover { background: #15803d; }
  button.reject { background: #7f1d1d; color: #fecaca; border-color: #7f1d1d; }
  button.reject:hover { background: #991b1b; }
  .response { margin-top: 12px; padding: 10px; border-radius: 4px; font-size: 0.9rem; }
  .response .ok { background: #064e3b; color: #d1fae5; padding: 10px; border-radius: 4px; }
  .response .error { background: #7f1d1d; color: #fecaca; padding: 10px; border-radius: 4px; }
  footer { color: #94a3b8; font-size: 0.8rem; margin-top: 32px; padding-top: 12px; border-top: 1px solid #2a2f37; }
  footer code { color: #cbd5e1; }
  .tooltip {
    border-bottom: 1px dotted #94a3b8; cursor: help; position: relative;
  }
</style>
</head>
<body>
<header>
  <h1>SecureContext Operator Console</h1>
  <span id="badge" class="badge">…</span>
</header>
<main>

<div class="panel">
  <h2>Pending mutation reviews</h2>
  <div id="pending"
       hx-get="/dashboard/pending" hx-trigger="load, every 10s"
       hx-target="this" hx-swap="innerHTML">
    Loading…
  </div>
</div>

<div class="panel">
  <h2>Active skills <span style="font-size:0.85rem; font-weight:400; color:#94a3b8">(edit frontmatter — body is mutator-managed)</span></h2>
  <div id="skills"
       hx-get="/dashboard/skills" hx-trigger="load, every 30s"
       hx-target="this" hx-swap="innerHTML">
    Loading…
  </div>
</div>

<div class="panel">
  <h2>Token savings <span style="font-size:0.85rem; font-weight:400; color:#94a3b8">(estimated, vs counterfactual native flow)</span></h2>
  <div class="savings-controls">
    <label>Project:
      <select id="savings-project" name="project"
              hx-get="/dashboard/savings"
              hx-trigger="change"
              hx-target="#savings-panel"
              hx-include="[name='window']">
        <option value="">— loading projects… —</option>
      </select>
    </label>
    <label>Window:
      <select name="window"
              hx-get="/dashboard/savings"
              hx-trigger="change"
              hx-target="#savings-panel"
              hx-include="[name='project']">
        <option value="session">Last hour (session)</option>
        <option value="24h">Last 24 hours</option>
        <option value="7d" selected>Last 7 days</option>
      </select>
    </label>
  </div>
  <div id="savings-panel">
    <p class="empty">Pick a project above to estimate token savings.</p>
  </div>
  <div id="savings-trend-controls" style="margin-top:16px; display:none">
    <label>Trend cadence:
      <select id="savings-trend-cadence" name="cadence">
        <option value="daily" selected>Daily (last 30 days)</option>
        <option value="4h">4-hour buckets (last 24 hours)</option>
      </select>
    </label>
  </div>
  <div id="savings-trend"></div>
  <script>
    // Lazy-load project options on first render
    (async () => {
      try {
        const r = await fetch('/dashboard/savings/projects', { cache: 'no-store' });
        const html = await r.text();
        const sel = document.getElementById('savings-project');
        if (sel) sel.innerHTML = '<option value="">— pick a project —</option>' + html;
      } catch (e) { /* swallow */ }
    })();
    // Load trend + per-agent + anti-patterns when project changes
    document.getElementById('savings-project')?.addEventListener('change', async (e) => {
      const proj = e.target.value;
      const trendDiv = document.getElementById('savings-trend');
      const trendCtrls = document.getElementById('savings-trend-controls');
      if (!proj) { trendDiv.innerHTML = ''; trendCtrls.style.display = 'none'; return; }
      trendCtrls.style.display = 'block';
      const cad = document.getElementById('savings-trend-cadence').value;
      try {
        const r = await fetch(\`/dashboard/savings/trend?project=\${encodeURIComponent(proj)}&cadence=\${cad}\`, { cache: 'no-store' });
        trendDiv.innerHTML = await r.text();
      } catch (err) { trendDiv.innerHTML = '<div class="error">Failed to load trend.</div>'; }
    });
    document.getElementById('savings-trend-cadence')?.addEventListener('change', () => {
      document.getElementById('savings-project')?.dispatchEvent(new Event('change'));
    });
    // v0.18.9 — auto-refresh every 10s while a project is selected. Re-fires
    // the existing HTMX project-change handler so both the savings panel and
    // the trend panel update with fresh data. Cheap (single GET each), and
    // pauses cleanly when no project is selected.
    setInterval(() => {
      const sel = document.getElementById('savings-project');
      if (sel && sel.value) {
        // Trigger the HTMX-bound select handler to re-fetch /dashboard/savings.
        // htmx.trigger() fires hx-trigger="change" on the element, refreshing
        // both #savings-panel (HTMX swap) and the trend div (our JS listener).
        if (window.htmx) {
          window.htmx.trigger(sel, 'change');
        } else {
          sel.dispatchEvent(new Event('change'));
        }
      }
    }, 10000);
  </script>
</div>

<footer>
  v0.18.9 — local operator console, embedded in <code>zc-ctx-api</code> at <code>:3099/dashboard</code>.
  Notifications poll every 5s; pending list every 10s.
  Browser desktop notifications: <button id="notify-btn" onclick="enableNotifications()" type="button" style="background:#1f2937;color:#cbd5e1;border-color:#2a2f37">Enable</button>
</footer>

</main>
<script>
// Tiny client-side: poll /dashboard/health every 5s, update title-bar + badge,
// fire desktop notification when pending count rises.
let lastPendingCount = 0;
let firstPoll = true;
function updateTitleBadge(n) {
  document.title = n > 0 ? \`(\${n}) SecureContext Console\` : 'SecureContext Operator Console';
  const b = document.getElementById('badge');
  if (b) {
    b.textContent = n > 0 ? \`● \${n} pending review\` : 'idle';
    b.className = 'badge' + (n > 0 ? ' alert' : '');
  }
  // Notify only when pending RISES (and we've seen at least one poll)
  if (!firstPoll && n > lastPendingCount && Notification.permission === 'granted') {
    new Notification('SecureContext: skill mutation pending review', {
      body: \`\${n} candidate bundle(s) awaiting your decision.\`,
      icon: '/favicon.ico',
    });
  }
  firstPoll = false;
  lastPendingCount = n;
}
async function pollHealth() {
  try {
    const res = await fetch('/dashboard/health', { cache: 'no-store' });
    const data = await res.json();
    updateTitleBadge(data.pending_count || 0);
  } catch { /* ignore transient network errors */ }
}
pollHealth();
setInterval(pollHealth, 5000);

function enableNotifications() {
  if (!('Notification' in window)) { alert('Browser does not support notifications'); return; }
  Notification.requestPermission().then((p) => {
    document.getElementById('notify-btn').textContent = p === 'granted' ? 'Enabled ✓' : 'Denied';
  });
}
</script>
</body>
</html>`;
}

/**
 * Render the inner-HTML fragment for the #pending div. Called every 10s by
 * HTMX, swaps innerHTML so all pending reviews are visible at once.
 *
 * v0.18.3: accepts a project_hash → name map (built once per request via
 * loadProjectNameMap) so each row can show the project basename instead
 * of just the 16-char hash.
 */
// ─── v0.18.5 Sprint 2.7 — Skills panel rendering ─────────────────────────────

interface SkillRow {
  skill_id:    string;
  name:        string;
  version:     string;
  scope:       string;
  description: string;
  frontmatter: unknown;
  body?:       string;
}

export function renderSkillsListFragment(
  rows: Array<Record<string, unknown>>,
  projectNameMap: Map<string, string> = new Map(),
  efficiencyMap: Map<string, { avg_tokens: number; run_count: number }> = new Map(),
): string {
  if (rows.length === 0) {
    return `<p class="empty">No active skills found. Use <code>zc_skill_import</code> to add one.</p>`;
  }
  // Group by scope so projects are visually clustered
  const byScope = new Map<string, SkillRow[]>();
  for (const r of rows) {
    const skill: SkillRow = {
      skill_id:    String(r.skill_id),
      name:        String(r.name),
      version:     String(r.version),
      scope:       String(r.scope),
      description: String(r.description ?? ""),
      frontmatter: r.frontmatter,
    };
    const arr = byScope.get(skill.scope) ?? [];
    arr.push(skill);
    byScope.set(skill.scope, arr);
  }
  const sections: string[] = [];
  for (const [scope, skills] of byScope.entries()) {
    let scopeLabel: string;
    if (scope === "global") {
      scopeLabel = `<span class="project-name" style="background:#1e3a8a; color:#dbeafe">global</span>`;
    } else if (scope.startsWith("project:")) {
      const hash = scope.slice("project:".length);
      const name = projectNameMap.get(hash);
      scopeLabel = name
        ? `<span class="project-name" title="project_hash: ${escapeHtml(hash)}">${escapeHtml(name)}</span>`
        : `<span class="project-name unresolved">project:${escapeHtml(hash.slice(0, 8))}…</span>`;
    } else {
      scopeLabel = `<span class="project-name unresolved">${escapeHtml(scope)}</span>`;
    }
    const skillRows = skills.map((s) => {
      const fm = typeof s.frontmatter === "string" ? JSON.parse(s.frontmatter) : (s.frontmatter as Record<string, unknown>);
      const intended = (fm?.intended_roles as string[] | undefined) ?? [];
      const guidance = String((fm?.mutation_guidance as string | undefined) ?? "");
      const intendedHtml = intended.length > 0
        ? intended.map((r) => `<code class="role-tag">${escapeHtml(r)}</code>`).join(" ")
        : `<span style="color:#6b7280; font-style:italic">no intended_roles</span>`;
      // v0.18.8 Loop B — skill efficiency column
      const eff = efficiencyMap.get(s.skill_id);
      const effHtml = eff
        ? `<span class="skill-eff" title="Average across ${eff.run_count} runs in last 30 days">avg cost: <strong>${Math.round(eff.avg_tokens).toLocaleString()}</strong> tokens/run · ${eff.run_count} runs</span>`
        : `<span class="skill-eff skill-eff-none" title="Insufficient data (need ≥3 runs in last 30 days)">avg cost: <em>n/a</em></span>`;
      return `
        <div class="skill-row" data-skill-id="${escapeHtml(s.skill_id)}">
          <div class="skill-header">
            <span class="skill-name">${escapeHtml(s.name)} <span style="color:#94a3b8">v${escapeHtml(s.version)}</span></span>
            <button class="edit-btn"
                    hx-get="/dashboard/skills/edit?skill_id=${encodeURIComponent(s.skill_id)}"
                    hx-target="next .skill-edit-zone" hx-swap="innerHTML">
              Edit frontmatter
            </button>
          </div>
          <div class="skill-meta">
            ${escapeHtml(s.description || "(no description)")}<br>
            roles: ${intendedHtml}<br>
            ${effHtml}
            ${guidance ? `<br>guidance: <span class="guidance-preview">${escapeHtml(guidance.slice(0, 120))}${guidance.length > 120 ? "…" : ""}</span>` : ""}
          </div>
          <div class="skill-edit-zone"></div>
        </div>
      `;
    }).join("");
    sections.push(`
      <div class="skill-scope">
        <div class="skill-scope-header">${scopeLabel}</div>
        ${skillRows}
      </div>
    `);
  }
  return sections.join("");
}

export function renderSkillEditForm(row: Record<string, unknown>): string {
  const skillId = String(row.skill_id);
  const fm = typeof row.frontmatter === "string" ? JSON.parse(row.frontmatter as string) : (row.frontmatter as Record<string, unknown>);
  const description       = String(fm?.description ?? row.description ?? "");
  const intendedRoles     = ((fm?.intended_roles as string[] | undefined) ?? []).join(", ");
  const mutationGuidance  = String((fm?.mutation_guidance as string | undefined) ?? "");
  const ac                = (fm?.acceptance_criteria as { min_outcome_score?: number; min_pass_rate?: number } | undefined) ?? {};
  const tags              = ((fm?.tags as string[] | undefined) ?? []).join(", ");
  const fixturesJson      = JSON.stringify(fm?.fixtures ?? [], null, 2);

  return `
    <form class="skill-edit-form" hx-post="/dashboard/skills/edit" hx-target="next .skill-edit-response" hx-swap="innerHTML">
      <input type="hidden" name="skill_id" value="${escapeHtml(skillId)}">

      <div class="form-banner">
        Editing <code>${escapeHtml(skillId)}</code>. The body is mutator-managed and NOT editable here — use <code>zc_skill_import</code> for body rewrites. Saving creates a new patch version (e.g. v1.0.3 → v1.0.4) with this frontmatter; current version is archived.
      </div>

      <label>
        <strong>description</strong>
        <input type="text" name="description" value="${escapeHtml(description)}" maxlength="500">
        <span class="help">Single-line skill summary (≤500 chars).</span>
      </label>

      <label>
        <strong>intended_roles</strong> <small>(comma-separated; first entry routes the L1 mutator pool)</small>
        <input type="text" name="intended_roles" value="${escapeHtml(intendedRoles)}" placeholder="e.g. marketer, copywriter">
        <span class="help">Lowercase, alphanumeric/dash/underscore. Empty = no role tagging (falls back to mutator-general).</span>
      </label>

      <label>
        <strong>mutation_guidance</strong>
        <textarea name="mutation_guidance" rows="5" maxlength="4000" placeholder="Skill-specific instructions injected into the mutator's prompt verbatim.">${escapeHtml(mutationGuidance)}</textarea>
        <span class="help">Free-form. Empty to clear. Max 4000 chars.</span>
      </label>

      <div class="form-row">
        <label>
          <strong>min_outcome_score</strong> <small>(0–1)</small>
          <input type="number" name="min_outcome_score" min="0" max="1" step="0.05" value="${ac.min_outcome_score ?? ""}">
        </label>
        <label>
          <strong>min_pass_rate</strong> <small>(0–1)</small>
          <input type="number" name="min_pass_rate" min="0" max="1" step="0.05" value="${ac.min_pass_rate ?? ""}">
        </label>
      </div>

      <label>
        <strong>tags</strong> <small>(comma-separated)</small>
        <input type="text" name="tags" value="${escapeHtml(tags)}" placeholder="e.g. validation, retry-aware">
      </label>

      <details class="fixtures-readonly">
        <summary>Fixtures (read-only — re-import via <code>zc_skill_import</code> to edit)</summary>
        <pre class="candidate-body">${escapeHtml(fixturesJson)}</pre>
      </details>

      <hr>

      <label>
        <strong>Confirm skill_id</strong> <small>(paste exactly to enable submit)</small>
        <input type="text" name="confirm_id" placeholder="${escapeHtml(skillId)}" required autocomplete="off">
      </label>

      <label>
        <strong>Rationale</strong> <small>(audit trail; required)</small>
        <input type="text" name="rationale" required placeholder="e.g. 'Adding copywriter role since CleanCheck launches need both'">
      </label>

      <div class="actions">
        <button type="submit" class="approve">Save (creates new patch version)</button>
      </div>
      <div class="skill-edit-response"></div>
    </form>
  `;
}

export function renderPendingFragment(
  rows: Array<Record<string, unknown>>,
  projectNameMap: Map<string, string> = new Map(),
): string {
  if (rows.length === 0) return `<p class="empty">No mutation results pending review. The mutator is idle.</p>`;
  const sections = rows.map((r) => renderResultSection(r, projectNameMap));
  return sections.join("\n");
}

function renderResultSection(row: Record<string, unknown>, projectNameMap: Map<string, string>): string {
  const result_id      = String(row.result_id);
  const skill_id       = String(row.skill_id);
  const headline       = String(row.headline ?? "");
  const proposer_model = String(row.proposer_model ?? "?");
  const proposer_role  = String(row.proposer_role  ?? "?");
  const candidate_count = Number(row.candidate_count);
  const best_score     = row.best_score === null || row.best_score === undefined ? null : Number(row.best_score);
  const created_at     = String(row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at);
  const original_task  = row.original_task_id ? String(row.original_task_id) : null;
  const original_role  = row.original_role ? String(row.original_role) : null;
  const project_hash   = String(row.project_hash ?? "");
  const project_name   = projectNameMap.get(project_hash) ?? null;

  let bodies: MutationCandidatePreview[] = [];
  try { bodies = JSON.parse(String(row.bodies)) as MutationCandidatePreview[]; } catch { /* corrupt row */ }

  // v0.18.4: render diff view + raw body, both inside a tabbed <details>
  const parentBody = String(row.parent_body ?? "");
  const candidates_html = bodies.map((b, i) => {
    const diffHtml = parentBody
      ? renderDiff(parentBody, b.candidate_body)
      : `<p class="empty">Parent body not available — diff disabled. (Skill may have been archived without preserving the body record.)</p>`;
    return `
    <details>
      <summary>
        <strong>#${i}</strong> ${escapeHtml(b.rationale.slice(0, 90))}${b.rationale.length > 90 ? "…" : ""}
        <span class="score">score=${escapeHtml(String(b.self_rated_score))} · ${b.candidate_body.length} chars</span>
      </summary>
      <div class="rationale">${escapeHtml(b.rationale)}</div>
      <div class="candidate-tabs">
        <details open><summary class="tab-label">Diff vs parent</summary>${diffHtml}</details>
        <details><summary class="tab-label">Full body</summary><div class="candidate-body">${escapeHtml(b.candidate_body)}</div></details>
      </div>
    </details>
    `;
  }).join("");

  // v0.18.3: project name resolved from agents.json registry; falls back to
  // the truncated hash when the registry isn't accessible (e.g. dashboard
  // running in a docker container that can't read the host's data/agents.json)
  const projectLabel = project_name
    ? `<span class="project-name" title="project_hash: ${escapeHtml(project_hash)}">${escapeHtml(project_name)}</span>`
    : `<span class="project-name unresolved" title="No registry entry for hash ${escapeHtml(project_hash)} — set ZC_A2A_REGISTRY_PATH if your dispatcher data dir is non-standard">project:${escapeHtml(project_hash.slice(0, 8))}…</span>`;

  return `
<div class="result" data-result-id="${escapeHtml(result_id)}">
  <div class="result-header">
    <span class="result-id">${escapeHtml(result_id)}</span>
    <span class="skill-id">${escapeHtml(skill_id)}</span>
  </div>
  <div class="meta">
    project: ${projectLabel}<br>
    ${escapeHtml(headline)}<br>
    proposer: <code>${escapeHtml(proposer_model)}</code> (${escapeHtml(proposer_role)}) ·
    candidates: <strong>${candidate_count}</strong> ·
    best score: <strong>${best_score === null ? "?" : best_score.toFixed(2)}</strong> ·
    created: ${escapeHtml(created_at)}
    ${original_task ? `<br>original task: <code>${escapeHtml(original_task)}</code> (role=<code>${escapeHtml(original_role ?? "?")}</code>)` : ""}
  </div>

  <div class="candidates">
    ${candidates_html}
  </div>

  <form hx-post="/dashboard/approve" hx-target="next .response" hx-swap="innerHTML">
    <input type="hidden" name="result_id" value="${escapeHtml(result_id)}">
    <div class="row">
      <label>
        <strong>Confirm result_id</strong> (paste exactly to enable submit)
        <input type="text" name="confirm_id" placeholder="${escapeHtml(result_id)}" required autocomplete="off">
        <div class="help">Type-confirm prevents misclicks. Must match the result ID above exactly.</div>
      </label>
      <label>
        <strong>Picked candidate index</strong>
        <input type="number" name="picked_candidate_index" min="0" max="${candidate_count - 1}" required>
        <div class="help">Index of the candidate body you're promoting (0-based).</div>
      </label>
    </div>
    <label>
      <strong>Rationale</strong>
      <textarea name="rationale" rows="2" required placeholder="Why this candidate over the others?"></textarea>
    </label>
    <div class="checkbox">
      <input type="checkbox" id="auto-${escapeHtml(result_id)}" name="auto_reassign" checked>
      <label for="auto-${escapeHtml(result_id)}">
        <span class="tooltip" title="When checked: a retry task is enqueued to the original role (typically 'developer') so they re-validate the new version. Failures during retry will NOT auto-mutate again — they surface to you for review (retry-cap safeguard prevents infinite loops).">
          Auto-reassign retry to original role <small style="color:#94a3b8">(recommended; with retry-cap safeguard)</small>
        </span>
      </label>
    </div>
    <div class="actions">
      <button type="submit" class="approve">Approve & Promote</button>
    </div>
    <div class="response"></div>
  </form>

  <form hx-post="/dashboard/reject" hx-target="next .response" hx-swap="innerHTML" style="margin-top:8px">
    <input type="hidden" name="result_id" value="${escapeHtml(result_id)}">
    <div class="row">
      <label>
        <strong>Confirm result_id (for reject)</strong>
        <input type="text" name="confirm_id" placeholder="${escapeHtml(result_id)}" required autocomplete="off">
      </label>
      <label>
        <strong>Rejection rationale</strong>
        <input type="text" name="rationale" required placeholder="None of the candidates address the failure correctly">
      </label>
    </div>
    <div class="actions">
      <button type="submit" class="reject">Reject all candidates</button>
    </div>
    <div class="response"></div>
  </form>
</div>`;
}
