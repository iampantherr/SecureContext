/**
 * v0.20.0 — Sprint 4 retrieval upgrades: reranker + HyDE + multi-hop.
 *
 * All three are OPTIONAL modes layered over the existing hybrid BM25+vector
 * search in knowledge.ts. None change default zc_search behavior — they
 * activate via opts:
 *
 *   zc_search([q])                                    → existing behavior (unchanged)
 *   zc_search([q], { rerank: true })                  → adds reranker pass
 *   zc_search([q], { mode: 'hyde' })                  → HyDE — embed hypothetical answer
 *   zc_search([q], { mode: 'multihop', depth: 2 })    → follow file/URL refs in results
 *
 * Configuration:
 *   ZC_RERANKER_MODEL   default 'bge-reranker-v2-m3' (Ollama)
 *   ZC_HYDE_MODEL       default 'qwen2.5-coder:14b'  (Ollama)
 *   ZC_OLLAMA_URL       existing
 */

import type { KnowledgeEntry } from "./knowledge.js";
import { logger } from "./logger.js";

// v0.20.0 — strip any /api/* suffix from ZC_OLLAMA_URL so we can build
// path-specific URLs. Reranker uses /api/embeddings; HyDE uses /api/generate.
function ollamaBase(): string {
  const raw = process.env.ZC_OLLAMA_URL ?? "http://localhost:11435";
  return raw.replace(/\/api\/[^/]+\/?$/, "").replace(/\/$/, "");
}
const OLLAMA_URL     = ollamaBase();
const RERANKER_MODEL = process.env.ZC_RERANKER_MODEL ?? "bge-reranker-v2-m3";
const HYDE_MODEL     = process.env.ZC_HYDE_MODEL ?? "qwen2.5-coder:14b";

// ─── Reranker (Sprint 4 #10) ──────────────────────────────────────────────

/**
 * Rerank candidates using a cross-encoder via Ollama. Falls back to original
 * order on failure (e.g. model not pulled). Returns top N.
 *
 * Uses the Ollama embeddings API as a stand-in: we get pairwise embeddings
 * for (query, candidate) and score by cosine. For native cross-encoder
 * reranking, the operator can pull bge-reranker-v2-m3 and the model will
 * return rerank scores. Until then, we approximate with embedding cosine —
 * still a quality improvement over pure BM25 for ambiguous queries.
 *
 * Note: Ollama doesn't yet have a unified reranker API across all models
 * (as of late 2025). We use the embeddings approach because it works with
 * any embedding model. When bge-reranker-v2-m3 ships proper API support
 * via Ollama, swap in the call.
 */
export async function rerankCandidates(
  query:      string,
  candidates: KnowledgeEntry[],
  topN:       number = 10,
): Promise<KnowledgeEntry[]> {
  if (candidates.length <= topN) return candidates;
  try {
    // Pull query embedding once
    const qEmbed = await ollamaEmbed(query, RERANKER_MODEL);
    if (!qEmbed) return candidates.slice(0, topN);

    // Score each candidate against the query
    const scored: Array<{ ent: KnowledgeEntry; rerank_score: number }> = [];
    for (const c of candidates) {
      const text = `${c.source}\n${c.snippet ?? ""}`.slice(0, 1500);
      const cEmbed = await ollamaEmbed(text, RERANKER_MODEL);
      if (!cEmbed) { scored.push({ ent: c, rerank_score: 0 }); continue; }
      scored.push({ ent: c, rerank_score: cosine(qEmbed, cEmbed) });
    }
    scored.sort((a, b) => b.rerank_score - a.rerank_score);
    return scored.slice(0, topN).map(s => ({
      ...s.ent,
      // Override vectorScore with rerank score for downstream sorting
      vectorScore: s.rerank_score,
    }));
  } catch (e) {
    logger.warn("retrieval", "rerank_failed", { error: (e as Error).message });
    return candidates.slice(0, topN);
  }
}

// ─── HyDE (Sprint 4 #11a) ─────────────────────────────────────────────────

/**
 * HyDE: generate a hypothetical answer to the query, then search BY that
 * answer's embedding instead of the raw query. Empirically yields 10-25%
 * precision lift on long-tail queries because the generated answer's
 * embedding is closer in semantic space to the actual answer's embedding
 * than the query itself is.
 *
 * Returns the hypothetical answer text — caller passes it to searchKnowledge
 * as the query.
 */
export async function generateHydeQuery(query: string): Promise<string> {
  const url = `${OLLAMA_URL.replace(/\/$/, "")}/api/generate`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: HYDE_MODEL,
        prompt: `Write a 2-3 sentence hypothetical answer to this question. Be specific and use technical terms an expert would use, even if you're guessing. The answer should LOOK LIKE a real answer might.\n\nQUESTION: ${query}\n\nHYPOTHETICAL ANSWER:`,
        stream: false,
        options: { temperature: 0.5, num_predict: 200 },
      }),
    });
    if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
    const j = await r.json() as { response: string };
    const hypothetical = (j.response ?? "").trim();
    if (!hypothetical) return query;  // fall back to original
    // Combine: original query + hypothetical (best of both worlds)
    return `${query}\n\n${hypothetical}`;
  } catch (e) {
    logger.warn("retrieval", "hyde_generation_failed", { error: (e as Error).message });
    return query;
  }
}

// ─── Multi-hop (Sprint 4 #11b) ────────────────────────────────────────────

/**
 * Multi-hop retrieval: take initial results, extract referenced sources
 * (file paths, URLs, code identifiers), search for those, optionally
 * recurse. Returns deduplicated set sorted by aggregate relevance.
 *
 * The reference extraction is pattern-based: looks for markdown links,
 * file-path patterns ([a-z_/]+\.[a-z]{1,5}), code identifiers in backticks.
 */

export interface MultiHopOptions {
  depth:           number;             // recursion depth (default 2)
  maxResultsPerHop: number;            // cap per-hop expansion (default 5)
  searchFn:        (q: string[]) => Promise<KnowledgeEntry[]>;
}

const REFERENCE_PATTERNS = [
  /\[([^\]]+)\]\([^)]+\)/g,                     // markdown links — capture link text
  /\b[\w\-./]+\.(md|ts|tsx|js|jsx|py|json|yml|yaml|sql|sh|ps1)\b/gi, // file paths
  /https?:\/\/[^\s)\]]+/g,                       // URLs
];

function extractReferences(text: string): string[] {
  const refs = new Set<string>();
  for (const re of REFERENCE_PATTERNS) {
    const matches = text.matchAll(re);
    for (const m of matches) {
      const ref = m[1] ?? m[0];
      if (ref && ref.length < 200) refs.add(ref.trim());
    }
  }
  return [...refs].slice(0, 10);  // cap per-source
}

export async function multiHopSearch(
  initialQueries: string[],
  opts:           MultiHopOptions,
): Promise<KnowledgeEntry[]> {
  const seen = new Set<string>();
  const all: KnowledgeEntry[] = [];

  // Hop 0: initial query
  const hop0 = await opts.searchFn(initialQueries);
  for (const r of hop0) {
    if (seen.has(r.source)) continue;
    seen.add(r.source); all.push(r);
  }

  // Hops 1..depth: extract refs from prior hop, search
  let prevHopResults = hop0.slice(0, opts.maxResultsPerHop);
  for (let depth = 1; depth <= opts.depth; depth++) {
    if (prevHopResults.length === 0) break;
    const refs: string[] = [];
    for (const r of prevHopResults) {
      const text = `${r.source} ${r.snippet ?? ""}`;
      refs.push(...extractReferences(text));
    }
    if (refs.length === 0) break;
    const dedupedRefs = [...new Set(refs)].slice(0, opts.maxResultsPerHop * 2);
    const hopResults = await opts.searchFn(dedupedRefs);
    const newResults: KnowledgeEntry[] = [];
    for (const r of hopResults) {
      if (seen.has(r.source)) continue;
      seen.add(r.source);
      // Decay score by depth so initial results rank higher
      const decay = Math.pow(0.7, depth);
      const decayed: KnowledgeEntry = { ...r, vectorScore: (r.vectorScore ?? 0) * decay };
      all.push(decayed); newResults.push(decayed);
    }
    prevHopResults = newResults.slice(0, opts.maxResultsPerHop);
  }

  // Final sort by score (vectorScore stands in for combined relevance after decay)
  all.sort((a, b) => (b.vectorScore ?? 0) - (a.vectorScore ?? 0));
  return all;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

async function ollamaEmbed(text: string, model: string): Promise<number[] | null> {
  try {
    const r = await fetch(`${OLLAMA_URL.replace(/\/$/, "")}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text.slice(0, 4000) }),
    });
    if (!r.ok) return null;
    const j = await r.json() as { embedding?: number[] };
    return j.embedding ?? null;
  } catch { return null; }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
