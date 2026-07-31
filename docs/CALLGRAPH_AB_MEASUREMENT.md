# A/B: does the call graph change what agents do?

**Measured answer: no — not on repos of this size, on any of three designs.**
16 agent runs. Recorded because a feature that cannot demonstrate its effect
should say so rather than be defended on plausibility.

## Rounds 1–2 measured the wrong thing

Both used `git diff --name-only` — "was the caller file touched". That is a weak
proxy: an agent can edit a caller and still break it. Both were null (4/4 and
6/6 runs, arms identical), but the metric could not have detected a bad edit.

Round 2 at least hardened the *discovery* problem: 25 files, two callers using
**aliased imports** (`toCents as toMinor`) that `grep toCents` misses, a decoy
file declaring its own local `toCents`, and 20 filler files. Both arms updated
3/3 real callers and neither touched the decoy.

## Round 3 measures SURVIVAL, which is the real question

Designed so the compiler cannot help and "the file was edited" proves nothing:

- `normalizeId(id: string): string` keeps its **signature**; only its **rule**
  changes (spaces/underscores become hyphens).
- `lookup.ts` holds a catalogue whose **keys are in the old canonical form**.
- `compare.ts` holds a **constant** in the old form.
- `cache.ts` is rule-agnostic — a false-positive control that must NOT be edited.

Change the helper alone and everything still typechecks while lookups silently
return `null` and comparisons silently return `false`.

Survival is decided by a **held-out** suite that is never in the repo while the
agent works: it typechecks the result, transpiles it, imports the real modules
and asserts end-to-end behaviour.

### The harness was validated before it was trusted

| repo state | typechecks | SURVIVED |
|---|---|---|
| baseline, task not done | ✓ | 4/8 |
| **naive edit — helper only** | **✓** | **3/8** |
| correct edit | ✓ | 8/8 |

The naive edit compiles cleanly and breaks five dependent behaviours, so the
measurement can detect exactly the failure the graph exists to prevent. An
earlier version of this fixture passed a naive edit 8/8 — the catalogue keys were
already in the new canonical form, making the change a harmless superset. That
version would have produced a meaningless null.

### Result

| arm | runs | SURVIVED | dependents fixed | false-positive edit |
|---|---|---|---|---|
| with graph | 3 | 8/8, 8/8, 8/8 | 2/2 each | 0 |
| without | 3 | 8/8, 8/8, 8/8 | 2/2 each | 0 |

Null again — with the right metric, on a break the compiler cannot catch.

## What this means

Across 16 runs and three designs, **the impact hooks did not improve edit
survival.** Agents with `Grep`/`Glob` find dependents in a 4–25 file repo, read
them, notice the stale keys, and fix them. On this scale the graph tells them
something they already work out.

Claiming the graph improves intra-repo edit correctness is **not supported by
this data**, and this document exists so that claim is not made.

### Where the value could still be real — and is NOT yet measured

- **Cross-repo consumers.** 14 edges reach SecureContext routes from
  A2A_dispatcher. No amount of grepping *inside* SecureContext finds them, so
  the control arm cannot succeed by search. This is the honest next experiment.
- **Scale.** A repo where reading every candidate is not viable.
- **Dynamic dispatch.** 612 unresolved sites, reported rather than hidden.
- **Operator visibility.** The dashboard graph and commit-time advisory answer
  questions a human asks; no agent A/B measures those.

## Caveats

n=16, one model, one refactor shape, small repos. A null result does not prove
the graph never helps — it proves it did not help *here*, which is all the data
supports.
