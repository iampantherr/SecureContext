# Live-Verification Ledger

Operator-ordered tracking (2026-08-24): every change below is implemented and
unit/CI-verified but **NOT yet live-verified against organic traffic**. The
operator will order one comprehensive live-verification pass; each item lists
the exact evidence that closes it. An item moves to VERIFIED only on observed
live evidence, never on the passing suite. Regression scope rides each item so
the pass also asserts we broke nothing adjacent.

**Baseline captured 2026-08-25T02:12Z:** auto-extract facts (7d): 0 on this
CLI machine wait — see note; total facts 7d: 5; auto-retirements (historical
total): 496 — this number moving is itself an alarm; open contradictions: 40;
userprompt autoextract buffers present: yes (`~/.claude/zc-ctx/autoextract/*.buf`
exist — prompts buffer, but Stop-side extraction yields no facts: consistent
with issue #5's "inert on CLI" for the extraction half).

## T1 — Trustworthy autonomy (pushed as 0d4ab69; synthetic-container-verified, organic pending)

| ID | Change | Live evidence required | Regression scope to watch |
|----|--------|------------------------|---------------------------|
| T1-a | Adjudicator "update" → advisory when AUTO_RESOLVE off | An organic contradiction scan produces an OPEN flag whose detail carries "LLM advisory: likely update" — and `resolution_mode='auto'` count stays 496 | Compatible-verdict suppression still works (dismissed/auto-llm rows still appear); triage queue doesn't balloon |
| T1-b | ★5 immunity at PG retire choke-point | `star5_retire_refused` line in api logs during an organic scan, OR 7 days of scans with zero ★5 valid_to changes | TTL expiry of ★1-4 facts still works; operator zc_forget of a ★5 still works |
| T1-c | ★5 immunity — SQLite mirror (parity) | A SQLite-mode session (no ZC_API_URL) attempts an auto-retire path; fact survives | SQLite retire of ★1-4 still works |
| T1-d | Subject-binding on polarity conflicts (SEMANTIC_MIN_OVERLAP=0.15) | Organic scans over 48h: no new open flag joining two facts with token-jaccard < 0.15; corpus-shape pairs (summaries near records) stay unflagged | GENUINE conflicts still flag: plant one real reversal pair (same subject, "keep X"/"removed X") in a scratch project and observe it flag |
| T1-e | autoResolveVictim precondition validation | Covered by T1-a/T1-d evidence (no victims at all while AUTO_RESOLVE off) | — |
| T1-f | Consolidation merge-veto preserved (raw polarity) | One enrichment/consolidation cycle: no merged pair with opposite polarity; consolidation still merges true paraphrases (count > 0 over the window if candidates exist) | Consolidation throughput unchanged (±) |

## T2 — Token-efficiency harness (LOCAL COMMIT ONLY — not pushed, not registered)

| ID | Change | Live evidence required | Regression scope to watch |
|----|--------|------------------------|---------------------------|
| T2-a | hooks/manifest.json = single source; init.mjs reads it | Run `node init.mjs` on this machine: registration diff shows exactly the manifest set, dedup skips the 14 already-present, no duplicates created | Existing registrations untouched (diff settings.json before/after); session still boots with all hooks firing |
| T2-b | Auto-extract active on fresh CLI installs | THE 0→>0 METRIC: after init + one real work session, Stop-hook extraction produces ≥1 auto-extracted fact (baseline: buffers exist, extracted facts 7d = 0) | Extracted facts are sane (spot-read 3); no duplicate-fact flooding; session Stop latency acceptable |
| T2-c | ps1 hooks platform-gated + runner-aware registration | init on this machine registers SessionStart→session-start-index-check.ps1 via powershell runner; (linux path asserted by unit test only — note as not-live-verifiable here) | SessionStart still fires zc-recall ritual (local-only hook untouched) |
| T2-d | Uninstall covers .ps1 hooks too (issue #3 completeness) | Sandboxed-home uninstall re-run: ps1 gone from sandbox, local-only session-start-zc-recall.ps1 UNTOUCHED in real home | Real ~/.claude/settings.json untouched by the sandbox run (diff before/after); desktop config untouched (APPDATA sandboxed this time) |
| T2-e | plugin.json parity test (legacy generation documented) | CI-level only (drift tripwire) — no live component; verify test fails if plugin.json edited (mutation check once, locally) | — |

## Carried from earlier (still awaiting organic evidence)

| ID | Change | Live evidence required |
|----|--------|------------------------|
| D-9 | Dispatcher class-9: unanswered worker question auto-inboxes after 45 min (A2A_dispatcher 043d3dd, local commit, dispatcher running it) | First natural QUERY_UNANSWERED_INBOXED line + the question rendering in the operator inbox; then push 043d3dd |

## Known measurement queries (for the pass)
- auto-retirements: `SELECT COUNT(*) FROM memory_contradictions_pg WHERE resolution_mode='auto'` (must stay 496)
- advisory flags: `SELECT COUNT(*) FROM memory_contradictions_pg WHERE status='open' AND detail LIKE 'LLM advisory%'`
- ★5 integrity: `SELECT COUNT(*) FROM working_memory WHERE importance>=5 AND valid_to IS NOT NULL AND retired_reason IN ('superseded','consolidated','expired') AND valid_to > '<pass-start>'` (must be 0)
- auto-extract: count facts created by the Stop hook after the pass's work session
