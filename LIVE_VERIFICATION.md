# Live-Verification Ledger — CLOSED 2026-08-25

Operator-ordered tracking (2026-08-24), closed 2026-08-25T04:00Z after the
composite organic pass (session aafb4b02, real dispatcher-spawned terminal
agents, project Test_Agent_Coordination). Final agent report: MERGE #3658–#3660,
**9 PASS / 1 UNVERIFIED** — the one UNVERIFIED (D-9 operator-side half) is
closed below with dispatcher-log evidence only the operator holds.

Full agent evidence lives in hub memory: `acceptance_MEMSAFE_result` +
`acceptance_MEMSAFE_result_pt2` (project Test_Agent_Coordination). Commit under
test: SecureContext 0d4ab69 (T1, pushed) + 1cdcaf3 (T2, local) + dispatcher
043d3dd/a99dbb4 (pushed).

## T1 — Trustworthy autonomy — ALL VERIFIED

| ID | Change | Closing evidence |
|----|--------|------------------|
| T1-a | Adjudicator → advisory when AUTO_RESOLVE off | Organic flag observed live: "probe_keep_export ⇄ probe_removed_export [semantic_conflict, sim=0.94] — LLM advisory: likely update … (auto-resolve disabled; operator decides)". `resolution_mode='auto'` count stable at 81 across the whole pass (see baseline note). Advisory open flags: 6. |
| T1-b | ★5 immunity at PG retire choke-point | Live probe: retire attempt REFUSED (`star5_retire_refused` logged); zero ★5 retirements through `_retireFactByHash` during the pass. NOTE: pass also exposed a bypass of this choke-point — see T1-g. |
| T1-c | ★5 immunity — SQLite mirror | SQLite-mode probe: fact survived auto-retire path (pre-pass probe, evidenced in session log). SQLite has no TTL sweep, so no T1-g analogue exists there. |
| T1-d | Subject-binding (SEMANTIC_MIN_OVERLAP=0.15) | Positive half: genuine reversal pair (probes verbatim, ≥90s apart) flagged (criterion #4 PASS). Negative half: no false-positive flag joining unrelated `probe_star5_shipped`+`probe_summary_tail` (criterion #5 PASS). |
| T1-e | autoResolveVictim precondition validation | No auto victims produced anywhere in the pass while AUTO_RESOLVE off (subsumed by T1-a/T1-d). |
| T1-f | Consolidation merge-veto preserved | Live cycle: true paraphrase merged (`cprobe_para_b` RETIRED(consolidated)); planted polarity pair both stayed LIVE (veto held). |

## T2 — Token-efficiency harness — ALL VERIFIED (commit 1cdcaf3 + working-tree fixes)

| ID | Change | Closing evidence |
|----|--------|------------------|
| T2-a | hooks/manifest.json single source; init.mjs reads it | Live `node init.mjs` re-run: 14/14 registrations skipped as already-present, settings.json byte-identical. (First live run caught the matcher-normalization dedup bug — fixed, in this commit.) |
| T2-b | Auto-extract active on fresh CLI installs | Pipeline proven end-to-end: harness-contract invocation extracted 4 facts via Ollama distill → `/api/v1/remember`. 12-day organic silence root-caused to env-less sessions; settings.json fallback + `_skipped.log` deployed (this commit). |
| T2-c | ps1 hooks platform-gated, runner-aware | Live init on win32 registered `session-start-index-check.ps1` via powershell runner; linux path unit-tested only (noted, not live-verifiable here). |
| T2-d | Uninstall covers .ps1 hooks | Double-sandboxed uninstall: ps1 removed in sandbox; real `~/.claude` and desktop config diff-verified untouched. |
| T2-e | plugin.json parity tripwire | Local mutation check: test fails when plugin.json edited. CI-level, no live component. |

## D-9 — Dispatcher class-9 escalation — VERIFIED (both halves)

Worker-side (agent evidence, criterion #8): question #3655 held 4m15s while the
worker stayed CONTINUOUSLY active — zero disruptive notices reached worker or
orchestrator. Operator-side (dispatcher log, closes the "1 UNVERIFIED"):
`OPERATOR_INBOX [aafb4b02] #3655 — worker question unanswered 2 min —
auto-escalated` + `OPERATOR_INBOX_API_OK #3655 — visible on the dashboard`
(02:59:02Z, 2m05s after the question, test env A2A_QUERY_INBOX_MS=120000).
Escalation triggers on question AGE with an active worker — the exact class-9
defect shape, now closed. Dispatcher commits 043d3dd + a99dbb4 pushed.

## Found BY the pass (new, open)

| ID | Finding | Status |
|----|---------|--------|
| T1-g | **TTL sweep bypasses the ★5/pinned guard**: the enrichment-cycle `UPDATE … retired_reason='expired'` doesn't route through `_retireFactByHash`, so it expired ★5 `acceptance_prod-hardening-1.0` (02:26Z) despite T1-b. FIXED in working tree: sweep WHERE now repeats the choke-point refusals (★5 unless ZC_STAR5_RETIRE=1; pinned kinds derived from PINNED_KINDS). Tripwire below. The expired ★5 fact is left retired (revivable) — it carried both ★5 and an explicit TTL; operator decides whether to revive. | Fixed, NOT live-verified |
| A2A-gate | Acceptance gate rejects staged-but-uncommitted files as "untracked or missing" — bounced three valid MERGEs (#3658–#3660) until the orchestrator hand-verified. A2A_dispatcher backlog, not SC. | Open (A2A) |
| O1–O8 | Agent-reported oddities, raw: O1 contradiction surfaced on 3rd recall not 2nd; O2 contradiction section oscillated 9→0→1 pairs; O3 three inconsistent auto-apply phrasings across surfaces; O4 probe keys tail-collapsed despite focus relevance; O5 namespace count divergence (recall 69/146 vs remember 5/146); O6 bare `git diff` empty for untracked files (agent-side git note, not SC); O7 pinned budget overflow 14 > ZC_PINNED_MAX_FACTS=12; O8 context compaction mid-probe at t+111s. | Triage backlog |

## Baseline anomaly — RESOLVED

The captured baseline "auto-retirements: 496" was a mis-scoped read (a
dashboard/status counter over a different population), not this ledger's
canonical query. Canonical `resolution_mode='auto'` = **81 at every read across
the pass** (start, mid, close) — the invariant that matters (no new automatic
retirements) held. Current distribution for the record: not_conflict 461,
auto-llm 289, auto 81, blank 44, purge-marker modes 36. Working-memory retired
rows: expired 124, ttl_backfill 24, superseded 8, consolidated 2, forgotten 1.

## Standing tripwires (run at any future pass)
- `SELECT COUNT(*) FROM memory_contradictions_pg WHERE resolution_mode='auto'` — must stay 81 (or move only with an operator action recorded).
- ★5 integrity incl. the T1-g sweep: `SELECT COUNT(*) FROM working_memory WHERE importance>=5 AND valid_to > '<window-start>' AND retired_reason IN ('superseded','consolidated','expired')` — must be 0.
- Advisory-only autonomy: `status='open' AND detail LIKE 'LLM advisory%'` grows, `resolution_mode='auto'` doesn't.
- Auto-extract: Stop-hook facts 7d > 0 on any machine with the env or settings.json fallback present; `_skipped.log` empty.
