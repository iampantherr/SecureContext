// Verify claim_verify against REAL MERGE claims from today's A2A session, not
// fixtures. Fixtures would only prove the code agrees with my assumptions, which
// is the failure mode that cost seven bugs this session.
const { verifyClaim } = await import("file:///C:/Users/Amit/AI_projects/SecureContext/dist/claim_verify.js");
const REPO = "C:\\Users\\Amit\\AI_projects\\A2A_communication";

const cases = [
  {
    name: "REAL MERGE #3111 — developer's round-2 sweep (commit + real files)",
    claim: {
      commit: "7f92f59",
      files: ["a2a_control_plane/hub/modules/pg_adapter.py", "a2a_control_plane/hub/main.py"],
      summary: "Round 2 COMPLETE - all ACs 10-12 satisfied. 21/21 tests passing, no regressions.",
    },
  },
  {
    name: "REAL MERGE #3073 — SFR3 v1 (commit 5f6f666)",
    claim: {
      commit: "5f6f666",
      files: ["a2a_control_plane/hub/db_adapter.py"],
      summary: "GREEN fix for SF-R3 fail-fast. 13/13 unit tests GREEN. /health returns 503 in 3.3s.",
    },
  },
  {
    name: "FABRICATED commit — must be REFUTED, this is the point",
    claim: { commit: "deadbee", files: [], summary: "all tests pass" },
  },
  {
    name: "UNCOMMITTED file claim — the SF-1 defect that created the standing rule",
    claim: {
      commit: "HEAD",
      files: ["reports/qa/THIS_FILE_WAS_NEVER_COMMITTED.md"],
      summary: "close-out complete, evidence attached",
    },
  },
  {
    name: "claim with ONLY unverifiable assertions — must not read as a pass",
    claim: { summary: "All 42/42 acceptance checks green, no regressions, verified end to end." },
  },
];

let refutedCorrectly = 0, falsePositives = 0;
for (const { name, claim } of cases) {
  const v = verifyClaim(REPO, claim);
  console.log("─".repeat(78));
  console.log(name);
  console.log(`  ok=${v.ok}  verified=${v.verified}  refuted=${v.refuted}  unverifiable=${v.unverifiable}`);
  for (const c of v.checks) {
    console.log(`    [${c.status.toUpperCase().padEnd(12)}] ${c.assertion}`);
    if (c.status !== "verified") console.log(`                     ${c.detail.slice(0, 96)}`);
  }
  if (name.startsWith("FABRICATED") || name.startsWith("UNCOMMITTED")) {
    v.refuted > 0 ? refutedCorrectly++ : falsePositives++;
  }
  if (name.startsWith("REAL") && v.refuted > 0) falsePositives++;
}
console.log("─".repeat(78));
console.log(`bad claims correctly refuted: ${refutedCorrectly}/2`);
console.log(`false positives on real claims: ${falsePositives}`);
process.exit(refutedCorrectly === 2 && falsePositives === 0 ? 0 : 1);
