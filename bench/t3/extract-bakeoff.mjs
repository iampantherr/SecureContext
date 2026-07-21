#!/usr/bin/env node
/**
 * Lever-4 EXTRACTION BAKEOFF — which local model extracts event facts best?
 * (Extraction is a DIFFERENT task from pair adjudication — the T3 bakeoff
 * result does not transfer.) Scores per model: gold-event recall, resolved-date
 * accuracy, hallucinated events (extractions matching no gold), latency.
 * Usage: node bench/t3/extract-bakeoff.mjs [model ...]
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.ZC_EVENT_OLLAMA_URL = process.env.ZC_EVENT_OLLAMA_URL ?? "http://localhost:11434";
const { extractEvents } = await import("../../dist/event_extractor.js");

const MODELS = process.argv.slice(2).length ? process.argv.slice(2)
  : ["gpt-oss:20b", "qwen2.5-coder:32b", "phi4:14b", "qwen2.5:14b", "qwen2.5-coder:14b"];

// Gold: session snippet + session date + expected events (keywords + dates).
const GOLD = [
  { date: "2026-05-03", text: "user: So excited, we finally leave for Portugal tomorrow! Two weeks of planning finally paying off.\nassistant: Have a wonderful trip!",
    events: [{ kw: ["portugal", "leave", "depart", "trip"], date: "2026-05-04" }] },
  { date: "2026-05-11", text: "user: Back home now from Lisbon, still jet-lagged. The trip ran from the 4th through yesterday.\nassistant: Welcome back!",
    events: [{ kw: ["home", "return", "back", "trip"], date: "2026-05-10", altDates: ["2026-05-11", "2026-05-04"] }] },
  { date: "2026-03-15", text: "user: I started my pottery class last Monday and it runs until April 20th, every week.\nassistant: That sounds fun.",
    events: [{ kw: ["pottery", "class"], from: "2026-03-09", to: "2026-04-20" }] },
  { date: "2026-06-20", text: "user: We deployed the payment service to production two days ago and the bug reports started yesterday.\nassistant: Let's triage.",
    events: [{ kw: ["deploy", "payment"], date: "2026-06-18" }, { kw: ["bug", "report"], date: "2026-06-19" }] },
  { date: "2026-07-01", text: "user: My dentist appointment is next Friday at 3pm, and I'm picking up the new car on July 15th.\nassistant: Noted.",
    events: [{ kw: ["dentist", "appointment"], date: "2026-07-10" }, { kw: ["car", "pick"], date: "2026-07-15" }] },
  { date: "2026-02-10", text: "user: I was sick with the flu from last Tuesday until yesterday, barely left bed.\nassistant: Glad you're better.",
    events: [{ kw: ["sick", "flu", "ill"], from: "2026-02-03", to: "2026-02-09" }] },
  { date: "2026-04-05", text: "user: The marathon I signed up for three weeks ago is happening in two weeks. Training every morning.\nassistant: Good luck!",
    events: [{ kw: ["sign", "marathon", "register"], date: "2026-03-15" }, { kw: ["marathon", "happen", "race", "run"], date: "2026-04-19" }] },
  { date: "2026-01-20", text: "user: I love hiking and my favorite color is green. I think remote work is the future.\nassistant: Interesting takes!",
    events: [] }, // control: NO events — extractions here are hallucinations
  { date: "2026-06-15", text: "user: Started the SOC-2 audit today; the auditors said the report lands in six weeks. Kickoff call was this morning.\nassistant: I'll prep the evidence.",
    events: [{ kw: ["audit", "start", "soc"], date: "2026-06-15" }, { kw: ["report", "land", "deliver"], date: "2026-07-27" }] },
  { date: "2026-05-25", text: "user: Vacation booked! We're in Kyoto from June 3rd to June 12th. Kids are thrilled.\nassistant: Wonderful.",
    events: [{ kw: ["kyoto", "vacation", "trip"], from: "2026-06-03", to: "2026-06-12" }] },
];

const near = (a, b, tolDays = 1) => a && b && Math.abs(Date.parse(a) - Date.parse(b)) <= tolDays * 86_400_000;
const results = {};
for (const model of MODELS) {
  const r = { recall: 0, goldN: 0, dateOk: 0, halluc: 0, extracted: 0, fail: 0, msSum: 0, n: 0, unresolved: [] };
  for (const g of GOLD) {
    const t0 = Date.now();
    let out;
    try { out = await extractEvents(g.text, g.date, { model, timeoutMs: 180_000 }); }
    catch (e) { r.fail++; continue; }
    r.msSum += Date.now() - t0; r.n++;
    r.unresolved.push(...out.unresolved);
    r.extracted += out.events.length;
    const matched = new Set();
    for (const ge of g.events) {
      r.goldN++;
      const hit = out.events.find((e, i) => !matched.has(i) &&
        ge.kw.some((k) => e.description.toLowerCase().includes(k)));
      if (!hit) continue;
      matched.add(out.events.indexOf(hit));
      r.recall++;
      const dates = [hit.date, hit.from, hit.to].filter(Boolean);
      const goldDates = [ge.date, ge.from, ge.to, ...(ge.altDates ?? [])].filter(Boolean);
      if (goldDates.some((gd) => dates.some((d) => near(d, gd)))) r.dateOk++;
    }
    r.halluc += out.events.length - matched.size;
  }
  const pct = (x, n) => (n ? +(100 * x / n).toFixed(1) : 0);
  console.log(`${model.padEnd(20)} recall ${pct(r.recall, r.goldN)}% | date-acc ${pct(r.dateOk, r.recall)}% | hallucinated ${r.halluc} | avg ${r.n ? Math.round(r.msSum / r.n) : "-"}ms | failures ${r.fail} | unresolved-exprs ${r.unresolved.length}`);
  results[model] = r;
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "extract-bakeoff-results.json"), JSON.stringify(results, null, 1));
}
