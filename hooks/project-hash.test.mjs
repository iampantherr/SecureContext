// The hook family keeps its own copy of projectHash so hooks survive a broken
// build. A second copy is only safe if something checks it, so this asserts the
// hook copy and the src/store.ts copy agree — on the awkward inputs, not the
// easy ones.
//
// If dist/ is missing this test says so and FAILS rather than passing vacuously:
// a drift guard that silently skips is worse than no drift guard, because it
// reports green while guarding nothing.
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
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
  W`C:\repos\my-service`,
  "C:/repos/my-service",
  // A trailing backslash would escape the closing backtick, so these are built
  // by concatenation rather than written literally.
  W`C:\repos\my-service` + "\\",
  "C:/repos/my-service/",
  W`C:\repos/mixed-seps`,
  "C:" + "\\",
  "/home/dev/project",
  "/home/dev/project/",
  "/",
  W`/home/dev/weird\name`,          // backslash is a legal POSIX filename char
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
  const canonical = W`C:\repos\other-service`;
  const a = hookHash(canonical);
  const b = hookHash("C:/repos/other-service");
  // Asserted as a property rather than a machine-specific constant: both
  // spellings agree AND land on a plain sha256 of the canonical form, which is
  // what keeps databases already on disk reachable.
  const expected = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const ok = a === b && a === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  both spellings resolve to the canonical database`);
  if (!ok) console.log(`        backslash=${a} forward=${b} want=${expected}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
