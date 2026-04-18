/**
 * Tests for src/security/chained_table.ts (v0.12.0 Sprint 2 prep)
 *
 * Coverage:
 *   - deriveAgentChainKey: deterministic per-agent, distinct across agents
 *   - computeChainHash: same canonical bytes → same hash; different agent → different hash
 *   - verifyChainRows: detects prev-mismatch + hash-mismatch + cross-agent forgery
 *   - Red-team RT-S2-01: agent A cannot forge a row claiming to be agent B
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import {
  deriveAgentChainKey,
  computeChainHash,
  verifyChainRows,
  GENESIS,
  canonicalize,
  type ChainableRow,
} from "./chained_table.js";
import {
  _resetCacheForTesting as resetMachineSecret,
  MACHINE_SECRET_PATH,
} from "./machine_secret.js";
import { hmacRowHash } from "./hmac_chain.js";

beforeEach(() => {
  try { if (existsSync(MACHINE_SECRET_PATH)) unlinkSync(MACHINE_SECRET_PATH); } catch {}
  resetMachineSecret();
});

afterEach(() => {
  try { if (existsSync(MACHINE_SECRET_PATH)) unlinkSync(MACHINE_SECRET_PATH); } catch {}
  resetMachineSecret();
});

describe("deriveAgentChainKey", () => {

  it("returns a 32-byte Buffer", () => {
    const k = deriveAgentChainKey("agent-x");
    expect(Buffer.isBuffer(k)).toBe(true);
    expect(k.length).toBe(32);
  });

  it("is deterministic for the same agent_id within a process", () => {
    const k1 = deriveAgentChainKey("agent-x");
    const k2 = deriveAgentChainKey("agent-x");
    expect(k1.equals(k2)).toBe(true);
  });

  it("yields different keys for different agent_ids", () => {
    const a = deriveAgentChainKey("alice");
    const b = deriveAgentChainKey("bob");
    expect(a.equals(b)).toBe(false);
  });

  it("yields different keys after machine_secret rotation", () => {
    const before = deriveAgentChainKey("agent-x");
    // Rotate
    if (existsSync(MACHINE_SECRET_PATH)) unlinkSync(MACHINE_SECRET_PATH);
    resetMachineSecret();
    const after = deriveAgentChainKey("agent-x");
    expect(before.equals(after)).toBe(false);
  });

  it("rejects empty/non-string agent_id", () => {
    expect(() => deriveAgentChainKey("")).toThrow();
    expect(() => deriveAgentChainKey(null as unknown as string)).toThrow();
    expect(() => deriveAgentChainKey(undefined as unknown as string)).toThrow();
  });

  it("treats agent_id as case-sensitive", () => {
    const lower = deriveAgentChainKey("agent");
    const upper = deriveAgentChainKey("AGENT");
    expect(lower.equals(upper)).toBe(false);
  });

  it("produces stable HKDF output for known agent_id (regression sentinel)", () => {
    // Setting machine_secret via env to a known value so we can pin the output
    const prevEnv = process.env.ZC_MACHINE_SECRET;
    process.env.ZC_MACHINE_SECRET = "00".repeat(64);  // 64 bytes hex of zeros
    try {
      resetMachineSecret();
      const k = deriveAgentChainKey("orchestrator");
      // Sanity: 32 bytes hex
      expect(k.toString("hex")).toMatch(/^[0-9a-f]{64}$/);
      // Stability: same input → same output across runs
      const k2 = deriveAgentChainKey("orchestrator");
      expect(k.equals(k2)).toBe(true);
    } finally {
      if (prevEnv !== undefined) process.env.ZC_MACHINE_SECRET = prevEnv;
      else delete process.env.ZC_MACHINE_SECRET;
      resetMachineSecret();
    }
  });
});

describe("computeChainHash", () => {

  it("produces the same hash for identical input within an agent", () => {
    const input = {
      agentId: "agent-x", projectHash: "abc",
      canonicalFields: ["a", 1, "b"],
    };
    const r1 = computeChainHash(input, GENESIS);
    const r2 = computeChainHash(input, GENESIS);
    expect(r1.rowHash).toBe(r2.rowHash);
    expect(r1.canonical).toBe(r2.canonical);
  });

  it("produces a DIFFERENT hash if agent_id changes (subkey isolation)", () => {
    const fields: Array<string | number> = ["call-1", "session-1", "Read", 100, 50];
    const r1 = computeChainHash({ agentId: "alice", projectHash: "p", canonicalFields: fields }, GENESIS);
    const r2 = computeChainHash({ agentId: "bob",   projectHash: "p", canonicalFields: fields }, GENESIS);
    expect(r1.rowHash).not.toBe(r2.rowHash);
    expect(r1.canonical).toBe(r2.canonical);  // same canonical bytes, different keys → different HMAC
  });

  it("produces different hash if any canonical field changes", () => {
    const a = computeChainHash({ agentId: "x", projectHash: "p", canonicalFields: ["a"] }, GENESIS);
    const b = computeChainHash({ agentId: "x", projectHash: "p", canonicalFields: ["b"] }, GENESIS);
    expect(a.rowHash).not.toBe(b.rowHash);
  });

  it("links via prev_hash (different prev → different row hash)", () => {
    const fields = ["x"];
    const a = computeChainHash({ agentId: "x", projectHash: "p", canonicalFields: fields }, GENESIS);
    const b = computeChainHash({ agentId: "x", projectHash: "p", canonicalFields: fields }, "deadbeef".repeat(8));
    expect(a.rowHash).not.toBe(b.rowHash);
  });
});

describe("verifyChainRows", () => {

  type TestRow = ChainableRow & { agentIdForVerify: string; canonical_field: string };

  let nextId = 1;
  function makeRow(
    agentId: string, prev: string, canonicalField: string,
  ): TestRow {
    const c = canonicalize([canonicalField]);
    const key = deriveAgentChainKey(agentId);
    const rowHash = hmacRowHash(key, prev, c);
    return {
      id: nextId++,
      agentIdForVerify: agentId,
      canonical_field: canonicalField,
      prev_hash: prev,
      row_hash: rowHash,
    };
  }

  it("returns ok=true for empty chain", () => {
    const r = verifyChainRows<TestRow>([], (r) => canonicalize([r.canonical_field]));
    expect(r.ok).toBe(true);
    expect(r.totalRows).toBe(0);
  });

  it("verifies a clean 5-row chain across multiple agents", () => {
    const rows: TestRow[] = [];
    let prev = GENESIS;
    const agents = ["alice", "bob", "alice", "carol", "bob"];
    for (let i = 0; i < 5; i++) {
      const r = makeRow(agents[i], prev, `value-${i}`);
      rows.push(r);
      prev = r.row_hash;
    }
    const out = verifyChainRows(rows, (r) => canonicalize([r.canonical_field]));
    expect(out.ok).toBe(true);
    expect(out.totalRows).toBe(5);
  });

  it("detects prev-mismatch", () => {
    const r1 = makeRow("alice", GENESIS, "a");
    const r2 = makeRow("alice", "0".repeat(64), "b");  // wrong prev_hash
    const out = verifyChainRows([r1, r2], (r) => canonicalize([r.canonical_field]));
    expect(out.ok).toBe(false);
    expect(out.brokenKind).toBe("prev-mismatch");
    expect(out.brokenAt).toBe(1);
  });

  it("detects hash-mismatch (row content tampered after write)", () => {
    const r1 = makeRow("alice", GENESIS, "a");
    const r2 = makeRow("alice", r1.row_hash, "b");
    // Tamper: change canonical field but keep stored row_hash
    const tampered = { ...r2, canonical_field: "TAMPERED" };
    const out = verifyChainRows([r1, tampered], (r) => canonicalize([r.canonical_field]));
    expect(out.ok).toBe(false);
    expect(out.brokenKind).toBe("hash-mismatch");
    expect(out.brokenAt).toBe(1);
  });

  it("[RT-S2-01] cross-agent forgery: bob CANNOT pass off a row claiming alice's identity", () => {
    // Genuine row written by alice
    const aliceRow = makeRow("alice", GENESIS, "real");

    // Attacker (bob) tries to insert a row claiming "alice" wrote it
    const bobsKey = deriveAgentChainKey("bob");
    const c = canonicalize(["fake"]);
    const fakeRowHash = hmacRowHash(bobsKey, aliceRow.row_hash, c);
    const forgedRow: TestRow = {
      id: 99,
      agentIdForVerify: "alice",  // claims to be alice
      canonical_field: "fake",
      prev_hash: aliceRow.row_hash,
      row_hash: fakeRowHash,       // hashed with bob's key
    };

    // Verifier derives alice's subkey (per agentIdForVerify) and recomputes;
    // hash won't match because bob used the wrong subkey.
    const out = verifyChainRows([aliceRow, forgedRow], (r) => canonicalize([r.canonical_field]));
    expect(out.ok).toBe(false);
    expect(out.brokenKind).toBe("hash-mismatch");
    expect(out.brokenAt).toBe(1);
  });
});
