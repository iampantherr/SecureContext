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
  date: string;          // ISO date used for computation
  dateOrigin: "content" | "first_seen" | "indexed";
}

export interface TemporalSolution {
  kind: "interval" | "ordering" | "ago";
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

const DAY_MS = 86_400_000;

function questionKind(q: string): TemporalSolution["kind"] | null {
  if (/how (?:many|much) (?:days?|weeks?|months?|time) (?:pass|elapsed|went by|were there|was there|between)|between the day|days? between/i.test(q)) return "interval";
  if (/which .*(first|last|earlier|earliest|latest)|order of|what order|happened first/i.test(q)) return "ordering";
  if (/how (?:many )?(?:days?|weeks?|months?) ago/i.test(q)) return "ago";
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
  // "ago" questions have ONE event; interval/ordering need ≥2 clauses.
  const targets = clauses.length >= 2 ? clauses
    : kind === "ago" ? [stripped] : null;
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
    const isEventRecord = (s: string) => s.startsWith("session:") || s.includes("SESSION_SUMMARY") || s.startsWith("checkpoint:");
    let best: TemporalEvent | null = null;
    for (let hi = 0; hi < hits.length; hi++) {
      const h = hits[hi]!;
      const contentDate = (hi === 0 || isEventRecord(h.source)) ? extractDate(h.content ?? "") : null;
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

  if (kind === "interval" && events.length >= 2) {
    const [a, b] = [events[0]!, events[1]!];
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
  if (kind === "ago") {
    const ref = questionDate && Number.isFinite(Date.parse(questionDate)) ? Date.parse(questionDate) : Date.now();
    const e = events[0]!;
    const days = Math.max(0, Math.round((ref - Date.parse(e.date)) / DAY_MS));
    return {
      kind, events, agoDays: days,
      statement: `Computed from stored dates: "${e.clause.trim()}" → ${e.date}; that is ${days} day(s) (~${Math.round(days / 7)} week(s)) before ${new Date(ref).toISOString().slice(0, 10)}.`,
    };
  }
  return null;
}
