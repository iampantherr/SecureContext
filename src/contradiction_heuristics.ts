/**
 * Shared, pure contradiction heuristics (Tier-1 B) — NO DB/embedding deps.
 * Used by BOTH the SQLite scan (memory_contradictions.ts) and the PG scan
 * (store-postgres.ts) so the two backends flag identical pairs.
 *
 * A pair is a candidate ONLY when it is both semantically similar (cosine ≥ SIM_HIGH,
 * checked by the caller) AND carries a conflict signal (decided here). Cosine alone is
 * similarity, not contradiction — the signal is mandatory.
 */

// Cosine threshold. Empirically, genuine contradictions ("keep X" vs "removed X",
// "will pass" vs "failed") embed at ~0.72–0.79 with nomic-embed-text, while unrelated
// facts sit ~0.50 — so 0.82 was too strict (missed real conflicts). 0.70 catches them
// with margin; the mandatory conflict signal still excludes merely-similar non-conflicts.
// Env-tunable so the threshold can be calibrated without a rebuild.
export const SIM_HIGH = parseFloat(process.env["ZC_CONTRADICTION_SIM"] ?? "0.70");
export const MAX_SCAN_FACTS = 80; // cap embeddings per scan (importance-desc → highest-value first)

export interface FactLite {
  key:                string;
  value:              string;
  kind?:              string | null;
  resolution_status?: string | null;
}

// semantic_conflict fires on an ACTION-REVERSAL polarity flip (one fact undoes what the
// other asserts), NOT on generic negation. Generic "not/never/avoid/cannot" appears in
// ordinary prose and caused false positives ("X verified" vs "X shipped"); restricting to
// undo-verbs keeps the real cases ("Keep X" vs "Removed X") while killing the noise.
const ACTION_REVERSAL = /\b(removed|deleted|dropped|disabled|deprecated|reverted|archived|abandoned|killed|undone|rolled back|backed out|scrapped|got rid of|turned off)\b/;
export function hasNegation(s: string): boolean { return ACTION_REVERSAL.test(s.toLowerCase()); }

export function tokenJaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Returns the conflict signal for a (already-similar) pair, or null if there's no conflict. */
export function detectConflict(a: FactLite, b: FactLite): { reason: string; detail: string } | null {
  const aFalsified = a.resolution_status === "resolved_incorrect";
  const bFalsified = b.resolution_status === "resolved_incorrect";
  const aLive = !a.resolution_status || a.resolution_status === "open";
  const bLive = !b.resolution_status || b.resolution_status === "open";
  if ((aFalsified && bLive) || (bFalsified && aLive)) {
    return { reason: "resolution_conflict", detail: "A near-duplicate claim was marked resolved_incorrect while the other is still asserted as live." };
  }
  if (a.kind === "decision" && b.kind === "decision" && tokenJaccard(a.value, b.value) < 0.5) {
    return { reason: "decision_reversal", detail: "Two decisions about the same topic appear to disagree (high semantic overlap, low textual overlap)." };
  }
  if (hasNegation(a.value) !== hasNegation(b.value)) {
    return { reason: "semantic_conflict", detail: "Highly similar claims with opposite polarity (one negates what the other asserts)." };
  }
  return null;
}
