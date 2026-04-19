/**
 * Tests for v0.17.0 §8.5 — complexity-based model routing.
 *
 * Covers:
 *   - tier mapping 1,2→haiku; 3,4→sonnet; 5→opus
 *   - clamping: <1, >5, non-finite, undefined, null all produce safe defaults
 *   - env var override of model identifiers
 *   - cost lookup matches pricing table
 *   - inputClamped flag accurate
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Capture originals so each test can mutate env independently.
const ORIGINAL_ENV = {
  HAIKU:  process.env.ZC_MODEL_TIER_HAIKU,
  SONNET: process.env.ZC_MODEL_TIER_SONNET,
  OPUS:   process.env.ZC_MODEL_TIER_OPUS,
};

afterEach(() => {
  // Restore to avoid cross-test pollution. NOTE: `process.env.X = undefined`
  // assigns the literal STRING "undefined" — must delete instead.
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("ZC_MODEL_TIER_HAIKU",  ORIGINAL_ENV.HAIKU);
  restore("ZC_MODEL_TIER_SONNET", ORIGINAL_ENV.SONNET);
  restore("ZC_MODEL_TIER_OPUS",   ORIGINAL_ENV.OPUS);
});

/** Re-import module fresh so env-var constants re-bind. */
async function freshImport() {
  const mod = await import("./model_router.js?t=" + Date.now());
  return mod as typeof import("./model_router.js");
}

describe("v0.17.0 §8.5 — chooseModel tier routing", () => {

  it("complexity 1 → haiku tier", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(1);
    expect(r.tier).toBe("haiku");
    expect(r.model).toContain("haiku");
    expect(r.inputClamped).toBe(false);
    expect(r.estimatedInputCostPerMtok).toBe(0.25);
  });

  it("complexity 2 → haiku tier", async () => {
    const { chooseModel } = await freshImport();
    expect(chooseModel(2).tier).toBe("haiku");
  });

  it("complexity 3 → sonnet tier", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(3);
    expect(r.tier).toBe("sonnet");
    expect(r.estimatedInputCostPerMtok).toBe(3.00);
  });

  it("complexity 4 → sonnet tier", async () => {
    const { chooseModel } = await freshImport();
    expect(chooseModel(4).tier).toBe("sonnet");
  });

  it("complexity 5 → opus tier", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(5);
    expect(r.tier).toBe("opus");
    expect(r.estimatedInputCostPerMtok).toBe(15.00);
  });

  it("rounds 3.4 → 3 → sonnet, NOT clamped", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(3.4);
    expect(r.tier).toBe("sonnet");
    expect(r.inputClamped).toBe(false);
  });

  it("rounds 4.6 → 5 → opus, NOT clamped", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(4.6);
    expect(r.tier).toBe("opus");
    expect(r.inputClamped).toBe(false);
  });

  // ── Clamping ────────────────────────────────────────────────────────────

  it("clamps 0 → 1 → haiku, inputClamped=true", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(0);
    expect(r.tier).toBe("haiku");
    expect(r.inputClamped).toBe(true);
  });

  it("clamps -5 → 1 → haiku, inputClamped=true", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(-5);
    expect(r.tier).toBe("haiku");
    expect(r.inputClamped).toBe(true);
  });

  it("clamps 99 → 5 → opus, inputClamped=true", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(99);
    expect(r.tier).toBe("opus");
    expect(r.inputClamped).toBe(true);
  });

  it("undefined → sonnet default, inputClamped=true", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(undefined);
    expect(r.tier).toBe("sonnet");
    expect(r.inputClamped).toBe(true);
  });

  it("null → sonnet default, inputClamped=true", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(null);
    expect(r.tier).toBe("sonnet");
    expect(r.inputClamped).toBe(true);
  });

  it("NaN → sonnet default, inputClamped=true", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(NaN);
    expect(r.tier).toBe("sonnet");
    expect(r.inputClamped).toBe(true);
  });

  it("Infinity → sonnet default, inputClamped=true", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(Infinity);
    expect(r.tier).toBe("sonnet");
    expect(r.inputClamped).toBe(true);
  });

  // ── Env var override ────────────────────────────────────────────────────

  it("env var ZC_MODEL_TIER_HAIKU overrides model id", async () => {
    process.env.ZC_MODEL_TIER_HAIKU = "custom-haiku-model";
    const { chooseModel } = await freshImport();
    expect(chooseModel(1).model).toBe("custom-haiku-model");
  });

  it("env var ZC_MODEL_TIER_SONNET overrides model id", async () => {
    process.env.ZC_MODEL_TIER_SONNET = "custom-sonnet-model";
    const { chooseModel } = await freshImport();
    expect(chooseModel(3).model).toBe("custom-sonnet-model");
  });

  it("env var ZC_MODEL_TIER_OPUS overrides model id", async () => {
    process.env.ZC_MODEL_TIER_OPUS = "custom-opus-model";
    const { chooseModel } = await freshImport();
    expect(chooseModel(5).model).toBe("custom-opus-model");
  });

  // ── Shape + reason ──────────────────────────────────────────────────────

  it("reason string is non-empty and mentions complexity level", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(3);
    expect(r.reason).toContain("3");
    expect(r.reason.length).toBeGreaterThan(10);
  });

  it("clamped result's reason mentions clamp note", async () => {
    const { chooseModel } = await freshImport();
    const r = chooseModel(99);
    expect(r.reason).toMatch(/clamp/i);
  });
});
