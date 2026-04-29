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
export function loadProjectNameMap(): Map<string, string> {
  const candidates = [
    process.env.ZC_A2A_REGISTRY_PATH,
    join(homedir(), "AI_projects", "A2A_dispatcher", "data", "agents.json"),
    join(process.cwd(), "..", "A2A_dispatcher", "data", "agents.json"),
  ].filter((p): p is string => Boolean(p));

  const map = new Map<string, string>();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      for (const [hash, entry] of Object.entries(data)) {
        const projectPath = (entry as { _meta?: { projectPath?: string } } | null)?._meta?.projectPath;
        if (typeof projectPath === "string" && projectPath.length > 0) {
          // basename works for both unix and windows-style paths
          const name = basename(projectPath.replace(/\\/g, "/"));
          if (name) map.set(hash, name);
        }
      }
      return map;  // first valid registry wins
    } catch { /* try next */ }
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
  <h2 style="opacity:0.6">Token savings (this project, last 7 days)</h2>
  <p class="empty">Sprint 2.7 — coming soon. Planned panels: token savings (KB hits vs Read), context-restore overhead, mutation cost vs human-edit cost.</p>
</div>

<footer>
  v0.18.3 — local operator console, embedded in <code>zc-ctx-api</code> at <code>:3099/dashboard</code>.
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

  const candidates_html = bodies.map((b, i) => `
    <details>
      <summary>
        <strong>#${i}</strong> ${escapeHtml(b.rationale.slice(0, 90))}${b.rationale.length > 90 ? "…" : ""}
        <span class="score">score=${escapeHtml(String(b.self_rated_score))} · ${b.candidate_body.length} chars</span>
      </summary>
      <div class="rationale">${escapeHtml(b.rationale)}</div>
      <div class="candidate-body">${escapeHtml(b.candidate_body)}</div>
    </details>
  `).join("");

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
