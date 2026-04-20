#!/usr/bin/env node
/**
 * Self-test for the L3 no-floating-promises rule.
 *
 * Creates a synthetic TS file with an unawaited async call in /tmp-eslint-test,
 * points ESLint at it, and asserts that:
 *   (a) ESLint exits non-zero (lint error detected)
 *   (b) The error message mentions no-floating-promises
 *
 * This proves the rule is wired and actually catches regressions.
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const scRoot = join(here, "..", "..");

function runEslint(dir) {
  return spawnSync("npx", ["eslint", dir], {
    encoding: "utf8",
    cwd: scRoot,
    shell: true,
  });
}

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.log(`  ✗ ${name}${detail ? "\n      " + detail : ""}`); }
}

// ─── Create a synthetic TS file with an unawaited promise ───────────────────
// Place it INSIDE src/ (temporarily) so ESLint's project tsconfig covers it.
const testFile = join(scRoot, "src", "_lint_regression_test.ts");
const badCode = `// Synthetic regression test — DO NOT commit this file
// ESLint should flag the unawaited call below.
async function someAsyncFn(): Promise<void> {
  return Promise.resolve();
}
someAsyncFn();  // <-- should trigger no-floating-promises
`;

try {
  writeFileSync(testFile, badCode, "utf8");
  const result = runEslint("src/_lint_regression_test.ts");
  assert("ESLint exits non-zero on floating promise", result.status !== 0,
    `status=${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert("error mentions no-floating-promises", /no-floating-promises/.test(result.stdout || ""),
    `stdout:\n${result.stdout}`);
  assert("error points to the right line",
    /_lint_regression_test\.ts/.test(result.stdout || ""),
    `stdout:\n${result.stdout}`);

  // Also verify the void operator silences it
  const fixedCode = badCode.replace("someAsyncFn();", "void someAsyncFn();");
  writeFileSync(testFile, fixedCode, "utf8");
  const fixedResult = runEslint("src/_lint_regression_test.ts");
  assert("void operator silences no-floating-promises", fixedResult.status === 0,
    `status=${fixedResult.status}\nSTDOUT:\n${fixedResult.stdout}`);

  // And that await silences it too
  const awaitedCode = `async function main(): Promise<void> {
  async function someAsyncFn(): Promise<void> { return; }
  await someAsyncFn();
}
void main();
`;
  writeFileSync(testFile, awaitedCode, "utf8");
  const awaitResult = runEslint("src/_lint_regression_test.ts");
  assert("await silences no-floating-promises", awaitResult.status === 0,
    `status=${awaitResult.status}\nSTDOUT:\n${awaitResult.stdout}`);
} finally {
  // Always clean up the synthetic file
  try { rmSync(testFile, { force: true }); } catch { /* noop */ }
}

console.log(`\n${pass + fail} total, ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
