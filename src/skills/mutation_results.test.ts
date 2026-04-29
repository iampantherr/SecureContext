/**
 * Tests for v0.18.1 — mutation_results side-channel (option-b architecture).
 *
 * Covers:
 *   - recordMutationResult writes a row + returns pointer with bodies_hash
 *   - bodies_hash is deterministic (same bodies → same hash)
 *   - bodies_hash differs when any candidate's content changes (tamper detect)
 *   - candidate_count + best_score derived correctly from input
 *   - fetchMutationResult round-trips bodies bit-for-bit
 *   - fetchMutationResult returns null on hash mismatch (DB row tampered)
 *   - fetchMutationResult returns null on expectedHash mismatch (broadcast lied)
 *   - fetchByResultId works
 *   - markConsumed sets consumed_at/consumed_by; idempotent (second call false)
 *   - large bodies (>>1KB) round-trip without truncation — the WHOLE point
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../migrations.js";
import {
  recordMutationResult, fetchMutationResult, fetchByResultId, markConsumed,
  hashBodies, canonicalizeBodies,
  type MutationCandidate,
} from "./mutation_results.js";

let tmpDir: string;
let db: DatabaseSync;

const SAMPLE: MutationCandidate[] = [
  { candidate_body: "# v1\n\nbody one", rationale: "first try",  self_rated_score: 0.7 },
  { candidate_body: "# v2\n\nbody two", rationale: "second try", self_rated_score: 0.85 },
  { candidate_body: "# v3\n\nbody three with **markdown**", rationale: "third try", self_rated_score: 0.81 },
];

beforeEach(() => {
  mkdirSync(join(homedir(), ".claude", "zc-ctx"), { recursive: true });
  tmpDir = mkdtempSync(join(tmpdir(), "mres-"));
  db = new DatabaseSync(join(tmpDir, "test.db"));
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  // Force SQLite-only path so PG isn't required for unit tests
  process.env.ZC_TELEMETRY_BACKEND = "sqlite";
});

afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  delete process.env.ZC_TELEMETRY_BACKEND;
});

describe("v0.18.1 — mutation_results", () => {

  it("hashBodies is deterministic for identical input", () => {
    const h1 = hashBodies(SAMPLE);
    const h2 = hashBodies(SAMPLE);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("hashBodies differs when any field changes (tamper-evidence)", () => {
    const baseline = hashBodies(SAMPLE);
    const tampered = hashBodies([
      { ...SAMPLE[0], candidate_body: SAMPLE[0].candidate_body + "!" },
      SAMPLE[1], SAMPLE[2],
    ]);
    expect(tampered).not.toBe(baseline);
  });

  it("canonicalizeBodies produces stable ordering across re-encodings", () => {
    const j1 = canonicalizeBodies(SAMPLE);
    const reordered: MutationCandidate[] = SAMPLE.map((c) => ({
      // Construct in a different key order — canonical form should still match
      self_rated_score: c.self_rated_score,
      rationale:        c.rationale,
      candidate_body:   c.candidate_body,
    }));
    const j2 = canonicalizeBodies(reordered);
    expect(j1).toBe(j2);
  });

  it("recordMutationResult inserts row + returns pointer with derived hash", async () => {
    const ptr = await recordMutationResult(db, {
      mutation_id:  "mut-test-001",
      skill_id:     "validate-input@1.0.0@project:abc1234567890123",
      project_hash: "abc1234567890123",
      proposer_model: "claude-sonnet-4-6",
      proposer_role:  "cli-mutator",
      bodies: SAMPLE,
    });
    expect(ptr.result_id).toMatch(/^mres-[0-9a-f-]{12}$/);
    expect(ptr.mutation_id).toBe("mut-test-001");
    expect(ptr.bodies_hash).toBe(hashBodies(SAMPLE));
    expect(ptr.headline).toContain("3 candidates");
    expect(ptr.headline).toContain("best=0.85");

    const row = db.prepare(`SELECT * FROM mutation_results WHERE result_id = ?`).get(ptr.result_id) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.candidate_count).toBe(3);
    expect(Number(row.best_score)).toBeCloseTo(0.85, 4);
    expect(row.bodies_hash).toBe(ptr.bodies_hash);
    expect(row.proposer_model).toBe("claude-sonnet-4-6");
  });

  it("fetchMutationResult round-trips bodies bit-for-bit", async () => {
    const ptr = await recordMutationResult(db, {
      mutation_id:  "mut-rt-002",
      skill_id:     "x@1@project:abc1234567890123",
      project_hash: "abc1234567890123",
      bodies: SAMPLE,
    });
    const fetched = await fetchMutationResult(db, "mut-rt-002");
    expect(fetched).not.toBeNull();
    expect(fetched!.result_id).toBe(ptr.result_id);
    expect(fetched!.candidate_count).toBe(3);
    expect(fetched!.bodies).toEqual(SAMPLE);
    expect(fetched!.bodies_hash).toBe(ptr.bodies_hash);
  });

  it("fetchMutationResult returns null on bodies tamper (hash mismatch)", async () => {
    const ptr = await recordMutationResult(db, {
      mutation_id:  "mut-tamper-003",
      skill_id:     "x@1@project:abc",
      project_hash: "abc",
      bodies: SAMPLE,
    });
    // Simulate a tamperer modifying the bodies column directly without
    // updating the hash. fetchMutationResult must detect and return null.
    const tamperedBodies = JSON.stringify([
      { ...SAMPLE[0], candidate_body: "EVIL OVERRIDE" },
      SAMPLE[1], SAMPLE[2],
    ]);
    db.prepare(`UPDATE mutation_results SET bodies = ? WHERE result_id = ?`)
      .run(tamperedBodies, ptr.result_id);

    const fetched = await fetchMutationResult(db, "mut-tamper-003");
    expect(fetched).toBeNull();
  });

  it("fetchMutationResult returns null when expectedHash from broadcast disagrees", async () => {
    await recordMutationResult(db, {
      mutation_id:  "mut-expect-004",
      skill_id:     "x@1@project:abc",
      project_hash: "abc",
      bodies: SAMPLE,
    });
    const fetched = await fetchMutationResult(db, "mut-expect-004", {
      expectedHash: "sha256:" + "0".repeat(64),  // wrong
    });
    expect(fetched).toBeNull();
  });

  it("fetchByResultId works", async () => {
    const ptr = await recordMutationResult(db, {
      mutation_id:  "mut-byid-005",
      skill_id:     "x@1@project:abc",
      project_hash: "abc",
      bodies: SAMPLE,
    });
    const r = await fetchByResultId(db, ptr.result_id);
    expect(r).not.toBeNull();
    expect(r!.mutation_id).toBe("mut-byid-005");
    expect(r!.bodies.length).toBe(3);
  });

  it("markConsumed sets consumed_at/by; second call returns false (idempotent)", async () => {
    const ptr = await recordMutationResult(db, {
      mutation_id:  "mut-consume-006",
      skill_id:     "x@1@project:abc",
      project_hash: "abc",
      bodies: SAMPLE,
    });
    expect(await markConsumed(db, ptr.result_id, "orchestrator-1")).toBe(true);
    const row = db.prepare(`SELECT * FROM mutation_results WHERE result_id = ?`).get(ptr.result_id) as Record<string, unknown>;
    expect(row.consumed_by).toBe("orchestrator-1");
    expect(row.consumed_at).not.toBeNull();
    // Second consumption is a no-op
    expect(await markConsumed(db, ptr.result_id, "orchestrator-2")).toBe(false);
  });

  it("LARGE bodies (>>1KB each, 5 candidates) round-trip without truncation", async () => {
    // The WHOLE point of option-b: bodies that would NEVER fit in the 1000-char
    // broadcast.summary cap must round-trip cleanly through the side-channel.
    const big: MutationCandidate[] = Array.from({ length: 5 }, (_, i) => ({
      candidate_body:
        "# Candidate " + (i + 1) + "\n\n" +
        // ~5 KB of realistic markdown content per candidate
        Array.from({ length: 200 }, (_, j) =>
          `- Step ${j + 1}: Carefully consider edge case #${j + 1} ` +
          `for input validation, including null/undefined coercion and ` +
          `retry-aware semantics. This is a deliberately verbose body to ` +
          `simulate a realistic skill that explains its reasoning.`
        ).join("\n"),
      rationale: `Long-form rationale for candidate ${i + 1}: this is what makes the side-channel necessary — the body is far larger than any sensible broadcast summary cap.`,
      self_rated_score: 0.7 + i * 0.05,
    }));
    // Sanity: each body is > 5 KB
    for (const c of big) expect(c.candidate_body.length).toBeGreaterThan(5000);

    const ptr = await recordMutationResult(db, {
      mutation_id:  "mut-big-007",
      skill_id:     "x@1@project:abc",
      project_hash: "abc",
      bodies: big,
    });
    const fetched = await fetchMutationResult(db, "mut-big-007");
    expect(fetched).not.toBeNull();
    expect(fetched!.candidate_count).toBe(5);
    expect(fetched!.bodies).toEqual(big);
    // Verify byte-perfect round-trip on the largest body
    expect(fetched!.bodies[4].candidate_body).toBe(big[4].candidate_body);
    expect(fetched!.bodies[4].candidate_body.length).toBeGreaterThan(5000);
  });

  it("empty bodies array → headline still produced, candidate_count=0, best_score=null", async () => {
    const ptr = await recordMutationResult(db, {
      mutation_id:  "mut-empty-008",
      skill_id:     "x@1@project:abc",
      project_hash: "abc",
      bodies: [],
    });
    const r = await fetchByResultId(db, ptr.result_id);
    expect(r!.candidate_count).toBe(0);
    expect(r!.best_score).toBeNull();
    expect(r!.bodies).toEqual([]);
    expect(ptr.headline).toContain("0 candidates");
  });
});
