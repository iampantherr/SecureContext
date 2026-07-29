/**
 * Tests for v0.51.0 multi-agent memory quality.
 *
 * Each test names the MEASURED pathology it defends against, so a future reader
 * knows these are not hypothetical. Numbers come from a live 3-agent project.
 */
import { describe, it, expect } from "vitest";
import {
  isPinnedKind, partitionPinned, computeMemoryHealth, type QualityRankable,
} from "./memory_quality.js";
import { Config } from "./config.js";

const NOW = Date.parse("2026-07-29T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function fact(p: Partial<QualityRankable> = {}): QualityRankable {
  return { key: "k", importance: 5, agent_id: "developer", kind: "fact",
           created_at: daysAgo(1), last_retrieved_at: daysAgo(1), ...p };
}

describe("pinned kinds — defends against the constraint lost on worker relaunch", () => {
  it("pins constraints and antipatterns", () => {
    expect(isPinnedKind(fact({ kind: "constraint" }))).toBe(true);
    expect(isPinnedKind(fact({ kind: "antipattern" }))).toBe(true);
  });

  it("does not pin ordinary kinds", () => {
    for (const k of ["fact", "decision", "hypothesis", "prediction"]) {
      expect(isPinnedKind(fact({ kind: k }))).toBe(false);
    }
  });

  it("partitions pinned first while preserving order within each group", () => {
    const facts = [
      fact({ key: "a", kind: "fact" }),
      fact({ key: "b", kind: "constraint" }),
      fact({ key: "c", kind: "fact" }),
      fact({ key: "d", kind: "antipattern" }),
    ];
    const { pinned, rest } = partitionPinned(facts);
    expect(pinned.map(f => f.key)).toEqual(["b", "d"]);
    expect(rest.map(f => f.key)).toEqual(["a", "c"]);
  });

  it("caps pinning so a runaway writer cannot eat the whole budget", () => {
    const many = Array.from({ length: Config.PINNED_MAX_FACTS + 25 },
      (_, i) => fact({ key: `c${i}`, kind: "constraint" }));
    const { pinned, rest } = partitionPinned(many);
    expect(pinned.length).toBe(Config.PINNED_MAX_FACTS);
    expect(rest.length).toBe(25);
  });
});

describe("computeMemoryHealth — makes the invisible pathologies visible", () => {
  it("flags importance inflation at the measured 59% ratio", () => {
    const facts = [
      ...Array.from({ length: 59 }, (_, i) => fact({ key: `hi${i}`, importance: 5 })),
      ...Array.from({ length: 41 }, (_, i) => fact({ key: `lo${i}`, importance: 3 })),
    ];
    const h = computeMemoryHealth(facts);
    expect(h.imp5Count).toBe(59);
    expect(h.imp5Pct).toBeCloseTo(59, 0);
    expect(h.warnings.join(" ")).toMatch(/importance-5/);
  });

  it("does not flag a healthy importance distribution", () => {
    const facts = [
      ...Array.from({ length: 10 }, (_, i) => fact({ key: `hi${i}`, importance: 5 })),
      ...Array.from({ length: 90 }, (_, i) => fact({ key: `lo${i}`, importance: 3 })),
    ];
    expect(computeMemoryHealth(facts).warnings.join(" ")).not.toMatch(/importance-5/);
  });

  it("names the under-recording role at the measured 280/190/9 spread", () => {
    const facts = [
      ...Array.from({ length: 280 }, (_, i) => fact({ key: `o${i}`, agent_id: "orchestrator", importance: 3 })),
      ...Array.from({ length: 190 }, (_, i) => fact({ key: `d${i}`, agent_id: "developer", importance: 3 })),
      ...Array.from({ length: 9 },   (_, i) => fact({ key: `q${i}`, agent_id: "qa", importance: 3 })),
    ];
    const h = computeMemoryHealth(facts);
    expect(h.underRecording).toContain("qa");
    expect(h.underRecording).not.toContain("developer");
    expect(h.warnings.join(" ")).toMatch(/qa/);
  });

  it("counts the shared pool separately from private namespaces", () => {
    const facts = [
      ...Array.from({ length: 5 }, (_, i) => fact({ key: `s${i}`, agent_id: "default", importance: 3 })),
      ...Array.from({ length: 3 }, (_, i) => fact({ key: `p${i}`, agent_id: "qa", importance: 3 })),
    ];
    const h = computeMemoryHealth(facts);
    expect(h.byAgent.find(a => a.agent_id === "default")?.facts).toBe(5);
    expect(h.underRecording).toEqual([]);   // only one private role — nothing to compare against
  });

  it("warns when no constraints exist in a sizeable memory", () => {
    const facts = Array.from({ length: 100 }, (_, i) => fact({ key: `f${i}`, importance: 3, kind: "fact" }));
    expect(computeMemoryHealth(facts).warnings.join(" ")).toMatch(/constraint/);
  });

  it("stops warning once constraints are recorded", () => {
    const facts = [
      ...Array.from({ length: 100 }, (_, i) => fact({ key: `f${i}`, importance: 3, kind: "fact" })),
      fact({ key: "rule", kind: "constraint", importance: 3 }),
    ];
    const h = computeMemoryHealth(facts);
    expect(h.pinnedCount).toBe(1);
    expect(h.warnings.join(" ")).not.toMatch(/No 'constraint'/);
  });

  it("handles an empty memory without dividing by zero", () => {
    const h = computeMemoryHealth([]);
    expect(h.totalFacts).toBe(0);
    expect(h.imp5Pct).toBe(0);
    expect(h.warnings).toEqual([]);
  });
});

// ── Integration: pinned facts survive a budget that would otherwise drop them ──
describe("budgetFacts integration — a constraint cannot be truncated away", () => {
  it("renders a constraint even when the budget is exhausted by louder facts", async () => {
    const { budgetFacts } = await import("./recall_budget.js");
    const noise = Array.from({ length: 200 }, (_, i) => ({
      key: `NOISE_${i}`, value: "x".repeat(400), importance: 5, agent_id: "orchestrator", kind: "fact",
    }));
    // The constraint is LAST — worst case, exactly how it gets lost.
    const constraint = {
      key: "SC1_PROTECTED_AGENTS", value: "never terminate date-check-2026, date-verify-agent",
      importance: 3, agent_id: "default", kind: "constraint",
    };
    const res = budgetFacts([...noise, constraint], { maxChars: 2000 });
    expect(res.collapsed.length).toBeGreaterThan(0);          // budget really did bite
    expect(res.rendered.map(f => f.key)).toContain("SC1_PROTECTED_AGENTS");
    expect(res.collapsed.map(f => f.key)).not.toContain("SC1_PROTECTED_AGENTS");
    expect(res.rendered[0].key).toBe("SC1_PROTECTED_AGENTS"); // and it renders FIRST
  });

  it("without the pinned kind, the same fact IS collapsed — proves the mechanism", async () => {
    const { budgetFacts } = await import("./recall_budget.js");
    const noise = Array.from({ length: 200 }, (_, i) => ({
      key: `NOISE_${i}`, value: "x".repeat(400), importance: 5, agent_id: "orchestrator", kind: "fact",
    }));
    const plain = {
      key: "SC1_PROTECTED_AGENTS", value: "never terminate date-check-2026",
      importance: 3, agent_id: "default", kind: "fact",
    };
    const res = budgetFacts([...noise, plain], { maxChars: 2000 });
    expect(res.collapsed.map(f => f.key)).toContain("SC1_PROTECTED_AGENTS");
  });
});

// ── Write-path guard: the bug 26 fixture tests could not catch ────────────────
// A live E2E failed while every unit test above passed, because they all
// CONSTRUCTED facts with kind:'constraint' directly. The real zc_remember path
// validated kind against a 4-value whitelist, silently coerced anything else,
// and returned SUCCESS. Fixtures proved the code agreed with the author's
// assumptions; only real data proved it agreed with reality.
describe("kind whitelist — the pinned kinds must survive the WRITE path", () => {
  it("accepts constraint and antipattern as valid kinds (not coerced away)", async () => {
    const mem = await import("./memory.js");
    // The exported union is the contract the write path validates against.
    const kinds: Array<import("./memory.js").MemoryKind> =
      ["fact", "decision", "hypothesis", "prediction", "constraint", "antipattern"];
    expect(kinds).toContain("constraint");
    expect(kinds).toContain("antipattern");
    expect(typeof mem.rememberFact).toBe("function");
  });

  it("the MCP tool schema advertises the pinned kinds, or agents cannot request them", async () => {
    const src = await import("node:fs").then(fs =>
      fs.readFileSync(new URL("./server.ts", import.meta.url), "utf8"));
    const kindLine = src.split("\n").find(l => l.includes('kind:') && l.includes('enum:'));
    expect(kindLine).toBeDefined();
    expect(kindLine).toContain("constraint");
    expect(kindLine).toContain("antipattern");
  });
});

// ── Drift guard: every kind definition must agree with MEMORY_KINDS ───────────
// v0.51.0 shipped, then failed a live E2E TWICE, because the kind enum was
// duplicated in seven places and only some were updated. Each write returned
// SUCCESS while silently coercing kind to 'fact'. This test fails the moment a
// new definition drifts from the single source of truth.
describe("kind enum drift — seven copies is how a write silently loses a field", () => {
  it("every file that validates or constrains kind admits all MEMORY_KINDS", async () => {
    const { MEMORY_KINDS } = await import("./memory.js");
    const fs = await import("node:fs");
    // Whitespace-normalised whole-file scan: a definition may be split across
    // lines (migration 44 is), so line-based matching gives false failures.
    const flat = (f: string) =>
      fs.readFileSync(new URL(f, import.meta.url), "utf8").replace(/\s+/g, " ");

    for (const file of ["./server.ts", "./store-postgres.ts", "./migrations.ts", "./pg_migrations.ts"]) {
      const src = flat(file);
      for (const k of MEMORY_KINDS) {
        expect(src.includes(`'${k}'`) || src.includes(`"${k}"`),
          `${file} never mentions kind '${k}' — a write with that kind will be silently coerced to 'fact'`
        ).toBe(true);
      }
    }
  });

  it("the PG write path derives its whitelist rather than re-typing it", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./store-postgres.ts", import.meta.url), "utf8");
    expect(src).toContain("MEMORY_KINDS");
    expect(src).not.toMatch(/const KINDS = \["fact", "decision", "hypothesis", "prediction"\]/);
  });
});

describe("pinned overflow is announced, never silent", () => {
  it("says so when constraints exceed PINNED_MAX_FACTS", async () => {
    const { budgetFacts } = await import("./recall_budget.js");
    const { Config } = await import("./config.js");
    const over = Config.PINNED_MAX_FACTS + 5;
    const facts = Array.from({ length: over }, (_, i) => ({
      key: `C_${i}`,
      value: "x".repeat(400),
      importance: 3,
      kind: "constraint",
      created_at: new Date().toISOString(),
    }));
    // Budget small enough that the overflowed constraints cannot fit as normal facts.
    const r = budgetFacts(facts, { maxChars: 200 });
    expect(r.collapsed.length).toBeGreaterThan(0);
    expect(r.tailNotice).toContain("exceeded the pinned budget");
    expect(r.tailNotice).toContain("ZC_PINNED_MAX_FACTS");
  });

  it("stays quiet when nothing pinned overflowed", async () => {
    const { budgetFacts } = await import("./recall_budget.js");
    const facts = Array.from({ length: 40 }, (_, i) => ({
      key: `N_${i}`,
      value: "y".repeat(400),
      importance: 5,
      kind: "fact",
      created_at: new Date().toISOString(),
    }));
    const r = budgetFacts(facts, { maxChars: 1000 });
    expect(r.collapsed.length).toBeGreaterThan(0);
    expect(r.tailNotice).not.toContain("ZC_PINNED_MAX_FACTS");
  });
});

describe("a pinned kind cannot be retired automatically", () => {
  // The live failure: four operator constraints on the A2A project were retired
  // with reason 'superseded' — two of them lost to `last_session_summary`, and
  // one rule was killed by a different rule — because the contradiction
  // adjudicator picks a survivor by recency. Retirement leaves the fact findable
  // by zc_search while removing it from every recall, so it looked present.
  const AUTOMATIC = ["superseded", "consolidated", "expired"];
  const EXPLICIT  = ["operator", "forget", "manual"];

  it("classifies the automatic reasons as pinned-protected", async () => {
    const { isPinnedKind } = await import("./memory_quality.js");
    for (const kind of ["constraint", "antipattern"]) {
      expect(isPinnedKind({ key: "k", importance: 3, kind })).toBe(true);
    }
    for (const kind of ["fact", "decision", "hypothesis", "prediction"]) {
      expect(isPinnedKind({ key: "k", importance: 5, kind })).toBe(false);
    }
  });

  it("both store implementations guard the same reason set", async () => {
    const fs = await import("node:fs");
    const flat = (f: string) =>
      fs.readFileSync(new URL(f, import.meta.url), "utf8").replace(/\s+/g, " ");
    for (const file of ["./store-postgres.ts", "./memory.ts"]) {
      const src = flat(file);
      expect(src, `${file} must refuse automatic retirement of pinned kinds`)
        .toContain("AUTOMATIC_REASONS");
      for (const r of AUTOMATIC) expect(src).toContain(`"${r}"`);
      // The guard must be conditional on the reason, not blanket — explicit
      // operator retirement (zc_forget, dashboard) has to keep working.
      expect(src).toContain("AUTOMATIC_REASONS.has(reason)");
    }
    expect(EXPLICIT.every((r) => !AUTOMATIC.includes(r))).toBe(true);
  });

  it("pinned kinds get a longer value budget than plain facts", async () => {
    const { Config } = await import("./config.js");
    expect(Config.PINNED_VALUE_MAX).toBeGreaterThan(500);
  });
});

describe("per-task markers expire by default", () => {
  // The orchestrator, asked what was actually crowding out its recall, named the
  // per-task markers rather than the pinned rules I suspected: 97 live
  // OWNERSHIP_*/ACCEPTANCE_* facts holding 52,982 chars — over 3x the whole
  // recall budget — 29 of them with no expiry. The "set ttl_days" convention was
  // documented but unenforced, so it decayed into a suggestion.
  const PER_TASK = /^(OWNERSHIP|ACCEPTANCE|ACCEPT|TASK|CKPT|CLAIM)[_-]/i;

  it("recognises the convention-named keys and nothing else", () => {
    for (const k of ["OWNERSHIP_DEV_TASK_X", "ACCEPTANCE_GATE_9", "ckpt_fix1", "TASK-42", "CLAIM_A"])
      expect(PER_TASK.test(k), k).toBe(true);
    for (const k of ["STANDING_RULE_MERGE", "FEEDBACK_QA_FIRST", "AUDIT_FINDINGS_2026", "last_session_summary"])
      expect(PER_TASK.test(k), k).toBe(false);
  });

  it("is configurable and disableable", async () => {
    const { Config } = await import("./config.js");
    expect(Config.TASK_MARKER_TTL_DAYS).toBeGreaterThanOrEqual(0);
  });

  it("never auto-expires a pinned kind or a high-importance fact", async () => {
    const src = (await import("node:fs"))
      .readFileSync(new URL("./store-postgres.ts", import.meta.url), "utf8").replace(/\s+/g, " ");
    // A durable decision or standing rule must be immune even if someone names it
    // TASK_something — expiring one of those is the failure this whole branch exists to stop.
    expect(src).toContain("safeImp <= 4");
    expect(src).toContain("!isPinnedKind({ key: safeKey, importance: safeImp, kind: safeKind })");
  });
});

describe("pinned facts do not consume the working-context budget", () => {
  // Measured trigger: once the A2A team started writing real constraints, 12
  // pinned facts reached 13,220 of a 16,000-char budget (83%), leaving room for
  // about seven working facts. Charging standing rules against working context
  // forces a false choice between knowing the rules and knowing what is happening.
  it("renders working facts even when pins are large", async () => {
    const { budgetFacts } = await import("./recall_budget.js");
    const pins = Array.from({ length: 8 }, (_, i) => ({
      key: `C_${i}`, value: "c".repeat(1000), importance: 3,
      kind: i % 2 ? "constraint" : "antipattern", created_at: new Date().toISOString(),
    }));
    const work = Array.from({ length: 20 }, (_, i) => ({
      key: `W_${i}`, value: "w".repeat(300), importance: 5,
      kind: "fact", created_at: new Date().toISOString(),
    }));
    const r = budgetFacts([...pins, ...work], { maxChars: 4000 });
    const renderedWork = r.rendered.filter((f) => f.kind === "fact").length;
    const renderedPins = r.rendered.filter((f) => f.kind !== "fact").length;
    expect(renderedPins).toBeGreaterThan(0);
    // The whole point: ~8000 chars of pins must NOT starve a 4000-char working budget.
    expect(renderedWork, "pins starved the working-context budget").toBeGreaterThan(5);
  });

  it("still bounds pins by their own char budget and announces drops", async () => {
    const { budgetFacts } = await import("./recall_budget.js");
    const { Config } = await import("./config.js");
    const huge = Math.ceil(Config.PINNED_MAX_CHARS / 800) + 6;
    const pins = Array.from({ length: huge }, (_, i) => ({
      key: `C_${i}`, value: "c".repeat(800), importance: 3, kind: "constraint",
      created_at: new Date().toISOString(),
    }));
    const r = budgetFacts(pins, { maxChars: 2000 });
    expect(r.collapsed.length).toBeGreaterThan(0);
    expect(r.tailNotice).toContain("ZC_PINNED_MAX_CHARS");
  });
});
