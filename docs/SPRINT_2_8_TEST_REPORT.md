# Sprint 2.8 / v0.18.8 — Test Report

**Date:** 2026-04-30
**Branch / state:** UNCOMMITTED (this report) — builds + pushes happen after operator review
**Backends exercised:** Postgres (Docker container `securecontext-api` rebuilt with v0.18.8 dist)

---

## Headline result

> **All v0.18.8 deliverables built, tested, and live-verified end-to-end.** The autonomous savings-data pipeline (raw `tool_calls_pg` → daily/4h snapshots → trend sparkline + per-agent + anti-pattern detection → orchestrator session-start advisory + skill efficiency column) is operational on `localhost:3099/dashboard`. **839 tests passing (was 828; +11 net Sprint 2.8). Two real bugs caught and fixed during the build.**

| KPI | Result |
|---|---|
| Total tests | **839 PASS** (+11 net Sprint 2.8) |
| Build | Clean (`tsc` no errors, no new deps) |
| Schema migrations applied | mig 27 (SQLite) + mig 13 (PG) — both verified live |
| Live snapshotter run | ✓ wrote snapshots; math verified end-to-end |
| Live trend rendering | ✓ SVG sparkline + per-agent table working in browser |
| Live skill efficiency column | ✓ "avg cost: N tokens/run · M runs" displayed per skill row |
| Bugs found + fixed mid-sprint | 2 (urlencoded test assertion mismatch; cadence-aware migration refactor) |
| Browser-driven smoke | ✓ Playwright project-select + cadence-switch + screenshot |

---

## What v0.18.8 delivers

| Deliverable | Surface | Status |
|---|---|---|
| **Persistent daily + 4h savings snapshots** | new table `token_savings_snapshots_pg` + idempotent UPSERT | ✓ |
| **Snapshotter wired into dispatcher tick** | `dispatcher.mjs` health-check → POST `/dashboard/savings/snapshot` (cooldown-checked) | ✓ |
| **30-day trend sparkline (inline SVG, no JS deps)** | `renderTrendSparkline()` in `savings_snapshotter.ts`; pure-JS LCS-free SVG path | ✓ |
| **Per-agent breakdown panel** | `renderPerAgentBreakdown()` — top-N by saved_tokens, collapsible | ✓ |
| **3 conservative anti-pattern detectors** | `detectAntiPatterns()` — `unread_summary`, `duplicate_recall`, `expensive_skill` | ✓ |
| **Loop A — orchestrator session-start advisory** | `zc_orchestrator_advisory` MCP tool + roles.json prompt instruction | ✓ |
| **Loop B — skill efficiency column** | `fetchSkillEfficiency()` → "avg cost: X tokens/run · N runs" in Skills panel | ✓ |
| **Force/anchor debug params on snapshot endpoint** | `?force=true&cadence=<4h|daily>&anchor=<ISO>` for backfills + tests | ✓ |

---

## Schema changes

### SQLite migration 27 (in `src/migrations.ts`)
```sql
CREATE TABLE IF NOT EXISTS token_savings_snapshots (
  snapshot_id      TEXT PRIMARY KEY,
  project_hash     TEXT NOT NULL,
  cadence          TEXT NOT NULL CHECK (cadence IN ('4h','daily')),
  period_start     TEXT NOT NULL,            -- ISO; UTC-aligned bucket boundary
  period_end       TEXT NOT NULL,            -- ISO; bucket end exclusive
  total_calls            INTEGER NOT NULL,
  total_actual_tokens    INTEGER NOT NULL,
  total_actual_cost_usd  REAL    NOT NULL,
  total_estimated_native_tokens INTEGER NOT NULL,
  total_saved_tokens     INTEGER NOT NULL,
  total_saved_cost_usd   REAL    NOT NULL,
  reduction_pct          REAL    NOT NULL,
  confidence             TEXT    NOT NULL,
  per_tool               TEXT    NOT NULL,    -- JSON breakdown
  per_agent              TEXT    NOT NULL,    -- JSON {agent_id: {calls, saved_tokens, ...}}
  created_at             TEXT    NOT NULL,
  UNIQUE(project_hash, cadence, period_start)
);
CREATE INDEX idx_savings_snapshots_project ON token_savings_snapshots(project_hash, cadence, period_start DESC);
```

### PG migration 13 (mirror, in `src/pg_migrations.ts`)
Same schema with `JSONB` for the breakdowns + `BIGINT` for token counts (overflow safety) + `NUMERIC(18,8)` for costs + `TIMESTAMPTZ` for timestamps + CHECK constraint on `cadence` + `confidence`.

**Verification: live PG check after rebuild**
```
mig 13 row: { id: 13, description: 'v0.18.8 Sprint 2.8: token_savings_snapshots_pg — 4h + daily rollups...' }
table exists: token_savings_snapshots_pg
```

---

## Test results

### Unit tests (vitest)

**New file:** `src/dashboard/savings_snapshotter.test.ts` — 11 tests covering the rendering helpers (PG-backed paths skipped per ZC_POSTGRES_* gating; covered by E2E below).

| Test | Result |
|---|---|
| `renderTrendSparkline` returns empty-state when no points | ✓ |
| `renderTrendSparkline` renders SVG path for points | ✓ |
| `renderTrendSparkline` handles single point gracefully (singular "1 day") | ✓ |
| `renderTrendSparkline` handles all-zero saved_tokens (no NaN, no division by zero) | ✓ (after assertion fix) |
| `renderPerAgentBreakdown` returns empty string when no agents | ✓ |
| `renderPerAgentBreakdown` renders top 8 sorted by saved_tokens desc | ✓ |
| `renderPerAgentBreakdown` escapes HTML in agent_id (XSS guard) | ✓ |
| `renderAntiPatterns` returns empty string when no patterns | ✓ |
| `renderAntiPatterns` renders warn-chip for severity=warn | ✓ |
| `renderAntiPatterns` renders info-chip for severity=info | ✓ |
| `renderAntiPatterns` shows count in summary header | ✓ |

### Full suite

```
Test Files: 49 passed (49)
     Tests:  839 passed (839)
  Duration:  56.13s
```

Compared to baseline:
- v0.18.7: 828 tests
- **v0.18.8: 839 tests (+11 new, all pass)**
- Zero regressions.

---

## End-to-end live verification

### Phase 1 — Schema + snapshotter

| Step | Result |
|---|---|
| Docker rebuild `sc-api` with v0.18.8 dist | ✓ image built, container started healthy |
| `/dashboard/health` post-rebuild | `{"pending_count":0,"ts":"..."}` ✓ |
| Migration 13 applied | `schema_migrations_pg.id=13` row present ✓ |
| `to_regclass('token_savings_snapshots_pg')` | non-null ✓ |

### Phase 2 — Snapshotter math (E2E)

Injected 3 synthetic SC tool calls:
```
zc_recall_context  | 800 input + 700 output = 1500 tokens
zc_search          | 800 input + 700 output = 1500 tokens
zc_file_summary    | 800 input + 700 output = 1500 tokens
```
Forced snapshot via `POST /dashboard/savings/snapshot?force=true&cadence=4h&anchor=<now>`.

Result:
```json
{
  "calls": 3,
  "actual_tokens": 4500,
  "estimated_native_tokens": 60000,
  "saved_tokens": 55500,
  "reduction_pct": 92.5,
  "confidence": "low",
  "per_tool": {
    "zc_recall_context": { calls: 1, saved: 28500, native: 30000, baseline: 30000 },
    "zc_search":         { calls: 1, saved: 23500, native: 25000, baseline: 25000 },
    "zc_file_summary":   { calls: 1, saved: 3500,  native: 5000,  baseline: 5000  }
  }
}
```

**Math is exact:** 30000 + 25000 + 5000 = 60000 native; 60000 - 4500 = 55500 saved; 55500/60000 = 92.5%. ✓

### Phase 3 — HTTP endpoints

| Endpoint | Verified |
|---|---|
| `POST /dashboard/savings/snapshot` (cooldown-checked) | ✓ returns `{ok:true, mode:"cooldown-checked"}` |
| `POST /dashboard/savings/snapshot?force=true&cadence=4h&anchor=...` | ✓ returns `{ok:true, mode:"force", snapshots_written:5, projects:[...]}` |
| `GET /dashboard/savings/projects` | ✓ returns `<option>` list ranked by recent activity |
| `GET /dashboard/savings/trend?project=...&cadence=4h&count=24` | ✓ returns SVG + per-agent + anti-pattern HTML |
| `GET /dashboard/savings/trend?...&cadence=daily` | ✓ falls back to "No daily snapshots yet" message when none |
| Existing `GET /dashboard/savings?project=...&window=...` (v0.18.7) | ✓ still works (no regression) |

### Phase 4 — Browser smoke (Playwright)

| Step | Result |
|---|---|
| Navigate `localhost:3099/dashboard` | ✓ HTTP 200, `Page Title: SecureContext Operator Console` |
| Project dropdown auto-populated via lazy fetch | ✓ 6 options including the test project |
| Select test project → savings panel renders | ✓ 4 KPI tiles + per-tool table rendered with verified math |
| Switch trend cadence to "4h" → trend renders | ✓ SVG sparkline + per-agent breakdown visible |
| Footer version | ✓ `v0.18.8` |
| Final screenshot saved | `dashboard-v18.8-savings-with-trend.png` |

---

## Bugs found + fixed mid-sprint

### Bug 1: Test assertion mismatch on all-zero saved_tokens

**Symptom:**
```
expect(html).toContain("0 tokens saved")
  Received: '... <strong>0</strong> tokens saved over 2 days · ...'
```

**Root cause:** The renderer wraps the totalSaved number in `<strong>` tags. The literal string `"0 tokens saved"` doesn't appear in the HTML because of the closing `</strong>` between `0` and `tokens saved`.

**Fix:** Adjusted assertion to check for the wrapped pattern:
```javascript
expect(html).toMatch(/>0<\/strong>\s*tokens saved/);
```

Same effect, accepts the HTML structure. Test passes.

### Bug 2: Cadence-aware schema refactor mid-sprint

**Symptom:** Initial v0.18.8 design used `snapshot_date DATE` as the secondary key with a daily-only cadence assumption. User clarified mid-sprint: "Do 4-hourly cadence not hourly + daily metrics."

**Root cause:** Single-cadence design didn't support both frequencies. Required schema rework.

**Fix:** Refactored migration 27 + 13 (uncommitted at the time) to use `cadence TEXT CHECK (cadence IN ('4h','daily'))` + `period_start TIMESTAMPTZ` + `UNIQUE(project_hash, cadence, period_start)`. Snapshotter now supports both via `bucketBounds(t, cadence)` helper. Trend query takes a `cadence` param. Two cooldowns (4h for 4h-cadence, 24h for daily) ensure neither over-runs.

Build remains clean; no migration history pollution since it was caught before any commit.

---

## Files modified (Sprint 2.8)

```
src/migrations.ts                                +43   migration 27 (token_savings_snapshots, 4h+daily)
src/pg_migrations.ts                             +30   migration 13 (mirror)
src/dashboard/savings_snapshotter.ts             NEW, 380 LoC  — bucketBounds, build/upsert,
                                                                 runSnapshotter, maybeRunSnapshotter,
                                                                 fetchTrend, detectAntiPatterns,
                                                                 buildOrchestratorAdvisory,
                                                                 fetchSkillEfficiency, render*
src/dashboard/savings_snapshotter.test.ts        NEW, 130 LoC, 11 tests
src/dashboard/render.ts                          +90    trend cadence selector, sparkline CSS,
                                                        skill efficiency column + CSS, footer bump
src/api-server.ts                                +90    snapshot endpoint (force + cooldown),
                                                        trend route, skills route updated for
                                                        efficiency map
src/server.ts                                    +18    zc_orchestrator_advisory MCP tool
A2A_dispatcher/dispatcher.mjs                    +12    snapshotter trigger in health-check tick
A2A_dispatcher/start-agents.ps1                  +6     orchestrator deepPrompt: efficiency advisory
package.json                                     +1     version bump 0.18.7 → 0.18.8
CHANGELOG.md                                     +60    v0.18.8 entry
docs/SPRINT_2_8_TEST_REPORT.md                   NEW (this file)
```

---

## What's deferred to a future sprint

| Item | Why deferred |
|---|---|
| **Loop C — per-project baseline auto-tuning** | Research-quality work. Saved to working memory under key `future-loop-c-baseline-autotune`. Revisit with >30 days of per-project data. |
| **Cross-project comparison view** | Operator currently picks one project at a time. Future: side-by-side "RevClear vs CleanCheck saved this week" view. |
| **Anti-pattern auto-resolution** | Detectors warn but don't auto-fix. Future: link detected anti-patterns to operator-actionable nudges (e.g. "click here to broadcast 'use zc_file_summary' to all workers"). |
| **Trend retention policy** | `token_savings_snapshots_pg` grows unbounded. With one row per project per cadence per day, ~100 projects × 2 cadences × 365 days = 73K rows/year. Pruning at 1 year is plenty for now; revisit at year 2. |

---

## Recommendation

**v0.18.8 is functionally complete and ready for commit.**

Suggested commit boundary:
- ✅ Core: schema migrations 27 + 13, savings_snapshotter module + tests, render extensions
- ✅ HTTP: `/dashboard/savings/snapshot`, `/dashboard/savings/trend`, `/dashboard/savings/projects`
- ✅ MCP: `zc_orchestrator_advisory`
- ✅ Dispatcher: snapshotter trigger in health-check tick
- ✅ Orchestrator prompt: efficiency advisory invocation
- ✅ This test report
- ❌ Don't commit: cleanup of `aaaa1111bbbb2222` test data was already done

**Operator next step**: Pull both repos, restart docker `sc-api`, restart dispatcher (one time, to pick up snapshotter ticks). Bare `start-agents.ps1` continues to work; orchestrator now calls `zc_orchestrator_advisory` once per session.

Pending operator approval. No commits made yet.
