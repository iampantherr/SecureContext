import { describe, it, expect } from "vitest";
import { assessFailureSpecificity } from "./specificity.js";
import type { Skill, SkillRun } from "./types.js";

function skill(scope: string): Skill {
  return { frontmatter: { scope } } as unknown as Skill;
}

function run(project_hash: string, outcome_score: number | null, status = "succeeded"): SkillRun {
  return { project_hash, outcome_score, status } as unknown as SkillRun;
}

describe("v0.61.0 M3c — assessFailureSpecificity", () => {
  it("forks when failures concentrate in one project and the skill is healthy elsewhere", () => {
    const runs = [
      run("projA", 0.1, "failed"), run("projA", 0.2, "failed"), run("projA", null, "timeout"),
      run("projB", 0.9), run("projB", 0.85), run("projC", 0.8),
    ];
    const a = assessFailureSpecificity(skill("global"), runs);
    expect(a.fork).toBe(true);
    expect(a.project_hash).toBe("projA");
  });

  it("does not fork when the skill fails everywhere (broad fix is right)", () => {
    const runs = [
      run("projA", 0.1, "failed"), run("projA", 0.2, "failed"), run("projA", 0.1, "failed"),
      run("projB", 0.3), run("projB", 0.2), run("projC", 0.4),
    ];
    expect(assessFailureSpecificity(skill("global"), runs).fork).toBe(false);
  });

  it("does not fork when failures spread across projects", () => {
    const runs = [
      run("projA", 0.1, "failed"), run("projB", 0.2, "failed"), run("projC", 0.1, "failed"),
      run("projD", 0.9), run("projD", 0.9), run("projD", 0.9),
    ];
    expect(assessFailureSpecificity(skill("global"), runs).fork).toBe(false);
  });

  it("never forks a project-scoped skill", () => {
    const runs = [
      run("projA", 0.1, "failed"), run("projA", 0.1, "failed"), run("projA", 0.1, "failed"),
      run("projB", 0.9), run("projB", 0.9), run("projB", 0.9),
    ];
    expect(assessFailureSpecificity(skill("project:projA"), runs).fork).toBe(false);
  });

  it("requires evidence of health elsewhere (no attributed runs outside → no fork)", () => {
    const runs = [run("projA", 0.1, "failed"), run("projA", 0.1, "failed"), run("projA", 0.1, "failed")];
    expect(assessFailureSpecificity(skill("global"), runs).fork).toBe(false);
  });
});
