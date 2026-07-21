/**
 * T5b (v0.47.x) — DETERMINISTIC TEMPORAL ANSWER SOLVER.
 *
 * The T5 end-to-end benchmark exposed the real temporal bottleneck: retrieval
 * finds the gold sessions ~67% of the time, but end-to-end temporal accuracy
 * was 21% — because interval/ordering answers require DATE ARITHMETIC, which
 * LLMs (local ones especially; LongMemEval's authors saw even Llama-8B fail at
 * time ranges) cannot do reliably. SecureContext already decomposes compound
 * temporal questions into event clauses (TR-2) and stores real timestamps (T1),
 * so "how many days passed between X and Y" is a SUBTRACTION, not a generation.
 *
 * solveTemporal(question, searchFn):
 *   1. isTemporalQuestion + splitEventClauses → the event clauses
 *   2. per-clause targeted retrieval (limit 3) → each event's best-dated hit
 *   3. event date = a date MENTIONED IN the hit content near clause terms when
 *      parseable, else the entry's firstSeenAt/createdAt
 *   4. deterministic computation: interval in days, weeks-ago, ordering
 * Returns null when the question isn't solvable this way — callers fall back
 * to normal generation. Pure algorithm; zero LLM.
 */
import { isTemporalQuestion, splitEventClauses, stripInterrogativeScaffolding } from "./temporal_parse.js";

export interface TemporalEvent {
  clause: string;
  source: string;
  date: string;          // ISO date used for computation (range start for ranges)
  dateOrigin: "content" | "first_seen" | "indexed";
  rangeEnd?: string;     // ISO — present when the hit is a lever-4 range pseudo-entry
}

/** Parse a lever-4 range pseudo-entry ("EVENT: … | FROM: iso | TO: iso"). */
export function extractDateRange(text: string): { from: string; to: string } | null {
  const m = text.match(/\bFROM:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*TO:\s*(\d{4}-\d{2}-\d{2})\b/);
  return m ? { from: m[1]!, to: m[2]! } : null;
}

export interface TemporalSolution {
  kind: "interval" | "ordering" | "ago" | "duration";
  events: TemporalEvent[];
  intervalDays?: number;
  ordering?: string[];    // sources in chronological order
  agoDays?: number;       // for "how many days/weeks ago did X" (vs now/questionDate)
  statement: string;      // human/LLM-ready computed statement
}

type SearchFn = (query: string, limit: number) => Promise<Array<{
  source: string; content: string; createdAt?: string; firstSeenAt?: string }>>;

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
const DATE_RES = [
  /\b(\d{4})-(\d{2})-(\d{2})\b/,                                        // 2026-06-02
  new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i"),  // June 2, 2026
  new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS}),?\\s+(\\d{4})\\b`, "i"),  // 2 June 2026
];

/** Extract the first parseable calendar date from text (deterministic; no LLM —
 *  the one operation the research says small models must never own). */
export function extractDate(text: string): string | null {
  for (const re of DATE_RES) {
    const m = text.match(re);
    if (!m) continue;
    const d = new Date(m[0]);
    if (Number.isFinite(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

/** All parseable dates in a text, with their character offsets. */
export function extractDatesWithIndex(text: string): Array<{ date: string; index: number }> {
  const out: Array<{ date: string; index: number }> = [];
  for (const re of DATE_RES) {
    const g = new RegExp(re.source, re.flags.includes("i") ? "gi" : "g");
    for (const m of text.matchAll(g)) {
      const d = new Date(m[0]);
      if (Number.isFinite(d.getTime())) out.push({ date: d.toISOString().slice(0, 10), index: m.index ?? 0 });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Date grounding for multi-topic documents: a doc with ONE date is
 *  unambiguous; a doc with MANY dates (session summaries covering several
 *  events — the live E2E found one whose FIRST date belonged to a different
 *  event entirely) must supply a date NEAR the clause terms (≤400 chars) or
 *  none at all. */
export function extractDateNear(text: string, terms: string[]): string | null {
  const dates = extractDatesWithIndex(text);
  if (dates.length === 0) return null;
  if (dates.length === 1) return dates[0]!.date;
  const lc = text.toLowerCase();
  const positions: number[] = [];
  for (const t of terms) {
    let i = lc.indexOf(t);
    while (i >= 0 && positions.length < 200) { positions.push(i); i = lc.indexOf(t, i + 1); }
  }
  if (positions.length === 0) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const d of dates) for (const p of positions) {
    const dist = Math.abs(d.index - p);
    if (dist < bestDist) { bestDist = dist; best = d.date; }
  }
  return bestDist <= 400 ? best : null;
}

const DAY_MS = 86_400_000;

function questionKind(q: string): TemporalSolution["kind"] | null {
  if (/how (?:many|much) (?:days?|weeks?|months?|time) (?:pass|elapsed|went by|were there|was there|between)|between the day|days? between/i.test(q)) return "interval";
  if (/which .*(first|last|earlier|earliest|latest)|order of|what order|happened first/i.test(q)) return "ordering";
  if (/how (?:many )?(?:days?|weeks?|months?) ago/i.test(q)) return "ago";
  // Duration-of-one-thing ("how many days did I spend on my trip", "how long
  // did the audit last") — answerable directly from a lever-4 RANGE entry.
  if (/how (?:many (?:days?|weeks?|months?)|long)\b.*\b(?:spend|spent|last|lasted|take|took|stay|stayed|go on|was|is|away|gone)/i.test(q)) return "duration";
  return null;
}

export async function solveTemporal(
  question: string,
  searchFn: SearchFn,
  questionDate?: string,
): Promise<TemporalSolution | null> {
  if (!isTemporalQuestion(question)) return null;
  const kind = questionKind(question);
  if (!kind) return null;
  const stripped = stripInterrogativeScaffolding(question);
  let clauses = splitEventClauses(stripped);
  // Ordering questions are often NOUN-PHRASE comparisons ("which happened
  // first, X or Y?") that the pronoun-anchored clause splitter can't cut
  // (caught by the live E2E). Fall back to splitting the comparison payload
  // on or/vs/commas.
  if (clauses.length < 2 && kind === "ordering") {
    const payload = stripped.replace(/^.*?\b(?:first|last|earlier|earliest|latest)\b[:,]?\s*/i, "") || stripped;
    clauses = payload.split(/\s+or\s+|\s+vs\.?\s+|\s*,\s*/i)
      .map((c) => c.replace(/[?.!]+$/, "").trim())
      .filter((c) => c.split(/\s+/).filter((w) => w.length > 2).length >= 2);
  }
  // Interval questions with a pronoun-less clause ("…and the day the bug
  // reports started") also defeat the pronoun-anchored splitter. Split the
  // "between …" payload on the and-marker instead.
  if (clauses.length < 2 && kind === "interval") {
    const payload = stripped.replace(/^.*?\bbetween\b\s*/i, "");
    const marker = payload.split(/\s+and\s+(?=the (?:day|time|week|month|moment)\b|when\b)/i);
    const parts = marker.length >= 2 ? marker : payload.split(/\s+and\s+/i);
    clauses = parts
      .map((c) => c.replace(/^the (?:day|time|week|month|moment)\s+(?:that\s+|when\s+|we\s+)?/i, "").replace(/[?.!]+$/, "").trim())
      .filter((c) => c.split(/\s+/).filter((w) => w.length > 2).length >= 2);
  }
  // "ago"/"duration" questions have ONE event; interval/ordering need ≥2 clauses.
  const targets = clauses.length >= 2 && kind !== "duration" ? clauses
    : kind === "ago" || kind === "duration" ? [stripped] : null;
  if (!targets) return null;

  const events: TemporalEvent[] = [];
  for (const clause of targets.slice(0, 4)) {
    let hits: Awaited<ReturnType<SearchFn>>;
    try { hits = await searchFn(clause, 5); } catch { return null; }
    // Event-date grounding policy (both rules from live E2E findings):
    //  1. A content-stated date from the TOP hit is best (rank-2+ file dates
    //     mis-grounded events in the first live probe).
    //  2. EXCEPT: session/summary sources are EVENT RECORDS — a content-dated
    //     session in the top-3 outranks an undated artifact file's clustered
    //     index timestamp (second live finding: "0 day interval" because both
    //     events grounded to the same backfilled file date).
    const isEventRecord = (s: string) => s.startsWith("session:") || s.includes("SESSION_SUMMARY") || s.startsWith("checkpoint:") || s.startsWith("event:");
    // T5c PRECISION GATE 1 — topical overlap. The T5c bench showed the solver
    // grounding clauses to topically-unrelated hits and emitting confidently
    // wrong numbers ("164 days", "1170 days ago") that the generator then
    // trusted. A hit may ground a clause only if it shares ≥1 meaningful term.
    const clauseTerms = clause.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    const overlaps = (text: string) => {
      const lc = text.toLowerCase();
      return clauseTerms.length === 0 || clauseTerms.some((t) => lc.includes(t));
    };
    let best: TemporalEvent | null = null;
    let firstEligible = true; // content-date privilege goes to the top hit that PASSES the overlap gate
    for (let hi = 0; hi < hits.length; hi++) {
      const h = hits[hi]!;
      if (!overlaps(h.content ?? "")) continue;
      // A lever-4 RANGE pseudo-entry is the strongest grounding there is —
      // both endpoints stated. Take it and stop looking.
      const range = isEventRecord(h.source) ? extractDateRange(h.content ?? "") : null;
      if (range) {
        best = { clause, source: h.source, date: range.from, rangeEnd: range.to, dateOrigin: "content" };
        break;
      }
      // Duration is answerable ONLY by a range entry — a content-dated parent
      // session at rank 1 must not short-circuit the scan (live-API finding:
      // the session's own SESSION_DATE grounded first and the range at rank 2
      // was never reached).
      if (kind === "duration") continue;
      const contentDate = (firstEligible || isEventRecord(h.source)) ? extractDateNear(h.content ?? "", clauseTerms) : null;
      firstEligible = false;
      const date = contentDate ?? (h.firstSeenAt ?? h.createdAt)?.slice(0, 10) ?? null;
      if (!date) continue;
      const ev: TemporalEvent = {
        clause, source: h.source, date,
        dateOrigin: contentDate ? "content" : h.firstSeenAt ? "first_seen" : "indexed",
      };
      if (!best) best = ev;
      // Upgrade to a content-dated event record when one appears in top-3.
      else if (ev.dateOrigin === "content" && best.dateOrigin !== "content" && isEventRecord(ev.source)) best = ev;
      if (best.dateOrigin === "content") break;
    }
    if (!best) return null; // an undatable event ⇒ not solvable deterministically
    events.push(best);
  }
  if (events.length === 0) return null;
  // T5c PRECISION GATE 2 — the statement leads the generator's context with
  // "trust these numbers", so it must only render on trustworthy grounding:
  // every event content-dated (index timestamps cluster on backfill dates and
  // produced the "0 day" family of wrong answers). Abstaining falls back to
  // normal generation over the dated context — strictly safer.
  if (!events.every((e) => e.dateOrigin === "content")) return null;

  if (kind === "interval" && events.length >= 2) {
    const [a, b] = [events[0]!, events[1]!];
    // Same-source grounding for two DIFFERENT clauses ⇒ retrieval collapsed
    // both onto one record; a 0-day interval from it is noise, not signal.
    if (a.source === b.source && a.date === b.date) return null;
    const days = Math.abs(Math.round((Date.parse(b.date) - Date.parse(a.date)) / DAY_MS));
    return {
      kind, events, intervalDays: days,
      statement: `Computed from stored dates: "${a.clause.trim()}" → ${a.date}; "${b.clause.trim()}" → ${b.date}. Interval: ${days} day(s) (~${Math.round(days / 7)} week(s)).`,
    };
  }
  if (kind === "ordering") {
    const sorted = [...events].sort((x, y) => Date.parse(x.date) - Date.parse(y.date));
    return {
      kind, events, ordering: sorted.map((e) => e.source),
      statement: `Computed chronological order: ${sorted.map((e) => `"${e.clause.trim()}" (${e.date})`).join(" → ")}.`,
    };
  }
  if (kind === "duration") {
    const e = events[0]!;
    if (!e.rangeEnd) return null; // only a range entry can answer a duration
    const days = Math.abs(Math.round((Date.parse(e.rangeEnd) - Date.parse(e.date)) / DAY_MS));
    return {
      kind, events, intervalDays: days,
      statement: `Computed from a stored event range: "${e.clause.trim()}" spans ${e.date} → ${e.rangeEnd}: ${days} day(s) (~${Math.round(days / 7)} week(s)).`,
    };
  }
  if (kind === "ago") {
    const ref = questionDate && Number.isFinite(Date.parse(questionDate)) ? Date.parse(questionDate) : Date.now();
    const e = events[0]!;
    const days = Math.max(0, Math.round((ref - Date.parse(e.date)) / DAY_MS));
    // A 0-day "ago" answer is almost always mis-grounding (event date ==
    // question/backfill date) — abstain rather than assert "0 weeks ago".
    if (days === 0) return null;
    return {
      kind, events, agoDays: days,
      statement: `Computed from stored dates: "${e.clause.trim()}" → ${e.date}; that is ${days} day(s) (~${Math.round(days / 7)} week(s)) before ${new Date(ref).toISOString().slice(0, 10)}.`,
    };
  }
  return null;
}
