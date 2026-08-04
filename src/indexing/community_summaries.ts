/**
 * Community summaries + global query mode (v0.37.0 — Tier-1 #4)
 * ==============================================================
 *
 * GraphRAG-style corpus-level Q&A at local cost: the enrichment cycle pre-computes ONE
 * LLM summary per Louvain community (budgeted, local Ollama), and `zc_search
 * {mode:"global"}` answers "what does this project know overall?" questions by
 * map-reducing over those few pre-computed summaries — hundreds of tokens per query
 * instead of GraphRAG's full community traversal. A DRIFT-lite touch: the answer call
 * also returns community-guided follow-up queries the agent can run as normal searches.
 */

export interface CommunitySummaryRow {
  community_id:   number;
  size:           number;
  sample_sources: string;   // comma-joined, for display
  summary:        string;
}

const SUMMARY_MODEL = process.env["ZC_ENTITY_MODEL"] ?? process.env["ZC_HYDE_MODEL"] ?? "qwen2.5-coder:14b";


async function ollamaGenerate(prompt: string, json: boolean, maxTokens: number): Promise<string | null> {
  try {
    const r = await fetch(`${ollamaBase()}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SUMMARY_MODEL, prompt, stream: false, ...(json ? { format: "json" } : {}),
        options: { temperature: 0.2, num_predict: maxTokens },
      }),
    });
    if (!r.ok) return null;
    const j = await r.json() as { response: string };
    return (j.response ?? "").trim() || null;
  } catch { return null; }
}

/** One community → one 2-4 sentence summary. Null on Ollama failure (retry next cycle). */
export async function summarizeCommunity(
  members: Array<{ source: string; snippet: string }>,
): Promise<string | null> {
  const body = members.slice(0, 12)
    .map((m) => `- [${m.source}] ${m.snippet.replace(/\s+/g, " ").slice(0, 220)}`)
    .join("\n");
  return ollamaGenerate(
    `These knowledge-base entries form one thematic cluster in a software project's memory. ` +
    `Summarize WHAT THIS CLUSTER IS ABOUT in 2-4 sentences (topic, key facts, current state). ` +
    `Be concrete; no preamble.\n\nENTRIES:\n${body}\n\nSUMMARY:`,
    false, 220,
  );
}

// ── SQLite variant (parity) ──────────────────────────────────────────────────
import type { DatabaseSync } from "node:sqlite";
import { ollamaBase } from "../config.js";
import { detectCommunitiesFromRows } from "./community.js";

/** Fetch → (generate on miss) → answer, all against one open project DB. */
export async function globalSearchOnDb(
  db: DatabaseSync,
  question: string,
): Promise<{ answer: string; followups: string[]; communities: CommunitySummaryRow[] } | null> {
  const fetchSums = (): CommunitySummaryRow[] => {
    try {
      return db.prepare(
        "SELECT community_id, size, sample_sources, summary FROM community_summaries ORDER BY size DESC LIMIT 12"
      ).all() as unknown as CommunitySummaryRow[];
    } catch { return []; }
  };
  let sums = fetchSums();
  if (sums.length === 0) {
    // Generate on demand: Louvain over KB + live memory, summarize top clusters, persist.
    try {
      const rows = db.prepare("SELECT source, content FROM knowledge").all() as Array<{ source: string; content: string }>;
      try {
        const wm = db.prepare(
          "SELECT ('memory:' || agent_id || ':' || key) AS source, value AS content FROM working_memory WHERE valid_to IS NULL LIMIT 300"
        ).all() as Array<{ source: string; content: string }>;
        for (const r of wm) rows.push(r);
      } catch { /* wm absent */ }
      const det = detectCommunitiesFromRows(rows);
      // v0.37.0 E2E fix: singletons count — see PG refreshCommunitySummaries.
      const top = det.communities.filter((c) => c.size >= 1).slice(0, 8);
      if (top.length > 0) {
        const contentBySource = new Map(rows.map((r) => [r.source, r.content]));
        const membersOf = new Map<number, Array<{ source: string; snippet: string }>>();
        for (const a of det.assignments) {
          const list = membersOf.get(a.communityId) ?? [];
          if (list.length < 12) list.push({ source: a.source, snippet: (contentBySource.get(a.source) ?? "").slice(0, 300) });
          membersOf.set(a.communityId, list);
        }
        const now = new Date().toISOString();
        db.exec(`CREATE TABLE IF NOT EXISTS community_summaries (
          community_id INTEGER PRIMARY KEY, size INTEGER NOT NULL, sample_sources TEXT NOT NULL,
          summary TEXT NOT NULL, computed_at TEXT NOT NULL)`);
        db.exec("DELETE FROM community_summaries");
        for (const c of top) {
          const s = await summarizeCommunity(membersOf.get(c.id) ?? []);
          if (s === null) break; // Ollama down — keep what we have
          db.prepare(
            "INSERT OR REPLACE INTO community_summaries(community_id, size, sample_sources, summary, computed_at) VALUES (?,?,?,?,?)"
          ).run(c.id, c.size, c.sampleSources.slice(0, 4).join(","), s, now);
        }
      }
    } catch { /* best-effort generation */ }
    sums = fetchSums();
  }
  if (sums.length === 0) return null;
  const res = await answerGlobal(question, sums);
  return res ? { ...res, communities: sums } : null;
}

/**
 * Global answer: map-reduce over the pre-computed community summaries.
 * Returns the answer + DRIFT-lite follow-up queries, or null on Ollama failure.
 */
export async function answerGlobal(
  question: string,
  summaries: CommunitySummaryRow[],
): Promise<{ answer: string; followups: string[] } | null> {
  const ctx = summaries.slice(0, 12)
    .map((s) => `[cluster ${s.community_id} · ${s.size} sources · e.g. ${s.sample_sources.split(",").slice(0, 2).join(", ")}]\n${s.summary}`)
    .join("\n\n");
  const raw = await ollamaGenerate(
    `You answer corpus-level questions about a software project using its knowledge-cluster ` +
    `summaries below. Answer the QUESTION from the clusters (cite cluster ids like [cluster 2]); ` +
    `if the clusters don't cover it, say what's missing. Then propose up to 3 short follow-up ` +
    `search queries (keyword style) that would drill into the most relevant clusters.\n\n` +
    `CLUSTERS:\n${ctx}\n\nQUESTION: ${question}\n\n` +
    `Return ONLY JSON: {"answer": "...", "followups": ["query", ...]}`,
    true, 500,
  );
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { answer?: unknown; followups?: unknown[] };
    const answer = typeof j.answer === "string" ? j.answer.trim() : "";
    if (!answer) return null;
    const followups = (Array.isArray(j.followups) ? j.followups : [])
      .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      .slice(0, 3);
    return { answer, followups };
  } catch { return null; }
}
