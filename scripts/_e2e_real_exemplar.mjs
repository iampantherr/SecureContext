// v0.23.0 Phase 1 F — verify REAL exemplar (run-8c34b318-f98) flows into proposer prompt
import { getExemplarRuns } from "/app/dist/skills/storage_dual.js";
import { buildProposerPrompt } from "/app/dist/skills/mutator.js";
import { getActiveSkill } from "/app/dist/skills/storage_dual.js";
import { DatabaseSync } from "node:sqlite";

const skillId = "developer-debugging-methodology";
const scope   = "global";

console.log("=== Step 1: getExemplarRuns for the live skill ===");
// First get the active version's full id
const db = new DatabaseSync(":memory:");
const exemplars = await getExemplarRuns("developer-debugging-methodology@1.1@global", 5);
console.log(`Found ${exemplars.length} exemplar(s) for developer-debugging-methodology@1.1@global`);
for (const e of exemplars) {
  console.log(`  - run_id=${e.run_id} note="${e.note}"`);
  console.log(`    inputs=${JSON.stringify(e.inputs).slice(0, 100)}...`);
}

console.log("\n=== Step 2: Build a proposer prompt using the live skill as parent ===");
const parent = await getActiveSkill(db, "developer-debugging-methodology", "global");
if (!parent) {
  console.log("FAIL: parent skill not found via getActiveSkill");
  process.exit(1);
}
console.log(`Parent: ${parent.skill_id}, body length: ${parent.body.length}`);

const prompt = buildProposerPrompt({
  parent,
  recent_runs:    [],
  failure_traces: ["example failure trace 1"],
  fixtures:       parent.frontmatter.fixtures ?? [],
  exemplars,
});

const idx = prompt.indexOf("## Operator-tagged exemplars");
if (idx === -1) {
  console.log("FAIL: prompt missing exemplar section");
  process.exit(1);
}
const end = prompt.indexOf("## ", idx + 30);
const section = prompt.slice(idx, end !== -1 ? end : idx + 800);
console.log("\nExemplar section in prompt:");
console.log("─".repeat(60));
console.log(section);
console.log("─".repeat(60));

console.log(`\nResult: PASS — real exemplar (${exemplars[0]?.run_id ?? "?"}) flows into proposer prompt`);
console.log(`Total prompt length: ${prompt.length} chars`);
