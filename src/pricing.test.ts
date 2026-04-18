/**
 * Tests for src/pricing.ts
 *
 * Covers:
 *   - Unit: cost math for each known model + batch + cached
 *   - Failure-mode: unknown model returns known=false
 *   - Red-team RT-S1-04: tampered pricing table detected → known=false
 *   - Red-team RT-S1-05: pricing version updates trusted (legit upgrade path)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  computeCost,
  listKnownModels,
  pricingTableVersion,
  verifyPricingTable,
  _resetPricingVerificationForTesting,
} from "./pricing.js";

const SIG_PATH = join(homedir(), ".claude", "zc-ctx", ".pricing_signature");

function clearSignatureFile(): void {
  try { if (existsSync(SIG_PATH)) unlinkSync(SIG_PATH); } catch {}
}

beforeEach(() => {
  _resetPricingVerificationForTesting();
  clearSignatureFile();
});

afterEach(() => {
  _resetPricingVerificationForTesting();
  clearSignatureFile();
});

describe("pricing", () => {
  // ── Unit: known models ──────────────────────────────────────────────────

  it("computes cost for claude-opus-4-7 (15/75 per Mtok)", () => {
    const c = computeCost("claude-opus-4-7", 1_000_000, 1_000_000);
    expect(c.known).toBe(true);
    // 15 (input) + 75 (output) = 90 USD
    expect(c.cost_usd).toBeCloseTo(90, 5);
  });

  it("computes cost for claude-sonnet-4-6 (3/15 per Mtok)", () => {
    const c = computeCost("claude-sonnet-4-6", 100_000, 100_000);
    // 0.3 (in) + 1.5 (out) = 1.8 USD
    expect(c.cost_usd).toBeCloseTo(1.8, 5);
    expect(c.known).toBe(true);
  });

  it("computes cost for claude-haiku-4-5 (0.80/4 per Mtok)", () => {
    const c = computeCost("claude-haiku-4-5", 1_000_000, 1_000_000);
    expect(c.cost_usd).toBeCloseTo(4.8, 5);  // 0.8 + 4
    expect(c.known).toBe(true);
  });

  it("computes zero cost for local Ollama models", () => {
    const c = computeCost("qwen2.5-coder:14b", 1_000_000, 1_000_000);
    expect(c.cost_usd).toBe(0);
    expect(c.known).toBe(true);  // model IS known; cost is genuinely zero
  });

  // ── Batch discount ──────────────────────────────────────────────────────

  it("applies 50% batch discount when batch=true on supported model", () => {
    const standard = computeCost("claude-sonnet-4-6", 1_000_000, 1_000_000);
    const batched  = computeCost("claude-sonnet-4-6", 1_000_000, 1_000_000, { batch: true });
    expect(batched.cost_usd).toBeCloseTo(standard.cost_usd * 0.5, 5);
    expect(batched.batch).toBe(true);
  });

  it("ignores batch flag for local models (batch_supported=false)", () => {
    const c = computeCost("qwen2.5-coder:14b", 1_000_000, 0, { batch: true });
    expect(c.cost_usd).toBe(0);  // free either way; batch flag is honored=true but no discount applies
  });

  // ── Cached input ────────────────────────────────────────────────────────

  it("applies cached_input_per_mtok when cached_input_tokens provided", () => {
    // Sonnet: input=3, cached_input=0.30 (10x discount on cached portion)
    const c = computeCost("claude-sonnet-4-6", 1_000_000, 0, { cached_input_tokens: 800_000 });
    // 200k uncached × $3/Mtok + 800k cached × $0.30/Mtok
    // = 0.6 + 0.24 = 0.84
    expect(c.cost_usd).toBeCloseTo(0.84, 5);
  });

  // ── Unknown models ──────────────────────────────────────────────────────

  it("returns known=false for unknown model", () => {
    const c = computeCost("gpt-9-omega-future-model", 100, 100);
    expect(c.known).toBe(false);
    expect(c.cost_usd).toBe(0);
  });

  // ── listKnownModels ─────────────────────────────────────────────────────

  it("listKnownModels returns sorted list including Claude family + Ollama", () => {
    const models = listKnownModels();
    expect(models.length).toBeGreaterThan(5);
    expect(models).toContain("claude-opus-4-7");
    expect(models).toContain("claude-sonnet-4-6");
    expect(models).toContain("claude-haiku-4-5");
    expect(models).toContain("qwen2.5-coder:14b");
    expect(models).toContain("nomic-embed-text");
    // Verify sort order
    const sorted = [...models].sort();
    expect(models).toEqual(sorted);
  });

  // ── Verification ────────────────────────────────────────────────────────

  it("verifyPricingTable creates baseline file on first run", () => {
    expect(existsSync(SIG_PATH)).toBe(false);
    const ok = verifyPricingTable();
    expect(ok).toBe(true);
    expect(existsSync(SIG_PATH)).toBe(true);
  });

  it("verifyPricingTable returns true when stored signature matches", () => {
    verifyPricingTable();  // first run records baseline
    _resetPricingVerificationForTesting();  // simulate process restart
    const ok = verifyPricingTable();
    expect(ok).toBe(true);
  });

  it("[RT-S1-04] verifyPricingTable detects tampered baseline file", () => {
    verifyPricingTable();  // record baseline

    // Attacker rewrites the baseline with the SAME version but a DIFFERENT signature
    const stored = JSON.parse(require("node:fs").readFileSync(SIG_PATH, "utf8"));
    stored.signature = "0000000000000000000000000000000000000000000000000000000000000000";
    writeFileSync(SIG_PATH, JSON.stringify(stored), { mode: 0o600 });

    _resetPricingVerificationForTesting();
    const ok = verifyPricingTable();
    expect(ok).toBe(false);

    // Subsequent computeCost should return known=false
    const c = computeCost("claude-sonnet-4-6", 100, 100);
    expect(c.known).toBe(false);
  });

  it("[RT-S1-05] version mismatch is treated as legit upgrade (re-records baseline)", () => {
    // Write a baseline with a DIFFERENT (older) version
    const dir = require("node:path").dirname(SIG_PATH);
    mkdirSync(dir, { recursive: true });
    writeFileSync(SIG_PATH, JSON.stringify({
      version: "2025-01-01.0",  // older
      signature: "previous-version-hash",
      recorded_at: "2025-01-01T00:00:00Z",
    }), { mode: 0o600 });

    _resetPricingVerificationForTesting();
    const ok = verifyPricingTable();
    expect(ok).toBe(true);  // version differs → trust new pricing, update baseline

    // The baseline file should now have the NEW version
    const stored = JSON.parse(require("node:fs").readFileSync(SIG_PATH, "utf8"));
    expect(stored.version).toBe(pricingTableVersion());
    expect(stored.previous_version).toBe("2025-01-01.0");
  });

  // ── pricingTableVersion ─────────────────────────────────────────────────

  it("pricingTableVersion returns a non-empty string", () => {
    const v = pricingTableVersion();
    expect(v).toBeTruthy();
    expect(typeof v).toBe("string");
    expect(v).toMatch(/\d{4}-\d{2}-\d{2}/);  // date-style version
  });
});
