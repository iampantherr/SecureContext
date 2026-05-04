/**
 * Lint unit tests (v0.23.0 Phase 1 #4)
 * =====================================
 *
 * Each test exercises ONE rule in isolation against a hand-crafted fixture.
 * Naming convention: rule_<N>_<scenario> so the failing rule is obvious.
 */

import { describe, it, expect } from "vitest";
import { lintSkillBody, formatLintResult } from "./lint.js";
import type { SkillFrontmatter } from "./types.js";

const VALID_FRONTMATTER: SkillFrontmatter = {
  name: "valid-skill",
  version: "1.0.0",
  scope: "global",
  description: "A test skill that does something useful and has a long-enough description.",
};

const VALID_BODY = `# Some Skill

This skill demonstrates a complete procedure.

## Examples

- Example 1: do thing A
- Example 2: do thing B

## Guidelines

- Always X
- Never Y
`;

describe("lintSkillBody", () => {
  describe("rule 1: description length", () => {
    it("rejects descriptions under 30 chars", () => {
      const fm = { ...VALID_FRONTMATTER, description: "too short" };
      const r = lintSkillBody(VALID_BODY, fm);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("description too short"))).toBe(true);
    });

    it("rejects empty descriptions", () => {
      const fm = { ...VALID_FRONTMATTER, description: "" };
      const r = lintSkillBody(VALID_BODY, fm);
      expect(r.ok).toBe(false);
    });

    it("accepts descriptions ≥30 chars", () => {
      const fm = { ...VALID_FRONTMATTER, description: "This is exactly thirty chars!!" };
      expect(fm.description.length).toBeGreaterThanOrEqual(30);
      const r = lintSkillBody(VALID_BODY, fm);
      expect(r.errors.length).toBe(0);
    });
  });

  describe("rule 2: all-caps description", () => {
    it("warns on shouty descriptions", () => {
      const fm = { ...VALID_FRONTMATTER, description: "USES SHOUTING TO DESCRIBE A SKILL HERE" };
      const r = lintSkillBody(VALID_BODY, fm);
      expect(r.ok).toBe(true); // warning, not error
      expect(r.warnings.some((w) => w.includes("all-caps"))).toBe(true);
    });
  });

  describe("rule 3: name format", () => {
    it("rejects names with underscores", () => {
      const fm = { ...VALID_FRONTMATTER, name: "bad_name" };
      const r = lintSkillBody(VALID_BODY, fm);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("agentskills.io spec"))).toBe(true);
    });

    it("rejects names with leading hyphen", () => {
      const fm = { ...VALID_FRONTMATTER, name: "-bad" };
      const r = lintSkillBody(VALID_BODY, fm);
      expect(r.ok).toBe(false);
    });

    it("rejects uppercase names", () => {
      const fm = { ...VALID_FRONTMATTER, name: "BadName" };
      const r = lintSkillBody(VALID_BODY, fm);
      expect(r.ok).toBe(false);
    });

    it("accepts valid lowercase-hyphen names", () => {
      const fm = { ...VALID_FRONTMATTER, name: "valid-name-123" };
      const r = lintSkillBody(VALID_BODY, fm);
      expect(r.errors.length).toBe(0);
    });
  });

  describe("rule 4: ## Examples section", () => {
    it("warns when body has no ## Examples", () => {
      const body = `# Skill\n\nNo examples section here.\n\n## Guidelines\n\n- Be careful\n`;
      const r = lintSkillBody(body + " ".repeat(100), VALID_FRONTMATTER);
      expect(r.warnings.some((w) => w.includes("Examples"))).toBe(true);
    });

    it("accepts ## Example (singular) too", () => {
      const body = `# Skill\n\n${" ".repeat(100)}\n\n## Example\n\n- One example\n\n## Guidelines\n\n- Rule 1\n`;
      const r = lintSkillBody(body, VALID_FRONTMATTER);
      expect(r.warnings.some((w) => w.includes("Examples"))).toBe(false);
    });
  });

  describe("rule 5: ## Guidelines section", () => {
    it("warns when body has no constraints section", () => {
      const body = `# Skill\n\nNo constraints.\n\n## Examples\n\n- Eg 1\n${" ".repeat(100)}`;
      const r = lintSkillBody(body, VALID_FRONTMATTER);
      expect(r.warnings.some((w) => w.includes("Guidelines"))).toBe(true);
    });

    it("accepts ## Constraints alternative", () => {
      const body = `# Skill\n\n${" ".repeat(100)}\n\n## Examples\n- E\n\n## Constraints\n- C\n`;
      const r = lintSkillBody(body, VALID_FRONTMATTER);
      expect(r.warnings.some((w) => w.includes("Guidelines"))).toBe(false);
    });
  });

  describe("rule 6: body length", () => {
    it("rejects bodies under 100 chars", () => {
      const r = lintSkillBody("# Tiny", VALID_FRONTMATTER);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("too short"))).toBe(true);
    });

    it("rejects bodies over 16000 chars", () => {
      const huge = `# Skill\n${" ".repeat(20000)}\n## Examples\n- e\n## Guidelines\n- g\n`;
      const r = lintSkillBody(huge, VALID_FRONTMATTER);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("too long"))).toBe(true);
    });

    it("warns on bodies in 8001-16000 range", () => {
      const big = `# Skill\n${" ".repeat(9000)}\n## Examples\n- e\n## Guidelines\n- g\n`;
      const r = lintSkillBody(big, VALID_FRONTMATTER);
      expect(r.ok).toBe(true);
      expect(r.warnings.some((w) => w.includes("body is long"))).toBe(true);
    });
  });

  describe("rule 7: secret-pattern detection", () => {
    it("rejects bodies containing what looks like an OpenAI key", () => {
      const body = VALID_BODY + "\nDEBUG: sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
      const r = lintSkillBody(body, VALID_FRONTMATTER);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("credential"))).toBe(true);
    });

    it("rejects bodies containing AWS access key", () => {
      const body = VALID_BODY + "\nAKIAIOSFODNN7EXAMPLE\n";
      const r = lintSkillBody(body, VALID_FRONTMATTER);
      expect(r.ok).toBe(false);
    });

    it("does NOT false-positive on innocuous keyword 'key'", () => {
      const body = VALID_BODY + "\nThe API key should be stored in env vars.\n";
      const r = lintSkillBody(body, VALID_FRONTMATTER);
      expect(r.errors.length).toBe(0);
    });
  });

  describe("rule 8: intended_roles empty array", () => {
    it("warns on empty array", () => {
      const fm = { ...VALID_FRONTMATTER, intended_roles: [] };
      const r = lintSkillBody(VALID_BODY, fm);
      expect(r.warnings.some((w) => w.includes("intended_roles"))).toBe(true);
    });

    it("accepts non-empty array", () => {
      const fm = { ...VALID_FRONTMATTER, intended_roles: ["developer"] };
      const r = lintSkillBody(VALID_BODY, fm);
      expect(r.warnings.some((w) => w.includes("intended_roles"))).toBe(false);
    });

    it("accepts undefined (field absent)", () => {
      const r = lintSkillBody(VALID_BODY, VALID_FRONTMATTER);
      expect(r.warnings.some((w) => w.includes("intended_roles"))).toBe(false);
    });
  });

  describe("rule 9: requires_network without allowlist", () => {
    it("rejects requires_network=true with empty allowlist", () => {
      const fm = { ...VALID_FRONTMATTER, requires_network: true, network_allowlist: [] };
      const r = lintSkillBody(VALID_BODY, fm);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("network_allowlist"))).toBe(true);
    });

    it("accepts requires_network=true with non-empty allowlist", () => {
      const fm = { ...VALID_FRONTMATTER, requires_network: true, network_allowlist: ["https://api.example.com/"] };
      const r = lintSkillBody(VALID_BODY, fm);
      expect(r.ok).toBe(true);
    });

    it("ignores allowlist if requires_network is false/absent", () => {
      const fm = { ...VALID_FRONTMATTER, network_allowlist: [] };
      const r = lintSkillBody(VALID_BODY, fm);
      expect(r.ok).toBe(true);
    });
  });

  describe("integration", () => {
    it("a fully valid skill returns ok=true with no warnings or errors", () => {
      const r = lintSkillBody(VALID_BODY, VALID_FRONTMATTER);
      expect(r.ok).toBe(true);
      expect(r.errors.length).toBe(0);
      expect(r.warnings.length).toBe(0);
    });

    it("multiple errors are surfaced together (not just the first)", () => {
      const fm = { ...VALID_FRONTMATTER, name: "Bad_Name", description: "short" };
      const r = lintSkillBody("# tiny", fm);
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThanOrEqual(3);
    });
  });
});

describe("formatLintResult", () => {
  it("returns empty string when no errors or warnings", () => {
    expect(formatLintResult({ ok: true, errors: [], warnings: [] }, "test-skill")).toBe("");
  });

  it("includes both errors and warnings sections", () => {
    const r = formatLintResult(
      { ok: false, errors: ["err1", "err2"], warnings: ["warn1"] },
      "test-skill",
    );
    expect(r).toContain("test-skill");
    expect(r).toContain("ERRORS");
    expect(r).toContain("err1");
    expect(r).toContain("WARNINGS");
    expect(r).toContain("warn1");
  });
});
