/**
 * v0.53.1 — Trustworthy-autonomy regression corpus.
 *
 * Ground truth from the 2026-08 live audits: 50 of 50 audited auto-retirements
 * were WRONG (353 facts restored across three sweeps), and exactly ONE genuine
 * conflict existed in the same period. These fixtures are drawn verbatim from
 * that history. The contract under test:
 *
 *   1. detectConflict must not flag any of the known-wrong pair SHAPES
 *      (rules-vs-facts, run reports, summaries embedding near records).
 *   2. The one genuine conflict shape (falsified-vs-live) must still flag.
 *   3. autoResolveVictim must produce NO victim for any pair here — with
 *      auto-resolve now default-off, victims only exist when an operator
 *      re-enables it, and even then the ★5 choke-point guard refuses.
 *
 * If a future change makes any wrong-corpus pair flag as a conflict with a
 * victim, this suite is the tripwire — precision is a regression-guarded
 * number, not a hope.
 */
import { describe, it, expect } from "vitest";
import { detectConflict, autoResolveVictim } from "./contradiction_heuristics.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

// ── The canonical wrong retirements, verbatim shapes from the live corpus ────
const WRONG_CORPUS: Array<{ name: string; a: any; b: any; sim: number }> = [
  {
    name: "release record eaten by a checkpoint that merely mentions it (the shutdown incident)",
    a: { key: "a2a_v010_rc1_complete_2026_08_16", kind: "fact", created_at: daysAgo(2),
         value: "A2A v0.1.0-rc1 COMPLETE from team side. Option A delivered end-to-end: A-1 loud persistence; A-2 self-destructing bootstrap credential; A-3 preflight, a2a_app role; A-4 install path, two-probe close." },
    b: { key: "RESUME_CHECKPOINT_2026_08_18", kind: "fact", created_at: daysAgo(0),
         value: "SHUTDOWN CHECKPOINT (resume exactly here). A2A: v0.1.0-rc1 COMPLETE, team retired cleanly. USER'S 3 GATES BEFORE TAG: rotation; push images; tag word." },
    sim: 0.84,
  },
  {
    name: "file-location note vs the P0 credential finding (DECISIONS_LOG_location incident)",
    a: { key: "DECISIONS_LOG_location", kind: "fact", created_at: daysAgo(1),
         value: "DECISIONS_LOG.md lives at the A2A repo root; D-001 through D-012 recorded with dates and operator confirmations. Removed the old scattered notes." },
    b: { key: "P0_supabase_service_role_leak", kind: "fact", created_at: daysAgo(9),
         value: "P0 SECURITY — STILL OPEN. apps/hub/.env holds a LIVE Supabase service_role key. Deleting the file does not fix this — only rotation does." },
    sim: 0.71,
  },
  {
    name: "an antipattern's reversal vocabulary vs an unrelated shipped-record",
    a: { key: "AP_SILENT_TRUNCATION_ON_THE_PRIVILEGED_PATH", kind: "antipattern", created_at: daysAgo(0),
         value: "ANTIPATTERN — when you give one code path a BIGGER budget, check it still runs through the SAME safety wrapper. The pinned path dropped the marker, so an over-budget fact lost its tail silently — the content was removed, discarded, gone." },
    b: { key: "edit_mode_shipped_2026_07_31", kind: "fact", created_at: daysAgo(14),
         value: "v0.55.3 SHIPPED (fee1de0, pushed): explicit edit mode for the summary redirect; whole-file bypasses learned per file+mtime." },
    sim: 0.72,
  },
  {
    name: "two run reports of different suites (e2e_result_MEMORY vs SECURITY)",
    a: { key: "e2e_result_MEMORY", kind: "fact", created_at: daysAgo(12),
         value: "E2E_MEMORY RESULT (developer) — 8 PASS / 0 FAIL. [PASS] zc_remember — Remembered under agent_id=developer." },
    b: { key: "e2e_result_SECURITY", kind: "fact", created_at: daysAgo(12),
         value: "E2E_SECURITY RESULT (developer) — 3 PASS / 0 FAIL. [PASS] zc_issue_token — token issued, prefix=zcst." },
    sim: 0.99,
  },
  {
    name: "a standing operator directive vs a later unrelated decision record",
    a: { key: "OPERATOR_DIRECTIVE_lean_stdlib", kind: "fact", created_at: daysAgo(12),
         value: "STANDING OPERATOR DIRECTIVE (applies to ALL future A2A tasks): make the project LEAN, use standard libraries everywhere possible, no bloat, remove dead code." },
    b: { key: "A2A_DECISION_hosting_vm_2026_08_12", kind: "fact", created_at: daysAgo(5),
         value: "HOSTING DECISION: kubernetes with a managed tier built as we go, without having to rewrite later. Single VM path dropped." },
    sim: 0.71,
  },
];

// ── The one genuine conflict from the same period ────────────────────────────
const GENUINE = {
  a: { key: "FINDING_STEP1_WITH_COOKIE_401_REGRESSION", kind: "hypothesis", created_at: daysAgo(6),
       resolution_status: "resolved_incorrect",
       value: "RESOLVED INCORRECT. There was NO regression. The 401 came from a HAND-CRAFTED TEST JWT missing tenant_id." },
  b: { key: "tenant_id_claim", kind: "fact", created_at: daysAgo(7),
       value: "A token with no tenant_id gets 'default' rather than being refused in hub/main.py:498." },
  sim: 0.72,
};

describe("autonomy precision corpus (2026-08 ground truth)", () => {
  for (const c of WRONG_CORPUS) {
    it(`does not flag: ${c.name}`, () => {
      expect(detectConflict(c.a, c.b, c.sim)).toBeNull();
    });
    it(`never produces a victim: ${c.name}`, () => {
      for (const reason of ["semantic_conflict", "numeric_conflict", "decision_reversal"]) {
        expect(autoResolveVictim(c.a, c.b, reason)).toBeNull();
      }
    });
  }

  it("the one genuine conflict still flags (falsified-vs-live)", () => {
    const r = detectConflict(GENUINE.a, GENUINE.b, GENUINE.sim);
    expect(r?.reason).toBe("resolution_conflict");
  });

  it("even the genuine conflict yields no automatic victim (falsified claims are a human call)", () => {
    expect(autoResolveVictim(GENUINE.a, GENUINE.b, "resolution_conflict")).toBeNull();
  });
});
