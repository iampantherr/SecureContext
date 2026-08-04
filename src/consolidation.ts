/**
 * M2 (v0.41.0) — Memory consolidation: merge near-duplicate working-memory facts.
 *
 * Over weeks, agents re-state the same durable fact in different words
 * ("ESLint with the shared config is mandatory" / "Every package must extend the
 * shared ESLint preset"). Each variant occupies a recall slot, competes in
 * retrieval, and pushes real facts toward eviction. The Zep/Graphiti research
 * confirmed dedup-merge quality as a competitor edge (embedding+LLM entity
 * resolution) — and that NO competitor runs background fact-level consolidation,
 * so this cycle is a leapfrog, not a catch-up.
 *
 * CONSERVATIVE by design:
 *   - only facts in the SAME (project, agent) namespace and of the SAME kind;
 *   - only pairs with cosine ≥ CONSOLIDATE_SIM (default 0.90 — paraphrase-level);
 *   - never a pair the contradiction heuristics would flag (a conflict is not a
 *     duplicate — that pair belongs to the triage dashboard instead);
 *   - the merge is LLM-written; if the local model fails or returns junk, the
 *     pair is SKIPPED (no destructive action without a valid canonical text);
 *   - the loser is RETIRED (superseded_by=survivor, retired_reason='consolidated')
 *     — revivable for RETIRE_PURGE_DAYS like any retirement, never deleted;
 *   - budgeted per enrichment cycle (CONSOLIDATE_MAX_PER_CYCLE).
 *
 * Kill-switch: ZC_CONSOLIDATE=0.
 */

import { Config, ollamaBase } from "./config.js";
import { detectConflict, numbersDiffer } from "./contradiction_heuristics.js";

// R2 (v0.42.0): numbersDiffer moved to contradiction_heuristics (shared with the
// contradiction detector's numeric_conflict signal); re-exported for existing users.
export { numbersDiffer };

export const CONSOLIDATE_ENABLED = process.env["ZC_CONSOLIDATE"] !== "0";
// Calibrated on nomic-embed-text against a labeled corpus: true paraphrases
// measure 0.767-0.897; same-cluster-but-different facts 0.48-0.62. 0.75 splits
// with margin. NOTE: similarity alone is NOT sufficient — contradicting facts
// about the same topic can score HIGHER than paraphrases (a measured 15-min vs
// 60-min cache-TTL pair hit 0.947) — hence the deterministic guards below.
export const CONSOLIDATE_SIM = parseFloat(process.env["ZC_CONSOLIDATE_SIM"] ?? "0.75");
export const CONSOLIDATE_MAX_PER_CYCLE = parseInt(process.env["ZC_CONSOLIDATE_MAX"] ?? "5", 10);

// (numbersDiffer lives in contradiction_heuristics.ts since R2 — imported above.)

const MERGE_MODEL = process.env["ZC_ENTITY_MODEL"] ?? process.env["ZC_HYDE_MODEL"] ?? "qwen2.5-coder:14b";


export interface ConsolidationCandidate {
  key: string;
  value: string;
  importance: number;
  kind: string | null;
  created_at: string | Date;
  agent_id: string;
}

/** LLM-merge two paraphrase facts into one canonical statement. Null = skip pair. */
export async function llmMergeFacts(a: string, b: string): Promise<string | null> {
  const prompt =
    "These two statements from an engineering team's memory say the same thing in different words. " +
    "Write ONE canonical statement that preserves EVERY concrete detail from both (numbers, names, " +
    "tools, conditions). Output ONLY the merged statement, one sentence if possible, max 350 characters. " +
    "If they actually say DIFFERENT things, output exactly: NOT_DUPLICATE\n\n" +
    `A: ${a}\nB: ${b}`;
  try {
    const r = await fetch(`${ollamaBase()}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MERGE_MODEL, prompt, stream: false,
        options: { temperature: 0.1, num_predict: 160 },
      }),
    });
    if (!r.ok) return null;
    const j = await r.json() as { response: string };
    const text = (j.response ?? "").trim();
    if (!text || text.length < 15 || text.length > 400) return null;
    if (/NOT_DUPLICATE/i.test(text)) return null; // model disagrees — trust the veto
    return text;
  } catch { return null; }
}

/**
 * Select mergeable pairs from a set of same-(project,agent) live facts with vectors.
 * Pure + synchronous — unit-testable without a database. Greedy: each fact joins at
 * most one pair per cycle (avoids merge chains racing each other).
 */
export function selectMergePairs(
  facts: ConsolidationCandidate[],
  vectors: Map<string, Float32Array>,
  cosine: (a: Float32Array, b: Float32Array) => number,
  simThreshold: number = CONSOLIDATE_SIM,
): Array<{ a: ConsolidationCandidate; b: ConsolidationCandidate; sim: number }> {
  const pairs: Array<{ a: ConsolidationCandidate; b: ConsolidationCandidate; sim: number }> = [];
  const used = new Set<string>();
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const A = facts[i]!, B = facts[j]!;
      if (used.has(A.key) || used.has(B.key)) continue;
      if ((A.kind ?? "fact") !== (B.kind ?? "fact")) continue;      // never across kinds
      if (A.agent_id !== B.agent_id) continue;                       // never across namespaces
      const va = vectors.get(A.key), vb = vectors.get(B.key);
      if (!va || !vb) continue;
      const sim = cosine(va, vb);
      if (sim < simThreshold) continue;
      // Different numbers = different claims (measured: contradicting TTL facts
      // score 0.947 — ABOVE paraphrase range). Deterministic, LLM-independent.
      if (numbersDiffer(A.value, B.value)) continue;
      // A conflict is NOT a duplicate — leave those to the contradiction triage.
      if (detectConflict(
        { key: A.key, value: A.value, kind: A.kind, resolution_status: null, created_at: A.created_at },
        { key: B.key, value: B.value, kind: B.kind, resolution_status: null, created_at: B.created_at },
      )) continue;
      used.add(A.key); used.add(B.key);
      pairs.push({ a: A, b: B, sim });
    }
  }
  return pairs;
}

/** Survivor policy: higher importance wins; tie → OLDER fact keeps its key (stability). */
export function pickSurvivor(a: ConsolidationCandidate, b: ConsolidationCandidate): {
  survivor: ConsolidationCandidate; loser: ConsolidationCandidate;
} {
  if (a.importance !== b.importance) {
    return a.importance > b.importance ? { survivor: a, loser: b } : { survivor: b, loser: a };
  }
  const ta = new Date(a.created_at).getTime(), tb = new Date(b.created_at).getTime();
  return ta <= tb ? { survivor: a, loser: b } : { survivor: b, loser: a };
}

// Config referenced so tree-shaking keeps the import (and future knobs live here).
void Config;
