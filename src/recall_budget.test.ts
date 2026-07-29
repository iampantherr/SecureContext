/**
 * R8 (v0.43.0) — recall budget unit tests.
 * Pure-function coverage; the mature-project scale scenario is covered live by
 * scripts/seed-mature-memory.mjs + scripts/recall-size-check.mjs.
 */
import { describe, it, expect } from "vitest";
import { budgetFacts, keyPrefix, effectiveImportance, applyStalenessDemotion } from "./recall_budget.js";
import { Config } from "./config.js";

const fact = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  value: "v".repeat(200),
  importance: 5,
  agent_id: "orchestrator",
  created_at: new Date().toISOString(),
  ...over,
});

describe("budgetFacts", () => {
  it("renders everything when under budget (byte-identical small-project path)", () => {
    const facts = [fact("a"), fact("b"), fact("c")];
    const r = budgetFacts(facts, { maxChars: 16000 });
    expect(r.rendered).toHaveLength(3);
    expect(r.collapsed).toHaveLength(0);
    expect(r.tailNotice).toBe("");
  });

  it("maxChars=0 disables budgeting entirely (kill-switch)", () => {
    const facts = Array.from({ length: 300 }, (_, i) => fact(`k${i}`));
    const r = budgetFacts(facts, { maxChars: 0 });
    expect(r.rendered).toHaveLength(300);
    expect(r.tailNotice).toBe("");
  });

  it("collapses the tail past the budget and reports counts by prefix", () => {
    const facts = [
      ...Array.from({ length: 40 }, (_, i) => fact(`OWNERSHIP_DEV_${i}`)),
      ...Array.from({ length: 40 }, (_, i) => fact(`LEARNING_${i}`)),
    ];
    const r = budgetFacts(facts, { maxChars: 3000 });
    expect(r.rendered.length).toBeLessThan(80);
    expect(r.collapsed.length).toBe(80 - r.rendered.length);
    expect(r.tailNotice).toContain("more facts collapsed");
    expect(r.tailNotice).toMatch(/OWNERSHIP_\* \(\d+\)|LEARNING_\* \(\d+\)/);
    expect(r.tailNotice).toContain("nothing is deleted");
  });

  it("never renders fewer than RECALL_MIN_FACTS even under a tiny budget", () => {
    const facts = Array.from({ length: 50 }, (_, i) => fact(`k${i}`));
    const r = budgetFacts(facts, { maxChars: 10 });
    expect(r.rendered.length).toBeGreaterThanOrEqual(Math.max(1, Config.RECALL_MIN_FACTS));
  });

  it("preserves incoming order (ranking is the caller's job)", () => {
    const facts = [fact("first"), fact("second"), fact("third")];
    const r = budgetFacts(facts, { maxChars: 16000 });
    expect(r.rendered.map((f) => f.key)).toEqual(["first", "second", "third"]);
  });

  it("gives in-window facts absolute tier-1 priority", () => {
    const now = Date.now();
    const old = new Date(now - 30 * 86400_000).toISOString();
    const recent = new Date(now - 2 * 86400_000).toISOString();
    const facts = [
      fact("out_1", { created_at: old }),
      fact("in_1", { created_at: recent }),
      fact("out_2", { created_at: old }),
      fact("in_2", { created_at: recent }),
    ];
    const win = { from: new Date(now - 7 * 86400_000), to: new Date(now) };
    const r = budgetFacts(facts, { maxChars: 16000, win });
    expect(r.rendered.map((f) => f.key)).toEqual(["in_1", "in_2", "out_1", "out_2"]);
  });

  it("uses valid_at (event time) over created_at for the window", () => {
    const now = Date.now();
    const facts = [
      fact("event_last_week", {
        created_at: new Date(now - 60 * 86400_000).toISOString(),
        valid_at: new Date(now - 3 * 86400_000).toISOString(),
      }),
      fact("recent_row_old_event", {
        created_at: new Date(now - 1 * 86400_000).toISOString(),
        valid_at: new Date(now - 40 * 86400_000).toISOString(),
      }),
    ];
    const win = { from: new Date(now - 7 * 86400_000), to: new Date(now) };
    const r = budgetFacts(facts, { maxChars: 16000, win });
    expect(r.rendered[0]!.key).toBe("event_last_week");
  });

  it("reports in-window overflow explicitly (never silent truncation)", () => {
    const now = Date.now();
    const recent = new Date(now - 2 * 86400_000).toISOString();
    const facts = Array.from({ length: 100 }, (_, i) => fact(`WIN_${i}`, { created_at: recent }));
    const win = { from: new Date(now - 7 * 86400_000), to: new Date(now) };
    const r = budgetFacts(facts, { maxChars: 3000, win });
    expect(r.inWindowCollapsed).toBeGreaterThan(0);
    expect(r.tailNotice).toContain("INSIDE your requested time window");
  });

  it("rendered + collapsed always equals the input (no facts lost)", () => {
    const facts = Array.from({ length: 237 }, (_, i) => fact(`k${i}`));
    const r = budgetFacts(facts, { maxChars: 8000 });
    expect(r.rendered.length + r.collapsed.length).toBe(237);
  });
});

describe("keyPrefix", () => {
  it("groups by the first _/-/. segment", () => {
    expect(keyPrefix("OWNERSHIP_DEV_TASK_X")).toBe("OWNERSHIP");
    expect(keyPrefix("ckpt_fix1")).toBe("ckpt");
    expect(keyPrefix("last_session_summary")).toBe("last");
  });
});

describe("effectiveImportance / applyStalenessDemotion", () => {
  const now = Date.now();
  const staleDate = new Date(now - (Config.RECALL_STALE_DAYS + 5) * 86400_000).toISOString();
  const freshDate = new Date(now - 1 * 86400_000).toISOString();

  it("demotes a fact untouched past RECALL_STALE_DAYS", () => {
    if (Config.RECALL_STALE_DEMOTE <= 0) return; // knob disabled in this env
    const stale = fact("s", { created_at: staleDate, last_retrieved_at: null });
    expect(effectiveImportance(stale, now)).toBe(5 - Config.RECALL_STALE_DEMOTE);
  });

  it("decays PER PERIOD, using IMPORTANCE_DECAY_DAYS as the period", () => {
    if (Config.RECALL_STALE_DEMOTE <= 0) return;
    const period = Config.IMPORTANCE_DECAY_DAYS > 0
      ? Config.IMPORTANCE_DECAY_DAYS
      : Config.RECALL_STALE_DAYS;
    const floor = Math.max(1, Math.min(5, Config.IMPORTANCE_DECAY_FLOOR));
    // Three elapsed periods must demote strictly further than one. Without this
    // the axis cannot tell "stale by a fortnight" from "untouched for months" —
    // measured on the live A2A corpus, a 30-day period made decay entirely inert
    // (772 of 773 facts were younger than that), so the period length is load-
    // bearing and a regression here would silently disable the feature again.
    const at = (periods: number) =>
      fact("x", {
        created_at: new Date(Date.now() - (period * periods + 1) * 86400_000).toISOString(),
        last_retrieved_at: null,
      });
    const one = effectiveImportance(at(1), Date.now());
    const three = effectiveImportance(at(3), Date.now());
    expect(three).toBeLessThanOrEqual(one);
    expect(three).toBeGreaterThanOrEqual(Math.min(floor, 5));
  });

  it("a recent retrieval keeps an old fact fresh", () => {
    const rehearsed = fact("r", { created_at: staleDate, last_retrieved_at: freshDate });
    expect(effectiveImportance(rehearsed, now)).toBe(5);
  });

  it("ranks a stale ★5 below a fresh ★4 in classic ordering", () => {
    if (Config.RECALL_STALE_DEMOTE < 2) return; // contract requires the default demotion depth
    const stale5 = fact("stale5", { created_at: staleDate, last_retrieved_at: null, importance: 5 });
    const fresh4 = fact("fresh4", { created_at: freshDate, importance: 4 });
    const sorted = applyStalenessDemotion([stale5, fresh4], "orchestrator", now);
    expect(sorted[0]!.key).toBe("fresh4");
  });
});
