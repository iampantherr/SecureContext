/**
 * S11 (v0.46.1) — tests for the interrogative-scaffolding stripper.
 * The stripper must gut question-form temporal noise while leaving event
 * content — and leave declarative queries byte-identical.
 */
import { describe, it, expect, afterEach } from "vitest";
import { stripInterrogativeScaffolding } from "./temporal_parse.js";

afterEach(() => { delete process.env.ZC_QUERY_DESCAFFOLD; });

describe("stripInterrogativeScaffolding", () => {
  it("strips 'how many X ago did I' scaffolding, keeps the event", () => {
    const out = stripInterrogativeScaffolding(
      "How many weeks ago did I attend the friends and family sale at Nordstrom?");
    expect(out.toLowerCase()).toContain("friends and family sale at nordstrom");
    expect(out.toLowerCase()).not.toContain("how many");
    expect(out.toLowerCase()).not.toContain("ago");
  });

  it("strips 'have passed since' forms", () => {
    const out = stripInterrogativeScaffolding(
      "How many months have passed since I last visited a museum with a friend?");
    expect(out.toLowerCase()).toContain("visited a museum with a friend");
    expect(out.toLowerCase()).not.toContain("passed");
  });

  it("strips between-two-events scaffolding but keeps both events + connective", () => {
    const out = stripInterrogativeScaffolding(
      "How many days passed between the day I started watering my herb garden and the day I harvested my first batch of herbs?");
    expect(out.toLowerCase()).toContain("watering my herb garden");
    expect(out.toLowerCase()).toContain("harvested my first batch of herbs");
    expect(out.toLowerCase()).toContain("between");
  });

  it("strips order-question scaffolding, keeps the event names", () => {
    const out = stripInterrogativeScaffolding(
      "Which event happened first, my cousin's wedding or Michael's engagement party?");
    expect(out.toLowerCase()).toContain("cousin's wedding");
    expect(out.toLowerCase()).toContain("engagement party");
    expect(out.toLowerCase()).not.toContain("happened first");
  });

  it("leaves declarative queries byte-identical", () => {
    for (const q of [
      "retrieval weights tuning in config.ts",
      "postgres connection pool exhaustion error",
      "the museum exhibit about ancient civilizations",
    ]) {
      expect(stripInterrogativeScaffolding(q)).toBe(q);
    }
  });

  it("never returns a near-empty query (guard)", () => {
    expect(stripInterrogativeScaffolding("How many days ago?"))
      .toBe("How many days ago?");
  });

  it("kill switch ZC_QUERY_DESCAFFOLD=0 passes everything through", () => {
    process.env.ZC_QUERY_DESCAFFOLD = "0";
    const q = "How many weeks ago did I attend the sale?";
    expect(stripInterrogativeScaffolding(q)).toBe(q);
  });
});

// ── TR-2: event-clause splitting ─────────────────────────────────────────────
import { splitEventClauses, isTemporalQuestion } from "./temporal_parse.js";

describe("isTemporalQuestion", () => {
  it("detects interval/ordering/when shapes", () => {
    expect(isTemporalQuestion("How many days passed between X and Y?")).toBe(true);
    expect(isTemporalQuestion("Which event happened first, A or B?")).toBe(true);
    expect(isTemporalQuestion("What is the order of my three trips?")).toBe(true);
    expect(isTemporalQuestion("When did I start the migration?")).toBe(true);
  });
  it("ignores plain queries", () => {
    expect(isTemporalQuestion("postgres pool exhaustion")).toBe(false);
    expect(isTemporalQuestion("the day shift schedule doc")).toBe(false);
  });
});

describe("splitEventClauses", () => {
  it("splits two-event 'when I' questions", () => {
    const c = splitEventClauses("did I attend a baking class at a local culinary school when I made my friends birthday cake");
    expect(c.length).toBe(2);
    expect(c[0]).toContain("baking class");
    expect(c[1]).toContain("birthday cake");
  });
  it("splits three-event ordering lists and drops interrogative residue", () => {
    const c = splitEventClauses("Which three events happened in the order : the day I helped my friend prepare the nursery, the day I helped my cousin pick out stuffed animals, or the day I watched the sunrise");
    expect(c).toEqual([
      "helped my friend prepare the nursery",
      "helped my cousin pick out stuffed animals",
      "watched the sunrise",
    ]);
  });
  it("returns [] for single-event and declarative queries", () => {
    expect(splitEventClauses("visited a museum with a friend")).toEqual([]);
    expect(splitEventClauses("retrieval weights tuning in config")).toEqual([]);
  });
  it("kill switch ZC_QUERY_DECOMPOSE=0 disables splitting", () => {
    process.env.ZC_QUERY_DECOMPOSE = "0";
    const c = splitEventClauses("did X when I did Y with the team");
    delete process.env.ZC_QUERY_DECOMPOSE;
    expect(c).toEqual([]);
  });
});
