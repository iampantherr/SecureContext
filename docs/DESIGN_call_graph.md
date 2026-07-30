# Design — function call graph for cascade-aware edits

**Status:** DESIGN, not implemented. For review before any code.
**Problem owner's words:** *"The agent just focuses on the current function and enhancing its functionality but fails to consider all the cascading dependent functions. I have seen this happen a lot."*

---

## 1. The problem, with evidence from this codebase

Not hypothetical. Every one of these happened in the last three days:

| incident | what the agent could not see |
|---|---|
| `recordEvent` removed | its removal made `getOrCreateSession` dead. Nobody noticed until a second scan. |
| `projectHash` semantics | 42 call sites. An agent editing one had no way to know. |
| MCP dropped `warning` | the same bug existed in `zc_remember`, `zc_search`, `zc_summarize_session`. Fixed three times because the pattern was invisible. |
| `clampWithMarker` reused | changing it silently affects broadcasts, session summaries and task-queue failure reasons. |
| `failTask` SQL comment | editing the function revealed nothing about who depends on it. |

The shape is constant: **the edit is local, the consequence is not.**

## 2. What already exists — do not rebuild it

This design is an **extension**, not a new subsystem. Checked before designing (rung 2):

| need | already in SecureContext |
|---|---|
| parser | `typescript@5.9.3` in `node_modules` — real AST available, no new dependency (rung 5) |
| edge storage | `kb_edges (from_source, to_source, relation_type, match_kind, weight, computed_at)` — free-form TEXT keys, PK includes `relation_type`, so call edges coexist with the existing document edges |
| **reverse index** | `idx_kbe_to ON kb_edges(to_source)` — the "who calls me" query is *already indexed* |
| in-degree aggregate | `kb_backlinks` |
| query tools | `zc_graph_neighbors`, `zc_graph_path`, `zc_graph_query`, `zc_graph_rebuild` |
| rebuild plumbing | debounced fire-and-forget after `indexContent`, PG mirroring to `kb_edges_pg` |
| **delivery at read time** | the PreRead hook, already enforcing summary-redirect |

**The only genuine gap is call-edge extraction.** `indexing/ast_extractor.ts` extracts declarations (classes, functions, interfaces, exports) by regex. It does not record call sites.

No schema migration is required.

## 3. Node identity

```
func:<repo-relative-path>#<symbol>      e.g. func:src/store.ts#projectHash
file:<repo-relative-path>               e.g. file:src/store.ts
```

Human-readable, greppable, stable across moves within a repo, and consistent with the existing `memory:<agent>:<key>` / `file:` source conventions.

## 4. Extraction — real AST, not regex

Use the TypeScript compiler API for `.ts`/`.mts`/`.js`/`.mjs`. **This is deliberate and the audit is the argument:** six findings across two audits were corrected because regexes reported a *shape* and a human supplied a *meaning*. A call graph built on regex would confidently report "no callers" for a function called via `obj.method()` and produce exactly the fabricated-zero failure this project has a pinned antipattern about.

For each source file:
1. `ts.createSourceFile(...)` → walk the AST
2. record every function/method/arrow declaration as a node, with its line
3. for every `CallExpression`, resolve the callee name and emit `calls` edge caller → callee
4. weight = number of call sites (a function called 5 times in a loop body is more coupled than one called once)

Resolution is **name-based within the repo**, not type-based. Full type resolution needs a `ts.Program` over the whole project, which is slower and still cannot resolve dynamic dispatch. Name-based resolution with an explicit ambiguity marker is the honest 80%.

## 4b. Feasibility probe — RUN, not assumed

A throwaway TS-AST extractor was run over SC's own `src/` before writing any implementation, and checked against numbers this session established by hand.

```
parsed 106 files, 11,652 call sites, 484 unresolved (dynamic) — 4.2% unresolved

clampWithMarker    4 distinct callers   (hand count 4)   MATCH
verifyWrite        2 distinct callers   (hand count 2)   MATCH
scopedProjectHash 31 distinct callers   (42 call sites)  see below
```

**The approach works**, and 95.8% static resolution is a usable base.

**Two things the probe taught that the design was silently wrong about:**

**(1) "Callers" and "call sites" are different numbers, and the useful one is both.** `scopedProjectHash` has 42 call *sites* but 31 distinct *calling functions* — several functions call it more than once. An impact answer must say `31 functions across 18 files (42 sites)`, because "how many places must I check" and "how many edits might be needed" are different questions.

**(2) Name-based resolution collapses common method names, and the failure is loud.** Top fan-in from the probe:

```
122  withClient     (pg_pool.ts)        ← real, useful
 70  close          (store-sqlite.ts)   ← MEANINGLESS: every db.close(), child.close(), …
 46  run            (embedder.ts)       ← MEANINGLESS
 35  ph             (store-postgres.ts) ← real
 30  add            (retrieval_advanced) ← MEANINGLESS: every Set.add()
 28  escapeHtml     (dashboard/render)  ← real, and security-relevant
 26  sanitize       (store-postgres.ts) ← real
```

`withClient`, `escapeHtml`, `sanitize` are genuine hubs — exactly the "what breaks if I touch this" signal we want. `close`, `run`, `add` are noise: an unqualified `.close()` matches every object with that method.

**Mitigation, decided by this probe:**
- emit a `calls` edge only when the callee name resolves to **exactly one** declaration in the repo
- when a name resolves to several, or matches a built-in method name, emit it as `relation_type='calls_ambiguous'` and render it separately, never in the fan-in count
- prefer the receiver when available (`store.close()` → `store-sqlite#close`) as a later refinement

Without this the graph would have reported "70 things depend on `close`" — a confident, useless number, and precisely the kind of fabricated figure the rest of this codebase has spent a week removing.

## 4c. What building it corrected in this design — three claims were wrong

Stage 1 is implemented (`src/indexing/call_graph.ts`, 14 tests + the oracle). The probe validated the *approach*; the implementation falsified three specifics, and all three were the same failure mode this feature exists to prevent — **a confident zero**.

**(1) "No new dependency" (§2) was false.** `typescript` is a **devDependency**. A production `npm i --omit=dev` has no parser, a static import would fail to load the module, and every impact answer would read "no callers" — for every symbol, silently. Fixed two ways: `typescript` promoted to `dependencies`, and the import made lazy behind `callGraphAvailable()`, so a broken install reports *unavailable* rather than *nothing depends on this*. The oracle test asserts nothing when the parser is missing, rather than passing vacuously.

**(2) Import aliases were unhandled — 47 call sites reported as 0.** `import { projectHash as scopedProjectHash }` means every call site uses a local name that matches no declaration. The single most-depended-on symbol in the repo reported **no callers**. Twelve fixture tests passed while this was broken; only the run against real source caught it.

**(3) The single-declaration rule then produced a *second* zero on the same symbol.** `projectHash` is declared **twice** — `store.ts:229` and `access-control.ts:80` — so once aliases resolved, all 47 sites were dumped into `calls_ambiguous` and fan-in stayed 0. Name-only resolution is not sufficient in this repo. Fixed by using the import specifier: a named import pins the call to exactly one file, which settles both same-name collisions and the common-method denylist (`import { close }` is real; a stray `db.close()` is not — distinguished by `viaProperty`).

Measured effect of the pinning fix over SC's `src/`:

| | before | after |
|---|---|---|
| trusted `calls` edges | 1,140 | **1,225** |
| `calls_ambiguous` | 1,455 | **1,268** |
| `projectHash` fan-in | **0** | **31 callers / 18 files / 45 sites** |

31 distinct callers matches the hand count exactly. `clampWithMarker`=4 and `verifyWrite`=2 held throughout.

**Method note.** The pattern from the two audits repeated verbatim: fixtures confirmed what I already believed and the oracle falsified it. Both bugs were invisible to a green suite because a fixture builds its own input. **The oracle — real source, hand-established counts — is the only part of this test file that could have failed.** Any future extractor change must be judged against it, not against the fixtures.

Also surfaced, not yet acted on: **two `projectHash` implementations and two `ph` implementations** exist in `src/`. The graph found duplicate-logic candidates as a side effect on its first real run.

## 5. What the graph CANNOT see — and must say so

This is the most important section. A graph that silently omits edges tells an agent *"nothing depends on this"* — a fabricated zero, and the exact class this codebase has spent a week eliminating.

Unresolvable by static extraction:
- dynamic dispatch — `handlers[type]()`, `obj[method]()`
- higher-order — a function passed as a callback and invoked elsewhere
- string-keyed dispatch — the dispatcher's broadcast routing, SC's MCP tool `switch`
- cross-language — a `.ps1` invoking `node dispatcher.mjs`, an agent calling an MCP tool
- reflection, `eval`, dynamic `import()` with a computed path

**Therefore every impact answer carries a coverage statement**, not just a count:

```
projectHash()  ← 42 static callers across 18 files
               ⚠ 3 unresolved dynamic call sites in this file; coverage is not complete
```

A zero must be rendered as **"no static callers found"**, never as "safe to change". `emptyResultAnomaly` already encodes this principle for search; the same rule applies here.

## 6. Surfacing — three places, cheapest first

### 6a. In the PreRead hook (highest value)
The hook already intercepts `Read` and returns an L0/L1 summary. Append an impact block:

```
## L0 / L1 summary
  …existing…

## Impact — what depends on this file
  projectHash()        ← 42 callers in 18 files   ⚠ HIGH FAN-IN
  clampWithMarker()    ← 6 callers  (broadcast, session summary, task queue)
  verifyClaim()        ← 1 caller
  ⚠ 4 call sites in this file are dynamic and were not resolved
```

This is the key integration: **the agent gets impact at the moment it decides to read, before it edits.** No new discipline required, no tool it must remember to call.

### 6b. `zc_impact(symbol)` tool
For deliberate lookup: `zc_impact("projectHash")` → callers, callees, fan-in, unresolved count. Thin wrapper over `kb_edges` + `idx_kbe_to`.

### 6c. Commit-time advisory
Pairs with the planned dead-code gate: if a staged diff modifies a function with fan-in > N, note the affected callers. **Advisory, never blocking** — high fan-in is a fact, not a defect.

## 7. Freshness

Reuse the existing trigger: `indexContent` already schedules a debounced backlink rebuild. Extend that to re-extract call edges for the changed file only. Full rebuild via `zc_graph_rebuild` stays the batch-authoritative path.

A per-file rebuild is O(file), not O(repo) — cheap enough to run on every write.

## 8. Staged plan

| stage | deliverable | verifiable by |
|---|---|---|
| **1 ✅ DONE** | `extractFileCalls` + `resolveCallGraph` + `impactOf` in `indexing/call_graph.ts` | 14 tests + oracle green; `clampWithMarker`=4, `verifyWrite`=2, `projectHash`=31/18 files, `close`/`run`/`add` all ambiguous. Full suite 1,046 pass. See §4c for what it corrected. |
| **2 ✅ DONE** | `indexing/call_edges.ts` — `match_kind='call'` in the existing `kb_edges`, PG mirrored | Full rebuild (429ms/107 files), NOT per-file: resolution is repo-wide, so refreshing only the changed file leaves stale edges pointing at it from elsewhere. Survives `rebuildBacklinks` (guard test fails without the carve-out). |
| **3 ✅ DONE** | `zc_impact({file\|symbol})`, `GET /api/v1/graph/impact`, `callImpactFor` on BOTH stores | Live against the running server: `withClient` 126 callers / 42 files / 197 sites, identical on SQLite and Postgres. |
| **4 ✅ DONE** | impact appended to both PreRead block paths, `crossFileOnly`, kill switch `ZC_IMPACT_ON_READ=0` | Real `claude -p` session on a throwaway repo: agent received the block and independently verified the count against source. Exposed two defects — wrong-project lookup from the session cwd, and `continue:false` ending the turn. |
| **5 ✅ DONE** | `scripts/impact-advisory.mjs` — staged diff → changed lines → enclosing functions → callers | Staged an edit to a function with 3 hand-counted callers; advisory reported exactly 3 in 2 files. Exit code 0 in every path including a fatal git error. |

Ground truth for stage 1 is unusually good here: this session established real numbers by hand (`projectHash` 42 sites, `clampWithMarker` 6, the MCP `warning` drop in 3). **If the extractor disagrees with those, the extractor is wrong** — that is a real oracle, not a fixture.

## 9. Risks

| risk | mitigation |
|---|---|
| false "no callers" → agent deletes live code | never render 0 as safe; always show unresolved count; the commit gate stays advisory |
| noise on every Read | only show fan-in ≥ 2, cap the list, one line per symbol |
| stale graph after edits | per-file refresh on write; `computed_at` per edge so staleness is visible |
| extraction cost on large files | AST parse is ~ms; already debounced |
| over-trust | the coverage statement is mandatory, not optional |

## 10. Open questions for review

1. **Scope:** SC + dispatcher only at first, or A2A (Python) too? Python needs a second extractor — `ast` module, same edge shape. Recommend deferring.
2. **Cross-repo edges:** should `A2A_dispatcher` calling an SC MCP tool be an edge? Valuable but needs a shared node namespace. Recommend deferring to a later stage.
3. **Fan-in threshold** for the ⚠ HIGH marker — the probe gives a real distribution now: a handful of genuine hubs at 20-122 (`withClient` 122, `ph` 35, `escapeHtml` 28, `sanitize` 26) and a long tail below 10. **Proposed: ⚠ at ≥ 10**, which flags roughly a dozen symbols repo-wide rather than hundreds.
4. **Should the PreRead block be opt-out?** `ZC_IMPACT_ON_READ=0` for parity with the other kill switches. Recommend yes.


---

## 11. Closed out — what the five stages actually cost, and what they caught

All five stages are implemented, verified, and pushed.

**Measured result on this repo:** 4,645 call edges over 273 files, 2.6s for a full
rebuild, 649 unresolved call sites reported rather than hidden, plus 14 cross-repo
edges into 8 routes from A2A_dispatcher.

**The defects this feature found while being built** — each one a confident wrong
answer that a green test suite would have shipped:

| found | what it was |
|---|---|
| `typescript` a devDependency | production install has no parser → every symbol reports "no callers", silently |
| import aliases unhandled | `projectHash as scopedProjectHash` → 47 call sites resolved to 0 |
| two `projectHash` declarations | the same 47 then buried as ambiguous — a second zero on one symbol |
| `dynamicSites: 0` hardcoded | the coverage field, whose only job is honesty, was lying |
| `rebuildBacklinks` DELETE | would have emptied the whole layer on the next index, with no error |
| four `projectHash` copies | led to the real one: the canonical hash normalised nothing, and TWO projects had two databases each |
| drift guard matched `createHash(` only | matched none of the 28 aliased copies it existed to prevent |
| hook used the session cwd | cross-project reads looked up the wrong database and said "NOT indexed" |
| hook returned `continue:false` | every redirected Read ended the agent's turn |
| URL regex needed a leading quote | missed `fetch(\`${BASE}/api/v1/x\`)` — 3 edges where 9 call sites existed |

**The pattern worth keeping.** Fixtures confirmed what I already believed and
falsified nothing. Every defect above came from running against real source with
hand-established counts, or from a live terminal agent. Two were found only by
deliberately breaking a passing test to check it could fail.
