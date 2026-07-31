/**
 * Tests for writing an approved skill change back to the FILE (v0.55.0).
 *
 * The bug these exist for: mutation approval called upsertSkill(), which writes
 * a Postgres row and never sets skill_dir. The operator approved a change and
 * SKILL.md never moved — and since the PreToolUse runner verifies the file
 * against the admission HMAC, a Postgres-only change was invisible to it.
 *
 * The edge cases below are the ones that turn a good feature into a broken
 * skill: a half-written file quarantines the skill, and a lost frontmatter key
 * silently changes what the skill claims to be.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSkillMd, writeSkillBody } from "./skill_file_writer.js";

let dir: string;

const SKILL_MD =
  "---\n" +
  "name: sample-skill\n" +
  "description: A sample skill for tests\n" +
  "version: 1.0.0\n" +
  "intended_roles: [developer, qa]\n" +
  "# a hand-written comment\n" +
  "custom_key: keep-me\n" +
  "---\n" +
  "# Sample\n\nOriginal body text.\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zc-skillw-"));
  writeFileSync(join(dir, "SKILL.md"), SKILL_MD, "utf8");
});
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ } });

const read = () => readFileSync(join(dir, "SKILL.md"), "utf8");

describe("writeSkillBody", () => {
  it("replaces the body and leaves the frontmatter untouched", () => {
    writeSkillBody(dir, "# New\n\nRewritten by the mutator.\n");
    const out = read();
    expect(out).toContain("Rewritten by the mutator.");
    expect(out).not.toContain("Original body text.");
    // Every frontmatter key survives, including the comment and unknown keys —
    // an approval must not quietly rewrite what the skill declares itself to be.
    expect(out).toContain("name: sample-skill");
    expect(out).toContain("intended_roles: [developer, qa]");
    expect(out).toContain("# a hand-written comment");
    expect(out).toContain("custom_key: keep-me");
  });

  it("bumps only the version when asked", () => {
    writeSkillBody(dir, "body\n", { version: "1.0.1" });
    expect(read()).toContain("version: 1.0.1");
    expect(read()).not.toContain("version: 1.0.0");
    expect(read()).toContain("custom_key: keep-me");
  });

  it("adds a version key when the file had none", () => {
    writeFileSync(join(dir, "SKILL.md"), "---\nname: x\ndescription: y\n---\nbody\n", "utf8");
    writeSkillBody(dir, "new body\n", { version: "2.0.0" });
    expect(read()).toContain("version: 2.0.0");
  });

  it("keeps a backup so an operator can undo the approval by hand", () => {
    const res = writeSkillBody(dir, "replaced\n", { stamp: "TEST" });
    expect(existsSync(res.backupPath)).toBe(true);
    expect(readFileSync(res.backupPath, "utf8")).toContain("Original body text.");
  });

  it("leaves no temp file behind (a stray .tmp would be admitted as a skill file)", () => {
    writeSkillBody(dir, "replaced\n", { stamp: "TEST" });
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("still produces a parseable file when the body contains frontmatter delimiters", () => {
    // A mutator suggesting an example that itself contains '---' must not be
    // able to corrupt the file's structure.
    writeSkillBody(dir, "Example:\n\n---\nname: not-real\n---\n\nend\n");
    const out = read();
    // Exactly one frontmatter block: content before the FIRST closing delimiter
    // must still be the real frontmatter.
    const firstClose = out.indexOf("\n---\n", 4);
    expect(out.slice(4, firstClose)).toContain("name: sample-skill");
  });

  describe("refuses rather than inventing a file", () => {
    it("throws on an empty skill_dir — the orphan case", () => {
      expect(() => writeSkillBody("", "b")).toThrow(/skill_dir is empty/);
    });

    it("throws when SKILL.md does not exist", () => {
      const empty = mkdtempSync(join(tmpdir(), "zc-skillw-none-"));
      try {
        expect(() => writeSkillBody(empty, "b")).toThrow(/does not exist/);
      } finally { rmSync(empty, { recursive: true, force: true }); }
    });

    it("throws when the file has no frontmatter, without damaging it", () => {
      writeFileSync(join(dir, "SKILL.md"), "no frontmatter here\n", "utf8");
      expect(() => writeSkillBody(dir, "b")).toThrow(/no frontmatter delimiter/);
      expect(read()).toBe("no frontmatter here\n");   // untouched
    });

    it("throws when the closing delimiter is missing, without damaging it", () => {
      const broken = "---\nname: x\ndescription: y\nbody with no close\n";
      writeFileSync(join(dir, "SKILL.md"), broken, "utf8");
      expect(() => writeSkillBody(dir, "b")).toThrow(/no closing frontmatter delimiter/);
      expect(read()).toBe(broken);
    });
  });

  it("handles CRLF files without doubling line endings", () => {
    writeFileSync(join(dir, "SKILL.md"), SKILL_MD.replace(/\n/g, "\r\n"), "utf8");
    writeSkillBody(dir, "clean body\n");
    expect(read()).not.toContain("\r\n\r\n---");
    expect(read()).toContain("clean body");
  });
});

describe("serializeSkillMd", () => {
  it("emits the exact shape the parser expects", () => {
    const out = serializeSkillMd({ name: "a", description: "b" }, "body\n");
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("\n---\nbody");
  });

  it("uses a block scalar for multi-line values instead of truncating them", () => {
    const out = serializeSkillMd({ name: "a", description: "line1\nline2" }, "b");
    expect(out).toContain("description: |");
    expect(out).toContain("  line1");
    expect(out).toContain("  line2");
  });

  it("serializes arrays and objects rather than emitting [object Object]", () => {
    const out = serializeSkillMd({ name: "a", roles: ["dev", "qa"], meta: { x: 1 } }, "b");
    expect(out).toContain('roles: ["dev", "qa"]');
    expect(out).toContain('meta: {"x":1}');
    expect(out).not.toContain("[object Object]");
  });

  it("skips null and undefined keys", () => {
    const out = serializeSkillMd({ name: "a", gone: null, alsoGone: undefined }, "b");
    expect(out).not.toContain("gone:");
  });
});

describe("round-trip through the ADMISSION parser", () => {
  // The one that matters: if a written file does not parse, re-admission
  // quarantines the skill and the runner blocks every script in it. A green
  // unit test on the writer alone would not catch that.
  it("a file written by writeSkillBody parses cleanly", async () => {
    const { parseFsSkill } = await import("./filesystem_skill_import.js");
    writeSkillBody(dir, "# Rewritten\n\nNew guidance here.\n", { version: "1.0.1" });
    const parsed = await parseFsSkill(dir);
    expect(parsed.parse_error).toBeNull();
    expect(parsed.fm.name).toBe("sample-skill");
    expect(parsed.fm.version).toBe("1.0.1");
    expect(parsed.body).toContain("New guidance here.");
  });

  it("survives a body containing frontmatter delimiters", async () => {
    const { parseFsSkill } = await import("./filesystem_skill_import.js");
    writeSkillBody(dir, "Example:\n\n---\nname: decoy\n---\n\ndone\n");
    const parsed = await parseFsSkill(dir);
    expect(parsed.parse_error).toBeNull();
    expect(parsed.fm.name).toBe("sample-skill");   // NOT "decoy"
  });

  it("survives a body with unicode and long lines", async () => {
    const { parseFsSkill } = await import("./filesystem_skill_import.js");
    writeSkillBody(dir, "Ünïcödé ✅ — em-dash, ‘quotes’\n" + "x".repeat(5000) + "\n");
    const parsed = await parseFsSkill(dir);
    expect(parsed.parse_error).toBeNull();
    expect(parsed.body).toContain("Ünïcödé");
  });

  it("an empty body still parses (the mutator may strip guidance)", async () => {
    const { parseFsSkill } = await import("./filesystem_skill_import.js");
    writeSkillBody(dir, "");
    const parsed = await parseFsSkill(dir);
    expect(parsed.parse_error).toBeNull();
    expect(parsed.fm.name).toBe("sample-skill");
  });
});
