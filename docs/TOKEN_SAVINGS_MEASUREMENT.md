# Does the summary redirect actually save tokens?

**Per read: yes, 98.2%. End to end: no — it cost 62% MORE.**

Both numbers are real and they do not contradict each other. The difference is
that the redirect saves bytes and spends *turns*, and a turn is more expensive
than the bytes it saved.

## The per-read arithmetic — the claim as usually stated

Real SecureContext files against the L0/L1 summaries actually stored for them,
plus the impact block:

| file | file tokens | summary + impact | ratio |
|---|---|---|---|
| `src/api-server.ts` | 67,819 | 419 | 0.01x |
| `src/server.ts` | 54,968 | 312 | 0.01x |
| `src/store-postgres.ts` | 40,454 | 391 | 0.01x |
| `src/knowledge.ts` | 13,987 | 822 | 0.06x |
| `src/config.ts` | 7,598 | 254 | 0.03x |
| `src/logger.ts` | 2,806 | 611 | 0.22x |
| `src/embedder.ts` | 2,523 | 531 | 0.21x |

Aggregate: **190,155 file tokens → 3,340 replacement tokens, 98.2% saved on the
read itself.** Break-even is ~477 tokens (~24 lines); below that the summary is
bigger than the file.

This is the number the documentation quotes, and in isolation it is correct.

## End to end it inverts

Measured with real agents, `--output-format json`, billed input =
`input + cache_creation + cache_read`.

### Edit task, small files (10 lines), 3 runs per arm

| | with redirect | without | delta |
|---|---|---|---|
| billed input | 346,824 | 215,465 | **+61.0%** |
| turns | 11.3 | 9.0 | +25.9% |
| cost | $0.6160 | $0.4502 | +36.8% |

Expected: below break-even the summary cannot pay for itself.

### Comprehension task, LARGE real files, 2 runs per arm

The regime the design is meant for — reading to understand, over a repo whose
largest file is 67k tokens.

| | with redirect | without | delta |
|---|---|---|---|
| billed input | 397,982 | 245,801 | **+61.9%** |
| output | 4,016 | 2,847 | +41.1% |
| turns | 10.5 | 7.5 | **+40.0%** |
| cost | $0.8379 | $0.6168 | +35.8% |
| wall clock | 70.5s | 52.0s | +35.6% |

**Even where the per-read saving is 99%, the end-to-end cost went UP.**

## Why: the delivery mechanism, not the content

The turn counts give it away (+26% and +40%). The hook returns
`permissionDecision: "deny"` with the summary as the reason — the agent receives
the summary, but the Read did not happen, so it takes another turn to re-read
with `offset/limit` or to ask something else. The write hook adds another.

Every extra turn re-sends the whole conversation as cache-read input. Against a
large cached prefix, **one extra round-trip costs more than the file it
avoided.** The savings are real per read and are then spent, with interest, on
round-trips.

## What this means for the claim

Any statement that the redirect "saves ~95% of Read tokens" must be qualified:
it is true of a single read in isolation and false of the session that contains
it, on both workloads measured here.

The fix is not a bigger discount on the content — it is to deliver the summary
**without costing a turn**. A mechanism that returns the summary AS the Read's
result (rather than denying the Read and making the agent retry) would keep the
98.2% and drop the turn penalty. That is a change to how the hook answers, not
to what it knows.

Until that exists, the honest setting for a token-sensitive workload is
`ZC_SUMMARY_REDIRECT=0`.

## Caveats

n=10 (6 edit + 4 comprehension), one model, two workloads, one machine. Cache
pricing and a 1M-token context window dominate the arithmetic — a smaller
context or different cache economics could move the break-even. The per-read
figures are exact; the end-to-end figures are means of small samples with
consistent sign and large effect size.
