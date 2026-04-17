// Quick live test of the summarizer against the running Ollama instance.
// Run: node scripts/test-summarizer-live.mjs
import { readFileSync } from "node:fs";
import { summarizeFile, selectSummaryModel } from "../dist/summarizer.js";

console.log("\n=== SUMMARIZER LIVE TEST ===\n");

const model = await selectSummaryModel();
console.log(`Selected model: ${model ?? "(none — will use truncation fallback)"}\n`);

const testFiles = [
  "src/summarizer.ts",
  "src/harness.ts",
  "src/config.ts",
];

for (const path of testFiles) {
  const content = readFileSync(path, "utf8");
  console.log(`--- Summarizing ${path} (${content.length} chars) ---`);
  const t0 = Date.now();
  const sum = await summarizeFile(path, content);
  const dt = Date.now() - t0;
  console.log(`  source: ${sum.source}${sum.modelUsed ? ` (${sum.modelUsed})` : ""} | elapsed: ${dt}ms | injection: ${sum.injectionDetected ?? false}`);
  console.log(`  L0 (${sum.l0.length} chars): ${sum.l0}`);
  console.log(`  L1 (${sum.l1.length} chars):\n    ${sum.l1.split("\n").join("\n    ")}`);
  console.log();
}

console.log("=== DONE ===\n");
