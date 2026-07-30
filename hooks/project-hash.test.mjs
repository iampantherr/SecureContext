// The hook family keeps its own copy of projectHash so hooks survive a broken
// build. A second copy is only safe if something checks it, so this asserts the
// hook copy and the src/store.ts copy agree — on the awkward inputs, not the
// easy ones.
//
// If dist/ is missing this test says so and FAILS rather than passing vacuously:
// a drift guard that silently skips is worse than no drift guard, because it
// reports green while guarding nothing.
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectHash as hookHash, normalizeProjectPath as hookNorm } from "./_project-hash.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "store.js");

if (!existsSync(DIST)) {
  console.error(`FAIL  dist/store.js not found at ${DIST} — run \`npm run build\` first.`);
  console.error("      (Refusing to pass without comparing: an unchecked second copy is the bug.)");
  process.exit(1);
}

const { projectHash: srcHash, normalizeProjectPath: srcNorm } = await import(pathToFileURL(DIST).href);

const W = String.raw;
const vectors = [
  W`C:\Users\Amit\AI_projects\SecureContext`,
  "C:/Users/Amit/AI_projects/SecureContext",
  // A trailing backslash would escape the closing backtick, so these are built
  // by concatenation rather than written literally.
  W`C:\Users\Amit\AI_projects\SecureContext` + "\\",
  "C:/Users/Amit/AI_projects/SecureContext/",
  W`C:\Users/Amit\AI_projects/Mixed`,
  "C:" + "\\",
  "/home/user/project",
  "/home/user/project/",
  "/",
  W`/home/user/weird\name`,          // backslash is a legal POSIX filename char
  "relative/path",
  "",
];

let pass = 0, fail = 0;
for (const v of vectors) {
  const okHash = hookHash(v) === srcHash(v);
  const okNorm = hookNorm(v) === srcNorm(v);
  const ok = okHash && okNorm;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(v)}`);
  if (!ok) {
    console.log(`        hook norm=${JSON.stringify(hookNorm(v))} hash=${hookHash(v)}`);
    console.log(`        src  norm=${JSON.stringify(srcNorm(v))} hash=${srcHash(v)}`);
  }
}

// The convergence that motivated all of this: two spellings, one database.
{
  const a = hookHash(W`C:\Users\Amit\AI_projects\Test_Agent_Coordination`);
  const b = hookHash("C:/Users/Amit/AI_projects/Test_Agent_Coordination");
  const ok = a === b && a === "aafb4b029db36884";
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  both spellings resolve to the pre-existing database`);
  if (!ok) console.log(`        backslash=${a} forward=${b} want=aafb4b029db36884`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
