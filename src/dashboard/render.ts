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
/**
 * v0.19.0 Sprint 2.10 — render the skill-candidates panel fragment.
 * Pure HTML rendering; the API server fetches the rows.
 */
export interface SkillCandidateRow {
  candidate_id:        string;
  target_role:         string;
  rejection_count:     number;
  headline:            string;
  status:              string;
  created_at:          string;
  last_rejection_at:   string;
  proposed_skill_body: string | null;
  installed_skill_id:  string | null;
}

export function renderSkillCandidatesFragment(rows: SkillCandidateRow[]): string {
  if (rows.length === 0) {
    return `<p class="empty">No pending skill candidates. Rejections will queue here when ≥3 occur for a role with no governing skill.</p>`;
  }
  return rows.map((r) => {
    const headline = escapeHtml(r.headline);
    const role     = escapeHtml(r.target_role);
    const status   = escapeHtml(r.status);
    const candId   = escapeHtml(r.candidate_id);

    // v0.20.0 — actions vary by status
    let actionsHtml = "";
    if (r.status === "pending") {
      actionsHtml = `
        <button onclick="zcGenerateSkill('${candId}')" class="zc-btn zc-btn-primary">⚡ Generate skill body (LLM)</button>
        <button onclick="zcRejectCandidate('${candId}')" class="zc-btn zc-btn-danger">✗ Reject</button>
      `;
    } else if (r.status === "generating") {
      actionsHtml = `<small><em>⏳ Generating skill body via LLM... (refresh to update)</em></small>`;
    } else if (r.status === "ready") {
      actionsHtml = `
        <details><summary>📄 View proposed skill body</summary>
          <pre class="skill-candidate-body">${escapeHtml(r.proposed_skill_body ?? "")}</pre>
        </details>
        <button onclick="zcApproveCandidate('${candId}')" class="zc-btn zc-btn-primary">✓ Approve + install to skills/</button>
        <button onclick="zcGenerateSkill('${candId}')" class="zc-btn zc-btn-secondary">↻ Regenerate</button>
        <button onclick="zcRejectCandidate('${candId}')" class="zc-btn zc-btn-danger">✗ Reject</button>
      `;
    } else if (r.status === "approved") {
      actionsHtml = `<small>✓ Approved + installed${r.installed_skill_id ? ` as <code>${escapeHtml(r.installed_skill_id)}</code>` : ""}</small>`;
    } else if (r.status === "rejected") {
      actionsHtml = `<small>✗ Rejected by operator</small>`;
    } else if (r.status === "superseded") {
      actionsHtml = `<small>↻ Superseded (a matching skill was authored manually)</small>`;
    }

    return `
      <div class="skill-candidate" data-candidate-id="${candId}">
        <div class="skill-candidate-header">
          <span class="role-tag">${role}</span>
          <span class="skill-candidate-count">${r.rejection_count} rejections</span>
          <span class="skill-candidate-status ${status}">${status}</span>
        </div>
        <div class="skill-candidate-headline">${headline}</div>
        <div class="skill-candidate-meta">
          first observed: ${escapeHtml(r.created_at.slice(0, 19))} ·
          last rejection: ${escapeHtml(r.last_rejection_at.slice(0, 19))}
          ${r.installed_skill_id ? ` · installed as <code>${escapeHtml(r.installed_skill_id)}</code>` : ""}
        </div>
        <div class="skill-candidate-actions">
          ${actionsHtml}
        </div>
      </div>
    `;
  }).join("") + `
    <script>
      // v0.20.0 — skill candidate review actions
      window.zcGenerateSkill = async function(candId) {
        const btn = event.target; btn.disabled = true; btn.textContent = '⏳ Generating...';
        try {
          const r = await fetch('/dashboard/skill-candidates/' + candId + '/generate', { method: 'POST' });
          const j = await r.json();
          if (!j.ok) alert('Generation failed: ' + (j.error || 'unknown'));
          // Refresh panel
          if (window.htmx) window.htmx.trigger('#skill-candidates', 'load');
          else document.getElementById('skill-candidates')?.dispatchEvent(new Event('load'));
        } catch (e) { alert('Error: ' + e.message); btn.disabled = false; btn.textContent = '⚡ Generate skill body (LLM)'; }
      };
      window.zcApproveCandidate = async function(candId) {
        if (!confirm('Approve + write this skill to skills/ + auto-import?')) return;
        const r = await fetch('/dashboard/skill-candidates/' + candId + '/approve', { method: 'POST' });
        const j = await r.json();
        if (!j.ok) alert('Approval failed: ' + (j.error || 'unknown'));
        else alert('Approved! Written to ' + j.written_to);
        if (window.htmx) window.htmx.trigger('#skill-candidates', 'load');
      };
      window.zcRejectCandidate = async function(candId) {
        const notes = prompt('Why reject? (optional)') || '';
        const r = await fetch('/dashboard/skill-candidates/' + candId + '/reject', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes }),
        });
        const j = await r.json();
        if (!j.ok) alert('Reject failed: ' + (j.error || 'unknown'));
        if (window.htmx) window.htmx.trigger('#skill-candidates', 'load');
      };
    </script>`;
}

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
  .edit-btn, .polish-btn, .runs-btn, .security-btn {
    background: #1f2937; color: #cbd5e1; border: 1px solid #2a2f37;
    padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 0.85rem;
    margin-left: 4px;
  }
  .edit-btn:hover { background: #2a2f37; color: #38bdf8; }
  .polish-btn:hover { background: #2a2f37; color: #c4b5fd; }
  .runs-btn:hover { background: #2a2f37; color: #fbbf24; }
  .security-btn:hover { background: #2a2f37; color: #34d399; }
  .skill-actions { display: flex; gap: 4px; }
  .skill-edit-zone { margin-top: 8px; }
  /* v0.23.2 — polish preview / runs list / security scans */
  .polish-result { background: #0a0d12; border: 1px solid #2a2f37; border-radius: 4px; padding: 12px; margin-top: 8px; }
  /* v0.23.3 — no-change state: clearly distinct from the diff state, no Apply button at all */
  .polish-no-change { border-color: #1f3a3a; background: #061616; }
  .polish-no-change-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .polish-no-change-icon { color: #4ade80; font-size: 1.1rem; }
  .polish-no-change-body { font-size: 0.85rem; color: #94a3b8; margin-bottom: 8px; }
  .polish-current { font-size: 0.85rem; color: #cbd5e1; padding: 6px 8px; background: #0a0d12; border-radius: 3px; }
  .polish-col-new { border-color: #15803d; background: #052e16; }
  .apply-polish-btn-blocked { background: #450a0a !important; color: #fecaca !important; border-color: #7f1d1d !important; }
  /* v0.24.0 Phase 2 — marketplace pulls */
  .market-pull-actions { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .pull-marketplace-btn { background: #1e3a8a; color: #dbeafe; border: 1px solid #1e40af; padding: 8px 18px; border-radius: 5px; cursor: pointer; font-size: 0.9rem; font-weight: 500; }
  .pull-marketplace-btn:hover:not(:disabled) { background: #1e40af; }
  .pull-marketplace-btn:disabled { opacity: 0.6; cursor: progress; }
  .market-meta { font-size: 0.82rem; color: #94a3b8; }
  .market-summary { background: #0a0d12; border: 1px solid #2a2f37; border-radius: 4px; padding: 12px; margin-bottom: 12px; }
  .market-summary-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .market-summary-counts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .count { padding: 3px 10px; border-radius: 3px; font-size: 0.82rem; font-family: ui-monospace, monospace; }
  .count-added    { background: #052e16; color: #4ade80; }
  .count-rejlint  { background: #7f1d1d; color: #fecaca; }
  .count-rejscan  { background: #450a0a; color: #fecaca; }
  .count-already  { background: #1e3a8a; color: #93c5fd; }
  .count-stale    { background: #422006; color: #fbbf24; }
  .count-error    { background: #7f1d1d; color: #fecaca; }
  .count-total    { background: #1f2937; color: #cbd5e1; }
  .market-details-link { color: #38bdf8; font-size: 0.85rem; text-decoration: none; cursor: pointer; }
  .market-details-link:hover { text-decoration: underline; }
  .market-details-zone { margin-top: 8px; }
  .market-pulls-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 8px; }
  .market-pulls-table th { background: #1f2937; color: #94a3b8; padding: 6px 8px; text-align: left; font-weight: 500; }
  .market-pulls-table td { padding: 6px 8px; border-top: 1px solid #1f2937; color: #e6e8eb; vertical-align: top; }
  .market-pulls-table .pull-details-row { background: transparent; }
  .market-pulls-table .pull-details-row td { border-top: none; padding: 0; }
  .pull-details { background: #0a0d12; border: 1px solid #1f2937; border-radius: 4px; padding: 10px; margin: 4px 8px 12px 8px; }
  .pull-details-header { font-size: 0.85rem; color: #cbd5e1; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #1f2937; }
  .pull-details-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .pull-details-table th { background: #1f2937; color: #94a3b8; padding: 5px 8px; text-align: left; }
  .pull-details-table td { padding: 5px 8px; border-top: 1px solid #1f2937; }
  .pull-details-table tr.decision-added { background: rgba(74, 222, 128, 0.05); }
  .pull-details-table tr.decision-rejected-lint { background: rgba(248, 113, 113, 0.05); }
  .pull-details-table tr.decision-rejected-scan { background: rgba(248, 113, 113, 0.07); }
  .pull-details-table tr.decision-already-exists { background: rgba(147, 197, 253, 0.05); }
  .pull-details-table tr.decision-stale-version { background: rgba(251, 191, 36, 0.05); }
  .pull-details-table tr.decision-error { background: rgba(248, 113, 113, 0.10); }
  .pull-details-table .reason-cell { max-width: 360px; word-wrap: break-word; }
  .pull-details-btn { background: #1f2937; color: #cbd5e1; border: 1px solid #2a2f37; padding: 3px 10px; border-radius: 3px; cursor: pointer; font-size: 0.78rem; }
  .pull-details-btn:hover { background: #2a2f37; color: #38bdf8; }
  .badge.dim-badge { background: #374151; color: #9ca3af; }
  .polish-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .polish-meta { font-size: 0.8rem; color: #94a3b8; }
  .polish-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .polish-col { background: #0e1116; border: 1px solid #1f2937; border-radius: 4px; padding: 8px; }
  .polish-col-title { font-size: 0.78rem; color: #94a3b8; margin-bottom: 6px; }
  .polish-col-text { font-size: 0.9rem; color: #e6e8eb; line-height: 1.4; white-space: pre-wrap; }
  .polish-actions { margin-top: 10px; }
  .apply-polish-btn { background: #166534; color: #dcfce7; border: 1px solid #15803d; padding: 5px 14px; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
  .apply-polish-btn:hover:not(:disabled) { background: #15803d; }
  .apply-polish-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .lint-errors { margin-top: 8px; padding: 6px 8px; background: #450a0a; border-left: 3px solid #ef4444; border-radius: 0 4px 4px 0; }
  .lint-err { color: #fecaca; font-size: 0.85rem; }
  .lint-warns { margin-top: 8px; }
  .lint-warns summary { cursor: pointer; font-size: 0.85rem; color: #fbbf24; }
  .lint-warn { font-size: 0.82rem; color: #cbd5e1; padding-left: 16px; }
  .badge { padding: 2px 8px; border-radius: 3px; font-size: 0.75rem; font-weight: 600; }
  .badge.ok { background: #166534; color: #dcfce7; }
  .badge.err { background: #7f1d1d; color: #fecaca; }
  .runs-list, .scans-list { background: #0a0d12; border: 1px solid #2a2f37; border-radius: 4px; padding: 12px; margin-top: 8px; }
  .runs-header, .scans-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .runs-meta, .scans-meta { font-size: 0.78rem; color: #94a3b8; }
  .runs-table, .scans-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .runs-table th, .scans-table th { background: #1f2937; color: #94a3b8; padding: 6px 8px; text-align: left; font-weight: 500; }
  .runs-table td, .scans-table td { padding: 6px 8px; border-top: 1px solid #1f2937; color: #e6e8eb; }
  .runs-table .mono.small, .scans-table .mono.small { font-family: ui-monospace, monospace; font-size: 0.78rem; color: #94a3b8; }
  .star-btn { background: #1f2937; color: #fbbf24; border: 1px solid #2a2f37; padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 0.82rem; }
  .star-btn:hover { background: #2a2f37; }
  .star-btn.star-on { background: #422006; color: #fde047; border-color: #ca8a04; cursor: default; }
  .star-btn:disabled { opacity: 0.85; cursor: default; }
  .score { padding: 2px 6px; border-radius: 3px; font-family: ui-monospace, monospace; font-size: 0.82rem; }
  .score-high { background: #052e16; color: #4ade80; }
  .score-mid { background: #422006; color: #fbbf24; }
  .score-low { background: #450a0a; color: #f87171; }
  .badge-status { padding: 2px 8px; border-radius: 3px; font-size: 0.75rem; }
  .badge-status.succeeded { background: #052e16; color: #4ade80; }
  .badge-status.failed { background: #450a0a; color: #f87171; }
  .scan-fail { padding: 6px 8px; margin: 4px 0; border-radius: 3px; font-size: 0.82rem; }
  .scan-sev-block { background: #450a0a; border-left: 3px solid #ef4444; }
  .scan-sev-warn { background: #422006; border-left: 3px solid #fbbf24; }
  .scan-sev-tag { font-size: 0.7rem; background: #1f2937; padding: 1px 6px; border-radius: 2px; margin-left: 6px; color: #cbd5e1; }
  .scan-detail { font-family: ui-monospace, monospace; font-size: 0.78rem; color: #cbd5e1; margin-top: 4px; }
  .dim { color: #6b7280; }
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
  /* v0.19.0 — skill candidates panel */
  .skill-candidate { background: #0e1116; border: 1px solid #1f2937; border-radius: 4px; padding: 12px; margin-bottom: 8px; }
  .skill-candidate-header { display: flex; gap: 12px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
  .skill-candidate-count { background: #7f1d1d; color: #fecaca; padding: 2px 8px; border-radius: 12px; font-size: 0.78rem; font-weight: 600; }
  .skill-candidate-status { padding: 2px 8px; border-radius: 12px; font-size: 0.78rem; font-weight: 600; text-transform: uppercase; }
  .skill-candidate-status.pending   { background: #1f2937; color: #fbbf24; }
  .skill-candidate-status.generating{ background: #1e3a8a; color: #93c5fd; }
  .skill-candidate-status.ready     { background: #064e3b; color: #6ee7b7; }
  .skill-candidate-status.approved  { background: #064e3b; color: #d1fae5; }
  .skill-candidate-status.rejected  { background: #4c1d95; color: #ddd6fe; opacity: 0.7; }
  .skill-candidate-status.superseded{ background: #1f2937; color: #94a3b8; opacity: 0.6; }
  .skill-candidate-headline { color: #cbd5e1; font-size: 0.9rem; margin: 6px 0; line-height: 1.4; }
  .skill-candidate-meta { color: #6b7280; font-size: 0.78rem; }
  .skill-candidate-actions { margin-top: 8px; padding-top: 8px; border-top: 1px solid #1f2937; }
  .skill-candidate-actions small { color: #94a3b8; font-style: italic; }
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
  /* v0.22.6 — Skill-activity health banner (top of dashboard) */
  .skill-health-banner {
    padding: 10px 14px; border-radius: 6px; margin-bottom: 10px;
    font-size: 0.95rem; border-left: 4px solid;
  }
  .skill-health-banner-bad {
    background: #3f1d1d; color: #fecaca; border-left-color: #ef4444;
  }
  .skill-health-banner-warn {
    background: #3a2e0e; color: #fde68a; border-left-color: #f59e0b;
  }
  .skill-health-banner-ok {
    background: #0e2f1f; color: #d1fae5; border-left-color: #10b981;
  }
  .skill-health-banner code {
    background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 3px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85em;
  }
  .skill-health-row {
    display: flex; align-items: center; gap: 10px;
    padding: 6px 14px; font-size: 0.88rem;
    border-bottom: 1px solid #1f2937;
  }
  .skill-health-row:last-child { border-bottom: none; }
  .skill-health-row .skill-health-icon { width: 20px; font-weight: 700; font-size: 1rem; flex-shrink: 0; }
  .skill-health-row .skill-health-name { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 600; min-width: 180px; }
  .skill-health-row .skill-health-detail { color: #cbd5e1; flex: 1; }
  .skill-health-bad .skill-health-icon { color: #f87171; }
  .skill-health-warn .skill-health-icon { color: #fbbf24; }
  .skill-health-ok .skill-health-icon { color: #4ade80; }
  .skill-health-empty { color: #94a3b8; font-style: italic; padding: 8px 14px; }
  .skill-health-empty .skill-health-icon { margin-right: 8px; }
  /* v0.22.7 — Summarizer activity panel */
  .summarizer-stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px; margin-bottom: 14px;
  }
  .summarizer-stats .stat-tile {
    background: #0e1116; border: 1px solid #1f2937; border-radius: 6px;
    padding: 12px; text-align: center;
  }
  .summarizer-stats .stat-num {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 1.6rem; font-weight: 700; color: #4ade80; margin-bottom: 4px;
  }
  .summarizer-stats .stat-label { font-size: 0.78rem; color: #94a3b8; line-height: 1.3; }
  .summarizer-breakdown {
    background: #0a0d12; border: 1px solid #1f2937; border-radius: 4px;
    padding: 10px 12px; margin-bottom: 12px;
  }
  .summarizer-breakdown .breakdown-title {
    font-size: 0.85rem; color: #94a3b8; margin-bottom: 6px;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .summarizer-breakdown .breakdown-row {
    font-size: 0.9rem; color: #cbd5e1; padding: 3px 0;
  }
  .summarizer-breakdown .badge-source {
    display: inline-block; padding: 1px 8px; border-radius: 3px;
    font-size: 0.78rem; font-weight: 600; margin-right: 6px;
    font-family: ui-monospace, monospace;
  }
  .badge-source.semantic    { background: #064e3b; color: #d1fae5; }
  .badge-source.ast         { background: #1e3a8a; color: #dbeafe; }
  .badge-source.truncation  { background: #4a2e0e; color: #fde68a; }
  .badge-source.unknown     { background: #1f2937; color: #94a3b8; }
  .badge-status { display: inline-block; padding: 1px 8px; border-radius: 3px; font-size: 0.78rem; font-weight: 600; font-family: ui-monospace, monospace; }
  .badge-status.error    { background: #7f1d1d; color: #fecaca; }
  .badge-status.skipped  { background: #4a2e0e; color: #fde68a; }
  .badge-status.ok       { background: #064e3b; color: #d1fae5; }
  .badge-status.fallback_truncation { background: #4a2e0e; color: #fde68a; }
  .summarizer-empty { padding: 12px; }
  .summarizer-empty.muted { color: #94a3b8; font-style: italic; }
  .summarizer-list { margin: 12px 0; }
  .summarizer-list summary { font-size: 0.9rem; color: #cbd5e1; padding: 6px 0; cursor: pointer; }
  .summarizer-list summary:hover { color: #38bdf8; }
  .summarizer-table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 0.82rem; }
  .summarizer-table th { text-align: left; padding: 4px 8px; color: #94a3b8; font-weight: 500; border-bottom: 1px solid #1f2937; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .summarizer-table td { padding: 4px 8px; border-bottom: 1px solid #161b22; vertical-align: top; }
  .summarizer-table td.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .summarizer-table td.small { font-size: 0.78rem; color: #94a3b8; }
  .summarizer-table td.error-msg { font-family: ui-monospace, monospace; font-size: 0.78rem; color: #fecaca; max-width: 480px; word-break: break-word; }
  .muted { color: #94a3b8; font-size: 0.85rem; }
</style>
</head>
<body>
<header>
  <h1>SecureContext Operator Console</h1>
  <span id="badge" class="badge">…</span>
</header>
<main>

<!-- v0.22.6 — Skill-activity health banner. First panel so operators see
     immediately when the closed-loop self-improvement system has gone dark
     on any active project. Polls every 60s (lower frequency than other
     panels because it's a slow-moving signal). -->
<div class="panel">
  <h2>Skill-activity health <span style="font-size:0.85rem; font-weight:400; color:#94a3b8">(closed-loop status per active project, 24h window)</span></h2>
  <div id="skill-health"
       hx-get="/dashboard/skill-health"
       hx-trigger="load, every 60s"
       hx-target="this" hx-swap="innerHTML">
    Loading skill-activity health…
  </div>
</div>

<!-- v0.22.7 — Summarizer activity. Operator visibility into the L0/L1
     indexer: how many summaries exist, when they were created, what failed,
     which model is being used. Without this, the operator was blind to
     summarization activity and could only "hope it was working." -->
<div class="panel">
  <h2>Summarizer activity <span style="font-size:0.85rem; font-weight:400; color:#94a3b8">(L0/L1 file summary index — total + last 24h)</span></h2>
  <div class="savings-controls" style="margin-bottom:10px">
    <label>Project filter:
      <select id="summarizer-project" name="project"
              hx-get="/dashboard/summarizer-health"
              hx-trigger="change"
              hx-target="#summarizer-health"
              hx-swap="innerHTML">
        <option value="">— all projects —</option>
      </select>
    </label>
  </div>
  <div id="summarizer-health"
       hx-get="/dashboard/summarizer-health"
       hx-trigger="load, every 60s[!document.querySelector('#summarizer-health input:focus, #summarizer-health select:focus, #summarizer-health details[open] table')]"
       hx-target="this" hx-swap="innerHTML">
    Loading summarizer activity…
  </div>
  <script>
    // Lazy-populate project filter (reuses the savings projects endpoint —
    // it returns the same set of projects with activity).
    (async function loadSummarizerProjects() {
      try {
        const r = await fetch('/dashboard/savings/projects', { cache: 'no-store' });
        const html = await r.text();
        const sel = document.getElementById('summarizer-project');
        if (sel && sel.options.length <= 1) {
          sel.innerHTML = '<option value="">— all projects —</option>' + html;
        }
      } catch { /* tolerate */ }
    })();
  </script>
</div>

<div class="panel">
  <h2>Pending mutation reviews</h2>
  <!-- v0.20.1 — skip poll when any input/textarea/select inside the panel has
       focus, OR when an .approve-form / .reject-form is currently open.
       Without this, every 10s the innerHTML swap wiped the operator's typed
       confirmation text. Filter syntax: hx-trigger="every Ns[<JS truthy>]"
       — true means "go ahead and trigger", false means "skip this fire". -->
  <div id="pending"
       hx-get="/dashboard/pending"
       hx-trigger="load, every 10s[!document.querySelector('#pending input:focus, #pending textarea:focus, #pending select:focus, #pending details[open]')]"
       hx-target="this" hx-swap="innerHTML">
    Loading…
  </div>
</div>

<div class="panel">
  <h2>Active skills <span style="font-size:0.85rem; font-weight:400; color:#94a3b8">(edit frontmatter — body is mutator-managed)</span></h2>
  <div id="skills"
       hx-get="/dashboard/skills"
       hx-trigger="load, every 30s[!document.querySelector('#skills input:focus, #skills textarea:focus, #skills select:focus, #skills details[open], #skills .skill-edit-zone:not(:empty)')]"
       hx-target="this" hx-swap="innerHTML">
    Loading…
  </div>
</div>

<!-- v0.24.0 Phase 2 — marketplace pulls panel -->
<div class="panel">
  <h2>Marketplace pulls <span style="font-size:0.85rem; font-weight:400; color:#94a3b8">(historic skill imports from anthropics/skills + others — see what was added vs rejected, with reasons)</span></h2>
  <div class="market-pull-actions">
    <button class="pull-marketplace-btn"
            hx-post="/dashboard/marketplace/pull"
            hx-target="#market-summary" hx-swap="innerHTML"
            hx-on:htmx:before-request="this.disabled=true; this.textContent='Pulling… (may take 30-60s)'"
            hx-on:htmx:after-request="this.disabled=false; this.textContent='🛒 Pull from anthropics/skills'; htmx.trigger('#market-pulls-list', 'refresh')">
      🛒 Pull from anthropics/skills
    </button>
    <span class="market-meta">Walks repo tree, runs lint + 8-point scan on each SKILL.md, upserts only those that pass. Every attempt logged.</span>
  </div>
  <div id="market-summary"></div>
  <div id="market-pulls-list"
       hx-get="/dashboard/marketplace/pulls"
       hx-trigger="load, refresh from:body, every 60s[!document.querySelector('#market-pulls-list .pull-row-expanded')]"
       hx-target="this" hx-swap="innerHTML">
    Loading historic pulls…
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
    // Lazy-load project options on first render + periodically re-fetch so new
    // projects appear without a manual page refresh. Preserves the user's
    // selection across re-fetches. v0.22.1 fix: previously the dropdown was
    // populated once at page load and stayed stale forever — discovered live
    // when A2A_communication started writing tool_calls but dashboard kept
    // showing only Test_Agent_Coordination + Test_Project_B.
    async function loadSavingsProjects() {
      try {
        const r = await fetch('/dashboard/savings/projects', { cache: 'no-store' });
        const html = await r.text();
        const sel = document.getElementById('savings-project');
        if (!sel) return;
        const prevValue = sel.value;
        const prevFocused = (document.activeElement === sel);
        const newInner = '<option value="">— pick a project —</option>' + html;
        if (sel.innerHTML !== newInner) {
          sel.innerHTML = newInner;
          if (prevValue) {
            const opt = Array.from(sel.options).find(o => o.value === prevValue);
            if (opt) sel.value = prevValue;
          }
        }
      } catch (e) { /* swallow */ }
    }
    loadSavingsProjects();
    setInterval(loadSavingsProjects, 30_000);
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
    // v0.18.9 — auto-refresh every 10s while a project is selected.
    // Originally tried htmx.trigger(sel, 'change') but HTMX dedupes when
    // the request URL is unchanged from the last call — so polling the same
    // project produced zero re-fetches. Switched to htmx.ajax() with explicit
    // values, which always issues a fresh GET. Refreshes BOTH the savings
    // panel (HTMX swap) and the trend panel (manual fetch since it's a
    // separate JS-driven widget).
    setInterval(async () => {
      const proj = document.getElementById('savings-project')?.value;
      if (!proj) return;
      const win  = document.querySelector('select[name="window"]')?.value || '7d';
      // 1) Refresh main savings panel
      if (window.htmx) {
        window.htmx.ajax('GET', '/dashboard/savings', {
          target: '#savings-panel',
          swap: 'innerHTML',
          values: { project: proj, window: win },
        });
      }
      // 2) Refresh trend / per-agent / anti-pattern panel
      const cad = document.getElementById('savings-trend-cadence')?.value || 'daily';
      const trendDiv = document.getElementById('savings-trend');
      if (trendDiv) {
        try {
          const r = await fetch(\`/dashboard/savings/trend?project=\${encodeURIComponent(proj)}&cadence=\${cad}\`, { cache: 'no-store' });
          trendDiv.innerHTML = await r.text();
        } catch (err) { /* keep last view, don't blank */ }
      }
      // 3) Refresh project dropdown counts (so "(N calls)" reflects fresh data)
      try {
        const r = await fetch('/dashboard/savings/projects', { cache: 'no-store' });
        const html = await r.text();
        const sel = document.getElementById('savings-project');
        if (sel) {
          const currentValue = sel.value;
          sel.innerHTML = '<option value="">— pick a project —</option>' + html;
          sel.value = currentValue;
        }
      } catch (err) { /* keep last view */ }
    }, 10000);
  </script>
</div>

<!-- v0.19.0 Sprint 2.10 — Skill candidates panel (REJECT clusters → propose new skill) -->
<div class="panel">
  <h2>Skill candidates <span style="font-size:0.85rem; font-weight:400; color:#94a3b8">(from REJECT patterns where the role has no governing skill)</span></h2>
  <!-- v0.20.1 — same focus-aware filter as #pending; don't blow away an
       operator who's mid-edit on the proposed skill body or notes. -->
  <div id="skill-candidates"
       hx-get="/dashboard/skill-candidates"
       hx-trigger="load, every 30s[!document.querySelector('#skill-candidates input:focus, #skill-candidates textarea:focus, #skill-candidates select:focus, #skill-candidates details[open]')]"
       hx-swap="innerHTML">
    <p class="empty">Loading skill candidates…</p>
  </div>
</div>

<footer>
  v0.20.0 — local operator console, embedded in <code>zc-ctx-api</code> at <code>:3099/dashboard</code>.
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
      // v0.23.3: when avg_tokens rounds to 0, the agent didn't report
      // total_tokens on zc_record_skill_outcome (Claude Code agents don't
      // have token introspection — they pass 0). Showing "0 tokens/run"
      // looks like a bug; show "not reported" instead with a tooltip
      // explaining the protocol gap. Real numbers display normally.
      const avgTokensRounded = eff ? Math.round(eff.avg_tokens) : 0;
      const effHtml = !eff
        ? `<span class="skill-eff skill-eff-none" title="Insufficient data (need ≥3 runs in last 30 days)">avg cost: <em>n/a</em></span>`
        : avgTokensRounded === 0
          ? `<span class="skill-eff skill-eff-none" title="Agent passed total_tokens=0 on zc_record_skill_outcome. Claude Code agents don't have token introspection — this is a known protocol gap. ${eff.run_count} runs in last 30 days.">avg cost: <em>not reported</em> · ${eff.run_count} runs</span>`
          : `<span class="skill-eff" title="Average across ${eff.run_count} runs in last 30 days">avg cost: <strong>${avgTokensRounded.toLocaleString()}</strong> tokens/run · ${eff.run_count} runs</span>`;
      return `
        <div class="skill-row" data-skill-id="${escapeHtml(s.skill_id)}">
          <div class="skill-header">
            <span class="skill-name">${escapeHtml(s.name)} <span style="color:#94a3b8">v${escapeHtml(s.version)}</span></span>
            <span class="skill-actions">
              <button class="edit-btn"
                      hx-get="/dashboard/skills/edit?skill_id=${encodeURIComponent(s.skill_id)}"
                      hx-target="next .skill-edit-zone" hx-swap="innerHTML">
                Edit frontmatter
              </button>
              <button class="polish-btn"
                      title="v0.23.0 Phase 1 #2 — let the polisher refine this skill's description"
                      hx-post="/dashboard/skills/${encodeURIComponent(s.skill_id)}/polish/html"
                      hx-target="next .skill-edit-zone" hx-swap="innerHTML"
                      hx-on:htmx:before-request="this.disabled=true; this.textContent='Polishing…'"
                      hx-on:htmx:after-request="this.disabled=false; this.textContent='✨ Polish'">
                ✨ Polish
              </button>
              <button class="runs-btn"
                      title="View recent skill runs and tag exemplars"
                      hx-get="/dashboard/skills/${encodeURIComponent(s.skill_id)}/runs"
                      hx-target="next .skill-edit-zone" hx-swap="innerHTML">
                Recent runs
              </button>
              <button class="security-btn"
                      title="View security scan history"
                      hx-get="/dashboard/skills/${encodeURIComponent(s.skill_id)}/security"
                      hx-target="next .skill-edit-zone" hx-swap="innerHTML">
                🛡 Security
              </button>
            </span>
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

// ─── v0.22.6 — Skill-activity health banner ─────────────────────────────────
//
// Catches the failure mode that hid for 7+ days on A2A_communication: agents
// are active (broadcasting ASSIGN/MERGE) but recording zero skill outcomes.
// This means the closed-loop self-improvement system is silently broken on
// that project — usually because the agents' system prompts are missing the
// v0.21.0 enforcement levers (e.g. spawn-agent.ps1 wasn't patched, env-var
// propagation gap, etc.). Hard to spot from any other panel; deserves a
// first-class indicator.
//
// Renders red/yellow/green status PER active project. "Active" = ≥3
// broadcasts in the last 24 hours. Quiet projects don't trigger the alert
// (no work happening means nothing to skill-record about).

export interface SkillHealthRow {
  project_hash: string;
  project_name: string | null;
  broadcasts_24h: number;
  skill_runs_24h: number;
  skill_show_calls_24h: number;
  outcome_calls_24h: number;
  unique_agents: number;
  last_broadcast_at: string;
}

export function renderSkillHealthFragment(rows: SkillHealthRow[]): string {
  if (rows.length === 0) {
    return `<div class="skill-health-empty">
      <span class="skill-health-icon">○</span>
      No projects with active broadcasts in the last 24 hours.
    </div>`;
  }

  const unhealthy = rows.filter((r) => r.skill_runs_24h === 0);
  const partial   = rows.filter((r) => r.skill_runs_24h > 0 && r.skill_show_calls_24h === 0);
  const healthy   = rows.filter((r) => r.skill_runs_24h > 0 && r.skill_show_calls_24h > 0);

  const renderProjectRow = (r: SkillHealthRow, severity: "bad" | "warn" | "ok"): string => {
    const name = r.project_name ?? r.project_hash.slice(0, 12);
    const icon = severity === "bad" ? "✗" : severity === "warn" ? "⚠" : "✓";
    const detail = severity === "bad"
      ? `${r.broadcasts_24h} broadcasts but 0 skill outcomes — closed-loop improvement is BROKEN here`
      : severity === "warn"
        ? `${r.skill_runs_24h} outcomes recorded but 0 zc_skill_show calls — agents are scoring skills they didn't load`
        : `${r.skill_runs_24h} skill_runs · ${r.skill_show_calls_24h} skill_show · ${r.unique_agents} agent(s)`;
    return `<div class="skill-health-row skill-health-${severity}">
      <span class="skill-health-icon">${icon}</span>
      <span class="skill-health-name" title="project_hash=${r.project_hash}">${escapeHtml(name)}</span>
      <span class="skill-health-detail">${escapeHtml(detail)}</span>
    </div>`;
  };

  const lines: string[] = [];

  // Banner header summarizing overall state
  if (unhealthy.length > 0) {
    lines.push(`<div class="skill-health-banner skill-health-banner-bad">
      <strong>${unhealthy.length} project${unhealthy.length === 1 ? "" : "s"} active without skill outcomes</strong>
      — the self-improvement loop is dormant for these projects. Likely fix:
      respawn agents to pick up the latest spawn-agent.ps1 (skill enforcement
      levers must be in their system prompts). See SecureContext v0.22.5+.
    </div>`);
  } else if (partial.length > 0) {
    lines.push(`<div class="skill-health-banner skill-health-banner-warn">
      <strong>${partial.length} project${partial.length === 1 ? "" : "s"} recording outcomes without loading skill bodies</strong>
      — agents are scoring skills they never read. The pre-task
      <code>zc_skill_show</code> mandate may not be firing.
    </div>`);
  } else {
    lines.push(`<div class="skill-health-banner skill-health-banner-ok">
      <strong>All ${healthy.length} active project${healthy.length === 1 ? " is" : "s are"} healthy.</strong>
      Each is loading skills before work and recording outcomes at MERGE.
    </div>`);
  }

  // Per-project detail rows
  for (const r of unhealthy) lines.push(renderProjectRow(r, "bad"));
  for (const r of partial)   lines.push(renderProjectRow(r, "warn"));
  for (const r of healthy)   lines.push(renderProjectRow(r, "ok"));

  return lines.join("\n");
}

// ─── v0.22.7 — Summarizer activity panel ─────────────────────────────────────
//
// Operator was completely blind to the summarizer (the LLM that generates
// L0/L1 file summaries on demand): when did it run, which model did it use,
// what failed, how many summaries are currently indexed. With 977 summaries
// in the SQLite DB but only 33 in PG source_meta, the operator literally
// could not see most of the indexing activity. This panel surfaces it.
//
// Renders three subsections:
//   1. Headline: total file summaries currently indexed
//   2. Last 24h activity grouped by status × source (ast / semantic /
//      truncation, ok / fallback_truncation / error / skipped)
//   3. Recent successes + recent failures (with full error messages)

export interface SummarizerHealthData {
  total_file_summaries: number;          // file: rows in PG source_meta (authoritative since v0.22.8 dual-write + backfill)
  distinct_summarized_v0227?: number;    // distinct sources in summarizer_events_pg since v0.22.7 (telemetry-tracked subset)
  events_24h: Array<{
    status:         string;
    summary_source: string;
    count:          number;
    avg_duration_ms: number;
  }>;
  recent_success:  Array<Record<string, unknown>>;
  recent_failures: Array<Record<string, unknown>>;
}

export function renderSummarizerHealthFragment(
  data: SummarizerHealthData,
  nameMap: Map<string, string>,
  projectFilter: string | null,
): string {
  const ev = data.events_24h;
  const totalEvents = ev.reduce((a, e) => a + e.count, 0);
  const successCount =
    ev.filter((e) => e.status === "ok" || e.status === "fallback_truncation")
      .reduce((a, e) => a + e.count, 0);
  const errorCount = ev.filter((e) => e.status === "error" || e.status === "skipped")
    .reduce((a, e) => a + e.count, 0);
  const semanticCount = ev.filter((e) => e.summary_source === "semantic")
    .reduce((a, e) => a + e.count, 0);
  const astCount = ev.filter((e) => e.summary_source === "ast")
    .reduce((a, e) => a + e.count, 0);
  const truncCount = ev.filter((e) => e.summary_source === "truncation")
    .reduce((a, e) => a + e.count, 0);

  const projectScopeLabel = projectFilter
    ? (nameMap.get(projectFilter) ?? `project:${projectFilter.slice(0, 8)}…`)
    : "all projects";

  const v0227Tracked = data.distinct_summarized_v0227 ?? 0;
  const headline = `<div class="summarizer-stats">
    <div class="stat-tile" title="Authoritative count from PG source_meta. Since v0.22.8 every file summary the agent creates is dual-written to PG + SQLite. Pre-v0.22.8 summaries were backfilled by scripts/backfill-source-meta-to-pg.mjs.">
      <div class="stat-num">${fmt(data.total_file_summaries)}</div>
      <div class="stat-label">file summaries indexed (PG source_meta)<br><span style="font-size:0.78rem; color:#94a3b8">${escapeHtml(projectScopeLabel)}</span></div>
    </div>
    <div class="stat-tile" title="Subset of the above: distinct files summarized since v0.22.7 telemetry started. Useful for 'how active was the indexer recently'.">
      <div class="stat-num" style="color:#a78bfa">${fmt(v0227Tracked)}</div>
      <div class="stat-label">summarized since v0.22.7 (telemetry)</div>
    </div>
    <div class="stat-tile">
      <div class="stat-num" style="color:${errorCount > 0 ? "#fbbf24" : "#4ade80"}">${fmt(successCount)}</div>
      <div class="stat-label">successful events (24h)</div>
    </div>
    <div class="stat-tile">
      <div class="stat-num" style="color:${errorCount > 0 ? "#f87171" : "#94a3b8"}">${fmt(errorCount)}</div>
      <div class="stat-label">failures + skipped (24h)</div>
    </div>
  </div>
  <div class="muted" style="margin-bottom:12px; font-size:0.82rem">
    File summaries live in PG (<code>source_meta</code>) and mirror to each agent's local SQLite
    (<code>~/.claude/zc-ctx/sessions/{project_hash}.db</code>) — both backends stay in sync via the
    v0.22.8 dual-write. Reads prefer PG. <strong>${fmt(totalEvents)}</strong> summarizer events fired
    in the last 24h.
  </div>`;

  let breakdown = "";
  if (totalEvents > 0) {
    breakdown = `<div class="summarizer-breakdown">
      <div class="breakdown-title">Source mix (last 24h)</div>
      <div class="breakdown-row"><span class="badge-source semantic">semantic LLM</span> ${fmt(semanticCount)} files</div>
      <div class="breakdown-row"><span class="badge-source ast">AST extracted</span> ${fmt(astCount)} files</div>
      <div class="breakdown-row"><span class="badge-source truncation">truncation fallback</span> ${fmt(truncCount)} files ${
        truncCount > 0 ? `<span class="muted">— Ollama unreachable or output malformed</span>` : ""
      }</div>
    </div>`;
  } else {
    breakdown = `<div class="summarizer-empty muted">No summarizer events recorded in the last 24 hours.${
      data.total_file_summaries === 0
        ? ` (No file summaries are indexed yet for this project — agents will index lazily on first <code>zc_file_summary</code> call.)`
        : ""
    }</div>`;
  }

  let recent = "";
  if (data.recent_success.length > 0) {
    const rows = data.recent_success.map((r) => {
      const ph = String(r["project_hash"] ?? "");
      const projName = ph ? (nameMap.get(ph) ?? null) : null;
      const tsStr = (r["ts"] instanceof Date) ? (r["ts"] as Date).toISOString() : String(r["ts"] ?? "");
      const when = tsStr.slice(11, 19); // HH:MM:SS
      const date = tsStr.slice(0, 10);
      return `<tr>
        <td class="mono">${escapeHtml(when)}</td>
        <td class="mono small">${escapeHtml(date)}</td>
        <td class="mono">${escapeHtml(String(r["source"] ?? "").slice(0, 60))}</td>
        <td><span class="badge-source ${escapeHtml(String(r["summary_source"] ?? ""))}">${escapeHtml(String(r["summary_source"] ?? ""))}</span></td>
        <td class="mono small">${escapeHtml(String(r["model"] ?? "—"))}</td>
        <td class="mono small">${fmt(Number(r["duration_ms"] ?? 0))}ms</td>
        <td class="mono small">${escapeHtml(String(r["agent_id"] ?? "default"))}</td>
        ${!projectFilter ? `<td class="mono small">${escapeHtml(projName ?? ph.slice(0, 8) + "…")}</td>` : ""}
      </tr>`;
    }).join("");
    recent = `<details class="summarizer-list" open>
      <summary>Recent summaries (last ${data.recent_success.length})</summary>
      <table class="summarizer-table">
        <thead><tr><th>Time</th><th>Date</th><th>File</th><th>Source</th><th>Model</th><th>Duration</th><th>Agent</th>${!projectFilter ? "<th>Project</th>" : ""}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
  }

  let failures = "";
  if (data.recent_failures.length > 0) {
    const rows = data.recent_failures.map((r) => {
      const ph = String(r["project_hash"] ?? "");
      const projName = ph ? (nameMap.get(ph) ?? null) : null;
      const tsStr = (r["ts"] instanceof Date) ? (r["ts"] as Date).toISOString() : String(r["ts"] ?? "");
      const when = tsStr.slice(0, 19).replace("T", " ");
      return `<tr>
        <td class="mono small">${escapeHtml(when)}</td>
        <td class="mono">${escapeHtml(String(r["source"] ?? "").slice(0, 60))}</td>
        <td><span class="badge-status ${escapeHtml(String(r["status"] ?? ""))}">${escapeHtml(String(r["status"] ?? ""))}</span></td>
        <td class="error-msg">${escapeHtml(String(r["error_message"] ?? "").slice(0, 240))}</td>
        ${!projectFilter ? `<td class="mono small">${escapeHtml(projName ?? ph.slice(0, 8) + "…")}</td>` : ""}
      </tr>`;
    }).join("");
    failures = `<details class="summarizer-list summarizer-failures" open>
      <summary>Recent failures (last ${data.recent_failures.length})</summary>
      <table class="summarizer-table">
        <thead><tr><th>Time</th><th>File</th><th>Status</th><th>Error</th>${!projectFilter ? "<th>Project</th>" : ""}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
  }

  return headline + breakdown + recent + failures;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

// ─── v0.23.2 — Phase 1 dashboard surfaces ───────────────────────────────────
// Three HTML fragments rendered inline on the skills list, swapped into the
// .skill-edit-zone div by HTMX:
//   1. polish preview (after ✨ Polish click) — shows original + polished + Apply button
//   2. recent runs list (after Recent runs click) — each row has ⭐ button to tag exemplar
//   3. security scan history (after 🛡 Security click) — table of scans with status

export interface PolishResultRow {
  skill_id:        string;
  original:        string;
  polished:        string;
  lint_passed:     boolean;
  lint_warnings:   string[];
  lint_errors:     string[];
  backend:         string;
  duration_ms:     number;
}

export function renderPolishPreview(r: PolishResultRow): string {
  const sameText = r.original === r.polished;
  // v0.23.3: when polished == original, we render a compact "no improvements
  // needed" panel instead of the side-by-side diff with a disabled Apply
  // button. Showing a green Apply button that does nothing — even when
  // technically disabled — confused users (the disabled CSS opacity:0.5
  // wasn't visually obvious enough).
  if (sameText) {
    const warnsLine = r.lint_warnings.length > 0
      ? `<details class="lint-warns" style="margin-top:8px"><summary>${r.lint_warnings.length} lint warning(s) on this description</summary>${r.lint_warnings.map((w) => `<div class="lint-warn">${escapeHtml(w)}</div>`).join("")}</details>`
      : "";
    return `
      <div class="polish-result polish-no-change">
        <div class="polish-no-change-header">
          <span class="polish-no-change-icon">✓</span>
          <strong>No improvements suggested</strong>
          <span class="polish-meta">backend: <code>${escapeHtml(r.backend)}</code> · ${r.duration_ms}ms</span>
        </div>
        <div class="polish-no-change-body">
          The polisher returned the same description unchanged. The current
          description already meets the lint bar; no rephrase needed.
        </div>
        <div class="polish-current">Current: <em>${escapeHtml(r.original)}</em></div>
        ${warnsLine}
      </div>
    `;
  }

  const lintBadge = r.lint_passed
    ? `<span class="badge ok">lint OK</span>`
    : `<span class="badge err">lint FAILED — apply blocked</span>`;
  const errs = r.lint_errors.length > 0
    ? `<div class="lint-errors">${r.lint_errors.map((e) => `<div class="lint-err">⚠ ${escapeHtml(e)}</div>`).join("")}</div>`
    : "";
  const warns = r.lint_warnings.length > 0
    ? `<details class="lint-warns"><summary>${r.lint_warnings.length} warning(s)</summary>${r.lint_warnings.map((w) => `<div class="lint-warn">${escapeHtml(w)}</div>`).join("")}</details>`
    : "";
  const applyBtn = r.lint_passed
    ? `<button class="apply-polish-btn"
              hx-post="/dashboard/skills/${encodeURIComponent(r.skill_id)}/apply-polish"
              hx-vals='{"description":${JSON.stringify(r.polished)}}'
              hx-headers='{"Content-Type":"application/json"}'
              hx-ext="json-enc"
              hx-target="closest .skill-edit-zone"
              hx-swap="innerHTML"
              hx-on:htmx:after-request="this.disabled=true; this.textContent='Applied — reload to refresh'">
        Apply polish
      </button>`
    : `<button class="apply-polish-btn apply-polish-btn-blocked" disabled title="lint failed — fix lint errors first">
        ✗ Apply blocked (lint failed)
      </button>`;

  return `
    <div class="polish-result">
      <div class="polish-header">
        <strong>Polish suggestion</strong>
        <span class="polish-meta">backend: <code>${escapeHtml(r.backend)}</code> · ${r.duration_ms}ms · ${lintBadge}</span>
      </div>
      <div class="polish-grid">
        <div class="polish-col">
          <div class="polish-col-title">Original</div>
          <div class="polish-col-text">${escapeHtml(r.original)}</div>
        </div>
        <div class="polish-col polish-col-new">
          <div class="polish-col-title">Polished</div>
          <div class="polish-col-text">${escapeHtml(r.polished)}</div>
        </div>
      </div>
      ${errs}
      ${warns}
      <div class="polish-actions">${applyBtn}</div>
    </div>
  `;
}

export interface SkillRunRow {
  run_id:        string;
  skill_id:      string;
  status:        string;
  outcome_score: number | null;
  ts:            string;
  agent_id:      string | null;
  is_exemplar:   boolean;
  exemplar_note: string | null;
}

export function renderSkillRunsFragment(skillId: string, rows: SkillRunRow[]): string {
  if (rows.length === 0) {
    return `<div class="runs-list-empty">No runs recorded yet for <code>${escapeHtml(skillId)}</code>.</div>`;
  }
  const trs = rows.map((r) => {
    const score = r.outcome_score === null
      ? `<span class="dim">—</span>`
      : `<span class="score score-${r.outcome_score >= 0.8 ? "high" : r.outcome_score >= 0.5 ? "mid" : "low"}">${r.outcome_score.toFixed(2)}</span>`;
    const star = r.is_exemplar
      ? `<button class="star-btn star-on" disabled title="Already tagged as exemplar${r.exemplar_note ? ': ' + r.exemplar_note : ''}">★ Exemplar</button>`
      : `<button class="star-btn"
                title="Tag as operator exemplar — flows into mutator proposer prompt"
                hx-post="/dashboard/skill-runs/${encodeURIComponent(r.run_id)}/tag-exemplar/html"
                hx-target="closest tr" hx-swap="outerHTML"
                hx-prompt="Optional note for this exemplar (what makes it good?)">
          ☆ Tag exemplar
        </button>`;
    const when = r.ts.slice(0, 19).replace("T", " ");
    return `
      <tr data-run-id="${escapeHtml(r.run_id)}">
        <td class="mono small">${escapeHtml(when)}</td>
        <td><span class="badge-status ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
        <td>${score}</td>
        <td class="mono small">${escapeHtml(r.agent_id ?? "—")}</td>
        <td class="mono small">${escapeHtml(r.run_id.slice(0, 16))}…</td>
        <td>${star}</td>
      </tr>
    `;
  }).join("");
  return `
    <div class="runs-list">
      <div class="runs-header">
        <strong>Recent runs</strong>
        <span class="runs-meta">tag a run as ★ exemplar — it flows into the mutator's proposer prompt as positive training signal</span>
      </div>
      <table class="runs-table">
        <thead><tr><th>When</th><th>Status</th><th>Score</th><th>Agent</th><th>Run ID</th><th></th></tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>
  `;
}

export function renderSkillRunRow(r: SkillRunRow): string {
  // Renders a SINGLE <tr> — used as the swap target after tagging an exemplar.
  const score = r.outcome_score === null
    ? `<span class="dim">—</span>`
    : `<span class="score score-${r.outcome_score >= 0.8 ? "high" : r.outcome_score >= 0.5 ? "mid" : "low"}">${r.outcome_score.toFixed(2)}</span>`;
  const star = r.is_exemplar
    ? `<button class="star-btn star-on" disabled title="Tagged${r.exemplar_note ? ': ' + r.exemplar_note : ''}">★ Exemplar</button>`
    : `<button class="star-btn"
              hx-post="/dashboard/skill-runs/${encodeURIComponent(r.run_id)}/tag-exemplar/html"
              hx-target="closest tr" hx-swap="outerHTML"
              hx-prompt="Optional note for this exemplar (what makes it good?)">
        ☆ Tag exemplar
      </button>`;
  const when = r.ts.slice(0, 19).replace("T", " ");
  return `<tr data-run-id="${escapeHtml(r.run_id)}">
    <td class="mono small">${escapeHtml(when)}</td>
    <td><span class="badge-status ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
    <td>${score}</td>
    <td class="mono small">${escapeHtml(r.agent_id ?? "—")}</td>
    <td class="mono small">${escapeHtml(r.run_id.slice(0, 16))}…</td>
    <td>${star}</td>
  </tr>`;
}

export interface SecurityScanRow {
  scanned_at:   string;
  score:        number;
  passed:       boolean;
  source:       string;
  failures:     Array<{ name: string; severity: string; detail: string | null }>;
}

// v0.24.0 Phase 2 — marketplace pull rendering
export interface MarketplacePullSummaryRow {
  pull_id:        string;
  source:         string;
  source_commit:  string;
  total:          number;
  added:          number;
  rejected_lint:  number;
  rejected_scan:  number;
  already_exists: number;
  stale_version:  number;
  errors:         number;
  duration_ms:    number;
}

export function renderMarketplacePullSummary(s: MarketplacePullSummaryRow): string {
  const verdict = s.added > 0
    ? `<span class="badge ok">${s.added} added</span>`
    : `<span class="badge dim-badge">0 added</span>`;
  return `
    <div class="market-summary">
      <div class="market-summary-header">
        <strong>Pull complete</strong>
        ${verdict}
        <span class="polish-meta">source: <code>${escapeHtml(s.source)}</code> @ <code>${escapeHtml(s.source_commit.slice(0, 8))}</code> · ${s.duration_ms}ms · <code>pull_id ${escapeHtml(s.pull_id.slice(0, 8))}…</code></span>
      </div>
      <div class="market-summary-counts">
        <span class="count count-added">${s.added} added</span>
        <span class="count count-already">${s.already_exists} already exists</span>
        <span class="count count-stale">${s.stale_version} stale</span>
        <span class="count count-rejlint">${s.rejected_lint} rejected (lint)</span>
        <span class="count count-rejscan">${s.rejected_scan} rejected (scan)</span>
        <span class="count count-error">${s.errors} errors</span>
        <span class="count count-total">${s.total} total</span>
      </div>
      <a href="#" class="market-details-link"
         hx-get="/dashboard/marketplace/pulls/${encodeURIComponent(s.pull_id)}"
         hx-target="next .market-details-zone" hx-swap="innerHTML">View per-skill verdicts →</a>
      <div class="market-details-zone"></div>
    </div>
  `;
}

export interface MarketplacePullsListRow {
  pull_id:        string;
  source:         string;
  source_commit:  string;
  pulled_at:      string;
  pulled_by:      string;
  total:          number;
  added:          number;
  rejected_lint:  number;
  rejected_scan:  number;
  already_exists: number;
  stale_version:  number;
  errors:         number;
}

export function renderMarketplacePullsList(rows: MarketplacePullsListRow[]): string {
  if (rows.length === 0) {
    return `<p class="empty">No marketplace pulls recorded yet. Click the 🛒 button above to import skills from anthropics/skills.</p>`;
  }
  const trs = rows.map((r) => {
    const when = r.pulled_at.slice(0, 19).replace("T", " ");
    const totalRejected = r.rejected_lint + r.rejected_scan;
    const verdictBadge = r.errors > 0
      ? `<span class="badge err">errors</span>`
      : (r.added > 0 ? `<span class="badge ok">+${r.added}</span>` : `<span class="badge dim-badge">no-op</span>`);
    return `
      <tr class="pull-row" data-pull-id="${escapeHtml(r.pull_id)}">
        <td class="mono small">${escapeHtml(when)}</td>
        <td>${verdictBadge}</td>
        <td><code>${escapeHtml(r.source)}</code><br><span class="mono small">@${escapeHtml(r.source_commit.slice(0, 8))}</span></td>
        <td class="mono small">${r.total} skills</td>
        <td>
          <span class="count count-added">+${r.added}</span>
          ${r.already_exists > 0 ? `<span class="count count-already">${r.already_exists}↻</span>` : ""}
          ${totalRejected > 0 ? `<span class="count count-rejlint">${totalRejected}✗</span>` : ""}
          ${r.errors > 0 ? `<span class="count count-error">${r.errors}!</span>` : ""}
        </td>
        <td>
          <button class="pull-details-btn"
                  hx-get="/dashboard/marketplace/pulls/${encodeURIComponent(r.pull_id)}"
                  hx-target="next .pull-details-zone" hx-swap="innerHTML"
                  hx-on:htmx:after-request="this.closest('tr').classList.add('pull-row-expanded')">
            View details
          </button>
        </td>
      </tr>
      <tr class="pull-details-row">
        <td colspan="6"><div class="pull-details-zone"></div></td>
      </tr>
    `;
  }).join("");
  return `
    <table class="market-pulls-table">
      <thead><tr>
        <th>When</th><th>Verdict</th><th>Source</th><th>Total</th><th>Counts</th><th></th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}

export interface MarketplacePullDetailRow {
  skill_name:        string;
  skill_version:     string;
  skill_scope:       string;
  candidate_skill_id: string;
  source_path:       string;
  decision:          string;
  decision_reason:   string;
  lint_passed:       boolean | null;
  lint_errors:       string[] | null;
  lint_warnings:     string[] | null;
  scan_score:        number | null;
  scan_passed:       boolean | null;
  scan_block_failures: Array<{ name: string; severity: string; detail: string | null }> | null;
  pulled_at:         string;
}

export function renderMarketplacePullDetails(pullId: string, rows: MarketplacePullDetailRow[]): string {
  if (rows.length === 0) {
    return `<div class="pull-details-empty">No detail rows for pull ${escapeHtml(pullId)}.</div>`;
  }
  const trs = rows.map((r) => {
    const decisionClass = `decision-${r.decision.replace(/_/g, "-")}`;
    const decisionLabel = r.decision === "added" ? "✓ ADDED"
      : r.decision === "rejected_lint" ? "✗ REJECTED (lint)"
      : r.decision === "rejected_scan" ? "✗ REJECTED (scan)"
      : r.decision === "already_exists" ? "↻ already exists"
      : r.decision === "stale_version" ? "⚠ stale"
      : r.decision === "error" ? "! ERROR"
      : r.decision;
    const scanCol = r.scan_score === null
      ? `<span class="dim">—</span>`
      : `<span class="score score-${r.scan_passed ? "high" : "low"}">${r.scan_score}/8</span>`;
    const lintCol = r.lint_passed === null
      ? `<span class="dim">—</span>`
      : (r.lint_passed ? `<span class="badge ok">OK</span>` : `<span class="badge err">FAIL</span>`);
    const errorList = (r.lint_errors && r.lint_errors.length > 0)
      ? `<details class="lint-errors"><summary>lint errors (${r.lint_errors.length})</summary>${r.lint_errors.map((e) => `<div class="lint-err">⚠ ${escapeHtml(e)}</div>`).join("")}</details>`
      : "";
    const blockList = (r.scan_block_failures && r.scan_block_failures.length > 0)
      ? `<details class="scan-block"><summary>scan block failures (${r.scan_block_failures.length})</summary>${r.scan_block_failures.map((f) => `<div class="scan-fail scan-sev-${escapeHtml(f.severity)}"><strong>${escapeHtml(f.name)}</strong> — ${escapeHtml(f.detail ?? "")}</div>`).join("")}</details>`
      : "";
    return `
      <tr class="${decisionClass}">
        <td class="mono small">${escapeHtml(r.skill_name)}</td>
        <td><strong>${decisionLabel}</strong></td>
        <td>${lintCol}</td>
        <td>${scanCol}</td>
        <td class="reason-cell">${escapeHtml(r.decision_reason)}${errorList}${blockList}</td>
        <td class="mono small"><code>${escapeHtml(r.source_path)}</code></td>
      </tr>
    `;
  }).join("");
  const summary = {
    added: rows.filter((r) => r.decision === "added").length,
    rejected: rows.filter((r) => r.decision.startsWith("rejected")).length,
    already_exists: rows.filter((r) => r.decision === "already_exists").length,
    error: rows.filter((r) => r.decision === "error").length,
  };
  return `
    <div class="pull-details">
      <div class="pull-details-header">
        Pull <code>${escapeHtml(pullId.slice(0, 8))}…</code> · ${rows.length} skills processed ·
        <span class="count count-added">+${summary.added}</span>
        <span class="count count-rejlint">${summary.rejected}✗</span>
        <span class="count count-already">${summary.already_exists}↻</span>
        ${summary.error > 0 ? `<span class="count count-error">${summary.error}!</span>` : ""}
      </div>
      <table class="pull-details-table">
        <thead><tr>
          <th>Skill</th><th>Decision</th><th>Lint</th><th>Scan</th><th>Reason</th><th>Path</th>
        </tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>
  `;
}

export function renderSecurityScansFragment(skillId: string, rows: SecurityScanRow[]): string {
  if (rows.length === 0) {
    return `<div class="scans-list-empty">No security scans recorded for <code>${escapeHtml(skillId)}</code> yet. Scans are written every time the skill is upserted (mutator, marketplace, operator).</div>`;
  }
  const trs = rows.map((r) => {
    const when = r.scanned_at.slice(0, 19).replace("T", " ");
    const verdict = r.passed
      ? `<span class="badge ok">8/8 PASS</span>`
      : `<span class="badge err">${r.score}/8 FAIL</span>`;
    const failsList = r.failures.length > 0
      ? `<details><summary>${r.failures.length} failure(s)</summary>${
          r.failures.map((f) =>
            `<div class="scan-fail scan-sev-${escapeHtml(f.severity)}">
              <strong>${escapeHtml(f.name)}</strong>
              <span class="scan-sev-tag">${escapeHtml(f.severity)}</span>
              ${f.detail ? `<div class="scan-detail">${escapeHtml(f.detail)}</div>` : ""}
            </div>`
          ).join("")
        }</details>`
      : `<span class="dim">none</span>`;
    return `
      <tr>
        <td class="mono small">${escapeHtml(when)}</td>
        <td>${verdict}</td>
        <td><code>${escapeHtml(r.source)}</code></td>
        <td>${failsList}</td>
      </tr>
    `;
  }).join("");
  return `
    <div class="scans-list">
      <div class="scans-header">
        <strong>Security scan history</strong>
        <span class="scans-meta">8-point check (v0.23.0 #1) — every upsert through storage_dual is logged</span>
      </div>
      <table class="scans-table">
        <thead><tr><th>When</th><th>Verdict</th><th>Source</th><th>Failures</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>
  `;
}
