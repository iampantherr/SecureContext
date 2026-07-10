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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  /* ════════════════════════════════════════════════════════════════
     SecureContext Operator Console — "Operator's terminal, elevated"
     Redesign 2026-06-02. Restyles every class in the dashboard to one
     cohesive security-console design system. Tab classes (tab-active /
     tab-content-active), data-tab, #badge, and all hx-* attrs preserved.
     ════════════════════════════════════════════════════════════════ */
  :root{
    --bg:#080b11; --bg-2:#0a0e16; --surface:#0e131c; --surface-2:#121a26; --surface-3:#16202e;
    --border:#1d2634; --border-bright:#2b3850; --hairline:rgba(255,255,255,.045);
    --text:#e9eef5; --text-dim:#8b99ad; --text-faint:#7a8799;
    --signal:#2fe6a6; --signal-deep:#0f7d59; --signal-glow:rgba(47,230,166,.30);
    --info:#5aa2ff; --violet:#a98bff; --warn:#f1b84c; --alert:#ff5d6c;
    --display:'Chakra Petch',ui-sans-serif,system-ui,sans-serif;
    --sans:'IBM Plex Sans',ui-sans-serif,system-ui,sans-serif;
    --mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace;
    --ease:cubic-bezier(.2,.8,.2,1); --ease-out:cubic-bezier(.16,1,.3,1);
    --fast:.18s; --med:.32s;
  }
  *{box-sizing:border-box;}
  body{
    font-family:var(--sans); margin:0; padding:0; background:var(--bg); color:var(--text);
    line-height:1.5; font-size:14px; -webkit-font-smoothing:antialiased; letter-spacing:.005em;
    position:relative; min-height:100vh;
  }
  body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
    background:radial-gradient(900px 420px at 18% -8%,rgba(47,230,166,.10),transparent 60%),radial-gradient(700px 500px at 100% 0%,rgba(90,162,255,.06),transparent 55%);}
  body::after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.03;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");}
  body > *{position:relative;z-index:1;}

  /* top signature accent */
  .topline{height:2px;width:100%;background:linear-gradient(90deg,transparent,var(--signal) 18%,var(--info) 50%,var(--violet) 78%,transparent);opacity:.85;box-shadow:0 0 18px var(--signal-glow);}

  /* ── masthead ── */
  header{display:flex;align-items:center;gap:18px;padding:22px 32px 18px;max-width:1180px;margin:0 auto;animation:rise .6s var(--ease-out) both;}
  .brand{display:flex;align-items:center;gap:13px;}
  .mark{width:38px;height:38px;flex:none;filter:drop-shadow(0 0 10px var(--signal-glow));}
  .wordmark{display:flex;flex-direction:column;line-height:1;}
  .wordmark .eyebrow{font-family:var(--mono);font-size:.62rem;letter-spacing:.4em;color:var(--text-faint);text-transform:uppercase;margin-bottom:5px;padding-left:2px;}
  h1{font-family:var(--display);font-weight:600;font-size:1.5rem;margin:0;letter-spacing:.01em;color:var(--text);}
  h1 b{color:var(--signal);font-weight:700;}
  .masthead-spacer{flex:1;}
  .status-cluster{display:flex;align-items:center;gap:16px;}
  .live{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:.7rem;letter-spacing:.18em;color:var(--text-dim);text-transform:uppercase;}
  .live-dot{width:8px;height:8px;border-radius:50%;background:var(--signal);position:relative;}
  .live-dot::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:1px solid var(--signal);animation:ping 1.8s var(--ease-out) infinite;}
  .sys-pills{display:flex;gap:7px;}
  .pill{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:.7rem;padding:5px 10px;border-radius:7px;background:var(--surface);border:1px solid var(--border);color:var(--text-dim);}
  .pill .dot{width:6px;height:6px;border-radius:50%;}
  .pill.up .dot{background:var(--signal);box-shadow:0 0 8px var(--signal-glow);}
  .pill.warn .dot{background:var(--warn);}
  .pill.down .dot{background:var(--alert);}
  /* health badge (#badge, populated by pollHealth) */
  .badge{display:inline-flex;align-items:center;gap:6px;padding:3px 11px;border-radius:20px;font-family:var(--mono);font-size:.74rem;font-weight:500;letter-spacing:.02em;background:var(--surface-2);color:var(--text-dim);border:1px solid var(--border);}
  .badge.ok{background:rgba(47,230,166,.10);color:var(--signal);border-color:rgba(47,230,166,.28);}
  .badge.err{background:rgba(255,93,108,.12);color:var(--alert);border-color:rgba(255,93,108,.35);}
  .badge.alert{background:rgba(255,93,108,.12);color:var(--alert);border-color:rgba(255,93,108,.35);animation:pulse 1.6s var(--ease) infinite;}
  .badge.dim-badge{background:var(--surface-2);color:var(--text-faint);border-color:var(--border);}

  /* ── tab nav (real classes: tab-active / tab-content-active) ── */
  .tab-nav{display:flex;gap:4px;max-width:1180px;margin:6px auto 0;padding:0 32px;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;background:rgba(8,11,17,.78);backdrop-filter:blur(10px);overflow-x:auto;scrollbar-width:none;animation:rise .6s .06s var(--ease-out) both;}
  .tab-nav::-webkit-scrollbar{display:none;}
  .tab-button{display:inline-flex;align-items:center;gap:9px;background:transparent;border:0;cursor:pointer;font-family:var(--sans);font-weight:500;font-size:.9rem;color:var(--text-dim);padding:13px 16px 15px;position:relative;white-space:nowrap;flex:none;transition:color var(--fast) var(--ease);}
  .tab-button svg{width:16px;height:16px;opacity:.8;transition:opacity var(--fast) var(--ease),transform var(--fast) var(--ease);}
  .tab-button::after{content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:2px;border-radius:2px;background:var(--signal);transform:scaleX(0);transition:transform var(--med) var(--ease);box-shadow:0 0 12px var(--signal-glow);}
  .tab-button:hover{color:var(--text);}
  .tab-button:hover svg{opacity:1;transform:translateY(-1px);}
  .tab-button.tab-active{color:var(--text);}
  .tab-button.tab-active svg{opacity:1;color:var(--signal);}
  .tab-button.tab-active::after{transform:scaleX(1);}
  .tab-content{display:none;}
  .tab-content.tab-content-active{display:block;animation:swap .34s var(--ease-out);}

  /* ── layout / panels ── */
  main{max-width:1180px;margin:0 auto;padding:24px 32px 56px;}
  .panel{background:linear-gradient(180deg,var(--surface),var(--bg-2));border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:18px;position:relative;box-shadow:0 1px 0 var(--hairline) inset,0 10px 30px -18px rgba(0,0,0,.8);transition:border-color var(--med) var(--ease);animation:rise .55s var(--ease-out) both;}
  .panel:hover{border-color:var(--border-bright);}
  .tab-content-active .panel:nth-of-type(1){animation-delay:.04s}
  .tab-content-active .panel:nth-of-type(2){animation-delay:.10s}
  .tab-content-active .panel:nth-of-type(3){animation-delay:.16s}
  .tab-content-active .panel:nth-of-type(4){animation-delay:.22s}
  .panel h2{font-family:var(--display);font-weight:600;font-size:1.02rem;letter-spacing:.01em;margin:0 0 14px;color:var(--text);display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
  .panel h2 span{font-family:var(--sans)!important;font-weight:400!important;}
  .empty,.muted{color:var(--text-faint);font-style:italic;font-size:.9rem;}
  .dim{color:var(--text-faint);}
  .mono,.mono.small{font-family:var(--mono);}

  /* result cards / ids */
  .result{border:1px solid var(--border);border-radius:10px;padding:13px 15px;margin-bottom:12px;background:var(--bg-2);transition:border-color var(--fast) var(--ease);}
  .result:hover{border-color:var(--border-bright);}
  .result-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;}
  .result-id{font-family:var(--mono);font-size:.88rem;color:var(--info);}
  .skill-id{font-family:var(--mono);font-size:.84rem;color:var(--violet);}
  .project-name{display:inline-block;padding:2px 8px;border-radius:6px;background:rgba(47,230,166,.1);color:#9af0cf;font-weight:500;font-size:.82rem;cursor:help;border:1px solid rgba(47,230,166,.24);}
  .project-name.unresolved{background:var(--surface-2);color:var(--text-dim);font-weight:400;border-color:var(--border);}
  .meta{color:var(--text-dim);font-size:.84rem;margin-bottom:8px;}
  .meta code,.skill-health-banner code{background:var(--surface-2);padding:1px 5px;border-radius:4px;font-family:var(--mono);font-size:.85em;}
  .rationale{color:var(--text-dim);font-style:italic;margin-bottom:6px;padding-left:12px;border-left:2px solid var(--signal);}
  .tooltip{border-bottom:1px dotted var(--text-faint);cursor:help;position:relative;}

  /* details / summary */
  details{margin-bottom:8px;}
  summary{cursor:pointer;padding:8px 0;font-weight:500;user-select:none;color:var(--text);}
  summary:hover{color:var(--signal);}
  summary .score{color:var(--signal);font-family:var(--mono);font-size:.84rem;margin-left:8px;}

  /* code/body blocks */
  .candidate-body,.skill-body-text{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:11px;font-family:var(--mono);font-size:.8rem;white-space:pre-wrap;word-wrap:break-word;max-height:340px;overflow:auto;color:var(--text);line-height:1.55;}

  /* diff view */
  .diff-summary{font-size:.84rem;color:var(--text-dim);margin:8px 0;}
  .diff-stat-add{color:var(--signal);font-family:var(--mono);margin-right:8px;}
  .diff-stat-del{color:var(--alert);font-family:var(--mono);margin-right:8px;}
  .diff-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
  .diff-side{background:var(--bg);border:1px solid var(--border);border-radius:8px;overflow:hidden;}
  .diff-label{padding:5px 9px;background:var(--surface-3);color:var(--text-dim);font-family:var(--mono);font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;}
  .diff-content{max-height:400px;overflow:auto;font-family:var(--mono);font-size:.78rem;}
  .diff-row{padding:1px 9px;white-space:pre-wrap;word-wrap:break-word;min-height:1em;}
  .diff-row.diff-equal{color:#c3ccd9;}
  .diff-row.diff-add{color:#aef3d8;background:rgba(47,230,166,.1);border-left:2px solid var(--signal);}
  .diff-row.diff-del{color:#ffb3bb;background:rgba(255,93,108,.1);border-left:2px solid var(--alert);text-decoration:line-through;}
  .diff-row.diff-blank{background:var(--bg);min-height:1em;}
  .diff-fallback{display:flex;gap:8px;}.diff-fallback .diff-side{flex:1;}.diff-fallback pre{padding:8px;margin:0;max-height:400px;overflow:auto;font-size:.78rem;}
  .candidate-tabs{margin-top:8px;}
  .candidate-tabs>details{margin-bottom:6px;border:1px solid var(--border);border-radius:8px;padding:6px 8px;}
  .tab-label{font-size:.84rem;color:var(--text-dim);cursor:pointer;padding:2px 4px;}
  .tab-label:hover{color:var(--signal);}

  /* skill rows */
  .skill-scope{margin-bottom:16px;}
  .skill-scope-header{font-family:var(--mono);font-size:.72rem;letter-spacing:.06em;color:var(--text-faint);text-transform:uppercase;margin:4px 0 8px;}
  .skill-row{background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:13px 15px;margin-bottom:9px;transition:border-color var(--fast) var(--ease),transform var(--fast) var(--ease),background var(--fast) var(--ease);}
  .skill-row:hover{border-color:var(--border-bright);transform:translateY(-1px);background:var(--surface);}
  .skill-header{display:flex;justify-content:space-between;align-items:center;gap:12px;}
  .skill-name{font-family:var(--mono);font-weight:600;font-size:.92rem;color:var(--text);}
  .skill-meta{color:var(--text-dim);font-size:.82rem;margin-top:6px;}
  .skill-meta .role-tag{font-family:var(--mono);background:rgba(90,162,255,.1);color:#9ec5ff;padding:1px 7px;border-radius:5px;font-size:.7rem;margin-right:4px;border:1px solid rgba(90,162,255,.22);}
  .skill-meta .guidance-preview{color:var(--text-dim);font-style:italic;}
  .skill-actions{display:flex;gap:5px;}
  .skill-edit-zone{margin-top:8px;}
  .skill-eff{color:var(--text-dim);font-size:.82rem;cursor:help;border-bottom:1px dotted var(--text-faint);}
  .skill-eff strong{color:var(--signal);font-family:var(--mono);}
  .skill-eff-none{color:var(--text-faint);}.skill-eff-none em{font-style:italic;}

  /* source badges */
  .src-badge{display:inline-flex;align-items:center;padding:2px 9px;border-radius:11px;font-family:var(--mono);font-size:.68rem;font-weight:500;margin-left:8px;vertical-align:middle;cursor:help;}
  .src-marketplace{background:rgba(90,162,255,.12);color:#9ec5ff;border:1px solid rgba(90,162,255,.3);}
  .src-filesystem{background:rgba(47,230,166,.11);color:#7ff0c6;border:1px solid rgba(47,230,166,.3);}
  .src-filesystem small{color:#5ed6a4;font-size:.66rem;margin-left:4px;}
  .src-role-extracted{background:rgba(241,184,76,.12);color:#f6cf85;border:1px solid rgba(241,184,76,.3);}
  .src-custom{background:var(--surface-2);color:var(--text-dim);border:1px solid var(--border);}

  /* score trend sparkline */
  .skill-trend{display:inline-flex;align-items:center;gap:5px;vertical-align:middle;}
  .sparkline{vertical-align:middle;color:var(--text-faint);}
  .sparkline.trend-up{color:var(--signal);}.sparkline.trend-down{color:var(--alert);}.sparkline.trend-flat{color:var(--text-dim);}
  .sparkline-label{font-size:.76rem;font-family:var(--mono);}
  .sparkline-label small{font-size:.68rem;margin-left:3px;}
  .sparkline-label.trend-up small{color:var(--signal);}.sparkline-label.trend-down small{color:var(--alert);}.sparkline-label.trend-flat small{color:var(--text-dim);}
  .sparkline-empty{color:var(--text-faint);font-size:.76rem;}

  /* buttons */
  button{font-family:var(--sans);padding:8px 15px;border-radius:8px;cursor:pointer;font-weight:500;font-size:.88rem;border:1px solid var(--border);background:var(--surface-2);color:var(--text-dim);transition:transform var(--fast) var(--ease),border-color var(--fast) var(--ease),background var(--fast) var(--ease),color var(--fast) var(--ease),box-shadow var(--fast) var(--ease);}
  button:hover{transform:translateY(-1px);border-color:var(--border-bright);color:var(--text);}
  .edit-btn,.polish-btn,.runs-btn,.security-btn,.body-btn,.pull-details-btn,.pull-body-btn,.proj-skills-btn,.star-btn{background:var(--surface-2);color:var(--text-dim);border:1px solid var(--border);padding:5px 12px;border-radius:7px;cursor:pointer;font-size:.82rem;transition:transform var(--fast) var(--ease),border-color var(--fast) var(--ease),color var(--fast) var(--ease),background var(--fast) var(--ease);}
  .edit-btn:hover,.runs-btn:hover,.security-btn:hover,.body-btn:hover,.polish-btn:hover,.pull-details-btn:hover,.pull-body-btn:hover,.proj-skills-btn:hover,.star-btn:hover{transform:translateY(-1px);border-color:var(--border-bright);color:var(--text);background:var(--surface-3);}
  .link-btn{background:none;border:0;color:var(--info);cursor:pointer;padding:0;font-size:.84rem;}
  .link-btn:hover{color:#bcd8ff;text-decoration:underline;}
  .new-skill-btn,button.approve,.approve-btn,.apply-polish-btn{background:linear-gradient(180deg,rgba(47,230,166,.16),rgba(47,230,166,.06));color:var(--signal);border:1px solid rgba(47,230,166,.34);padding:7px 15px;border-radius:8px;cursor:pointer;font-weight:500;}
  .new-skill-btn:hover,button.approve:hover,.approve-btn:hover,.apply-polish-btn:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 20px -8px var(--signal-glow);border-color:var(--signal);}
  button.reject,.reject-btn{background:var(--surface-2);color:var(--text-dim);border:1px solid var(--border);}
  button.reject:hover,.reject-btn:hover{color:#ff97a1;border-color:rgba(255,93,108,.4);transform:translateY(-1px);}
  .pull-marketplace-btn{background:rgba(90,162,255,.12);color:#bcd8ff;border:1px solid rgba(90,162,255,.32);padding:8px 16px;border-radius:8px;cursor:pointer;font-weight:500;transition:transform var(--fast) var(--ease),border-color var(--fast) var(--ease),box-shadow var(--fast) var(--ease);}
  .pull-marketplace-btn:hover:not(:disabled){transform:translateY(-1px);border-color:var(--info);box-shadow:0 6px 20px -8px rgba(90,162,255,.4);}
  .pull-marketplace-btn:disabled,.apply-polish-btn:disabled{opacity:.55;cursor:progress;transform:none;}
  .apply-polish-btn-blocked{background:rgba(255,93,108,.12)!important;color:#ff97a1!important;border-color:rgba(255,93,108,.35)!important;}
  .star-btn{color:var(--warn);}
  .star-btn.star-on{background:rgba(241,184,76,.14);color:#ffd97a;border-color:rgba(241,184,76,.4);cursor:default;}
  .new-skill-meta,.market-meta,.runs-meta,.scans-meta,.polish-meta,.proj-skills-meta,.skill-body-meta,.skill-candidate-meta{font-size:.8rem;color:var(--text-faint);}

  /* skill body view */
  .skill-body-view,.polish-result,.runs-list,.scans-list,.new-skill-form,.skill-edit-form,.pull-details,.market-summary,.proj-skills-table{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px;margin-top:8px;}
  .skill-body-header,.polish-header,.runs-header,.scans-header,.proj-skills-header,.market-summary-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
  .skill-body-warning{background:rgba(241,184,76,.1);border-left:3px solid var(--warn);padding:8px 12px;margin-top:8px;font-size:.82rem;color:#fbe3a8;border-radius:0 6px 6px 0;}

  /* chain banner */
  .chain-banner{display:flex;align-items:center;gap:12px;padding:13px 16px;border-radius:10px;margin:8px 0 14px;font-size:.9rem;}
  .chain-banner.chain-ok{background:linear-gradient(180deg,rgba(47,230,166,.1),rgba(47,230,166,.03));border:1px solid rgba(47,230,166,.3);color:#aef3d8;}
  .chain-banner.chain-broken{background:rgba(255,93,108,.1);border:1px solid rgba(255,93,108,.34);color:#ffb3bb;}
  .chain-banner.chain-error{background:rgba(241,184,76,.1);border:1px solid rgba(241,184,76,.3);color:#fbe3a8;}
  .chain-banner .chain-status{font-family:var(--mono);font-weight:600;letter-spacing:.04em;}
  .chain-banner .chain-detail{color:inherit;opacity:.85;}

  /* skills git sync */
  .fs-git-sync-details{margin-top:12px;padding:8px 14px;background:var(--bg-2);border:1px solid var(--border);border-radius:10px;}
  .git-sync-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:6px;}
  .git-sync-pills{display:flex;gap:6px;flex-wrap:wrap;}
  .git-pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.72rem;font-family:var(--mono);letter-spacing:.03em;}
  .git-pill-ok{background:rgba(16,185,129,.15);color:#10b981;}
  .git-pill-warn{background:rgba(245,158,11,.15);color:#f59e0b;}
  .git-pill-dirty{background:rgba(239,68,68,.15);color:#f87171;}
  .git-pill-new{background:rgba(96,165,250,.15);color:#60a5fa;}
  .git-sync-btn{padding:7px 14px;border-radius:8px;border:1px solid var(--border);background:var(--accent,#2563eb);color:#fff;font-size:.82rem;cursor:pointer;font-weight:500;}
  .git-sync-btn[disabled]{opacity:.5;cursor:default;background:transparent;color:var(--text-faint);}
  .git-sync-meta{margin-top:6px;font-size:.78rem;color:var(--text-faint);}
  .git-sync-meta code{font-size:.75rem;color:#94a3b8;}
  /* fs quarantine / admission */
  .fs-quarantine-details,.fs-admission-details,.per-agent-panel,.anti-patterns-panel,.savings-methodology,.skill-edit-form details.fixtures-readonly,.summarizer-breakdown,.trend-panel{margin-top:12px;padding:8px 14px;background:var(--bg-2);border:1px solid var(--border);border-radius:10px;}
  .fs-quarantine-table,.fs-admission-table,.spotter-runs-table,.runs-table,.scans-table,.savings-table,.summarizer-table,.mutations-table,.broadcasts-table,.market-pulls-table,.pull-details-table{width:100%;border-collapse:collapse;font-size:.84rem;}
  .fs-quarantine-table th,.fs-admission-table th,.spotter-runs-table th,.runs-table th,.scans-table th,.savings-table th,.summarizer-table th,.mutations-table th,.broadcasts-table th,.market-pulls-table th,.pull-details-table th{text-align:left;padding:9px 10px;font-family:var(--mono);font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text-faint);background:transparent;border-bottom:1px solid var(--border);font-weight:500;}
  .fs-quarantine-table td,.fs-admission-table td,.spotter-runs-table td,.runs-table td,.scans-table td,.savings-table td,.summarizer-table td,.mutations-table td,.broadcasts-table td,.market-pulls-table td,.pull-details-table td{padding:9px 10px;border-bottom:1px solid var(--hairline);color:var(--text);vertical-align:top;}
  .broadcasts-table tbody tr,.mutations-table tbody tr,.runs-table tbody tr{transition:background var(--fast) var(--ease);}
  .broadcasts-table tbody tr:hover,.mutations-table tbody tr:hover,.runs-table tbody tr:hover{background:rgba(47,230,166,.03);}
  .summarizer-table td.error-msg,.runs-table .mono.small,.scans-table .mono.small,.summarizer-table td.small{font-family:var(--mono);font-size:.78rem;color:var(--text-dim);}
  .summarizer-table td.error-msg{color:#ffb3bb;max-width:480px;word-break:break-word;}

  /* event / status chips */
  .evt-badge,.bcast-type,.badge-status,.badge-source,.count,.skill-candidate-status,.skill-candidate-count,.scan-sev-tag{display:inline-flex;align-items:center;font-family:var(--mono);font-size:.7rem;font-weight:500;padding:2px 9px;border-radius:8px;letter-spacing:.02em;}
  .evt-ok{background:rgba(47,230,166,.12);color:var(--signal);}
  .evt-quar{background:rgba(255,93,108,.12);color:#ff97a1;}
  .evt-info{background:rgba(90,162,255,.12);color:#9ec5ff;}
  .bcast-assign,.bcast-proposed{background:rgba(90,162,255,.13);color:#9ec5ff;}
  .bcast-status,.bcast-revise,.bcast-dependency{background:rgba(241,184,76,.13);color:#f6cf85;}
  .bcast-merge{background:rgba(47,230,166,.13);color:var(--signal);}
  .bcast-reject{background:rgba(255,93,108,.13);color:#ff97a1;}
  .bcast-launch_role{background:rgba(169,139,255,.14);color:#c9b6ff;}
  .bcast-retire_role{background:var(--surface-2);color:var(--text-dim);}
  .score,.badge-status{padding:2px 8px;border-radius:7px;font-family:var(--mono);}
  .score-high,.badge-status.succeeded,.badge-status.ok,.badge-source.semantic{background:rgba(47,230,166,.12);color:var(--signal);}
  .score-mid,.badge-status.skipped,.badge-status.fallback_truncation,.badge-source.truncation{background:rgba(241,184,76,.13);color:#f6cf85;}
  .score-low,.badge-status.failed,.badge-status.error{background:rgba(255,93,108,.12);color:#ff97a1;}
  .badge-source.ast{background:rgba(90,162,255,.12);color:#9ec5ff;}
  .badge-source.unknown{background:var(--surface-2);color:var(--text-dim);}
  .skill-candidate-count{background:rgba(255,93,108,.13);color:#ff97a1;border-radius:11px;}
  .skill-candidate-status{border-radius:11px;text-transform:uppercase;}
  .skill-candidate-status.pending{background:rgba(241,184,76,.13);color:#f6cf85;}
  .skill-candidate-status.generating{background:rgba(90,162,255,.13);color:#9ec5ff;}
  .skill-candidate-status.ready,.skill-candidate-status.approved{background:rgba(47,230,166,.12);color:var(--signal);}
  .skill-candidate-status.rejected{background:rgba(169,139,255,.14);color:#c9b6ff;opacity:.7;}
  .skill-candidate-status.superseded{background:var(--surface-2);color:var(--text-dim);opacity:.7;}
  .count-added{background:rgba(47,230,166,.12);color:var(--signal);}
  .count-already{background:rgba(90,162,255,.12);color:#9ec5ff;}
  .count-stale{background:rgba(241,184,76,.13);color:#f6cf85;}
  .count-rejlint,.count-rejscan,.count-error{background:rgba(255,93,108,.12);color:#ff97a1;}
  .count-total{background:var(--surface-2);color:var(--text-dim);}

  /* skill candidate / spotter / signals */
  .skill-candidate,.signal-row,.spotter-result{background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:13px 15px;margin-bottom:8px;}
  .skill-candidate-header{display:flex;gap:10px;align-items:center;margin-bottom:6px;flex-wrap:wrap;}
  .skill-candidate-headline,.signal-header{color:var(--text);font-size:.9rem;margin:6px 0;line-height:1.45;}
  .skill-candidate-actions{margin-top:8px;padding-top:8px;border-top:1px solid var(--border);}
  .skill-candidate-actions small{color:var(--text-dim);font-style:italic;}
  .spotter-controls{display:flex;gap:8px;align-items:center;margin:8px 0 12px;flex-wrap:wrap;}
  .signal-name,.signal-trigger,.signal-evidence{font-size:.84rem;color:#c3ccd9;margin-top:4px;}
  .signal-evidence code{font-size:.78rem;color:#9ec5ff;}
  .spotter-result{background:rgba(47,230,166,.06);color:#aef3d8;}

  /* forms */
  form{margin-top:16px;padding-top:14px;border-top:1px solid var(--border);}
  form label,.new-skill-form label,.skill-edit-form label,.savings-controls label{display:block;margin-bottom:11px;font-size:.84rem;color:#c3ccd9;}
  form .form-banner,.new-skill-form .form-banner,.skill-edit-form .form-banner{background:var(--surface-2);border-left:3px solid var(--signal);padding:8px 12px;margin-bottom:14px;font-size:.84rem;color:#c3ccd9;border-radius:0 6px 6px 0;}
  input[type=text],input[type=number],select,textarea{width:100%;padding:8px 11px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:7px;font-family:var(--sans);font-size:16px;margin-top:4px;transition:border-color var(--fast) var(--ease);}
  textarea{font-family:var(--mono);font-size:.84rem;resize:vertical;}
  input[type=text]:focus,input[type=number]:focus,select:focus,textarea:focus{outline:none;border-color:var(--signal);box-shadow:0 0 0 3px rgba(47,230,166,.12);}
  form .row,.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
  form .checkbox{display:flex;align-items:center;gap:8px;margin:12px 0;}
  form .checkbox input,form input[type=checkbox]{width:auto;margin:0;}
  form .help,.help,.savings-tile-label{font-size:.78rem;color:var(--text-faint);margin-top:4px;}
  form .actions,.form-actions,.skill-create-actions,.market-pull-actions{display:flex;gap:8px;align-items:center;}
  .skill-create-actions,.market-pull-actions{margin-bottom:14px;}
  .role-picker summary{cursor:pointer;padding:7px 11px;background:var(--bg);border:1px solid var(--border);border-radius:7px;font-size:.84rem;color:#c3ccd9;}
  .role-checkbox-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-top:4px;max-height:240px;overflow-y:auto;}
  .role-checkbox{display:flex;align-items:center;gap:5px;font-size:.78rem;color:#c3ccd9;cursor:pointer;}
  .response .ok{background:rgba(47,230,166,.1);color:#aef3d8;padding:10px;border-radius:8px;}
  .response .error{background:rgba(255,93,108,.1);color:#ffb3bb;padding:10px;border-radius:8px;}
  /* v0.33.0 — suspected-contradictions review cards */
  .contra-card{border:1px solid var(--border);border-left:3px solid var(--warn);border-radius:10px;padding:12px 14px;margin-bottom:12px;background:var(--bg-2);animation:rise .4s var(--ease-out) both;}
  .contra-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;font-size:.86rem;}
  .contra-reason{font-weight:600;color:var(--warn);}
  .contra-sim{font-family:var(--mono);font-size:.78rem;color:var(--text-dim);border:1px solid var(--border);border-radius:6px;padding:1px 7px;}
  .contra-proj{color:var(--text-dim);margin-left:auto;}
  .contra-pair{display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:start;margin-bottom:12px;}
  .contra-side{min-width:0;}
  .contra-side code{display:inline-block;margin-bottom:4px;color:var(--signal);font-size:.82rem;word-break:break-all;}
  .contra-val{font-size:.84rem;color:var(--text);line-height:1.4;background:var(--surface);border:1px solid var(--hairline);border-radius:7px;padding:7px 9px;}
  .contra-vs{align-self:center;color:var(--warn);font-size:1.1rem;font-weight:700;}
  .contra-actions{display:flex;gap:8px;flex-wrap:wrap;}
  .contra-actions button{font-size:.84rem;padding:6px 13px;}
  .contra-accept:hover{border-color:var(--signal);color:var(--signal);background:rgba(47,230,166,.08);}
  .contra-discard:hover{border-color:#9aa6b5;color:var(--text);}
  .contra-ignore:hover{border-color:#ff7d88;color:#ffb3bb;background:rgba(255,93,108,.07);}
  .contra-resolved{border:1px solid var(--border);border-left:3px solid var(--signal);border-radius:10px;padding:10px 14px;margin-bottom:12px;background:rgba(47,230,166,.06);color:#aef3d8;font-size:.88rem;}
  @media (max-width:720px){.contra-pair{grid-template-columns:1fr;}.contra-vs{justify-self:start;}}
  .lint-errors{margin-top:8px;padding:7px 10px;background:rgba(255,93,108,.1);border-left:3px solid var(--alert);border-radius:0 6px 6px 0;}
  .lint-err{color:#ffb3bb;font-size:.84rem;}
  .lint-warns summary{cursor:pointer;font-size:.84rem;color:var(--warn);}
  .lint-warn{font-size:.82rem;color:#c3ccd9;padding-left:16px;}
  .scan-fail{padding:7px 10px;margin:4px 0;border-radius:7px;font-size:.82rem;}
  .scan-sev-block{background:rgba(255,93,108,.1);border-left:3px solid var(--alert);}
  .scan-sev-warn{background:rgba(241,184,76,.1);border-left:3px solid var(--warn);}
  .scan-detail{font-family:var(--mono);font-size:.78rem;color:#c3ccd9;margin-top:4px;}

  /* polish columns */
  .polish-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
  .polish-col{background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:9px;}
  .polish-col-new{border-color:rgba(47,230,166,.4);background:rgba(47,230,166,.05);}
  .polish-col-title{font-size:.78rem;color:var(--text-faint);margin-bottom:6px;}
  .polish-col-text,.polish-current{font-size:.88rem;color:var(--text);line-height:1.45;white-space:pre-wrap;}
  .polish-no-change{border-color:rgba(47,230,166,.3);background:rgba(47,230,166,.04);}
  .polish-no-change-icon{color:var(--signal);}

  /* market / pull rows */
  .market-summary-counts{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}
  .market-details-link{color:var(--info);font-size:.84rem;cursor:pointer;text-decoration:none;}
  .market-details-link:hover{text-decoration:underline;}
  .pull-details-table tr.decision-added{background:rgba(47,230,166,.04);}
  .pull-details-table tr.decision-rejected-lint,.pull-details-table tr.decision-rejected-scan,.pull-details-table tr.decision-error{background:rgba(255,93,108,.05);}
  .pull-details-table tr.decision-already-exists{background:rgba(90,162,255,.04);}
  .pull-details-table tr.decision-stale-version{background:rgba(241,184,76,.04);}
  .pull-details-header{font-size:.84rem;color:#c3ccd9;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border);}

  /* skill-health banner + rows */
  .skill-health-banner{padding:11px 14px;border-radius:10px;margin-bottom:10px;font-size:.92rem;border-left:3px solid;}
  .skill-health-banner-ok{background:rgba(47,230,166,.08);color:#aef3d8;border-left-color:var(--signal);}
  .skill-health-banner-warn{background:rgba(241,184,76,.08);color:#fbe3a8;border-left-color:var(--warn);}
  .skill-health-banner-bad{background:rgba(255,93,108,.08);color:#ffb3bb;border-left-color:var(--alert);}
  .skill-health-banner-info{background:rgba(90,162,255,.08);color:#bcd8ff;border-left-color:var(--info);}
  .skill-health-row{display:flex;align-items:center;gap:10px;padding:8px 4px;font-size:.88rem;border-bottom:1px solid var(--hairline);}
  .skill-health-row:last-child{border-bottom:none;}
  .skill-health-row .skill-health-icon{width:20px;font-weight:700;font-size:1rem;flex-shrink:0;}
  .skill-health-row .skill-health-name{font-family:var(--mono);font-weight:600;min-width:180px;}
  .skill-health-row .skill-health-detail{color:#c3ccd9;flex:1;}
  .skill-health-bad .skill-health-icon{color:var(--alert);}
  .skill-health-warn .skill-health-icon{color:var(--warn);}
  .skill-health-ok .skill-health-icon{color:var(--signal);}
  .skill-health-info .skill-health-icon{color:var(--info);}
  .skill-health-empty,.proj-skills-empty,.trend-empty,.summarizer-empty.muted{color:var(--text-faint);font-style:italic;padding:8px 4px;}

  /* stat tiles (savings + summarizer) */
  .savings-totals,.summarizer-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px;}
  .savings-tile,.summarizer-stats .stat-tile{background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;text-align:center;transition:border-color var(--fast) var(--ease);}
  .savings-tile:hover,.summarizer-stats .stat-tile:hover{border-color:var(--border-bright);}
  .savings-tile-num,.summarizer-stats .stat-num{font-family:var(--display);font-size:1.6rem;font-weight:600;color:var(--signal);letter-spacing:.01em;margin-bottom:4px;}
  .savings-tile-label,.summarizer-stats .stat-label{font-family:var(--mono);font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text-faint);}
  .savings-table td.savings-cell{color:var(--signal);}
  .savings-methodology{font-size:.8rem;color:var(--text-dim);}.savings-methodology ul{margin:8px 0 0;padding-left:20px;}.savings-methodology li{margin-bottom:4px;}
  .summarizer-breakdown .breakdown-title{font-family:var(--mono);font-size:.7rem;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;}
  .summarizer-breakdown .breakdown-row{font-size:.88rem;color:#c3ccd9;padding:3px 0;}

  /* trend / anti-patterns */
  .trend-header{font-size:.85rem;color:#c3ccd9;margin-bottom:8px;}
  .trend-svg{width:100%;height:80px;display:block;}
  .trend-axis{display:flex;justify-content:space-between;font-size:.72rem;color:var(--text-faint);margin-top:4px;}
  .anti-patterns-panel summary{cursor:pointer;color:var(--warn);font-weight:600;}
  .per-agent-panel summary{cursor:pointer;color:#c3ccd9;font-weight:600;}
  .anti-pattern{padding:6px 10px;margin-top:6px;border-radius:7px;font-size:.85rem;}
  .anti-pattern.warn-chip{background:rgba(255,93,108,.1);color:#ffb3bb;border-left:3px solid var(--alert);}
  .anti-pattern.info-chip{background:var(--surface-2);color:#c3ccd9;border-left:3px solid var(--warn);}

  /* footer → status strip */
  footer{display:flex;align-items:center;gap:16px;flex-wrap:wrap;color:var(--text-faint);font-family:var(--mono);font-size:.74rem;letter-spacing:.03em;margin-top:36px;padding:14px 0 0;border-top:1px solid var(--border);}
  footer code{color:var(--text-dim);}

  /* keyframes */
  @keyframes rise{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:none;}}
  @keyframes swap{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}
  @keyframes ping{0%{transform:scale(.6);opacity:.9;}70%,100%{transform:scale(1.9);opacity:0;}}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.55;}}
  @keyframes sheen{to{background-position:200% 0;}}
  /* motion polish — restrained, refresh-safe (no per-row animation that would flicker on auto-refresh) */
  button:active,.edit-btn:active,.runs-btn:active,.security-btn:active,.body-btn:active,.new-skill-btn:active,.pull-marketplace-btn:active,.approve-btn:active,.reject-btn:active,.link-btn:active,.proj-skills-btn:active,.star-btn:active{transform:translateY(0) scale(.97);}
  .topline{background-size:200% 100%;animation:sheen 11s linear infinite;}
  .badge.ok,.evt-ok,.bcast-merge,.health-status.healthy,.skill-health-ok .skill-health-icon{text-shadow:0 0 10px var(--signal-glow);}
  .mark{transition:filter var(--med) var(--ease);}
  header:hover .mark{filter:drop-shadow(0 0 16px var(--signal-glow));}

  @media (max-width:760px){
    header{flex-wrap:wrap;gap:12px;padding:18px;}
    .sys-pills{display:none;}
    main,.tab-nav{padding-left:18px;padding-right:18px;}
    .panel{overflow-x:auto;}
    .diff-grid,.polish-grid,form .row,.form-row,.role-checkbox-grid{grid-template-columns:1fr;}
    .skill-header{flex-wrap:wrap;gap:8px;}
  }
  /* ── v0.40.0 panel-subtitle + overview status strip ── */
  .panel h2 .sub{font-size:.82rem;font-weight:400;color:#94a3b8;margin-left:8px;}
  .stat-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:4px;}
  .stat-card{background:rgba(15,20,30,.65);border:1px solid var(--border);border-radius:12px;padding:14px 16px;cursor:pointer;transition:border-color var(--fast) var(--ease),transform var(--fast) var(--ease);}
  .stat-card:hover{border-color:var(--signal);transform:translateY(-2px);}
  .stat-card .stat-n{font-size:1.7rem;font-weight:650;letter-spacing:-.02em;color:var(--text);line-height:1.1;}
  .stat-card .stat-n.warn{color:#fbbf24;}
  .stat-card .stat-n.ok{color:var(--signal);}
  .stat-card .stat-l{font-size:.78rem;color:var(--text-dim);margin-top:4px;}
  .stat-sys{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;background:rgba(15,20,30,.65);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin-bottom:12px;font-size:.85rem;color:var(--text-dim);}
  .stat-sys b{color:var(--text);font-weight:550;}
  .stat-sys .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:baseline;}
  .stat-sys .dot.up{background:var(--signal);box-shadow:0 0 8px var(--signal-glow);}
  .stat-sys .dot.down{background:#f87171;}
  @media (prefers-reduced-motion:reduce){
    *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;}
    .live-dot::after{display:none;}
  }
  :focus-visible{outline:2px solid var(--signal);outline-offset:2px;border-radius:4px;}
</style>
</head>
<body>
<div class="topline"></div>
<header>
  <div class="brand">
    <svg class="mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path d="M20 2.5 34.5 11v18L20 37.5 5.5 29V11L20 2.5Z" stroke="var(--signal)" stroke-width="1.6" stroke-linejoin="round" opacity=".55"/>
      <path d="M20 2.5 34.5 11v18L20 37.5 5.5 29V11L20 2.5Z" fill="rgba(47,230,166,.05)"/>
      <circle cx="20" cy="20" r="3.4" fill="var(--signal)"/>
      <circle cx="13" cy="13.5" r="1.9" fill="var(--info)"/>
      <circle cx="27" cy="13.5" r="1.9" fill="var(--violet)"/>
      <circle cx="20" cy="28.5" r="1.9" fill="var(--text-dim)"/>
      <path d="M20 20 13 13.5M20 20 27 13.5M20 20 20 28.5" stroke="var(--signal)" stroke-width="1.1" opacity=".5"/>
    </svg>
    <div class="wordmark">
      <span class="eyebrow">Operator Console</span>
      <h1>Secure<b>Context</b></h1>
    </div>
  </div>
  <div class="masthead-spacer"></div>
  <div class="status-cluster">
    <span id="badge" class="badge">…</span>
    <div class="live"><span class="live-dot"></span>Live</div>
  </div>
</header>
<nav class="tab-nav" id="dashboard-tabs" aria-label="Dashboard sections">
  <button type="button" class="tab-button" data-tab="overview"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>Overview</button>
  <button type="button" class="tab-button" data-tab="memory"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4a4 4 0 0 0-4 4 4 4 0 0 0-3 6.5A4 4 0 0 0 8 21h8a4 4 0 0 0 3-6.5A4 4 0 0 0 16 8a4 4 0 0 0-4-4Z"/><path d="M12 4v17"/></svg>Memory</button>
  <button type="button" class="tab-button" data-tab="skills"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 6 4 4-9.5 9.5H4.5V15L14 6Z"/><path d="m13 7 4 4"/><path d="M17 3l4 4"/></svg>Skills</button>
  <button type="button" class="tab-button" data-tab="security"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-4Z"/><path d="m9 12 2 2 4-4"/></svg>Security</button>
  <button type="button" class="tab-button" data-tab="knowledge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.2 15.6 8M7.2 8.2l3.6 7.6M16.8 10.2l-3.6 5.6"/></svg>Knowledge</button>
</nav>
<main>

<section class="tab-content" data-tab="overview">
<!-- v0.40.0 — At-a-glance status strip: version/store health + the counts an
     operator actually triages (contradictions, pending mutations, quarantine,
     active agents, auto-extracted facts). Each count card jumps to its tab. -->
<div id="overview-strip"
     hx-get="/dashboard/overview-strip"
     hx-trigger="load, every 30s"
     hx-target="this" hx-swap="innerHTML">
  <p class="empty">Loading system status…</p>
</div>
</section>

<section class="tab-content" data-tab="skills">
<!-- v0.22.6 — Skill-activity health banner. First panel so operators see
     immediately when the closed-loop self-improvement system has gone dark
     on any active project. Polls every 60s (lower frequency than other
     panels because it's a slow-moving signal). -->
<div class="panel">
  <h2>Skill-activity health <span class="sub">closed-loop status per project, 24h</span></h2>
  <div id="skill-health"
       hx-get="/dashboard/skill-health"
       hx-trigger="load, every 60s"
       hx-target="this" hx-swap="innerHTML">
    Loading skill-activity health…
  </div>
</div>
</section>

<section class="tab-content" data-tab="memory">
<!-- v0.33.0 — Suspected memory contradictions. The contradiction detector +
     enrichment cron flag conflicting working-memory facts; this is where the
     operator triages them (keep left / keep right / not a conflict). -->
<div class="panel">
  <h2>Suspected memory contradictions <span class="sub">keep one side, or dismiss — never auto-applied</span></h2>
  <div id="contradictions"
       hx-get="/dashboard/contradictions"
       hx-trigger="load, every 60s"
       hx-target="this" hx-swap="innerHTML">
    Loading suspected contradictions…
  </div>
</div>
</section>

<section class="tab-content" data-tab="knowledge">
<!-- v0.22.7 — Summarizer activity. Operator visibility into the L0/L1
     indexer: how many summaries exist, when they were created, what failed,
     which model is being used. Without this, the operator was blind to
     summarization activity and could only "hope it was working." -->
<div class="panel">
  <h2>Summarizer activity <span class="sub">L0/L1 file summary index — total + last 24h</span></h2>
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
</section>

<section class="tab-content" data-tab="skills">
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
</section>

<section class="tab-content" data-tab="overview">
<!-- v0.25.0 — Live agent activity (last 20 broadcasts, refreshes every 5s) -->
<div class="panel">
  <h2>Live agent activity <span class="sub">last 20 broadcasts, all projects</span></h2>
  <div id="live-broadcasts"
       hx-get="/dashboard/broadcasts"
       hx-trigger="load, every 5s"
       hx-target="this" hx-swap="innerHTML">
    Loading…
  </div>
</div>
</section>

<section class="tab-content" data-tab="skills">
<!-- v0.25.0 — Completed mutations (promotion history with score delta) -->
<div class="panel">
  <h2>Completed mutations <span class="sub">was the skill actually improved?</span></h2>
  <div id="completed-mutations"
       hx-get="/dashboard/mutations/completed"
       hx-trigger="load, every 30s"
       hx-target="this" hx-swap="innerHTML">
    Loading…
  </div>
</div>
</section>

<section class="tab-content" data-tab="security">
<!-- v0.26.0 Step 7 — Filesystem skills security panel.
     Surfaces: chain integrity status, admission log tail, quarantined skills.
     Chain banner refreshes every 30s; quarantine list + admission tail refresh
     on a load trigger so operators see new events without a manual reload. -->
<div class="panel" id="fs-skills-panel">
  <h2>Skill admission security <span class="sub">AST gate · HMAC chain · quarantine</span></h2>

  <details class="fs-git-sync-details" open>
    <summary><strong>Git sync &amp; versioning</strong> <small>(back up ~/.claude/skills to the private repo — commit &amp; push in one click; shows which skills are uncommitted)</small></summary>
    <div id="fs-git-sync"
         hx-get="/dashboard/fs-skills/git-status"
         hx-trigger="load, every 60s"
         hx-target="this" hx-swap="innerHTML">
      Loading git status…
    </div>
  </details>

  <div id="fs-chain-banner"
       hx-get="/dashboard/fs-skills/chain-banner"
       hx-trigger="load, every 30s"
       hx-target="this" hx-swap="innerHTML">
    Loading chain integrity…
  </div>

  <details class="fs-quarantine-details" open>
    <summary><strong>Quarantined skills</strong> <small>(scripts that failed AST scan or frontmatter validation)</small></summary>
    <div id="fs-quarantine-list"
         hx-get="/dashboard/fs-skills/quarantine"
         hx-trigger="load, every 60s"
         hx-target="this" hx-swap="innerHTML">
      Loading quarantine…
    </div>
  </details>

  <details class="fs-admission-details">
    <summary><strong>Recent admission events</strong> <small>(HMAC-chained, tamper-evident)</small></summary>
    <div id="fs-admission-log"
         hx-get="/dashboard/fs-skills/admission-log"
         hx-trigger="load, every 60s"
         hx-target="this" hx-swap="innerHTML">
      Loading admission log…
    </div>
  </details>
</div>
</section>

<section class="tab-content" data-tab="knowledge">
<!-- v0.31.0 — Code/Memory Knowledge Graph (Tier-1 A). SecureContext's OWN reference
     graph (kb_edges/kb_backlinks) over file:/memory:/session: sources, PER PROJECT.
     Node size ∝ backlink in-degree; hubs rank higher in zc_search. FIRST panel on
     the Knowledge tab — it's the system's own graph. Lazy-loaded in a <details>. -->
<div class="panel" id="kb-graph-panel">
  <h2>Knowledge graph — code &amp; memory <span class="sub">per project · file/memory/session references · node size ∝ backlinks</span></h2>
  <details class="wiki-graph-details">
    <summary><strong>Show graph</strong> <small>(loads on first open)</small></summary>
    <div id="kb-graph"
         hx-get="/dashboard/kb-graph"
         hx-trigger="click from:previous summary once"
         hx-target="this" hx-swap="innerHTML">
      <em style="color:#94a3b8; font-size:0.85rem">Click the heading above to load the graph.</em>
    </div>
  </details>
</div>
<!-- v0.30.6 — Personal-wiki KB graph. Operator-curated knowledge base
     (creators / videos / topics / wiki-origin skills) rendered as a d3
     force-directed view. Reads wiki/graph.json produced by the
     personal-wiki/viz/build_graph.py script (which runs at end of
     approve.py and at end of the twice-weekly promotion-check cron).
     SEPARATE from the code/memory graph above. Lazy-loaded in a <details>. -->
<div class="panel" id="wiki-graph-panel">
  <h2>Personal wiki graph <span class="sub">operator-curated content + wiki-origin skills</span></h2>
  <details class="wiki-graph-details">
    <summary><strong>Show graph</strong> <small>(loads on first open)</small></summary>
    <div id="wiki-graph"
         hx-get="/dashboard/wiki-graph"
         hx-trigger="click from:previous summary once"
         hx-target="this" hx-swap="innerHTML">
      <em style="color:#94a3b8; font-size:0.85rem">Click the heading above to load the graph.</em>
    </div>
  </details>
</div>
</section>

<section class="tab-content" data-tab="skills">
<!-- v0.28.0-α — Skill spotter dry-run panel. Mines tool_calls_pg +
     pretool_events_pg for repeated patterns and surfaces them as
     signals the operator can review. No LLM yet; β adds the
     Sonnet-4.6-high-effort agent that turns signals into candidates. -->
<div class="panel" id="skill-spotter-panel">
  <h2>Skill spotter <span class="sub">mines repeated activity patterns into skill candidates</span></h2>

  <div class="spotter-controls">
    <button class="pull-marketplace-btn"
            hx-post="/dashboard/spotter/dry-run?days=7"
            hx-target="#spotter-dry-run-result" hx-swap="innerHTML"
            hx-on:htmx:before-request="this.disabled=true; this.textContent='Mining…'"
            hx-on:htmx:after-request="this.disabled=false; this.textContent='🔎 Run dry-run (7d)'; htmx.trigger('#spotter-runs-list', 'refresh')">
      🔎 Run dry-run (7d)
    </button>
    <button class="pull-marketplace-btn"
            hx-post="/dashboard/spotter/dry-run?days=30"
            hx-target="#spotter-dry-run-result" hx-swap="innerHTML"
            hx-on:htmx:before-request="this.disabled=true; this.textContent='Mining…'"
            hx-on:htmx:after-request="this.disabled=false; this.textContent='🔎 Run dry-run (30d)'; htmx.trigger('#spotter-runs-list', 'refresh')">
      🔎 Run dry-run (30d)
    </button>
    <span class="market-meta">Mines repeated tool sequences + repeated doc reads across sessions. Surfaces patterns the operator can review before β enables the LLM-driven candidate filer.</span>
  </div>
  <div id="spotter-dry-run-result"></div>

  <div id="spotter-runs-list"
       hx-get="/dashboard/spotter/runs"
       hx-trigger="load, refresh from:body"
       hx-target="this" hx-swap="innerHTML"
       style="margin-top:12px">
    Loading spotter runs…
  </div>
</div>
</section>

<section class="tab-content" data-tab="skills">
<div class="panel">
  <h2>Active skills <span class="sub">edit frontmatter — body is mutator-managed</span></h2>
  <!-- v0.25.0: + New skill button — opens an inline form, posts to
       /dashboard/skills/new which routes through storage_dual.upsertSkill
       (lint + 8-point scan gates run; rejection = inline error). -->
  <div class="skill-create-actions">
    <button class="new-skill-btn"
            hx-get="/dashboard/skills/new-form"
            hx-target="#new-skill-zone" hx-swap="innerHTML">
      + New skill
    </button>
    <span class="new-skill-meta">Operator-authored skill — lint + security gates apply just like any other source.</span>
  </div>
  <div id="new-skill-zone"></div>
  <div id="skills"
       hx-get="/dashboard/skills"
       hx-trigger="load, every 30s[!document.querySelector('#skills input:focus, #skills textarea:focus, #skills select:focus, #skills details[open], #skills .skill-edit-zone:not(:empty)')]"
       hx-target="this" hx-swap="innerHTML">
    Loading…
  </div>
</div>
</section>

<section class="tab-content" data-tab="skills">
<!-- v0.24.0 Phase 2 — marketplace pulls panel -->
<div class="panel">
  <h2>Marketplace pulls <span class="sub">skill imports — what was added vs rejected, and why</span></h2>
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
</section>

<section class="tab-content" data-tab="knowledge">
<div class="panel">
  <h2>Token savings <span class="sub">estimated, vs counterfactual native flow</span></h2>
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
          } else {
            // v0.25.2 — auto-pick the most-active project on first load.
            // Operator was confused that "Token savings" appeared empty even
            // though A2A_communication had 1.1M tokens saved — the panel
            // default was 'pick a project above' until the operator clicked
            // the dropdown. Now: first non-empty option auto-selects so the
            // panel renders real data immediately.
            const firstOpt = Array.from(sel.options).find(o => o.value);
            if (firstOpt) {
              sel.value = firstOpt.value;
              // Trigger change so the trend + breakdown load
              sel.dispatchEvent(new Event('change'));
            }
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
</section>

<section class="tab-content" data-tab="skills">
<!-- v0.19.0 Sprint 2.10 — Skill candidates panel (REJECT clusters → propose new skill) -->
<div class="panel">
  <h2>Skill candidates <span class="sub">from REJECT patterns + spotter auto-filing</span></h2>
  <!-- v0.20.1 — same focus-aware filter as #pending; don't blow away an
       operator who's mid-edit on the proposed skill body or notes. -->
  <div id="skill-candidates"
       hx-get="/dashboard/skill-candidates"
       hx-trigger="load, every 30s[!document.querySelector('#skill-candidates input:focus, #skill-candidates textarea:focus, #skill-candidates select:focus, #skill-candidates details[open]')]"
       hx-swap="innerHTML">
    <p class="empty">Loading skill candidates…</p>
  </div>
</div>
</section>

<footer>
  Local operator console, embedded in <code>sc-api</code> at <code>:3099/dashboard</code>.
  Overview · Memory · Skills · Security · Knowledge.
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
<script>
// v0.30.7 — tab switcher for the dashboard. Active tab persisted in
// localStorage so a refresh keeps you on the section you were just viewing.
// Default tab = 'skills' because that's where the actionable Pending
// mutation reviews live.
(function tabSwitcher() {
  var KEY = 'sc-dashboard-active-tab-v2'; // v2: overview/memory/skills/security/knowledge
  function applyTab(name) {
    document.querySelectorAll('.tab-button').forEach(function (b) {
      b.classList.toggle('tab-active', b.dataset.tab === name);
    });
    document.querySelectorAll('section.tab-content').forEach(function (s) {
      s.classList.toggle('tab-content-active', s.dataset.tab === name);
    });
    try { localStorage.setItem(KEY, name); } catch (e) { /* private mode etc */ }
  }
  function init() {
    var buttons = document.querySelectorAll('.tab-button');
    buttons.forEach(function (b) {
      b.addEventListener('click', function () { applyTab(b.dataset.tab); });
    });
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
    var validTabs = Array.from(buttons).map(function (b) { return b.dataset.tab; });
    var initialTab = (saved && validTabs.indexOf(saved) !== -1) ? saved : 'overview';
    applyTab(initialTab);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
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
  // v0.26.0 Step 7 — present only on filesystem-sourced rows (Anthropic-style
  // ~/.claude/skills/<name>/ directories); used to render the 📁 filesystem
  // badge + script count.
  skill_dir?:    string | null;
  script_hmacs?: Record<string, string> | null;
}

export function renderSkillsListFragment(
  rows: Array<Record<string, unknown>>,
  projectNameMap: Map<string, string> = new Map(),
  efficiencyMap: Map<string, { avg_tokens: number; run_count: number }> = new Map(),
  // v0.25.0 — last-N scored runs per skill, used to render a sparkline trend
  scoreTrendMap: Map<string, Array<{ ts: string; score: number | null }>> = new Map(),
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
      // v0.26.0 Step 7 — propagate FS-source fields for the 📁 badge
      skill_dir:    typeof r.skill_dir === "string" ? r.skill_dir : null,
      script_hmacs: (r.script_hmacs && typeof r.script_hmacs === "object")
        ? r.script_hmacs as Record<string, string>
        : null,
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
      const tags = (fm?.tags as string[] | undefined) ?? [];
      const guidance = String((fm?.mutation_guidance as string | undefined) ?? "");
      const intendedHtml = intended.length > 0
        ? intended.map((r) => `<code class="role-tag">${escapeHtml(r)}</code>`).join(" ")
        : `<span style="color:#6b7280; font-style:italic">no intended_roles</span>`;
      // v0.24.2 — source badge so operator can tell at a glance whether
      // a skill came from marketplace, role-extraction, or custom-authored.
      // Order matters: filesystem (v0.26.0) > marketplace > role-extracted > custom (most-specific first).
      const isMarketplace = tags.includes("marketplace");
      const isRoleExtracted = tags.includes("role-extracted");
      // v0.26.0 Step 7 — distinct badge for filesystem-sourced skills
      // (Anthropic-style ~/.claude/skills/<name>/ directory). Detect by
      // presence of skill_dir column (only set by filesystem_skill_import.ts).
      const isFilesystem = typeof s.skill_dir === "string" && s.skill_dir.length > 0;
      const scriptHmacs = s.script_hmacs;
      const scriptCount = scriptHmacs && typeof scriptHmacs === "object" && !Array.isArray(scriptHmacs)
        ? Object.keys(scriptHmacs).filter((k) => k.startsWith("scripts/")).length
        : 0;
      const sourceBadge = isFilesystem
        ? `<span class="src-badge src-filesystem" title="Anthropic-style filesystem skill at ${escapeHtml(String(s.skill_dir ?? ""))}; ${scriptCount} bundled script(s) HMAC-verified at admission">📁 filesystem${scriptCount > 0 ? ` <small>· ${scriptCount} script${scriptCount === 1 ? "" : "s"}</small>` : ""}</span>`
        : isMarketplace
          ? `<span class="src-badge src-marketplace" title="Imported from anthropics/skills marketplace">🛒 marketplace</span>`
          : isRoleExtracted
            ? `<span class="src-badge src-role-extracted" title="Auto-extracted from a role's deepPrompt during system bootstrap">🤖 role-extracted</span>`
            : `<span class="src-badge src-custom" title="Custom-authored skill (operator or mutator-promoted)">👤 custom</span>`;
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
      // v0.25.0 — score-trend sparkline. Inline SVG showing last N scored runs.
      const trend = scoreTrendMap.get(s.skill_id) ?? [];
      const sparklineHtml = trend.length >= 2
        ? `<span class="skill-trend">trend: ${renderSparkline(trend)}</span>`
        : "";
      return `
        <div class="skill-row" data-skill-id="${escapeHtml(s.skill_id)}">
          <div class="skill-header">
            <span class="skill-name">${escapeHtml(s.name)} <span style="color:#94a3b8">v${escapeHtml(s.version)}</span> ${sourceBadge}</span>
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
              <button class="body-btn"
                      title="v0.24.1 — view the actual procedural body of this skill (what the agent sees)"
                      hx-get="/dashboard/skills/${encodeURIComponent(s.skill_id)}/body"
                      hx-target="next .skill-edit-zone" hx-swap="innerHTML">
                📄 View body
              </button>
            </span>
          </div>
          <div class="skill-meta">
            ${escapeHtml(s.description || "(no description)")}<br>
            roles: ${intendedHtml}<br>
            ${effHtml}${sparklineHtml ? ` &middot; ${sparklineHtml}` : ""}
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

/**
 * v0.33.0 — Suspected-contradictions review panel. Renders open memory contradictions
 * (from memory_contradictions_pg, joined to the fact values for context) as cards with
 * Accept / Discard / Ignore actions. Each card is a tiny form (hidden inputs + a named
 * submit button per action) so special chars in keys/values can't break attribute quoting;
 * the POST swaps the card via outerHTML. NEVER auto-applies — operator decides.
 */
export function renderContradictionsFragment(
  rows: Array<Record<string, unknown>>,
  projectNameMap: Map<string, string> = new Map(),
  autoRows: Array<Record<string, unknown>> = [],
): string {
  // v0.37.0 — auto-resolved supersessions (stale side retired automatically), each undoable.
  const autoSection = autoRows.length === 0 ? "" : `
<details class="contra-auto" style="margin-top:14px">
  <summary style="cursor:pointer;color:#2fe6a6;font-weight:600">⚙ Auto-resolved supersessions (last 7 days: ${autoRows.length}) — stale facts retired automatically, click to review / undo</summary>
  ${autoRows.map((r) => {
    const ph2 = String(r.project_hash ?? ""); const agent = String(r.agent_id ?? "default");
    const name = projectNameMap.get(ph2);
    return `
  <div class="contra-card" style="border-left-color:#2fe6a6">
    <div class="contra-head">
      <span style="color:#2fe6a6;font-weight:600">✓ auto-resolved</span>
      <span class="contra-sim">sim ${r.similarity == null ? "?" : Number(r.similarity).toFixed(2)}</span>
      <span class="contra-proj">${name ? escapeHtml(name) : "project:" + escapeHtml(ph2.slice(0, 8)) + "…"}</span>
    </div>
    <div style="font-size:.85rem;color:#c3ccd9;margin-bottom:10px">${escapeHtml(String(r.detail ?? "").slice(0, 260))}</div>
    <form class="contra-actions" hx-post="/dashboard/contradictions/review" hx-target="closest .contra-card" hx-swap="outerHTML">
      <input type="hidden" name="project_hash" value="${escapeHtml(ph2)}">
      <input type="hidden" name="agent_id" value="${escapeHtml(agent)}">
      <input type="hidden" name="key_a" value="${escapeHtml(String(r.key_a ?? ""))}">
      <input type="hidden" name="key_b" value="${escapeHtml(String(r.key_b ?? ""))}">
      <button type="submit" name="action" value="undo" class="contra-discard" title="Revive the retired fact and reopen the pair for triage">↩ Undo</button>
    </form>
  </div>`;
  }).join("\n")}
</details>`;

  if (rows.length === 0) {
    return `<p class="empty">No suspected contradictions — working memory is consistent. ✓</p>${autoSection}`;
  }
  const reasonLabel: Record<string, string> = {
    semantic_conflict:   "opposite polarity",
    decision_reversal:   "decision reversed",
    resolution_conflict: "resolved-vs-live",
  };
  return rows.map((r) => {
    const ph    = String(r.project_hash ?? "");
    const agent = String(r.agent_id ?? "default");
    const ka    = String(r.key_a ?? "");
    const kb    = String(r.key_b ?? "");
    const reason = String(r.reason ?? "");
    const sim   = r.similarity == null ? "" : Number(r.similarity).toFixed(2);
    const va    = r.value_a == null ? "(fact no longer present)" : String(r.value_a);
    const vb    = r.value_b == null ? "(fact no longer present)" : String(r.value_b);
    const name  = projectNameMap.get(ph);
    const projectLabel = name
      ? `<span class="project-name" title="project_hash: ${escapeHtml(ph)}">${escapeHtml(name)}</span>`
      : `<span class="project-name unresolved" title="hash ${escapeHtml(ph)}">project:${escapeHtml(ph.slice(0, 8))}…</span>`;
    const hidden =
      `<input type="hidden" name="project_hash" value="${escapeHtml(ph)}">` +
      `<input type="hidden" name="agent_id" value="${escapeHtml(agent)}">` +
      `<input type="hidden" name="key_a" value="${escapeHtml(ka)}">` +
      `<input type="hidden" name="key_b" value="${escapeHtml(kb)}">`;
    return `
<div class="contra-card">
  <div class="contra-head">
    <span class="contra-reason">⚠️ ${escapeHtml(reasonLabel[reason] ?? reason)}</span>
    ${sim ? `<span class="contra-sim">sim ${escapeHtml(sim)}</span>` : ""}
    <span class="contra-proj">${projectLabel}${agent !== "default" ? ` · <code>${escapeHtml(agent)}</code>` : ""}</span>
  </div>
  <div class="contra-pair">
    <div class="contra-side"><code>${escapeHtml(ka)}</code><div class="contra-val">${escapeHtml(va.slice(0, 240))}</div></div>
    <div class="contra-vs">⇄</div>
    <div class="contra-side"><code>${escapeHtml(kb)}</code><div class="contra-val">${escapeHtml(vb.slice(0, 240))}</div></div>
  </div>
  <form class="contra-actions" hx-post="/dashboard/contradictions/review" hx-target="closest .contra-card" hx-swap="outerHTML">
    ${hidden}
    <button type="submit" name="action" value="keep_a" class="contra-accept"  title="Keep the LEFT fact — retire the right one (archived to the KB, undoable)">⯇ Keep left</button>
    <button type="submit" name="action" value="keep_b" class="contra-accept"  title="Keep the RIGHT fact — retire the left one (archived to the KB, undoable)">Keep right ⯈</button>
    <button type="submit" name="action" value="not_conflict" class="contra-ignore" title="Both facts are valid — dismiss the flag; this pair won't be re-flagged">✕ Not a conflict</button>
  </form>
</div>`;
  }).join("\n") + autoSection;
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

  // v0.25.2: 4-state classification (was 3). Distinguishing "in-progress"
  // from "broken" matters: a freshly-started session may have skill_show
  // calls (agents loaded skills) but no outcomes yet (MERGE hasn't fired).
  // Calling that "BROKEN" panicked the operator during real-project use.
  //
  //   broken    — broadcasts but no skill_show: agents not loading skills
  //   partial   — outcomes but no skill_show in 7d: scoring without loading
  //   inProgress— skill_show but no outcomes in 24h: agents loaded, working
  //   healthy   — skill_runs + skill_show both > 0
  const broken     = rows.filter((r) => r.skill_show_calls_24h === 0 && r.skill_runs_24h === 0);
  const partial    = rows.filter((r) => r.skill_runs_24h > 0 && r.skill_show_calls_24h === 0);
  const inProgress = rows.filter((r) => r.skill_runs_24h === 0 && r.skill_show_calls_24h > 0);
  const healthy    = rows.filter((r) => r.skill_runs_24h > 0 && r.skill_show_calls_24h > 0);

  const renderProjectRow = (r: SkillHealthRow, severity: "bad" | "warn" | "info" | "ok"): string => {
    const name = r.project_name ?? r.project_hash.slice(0, 12);
    const icon = severity === "bad" ? "✗" : severity === "warn" ? "⚠" : severity === "info" ? "⏳" : "✓";
    const detail = severity === "bad"
      ? `${r.broadcasts_24h} broadcasts, 0 zc_skill_show calls — agents aren't loading skills (skill enforcement lever may not be in their system prompts)`
      : severity === "warn"
        ? `${r.skill_runs_24h} outcomes recorded but 0 zc_skill_show calls in last 7d — scoring without loading`
        : severity === "info"
          ? `${r.broadcasts_24h} broadcasts · ${r.skill_show_calls_24h} skill_show — task in progress, MERGE pending (outcome will land at MERGE)`
          : `${r.skill_runs_24h} skill_runs · ${r.skill_show_calls_24h} skill_show · ${r.unique_agents} agent(s)`;
    // v0.25.3: per-project "which skills did agents use today" rollup
    // (operator-asked feature — was only available by drilling into each
    // skill's Recent runs button). Inline expand reveals a table showing
    // skill_id × calls × outcomes × agents × latest score for the project.
    const showSkillsBtn = (severity === "info" || severity === "ok")
      ? `<button class="proj-skills-btn"
                title="Show which skills agents on this project used in the last 24h"
                hx-get="/dashboard/projects/${encodeURIComponent(r.project_hash)}/skills-used"
                hx-target="next .proj-skills-zone" hx-swap="innerHTML">
          📋 Skills used
        </button>`
      : "";
    return `<div class="skill-health-row skill-health-${severity}">
      <span class="skill-health-icon">${icon}</span>
      <span class="skill-health-name" title="project_hash=${r.project_hash}">${escapeHtml(name)}</span>
      <span class="skill-health-detail">${escapeHtml(detail)}</span>
      ${showSkillsBtn}
    </div>
    <div class="proj-skills-zone"></div>`;
  };

  const lines: string[] = [];

  // Banner header — pick the most-severe applicable state.
  if (broken.length > 0) {
    lines.push(`<div class="skill-health-banner skill-health-banner-bad">
      <strong>${broken.length} project${broken.length === 1 ? "" : "s"} broadcasting without loading skills</strong>
      — agents aren't calling <code>zc_skill_show</code>. Likely fix: respawn
      agents so they pick up the latest spawn-agent.ps1 with the skill
      enforcement levers in their system prompts. See SecureContext v0.22.5+.
    </div>`);
  } else if (partial.length > 0) {
    lines.push(`<div class="skill-health-banner skill-health-banner-warn">
      <strong>${partial.length} project${partial.length === 1 ? "" : "s"} recording outcomes without loading skill bodies</strong>
      — agents are scoring skills they never read. The pre-task
      <code>zc_skill_show</code> mandate may not be firing.
    </div>`);
  } else if (inProgress.length > 0 && healthy.length === 0) {
    lines.push(`<div class="skill-health-banner skill-health-banner-info">
      <strong>${inProgress.length} project${inProgress.length === 1 ? "" : "s"} with task in progress</strong>
      — agents have loaded skills, MERGE pending. Outcomes will land when the
      developer broadcasts MERGE.
    </div>`);
  } else if (healthy.length > 0 && inProgress.length === 0) {
    lines.push(`<div class="skill-health-banner skill-health-banner-ok">
      <strong>All ${healthy.length} active project${healthy.length === 1 ? " is" : "s are"} healthy.</strong>
      Each is loading skills before work and recording outcomes at MERGE.
    </div>`);
  } else if (healthy.length > 0 || inProgress.length > 0) {
    const total = healthy.length + inProgress.length;
    lines.push(`<div class="skill-health-banner skill-health-banner-ok">
      <strong>All ${total} active project${total === 1 ? " is" : "s are"} healthy.</strong>
      ${healthy.length} have completed task cycles; ${inProgress.length} have a task in progress.
    </div>`);
  }

  // Per-project detail rows — most severe first.
  for (const r of broken)     lines.push(renderProjectRow(r, "bad"));
  for (const r of partial)    lines.push(renderProjectRow(r, "warn"));
  for (const r of inProgress) lines.push(renderProjectRow(r, "info"));
  for (const r of healthy)    lines.push(renderProjectRow(r, "ok"));

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

// v0.25.0 — Operator-create-skill form (rendered inline, posts to /dashboard/skills/new)
export function renderNewSkillForm(
  roles: string[],
  projects: Array<{ hash: string; name: string }> = [],
): string {
  const roleOptions = roles.slice(0, 80).map((r) =>
    `<label class="role-checkbox"><input type="checkbox" name="intended_roles" value="${escapeHtml(r)}"> ${escapeHtml(r)}</label>`
  ).join("");
  // v0.30.2 — enumerate known projects so the operator can author a
  // project-scoped skill from the dashboard (was global-only in v0.25.0).
  // Values use the canonical `project:<hash>` form that loader.ts validates.
  const projectOptions = projects.slice(0, 60).map((p) =>
    `<option value="project:${escapeHtml(p.hash)}">project: ${escapeHtml(p.name)} (${escapeHtml(p.hash.slice(0, 8))}…)</option>`
  ).join("");
  return `
    <form class="new-skill-form" hx-post="/dashboard/skills/new" hx-target="#new-skill-zone" hx-swap="innerHTML">
      <div class="form-banner">
        Create a new operator-authored skill. Body must be ≥100 chars. Lint
        gates apply: needs <code>## Goal</code> + <code>## Steps</code>
        sections to avoid warnings (recommended) and proper frontmatter.
        Skill lands as <strong>👤 custom</strong> and the admission is
        appended to the HMAC-chained <code>skill_admission_log_pg</code>.
      </div>
      <label>
        <strong>name</strong> <small>(kebab-case, no spaces)</small>
        <input type="text" name="name" required pattern="[a-z][a-z0-9-]+" placeholder="my-custom-skill" maxlength="64">
      </label>
      <div class="form-row">
        <label>
          <strong>version</strong>
          <input type="text" name="version" value="1.0.0" pattern="\\d+(\\.\\d+){0,2}" required>
        </label>
        <label>
          <strong>scope</strong> <small>(global = visible to every project; project = scoped to one)</small>
          <select name="scope">
            <option value="global" selected>global</option>
            ${projectOptions}
          </select>
        </label>
      </div>
      <label>
        <strong>description</strong> <small>(≥30 chars; agents match skills by description)</small>
        <input type="text" name="description" required minlength="30" maxlength="500" placeholder="A clear one-line description of what this skill does and when to use it.">
      </label>
      <label>
        <strong>intended_roles</strong> <small>(pick the roles that should auto-load this skill at session start)</small>
        <details class="role-picker">
          <summary>Select roles…</summary>
          <div class="role-checkbox-grid">${roleOptions}</div>
        </details>
      </label>
      <label>
        <strong>body</strong> <small>(markdown — the procedural instructions the agent will follow)</small>
        <textarea name="body" required minlength="100" rows="14" placeholder="## Goal&#10;What this skill achieves.&#10;&#10;## Steps&#10;1. First step&#10;2. Second step&#10;&#10;## Examples&#10;- example 1&#10;&#10;## Guidelines&#10;- be careful with X"></textarea>
      </label>
      <div class="form-actions">
        <button type="submit" class="apply-polish-btn">Create skill</button>
        <button type="button" class="edit-btn" onclick="document.getElementById('new-skill-zone').innerHTML=''">Cancel</button>
      </div>
    </form>
  `;
}

// v0.25.3 — per-project skills usage rollup
//
// "Which skills did the agents on this project actually use today?" — a
// question the dashboard couldn't answer at the project level until now.
// (Recent runs button per-skill answered it per-skill; this gives the
// project-wide view operator wanted.)

export interface ProjectSkillUsageRow {
  skill_id:    string;
  shows:       number;
  outcomes:    number;
  runs_24h:    number;
  avg_score:   number | null;
  latest_score: number | null;
  agents:      string;     // comma-separated agent_ids
  last_used:   string;     // ISO ts
}

export function renderProjectSkillsUsed(projectHash: string, rows: ProjectSkillUsageRow[]): string {
  if (rows.length === 0) {
    return `<div class="proj-skills-empty">No skills called on this project in the last 24h.</div>`;
  }
  const trs = rows.map((r) => {
    const when = r.last_used.slice(0, 19).replace("T", " ");
    const score = r.latest_score === null
      ? `<span class="dim">—</span>`
      : `<span class="score score-${r.latest_score >= 0.8 ? "high" : r.latest_score >= 0.5 ? "mid" : "low"}">${r.latest_score.toFixed(2)}</span>`;
    const avg = r.avg_score === null
      ? `<span class="dim">—</span>`
      : `<span class="score score-${r.avg_score >= 0.8 ? "high" : r.avg_score >= 0.5 ? "mid" : "low"}">${r.avg_score.toFixed(2)}</span>`;
    return `
      <tr>
        <td class="mono small"><code>${escapeHtml(r.skill_id)}</code></td>
        <td>${r.shows}</td>
        <td>${r.outcomes}</td>
        <td>${score}</td>
        <td>${avg}</td>
        <td class="mono small">${escapeHtml(r.agents)}</td>
        <td class="mono small">${escapeHtml(when)}</td>
      </tr>
    `;
  }).join("");
  const totalShows = rows.reduce((s, r) => s + r.shows, 0);
  const totalOutcomes = rows.reduce((s, r) => s + r.outcomes, 0);
  return `
    <div class="proj-skills-table">
      <div class="proj-skills-header">
        <strong>Skills used in last 24h</strong>
        <span class="proj-skills-meta">${rows.length} distinct skill${rows.length === 1 ? "" : "s"} · ${totalShows} loads · ${totalOutcomes} outcomes</span>
      </div>
      <table class="runs-table">
        <thead><tr>
          <th>Skill</th><th>Loads</th><th>Outcomes</th><th>Latest score</th><th>Avg score</th><th>Used by</th><th>Last call</th>
        </tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>
  `;
}

// v0.25.0 — score-trend sparkline. Tiny SVG, last N runs.
export function renderSparkline(scores: Array<{ ts: string; score: number | null }>, width: number = 100, height: number = 22): string {
  const valid = scores.filter((s) => s.score !== null && Number.isFinite(s.score)) as Array<{ ts: string; score: number }>;
  if (valid.length < 2) {
    return `<span class="sparkline-empty" title="Need ≥2 scored runs for trend">—</span>`;
  }
  const xs = valid.map((_, i) => (i / (valid.length - 1)) * (width - 2) + 1);
  // Y: flip so 1.0 is at top, 0 at bottom
  const ys = valid.map((s) => (1 - s.score) * (height - 2) + 1);
  const points = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const lastScore = valid[valid.length - 1].score;
  const firstScore = valid[0].score;
  const delta = lastScore - firstScore;
  const deltaCls = delta > 0.05 ? "trend-up" : delta < -0.05 ? "trend-down" : "trend-flat";
  const deltaTxt = delta > 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
  return `
    <svg class="sparkline ${deltaCls}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" title="Score trend across last ${valid.length} runs (Δ${deltaTxt})">
      <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <circle cx="${xs[xs.length - 1].toFixed(1)}" cy="${ys[ys.length - 1].toFixed(1)}" r="2" fill="currentColor"/>
    </svg>
    <span class="sparkline-label ${deltaCls}">${lastScore.toFixed(2)}<small>${deltaTxt}</small></span>
  `;
}

// v0.25.0 — completed mutations panel (promotions history)
export interface CompletedMutationRow {
  mutation_id:        string;
  parent_skill_id:    string;
  promoted_to:        string | null;
  judge_score:        number | null;
  replay_score:       number | null;
  judge_rationale:    string | null;
  promoted:           boolean;
  resolved_at:        string;
  proposed_by:        string;
}

export function renderCompletedMutations(rows: CompletedMutationRow[]): string {
  if (rows.length === 0) {
    return `<p class="empty">No completed mutations yet. Once the L1 mutation cycle promotes a candidate (or rejects one), it will appear here with the score delta and rationale.</p>`;
  }
  const trs = rows.map((r) => {
    const when = r.resolved_at.slice(0, 19).replace("T", " ");
    const verdict = r.promoted
      ? `<span class="badge ok">PROMOTED</span>`
      : `<span class="badge dim-badge">rejected</span>`;
    const score = r.judge_score !== null
      ? `<span class="score score-${r.judge_score >= 0.8 ? "high" : r.judge_score >= 0.5 ? "mid" : "low"}">${r.judge_score.toFixed(2)}</span>`
      : `<span class="dim">—</span>`;
    const replay = r.replay_score !== null
      ? `<span class="score score-${r.replay_score >= 0.8 ? "high" : r.replay_score >= 0.5 ? "mid" : "low"}">${r.replay_score.toFixed(2)}</span>`
      : `<span class="dim">—</span>`;
    return `
      <tr>
        <td class="mono small">${escapeHtml(when)}</td>
        <td>${verdict}</td>
        <td class="mono small">${escapeHtml(r.parent_skill_id)}${r.promoted_to ? ` <span style="color:#4ade80">→</span> <code>${escapeHtml(r.promoted_to)}</code>` : ""}</td>
        <td>${score}</td>
        <td>${replay}</td>
        <td class="reason-cell">${escapeHtml(r.judge_rationale ?? "(no rationale)")}</td>
        <td class="mono small">${escapeHtml(r.proposed_by)}</td>
      </tr>
    `;
  }).join("");
  return `
    <table class="mutations-table">
      <thead><tr>
        <th>When</th><th>Verdict</th><th>Skill</th><th>Judge</th><th>Replay</th><th>Rationale</th><th>Proposer</th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}

// v0.25.0 — live broadcasts feed
export interface BroadcastRow {
  id:           number;
  agent_id:     string;
  type:         string;
  task:         string;
  state:        string;
  created_at:   string;
  project_hash: string;
  project_name: string | null;
}

export function renderLiveBroadcasts(rows: BroadcastRow[]): string {
  if (rows.length === 0) {
    return `<p class="empty">No recent broadcasts. Once you launch agents (start-agents.ps1) and send the orchestrator a task, you'll see ASSIGN / STATUS / MERGE traffic here in real time.</p>`;
  }
  const trs = rows.map((r) => {
    const when = r.created_at.slice(0, 19).replace("T", " ");
    const typeBadge = `<span class="bcast-type bcast-${escapeHtml(r.type.toLowerCase())}">${escapeHtml(r.type)}</span>`;
    const project = r.project_name ?? r.project_hash.slice(0, 8) + "…";
    const stateText = r.state ? r.state.slice(0, 100) : "";
    return `
      <tr>
        <td class="mono small">${escapeHtml(when)}</td>
        <td>${typeBadge}</td>
        <td class="mono small">${escapeHtml(r.agent_id)}</td>
        <td class="mono small">${escapeHtml(r.task ?? "—")}</td>
        <td class="state-cell">${escapeHtml(stateText)}</td>
        <td class="mono small">${escapeHtml(project)}</td>
      </tr>
    `;
  }).join("");
  return `
    <table class="broadcasts-table">
      <thead><tr>
        <th>When</th><th>Type</th><th>Agent</th><th>Task</th><th>State</th><th>Project</th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}

// v0.24.1 — View body for active + marketplace-rejected skills
export interface SkillBodyView {
  skill_id:    string;
  body:        string;
  body_len:    number;
  body_lines:  number;
  source:      "active" | "rejected_marketplace";
  /** For rejected marketplace skills: the decision_reason so operator knows why */
  reason?:     string;
}

export function renderSkillBody(v: SkillBodyView): string {
  const tooLong = v.body_len > 25000;
  const longWarning = tooLong
    ? `<div class="skill-body-warning">⚠ Body is ${fmt(v.body_len)} chars (~${v.body_lines} lines). Anthropic's guidance is "under 500 lines" — consider progressive disclosure (split into SKILL.md + reference.md + examples.md) before applying.</div>`
    : "";
  const rejectedNote = v.source === "rejected_marketplace" && v.reason
    ? `<div class="skill-body-warning" style="background:#450a0a; border-color:#ef4444; color:#fecaca">✗ Rejected by marketplace pull: ${escapeHtml(v.reason)}</div>`
    : "";
  return `
    <div class="skill-body-view">
      <div class="skill-body-header">
        <strong>📄 Skill body</strong>
        <span class="skill-body-meta"><code>${escapeHtml(v.skill_id)}</code> · ${fmt(v.body_len)} chars · ${v.body_lines} lines · source: <code>${v.source}</code></span>
      </div>
      ${rejectedNote}
      <div class="skill-body-text">${escapeHtml(v.body)}</div>
      ${longWarning}
    </div>
  `;
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
  /** v0.24.1: pull row's id (BIGSERIAL) so we can fetch the body via the new endpoint */
  pull_row_id:       number;
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
    // v0.24.1: View body link — works for ALL decisions (added/rejected/error)
    // because we now persist candidate_body on every audit row. Endpoint
    // fetches the body and renders it scrollable below the table.
    const viewBodyLink = `<button class="pull-body-btn"
      title="View the actual SKILL.md body that was attempted"
      hx-get="/dashboard/marketplace/pulls/row/${r.pull_row_id}/body"
      hx-target="next .pull-body-zone" hx-swap="innerHTML">
      📄 View body
    </button>`;
    return `
      <tr class="${decisionClass}">
        <td class="mono small">${escapeHtml(r.skill_name)}</td>
        <td><strong>${decisionLabel}</strong></td>
        <td>${lintCol}</td>
        <td>${scanCol}</td>
        <td class="reason-cell">${escapeHtml(r.decision_reason)}${errorList}${blockList}</td>
        <td class="mono small">${viewBodyLink}<br><code style="display:block; margin-top:4px">${escapeHtml(r.source_path)}</code></td>
      </tr>
      <tr class="pull-body-row"><td colspan="6"><div class="pull-body-zone"></div></td></tr>
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

// ─────────────────────────────────────────────────────────────────────
// v0.30.6 — Personal-wiki KB graph fragment.
// Reads wiki/graph.json produced by personal-wiki/viz/build_graph.py
// and emits an inline d3-rendered force-directed graph for the
// /dashboard/wiki-graph endpoint.
//
// Wiki root is resolved via the PERSONAL_WIKI_ROOT env var (falls back
// to the hard-coded path for the primary operator). When the snapshot
// is missing or empty, we return a friendly help fragment instead of
// throwing — the panel should never look broken just because the wiki
// isn't populated yet.
//
// d3.js is loaded lazily from the CDN inside the fragment. If the
// dashboard page already has d3 loaded (e.g. from another panel) the
// fragment reuses it; otherwise it injects a one-shot <script> tag.
// ─────────────────────────────────────────────────────────────────────

/**
 * v0.31.0 — Code/Memory Knowledge Graph panel (Tier-1 A). DISTINCT from the wiki KB graph:
 * this is SecureContext's OWN reference graph (kb_edges/kb_backlinks) over file:/memory:/session:
 * sources, PER PROJECT. Node size ∝ backlink weighted-in (hubs are visually largest — they also
 * rank higher in zc_search). Data is fetched server-side via store.graphData() and passed in by
 * the /dashboard/kb-graph endpoint. Never reads the personal-wiki graph.json.
 */
export function renderKbGraphFragment(
  data: { nodes: Array<{ id: string; inDegree: number; weightedIn: number }>; edges: Array<{ from: string; to: string; relation: string; weight: number }> },
  projectPath: string,
  projects: Array<{ path: string; label: string }> = [],
): string {
  // v0.35.0 — project PICKER (populated from knowledge_entries × project_paths_pg) replaces
  // the raw absolute-path input. Auto-submits on change. Falls back to the free-text input
  // when no PG project list is available (SQLite-only install), so nothing regresses.
  const picker = projects.length
    ? `<select name="projectPath" onchange="this.form.requestSubmit()"
             style="flex:1; min-width:280px; padding:7px 10px; background:#0a0e16; border:1px solid #1d2634; border-radius:8px; color:#c3ccd9; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:0.8rem; cursor:pointer">
        <option value="">— select a project —</option>
        ${projects.map((p) => `<option value="${escapeHtml(p.path)}"${p.path === projectPath ? " selected" : ""}>${escapeHtml(p.label)}</option>`).join("")}
      </select>`
    : `<input name="projectPath" value="${escapeHtml(projectPath)}" placeholder="absolute project path"
             style="flex:1; min-width:280px; padding:7px 10px; background:#0a0e16; border:1px solid #1d2634; border-radius:8px; color:#c3ccd9; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:0.8rem">`;
  const form = `
    <form hx-get="/dashboard/kb-graph" hx-target="#kb-graph" hx-swap="innerHTML"
          style="display:flex; gap:8px; margin:0 0 12px 0; flex-wrap:wrap">
      ${picker}
      <button type="submit" style="padding:7px 14px; background:#16241c; border:1px solid #2fe6a6; color:#2fe6a6; border-radius:8px; cursor:pointer; font-size:0.82rem">Load graph</button>
    </form>`;

  if (!projectPath) {
    return `${form}<div style="padding:14px; color:#94a3b8; font-size:0.88rem; line-height:1.55">
      ${projects.length ? "<strong>Select a project</strong>" : "Enter an <strong>absolute project path</strong>"} to view its code/memory knowledge graph —
      SecureContext's own reference graph over <code>file:</code>/<code>memory:</code>/<code>session:</code> sources,
      <strong>separate from the personal-wiki graph</strong>. It builds automatically as the project's KB is indexed;
      run <code>zc_graph_rebuild</code> to force it.
    </div>`;
  }
  if (!data.nodes.length) {
    return `${form}<div style="padding:14px; color:#94a3b8; font-size:0.88rem; line-height:1.55">
      <strong>No knowledge or memory indexed yet for this project.</strong> Nodes appear as soon as the project
      has KB sources or working-memory facts; reference edges build automatically when indexed content
      cross-references other sources (or run <code>zc_graph_rebuild</code>). Path: <code>${escapeHtml(projectPath)}</code>
    </div>`;
  }

  const memCount = data.nodes.filter((n) => n.id.startsWith("memory:")).length;
  const topHub = data.nodes.slice().sort((a, b) => b.weightedIn - a.weightedIn)[0];
  const safeJson = JSON.stringify(data).replace(/<\/script>/gi, "<\\/script>").replace(/<!--/g, "<\\!--");

  return `${form}
  <div style="display:flex; gap:14px; flex-wrap:wrap; padding:2px 2px 10px 2px; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:0.76rem; color:#8b99ad">
    <span><b style="color:#2fe6a6">${data.nodes.length}</b> sources</span>
    ${memCount ? `<span><b style="color:#f1b84c">${memCount}</b> memory facts</span>` : ""}
    <span><b style="color:#5aa2ff">${data.edges.length}</b> references</span>
    ${topHub ? `<span>top hub: <b style="color:#f1b84c">${escapeHtml(topHub.id)}</b> (weighted_in=${topHub.weightedIn})</span>` : ""}
    <span style="color:#7a8799; margin-left:auto">node size ∝ backlinks · hubs rank higher in zc_search</span>
  </div>
  <div id="kb-graph-canvas" style="width:100%; height:520px; background:radial-gradient(620px 420px at 50% 45%, rgba(90,162,255,.05), transparent 70%), #080b11; border:1px solid #1d2634; border-radius:12px; position:relative; overflow:hidden">
    <div id="kb-graph-loading" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#7a8799; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:0.82rem">rendering graph&hellip;</div>
  </div>
  <div id="kb-graph-sel" style="margin-top:10px; padding:10px 12px; background:#0a0e16; border:1px solid #1d2634; border-radius:10px; font-size:0.82rem; color:#c3ccd9; min-height:40px">
    <em style="color:#7a8799">Hover a node for its references. Bigger = more inbound references (a "hub").</em>
  </div>
  <script>
  (function bootstrapKbGraph() {
    var data = ${safeJson};
    function render() {
      var canvas = document.getElementById("kb-graph-canvas");
      var loading = document.getElementById("kb-graph-loading");
      var selBox = document.getElementById("kb-graph-sel");
      if (!canvas || typeof d3 === "undefined") return;
      if (loading && loading.parentNode) loading.parentNode.removeChild(loading);
      while (canvas.firstChild) canvas.removeChild(canvas.firstChild);
      var W = canvas.clientWidth || 800, H = canvas.clientHeight || 520;
      var svg = d3.select(canvas).append("svg").attr("width", W).attr("height", H);
      var g = svg.append("g");
      svg.call(d3.zoom().scaleExtent([0.15, 4]).on("zoom", function(e){ g.attr("transform", e.transform); }));
      var defs = svg.append("defs");
      var marker = defs.append("marker").attr("id","kb-arrow").attr("viewBox","0 -5 10 10").attr("refX",18).attr("refY",0).attr("markerWidth",5).attr("markerHeight",5).attr("orient","auto");
      marker.append("path").attr("d","M0,-4L8,0L0,4").attr("fill","#33415a");
      var maxW = d3.max(data.nodes, function(n){ return n.weightedIn; }) || 1;
      var rOf = function(n){ return 5 + 16 * Math.sqrt((n.weightedIn||0)/maxW); };
      var REL = { code_ref:"#5aa2ff", mentions_file:"#2fe6a6", mentions_memory:"#a98bff", cross_ref:"#7a8799", weak_ref:"#2a3548" };
      var idset = {}; data.nodes.forEach(function(n){ idset[n.id]=1; });
      var edges = data.edges.filter(function(e){ return idset[e.from] && idset[e.to]; }).map(function(e){ return { source:e.from, target:e.to, relation:e.relation, weight:e.weight }; });
      var sim = d3.forceSimulation(data.nodes)
        .force("link", d3.forceLink(edges).id(function(d){ return d.id; }).distance(70).strength(0.4))
        .force("charge", d3.forceManyBody().strength(-180))
        .force("center", d3.forceCenter(W/2, H/2))
        // v0.35.0 — gentle gathering so ISOLATED nodes (memory facts / un-referenced sources)
        // stay in frame instead of being flung off-canvas by charge repulsion (same fix as
        // the wiki graph's disconnected-component handling).
        .force("x", d3.forceX(W/2).strength(0.07))
        .force("y", d3.forceY(H/2).strength(0.07))
        .force("collide", d3.forceCollide().radius(function(d){ return rOf(d)+4; }));
      var link = g.append("g").selectAll("line").data(edges).enter().append("line")
        .attr("stroke", function(d){ return REL[d.relation] || "#33415a"; }).attr("stroke-opacity",0.5).attr("stroke-width",1).attr("marker-end","url(#kb-arrow)");
      var node = g.append("g").selectAll("circle").data(data.nodes).enter().append("circle")
        .attr("r", rOf).attr("fill","#2fe6a6").attr("fill-opacity", function(d){ return 0.32 + 0.55*Math.sqrt((d.weightedIn||0)/maxW); }).attr("stroke","#080b11").attr("stroke-width",1.2).style("cursor","pointer")
        .call(d3.drag().on("start",function(e,d){ if(!e.active)sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; }).on("drag",function(e,d){ d.fx=e.x; d.fy=e.y; }).on("end",function(e,d){ if(!e.active)sim.alphaTarget(0); d.fx=null; d.fy=null; }));
      node.append("title").text(function(d){ return d.id + "  (in_degree=" + d.inDegree + ", weighted_in=" + d.weightedIn + ")"; });
      function show(d){ if(selBox) selBox.innerHTML = '<b style="color:#2fe6a6">'+d.id+'</b> &mdash; '+d.inDegree+' inbound source(s), weighted_in '+d.weightedIn; }
      node.on("mouseover", function(e,d){ show(d); }).on("click", function(e,d){ show(d); });
      sim.on("tick", function(){
        link.attr("x1",function(d){return d.source.x;}).attr("y1",function(d){return d.source.y;}).attr("x2",function(d){return d.target.x;}).attr("y2",function(d){return d.target.y;});
        node.attr("cx",function(d){return d.x;}).attr("cy",function(d){return d.y;});
      });
    }
    if (typeof d3 !== "undefined") { render(); return; }
    var s = document.createElement("script");
    s.src = "https://d3js.org/d3.v7.min.js";
    s.onload = render;
    s.onerror = function(){ var l = document.getElementById("kb-graph-loading"); if (l) l.textContent = "d3.js failed to load from CDN."; };
    document.head.appendChild(s);
  })();
  </script>`;
}

export async function renderWikiGraphFragment(): Promise<string> {
  const fs = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const { homedir } = await import("node:os");

  // Resolution order: PERSONAL_WIKI_ROOT env (set by docker-compose to the
  // read-only /personal-wiki mount) → ~/AI_projects/personal-wiki for
  // host-run dev. No hardcoded operator paths.
  const wikiRoot =
    process.env["PERSONAL_WIKI_ROOT"] ||
    nodePath.join(homedir(), "AI_projects", "personal-wiki");
  const dataPath = nodePath.join(wikiRoot, "wiki", "graph.json");

  type GraphData = {
    schema_version?: number;
    built_at?: string;
    counts?: { creators?: number; videos?: number; topics?: number; skills?: number; nodes?: number; edges?: number };
    nodes?: Array<{ id: string; label: string; type: string; size: number; title?: string; url?: string }>;
    edges?: Array<{ source: string; target: string; kind: string }>;
  };
  let data: GraphData | null = null;

  try {
    const raw = await fs.readFile(dataPath, "utf-8");
    data = JSON.parse(raw) as GraphData;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return `<div class="wiki-graph-empty" style="padding:14px; font-size:0.9rem; line-height:1.55; color:#cbd5e1">
        <p style="margin:0 0 8px 0"><strong>No KB graph snapshot yet.</strong> Looked for: <code>${escapeHtml(dataPath)}</code></p>
        <p style="margin:0 0 8px 0">To populate the wiki:</p>
        <ol style="margin:0 0 8px 18px; padding:0">
          <li>Invoke the <code>wiki-watch</code> skill on a video URL (agent does this, or you can directly).</li>
          <li>Review pending: <code>python ${escapeHtml(nodePath.join(wikiRoot, "approve.py"))}</code> and press <kbd>a</kbd>.</li>
          <li>The inline pipeline writes <code>wiki/raw/</code> + <code>wiki/videos/</code>, then rebuilds <code>wiki/graph.json</code>.</li>
          <li>Reload this page — the graph appears here.</li>
        </ol>
        <p style="margin:0; color:#94a3b8; font-size:0.82rem">If your personal-wiki lives elsewhere, set <code>PERSONAL_WIKI_ROOT</code> on the SC server.</p>
      </div>`;
    }
    return `<div class="wiki-graph-empty" style="padding:14px; color:#fca5a5; font-size:0.85rem">
      Error reading <code>${escapeHtml(dataPath)}</code>: ${escapeHtml(String(err.message))}
    </div>`;
  }

  if (!data?.nodes?.length) {
    return `<div class="wiki-graph-empty" style="padding:14px; font-size:0.9rem; color:#94a3b8; line-height:1.5">
      <p style="margin:0 0 6px 0"><strong>KB graph file exists but is empty.</strong></p>
      <p style="margin:0 0 6px 0">Last build: <code>${escapeHtml(String(data?.built_at ?? "unknown"))}</code></p>
      <p style="margin:0">Approve at least one wiki-watch proposal in <code>approve.py</code> to add real nodes.</p>
    </div>`;
  }

  // Embed graph data safely — close any </script> token that could break
  // out of our inline <script> tag, and any HTML comment opener.
  const safeJson = JSON.stringify(data)
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/<!--/g, "<\\!--");

  const builtAt = escapeHtml(String(data.built_at || ""));
  const c = data.counts || {};
  return `
  <div class="wiki-graph-meta" style="display:flex; gap:14px; flex-wrap:wrap; padding:6px 2px 12px 2px; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:0.76rem; color:#8b99ad">
    <span><b style="color:#a98bff">${c.creators ?? 0}</b> creators</span>
    <span><b style="color:#5aa2ff">${c.videos ?? 0}</b> videos</span>
    <span><b style="color:#2fe6a6">${c.topics ?? 0}</b> topics</span>
    <span><b style="color:#f1b84c">${c.skills ?? 0}</b> wiki-skills</span>
    <span style="color:#7a8799">${c.nodes ?? 0} nodes, ${c.edges ?? 0} edges</span>
    <span style="color:#7a8799; margin-left:auto">built ${builtAt}</span>
  </div>
  <div id="wiki-graph-canvas" style="width:100%; height:560px; background:radial-gradient(620px 420px at 50% 45%, rgba(47,230,166,.05), transparent 70%), #080b11; border:1px solid #1d2634; border-radius:12px; position:relative; overflow:hidden">
    <div id="wiki-graph-loading" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#7a8799; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:0.82rem">loading graph&hellip;</div>
  </div>
  <div id="wiki-graph-sel" style="margin-top:10px; padding:10px 12px; background:#0a0e16; border:1px solid #1d2634; border-radius:10px; font-size:0.82rem; color:#c3ccd9; min-height:44px">
    <em style="color:#7a8799">Click any node for details. Scroll to zoom, drag the background to pan, hover to focus its connections.</em>
  </div>
  <script>
  (function bootstrapWikiGraph() {
    var data = ${safeJson};
    function render() {
      var canvas = document.getElementById("wiki-graph-canvas");
      var loading = document.getElementById("wiki-graph-loading");
      var selBox = document.getElementById("wiki-graph-sel");
      if (!canvas || !selBox) return;
      if (loading) loading.parentNode.removeChild(loading);
      // Clear any prior render (HTMX could swap us in twice).
      while (canvas.firstChild) canvas.removeChild(canvas.firstChild);
      var W = canvas.clientWidth || 800;
      var H = canvas.clientHeight || 560;
      var svg = d3.select(canvas).append("svg").attr("width", W).attr("height", H);
      var g = svg.append("g");
      var zoom = d3.zoom().scaleExtent([0.15, 4]).on("zoom", function(e) { g.attr("transform", e.transform); });
      svg.call(zoom);
      var RM = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      var TYPE_COLOR = { creator:"#a98bff", video:"#5aa2ff", topic:"#2fe6a6", skill:"#f1b84c" };
      var LINK_COLOR = { publishes:"#5a4a7a", cites:"#2f567f", origin:"#1f8f66" };
      // soft glow so nodes read as luminous on the dark field (skills glow strongest)
      var defs = svg.append("defs");
      var glow = defs.append("filter").attr("id","wg-glow").attr("x","-70%").attr("y","-70%").attr("width","240%").attr("height","240%");
      glow.append("feGaussianBlur").attr("stdDeviation","2.4").attr("result","b");
      var fm = glow.append("feMerge"); fm.append("feMergeNode").attr("in","b"); fm.append("feMergeNode").attr("in","SourceGraphic");
      // adjacency for hover focus
      var ADJ = {}; data.nodes.forEach(function(n){ ADJ[n.id] = {}; ADJ[n.id][n.id] = 1; });
      data.edges.forEach(function(l){ var s=(typeof l.source==="object")?l.source.id:l.source, t=(typeof l.target==="object")?l.target.id:l.target; if(ADJ[s])ADJ[s][t]=1; if(ADJ[t])ADJ[t][s]=1; });
      function linkId(l, end) { var v = l[end]; return (typeof v==="object") ? v.id : v; }

      var link = g.append("g").attr("stroke-linecap","round").selectAll("line").data(data.edges).enter().append("line")
        .attr("stroke", function(d){ return LINK_COLOR[d.kind] || "#33415a"; })
        .attr("stroke-opacity", RM ? 0.42 : 0).attr("stroke-width", 1.1);
      var node = g.append("g").selectAll("g.node").data(data.nodes).enter().append("g").attr("class","wiki-graph-node")
        .style("cursor","pointer")
        .call(d3.drag()
          .on("start", function(e, d) { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
          .on("drag",  function(e, d) { d.fx=e.x; d.fy=e.y; })
          .on("end",   function(e, d) { if (!e.active) sim.alphaTarget(0); d.fx=null; d.fy=null; }));
      var circ = node.append("circle").attr("r", RM ? function(d){ return d.size; } : 0.01)
        .attr("fill", function(d){ return TYPE_COLOR[d.type] || "#7a8799"; })
        .attr("stroke", "#080b11").attr("stroke-width", 1.4)
        .attr("filter", function(d){ return d.type === "skill" ? "url(#wg-glow)" : null; });
      node.append("title").text(function(d){ return d.title || d.label; });
      var label = node.append("text").attr("dy", function(d){ return d.size + 11; }).attr("text-anchor","middle")
        .style("font-family", "'JetBrains Mono',ui-monospace,monospace").style("font-size", "9.5px").style("fill", "#aeb8c8").style("pointer-events", "none")
        .style("opacity", RM ? 1 : 0)
        .style("text-shadow", "0 0 4px #080b11, 0 0 4px #080b11")
        .text(function(d){ return d.label.length > 32 ? d.label.slice(0, 31) + "\\u2026" : d.label; });

      // entrance: nodes scale in with a short stagger; links + labels fade in.
      // one composed arrival moment (directs attention) — skipped under reduced-motion.
      if (!RM) {
        circ.transition().delay(function(d,i){ return Math.min(i * 1.3, 520); }).duration(560).ease(d3.easeCubicOut)
          .attr("r", function(d){ return d.size; });
        label.transition().delay(440).duration(620).style("opacity", 1);
        link.transition().delay(160).duration(720).attr("stroke-opacity", 0.42);
      }

      // hover: focus a node + its connections, dim the rest (attention + causality)
      function focusNode(d) {
        var adj = ADJ[d.id] || {};
        node.style("opacity", function(n){ return adj[n.id] ? 1 : 0.12; });
        circ.transition().duration(140).ease(d3.easeCubicOut).attr("r", function(n){ return n.id === d.id ? n.size * 1.55 : n.size; });
        link.attr("stroke-opacity", function(l){ return (linkId(l,"source")===d.id || linkId(l,"target")===d.id) ? 0.9 : 0.035; })
            .attr("stroke", function(l){ return (linkId(l,"source")===d.id || linkId(l,"target")===d.id) ? "#2fe6a6" : (LINK_COLOR[l.kind]||"#33415a"); });
      }
      function unfocus() {
        node.style("opacity", 1);
        circ.transition().duration(180).ease(d3.easeCubicOut).attr("r", function(n){ return n.size; });
        link.attr("stroke-opacity", 0.42).attr("stroke", function(l){ return LINK_COLOR[l.kind] || "#33415a"; });
      }
      node.on("mouseenter", function(e, d){ focusNode(d); }).on("mouseleave", function(){ unfocus(); });

      node.on("click", function(e, d) {
        e.stopPropagation();
        circ.attr("stroke", function(n){ return n.id===d.id ? "#2fe6a6" : "#080b11"; }).attr("stroke-width", function(n){ return n.id===d.id ? 2.6 : 1.4; });
        var neighbors = new Set();
        data.edges.forEach(function(l) {
          var sId = linkId(l,"source"), tId = linkId(l,"target");
          if (sId === d.id) neighbors.add(tId);
          if (tId === d.id) neighbors.add(sId);
        });
        var html = "<strong style='color:#e9eef5'>" + esc(d.label) + "</strong> &nbsp; <em style='color:" + (TYPE_COLOR[d.type]||"#8b99ad") + "'>" + esc(d.type) + "</em>";
        if (d.title) html += '<pre style="white-space:pre-wrap; word-break:break-word; font-size:11px; margin:6px 0 4px 0; padding:7px; background:#080b11; border:1px solid #1d2634; border-radius:6px; color:#c3ccd9">' + esc(d.title) + '</pre>';
        if (d.url) html += '<a target="_blank" rel="noopener" href="' + esc(d.url) + '" style="color:#5aa2ff">open URL</a> &nbsp; ';
        html += "<b style='color:#2fe6a6'>" + neighbors.size + "</b> connection(s).";
        selBox.innerHTML = html;
      });
      svg.on("click", function(){ circ.attr("stroke","#080b11").attr("stroke-width",1.4); });

      var sim = d3.forceSimulation(data.nodes)
        .force("link", d3.forceLink(data.edges).id(function(d){ return d.id; }).distance(64).strength(0.65))
        .force("charge", d3.forceManyBody().strength(-175))
        .force("center", d3.forceCenter(W/2, H/2))
        // gentle pull toward center so DISCONNECTED components (e.g. a lone video
        // sharing no topics with the rest, like the Think School node) stay gathered
        // in-frame instead of drifting to a far corner and reading as "missing".
        .force("x", d3.forceX(W/2).strength(0.07))
        .force("y", d3.forceY(H/2).strength(0.07))
        .force("collide", d3.forceCollide().radius(function(d){ return d.size + 4; }))
        .velocityDecay(0.34).alphaDecay(0.045);
      sim.on("tick", function() {
        link.attr("x1", function(d){ return d.source.x; }).attr("y1", function(d){ return d.source.y; })
            .attr("x2", function(d){ return d.target.x; }).attr("y2", function(d){ return d.target.y; });
        node.attr("transform", function(d){ return "translate(" + d.x + "," + d.y + ")"; });
      });
      // auto-fit the settled graph into view (continuity — it never sits half off-screen)
      var fitted = false;
      function fitToView() {
        if (fitted || !data.nodes.length) return; fitted = true;
        var xs = data.nodes.map(function(n){ return n.x; }), ys = data.nodes.map(function(n){ return n.y; });
        var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
        var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
        var gw = (maxX - minX) || 1, gh = (maxY - minY) || 1, pad = 56;
        var k = Math.max(0.15, Math.min((W - pad) / gw, (H - pad) / gh, 2));
        var t = d3.zoomIdentity.translate((W - k*(minX+maxX))/2, (H - k*(minY+maxY))/2).scale(k);
        svg.transition().duration(RM ? 0 : 750).ease(d3.easeCubicInOut).call(zoom.transform, t);
      }
      sim.on("end", fitToView);
      setTimeout(fitToView, 2800);
      function esc(s) { return String(s).replace(/[&<>"']/g, function(c){ return ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]; }); }
    }
    if (typeof d3 !== 'undefined') { render(); return; }
    var s = document.createElement('script');
    s.src = 'https://d3js.org/d3.v7.min.js';
    s.onload = render;
    s.onerror = function() {
      var l = document.getElementById("wiki-graph-loading");
      if (l) l.textContent = "d3.js failed to load from CDN. Check network or vendor it locally.";
    };
    document.head.appendChild(s);
  })();
  </script>`;
}
