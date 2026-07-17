#!/usr/bin/env node
/**
 * S7 (v0.46.0) — CI/CD MEMORY: hydrate + write-back for HEADLESS agents.
 * =======================================================================
 *
 * A zero-dependency CLI so pipeline jobs (GitHub Actions, GitLab CI, cron
 * boxes) get the same persistent project memory interactive agents have —
 * without an MCP server. Hydrate prints a compact markdown context block to
 * pipe into `claude -p`; remember/broadcast write results back so the NEXT
 * run (or the next human session) starts warm.
 *
 * Auth: ZC_API_KEY may be the operator master key OR a per-user key from
 * `POST /api/v1/team/keys` (S3) — give CI its own user ("ci") and every
 * write-back is attributed (`created_by=ci`) and independently revocable.
 *
 *   env: ZC_API_URL   (default http://localhost:3099)
 *        ZC_API_KEY   (master or zck_… user key)
 *        ZC_USER_ID   (optional attribution when using the master key)
 *
 * Commands:
 *   hydrate  --project <path|workspace:slug> [--agent ci] [--focus "..."] [--max 30] [--broadcasts 5]
 *   remember --project <p> --key <k> --value <v> [--importance 3] [--ttl-days N] [--kind fact|decision|hypothesis|prediction] [--agent ci]
 *   search   --project <p> --query "<q>" [--max 5]
 *   broadcast --project <p> --type STATUS --task <t> --state <s> [--agent ci]
 *
 * GitHub Actions sketch:
 *   - run: node scripts/ci-memory.mjs hydrate --project "$GITHUB_WORKSPACE" --focus "ci failures" > memory.md
 *   - run: claude -p "$(cat memory.md)`n`nFix the failing test." --output-format text
 *   - run: node scripts/ci-memory.mjs remember --project "$GITHUB_WORKSPACE" --key "ci_run_${GITHUB_RUN_ID}" --value "..." --ttl-days 14
 */

const API = (process.env.ZC_API_URL || "http://localhost:3099").replace(/\/$/, "");
const KEY = process.env.ZC_API_KEY || "";

function args() {
  const [, , cmd, ...rest] = process.argv;
  const out = { _cmd: cmd };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const k = rest[i].slice(2);
      const v = i + 1 < rest.length && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}

async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (KEY) headers["Authorization"] = `Bearer ${KEY}`;
  const zcUser = process.env.ZC_USER_ID;
  if (zcUser && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(zcUser)) headers["x-zc-user"] = zcUser;
  const res = await fetch(`${API}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `API ${res.status} on ${path}`);
  return json;
}

function req(a, name) {
  if (!a[name]) { console.error(`--${name} is required`); process.exit(2); }
  return a[name];
}

async function hydrate(a) {
  const project = req(a, "project");
  const agent = a.agent || "ci";
  const max = Math.max(1, parseInt(a.max || "30", 10) || 30);
  const focus = a.focus ? `&focus=${encodeURIComponent(a.focus)}` : "";
  const r = await api("GET", `/api/v1/recall?projectPath=${encodeURIComponent(project)}&agentId=${encodeURIComponent(agent)}${focus}`);
  const facts = (r.facts || []).slice(0, max);

  const lines = [];
  lines.push(`# Project memory (SecureContext hydrate)`);
  lines.push(`Project: ${project} · agent namespace: ${agent} · ${facts.length} fact(s)${a.focus ? ` · focus: ${a.focus}` : ""}`);
  lines.push("");
  if (facts.length === 0) {
    lines.push("_No stored facts yet — this may be the first run on this project._");
  } else {
    for (const f of facts) {
      const badge = f.kind && f.kind !== "fact" ? ` ⟨${f.kind}⟩` : "";
      const by = f.created_by ? ` (by:${f.created_by})` : "";
      lines.push(`- [★${f.importance}]${badge} **${f.key}**: ${f.value}${by}`);
    }
  }
  const nB = Math.max(0, parseInt(a.broadcasts || "5", 10) || 0);
  if (nB > 0) {
    try {
      const b = await api("GET", `/api/v1/broadcasts?projectPath=${encodeURIComponent(project)}&limit=${nB}`);
      const rows = (b.broadcasts || []).slice(0, nB);
      if (rows.length > 0) {
        lines.push("", `## Recent coordination (${rows.length})`);
        for (const x of rows) {
          lines.push(`- ${String(x.created_at || "").slice(0, 16)} [${x.type}] ${x.agent_id}: ${String(x.summary ?? x.state ?? "").slice(0, 160)}`);
        }
      }
    } catch { /* broadcasts optional — older servers */ }
  }
  if (r.contradictions && r.contradictions.length > 0) {
    lines.push("", `## ⚠ Open contradictions (${r.contradictions.length}) — verify before trusting either side`);
    for (const c of r.contradictions.slice(0, 5)) lines.push(`- ${c.key_a} ↔ ${c.key_b} (${c.reason})`);
  }
  console.log(lines.join("\n"));
}

async function remember(a) {
  const body = {
    projectPath: req(a, "project"),
    key: req(a, "key"),
    value: req(a, "value"),
    importance: parseInt(a.importance || "3", 10) || 3,
    agentId: a.agent || "ci",
  };
  if (a.kind) body.kind = a.kind;
  if (a["ttl-days"]) body.ttl_days = parseFloat(a["ttl-days"]);
  const r = await api("POST", "/api/v1/remember", body);
  console.log(`remembered "${body.key}" (${r.count}/${r.max} facts in namespace)`);
}

async function search(a) {
  const r = await api("POST", "/api/v1/search", {
    projectPath: req(a, "project"),
    queries: [req(a, "query")],
  });
  const max = Math.max(1, parseInt(a.max || "5", 10) || 5);
  for (const x of (r.results || []).slice(0, max)) {
    console.log(`### ${x.source}\n${String(x.content || "").slice(0, 500)}\n`);
  }
}

async function broadcast(a) {
  const r = await api("POST", "/api/v1/broadcast", {
    projectPath: req(a, "project"),
    type: a.type || "STATUS",
    agentId: a.agent || "ci",
    task: a.task || "ci-run",
    state: a.state || "",
  });
  console.log(`broadcast #${r.message?.id ?? "?"} sent`);
}

const a = args();
const CMDS = { hydrate, remember, search, broadcast };
const fn = CMDS[a._cmd];
if (!fn) {
  console.error(`Usage: ci-memory.mjs <hydrate|remember|search|broadcast> --project <path> [...]\nSee the header of this file for full usage.`);
  process.exit(2);
}
fn(a).catch((e) => { console.error(`ci-memory ${a._cmd} failed: ${e.message}`); process.exit(1); });
