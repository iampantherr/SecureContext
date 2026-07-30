/**
 * M3 (v0.41.0) — Zero-dependency natural-language temporal query parser.
 *
 * Turns time expressions inside a memory query into a structured window so
 * recall/search can rank or reconstruct by TIME, not just topic:
 *
 *   "what did we decide about caching last week"   → window [now-7d, now]
 *   "the rate limit decision about six weeks ago"  → window [now-7w, now-5w]
 *   "as of one month ago, where were uploads?"     → asOf now-30d (time travel)
 *   "changes in the last 2 weeks"                  → window [now-14d, now]
 *
 * Closes the verified competitive gaps in one move: Mem0 ships NL temporal
 * resolution (their headline 2026 feature); Graphiti exposes only STRUCTURED
 * valid_at/invalid_at range params and explicitly deferred NL resolution.
 * SC gets both: this parser feeds the same structured window the API also
 * accepts directly (dateFrom/dateTo/asOf).
 *
 * Deliberately conservative: recognizes a fixed set of English patterns and
 * returns {} when nothing matches — a query with no time expression behaves
 * exactly as before. "About N <unit> ago" widens to ±1 unit; bare "N <unit>
 * ago" widens ±half a unit (people are imprecise about the past).
 */

export interface TemporalWindow {
  /** Inclusive range: facts whose event-time falls inside rank first. */
  from?: Date;
  to?: Date;
  /** Point-in-time reconstruction: what was TRUE at this moment (includes
   *  facts retired SINCE then — time travel over the transaction timeline). */
  asOf?: Date;
  /** The query with the recognized temporal phrase removed, so embedding
   *  similarity concentrates on the topic words. */
  cleaned: string;
  /** The phrase that matched (for explain/debug surfaces). */
  matched?: string;
}

const UNIT_MS: Record<string, number> = {
  day: 86_400_000, days: 86_400_000,
  week: 7 * 86_400_000, weeks: 7 * 86_400_000,
  month: 30 * 86_400_000, months: 30 * 86_400_000,
  year: 365 * 86_400_000, years: 365 * 86_400_000,
};

const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function num(tok: string): number | null {
  const t = tok.toLowerCase();
  if (t in WORD_NUM) return WORD_NUM[t]!;
  const n = parseInt(t, 10);
  return Number.isFinite(n) && n > 0 && n <= 400 ? n : null;
}

const NUM_RE = "(\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const UNIT_RE = "(day|days|week|weeks|month|months|year|years)";

export function parseTemporalQuery(query: string, now: Date = new Date()): TemporalWindow {
  const q = query;
  const t = now.getTime();
  const strip = (m: RegExpMatchArray): string =>
    (q.slice(0, m.index!) + " " + q.slice(m.index! + m[0].length)).replace(/\s+/g, " ").trim();

  // ── "as of <N unit ago | yesterday>" — point-in-time reconstruction ──
  let m = q.match(new RegExp(`as of (?:about |around |roughly )?${NUM_RE}\\s+${UNIT_RE}\\s+ago`, "i"));
  if (m) {
    const n = num(m[1]!); const unit = UNIT_MS[m[2]!.toLowerCase()]!;
    if (n) return { asOf: new Date(t - n * unit), cleaned: strip(m), matched: m[0] };
  }
  m = q.match(/as of yesterday/i);
  if (m) return { asOf: new Date(t - UNIT_MS.day!), cleaned: strip(m), matched: m[0] };

  // ── "in the last / within the last / over the last / last N units" ──
  m = q.match(new RegExp(`(?:in |within |over |during )?the last ${NUM_RE}\\s+${UNIT_RE}`, "i"))
   ?? q.match(new RegExp(`(?:in |within |over |during )?the past ${NUM_RE}\\s+${UNIT_RE}`, "i"));
  if (m) {
    const n = num(m[1]!); const unit = UNIT_MS[m[2]!.toLowerCase()]!;
    if (n) return { from: new Date(t - n * unit), to: now, cleaned: strip(m), matched: m[0] };
  }

  // ── bare "last week/month/year" (the previous one ≈ trailing window) ──
  m = q.match(/\blast (week|month|year)\b/i);
  if (m) {
    const unit = UNIT_MS[m[1]!.toLowerCase()]!;
    return { from: new Date(t - unit), to: now, cleaned: strip(m), matched: m[0] };
  }
  m = q.match(/\bthis (week|month|year)\b/i);
  if (m) {
    const unit = UNIT_MS[m[1]!.toLowerCase()]!;
    return { from: new Date(t - unit), to: now, cleaned: strip(m), matched: m[0] };
  }
  m = q.match(/\byesterday\b/i);
  if (m) return { from: new Date(t - 2 * UNIT_MS.day!), to: new Date(t - UNIT_MS.day! / 2), cleaned: strip(m), matched: m[0] };
  m = q.match(/\btoday\b/i);
  if (m) return { from: new Date(t - UNIT_MS.day!), to: now, cleaned: strip(m), matched: m[0] };

  // ── "(about|around|roughly)? N units ago" — a POINT in the past, widened ──
  m = q.match(new RegExp(`(about |around |roughly |approximately )?${NUM_RE}\\s+${UNIT_RE}\\s+ago`, "i"));
  if (m) {
    const n = num(m[2]!); const unit = UNIT_MS[m[3]!.toLowerCase()]!;
    if (n) {
      const fuzzy = m[1] ? 1 : 0.5;                    // "about" widens more
      const center = t - n * unit;
      return {
        from: new Date(center - fuzzy * unit),
        to:   new Date(center + fuzzy * unit),
        cleaned: strip(m), matched: m[0],
      };
    }
  }

  // ── "since <Month> [Year]" / "in <Month> [Year]" / "before <Month> [Year]" ──
  const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const monRe = new RegExp(`\\b(since|in|before|after)\\s+(${MONTHS.join("|")})(?:\\s+(\\d{4}))?\\b`, "i");
  m = q.match(monRe);
  if (m) {
    const mi = MONTHS.indexOf(m[2]!.toLowerCase());
    const year = m[3] ? parseInt(m[3], 10)
      : (mi > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear()); // bare month = most recent occurrence
    const start = new Date(Date.UTC(year, mi, 1));
    const end   = new Date(Date.UTC(year, mi + 1, 1));
    const verb  = m[1]!.toLowerCase();
    if (verb === "since")  return { from: start, to: now, cleaned: strip(m), matched: m[0] };
    if (verb === "before") return { from: new Date(0), to: start, cleaned: strip(m), matched: m[0] };
    if (verb === "after")  return { from: end, to: now, cleaned: strip(m), matched: m[0] };
    return { from: start, to: end, cleaned: strip(m), matched: m[0] }; // "in March [2025]"
  }

  return { cleaned: q };
}


// ─── S11 (v0.46.1) — interrogative-scaffolding stripper ─────────────────────
//
// LongMemEval temporal-reasoning miss analysis: questions like "How many weeks
// ago did I attend the friends and family sale at Nordstrom?" retrieve poorly
// because the interrogative-temporal SCAFFOLDING ("how many weeks ago did I…",
// "…have passed since…") dominates the QUERY EMBEDDING — the discriminative
// content is the event description, but the vector mostly encodes the question
// form. BM25 is less affected (English stopwords) yet still spends weight on
// "days/weeks/passed".
//
// This helper removes only WHOLE scaffolding PHRASES (never bare content
// words), so declarative queries pass through byte-identical. Conservative
// guard: if stripping leaves fewer than 3 words, the original is returned.
// Kill switch: ZC_QUERY_DESCAFFOLD=0.

const SCAFFOLD_PHRASES: RegExp[] = [
  /\bhow\s+(?:many|much)\s+(?:days?|weeks?|months?|years?|hours?|time)\b/gi,
  /\bhow\s+long\s+(?:ago|has\s+it\s+been|had\s+it\s+been)?\b/gi,
  /\b(?:have|had|has)\s+(?:passed|elapsed|gone\s+by)\b/gi,
  /\bpassed\s+(?=between|since)\b/gi,   // keep the connective, drop "passed"
  /\b(?:days?|weeks?|months?|years?)\s+ago\b/gi,
  /\bago\b/gi,
  /\bwhat\s+is\s+the\s+order\s+of\b/gi,
  /\bin\s+what\s+order\b/gi,
  /\bwhich\s+(?:\w+\s+)?(?:events?\s+)?happened\s+(?:first|last|earlier|later)\b/gi,
  /\bfrom\s+(?:first|earliest)\s+to\s+(?:last|latest)\b/gi,
  /\bwhen\s+did\s+(?:i|we)\b/gi,
];

export function stripInterrogativeScaffolding(query: string): string {
  if (process.env["ZC_QUERY_DESCAFFOLD"] === "0") return query;
  let out = query;
  for (const re of SCAFFOLD_PHRASES) out = out.replace(re, " ");
  out = out.replace(/\s{2,}/g, " ").trim();
  // Conservative guard — never hand the matcher an empty/near-empty query.
  const words = out.split(/\s+/).filter((w) => /\w/.test(w));
  if (words.length < 3) return query;
  return out;
}

// ─── TR-2 (v0.46.1) — temporal-question detection + event-clause splitting ──
//
// Second lever from the LongMemEval miss analysis: the remaining temporal
// misses are COMPOUND questions — "How many days passed between the day I
// started watering my herb garden and the day I harvested…" — whose single
// query embedding is a blend of several events that matches none of them.
// `splitEventClauses` breaks such a question into its event descriptions so
// the search layer can retrieve PER CLAUSE and fuse the lists (RRF).
// Decomposition is TEMPORAL-SCOPED: the search layer only applies it when
// `isTemporalQuestion` fired, keeping the blast radius near zero for normal
// queries. Kill switch: ZC_QUERY_DECOMPOSE=0.

const TEMPORAL_QUESTION_RE = new RegExp(
  [
    String.raw`\bhow\s+(?:many|much)\s+(?:days?|weeks?|months?|years?|hours?|time)\b`,
    String.raw`\bhow\s+long\b`,
    String.raw`\b(?:days?|weeks?|months?|years?)\s+(?:ago|passed|had\s+passed|have\s+passed)\b`,
    String.raw`\bwhat\s+is\s+the\s+order\b`,
    String.raw`\bin\s+what\s+order\b`,
    String.raw`\bhappened\s+(?:first|last|earlier|later)\b`,
    String.raw`\bfrom\s+(?:first|earliest)\s+to\s+(?:last|latest)\b`,
    String.raw`\bwhen\s+did\s+(?:i|we)\b`,
  ].join("|"),
  "i",
);

/** True when the query is a temporal QUESTION (ordering / interval / when). */
export function isTemporalQuestion(query: string): boolean {
  return TEMPORAL_QUESTION_RE.test(query);
}

/**
 * Split a (descaffolded) compound temporal question into its event clauses.
 * Returns [] when the query is not usefully compound (fewer than 2 clauses
 * with ≥3 content words each) — callers treat [] as "search as-is".
 */
export function splitEventClauses(query: string): string[] {
  if (process.env["ZC_QUERY_DECOMPOSE"] === "0") return [];
  // Clause boundaries seen in real temporal questions: "…X and the day I Y…",
  // "…X when I Y…", "…X or Y…", "between X and Y", list commas before "the day I".
  const seeded = query
    .replace(/\bbetween\b/gi, " ")
    .split(/(?:,\s*)|(?:\b(?:and|or|when|while|before|after)\s+(?:the\s+day\s+)?(?:i|we|my)\b)|(?:\bthe\s+day\s+(?:i|we)\b)/i);
  const clauses = seeded
    .map((c) => c.replace(/[?.!]+$/g, "").replace(/^\W+|\W+$/g, "").trim())
    // Drop interrogative residue ("Which three events happened in the order…")
    // — clauses must be EVENT descriptions, not leftover question framing.
    .filter((c) => !/^(which|what|how|when|who|where|why)/i.test(c))
    .filter((c) => {
      const words = c.split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|did|was|were|have|had|has|that|this|with|for)$/i.test(w));
      return words.length >= 2;
    });
  return clauses.length >= 2 ? clauses.slice(0, 4) : [];
}
