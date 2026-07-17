/**
 * S10 (v0.46.0) — unit tests for the compliance markdown renderer (pure).
 * The chain-verification math itself is covered by replay.test.ts; the live
 * E2E covers the SQL aggregation.
 */
import { describe, it, expect } from "vitest";
import { renderComplianceMarkdown, type ComplianceReport } from "./compliance.js";

const BASE: ComplianceReport = {
  project: "36608e2913b5dc42",
  windowDays: 30,
  generatedAt: "2026-07-17T06:00:00.000Z",
  auditChain: {
    totalRows: 328, windowRows: 120, verified: 260, unsigned: 10,
    hashMismatches: 58, linkBreaks: 0, chainOk: false,
    keysTried: ["container", "host"], firstBrokenId: 4244,
  },
  agents: [
    { agent_id: "orchestrator", calls: 40, failures: 0, first_seen: "2026-07-01T00:00:00.000Z", last_seen: "2026-07-17T00:00:00.000Z" },
    { agent_id: "developer", calls: 22, failures: 1, first_seen: "2026-07-02T00:00:00.000Z", last_seen: "2026-07-16T00:00:00.000Z" },
  ],
  sessions: 9,
  skillSecurity: { admissionEvents: 5, quarantines: 1 },
  memory: { liveFacts: 152, writtenInWindow: 33, byUser: { amit: 2, teammate: 2, ci: 1 } },
};

describe("renderComplianceMarkdown", () => {
  it("flags issues when the chain has mismatches, with the first broken id", () => {
    const md = renderComplianceMarkdown(BASE, "ZZ_MATURE");
    expect(md).toContain("⚠️ ISSUES FOUND");
    expect(md).toContain("ZZ_MATURE (36608e2913b5dc42)");
    expect(md).toContain("| First non-verifying row id | 4244 |");
    expect(md).toContain("| Hash mismatches (modified or unknown key) | 58 |");
    expect(md).toContain("container, host");
  });

  it("reports INTACT when clean and omits the first-broken row", () => {
    const clean: ComplianceReport = {
      ...BASE,
      auditChain: { ...BASE.auditChain, hashMismatches: 0, linkBreaks: 0, chainOk: true, firstBrokenId: null, verified: 318 },
    };
    const md = renderComplianceMarkdown(clean, null);
    expect(md).toContain("✅ INTACT");
    expect(md).not.toContain("First non-verifying row id");
    expect(md).toContain("- **Project:** 36608e2913b5dc42");
  });

  it("renders agents, sessions, skill security, and attribution", () => {
    const md = renderComplianceMarkdown(BASE);
    expect(md).toContain("| orchestrator | 40 | 0 |");
    expect(md).toContain("Sessions in window: **9**");
    expect(md).toContain("Quarantines: **1**");
    expect(md).toContain("**amit** (2)");
    expect(md).toContain("**ci** (1)");
  });

  it("handles an empty window gracefully", () => {
    const empty: ComplianceReport = {
      ...BASE, agents: [], sessions: 0,
      memory: { liveFacts: 0, writtenInWindow: 0, byUser: {} },
    };
    const md = renderComplianceMarkdown(empty);
    expect(md).toContain("_No tool calls recorded in the window._");
    expect(md).not.toContain("Attributed writers");
  });
});
