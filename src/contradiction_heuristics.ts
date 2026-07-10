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
  created_at?:        string | Date | null;  // needed by auto-resolution (PG returns Date)
}

/**
 * v0.37.0 — CONSERVATIVE auto-resolution: when a flagged pair has a clear supersession,
 * return the key of the fact to RETIRE (the stale side); return null when ambiguous
 * (→ operator triage, exactly as before). Clear supersession requires ALL of:
 *   - the conflict is a polarity flip or decision reversal (never resolution_conflict —
 *     a falsified-claim clash is a judgment call for a human),
 *   - a strict time ordering (> 60s apart, so same-burst writes stay ambiguous),
 *   - the NEWER fact carries an action-reversal verb ("removed/reverted/dropped…") and
 *     the OLDER does not — i.e. the newer fact explicitly undoes the older state.
 * The retire is non-destructive (valid_to + KB archival + dashboard Undo), which is what
 * makes auto-application acceptable here at all.
 */
export function autoResolveVictim(a: FactLite, b: FactLite, reason: string): string | null {
  if (reason !== "semantic_conflict" && reason !== "decision_reversal") return null;
  const ts = (f: FactLite): number => {
    if (f.created_at == null) return NaN;
    return f.created_at instanceof Date ? f.created_at.getTime() : Date.parse(String(f.created_at));
  };
  const ta = ts(a), tb = ts(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || Math.abs(ta - tb) < 60_000) return null;
  const newer = ta > tb ? a : b;
  const older = ta > tb ? b : a;
  if (hasNegation(newer.value) && !hasNegation(older.value)) return older.key;
  return null;
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

/**
 * R2 (v0.42.0) — deterministic numeric divergence: two claims carrying DIFFERENT
 * number tokens (TTLs, limits, versions, ports) are different claims. Shared by
 * the consolidation cycle (as a merge VETO) and the contradiction detector (as a
 * flag REASON): measured on a labeled corpus, contradicting same-topic facts hit
 * cosine 0.947 — ABOVE the paraphrase range — so similarity alone can't catch them.
 */
export function numbersDiffer(a: string, b: string): boolean {
  const nums = (s: string) => new Set((s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
  const na = nums(a), nb = nums(b);
  if (na.size === 0 && nb.size === 0) return false;
  if (na.size !== nb.size) return true;
  for (const n of na) if (!nb.has(n)) return true;
  return false;
}

/** Similarity floor for the numeric_conflict signal — higher than SIM_HIGH because
 *  differing numbers in merely-related facts (two different limits on two different
 *  things) are normal; only near-identical claims disagreeing on the NUMBER are
 *  contradictions ("cache TTL is 15 min" vs "cache TTL is 60 min"). */
export const NUMERIC_CONFLICT_SIM = parseFloat(process.env["ZC_NUMERIC_CONFLICT_SIM"] ?? "0.85");

/** Returns the conflict signal for a (already-similar) pair, or null if there's no conflict.
 *  `sim` (optional): the pair's cosine similarity — enables the numeric_conflict signal. */
export function detectConflict(a: FactLite, b: FactLite, sim?: number): { reason: string; detail: string } | null {
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
  // R2 — numeric conflict: near-identical claims that disagree on the NUMBER.
  // Never auto-resolved (autoResolveVictim only handles semantic_conflict /
  // decision_reversal) — these go to the operator triage dashboard.
  if (typeof sim === "number" && sim >= NUMERIC_CONFLICT_SIM && numbersDiffer(a.value, b.value)) {
    return { reason: "numeric_conflict", detail: "Near-identical claims that disagree on a number (limit/TTL/version) — likely one superseded the other." };
  }
  return null;
}
