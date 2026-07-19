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
  // S4 — bounded timeout + one retry: an API stall under heavy background load
  // (embed drain / summarizer) killed a run at undici's 300s default. 120s cap,
  // retry once after a breather; callers add their own per-item resilience.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  throw lastErr;
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

  // S1 — WAIT for fact embeddings to land before declaring the corpus ready.
  // Scoring a vector-less corpus silently produces baseline-shaped garbage
  // (measured: overall 78% → 31% when scored 5s after seeding). Poll until
  // ≥95% of live facts have a vector or 180s elapses — and say which.
  const liveN = parseInt(psql(`SELECT COUNT(*) FROM working_memory WHERE project_hash='${h}' AND valid_to IS NULL`), 10);
  const embCount = () => parseInt(psql(`SELECT COUNT(*) FROM embeddings WHERE project_hash='${h}' AND source LIKE 'memory:%'`), 10);
  const deadline = Date.now() + 180_000;
  let embedded = embCount();
  while (embedded < Math.ceil(liveN * 0.95) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    embedded = embCount();
    console.log(`  embeddings: ${embedded}/${liveN}…`);
  }
  if (embedded < Math.ceil(liveN * 0.95)) {
    console.warn(`  ⚠ only ${embedded}/${liveN} fact embeddings landed after 180s — scores will be degraded. Check Ollama.`);
  }
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

// ── R6 (v0.42.0): LongMemEval-format adapter ─────────────────────────────────
// Runs the PUBLIC LongMemEval dataset (arXiv 2410.10813) against SecureContext.
// Usage: node scripts/memory-bench.mjs --longmemeval <dataset.json> [--limit N]
//
// Ingests each question's haystack sessions as KB entries (source `session:<id>`,
// created_at backdated to the session date) into a dedicated project, then scores
// a RETRIEVAL PROXY: for each question, does zc_search(question) surface one of
// the labeled answer sessions in the top-K? (The official metric needs an
// LLM-judge over generated answers; retrieval recall is the memory-system share
// of that pipeline and is deterministic + reproducible.)
const LME_PROJECT = "C:/Users/Amit/AI_projects/ZZ_LME";

async function runLongMemEval(file, limit) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const all = Array.isArray(data) ? data : data.questions;
  // S4 — STRATIFIED sampling: the dataset is grouped by question_type, so a
  // head-slice covers exactly one type (measured: first 50 = all
  // single-session-user). Interpret --limit as PER-TYPE: take the first N of
  // each type in dataset order (deterministic, no RNG).
  // S9b — optional type filter (--types a,b) so a targeted round (e.g.
  // temporal-reasoning) re-scores in minutes against the already-ingested corpus.
  const typesFilter = (val("--types") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const perType = new Map();
  for (const q of all) {
    const t = q.question_type ?? "unknown";
    if (typesFilter.length > 0 && !typesFilter.includes(t)) continue;
    if (!perType.has(t)) perType.set(t, []);
    if (perType.get(t).length < (limit || 15)) perType.get(t).push(q);
  }
  const questions = [...perType.values()].flat();
  console.log(`LongMemEval: ${questions.length} questions (${limit || 15}/type × ${perType.size} types, of ${all.length} total)`);

  // Ingest the union of haystack sessions (deduped by session id).
  const seen = new Set();
  const ingestFailures = [];
  let ingested = 0;
  for (const q of questions) {
    const ids   = q.haystack_session_ids ?? [];
    const dates = q.haystack_dates ?? [];
    const sess  = q.haystack_sessions ?? [];
    for (let i = 0; i < ids.length; i++) {
      const sid = ids[i];
      if (seen.has(sid)) continue;
      seen.add(sid);
      const turns = (sess[i] ?? []).map((t) => `${t.role}: ${t.content}`).join("\n").slice(0, 45_000);
      if (!turns.trim()) continue;
      // S4 — resilient ingest: one transient 500 must not kill a 2,500-session
      // batch (measured: the first full run died on a single "Internal error").
      // Retry twice with backoff; count persistent failures; abort only >10%.
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          await api("POST", "/api/v1/index", { projectPath: LME_PROJECT, content: turns, source: `session:${sid}`, sourceType: "internal" });
          ok = true;
        } catch (e) {
          if (attempt === 2) {
            ingestFailures.push(sid);
            console.warn(`\ningest failed after 3 attempts: session:${sid} — ${e.message.slice(0, 120)}`);
          } else {
            await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
          }
        }
      }
      if (!ok) {
        if (ingestFailures.length > Math.max(10, seen.size * 0.1)) {
          throw new Error(`aborting: ${ingestFailures.length} sessions failed to ingest (>10%) — API unhealthy`);
        }
        continue;
      }
      if (dates[i]) {
        const d = new Date(dates[i]);
        if (Number.isFinite(d.getTime())) {
          const h = psql(`SELECT project_hash FROM knowledge_entries WHERE source='session:${sid}' ORDER BY created_at DESC LIMIT 1`);
          if (/^[0-9a-f]{16}$/.test(h)) psql(`UPDATE knowledge_entries SET created_at='${d.toISOString()}' WHERE project_hash='${h}' AND source='session:${sid}'`);
        }
      }
      ingested++;
      if (ingested % 20 === 0) process.stdout.write(`\ringested ${ingested} sessions…`);
    }
  }
  // S4 — wait for embeddings to LAND, not a fixed 10s (S1 lesson: scoring a
  // vector-less corpus silently produces garbage). Budget scales with corpus size;
  // the background embed lane drains serially at roughly 3-6 sessions/sec.
  const lmeHash = psql(`SELECT project_hash FROM knowledge_entries WHERE source LIKE 'session:%' ORDER BY created_at DESC LIMIT 1`);
  if (/^[0-9a-f]{16}$/.test(lmeHash)) {
    const embCount = () => parseInt(psql(`SELECT COUNT(*) FROM embeddings WHERE project_hash='${lmeHash}' AND source LIKE 'session:%'`), 10);
    const deadline = Date.now() + Math.max(120_000, ingested * 1_500);
    let embedded = embCount();
    while (embedded < Math.ceil(ingested * 0.95) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10_000));
      embedded = embCount();
      process.stdout.write(`\rembeddings: ${embedded}/${ingested}…   `);
    }
    console.log();
    if (embedded < Math.ceil(ingested * 0.95)) {
      console.warn(`⚠ only ${embedded}/${ingested} session embeddings landed — retrieval scores will be DEGRADED (BM25-heavy).`);
    }
  }

  // Score retrieval proxy per question type. Per-question resilience: a stalled
  // search skips the question (counted) instead of killing the run.
  const byType = {};
  const detail = [];
  let scoreFailures = 0;
  for (const q of questions) {
    const goldSet = new Set((q.answer_session_ids ?? []).map((s) => `session:${s}`));
    if (goldSet.size === 0) continue;
    let r;
    try {
      r = await api("POST", "/api/v1/search", { projectPath: LME_PROJECT, queries: [q.question] });
    } catch (e) {
      scoreFailures++;
      console.warn(`\nscore failed for ${q.question_id ?? q.question.slice(0, 40)}: ${e.message.slice(0, 100)}`);
      if (scoreFailures > questions.length * 0.2) throw new Error("aborting: >20% of questions failed to score — API unhealthy");
      continue;
    }
    const sources = (r.results ?? []).map((x) => x.source);
    const rank = sources.findIndex((s) => goldSet.has(s)) + 1; // 0 = miss
    const t = (byType[q.question_type ?? "unknown"] ??= { n: 0, hit5: 0, hit10: 0, mrr: 0 });
    t.n++; if (rank && rank <= 5) t.hit5++; if (rank && rank <= 10) t.hit10++; if (rank) t.mrr += 1 / rank;
    // S9b — per-question detail for miss analysis.
    detail.push({ id: q.question_id, type: q.question_type, question: q.question,
      gold: [...goldSet], rank: rank || null, top10: sources.slice(0, 10) });
    await new Promise((r2) => setTimeout(r2, 400));
    process.stdout.write(".");
  }
  console.log("\n=== LongMemEval retrieval proxy (answer-session recall) ===");
  const pct = (x, n) => (n ? +(100 * x / n).toFixed(1) : 0);
  console.table(Object.fromEntries(Object.entries(byType).map(([k, t]) =>
    [k, { n: t.n, "hit@5%": pct(t.hit5, t.n), "hit@10%": pct(t.hit10, t.n), mrr: +(t.mrr / (t.n || 1)).toFixed(3) }])));
  const dir = new URL("../bench/results/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  // A partial (--types) run must not clobber the full-run headline numbers.
  const partial = typesFilter.length > 0;
  if (!partial) {
    writeFileSync(new URL(`longmemeval.json`, dir), JSON.stringify({ scoredAt: new Date().toISOString(), byType }, null, 2));
    console.log("saved bench/results/longmemeval.json");
  }
  writeFileSync(new URL(`longmemeval_detail${partial ? "_" + typesFilter.join("-") : ""}.json`, dir),
    JSON.stringify({ scoredAt: new Date().toISOString(), byType, detail }, null, 2));
  console.log("saved per-question detail");

  // ── T5 (v0.47.x) — END-TO-END QA protocol (Zep-comparable methodology) ─────
  // Two conditions per question, SAME local generator, so the SC-vs-baseline
  // DELTA is comparable to Zep's reported lift (their 71.2% vs 60.2% used
  // gpt-4o for both conditions; absolute numbers across different generators
  // are NOT comparable and are reported with that disclosure):
  //   A) SC memory: top-10 zc_search results as context (~Zep's ~1.6k tokens)
  //   B) Baseline: the question's own haystack transcript, most-recent-first,
  //      truncated to fit the local context window (approximates full-context)
  // Generator: --qa-gen (default qwen2.5-coder:32b, host GPU Ollama).
  // Judge: --qa-judge (default phi4:14b — a DIFFERENT model, constrained JSON).
  if (has("--qa")) {
    const GEN   = val("--qa-gen")   ?? "qwen2.5-coder:32b";
    const JUDGE = val("--qa-judge") ?? "phi4:14b";
    const OLL   = process.env.BENCH_OLLAMA_URL ?? "http://localhost:11434";
    const chat = async (model, prompt, format, numCtx, numPredict) => {
      const resp = await fetch(`${OLL}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false,
          // Reasoning models (gpt-oss) burn tokens in the thinking channel
          // BEFORE the answer — the budget must cover both.
          ...(format ? { format } : {}), options: { temperature: 0, num_predict: numPredict ?? 1600, num_ctx: numCtx ?? 8192 } }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!resp.ok) throw new Error(`ollama ${model} http ${resp.status}`);
      return ((await resp.json()).message?.content ?? "").trim();
    };
    const genAnswer = (context, question) => chat(GEN,
      `You are answering a question about a user based on their past conversation history.\n\nCONTEXT (excerpts from past sessions):\n${context}\n\nQUESTION: ${question}\n\nAnswer concisely using ONLY the context. If the context does not contain the information, answer exactly: "I don't have that information."`,
      undefined, 16384);
    const judgeAnswer = async (question, gold, hyp) => {
      const out = await chat(JUDGE,
        `Grade a memory system's answer.\nQUESTION: ${question}\nGOLD ANSWER: ${gold}\nMODEL ANSWER: ${hyp}\n\nThe model answer is CORRECT if it conveys the same essential information as the gold answer (paraphrase ok, extra detail ok). If the gold answer indicates the question is unanswerable/abstention, the model is correct only if it declines or says it doesn't know.\nJSON only: {"correct": true|false}`,
        { type: "object", properties: { correct: { type: "boolean" } }, required: ["correct"] }, 8192);
      const m = out.match(/\{[\s\S]*\}/);
      return m ? !!JSON.parse(m[0]).correct : false;
    };
    const qaByType = {}; const qaDetail = [];
    let done = 0;
    for (const q of questions) {
      const gold = q.answer ?? q.gold_answer ?? "";
      if (!gold) continue;
      try {
        // Condition A — SC memory. T5b upgrades (each measured against the T5
        // baseline run):
        //  - type-aware K: multi-session answers span MANY gold sessions
        //  - CHRONOLOGICAL DATED context: the T5 run showed the dated session
        //    stream (baseline format) beat unordered chunks even when retrieval
        //    recall was higher — so SC context now renders the same way
        //  - deterministic temporal solver statement leads the context
        const K = q.question_type === "multi-session" ? 16 : 10;
        const r = await api("POST", "/api/v1/search", { projectPath: LME_PROJECT, queries: [q.question], limit: K, question_date: q.question_date });
        const dated = (r.results ?? []).map((x) => ({
          date: (x.firstSeenAt ?? x.createdAt ?? "").slice(0, 10) || "undated",
          text: (x.content ?? x.snippet ?? "").slice(0, 4000),
        })).sort((a, b) => (a.date < b.date ? -1 : 1));
        const solved = r.temporal?.statement ? `COMPUTED TEMPORAL FACTS (deterministic date math — trust these numbers):\n${r.temporal.statement}\n\n` : "";
        const scCtx = (solved + dated.map((d) => `SESSION (${d.date}):\n${d.text}`).join("\n\n")).slice(0, 44_000);
        const scAns = await genAnswer(scCtx || "(no results)", q.question);
        const scOk = await judgeAnswer(q.question, gold, scAns);
        // Condition B — truncated full-context baseline (most recent last, cap ~48k chars)
        const sessions = (q.haystack_sessions ?? []).map((s, i) => ({
          date: q.haystack_dates?.[i] ?? "", text: (s ?? []).map((t) => `${t.role}: ${t.content}`).join("\n") }));
        let base = "";
        for (let i = sessions.length - 1; i >= 0 && base.length < 48_000; i--) {
          base = `SESSION (${sessions[i].date}):\n${sessions[i].text}\n\n` + base;
        }
        const baseAns = await genAnswer(base.slice(-48_000), q.question);
        const baseOk = await judgeAnswer(q.question, gold, baseAns);
        const t = (qaByType[q.question_type ?? "unknown"] ??= { n: 0, sc: 0, base: 0 });
        t.n++; if (scOk) t.sc++; if (baseOk) t.base++;
        qaDetail.push({ id: q.question_id, type: q.question_type, scOk, baseOk, scAns: scAns.slice(0, 200), baseAns: baseAns.slice(0, 200), gold: String(gold).slice(0, 200) });
      } catch (e) {
        qaDetail.push({ id: q.question_id, type: q.question_type, error: e.message.slice(0, 120) });
      }
      done++;
      process.stdout.write(`\rQA ${done}/${questions.length}…  `);
      writeFileSync(new URL(`longmemeval_qa.json`, dir), JSON.stringify({ scoredAt: new Date().toISOString(), generator: GEN, judge: JUDGE, qaByType, qaDetail }, null, 2));
    }
    console.log("\n=== LongMemEval END-TO-END QA (local generator: " + GEN + ", judge: " + JUDGE + ") ===");
    console.table(Object.fromEntries(Object.entries(qaByType).map(([k, t]) =>
      [k, { n: t.n, "SC%": pct(t.sc, t.n), "baseline%": pct(t.base, t.n), "delta": +(pct(t.sc, t.n) - pct(t.base, t.n)).toFixed(1) }])));
    const tot = Object.values(qaByType).reduce((a, t) => ({ n: a.n + t.n, sc: a.sc + t.sc, base: a.base + t.base }), { n: 0, sc: 0, base: 0 });
    console.log(`OVERALL: SC ${pct(tot.sc, tot.n)}% vs baseline ${pct(tot.base, tot.n)}% (delta ${+(pct(tot.sc, tot.n) - pct(tot.base, tot.n)).toFixed(1)} pts, n=${tot.n})`);
    console.log("saved bench/results/longmemeval_qa.json");
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };

if (has("--purge")) await purge();
else if (has("--seed")) await seed();
else if (has("--score")) await score(val("--stage") ?? "baseline");
else if (has("--compare")) { const [a, b] = args.slice(args.indexOf("--compare") + 1); compare(a, b); }
else if (has("--longmemeval")) await runLongMemEval(val("--longmemeval"), parseInt(val("--limit") ?? "50", 10));
else console.log("usage: --seed | --score --stage <name> | --compare <a> <b> | --purge | --longmemeval <dataset.json> [--limit N]");
