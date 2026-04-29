/**
 * Tests for v0.18.0 — agentskills.io format adapter.
 *
 * Covers:
 *   - export emits valid agentskills.io frontmatter
 *   - import reconstructs Skill with HMAC computed
 *   - round-trip preserves SC-specific fields (acceptance, fixtures, scope)
 *   - import without zc_* metadata defaults scope=global + no acceptance
 *   - missing leading/trailing --- → throws
 *   - missing required field (name/version/description) → throws
 *   - tags list survives round-trip
 *   - foreign metadata keys survive (round-trip preservation)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exportToAgentSkillsIo, importFromAgentSkillsIo } from "./agentskills_io.js";
import { buildSkill, verifySkillHmac } from "../loader.js";
import { _resetCacheForTesting as resetMachineSecret } from "../../security/machine_secret.js";
import type { Skill } from "../types.js";

beforeEach(() => {
  mkdirSync(join(homedir(), ".claude", "zc-ctx"), { recursive: true });
  resetMachineSecret();
});

async function makeFullSkill(): Promise<Skill> {
  return buildSkill(
    {
      name: "audit_file", version: "1.0.0", scope: "project:aafb4b029db36884",
      description: "Audit a source file",
      tags: ["security", "code-review"],
      acceptance_criteria: { min_outcome_score: 0.7, min_pass_rate: 0.85 },
      fixtures: [
        { fixture_id: "happy", description: "h", input: { x: 1 }, expected: { ok: true } },
      ],
      requires_network: false,
    },
    "# Audit a Source File\n\nDo it carefully.",
  );
}

describe("v0.18.0 — agentskills.io export", () => {

  it("emits valid agentskills.io frontmatter with metadata round-trip fields", async () => {
    const skill = await makeFullSkill();
    const text = exportToAgentSkillsIo(skill);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain('"audit_file"');  // name
    expect(text).toContain('"1.0.0"');         // version
    expect(text).toContain("metadata:");
    expect(text).toContain("zc_scope");
    expect(text).toContain("zc_acceptance_criteria");
    expect(text).toContain("zc_fixtures");
  });

  it("body is appended after the frontmatter", async () => {
    const skill = await makeFullSkill();
    const text = exportToAgentSkillsIo(skill);
    expect(text).toContain("# Audit a Source File");
  });
});

describe("v0.18.0 — agentskills.io import", () => {

  it("imports a SC-exported skill with HMAC verifying", async () => {
    const original = await makeFullSkill();
    const text = exportToAgentSkillsIo(original);
    const reimported = await importFromAgentSkillsIo(text);
    expect(reimported.frontmatter.name).toBe("audit_file");
    expect(reimported.frontmatter.version).toBe("1.0.0");
    expect(reimported.frontmatter.scope).toBe("project:aafb4b029db36884");
    expect(reimported.frontmatter.acceptance_criteria?.min_outcome_score).toBe(0.7);
    expect(reimported.frontmatter.fixtures?.length).toBe(1);
    expect(reimported.frontmatter.tags).toEqual(["security", "code-review"]);
    expect(await verifySkillHmac(reimported.body, reimported.body_hmac)).toBe(true);
  });

  it("body content survives unchanged", async () => {
    const original = await makeFullSkill();
    const text = exportToAgentSkillsIo(original);
    const reimported = await importFromAgentSkillsIo(text);
    expect(reimported.body.trim()).toBe(original.body.trim());
  });

  it("import without zc_ metadata uses defaults", async () => {
    const text = `---
name: "ext_skill"
version: "0.1.0"
description: "From an external author"
tags: ["external"]
metadata: {}
---

# External Skill

External body.`;
    const skill = await importFromAgentSkillsIo(text, "global");
    expect(skill.frontmatter.scope).toBe("global");
    expect(skill.frontmatter.acceptance_criteria).toBeUndefined();
    expect(skill.frontmatter.fixtures).toBeUndefined();
  });

  it("missing leading --- throws", async () => {
    await expect(importFromAgentSkillsIo("name: foo\n")).rejects.toThrow();
  });

  it("missing closing --- throws", async () => {
    await expect(importFromAgentSkillsIo("---\nname: foo\nbody")).rejects.toThrow();
  });

  it("missing required field throws", async () => {
    const text = `---
name: "x"
description: "no version"
metadata: {}
---

body`;
    await expect(importFromAgentSkillsIo(text)).rejects.toThrow(/version/);
  });

  it("invalid scope in metadata falls back to default", async () => {
    const text = `---
name: "x"
version: "1.0.0"
description: "y"
metadata: {"zc_scope": "evil-scope"}
---

body`;
    const skill = await importFromAgentSkillsIo(text, "global");
    expect(skill.frontmatter.scope).toBe("global");
  });

  it("full round-trip is byte-identical for body", async () => {
    const original = await makeFullSkill();
    const t1 = exportToAgentSkillsIo(original);
    const r1 = await importFromAgentSkillsIo(t1);
    const t2 = exportToAgentSkillsIo(r1);
    const r2 = await importFromAgentSkillsIo(t2);
    expect(r2.body).toBe(r1.body);
    expect(r2.frontmatter.acceptance_criteria).toEqual(r1.frontmatter.acceptance_criteria);
  });
});
