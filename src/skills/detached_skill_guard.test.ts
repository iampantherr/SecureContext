/**
 * The orphan guard (v0.55.0).
 *
 * upsertSkillPg's INSERT has no skill_dir column, so every row it wrote had
 * skill_dir NULL — an orphan by construction. 28 accumulated before anyone
 * looked, and the operator dashboard listed them beside real skills. Approving a
 * mutation minted another one every time.
 *
 * These assert the guard REFUSES rather than warns, because a warning in a
 * background write path is the same as no guard at all.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DetachedSkillError } from "./storage_pg.js";

const ORIGINAL = process.env.ZC_ALLOW_DETACHED_SKILLS;
beforeEach(() => { delete process.env.ZC_ALLOW_DETACHED_SKILLS; });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ZC_ALLOW_DETACHED_SKILLS;
  else process.env.ZC_ALLOW_DETACHED_SKILLS = ORIGINAL;
});

describe("DetachedSkillError", () => {
  it("names the skill and states the rule", () => {
    const e = new DetachedSkillError("ghost@1.0.0@global");
    expect(e.message).toContain("ghost@1.0.0@global");
    expect(e.message).toContain("~/.claude/skills");
    expect(e.name).toBe("DetachedSkillError");
  });

  it("tells the caller how to override deliberately", () => {
    // An escape hatch nobody can find is a guard people work around by disabling
    // the feature instead.
    expect(new DetachedSkillError("x").message).toContain("ZC_ALLOW_DETACHED_SKILLS=1");
  });

  it("explains the consequence, not just the rule", () => {
    // "Refused" without "why it matters" gets pattern-matched into an override.
    const msg = new DetachedSkillError("x").message;
    expect(msg).toMatch(/HMAC|verif/i);
  });
});

describe("upsertSkillPg provenance check", () => {
  // Exercised without a live PG connection: the guard must run BEFORE any
  // network call, so a detached write fails fast rather than half-writing.
  const skill = (extra: Record<string, unknown> = {}) => ({
    skill_id: "t@1.0.0@global",
    body: "b",
    body_hmac: "deadbeef",
    frontmatter: { name: "t", version: "1.0.0", scope: "global", description: "d" },
    ...extra,
  }) as never;

  it("rejects a skill with neither skill_dir nor source_path", async () => {
    const { upsertSkillPg } = await import("./storage_pg.js");
    await expect(upsertSkillPg(skill())).rejects.toThrow(DetachedSkillError);
  });

  it("accepts a skill that names its file", async () => {
    const { upsertSkillPg } = await import("./storage_pg.js");
    // Gets past the provenance check, then fails later on HMAC/connection —
    // which is exactly the point: provenance is no longer what stops it.
    await expect(upsertSkillPg(skill({ skill_dir: "/home/u/.claude/skills/t" })))
      .rejects.not.toThrow(DetachedSkillError);
  });

  it("accepts source_path as provenance too", async () => {
    const { upsertSkillPg } = await import("./storage_pg.js");
    await expect(upsertSkillPg(skill({ source_path: "/home/u/.claude/skills/t/SKILL.md" })))
      .rejects.not.toThrow(DetachedSkillError);
  });

  it("honours the explicit opt-out", async () => {
    process.env.ZC_ALLOW_DETACHED_SKILLS = "1";
    const { upsertSkillPg } = await import("./storage_pg.js");
    await expect(upsertSkillPg(skill())).rejects.not.toThrow(DetachedSkillError);
  });

  it("treats an empty-string skill_dir as no provenance", async () => {
    // "" is falsy but easy to pass by accident from a NULL column read.
    const { upsertSkillPg } = await import("./storage_pg.js");
    await expect(upsertSkillPg(skill({ skill_dir: "" }))).rejects.toThrow(DetachedSkillError);
  });
});
