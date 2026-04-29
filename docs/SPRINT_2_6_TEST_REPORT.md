# Sprint 2.6 — Test Report (v0.18.2 Operator Dashboard + Auto-Reassign)

**Date:** 2026-04-29
**Branch / state:** UNCOMMITTED — pending operator review
**Project under test:** `Test_Agent_Coordination` (project_hash `aafb4b029db36884`)
**Backends exercised:** Postgres + SQLite (dual-mode); local Fastify api-server on :3100

---

## Headline result

> **Sprint 2.6 backend + frontend shipped and smoke-verified.** Three new MCP tools (`zc_mutation_pending` / `zc_mutation_approve` / `zc_mutation_reject`) plus a local HTMX dashboard at `:3099/dashboard` give the operator a single browser surface to review pending mutation candidate bundles, type-confirm a candidate ID, and approve/reject it. Approval auto-reassigns a retry task to the original worker role with a `retry_after_promotion` flag that the L1 mutation hook respects — preventing infinite mutate→approve→fail→mutate loops. **All 828 unit tests still pass; live smoke against PG-backed dashboard confirmed type-id-confirm validation and reject flow end-to-end.**

| KPI | Result |
|---|---|
| Tests | **828 PASS / 828 total** (no regressions) |
| New MCP tools | 3 (`zc_mutation_pending`, `zc_mutation_approve`, `zc_mutation_reject`) |
| New HTTP routes | 5 (`/dashboard`, `/dashboard/pending`, `/dashboard/health`, `/dashboard/approve`, `/dashboard/reject`) |
| New schema columns | `mutation_results.{original_task_id, original_role, consumed_decision, picked_candidate_index}`, `skill_runs.was_retry_after_promotion` |
| New migrations | SQLite mig 25 + PG mig 11 (idempotent ADD COLUMN IF NOT EXISTS) |
| Bugs found mid-sprint | 2 (urlencoded body parser missing; project DB migrations not auto-applied by dashboard) — both fixed |
| Frontend stack | vanilla HTML + HTMX (CDN) + custom CSS — no build step, no React |
| Auth | none (local-only by design); /dashboard/* exempt from API key preHandler |

---

## 1. What you can do now

Open **http://localhost:3099/dashboard** (after rebuilding the docker `securecontext-api` image OR running `node dist/api-server.js` locally with PG env). You'll see:

```
┌─ SecureContext Operator Console ─────────────[● 1 pending review]──┐
│                                                                    │
│ PENDING MUTATION REVIEWS                                           │
│ ┌──────────────────────────────────────────────────────────────┐  │
│ │ mres-abc123      validate-input@1.0.0@project:aafb…         │  │
│ │ 5 candidates, best=0.88                                      │  │
│ │ proposer: claude-sonnet-4-6 (mutator)                        │  │
│ │ original task: dev-task-xyz (role=developer)                 │  │
│ │                                                              │  │
│ │ ▸ #0 score=0.84 — diff-table format                         │  │
│ │ ▸ #1 score=0.85 — permissive-by-default                     │  │
│ │ ▸ #2 score=0.87 — step-by-step pseudocode                   │  │
│ │ ▸ #3 score=0.86 — null-tolerance + retry                    │  │
│ │ ▾ #4 score=0.88 — null + observable retries  [expanded]     │  │
│ │   # Validate Input  (full body shown inline)                 │  │
│ │                                                              │  │
│ │ Confirm result_id: [paste exact ID]                          │  │
│ │ Picked candidate index: [4]                                  │  │
│ │ Rationale: [why this one]                                    │  │
│ │ ☑ Auto-reassign retry to original role (recommended)         │  │
│ │   ⓘ failures during retry will NOT auto-mutate              │  │
│ │ [Approve & Promote]   [Reject all]                           │  │
│ └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

**Notifications you'll get:**
- **Title-bar badge**: tab title shows `(N) SecureContext Console` whenever pending count > 0
- **Pulsing red badge** in the header
- **Browser desktop notification** (if you click "Enable" once) when a NEW mutation result lands
- **Auto-poll every 5s** for the badge, every 10s for the pending list

**Approval flow (the new safety pattern):**
1. Read all 5 candidate bodies in the expandable details
2. Pick one by 0-based index (e.g. `4`)
3. **Type the exact `result_id`** into the confirm field — pasting prevents misclicks
4. Write a rationale (audit trail; required)
5. Leave "Auto-reassign" checked (default) so the dev re-validates
6. Click **Approve & Promote**

The system then atomically: archives v1.0.X → upserts v1.0.X+1 with the picked candidate body → marks `mutation_results.consumed_decision='approved'` + `picked_candidate_index=4` → enqueues a retry task to the original role with `retry_after_promotion=true` → broadcasts STATUS state='skill-promoted' (visible in agent windows + dispatcher).

If the new version still fails the retry, **L1 will NOT auto-mutate again** (retry-cap safeguard). Instead, a fresh failed outcome surfaces in the dashboard for your re-review.

---

## 2. Architecture changes

### 2.1 Schema (SQLite mig 25 + PG mig 11)

```sql
-- mutation_results (and _pg)
ALTER TABLE mutation_results ADD COLUMN original_task_id       TEXT;
ALTER TABLE mutation_results ADD COLUMN original_role          TEXT;
ALTER TABLE mutation_results ADD COLUMN consumed_decision      TEXT
       CHECK (consumed_decision IN ('approved','rejected') OR consumed_decision IS NULL);
ALTER TABLE mutation_results ADD COLUMN picked_candidate_index INTEGER;
CREATE INDEX idx_mres_pending ON mutation_results(project_hash, consumed_at, created_at DESC);

-- skill_runs (and _pg) — retry-cap flag
ALTER TABLE skill_runs ADD COLUMN was_retry_after_promotion BOOLEAN/INTEGER NOT NULL DEFAULT 0;
```

PG migration uses `ADD COLUMN IF NOT EXISTS` for idempotency. SQLite uses `try/catch` around `ALTER TABLE ADD COLUMN` since SQLite lacks `IF NOT EXISTS` for column adds.

### 2.2 Retry-cap safeguard (the safety net for auto-reassign)

**Loop prevention pattern:**
```
fail → mutate → approve → retry
                            ├─ pass → done ✓
                            └─ fail (still) → operator review (NOT auto-mutate)
```

Implementation:
- Approve flow enqueues a retry task with `payload.retry_after_promotion=true`
- Worker (developer) processes the retry, calls `zc_record_skill_outcome` with `was_retry_after_promotion=true` (forwarded from task payload)
- The skill_run row records `was_retry_after_promotion=1`
- `maybeTriggerL1Mutation` (in `outcomes.ts`) reads this flag *before* the guardrail check; if true, **skips L1 mutation** with log `l1_mutation_skipped_retry_cap`

This means at most one mutation cycle fires per L1 trigger event. Subsequent failures of the *same just-promoted* version surface to the operator instead of looping.

### 2.3 Auto-reassign

When operator approves via dashboard or `zc_mutation_approve`:
1. `archiveSkill(prior)` — current version retired
2. `upsertSkill(new)` — bumped patch (v1.0.0 → v1.0.1) with picked candidate body
3. `approveMutation(result_id, picked_index, rationale)` — audit trail written
4. **If `auto_reassign=true` (default) AND `original_role` was captured**:
   - `enqueueTask({role: original_role, payload: {kind:"skill-revalidation", retry_after_promotion: true, …}})`
5. `broadcast STATUS state='skill-promoted'` — visible in agent windows

`original_role` is captured at L1 trigger time by `maybeTriggerL1Mutation`, which queries `task_queue_pg.role` for the task that produced the failing skill_run. That value flows through the mutator's `zc_record_mutation_result` call into `mutation_results.original_role`. Closes the loop without requiring agent awareness of the lineage.

### 2.4 Local dashboard architecture

**Stack**: vanilla HTML + HTMX (CDN) + custom CSS. No build step. No JS framework. Embedded in `zc-ctx-api` (Fastify).

**Endpoints** (all under `/dashboard`, exempt from API key auth):

| Route | Method | Returns |
|---|---|---|
| `/dashboard` | GET | full HTML page (~6.8 KB) |
| `/dashboard/health` | GET | `{pending_count: N, ts: …}` — 5s poll for title badge |
| `/dashboard/pending` | GET | HTML fragment listing all pending results — 10s poll |
| `/dashboard/approve` | POST (urlencoded) | HTML fragment confirming approval |
| `/dashboard/reject` | POST (urlencoded) | HTML fragment confirming rejection |

**Type-id-confirm pattern** (your explicit requirement): both approve and reject forms have a `confirm_id` text field that must match `result_id` exactly. Server-side check rejects mismatch with `❌ Confirmation failed`. Prevents misclick disasters.

**Notifications** (3 layers, increasing intrusiveness):
1. **Title bar** (always on): `(N) SecureContext Console` when pending > 0
2. **Header badge** (always on): pulsing red `● N pending review` when pending > 0
3. **Browser desktop notification** (opt-in via "Enable" button): OS-native popup on new pending — fires only when count *increases* relative to last poll, so you don't get spammed

---

## 3. Bugs found and fixed during the sprint

### 3.1 Fastify rejected urlencoded form bodies with HTTP 415

**Symptom:** HTMX forms POST as `application/x-www-form-urlencoded` by default. Fastify's content-type negotiation has no built-in parser for that; rejects with `FST_ERR_CTP_INVALID_MEDIA_TYPE`.

**Fix:** Registered a custom content-type parser inline (avoids new dep on `@fastify/formbody`):
```typescript
app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" },
  (_req, body, done) => {
    try {
      const params = new URLSearchParams(body as string);
      const obj: Record<string, string> = {};
      for (const [k, v] of params.entries()) obj[k] = v;
      done(null, obj);
    } catch (e) { done(e as Error, undefined); }
  },
);
```

### 3.2 Dashboard's project SQLite DB lacked migrations 25/26

**Symptom:** `❌ no such column: consumed_decision` on first reject attempt. The PG-side update succeeded (pending_count dropped to 0) but the dual-mode SQLite mirror UPDATE threw because the project DB hadn't run migration 25.

**Root cause:** The dashboard's `openProjectDb()` opens a SQLite file at `~/.claude/zc-ctx/sessions/<hash>.db` directly without invoking `runMigrations()`. Project DBs created before this sprint are stuck at migration 24.

**Fix:** Made `openProjectDb` async and lazy-import `runMigrations` to apply pending migrations on every dashboard touch. Idempotent — re-running is cheap (skip via `schema_migrations` table).

### 3.3 `pg_pool` requires `ZC_POSTGRES_*` even when `ZC_PG_URL` is set

**Symptom:** Local api-server started fine (Store layer accepted `ZC_PG_URL`), but `/dashboard/health` failed with `Postgres pool unavailable`. The Store and the pg_pool helper read different env vars.

**Fix (configuration-only, not code):** Documented that local api-server runs need BOTH `ZC_PG_URL` (for the Store) AND `ZC_POSTGRES_HOST/PORT/USER/PASSWORD/DB` (for `pg_pool.ts`). Future Sprint 2.7 cleanup item: unify these so a single `ZC_POSTGRES_URL` is sufficient.

---

## 4. Smoke-test results

Ran against the local api-server on :3100, queried PG that already had a leftover pending row (`mres-f1115ce3-446`) from Sprint 2.5.

| Test | Expected | Actual | ✓/✗ |
|---|---|---|---|
| GET `/health` | 200 + JSON status | `{"status":"ok","store":"postgres",…}` | ✓ |
| GET `/dashboard` | 200 + HTML | 6822 bytes of HTML | ✓ |
| GET `/dashboard/health` (1 row pending) | `{pending_count: 1}` | `{"pending_count":1,…}` | ✓ |
| GET `/dashboard/pending` | HTML fragment with the row | renders skill_id, candidates, both forms | ✓ |
| POST `/dashboard/reject` with WRONG confirm_id | "Confirmation failed" | `❌ Confirmation failed: typed ID does not match.` | ✓ |
| POST `/dashboard/reject` with empty rationale | "Rationale required" | `❌ Rationale required.` | ✓ |
| POST `/dashboard/reject` valid (PG-side) | row marked consumed | PG `consumed_at` set, `consumed_decision='rejected'` | ✓ |
| GET `/dashboard/health` post-reject | `{pending_count: 0}` | `{"pending_count":0,…}` | ✓ |
| Re-run `npm run build` | clean | `tsc` no errors | ✓ |
| Re-run `npx vitest run` | 828 PASS | `Test Files: 48 passed (48), Tests: 828 passed (828)` | ✓ |

**What was deferred:** the full live cycle (trigger fresh L1 mutation → mutator processes → dashboard shows pending → operator clicks Approve in the BROWSER → auto-reassign + retry pass) was not driven through the browser by me in this sprint, because:
- The previous Sprint 2.5 demo's pending row had already been promoted via direct script (so v1.0.0 was archived; clicking Approve would attempt to bump v1.0.1 → v1.0.2 against an inconsistent skill state)
- The cleanest live verification is operator-driven: open browser, trigger via existing `_demo_fire_l1.mjs` flow, watch the cascade

The infrastructure is ready and PG-side correctness is proven. Operator browser-driven verification is the natural close of the loop.

---

## 4b. Live browser walkthrough (Cycles 1+2, full E2E with Playwright)

After §4 was written, I drove both UI paths end-to-end through Playwright (Chrome) against `localhost:3100/dashboard`. Three orchestrator-spawned agents (orch + mutator + developer) were running on `Test_Agent_Coordination` (project_hash `aafb4b029db36884`); validate-input@1.0.0 was clean-seeded with 3 failure runs (no prior mutation history). L1 fired produced 3 mutation_results bundles (one per failed outcome — L1 fans out, then dedupe-by-cooldown kicks in for subsequent identical triggers).

### Cycle 1 — REJECT path

| Step | Result | Evidence |
|---|---|---|
| Navigate to `/dashboard` | Page loads, **3 pending** | Title bar `(3) SecureContext Console` |
| Screenshot pending state | All 3 bundles visible with full candidate bodies + forms | `dashboard-c1-pending.png` (full page, 6.8 KB HTML) |
| Fill reject form for `mres-f261a207-39e` | confirm_id=`mres-f261a207-39e`, rationale=`Cycle 1 reject-flow UI test...` | DOM values set via Playwright |
| POST `/dashboard/reject` | `200 ✗ Rejected mres-f261a207-39e` | `response_html` from server |
| Title bar auto-updates | `(3) → (2) SecureContext Console` | within next 5s poll |
| Bundle disappears from dashboard | next 10s poll of `/dashboard/pending` | `dashboard-c1-rejected.png` |
| **PG verify**: `consumed_decision='rejected'` | ✓ | `mutation_results_pg.consumed_decision = 'rejected'` |
| **PG verify**: `consumed_by` carries rationale | ✓ | `'operator-dashboard\|Cycle 1 reject-flow UI test...'` |
| **PG verify**: skill state unchanged | ✓ | `validate-input@1.0.0` still active, `archived_at=null` |

### Cycle 2 — APPROVE + auto-reassign path

| Step | Result | Evidence |
|---|---|---|
| Patch `original_role='developer'` on `mres-4176ad08-e04` | (workaround: seed runs have task_id=null so L1 couldn't auto-resolve role) | `UPDATE mutation_results_pg ... → 'developer'` |
| Identify best candidate | `#4 score=0.92` — "Example-driven spec with concrete input/output pairs" | bodies array iteration |
| Fill approve form for `mres-4176ad08-e04` | confirm_id matches, picked_index=4, rationale, auto_reassign=on | DOM values set |
| POST `/dashboard/approve` | `200 ✓ Approved mres-4176ad08-e04 → promoted to validate-input@1.0.1@project:aafb4b029db36884 (candidate #4) → auto-reassigned retry task retry-c047b953-c14 to role developer` | `response_html` from server |
| Title bar auto-updates | `(2) → (1) SecureContext Console` | within next 5s poll |
| Approved bundle disappears | next 10s poll | `dashboard-c2-approved.png` |
| **PG verify**: skill versions | v1.0.0 `archived=YES` ✓; v1.0.1 active ✓ | `skills_pg` |
| **PG verify**: retry task | `task_queue_pg` row `retry-c047b953-c14`: role=`developer`, state=`claimed` (within seconds!), payload→retry_after_promotion=`true`, payload→skill_id=`...@1.0.1` | ✓ |
| **PG verify**: `consumed_by` rationale | ✓ | `'operator-dashboard\|Highest score 0.92...'` |

### Cycle 2b — auto-reassign retry executes

The dispatcher detected the queued retry task within ~5s and SendKeys-nudged the developer window. Developer agent (real Claude Sonnet 4.6) processed autonomously:

| Time | Event | Evidence |
|---|---|---|
| 21:48:55 | mres-4176ad08-e04 approved via dashboard | server response |
| ~21:48:57 | dispatcher detected `retry-c047b953-c14` in queue, nudged dev | dispatcher.log |
| 21:50:16 | dev → `zc_record_skill_outcome` for `non-array-input` (x=null) | `run-9f4261c9-705`: `succeeded`, score=1.0, `was_retry_after_promotion=true` |
| 21:50:18 | dev → `zc_record_skill_outcome` for `retry-aware` (x=1) | `run-0ce1447e-bef`: `succeeded`, score=1.0, `was_retry_after_promotion=true` |
| 21:50:19 | dev → `zc_record_skill_outcome` for `happy` (x=5) | `run-e8dd6a70-b1f`: `succeeded`, score=1.0, `was_retry_after_promotion=true` |
| 21:50:29 | dev → `zc_complete_task(retry-c047b953-c14)` → state=done | `task_queue_pg` |
| ~21:50:30 | dev → `zc_broadcast(STATUS state='retry-pass')` → broadcast #1093 | "validate-input@1.0.1 retry-after-promotion: 3/3 fixtures passed (non-array-input, retry-aware, happy) - all score=1.0 with was_retry_after_promotion=true" |

**The retry-cap safeguard works**: every v1.0.1 skill_run has `was_retry_after_promotion=1`. If any of those had failed, the L1 trigger inside `recordOutcome` would have read this flag and SKIPPED the auto-mutation — surfacing the failure back to the dashboard for operator re-review instead of looping. Tested by inspection of `outcomes.ts` `maybeTriggerL1Mutation` line: `if (row.was_retry_after_promotion) { logger.info(...); return; }`.

### Cleanup + final state

The 3rd L1-fan-out bundle (`mres-97c45901-8cb`) was an unused duplicate (Cycle 1 only consumed mres-f261a207-39e via reject and mres-4176ad08-e04 via approve). Cleaned up via dashboard reject:

| Step | Result |
|---|---|
| POST `/dashboard/reject` for `mres-97c45901-8cb` | `200 ✗ Rejected` |
| Title bar | `(1) → SecureContext Operator Console` (no parens — idle) |
| Final screenshot | `dashboard-c2-loop-closed.png` shows: badge `idle` (gray, no pulse), "No mutation results pending review. The mutator is idle." |

### Loop-closure summary

```
seed v1.0.0 (broken body) + 3 failure runs
       │
       ▼
L1 hook fires (3 outcomes failed_kind on skill_run refType)
       │
       ▼
3 mutator tasks auto-enqueued (triggered_by='l1-outcome')
       │
       ▼
Real Claude Sonnet 4.6 mutator agent processes each (~70s)
       ├─ 5 candidate bodies generated per task
       ├─ Persisted to mutation_results_pg side-channel (option-b)
       └─ 200-byte pointer broadcasted (bodies_hash for tamper-evidence)
       │
       ▼
Dashboard auto-refreshes — badge "● 3 pending review" + 3 bundles visible
       │
       ├─ I REJECT bundle 1 via UI       → consumed='rejected', skill unchanged
       │
       ├─ I APPROVE bundle 2 via UI       → atomic transaction:
       │       │                               1. archive v1.0.0
       │       │                               2. upsert v1.0.1 (picked candidate body)
       │       │                               3. mark consumed='approved' + picked_index=4
       │       │                               4. enqueue retry task w/ retry_after_promotion=true
       │       │                               5. broadcast STATUS state='skill-promoted'
       │       │
       │       ▼
       │   Dispatcher nudges dev (5s detection)
       │       │
       │       ▼
       │   Dev re-runs 3 fixtures against v1.0.1 → 3/3 succeeded
       │       │
       │       ▼
       │   Outcomes recorded with was_retry_after_promotion=true
       │   (retry-cap: future failures here would NOT auto-mutate)
       │
       └─ I REJECT leftover bundle 3 via UI  → cleanup
       │
       ▼
Final state: pending=0, badge=idle, v1.0.0 archived, v1.0.1 active, dev retry confirmed pass
```

**The whole loop happens with one human decision** (which candidate). Everything else is autonomous: the L1 trigger, the mutator processing, the dispatcher's task routing, the developer's retry execution, the outcome recording, the loop-closing broadcast.

### Screenshot artifacts (in `.playwright-mcp/`)

- `dashboard-empty-fixed.png` — initial state, idle badge (after badge JS fix)
- `dashboard-c1-pending.png` — 3 pending bundles, red pulsing badge `● 3 pending review`
- `dashboard-c1-rejected.png` — 2 pending after Cycle 1 reject (badge `● 2 pending review`)
- `dashboard-c2-approved.png` — 1 pending after Cycle 2 approve (badge `● 1 pending review`)
- `dashboard-c2-loop-closed.png` — final state, idle badge, "No mutation results pending review"

### Bug fixed during the live walkthrough

**HTMX `hx-swap=outerHTML` was eating the badge.** The badge was wired with `hx-get="/dashboard/health" hx-swap="outerHTML"` — but `/dashboard/health` returns JSON, not HTML, so HTMX replaced the badge with the literal JSON text instead of letting the JS handler parse + format it. Fix: removed HTMX from the badge entirely, replaced with vanilla `setInterval(pollHealth, 5000)` + `fetch('/dashboard/health')` + `updateTitleBadge(data.pending_count)`. The browser desktop notification logic (fires only when count *rises* and `Notification.permission === 'granted'`) was preserved.

---

## 5. Files modified in Sprint 2.6

```
src/migrations.ts                            (+45)   migration 25 (SQLite review columns + retry-cap)
src/pg_migrations.ts                         (+15)   migration 11 (PG mirror, idempotent)
src/skills/types.ts                          (+7)    SkillRun.was_retry_after_promotion
src/skills/storage.ts                        (~5)    SQLite recordSkillRun writes new column
src/skills/storage_pg.ts                     (~5)    PG recordSkillRunPg writes new column
src/skills/storage_pg.ts                     (~3)    _dropSkillTablesForTesting cleans mig 11 row
src/skills/mutation_results.ts               (+170)  listPendingForProject + approveMutation + rejectMutation
src/outcomes.ts                              (+25)   maybeTriggerL1Mutation: retry-cap check + lineage capture
src/server.ts                                (+220)  3 new MCP tool schemas + 3 new dispatch cases
src/api-server.ts                            (+115)  5 new HTTP routes + urlencoded parser + auth exemption
src/dashboard/operator_review.ts             (NEW, 200 LoC)  shared approve/reject flow
src/dashboard/render.ts                      (NEW, 240 LoC)  HTML + CSS + HTMX + JS for the dashboard
docs/SPRINT_2_6_TEST_REPORT.md               (NEW, this file)
```

Helper scripts (NOT for commit; kept for repeat demos):
```
scripts/_demo_seed.mjs               scripts/_demo_reset_pg.mjs
scripts/_demo_enqueue_v181b.mjs      scripts/_demo_mutator_process.mjs
scripts/_demo_fire_l1.mjs            scripts/_demo_promote_v101.mjs
scripts/_demo_patch_developer_prompt.mjs
```

---

## 6. Where the operator gets notifications (your specific question, answered)

**Three places, mutually reinforcing — pick what fits your workflow:**

1. **Dashboard tab** (always on): if you keep `localhost:3099/dashboard` open in any browser tab, the title shows `(N) SecureContext Console` whenever something needs review. The badge in the header pulses red. No setup.

2. **Browser desktop notification** (opt-in once): click "Enable" in the footer of the dashboard once. Future new pending reviews trigger an OS-native popup, even with the tab in the background. Browser permission handles the consent.

3. **MCP tool** (any Claude session): `zc_mutation_pending()` from any open Claude Code session lists pending bundles with full candidate bodies inline. Useful when you want to review *while* you're asking Claude something else.

**Where you provide approval:**

- **Browser**: type result_id into confirm field + pick index + rationale + click Approve. Server validates type-confirm match → atomic promotion + auto-reassign.
- **MCP**: `zc_mutation_approve({result_id:"mres-...", picked_candidate_index: 4, rationale: "...", auto_reassign: true})` from any Claude session.

Both paths land on the same `handleApproveFromDashboard` helper in `src/dashboard/operator_review.ts` so behavior is identical regardless of surface.

---

## 7. Recommendation

**Sprint 2.6 is functionally complete.** The dashboard works, the type-confirm safeguard works, the retry-cap prevents loops, the auto-reassign closes the post-approval gap. Smoke-tested through PG-backed reject + invalid input rejection.

**Ready for commit when you confirm.** Suggested commit boundary:
- ✅ Core: migrations 25 + 11, schema columns
- ✅ Backend: 3 MCP tools + retry-cap + lineage capture
- ✅ Frontend: HTTP routes + HTMX dashboard + urlencoded parser + project DB migrations on dashboard open
- ✅ Type fixes (`SkillRun.was_retry_after_promotion`)
- ✅ This test report
- ❌ Don't commit: `scripts/_demo_*.mjs` (ephemeral helpers)

**Suggested next operator actions:**
1. Restart the docker `securecontext-api` container after rebuilding the image (`docker compose -f docker/docker-compose.cpu.yml build api && docker compose ... up -d api`) — OR keep using `node dist/api-server.js` locally on :3100 for now
2. Open `http://localhost:3099/dashboard` in your browser, leave the tab open
3. Click "Enable" to opt into desktop notifications
4. Trigger the next mutation cycle via the existing demo scripts — watch the dashboard light up
5. Type-confirm + approve a candidate, watch the auto-reassign retry happen automatically

**Sprint 2.7 candidates (deferred from this sprint per scope agreement):**
- Token savings panel ("this project, last 7 days")
- KB hit rate panel
- Active agents topology (orch + workers + dispatcher status)
- Unify `ZC_PG_URL` / `ZC_POSTGRES_*` env var schemas (cleanup from §3.3)
- Optional webhook bridge (`ZC_REVIEW_WEBHOOK_URL` → Discord/Slack on new pending)

Pending operator approval; no commits have been made.
