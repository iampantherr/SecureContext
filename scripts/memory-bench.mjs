/**
 * M0 — Memory-quality benchmark runner (LongMemEval-style, deterministic).
 *
 * Usage (from repo root, .env providing ZC_API_KEY):
 *   node scripts/memory-bench.mjs --seed                 # build the corpus (idempotent: purges first)
 *   node scripts/memory-bench.mjs --score --stage baseline
 *   node scripts/memory-bench.mjs --compare baseline m1
 *   node scripts/memory-bench.mjs --purge                # remove all bench data
 *
 * Measures retrieval quality EXACTLY the way agents access memory — through
 * the live HTTP API (recall for working memory, search for the KB) — and
 * scores the rank of a known gold fact/doc per question:
 *   hit@5, hit@10, MRR (1/rank, 0 if not in top 25).
 * Results land in bench/results/<stage>.json so every improvement stage gets
 * a comparable, reproducible number.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { WM_FACTS, noiseFacts, KB_DOCS, QUESTIONS, AGENT_ID } from "../bench/bench-data.mjs";

const PROJECT = "C:/Users/Amit/AI_projects/ZZ_BENCH";
const API = process.env.ZC_API_URL || "http://localhost:3099";
const KEY = process.env.ZC_API_KEY || readEnvKey();
const PSQL = ["exec", "securecontext-postgres", "psql", "-U", "scuser", "-d", "securecontext", "-tAc"];

function readEnvKey() {
  try {
    const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const m = env.match(/^ZC_API_KEY=(.+)$/m);
    return m ? m[1].trim() : "";
  } catch { return ""; }
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function psql(sql) {
  return execFileSync("docker", [...PSQL, sql], { encoding: "utf8" }).trim();
}

async function projectHash() {
  const h = psql(`SELECT project_hash FROM working_memory WHERE key='auth_token_rotation' ORDER BY created_at DESC LIMIT 1`);
  if (!/^[0-9a-f]{16}$/.test(h)) throw new Error(`could not resolve bench project hash (got '${h}') — run --seed first`);
  return h;
}

// ── Seeding ──────────────────────────────────────────────────────────────────

async function purge() {
  // Resolve hash if any bench rows exist; purge every bench table by hash.
  let h = null;
  try { h = await projectHash(); } catch { /* nothing seeded yet */ }
  if (h) {
    for (const sql of [
      `DELETE FROM working_memory WHERE project_hash='${h}'`,
      `DELETE FROM knowledge_entries WHERE project_hash='${h}'`,
      `DELETE FROM source_meta WHERE project_hash='${h}'`,
      `DELETE FROM embeddings WHERE project_hash='${h}'`,
      `DELETE FROM kb_edges_pg WHERE project_hash='${h}'`,
      `DELETE FROM kb_backlinks_pg WHERE project_hash='${h}'`,
      `DELETE FROM memory_contradictions_pg WHERE project_hash='${h}'`,
      `DELETE FROM kb_community_summaries_pg WHERE project_hash='${h}'`,
    ]) psql(sql);
    console.log(`purged bench data (hash ${h})`);
  } else {
    console.log("nothing to purge");
  }
}

async function seed() {
  await purge();
  const facts = [...WM_FACTS, ...noiseFacts()];
  console.log(`seeding ${facts.length} working-memory facts…`);
  for (const f of facts) {
    await api("POST", "/api/v1/remember", {
      projectPath: PROJECT, key: f.key, value: f.value,
      importance: f.importance, agentId: AGENT_ID,
      ...(f.kind ? { kind: f.kind } : {}),
    });
  }
  const h = await projectHash();

  console.log("backdating created_at per corpus daysAgo…");
  for (const f of facts) {
    psql(`UPDATE working_memory SET created_at = NOW() - INTERVAL '${f.daysAgo} days' WHERE project_hash='${h}' AND key='${f.key}' AND agent_id='${AGENT_ID}'`);
  }

  console.log("applying knowledge-update retirements…");
  for (const f of WM_FACTS.filter((x) => x.retire)) {
    const successor = WM_FACTS.find((x) => x.key === f.retire.by);
    psql(`UPDATE working_memory SET valid_to = NOW() - INTERVAL '${successor.daysAgo} days', superseded_by='${f.retire.by}', retired_reason='superseded' WHERE project_hash='${h}' AND key='${f.key}' AND agent_id='${AGENT_ID}'`);
  }

  console.log(`indexing ${KB_DOCS.length} KB docs…`);
  for (const d of KB_DOCS) {
    await api("POST", "/api/v1/index", { projectPath: PROJECT, content: d.content, source: d.source, sourceType: "internal" });
  }

  console.log("rebuilding co-reference graph…");
  await api("POST", "/api/v1/graph/rebuild", { projectPath: PROJECT });

  // Give fire-and-forget embeddings a moment to land, then report state.
  await new Promise((r) => setTimeout(r, 8000));
  const live = psql(`SELECT COUNT(*) FROM working_memory WHERE project_hash='${h}' AND valid_to IS NULL`);
  const retired = psql(`SELECT COUNT(*) FROM working_memory WHERE project_hash='${h}' AND valid_to IS NOT NULL`);
  const kb = psql(`SELECT COUNT(*) FROM knowledge_entries WHERE project_hash='${h}'`);
  const edges = psql(`SELECT COUNT(*) FROM kb_edges_pg WHERE project_hash='${h}'`);
  console.log(`seeded: ${live} live facts, ${retired} retired, ${kb} KB docs, ${edges} graph edges (hash ${h})`);
}

// ── Scoring ──────────────────────────────────────────────────────────────────

const TOP_CUTOFF = 25;

function rankMetrics(rank) {
  return {
    rank,
    hit5: rank !== null && rank <= 5 ? 1 : 0,
    hit10: rank !== null && rank <= 10 ? 1 : 0,
    mrr: rank !== null && rank <= TOP_CUTOFF ? 1 / rank : 0,
  };
}

async function scoreQuestion(q) {
  if (!q.gold) {
    // Abstention: informational — record the top search hit only.
    const r = await api("POST", "/api/v1/search", { projectPath: PROJECT, queries: [q.question] });
    const top = r.results?.[0];
    return { id: q.id, category: q.category, abstention: true, topSource: top?.source ?? null };
  }
  if (q.gold.type === "wm") {
    const r = await api("GET", `/api/v1/recall?projectPath=${encodeURIComponent(PROJECT)}&agentId=${AGENT_ID}&focus=${encodeURIComponent(q.question)}`);
    const keys = (r.facts ?? []).map((f) => f.key);
    const idx = keys.indexOf(q.gold.key);
    const rank = idx === -1 ? null : idx + 1;
    const out = { id: q.id, category: q.category, gold: q.gold.key, ...rankMetrics(rank), listLen: keys.length };
    if (q.decoy?.key) {
      const dIdx = keys.indexOf(q.decoy.key);
      out.decoyRank = dIdx === -1 ? null : dIdx + 1;
      out.decoyAboveGold = out.decoyRank !== null && (rank === null || out.decoyRank < rank) ? 1 : 0;
    }
    if (q.retired) out.retiredLeaked = keys.includes(q.retired) ? 1 : 0;
    return out;
  }
  // KB gold → search
  const r = await api("POST", "/api/v1/search", { projectPath: PROJECT, queries: [q.question] });
  const sources = (r.results ?? []).map((x) => x.source);
  const idx = sources.indexOf(q.gold.source);
  const rank = idx === -1 ? null : idx + 1;
  return { id: q.id, category: q.category, gold: q.gold.source, ...rankMetrics(rank), listLen: sources.length };
}

function aggregate(perQuestion) {
  const cats = {};
  for (const r of perQuestion) {
    if (r.abstention) continue;
    const c = (cats[r.category] ??= { n: 0, hit5: 0, hit10: 0, mrr: 0, decoyAbove: 0, decoyN: 0, retiredLeaks: 0 });
    c.n++; c.hit5 += r.hit5; c.hit10 += r.hit10; c.mrr += r.mrr;
    if (r.decoyAboveGold !== undefined) { c.decoyN++; c.decoyAbove += r.decoyAboveGold; }
    if (r.retiredLeaked !== undefined) c.retiredLeaks += r.retiredLeaked;
  }
  const overall = { n: 0, hit5: 0, hit10: 0, mrr: 0 };
  for (const c of Object.values(cats)) { overall.n += c.n; overall.hit5 += c.hit5; overall.hit10 += c.hit10; overall.mrr += c.mrr; }
  const pct = (x, n) => (n ? +(100 * x / n).toFixed(1) : 0);
  const fmt = (c) => ({ n: c.n, "hit@5%": pct(c.hit5, c.n), "hit@10%": pct(c.hit10, c.n), mrr: +(c.mrr / (c.n || 1)).toFixed(3),
    ...(c.decoyN ? { decoyAboveGoldPct: pct(c.decoyAbove, c.decoyN) } : {}),
    ...(c.retiredLeaks !== undefined && c.retiredLeaks > 0 ? { retiredLeaks: c.retiredLeaks } : {}) });
  return { categories: Object.fromEntries(Object.entries(cats).map(([k, c]) => [k, fmt(c)])), overall: fmt(overall) };
}

async function score(stage) {
  const perQuestion = [];
  for (const q of QUESTIONS) {
    perQuestion.push(await scoreQuestion(q));
    process.stdout.write(".");
    // Pace the run: real agents don't fire 36 embedding queries back-to-back.
    // Without this, local Ollama saturates and semantic features degrade mid-run,
    // measuring the SATURATION, not the retrieval quality.
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log();
  const agg = aggregate(perQuestion);
  const out = { stage, scoredAt: new Date().toISOString(), ...agg, perQuestion };
  const dir = new URL("../bench/results/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`${stage}.json`, dir), JSON.stringify(out, null, 2));
  console.log(`\n=== ${stage} ===`);
  console.table(agg.categories);
  console.log("overall:", agg.overall);
  console.log(`saved bench/results/${stage}.json`);
}

function compare(a, b) {
  const load = (s) => JSON.parse(readFileSync(new URL(`../bench/results/${s}.json`, import.meta.url), "utf8"));
  const A = load(a), B = load(b);
  console.log(`\n=== ${a} -> ${b} ===`);
  const rows = {};
  for (const cat of new Set([...Object.keys(A.categories), ...Object.keys(B.categories)])) {
    const x = A.categories[cat] ?? {}, y = B.categories[cat] ?? {};
    rows[cat] = {
      "hit@10": `${x["hit@10%"] ?? 0}% -> ${y["hit@10%"] ?? 0}%`,
      mrr: `${x.mrr ?? 0} -> ${y.mrr ?? 0}`,
      "Δmrr": +((y.mrr ?? 0) - (x.mrr ?? 0)).toFixed(3),
    };
  }
  rows.OVERALL = {
    "hit@10": `${A.overall["hit@10%"]}% -> ${B.overall["hit@10%"]}%`,
    mrr: `${A.overall.mrr} -> ${B.overall.mrr}`,
    "Δmrr": +(B.overall.mrr - A.overall.mrr).toFixed(3),
  };
  console.table(rows);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };

if (has("--purge")) await purge();
else if (has("--seed")) await seed();
else if (has("--score")) await score(val("--stage") ?? "baseline");
else if (has("--compare")) { const [a, b] = args.slice(args.indexOf("--compare") + 1); compare(a, b); }
else console.log("usage: --seed | --score --stage <name> | --compare <a> <b> | --purge");
