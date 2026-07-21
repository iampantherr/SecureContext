/**
 * Lever-4 (v0.48.0) — EVENT-FACT EXTRACTION AT INGEST.
 *
 * The problem (measured on LongMemEval T5b): we store TRANSCRIPTS OF TALKING
 * ABOUT EVENTS, not the events — "we leave for Portugal tomorrow" carries an
 * event whose date exists only relative to the session date, and a trip's
 * duration exists only as the gap between two sessions. Temporal questions
 * then re-derive "what happened when" from prose at query time, where it is
 * hardest (temporal-reasoning e2e: 26.7%).
 *
 * The fix: at ingest, a local model extracts ATOMIC EVENTS — description +
 * RAW time expression ("tomorrow", "last Friday", "May 4th", "from X to Y") —
 * and CODE resolves expressions to calendar dates anchored on the session
 * date. (The one quantified small-model finding in the literature: they fail
 * at generating time ranges — so the model never resolves dates, ever.)
 * Events are indexed as pseudo-entries `event:<parent>:<n>` whose content
 * carries the resolved dates:
 *   "EVENT: user departs for Portugal | DATE: 2026-05-04 | (from session:xyz)"
 *   "EVENT: trip to Portugal | FROM: 2026-05-04 | TO: 2026-05-11 | …"
 * They flow through every existing retrieval channel, and the temporal solver
 * prefers them (event-record sources) for date grounding.
 *
 * Trust: INFERRED provenance, never overrides stated facts, always source-linked.
 * ZC_EVENT_EXTRACT=0 disables. ZC_EVENT_EXTRACT_MODEL / ZC_EVENT_OLLAMA_URL
 * select the model/endpoint (point the URL at a GPU host for speed).
 */
import { Config } from "./config.js";

export interface ExtractedEvent {
  description: string;
  kind: "point" | "range";
  date?: string;        // resolved ISO (point)
  from?: string;        // resolved ISO (range start)
  to?: string;          // resolved ISO (range end)
  rawExpression: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          kind: { type: "string", enum: ["point", "range"] },
          when: { type: "string", description: "the time expression exactly as stated in the text" },
          when_end: { type: "string", description: "for ranges: the end expression as stated; empty otherwise" },
        },
        required: ["description", "kind", "when"],
      },
    },
  },
  required: ["events"],
};

export function extractorEnabled(): boolean {
  return process.env["ZC_EVENT_EXTRACT"] !== "0";
}
export function extractorModel(): string {
  // Default from the measured bakeoff (bench/t3/extract-bakeoff-results.json):
  // phi4:14b tied gpt-oss:20b on quality (92.3% recall, 100% date accuracy)
  // at 2.5× the speed — and extraction runs on every session ingest.
  return process.env["ZC_EVENT_EXTRACT_MODEL"] || "phi4:14b";
}
function extractorUrl(): string {
  // "||" not "??": compose passes empty strings for unset vars.
  const base = process.env["ZC_EVENT_OLLAMA_URL"] || Config.OLLAMA_URL;
  return base.replace(/\/api\/embeddings\/?$/, "").replace(/\/$/, "") + "/api/chat";
}

// ─── Deterministic relative-expression resolver (code, never the model) ──────
const DAY_MS = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Resolve a natural-language time expression to an ISO date, anchored at the
 *  session date. Returns null when unresolvable (logged by callers — the tail
 *  tells us which expressions to add next). */
export function resolveExpression(exprRaw: string, anchorIso: string): string | null {
  const anchor = Date.parse(anchorIso);
  if (!Number.isFinite(anchor)) return null;
  // NOTE: "in" is NOT stripped — "in two weeks" is a relative form, not a
  // preposition here (caught by the resolver's own unit probe).
  const expr = exprRaw.trim().toLowerCase()
    .replace(/^(on|at|this past|this|until|through|to|from|since|starting)\s+/, "")
    .replace(/\s+at\s+\d{1,2}(:\d{2})?\s*(am|pm)?$/, ""); // "next Friday at 3pm" → "next Friday"
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);

  // Absolute forms first.
  const iso = expr.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const mdY = expr.match(new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`));
  if (mdY) {
    const year = mdY[3] ? parseInt(mdY[3], 10) : new Date(anchor).getUTCFullYear();
    const d = new Date(Date.UTC(year, MONTHS.indexOf(mdY[1]!), parseInt(mdY[2]!, 10)));
    // Month-day with no year: allow ~6 months of future (range ends like
    // "until April 20th" routinely extend months ahead); only beyond that,
    // assume the previous year's occurrence.
    if (!mdY[3] && d.getTime() > anchor + 180 * DAY_MS) d.setUTCFullYear(year - 1);
    return day(d.getTime());
  }

  // Relative forms.
  // Bare "morning"/"evening" appear when the preprocessor strips "this ".
  if (/^(today|tonight|now|morning|afternoon|evening|night|(this )?(morning|afternoon|evening))$/.test(expr)) return day(anchor);
  // Bare ordinal day-of-month ("the 4th") — nearest occurrence, past-biased.
  const ord = expr.match(/^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)$/);
  if (ord) {
    const a = new Date(anchor);
    const d = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), parseInt(ord[1]!, 10)));
    if (d.getTime() > anchor + 2 * DAY_MS) d.setUTCMonth(d.getUTCMonth() - 1);
    return day(d.getTime());
  }
  if (/^tomorrow( morning| night| evening)?$/.test(expr)) return day(anchor + DAY_MS);
  if (/^yesterday( morning| night| evening)?$/.test(expr)) return day(anchor - DAY_MS);
  const nAgo = expr.match(/^(?:about |around |roughly )?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month)s?\s+ago$/);
  const nIn = expr.match(/^in\s+(?:about |around )?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month)s?$/);
  const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const toN = (s: string) => words[s] ?? parseInt(s, 10);
  const unitMs = (u: string) => (u === "day" ? 1 : u === "week" ? 7 : 30) * DAY_MS;
  if (nAgo) return day(anchor - toN(nAgo[1]!) * unitMs(nAgo[2]!));
  if (nIn)  return day(anchor + toN(nIn[1]!)  * unitMs(nIn[2]!));
  if (/^last week$/.test(expr))  return day(anchor - 7 * DAY_MS);
  if (/^next week$/.test(expr))  return day(anchor + 7 * DAY_MS);
  if (/^last month$/.test(expr)) return day(anchor - 30 * DAY_MS);
  if (/^next month$/.test(expr)) return day(anchor + 30 * DAY_MS);
  if (/^(the )?weekend$/.test(expr) || /^this weekend$/.test(expr)) {
    const dow = new Date(anchor).getUTCDay();
    return day(anchor + ((6 - dow + 7) % 7) * DAY_MS); // upcoming Saturday
  }
  const lastWd = expr.match(new RegExp(`^last\\s+(${WEEKDAYS.join("|")})$`));
  const nextWd = expr.match(new RegExp(`^next\\s+(${WEEKDAYS.join("|")})$`));
  const bareWd = expr.match(new RegExp(`^(${WEEKDAYS.join("|")})$`));
  const wdShift = (target: number, dir: 1 | -1) => {
    const dow = new Date(anchor).getUTCDay();
    let diff = dir === -1 ? (dow - target + 7) % 7 : (target - dow + 7) % 7;
    if (diff === 0) diff = 7;
    return day(anchor + dir * diff * DAY_MS);
  };
  if (lastWd) return wdShift(WEEKDAYS.indexOf(lastWd[1]!), -1);
  if (nextWd) {
    // Colloquial "next <weekday>" = that weekday of NEXT week (the nearest
    // future occurrence is "this <weekday>").
    const nearest = wdShift(WEEKDAYS.indexOf(nextWd[1]!), 1);
    return day(Date.parse(nearest) + 7 * DAY_MS);
  }
  if (bareWd) return wdShift(WEEKDAYS.indexOf(bareWd[1]!), -1); // past-biased in recall contexts
  return null;
}

// ─── The extraction call ─────────────────────────────────────────────────────
export async function extractEvents(
  content: string,
  sessionDateIso: string,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<{ events: ExtractedEvent[]; unresolved: string[] }> {
  const prompt = `Extract the concrete EVENTS from this conversation excerpt — things that happened or will happen at a specific time (trips, purchases, appointments, starts/finishes, deployments, meetings, incidents). For each event give:
- "description": one short third-person clause naming the actor and the event (e.g. "user departs for Portugal trip")
- "kind": "point" for a single moment, "range" for something with a start and end (a trip, a course, an illness)
- "when": the time expression EXACTLY as it appears in the text ("tomorrow", "last Friday", "May 4th", "two weeks ago"). Never convert or compute dates.
- "when_end": for ranges only — the end expression as stated ("until the 11th", "next Sunday"); empty string if not stated.
Only include events with SOME stated time expression. No opinions, preferences, or timeless facts. Maximum 8 events.

The conversation happened on ${sessionDateIso.slice(0, 10)}.

CONVERSATION:
${content.slice(0, 8000)}

JSON only.`;
  const resp = await fetch(extractorUrl(), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model ?? extractorModel(),
      messages: [{ role: "user", content: prompt }],
      stream: false, format: SCHEMA,
      options: { temperature: 0, num_predict: 1800 },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!resp.ok) throw new Error(`extractor http ${resp.status}`);
  const text = ((await resp.json()) as { message?: { content?: string } }).message?.content ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("extractor: no JSON");
  const raw = JSON.parse(m[0]) as { events?: Array<{ description?: string; kind?: string; when?: string; when_end?: string }> };

  const events: ExtractedEvent[] = [];
  const unresolved: string[] = [];
  for (const e of (raw.events ?? []).slice(0, 8)) {
    if (!e.description || !e.when) continue;
    const start = resolveExpression(e.when, sessionDateIso);
    if (!start) { unresolved.push(e.when); continue; }
    if (e.kind === "range" && e.when_end) {
      const end = resolveExpression(e.when_end, sessionDateIso);
      if (end) { events.push({ description: e.description, kind: "range", from: start, to: end, rawExpression: `${e.when} → ${e.when_end}` }); continue; }
      unresolved.push(e.when_end);
    }
    events.push({ description: e.description, kind: "point", date: start, rawExpression: e.when });
  }
  return { events, unresolved };
}

/** Render an event as pseudo-entry content (the solver + retrieval consume this). */
export function eventContent(e: ExtractedEvent, parentSource: string): string {
  const when = e.kind === "range" ? `FROM: ${e.from} | TO: ${e.to}` : `DATE: ${e.date}`;
  return `EVENT: ${e.description} | ${when} | stated as "${e.rawExpression}" (from ${parentSource})`;
}

/** Only conversational/event-record sources carry extractable events — never
 *  project files, and never the pseudo-entries themselves (no recursion). */
export function eligibleForExtraction(source: string): boolean {
  if (source.startsWith("event:")) return false;
  return source.startsWith("session:") || source.includes("SESSION_SUMMARY") || source.startsWith("checkpoint:");
}

/**
 * Lever-4 EVENT SUPERSESSION (T5c-gated bench finding): event pseudo-entries
 * are a stale-fact amplifier for "what is X now" questions — an old value
 * ("user's 5K time is 35:22") extracted as a crisp one-liner outranks the
 * session that later updated it, and events had no supersession. Among the
 * event entries in ONE result set, same-subject events (numeral-stripped
 * token Jaccard ≥ 0.4 on the description) collapse to the LATEST-dated one.
 * Callers skip this on temporal-solver sub-searches (_noDecompose) — interval
 * questions legitimately need BOTH occurrences of a repeated event.
 * ZC_EVENT_SUPERSEDE=0 disables.
 */
export function supersedeEventEntries<T>(ranked: T[], get: (x: T) => { source: string; content: string }): T[] {
  if (process.env["ZC_EVENT_SUPERSEDE"] === "0") return ranked;
  const events = ranked
    .map((r, i) => { const g = get(r); return { i, source: g.source, content: g.content ?? "" }; })
    .filter((x) => x.source.startsWith("event:"));
  if (events.length < 2) return ranked;
  // Numerals stripped: differing VALUES are exactly what same-subject updates
  // look like — including number WORDS ("four" plants vs "seven" plants, the
  // KU miss-analysis find that defeated digit-only stripping).
  const NUM_WORDS = new Set(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand"]);
  const descTokens = (c: string) => {
    const m = c.match(/^EVENT:\s*([^|]+)/);
    return new Set((m ? m[1]! : c).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && !NUM_WORDS.has(w)));
  };
  const latestDate = (c: string) => { const ds = c.match(/\d{4}-\d{2}-\d{2}/g); return ds ? [...ds].sort().at(-1)! : ""; };
  const jaccard = (A: Set<string>, B: Set<string>) => {
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    const uni = A.size + B.size - inter;
    return uni ? inter / uni : 0;
  };
  const drop = new Set<number>();
  for (let a = 0; a < events.length; a++) {
    for (let b = a + 1; b < events.length; b++) {
      const ea = events[a]!, eb = events[b]!;
      if (drop.has(ea.i) || drop.has(eb.i)) continue;
      if (jaccard(descTokens(ea.content), descTokens(eb.content)) >= 0.4) {
        drop.add(latestDate(ea.content) >= latestDate(eb.content) ? eb.i : ea.i);
      }
    }
  }
  if (drop.size === 0) return ranked;
  return ranked.filter((_, i) => !drop.has(i));
}

// ─── Background extraction lane (embed-pattern: serialized, capped, silent) ──
type ExtractJob = { content: string; source: string; anchorIso: string;
  indexEvent: (source: string, content: string) => Promise<void> };
const queue: ExtractJob[] = [];
const MAX_BACKLOG = 50;
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      try {
        const { events } = await extractEvents(job.content, job.anchorIso);
        for (let i = 0; i < events.length; i++) {
          await job.indexEvent(`event:${job.source}:${i}`, eventContent(events[i]!, job.source));
        }
      } catch { /* fail-closed: an extraction failure never surfaces */ }
    }
  } finally { draining = false; }
}

/**
 * Fire-and-forget extraction for one ingested entry. The anchor date is a
 * date stated IN the content when present (e.g. "SESSION_SUMMARY 2026-06-02"),
 * else now — backfill scripts pass content that carries its session date.
 */
export function scheduleEventExtraction(
  content: string,
  source: string,
  indexEvent: (source: string, content: string) => Promise<void>,
): void {
  if (!extractorEnabled() || !eligibleForExtraction(source)) return;
  if (queue.length >= MAX_BACKLOG) return; // shed load, never block ingest
  const stated = content.slice(0, 400).match(/\b\d{4}-\d{2}-\d{2}\b/);
  queue.push({ content, source, anchorIso: stated?.[0] ?? new Date().toISOString().slice(0, 10), indexEvent });
  void drain();
}
