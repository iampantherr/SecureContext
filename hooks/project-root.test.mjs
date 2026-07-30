// Exercise the project-root resolution from preread-dedup.mjs against a REAL
// temporary directory tree, not string fixtures.
//
// The bug this guards: the hook used the session's cwd as the project. A session
// running in .../zeroclaw that read .../SecureContext/src/embedder.ts looked the
// file up in zeroclaw's knowledge base, found nothing, and reported "NOT indexed"
// for a file that is fully indexed. The attached advice was the dangerous part —
// "run zc_file_summary" would have indexed a SecureContext file INTO zeroclaw's KB.
//
// Same predicate as the hook. Kept in step by hand, matching brief-exempt.test.mjs.
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

function resolveProjectRoot(absPath, fallback) {
  try {
    if (!/^([a-zA-Z]:[\\/]|\/)/.test(absPath)) return fallback;
    let dir = resolve(absPath, "..");
    for (let i = 0; i < 40; i++) {
      if (existsSync(join(dir, ".git"))) return dir;
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* fall through */ }
  return fallback;
}

const ROOT = join(tmpdir(), `zc_projroot_${process.pid}`);
const REPO_A = join(ROOT, "repoA");
const REPO_B = join(ROOT, "repoB");
rmSync(ROOT, { recursive: true, force: true });
for (const r of [REPO_A, REPO_B]) {
  mkdirSync(join(r, ".git"), { recursive: true });
  mkdirSync(join(r, "src", "deep", "nested"), { recursive: true });
  writeFileSync(join(r, "src", "deep", "nested", "file.ts"), "export const x = 1;\n");
}
// A directory with no .git anywhere above it inside ROOT.
const LOOSE = join(ROOT, "loose");
mkdirSync(LOOSE, { recursive: true });
writeFileSync(join(LOOSE, "stray.ts"), "export const y = 2;\n");

const FALLBACK = REPO_A;   // stand-in for the session cwd

const cases = [
  [join(REPO_B, "src", "deep", "nested", "file.ts"), REPO_B,
   "file in another repo resolves to THAT repo, not the session cwd"],
  [join(REPO_A, "src", "deep", "nested", "file.ts"), REPO_A,
   "file in the session's own repo still resolves to it"],
  [join(REPO_B, "src"), REPO_B,
   "a directory inside a repo resolves to the repo"],
  ["src/relative/path.ts", FALLBACK,
   "a relative path is already project-local, so the fallback stands"],
];

let pass = 0, fail = 0;
for (const [input, want, why] of cases) {
  const got = resolveProjectRoot(input, FALLBACK);
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${why}`);
  if (!ok) console.log(`        got=${got}\n       want=${want}`);
}

// The loose file has no .git above it until tmpdir's ancestors, so it must NOT
// silently claim some far-off repo as its project.
{
  const got = resolveProjectRoot(join(LOOSE, "stray.ts"), FALLBACK);
  const ok = got === FALLBACK || !got.startsWith(ROOT);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  a file with no repo above it does not claim a sibling repo`);
  if (!ok) console.log(`        got=${got}`);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
