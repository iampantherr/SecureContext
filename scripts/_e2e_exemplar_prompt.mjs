// v0.23.0 Phase 1 F — verify exemplars flow into the proposer prompt
import { getExemplarRuns } from "/app/dist/skills/storage_dual.js";
import { buildProposerPrompt } from "/app/dist/skills/mutator.js";
import { buildSkill } from "/app/dist/skills/loader.js";

const skillId = "developer-skill-execution-outcome-reporting-v0-18-1@1@global";

console.log("=== Step 1: getExemplarRuns ===");
const exemplars = await getExemplarRuns(skillId, 5);
console.log(`Found ${exemplars.length} exemplar(s) for ${skillId}`);
for (const e of exemplars) {
  console.log(`  - run_id=${e.run_id} note="${e.note ?? "(none)"}"`);
}

console.log("\n=== Step 2: Build proposer prompt with exemplars ===");
const parent = await buildSkill(
  {
    name: "phase1-prompt-test", version: "1.0.0", scope: "global",
    description: "A test skill for verifying the exemplar section in the proposer prompt",
  },
  "# Goal\n## Steps\n1. Do the thing\n## Examples\n- example 1\n## Guidelines\n- be careful\n",
);

const prompt = buildProposerPrompt({
  parent,
  recent_runs:    [],
  failure_traces: ["test failure 1"],
  fixtures:       [],
  exemplars,
});

const hasExemplarSection = prompt.includes("## Operator-tagged exemplars");
console.log(`Prompt includes exemplar section: ${hasExemplarSection}`);
if (hasExemplarSection) {
  const start = prompt.indexOf("## Operator-tagged exemplars");
  const end = prompt.indexOf("##", start + 30);
  console.log("Exemplar section excerpt:");
  console.log(prompt.slice(start, end !== -1 ? end : start + 600));
}

console.log("\n=== Step 3: Build proposer prompt WITHOUT exemplars ===");
const promptNoEx = buildProposerPrompt({
  parent,
  recent_runs:    [],
  failure_traces: [],
  fixtures:       [],
});
const hasNoExSection = promptNoEx.includes("## Operator-tagged exemplars");
console.log(`Prompt without exemplars omits exemplar section: ${!hasNoExSection}`);

console.log(`\nResult: ${hasExemplarSection && !hasNoExSection ? "PASS" : "FAIL"}`);
process.exit(hasExemplarSection && !hasNoExSection ? 0 : 1);
