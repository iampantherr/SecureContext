# SecureContext — Ponytail Audit

**Date:** 2026-07-30 · **Scope:** all 106 source files, 49,986 lines (`src/`, excluding tests)
**Method:** the decision ladder from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)
**Status:** AUDIT ONLY — nothing in this document has been fixed. Findings are evidence, ranked by payoff against risk.

---

## How to read this

Every finding carries `file:line` so it can be verified independently and fixed in isolation. Severity means:

| | meaning |
|---|---|
| **S1** | can produce wrong data or hide a failure. Fix regardless of effort. |
| **S2** | real maintenance cost; a future change will trip over it. |
| **S3** | noise. Fix when touching the file anyway. |

The ladder rung tells you *why* it is a finding: rung 2 = "already in this codebase", rung 3 = "stdlib does it", rung 6 = "one line", rung 7 = "minimum that works".

---

## S1-1 · The project hash is reimplemented 49 times, and the copies disagree

**Rung 2.** `sha256(projectPath).slice(0,16)` — the primary key for every project-scoped table — is written out inline in **49 places across 25 files**.

Named definitions, all byte-identical:

| symbol | file:line |
|---|---|
| `ph()` | `store-postgres.ts:80` |
| `projectHash()` | `store.ts:229` |
| `projectHashOf()` | `skills/storage_dual.ts:34` |
| (anonymous inline) | 46 further sites |

Representative inline sites: `api-server.ts:149,618,677,1087,3683,4231,4471,4567,4637` · `server.ts:153,2415,3726,4247,4265,4275,4303,4320` · `knowledge.ts:79,287,454,491` · `session.ts:21,26,66` · `outcomes.ts:205,242,355,866` · `harness.ts:478,516,989` · `store-sqlite.ts:85,114` · `memory.ts:224` · `telemetry.ts:546` · `access-control.ts:80` · `compaction.ts:144` · `program.ts:21` · `memory_contradictions.ts:344` · `indexing/backlinks.ts:209` · `skills/spotter/llm_filer.ts:327,379` · `skills/mutators/cli_claude.ts:114,284`

**Why this is S1 — the copies do not agree on their input.** *(Severity corrected 2026-07-30 after measurement; see below.)*

- `api-server.ts:131` is inside `validateProjectPath`, which normalises Windows separators and **returns** the path — so callers hashing its output are consistent. Not a divergence.
- `api-server.ts:618` and `:677` (the `pretool-event` and `summarizer-event` writers) resolved symlinks via `realpathSync` **before** hashing. These were the only two sites that did.
- the other 46 sites hash the validated path directly.

**Measured, not assumed:** `realpathSync` is a no-op on plain local paths — 0 of 3 real project paths produced a different hash. The divergence was therefore **latent, not active**. My first draft of this section claimed one project "can produce three different hashes" as though it were live; that was wrong and is corrected here.

The latent risk was still real and worth closing: `summarizer_events_pg` rows were written with the realpath hash, while `source_meta` and `project_paths_pg` use the validated one, and the dashboard filters **both** with a single hash taken from the non-realpath side. On any symlinked path or mapped drive the summarizer panel would report zero while the count rendered beside it stayed correct — which is the "dashboard inconsistency" class the v0.22.7 commit that introduced this realpath call was itself trying to fix.

**FIXED in v0.54.4:** both writers now call the existing `projectHash()` from `store.ts` (rung 2 — reuse what is already here) instead of hand-rolling a third variant. 1032/1032 tests pass.

**Still open:** the remaining 47 inline copies. With the divergence closed these are an S2 maintenance concern, not a correctness one — each is a place a future edit can reintroduce exactly this bug.

**This class already fired in production.** On 2026-07-29 the cross-project pool (v0.54.0) wrote global facts under `hash("__global__")` while recall matched the raw literal `"__global__"`. The write returned `ok:true`, the row existed, and nothing read it. Effect verification did not catch it because the field *values* were stored exactly as asked — the routing was wrong, not the data.

**Fix shape:** one exported `projectHash()`; every call site imports it. Then the normalisation question becomes answerable *once* (does it realpath or not?) instead of being decided differently in three places.

---

## S1-2 · 222 empty catch blocks; 22 with no explanation at all

**Rung 7.** Swallowing an error is a decision. Sometimes correct — a best-effort backlink rebuild should not fail a write. But it is indistinguishable from an oversight unless the code says which it is.

Distribution:

| file | count |
|---|---|
| `store-postgres.ts` | 28 |
| `migrations.ts` | 26 |
| `knowledge.ts` | 23 |
| `api-server.ts` | 16 |
| `server.ts` | 16 |
| `harness.ts` | 14 |
| `memory.ts` | 10 |
| `dashboard/operator_review.ts` | 10 |
| `dashboard/render.ts` | 10 |
| `memory_contradictions.ts` | 9 |
| *(30 further files)* | 60 |

**200 carry a comment** (`/* best-effort */`, `/* non-fatal */`) — those are defensible.

**22 appeared to be bare `catch {}`.** *(Corrected 2026-07-30 after reading all 22 — the detector over-counted.)*

The regex only inspected text **between the braces**, so it flagged code whose intent is documented on the line above:

```ts
// Add agent_id to existing tables upgrading from v0.5.0 (safe: silently ignored if already present)
try { db.exec(`ALTER TABLE working_memory ADD COLUMN agent_id ...`); } catch {}
```

Actual breakdown after reading each one:

| count | kind | action taken |
|---|---|---|
| **12** | idempotent `ALTER TABLE`, intent stated on the preceding line | **none** — a second comment is noise (rung 1) |
| **8** | degrade to a safe default already declared before the `try` (search enrichment, project label, cache parse, JSON parse) | one-line intent comment |
| **1** | **reports a fabricated `0` to the operator** | `ponytail:` ceiling note + upgrade path |
| **1** | nested `child.kill` fallback after a failed kill | one-line comment |

**The one that mattered — `knowledge.ts:1230` (`getKnowledgeStats`).** On a pre-v0.6 DB without `source_meta`, it silently returns `externalEntries: 0, summaryEntries: 0`. The operator reads "none"; the truth is "not counted". The asymmetry proves the intent was known: **every other count in that same function — `totalEntries`, `embeddingsCached`, `dbSizeBytes` — is deliberately unwrapped and throws.** Only these two lie.

Left non-throwing on purpose (an old DB should still render stats), but the ceiling is now named in-code with the upgrade path: widen both to `number | null` and render `—` when null.

**FIXED in v0.54.5.** 1032/1032 tests pass. Remaining bare-looking catches: 12, all documented `ALTER TABLE`.

**This class has already cost this project three separate incidents**, all in the last week: telemetry `.catch(() => {})` hiding a 400 that made a detector unobservable; a swallowed embedding timeout; and the PreRead hook silently discarding rejected outcomes.

**Fix shape:** every `catch {}` states why in-line, or logs at debug. A rule that can be enforced mechanically: reject a bare `catch {}` with no comment.

---

## S2-1 · `createApiServer` is a 4,462-line function

**Rung 7.** `api-server.ts:203` — a single function containing the entire HTTP API. The file is 4,790 lines, so **93% of the file is one function body**.

Consequences already visible in this codebase:
- route handlers cannot be unit-tested in isolation; the API is only testable through HTTP
- `api-server.ts` holds 16 empty catch blocks and 9 duplicated hash computations, largely because there is no smaller unit to reason about
- every route edit touches the same function, so blame and conflict surface are maximal

Other oversized functions:

| lines | location | name |
|---|---|---|
| 4462 | `api-server.ts:203` | `createApiServer` |
| 1099 | `dashboard/render.ts:284` | `renderDashboardHtml` |
| 268 | `skills/filesystem_skill_import.ts:483` | `importFilesystemSkills` |
| 264 | `skills/marketplace_pull.ts:222` | `pullFromMarketplace` |
| 211 | `dashboard/render.ts:2944` | `renderWikiGraphFragment` |
| 188 | `outcomes.ts:198` | `maybeTriggerL1Mutation` |
| 163 | `skills/spotter/llm_filer.ts:480` | `runSpotterLlmFiler` |
| 152 | `skill_auto_import.ts:175` | `autoImportSkills` |
| 131 | `dashboard/operator_review.ts:104` | `handleApproveFromDashboard` |
| 121 | `telemetry.ts:208` | `_recordToolCallPostgres` |

*(20 further functions over 80 lines — full list in `audit_raw.json`)*

### Measured feasibility (2026-07-30) — DEFERRED, with a concrete plan

Two facts change the picture, both measured rather than assumed:

**Encouraging:** the 123 route handlers close over exactly **two** variables — `store` and `app`. There is no hidden shared state, so extracted modules need only the signature `(app, store)`. That is a far better risk profile than 4,462 lines suggests.

**Blocking:** the routes are **heavily interleaved**. `/api/*` (62) and `/dashboard/*` (56) alternate 15+ times through the function:

```
line  330 api → 363 DASH → 546 api → 553 DASH → 600 api → 718 DASH
     1020 api → 1138 DASH → 1715 api → 2067 DASH → 2220 api → …
```

So extraction is not a contiguous cut; it is cherry-picking ~56 scattered blocks out of a 4.5k-line body. Dashboard routes return HTML and are the *thinnest*-covered part of the suite, so a misplaced block can pass CI and fail in the browser.

**Deliberately not done in this pass.** Ponytail's own rule decides it: *"the smallest change in the wrong place isn't lazy, it's a second bug."* A blind mass-move at the end of a long session, to close a checklist item, is exactly that. This one is a refactor, not a cleanup — it moves code rather than deleting any, so the payoff is testability, not leanness.

**Staged plan when it is scheduled:**
1. `src/api/routes_dashboard.ts` exporting `registerDashboardRoutes(app, store)` — move the 56 `/dashboard/*` handlers **one group at a time**, running the suite after each
2. Add a smoke test that GETs every `/dashboard/*` path and asserts HTTP 200 + non-empty body **before** moving anything — the current gap is why this is risky
3. Then `routes_telemetry.ts`, `routes_memory.ts`, `routes_skills.ts` from the `/api/v1/*` groups
4. `createApiServer` ends as ~200 lines of setup plus registration calls

Do step 2 first. Without it the refactor is unverifiable.

---

## S2-2 · Seven dead exports remain, and removing dead code creates more

**Rung 1.** Verified unreferenced across the whole repo (not just `src/` — `hooks/`, `scripts/` and the dashboard import from `src` too):

| file:line | symbol | note |
|---|---|---|
| `skills/anthropic_standard.ts:190` | `STANDARD_TLDR` | missed by the v0.54.3 pass (wrong path) |
| `session.ts:64` | `getOrCreateSession` | **newly dead** — its only caller was `recordEvent`, removed in v0.54.3 |

Plus five whose only consumers are outside `src/` and which are therefore **not** dead — listed here so a future pass does not delete them: `harness.ts:905 clearSessionReadLog`, `harness.ts:1236 resetHealthCache`, `knowledge.ts:1242 clearKnowledge`, `summarizer.ts:362 resetSummaryModelCache`, `temporal_solver.ts:58 extractDate`.

**The cascade is the point.** Removing 14 symbols in v0.54.3 made `getOrCreateSession` dead. Dead-code removal must be run to a fixpoint, not once.

### 32 exports referenced only by their own tests

These are the trap: **the test proves the function works, not that anything needs it.** Many are legitimate `_resetXForTesting` helpers. Each needs a judgement call, not a blanket rule:

`access-control.ts hasActiveSessions, revokeToken` · `contradiction_heuristics.ts isSeriesPair` · `loader.ts loadSkillFromPath, renderSkillMarkdown, skillFilename` · `machine_secret.ts getMachineSecretInfo, rotateMachineSecret` · `mutator.ts hashCandidates` · `orchestrator.ts runNightlyCycle` · `outcomes.ts getOutcomesForToolCall` (27 test refs) · `pricing.ts listKnownModels, pricingTableVersion` · `recall_budget.ts applyStalenessDemotion` · `recall_cache.ts getCacheStats` · *(+18 more)*

`revokeToken` and `rotateMachineSecret` are security operations with no production caller — either the feature is unfinished or the exports are vestigial. Worth answering explicitly.

---

## S2-3 · Eleven forwarding wrappers

**Rung 6.** A function whose entire body is one call to another function.

Genuinely duplicated (same body, different name) — **remove one:**
- `store.ts:229 projectHash()` and `skills/storage_dual.ts:34 projectHashOf()` — byte-identical
- `skills/script_scanner.ts scanSkillScripts()` — *already removed in v0.54.3*; its caller had hand-rolled the identical `.map()` inline

Defensible (a named domain concept over a stdlib primitive — keep):
- `chain.ts:22 computeRowHash()`, `security/hmac_chain.ts:87 hmacRowHash()`, `team_auth.ts:40 hashApiKey()`

Thin but harmless (judgement call):
- `outcomes.ts:178 tryTriggerL1Mutation()` → `maybeTriggerL1Mutation()`
- `skills/mutation_results.ts:316,326 approveMutation()/rejectMutation()` → `_decideMutation()` — these two read well and document intent
- `logger.ts:176 pathForDate()` → `join()`
- `contradiction_heuristics.ts:277 strippedTemplate()` → `normalizeNumerals()`
- `security/chained_table.ts:135 deriveAgentChainKey()` → `deriveAgentChainKeyFrom()`

---

## S3-1 · 25 duplicated six-line blocks — NOT ACTIONED (mostly noise)

Inspected. Breakdown:
- `const { createHash } = await import("node:crypto");` ×4 — a trivial import line; two of those sites disappeared in the hash consolidation anyway
- `body: row.body,` / `body_hmac: row.body_hmac,` ×4 — row→DTO field mapping. Extracting a helper for three sites buys indirection, not clarity
- SQL DDL fragments in `migrations.ts` — **historical migrations must not be edited**
- `task?: string; state?: string; summary?: string;` ×3 across `memory.ts`, `server.ts`, `store.ts` — the one *real* item: the broadcast-options shape is declared three times. Type-level, low-risk, and consolidating it crosses module boundaries with import-cycle implications. **Left deliberately; noted for whoever next touches that shape.**

## S3-2 · Repeated magic numbers — NOT ACTIONED (false positives)

The detector counted any 3+ digit literal. Inspected, the top hits are:
- `255`, `230`, `166`, `108`, `162`, `241` — **RGB channel values** in `dashboard/render.ts` CSS (`rgba(255,255,255,.045)`)
- `2026` — the current year, in dates
- `1024` — byte→KB conversion
- `256` — text inside a comment (`// 256-bit random salt`)

Nothing here wants a named constant. **No change.**

## S3-3 · Nine lines of commented-out code — NOT ACTIONED (false positives)

All nine were prose beginning with a keyword, or documentation:
- `// let consumers filter rows when querying:` — prose
- `// import keeps the memory↔knowledge↔backlinks module graph cycle-free` — prose
- six in `indexing/ast_extractor.ts` (`// export class Foo`) — **pattern labels documenting the regex on the line below**, which are genuinely useful

**Nothing deleted.**

## S3-4 · One debt marker

A single `TODO/FIXME/HACK` in 50k lines. Unusually clean — but read alongside the empty catches, it suggests debt is being *absorbed silently* rather than marked.

## S3-5 · `mutation_guardrails` daily cap is unreliable near midnight — NOTED, not fixed

Found by a real failure during this work, not by a detector. `checkMutationGuardrails` builds the day boundary with local time and compares it against UTC ISO timestamps:

```ts
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);          // LOCAL midnight
const todayIso = todayStart.toISOString(); // ...compared against UTC rows
```

The daily-cap test failed once at **00:05** and passes at every other hour; it passes in isolation both with and without the change that was in flight, so it is a date-boundary flake, not a regression. Left alone because the fix (decide whether the cap is a local-day or UTC-day policy) is a behaviour decision, not a cleanup.

**Worth flagging as process:** the honest move on a single red test minutes after midnight is to prove *why* before re-running. Re-running until green would have hidden this.

---

## What the audit found that is NOT over-engineering

Stated so the picture is honest:

- **No `catch` that only rethrows** (0 instances) — error handling is not ceremonial
- **Only 1 debt marker** in 50k lines
- **Only 9 lines of commented-out code**
- The 200 *commented* empty catches are largely deliberate best-effort paths, correctly reasoned

The codebase's problem is not sloppiness. It is **scale without extraction**: two enormous functions, one primitive copy-pasted 49 times, and error suppression that became a habit.

---

## Scheduled follow-up — do not lose this

### Enforcement plan (agreed 2026-07-30, to implement after this audit)

Two layers, deliberately different in kind:

**1. ponytail plugin — soft, broad.** Installed via `/plugin marketplace add DietrichGebert/ponytail` + `/plugin install`. Its value is *delivery*, not novelty: `SessionStart` / `UserPromptSubmit` / `SubagentStart` hooks re-inject the rules across compaction and into every subagent, and it propagates to Codex/Cursor/Copilot. It registers **no `PreToolUse` hook**, so it cannot block anything — it guides.

Honest caveat on file: on ponytail's own benchmark, [Scott Logic measured](https://blog.scottlogic.com/2026/06/16/ponytail-yagni-and-the-problem-with-prompt-benchmarks.html) `"Follow YAGNI principles, and one-liner solutions"` at **6.9 LOC vs ponytail's 8.25** — seven words beat the ruleset. That benchmark tests ~10-line toy tasks and cannot see any finding in this document.

**2. Commit-time dead-code gate — hard, narrow.** A `PreToolUse` hook on `Bash` matching `git commit`, inspecting the staged diff, blocking when a newly added export has no reference outside its own file and tests. Blocking at *Write* time would be wrong — you legitimately write the helper before the caller. At commit time the answer is unambiguous.

Rationale for pairing: the plugin covers judgement it cannot enforce; the gate enforces the one rule that is mechanically decidable. Dead code earns that status because **the test suite reports it as healthy** — this audit found 14 dead symbols in v0.54.3, several with passing tests.

### Also outstanding from earlier work
- Centralised MCP response helper, so a new tool cannot silently drop a `warning` field (the same bug occurred independently in `zc_remember`, `zc_search`, `zc_summarize_session`)
- Path-separator lint — a regex containing `[\/]` matched no Windows path and silently disabled a detector

---

## Credit

The decision ladder, the safety carve-outs, and the audit shapes used here come from
**[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)** (MIT).
Raw machine-readable findings: `audit_raw.json`.

---

## Final status — every finding

| id | finding | status |
|---|---|---|
| **S1-1** | project hash reimplemented, copies disagreed | **FIXED** v0.54.4 (divergence) + v0.54.6 (42 sites consolidated) |
| **S1-2** | silent catch blocks | **FIXED** v0.54.5 — 10 real, not 22 |
| **S2-1** | `createApiServer` 4,462 lines | **DEFERRED** with a staged plan + a prerequisite smoke test |
| **S2-2** | dead exports | **FIXED** v0.54.3 + v0.54.6, run to a **fixpoint** (0 remain) |
| **S2-3** | forwarding wrappers | **FIXED** — true duplicate removed; the rest are named domain concepts, kept |
| **S3-1** | duplicated blocks | **NOT ACTIONED** — noise, except one triplicated type shape, noted |
| **S3-2** | repeated magic numbers | **NOT ACTIONED** — RGB channels and a year |
| **S3-3** | commented-out code | **NOT ACTIONED** — prose and pattern labels |
| **S3-4** | one debt marker | informational |
| **S3-5** | midnight-flaky daily cap | **NOTED** — behaviour decision, not a cleanup |

Suite: **1032/1032** after every change.

## What this audit taught about auditing

**Four of ten findings shrank or vanished on inspection.** S1-1 was latent not active; S1-2 was 10 not 22; S3-2 and S3-3 were entirely false positives. The detectors were regexes, and regexes cannot tell an RGB channel from a magic number, prose from commented-out code, or a comment above a line from no comment at all.

The audit's value was in **pointing at the right files**. Every count in it needed a human read before it meant anything — which is the same lesson the codebase keeps teaching about green test suites.

Two real bugs were found *while fixing*, not by any detector:
- a v0.53.1 comment sitting **inside a SQL template literal**, shipped and pushed, breaking every `failTask` call — the suite was green because the live-PG tests had not run that session
- the midnight-boundary flake (S3-5)

**Implication for the enforcement plan above:** the commit-time gate must stay narrow. Dead code is mechanically decidable and worth blocking. "Is this over-engineered" is not, and a gate that guesses at it would produce exactly the false positives this audit produced — and would be disabled within a day.
