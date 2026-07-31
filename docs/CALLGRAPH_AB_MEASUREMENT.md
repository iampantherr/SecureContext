# A/B: does the call graph change what agents do?

**Answer as measured: no, not on intra-repo caller updates.** Recorded because a
feature that cannot show its effect should say so rather than be defended.

## Method

Same task, same model, same repo, ten runs. Arm **A** had the graph (PreRead +
PreWrite impact hooks). Arm **B** had both disabled
(`ZC_IMPACT_ON_WRITE=0`, `ZC_SUMMARY_REDIRECT=0`). Both arms had `Grep`/`Glob`.

Task: change `toCents` to take a `currency` parameter and return
`{ cents, currency }` — a change that **breaks every caller**. The measurement is
objective: which caller files were modified, from `git diff --name-only`.

## Round 1 — 4 files, plain named imports

| arm | runs | callers updated |
|---|---|---|
| with graph | 2 | 3/3, 3/3 |
| without | 2 | 3/3, 3/3 |

Null. The design was too easy: `import { toCents } from "./money.js"` in a
four-file repo is a `grep` away.

## Round 2 — built so naive search FAILS

25 files, and specifically:

- two callers import under an **alias** (`toCents as toMinor`,
  `as minorUnits`), so grepping the function name finds the import line but not
  the call sites;
- a **decoy** file declares its own local `toCents` — a name-based search reports
  it as a caller, and "fixing" it would be a wrong edit;
- 20 filler files so "read everything" is not a strategy.

This is exactly the case the extractor handles via import-specifier pinning and a
text search does not.

| arm | runs | real callers updated | decoy wrongly edited |
|---|---|---|---|
| with graph | 3 | 3/3, 3/3, 3/3 | 0 |
| without | 3 | 3/3, 3/3, 3/3 | 0 |

Null again — including the false-positive trap.

## What this means

Agents with `Grep`/`Glob` already solve intra-repo caller discovery, aliases
included. **The impact hooks did not improve correctness on this class of task,
and claiming otherwise would be unsupported.**

The graph's remaining, unduplicated value is where local search *cannot* reach:

- **cross-repo consumers** — 14 edges into SecureContext routes from
  A2A_dispatcher. No amount of grepping inside SecureContext finds them.
- **dynamic dispatch** — 612 unresolved call sites, reported rather than hidden.
- **operator visibility** — the dashboard graph and the commit-time advisory
  answer questions a human asks, not an agent.

**Not yet measured:** the cross-repo case. That is the honest next experiment,
and until it is run the cross-repo claim is a hypothesis too.

## Caveats

n=10 on one refactor shape, one model, small repos. A null result here does not
prove the graph never helps — it proves it did not help *here*, which is the only
thing the data supports.
