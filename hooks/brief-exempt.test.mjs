// Exercise the exact brief-exemption predicate from preread-dedup.mjs on BOTH
// separator styles. The first version of this check put the separator inside the
// regex as [\/] — a forward slash only in a JS regex literal — so it never
// matched a Windows path and the exemption was dead. The original verification
// used forward slashes and passed, which is how the bug survived.
const isBrief = (p) => {
  const base = String(p).split(/[\\/]/).pop() ?? "";
  return /^(TASK|BRIEF|SPEC|ACCEPTANCE|PENDING_WORK|HANDOFF)/i.test(base) && /\.md$/i.test(base);
};

const W = String.raw;   // keep Windows paths literal
const cases = [
  [W`C:\repos\example-project\TASK_DEV_P1NEW.md`, true,  "windows backslash brief"],
  ["C:/repos/example-project/TASK_DEV_P1NEW.md",  true,  "posix-style brief"],
  [W`C:\x\PENDING_WORK.md`,                                          true,  "pending work"],
  [W`C:\x\HANDOFF.md`,                                               true,  "handoff"],
  ["TASK_E2E_PROBE.md",                                              true,  "bare filename"],
  [W`C:\x\ACCEPTANCE_CRITERIA.md`,                                   true,  "acceptance"],
  [W`C:\x\reports\qa\P1NEW_CLOSEOUT.md`,                             false, "report must stay redirected"],
  [W`C:\x\README.md`,                                                false, "readme must stay redirected"],
  [W`C:\x\src\store-postgres.ts`,                                    false, "source must stay redirected"],
  [W`C:\x\TASK_NOTES.txt`,                                           false, "non-markdown"],
  [W`C:\x\MY_TASK_LIST.md`,                                          false, "TASK not at start of basename"],
];

let pass = 0, fail = 0;
for (const [p, want, why] of cases) {
  const got = isBrief(p);
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  got=${String(got).padEnd(5)} want=${String(want).padEnd(5)} ${why}`);
  if (!ok) console.log(`        path: ${p}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
