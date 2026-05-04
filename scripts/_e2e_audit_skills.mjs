// Re-run lint on every shipped skill to identify which one was rejected
import { lintSkillBody, formatLintResult } from "/app/dist/skills/lint.js";
import { scanSkillBody } from "/app/dist/skills/security_scan.js";
import { loadSkillFromPath } from "/app/dist/skills/loader.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const skillsDir = "/app/skills";
const files = readdirSync(skillsDir)
  .filter((f) => f.endsWith(".skill.md"))
  .map((f) => join(skillsDir, f));

let lintFails = 0, scanFails = 0, ok = 0;
for (const f of files) {
  let skill;
  try { skill = await loadSkillFromPath(f, { skipLint: true }); }
  catch (e) {
    console.log(`[LOAD-FAIL] ${f}: ${e.message.slice(0, 80)}`);
    continue;
  }
  if (!skill) continue;

  const lint = lintSkillBody(skill.body, skill.frontmatter);
  if (!lint.ok) {
    lintFails++;
    console.log(`[LINT-FAIL] ${skill.skill_id}: ${lint.errors.join("; ").slice(0, 200)}`);
    continue;
  }

  const scan = await scanSkillBody(skill);
  const blockFails = scan.checks.filter((c) => !c.passed && c.severity === "block");
  if (blockFails.length > 0) {
    scanFails++;
    console.log(`[SCAN-BLOCK] ${skill.skill_id}: ${blockFails.map((c) => c.name).join(", ")}`);
    continue;
  }
  if (scan.score <= 6) {
    scanFails++;
    console.log(`[SCAN-LOW] ${skill.skill_id}: score ${scan.score}/8`);
    continue;
  }
  ok++;
}
console.log(`\nTotals: ${ok} OK, ${lintFails} lint-fails, ${scanFails} scan-rejects (out of ${files.length})`);
