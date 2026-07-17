/**
 * S6 (v0.45.0) — unit tests for the pure chain-verdict walker.
 *
 * Builds a synthetic tool_calls chain signed with a known root secret and
 * proves each verdict deterministically: verified (right key), hash-mismatch
 * (tampered field), link-broken (deleted row), unsigned (pre-chain row), and
 * multi-secret candidate matching (container vs host key labels).
 */
import { describe, it, expect } from "vitest";
import { walkChainVerdicts, type ChainRow } from "./replay.js";
import { deriveAgentChainKeyFrom } from "./security/chained_table.js";
import { hmacRowHash, GENESIS, canonicalize } from "./security/hmac_chain.js";

const PROJECT = "test-project-hash-0000";
const HOST_SECRET = Buffer.from("a".repeat(64), "hex");      // the "recording" machine
const CONTAINER_SECRET = Buffer.from("b".repeat(64), "hex"); // a different machine

/** Mirror of replay.ts canonicalFor — the 12 canonical fields of tool_calls. */
function canonicalFor(row: ChainRow): string {
  const cost = typeof row.cost_usd === "string" ? parseFloat(row.cost_usd) : row.cost_usd;
  return canonicalize([
    row.call_id, row.session_id, row.agent_id, PROJECT,
    row.tool_name, row.model, row.input_tokens, row.output_tokens,
    (cost ?? 0).toFixed(8), row.latency_ms, row.status,
    row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
  ]);
}

/** Build a signed chain of n rows (round-robin over agents) with a given root secret. */
function buildChain(n: number, secret: Buffer, agents = ["developer", "qa"]): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev = GENESIS;
  for (let i = 0; i < n; i++) {
    const agent = agents[i % agents.length]!;
    const row: ChainRow = {
      id: i + 1,
      call_id: `call-${i + 1}`,
      session_id: i < Math.ceil(n / 2) ? "sess-A" : "sess-B",
      agent_id: agent,
      tool_name: i % 2 === 0 ? "zc_search" : "zc_remember",
      model: "claude-sonnet-5",
      input_tokens: 100 + i,
      output_tokens: 50 + i,
      cost_usd: "0.00123400",
      latency_ms: 200 + i,
      status: "ok",
      ts: new Date(Date.UTC(2026, 6, 15, 10, 0, i)),
      prev_hash: prev,
      row_hash: "",
      task_id: null, skill_id: null, error_class: null,
    };
    row.row_hash = hmacRowHash(deriveAgentChainKeyFrom(secret, agent), prev, canonicalFor(row));
    prev = row.row_hash;
    rows.push(row);
  }
  return rows;
}

const HOST_ONLY = [{ label: "host", secret: HOST_SECRET }];
const BOTH = [
  { label: "container", secret: CONTAINER_SECRET },
  { label: "host", secret: HOST_SECRET },
];

describe("walkChainVerdicts", () => {
  it("verifies an intact chain end-to-end, per-agent subkeys included", () => {
    const rows = buildChain(6, HOST_SECRET);
    const v = walkChainVerdicts(rows, PROJECT, HOST_ONLY);
    expect(v).toHaveLength(6);
    for (const x of v) {
      expect(x.chain).toBe("verified");
      expect(x.key).toBe("host");
    }
  });

  it("reports which candidate secret verified when several are tried", () => {
    const rows = buildChain(4, HOST_SECRET);
    const v = walkChainVerdicts(rows, PROJECT, BOTH);
    // Container key fails, host key matches — label must say "host".
    expect(v.every((x) => x.chain === "verified" && x.key === "host")).toBe(true);
  });

  it("flags hash-mismatch on the tampered row only; later rows stay verified", () => {
    const rows = buildChain(5, HOST_SECRET);
    rows[2]!.output_tokens = 999_999; // tamper AFTER signing — linkage intact
    const v = walkChainVerdicts(rows, PROJECT, HOST_ONLY);
    expect(v.map((x) => x.chain)).toEqual([
      "verified", "verified", "hash-mismatch", "verified", "verified",
    ]);
    expect(v[2]!.key).toBeNull();
  });

  it("flags link-broken where a row was deleted, then resyncs", () => {
    const rows = buildChain(5, HOST_SECRET);
    rows.splice(2, 1); // delete row 3 — row 4's prev_hash no longer matches
    const v = walkChainVerdicts(rows, PROJECT, HOST_ONLY);
    expect(v.map((x) => x.chain)).toEqual([
      "verified", "verified", "link-broken", "verified",
    ]);
  });

  it("marks pre-chain rows unsigned without advancing linkage", () => {
    const rows = buildChain(4, HOST_SECRET);
    // Simulate two legacy rows recorded before chaining existed.
    const legacy: ChainRow[] = [0, 1].map((i) => ({
      ...rows[0]!, id: -2 + i, call_id: `legacy-${i}`, prev_hash: "", row_hash: "",
    }));
    const v = walkChainVerdicts([...legacy, ...rows], PROJECT, HOST_ONLY);
    expect(v.map((x) => x.chain)).toEqual([
      "unsigned", "unsigned", "verified", "verified", "verified", "verified",
    ]);
  });

  it("returns hash-mismatch when NO candidate secret matches (wrong machine)", () => {
    const rows = buildChain(3, HOST_SECRET);
    const v = walkChainVerdicts(rows, PROJECT, [{ label: "container", secret: CONTAINER_SECRET }]);
    expect(v.every((x) => x.chain === "hash-mismatch" && x.key === null)).toBe(true);
  });

  it("cross-agent forgery fails: row re-signed with the WRONG agent's subkey", () => {
    const rows = buildChain(4, HOST_SECRET);
    const r = rows[1]!; // signed by "qa" — re-sign claiming qa but keyed as developer
    r.row_hash = hmacRowHash(
      deriveAgentChainKeyFrom(HOST_SECRET, "developer"), r.prev_hash, canonicalFor(r),
    );
    // Fix downstream linkage so ONLY the subkey mismatch is visible.
    let prev = r.row_hash;
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i]!;
      row.prev_hash = prev;
      row.row_hash = hmacRowHash(
        deriveAgentChainKeyFrom(HOST_SECRET, row.agent_id), prev, canonicalFor(row),
      );
      prev = row.row_hash;
    }
    const v = walkChainVerdicts(rows, PROJECT, HOST_ONLY);
    expect(v.map((x) => x.chain)).toEqual([
      "verified", "hash-mismatch", "verified", "verified",
    ]);
  });

  it("empty input → empty output", () => {
    expect(walkChainVerdicts([], PROJECT, HOST_ONLY)).toEqual([]);
  });
});
