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
  const numericOk = reason === "numeric_conflict" && AUTO_RESOLVE_NUMERIC;
  if (reason !== "semantic_conflict" && reason !== "decision_reversal" && !numericOk) return null;
  const ts = (f: FactLite): number => {
    if (f.created_at == null) return NaN;
    return f.created_at instanceof Date ? f.created_at.getTime() : Date.parse(String(f.created_at));
  };
  const ta = ts(a), tb = ts(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || Math.abs(ta - tb) < 60_000) return null;
  const newer = ta > tb ? a : b;
  const older = ta > tb ? b : a;
  if (numericOk) {
    // S1 (v0.44.0) — a numeric conflict auto-supersedes ONLY when the NEWER value
    // explicitly announces the change ("now", "changed to", "migrated to"...) and
    // the older doesn't. Without the marker it stays operator triage — a bare
    // number flip is either an update or an error, and only a human can tell.
    return hasUpdateMarkers(newer.value) && !hasUpdateMarkers(older.value) ? older.key : null;
  }
  if (hasNegation(newer.value) && !hasNegation(older.value)) return older.key;
  return null;
}

/** S1 — explicit change-announcement language: the newer fact SAYS it replaces prior state. */
const UPDATE_MARKERS = /\b(now|no longer|migrated(?: to)?|changed to|updated to|increased to|reduced to|raised to|lowered to|moved to|switched to|instead of|replac(?:es|ed|ing)|supersed(?:es|ed))\b/;
export function hasUpdateMarkers(s: string): boolean { return UPDATE_MARKERS.test(s.toLowerCase()); }
/** Kill-switch for numeric auto-supersession (ZC_AUTO_RESOLVE_NUMERIC=0 → triage-only, v0.42 behaviour). */
export const AUTO_RESOLVE_NUMERIC = process.env["ZC_AUTO_RESOLVE_NUMERIC"] !== "0";

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

/**
 * S1 (v0.44.0) — retrieval-time PREFER-LATEST: among the already-RANKED top
 * candidates of a focused recall, find near-identical conflicting pairs
 * (sim ≥ NUMERIC_CONFLICT_SIM + a conflict signal) and demote the fact with the
 * OLDER event-time to just below the newer one. Pure ranking adjustment — the
 * stored facts are untouched, and callers MUST skip this when the query carries
 * a temporal window / as-of (historical questions want the old fact).
 *
 * Returns a map of key → adjusted score for the demoted facts only.
 */
export function preferLatestAdjust<F extends FactLite>(
  top: Array<{ fact: F; score: number; vec: Float32Array | undefined; ev: number }>,
  cosine: (a: Float32Array, b: Float32Array) => number,
  margin: number,
): Map<string, number> {
  const adjusted = new Map<string, number>();
  const scoreOf = (i: number): number => adjusted.get(top[i]!.fact.key) ?? top[i]!.score;
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const A = top[i]!, B = top[j]!;
      if (!A.vec || !B.vec || !Number.isFinite(A.ev) || !Number.isFinite(B.ev) || A.ev === B.ev) continue;
      const sim = cosine(A.vec, B.vec);
      if (sim < NUMERIC_CONFLICT_SIM) continue;
      if (!detectConflict(A.fact, B.fact, sim)) continue;
      const [newer, older] = A.ev > B.ev ? [i, j] : [j, i];
      const demoted = Math.min(scoreOf(older), scoreOf(newer) - margin);
      if (demoted < scoreOf(older)) adjusted.set(top[older]!.fact.key, demoted);
    }
  }
  return adjusted;
}

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
  // R2/S1 — numeric conflict, TIGHTENED to two principled shapes (cosine alone
  // cannot establish "same claim": boilerplate-heavy agent notes embed ≥0.85
  // across different topics, and enumerated series entries embed ≥0.9 — both
  // flooded triage, measured 62-of-66 facts flagged on one corpus):
  //   (1) SAME TEMPLATE, ONE number changed — "retry limit is 3" → "retry limit
  //       is 8": digit-stripped texts identical, exactly one differing number.
  //   (2) MARKED UPDATE — near-identical claims where exactly one side announces
  //       the change ("now", "changed to", "migrated to"...).
  // Session summaries are multi-number NARRATIVES, not claims — a summary
  // mentioning "90 seconds" next to a fact saying "30 seconds" is not a conflict.
  const isSummary = (f: FactLite) => f.key === "last_session_summary" || f.key.startsWith("[SESSION_SUMMARY]");
  if (typeof sim === "number" && sim >= SIM_HIGH && !isSummary(a) && !isSummary(b) && numbersDiffer(a.value, b.value)) {
    // Branch (1) additionally requires the changed number to be a QUANTITY (followed
    // by a unit word: "15 minutes", "3 attempts"), not an ENUMERATOR ("detail 3:",
    // "Work log 12:") — log-style notes differ only in an index and are not conflicts
    // (measured: 23-of-80 boilerplate facts flagged on a mature corpus without this).
    const sameTemplateOneDiff =
      strippedTemplate(a.value) === strippedTemplate(b.value) &&
      numberDiffCount(a.value, b.value) === 1 &&
      diffNumberIsQuantity(a.value, b.value);
    const markedUpdate = hasUpdateMarkers(a.value) !== hasUpdateMarkers(b.value);
    // Per-branch similarity floors (measured): an update that ADDS a clause
    // ("…is now 90 seconds after the load-test results") dilutes cosine to
    // 0.80–0.84 — there the MARKER is the precision signal, so that branch uses
    // the scan candidate floor (SIM_HIGH). The bare template branch keeps the
    // stricter floor calibrated for unguarded numeric divergence.
    if ((sameTemplateOneDiff && sim >= NUMERIC_CONFLICT_SIM) || (markedUpdate && sim >= SIM_HIGH)) {
      return { reason: "numeric_conflict", detail: "Near-identical claims that disagree on a number (limit/TTL/version) — likely one superseded the other." };
    }
  }
  return null;
}

/** S1 — is the (single) differing number a quantity (followed by a unit word) in BOTH texts? */
export function diffNumberIsQuantity(a: string, b: string): boolean {
  const followsWord = (s: string, other: string): boolean => {
    const re = /\d+(?:\.\d+)?/g;
    const oNums = other.match(re) ?? [];
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(s)) !== null) {
      if (oNums[i] !== m[0]) {
        // this is the differing slot — quantity iff a word follows ("15 minutes")
        return /^\s+[a-zA-Z]/.test(s.slice(m.index + m[0].length));
      }
      i++;
    }
    return false;
  };
  return followsWord(a, b) && followsWord(b, a);
}

/** S1 — digit-stripped, whitespace-normalized template of a claim. */
export function strippedTemplate(s: string): string {
  return s.replace(/\d+(?:\.\d+)?/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
}

/** S1 — how many positional number slots differ between two texts (∞-proxy when counts differ). */
export function numberDiffCount(a: string, b: string): number {
  const nums = (s: string) => s.match(/\d+(?:\.\d+)?/g) ?? [];
  const na = nums(a), nb = nums(b);
  if (na.length !== nb.length) return Math.max(na.length, nb.length);
  let diffs = 0;
  for (let i = 0; i < na.length; i++) if (na[i] !== nb[i]) diffs++;
  return diffs;
}

/**
 * S1 — enumerated SERIES entries (same template, different instance): identical
 * digit-stripped template with ≥2 differing numbers ("log 12 … iteration 41" vs
 * "log 22 … iteration 42"). Kept as an exported helper; the tightened
 * numeric_conflict definition above excludes these by construction.
 */
export function isSeriesPair(a: string, b: string): boolean {
  return strippedTemplate(a) === strippedTemplate(b) && numberDiffCount(a, b) >= 2;
}
