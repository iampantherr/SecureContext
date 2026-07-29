/**
 * Effect verification — catch operations that "succeed" without doing the job.
 *
 * WHY THIS EXISTS
 *
 * In a single day of dogfooding, six defects shipped through a fully green test
 * suite (999 → 1014 passing throughout). Every one had the same shape: an
 * operation that could not do its job returned a plausible-looking result
 * instead of failing.
 *
 *   1. zc_remember accepted kind:'constraint' and silently stored 'fact'
 *      — validated against a stale whitelist, fell back to the auto-classifier,
 *        returned {ok:true}. Took three live E2E rounds to find.
 *   2. Broadcast summaries were clamped to 1000 chars with no marker
 *      — a task brief arrived cut mid-sentence; the worker lost its acceptance
 *        criteria and built against invented ones.
 *   3. migrationsTouching() returned [] from a regex whose \b became a
 *      backspace character — silently disabled a migration replay.
 *   4. A base-class stub returned [] instead of raising, so an unimplemented
 *      Postgres method rendered as HTTP 200 with empty data.
 *   5. Progressive importance decay shipped inert — the period was longer than
 *      the age of 772 of 773 facts. Entropy 1.417 before, 1.414 after.
 *   6. An acceptance gate passed 42/42 on three submissions, two of them broken.
 *
 * Green tests, clean logs, wrong system. Unit tests could not catch any of them
 * because the tests asserted what the author BELIEVED, using inputs the author
 * constructed. Only comparing a declared intent against a measured effect finds
 * this class.
 *
 * THE THREE DETECTORS
 *
 *   A. Write-readback (this module's core). Every mutation reports what was
 *      ACTUALLY persisted; a contract diffs it against what was REQUESTED.
 *      Catches silent coercion, silent clamping, silently dropped fields —
 *      automatically, for every caller, with no author effort. Defects 1 and 2.
 *
 *   B. Empty-result anomaly (emptyResultAnomaly). An operation that returns
 *      nothing where it historically returned something is a tripwire for
 *      "it silently did nothing". Defects 3 and 4.
 *
 *   C. Effect assertion (see effect_assert.ts). A change declares a falsifiable
 *      metric and direction BEFORE shipping; the system measures on real data
 *      and refutes the claim if it did not move. Defects 5 and 6.
 *
 * DESIGN RULE, learned the hard way: a discrepancy is never silent. That is the
 * failure this module exists to prevent, and it would be absurd to reproduce it
 * here. Discrepancies are returned to the caller, logged, and (for fields
 * declared exact) can hard-fail.
 */
import { Config } from "./config.js";
import { logger } from "./logger.js";

/** How a field is allowed to differ between request and stored row. */
export type FieldContract =
  /** Must round-trip byte-identical. Divergence = the write did not honour the caller. */
  | "exact"
  /** May be shortened, but ONLY if the stored value announces it (marker text). */
  | "lossy-marked"
  /** May be normalised (trim/case/default-fill). Divergence is reported, never fatal. */
  | "normalised"
  /** Not checked. */
  | "ignore";

export interface Discrepancy {
  field: string;
  contract: FieldContract;
  requested: unknown;
  stored: unknown;
  /** Human-readable, actionable — this text reaches the agent that made the call. */
  detail: string;
  severity: "error" | "warning";
}

export interface VerifyResult {
  ok: boolean;
  discrepancies: Discrepancy[];
  /** One-line summary for logs and API responses; "" when clean. */
  notice: string;
}

const truncate = (v: unknown, n = 80): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s == null) return String(v);
  return s.length > n ? `${s.slice(0, n)}...` : s;
};

/**
 * Compare what a caller asked to persist against what actually landed.
 *
 * `contracts` names the fields that matter. Anything absent from `contracts` is
 * ignored, so adding a column cannot retroactively make every write noisy.
 */
export function verifyWrite(
  requested: Record<string, unknown>,
  stored: Record<string, unknown>,
  contracts: Record<string, FieldContract>,
  opts: { operation: string; truncationMarker?: string } = { operation: "write" }
): VerifyResult {
  const discrepancies: Discrepancy[] = [];
  const marker = opts.truncationMarker ?? "TRUNCATED";

  for (const [field, contract] of Object.entries(contracts)) {
    if (contract === "ignore") continue;
    if (!(field in requested) || requested[field] === undefined) continue;

    const req = requested[field];
    const got = stored[field];

    if (contract === "exact") {
      // Compare by value, not identity; numbers-as-strings from PG are common.
      const same = req === got || String(req) === String(got);
      if (!same) {
        discrepancies.push({
          field, contract, requested: req, stored: got,
          severity: "error",
          detail:
            `${opts.operation}: '${field}' was requested as ${truncate(req)} but stored as ` +
            `${truncate(got)}. The write reported success while silently changing your value - ` +
            `this is the coerced-enum class. Treat the operation as FAILED.`,
        });
      }
      continue;
    }

    if (contract === "lossy-marked") {
      const reqS = String(req ?? "");
      const gotS = String(got ?? "");
      if (gotS.length < reqS.length && !gotS.includes(marker)) {
        discrepancies.push({
          field, contract, requested: `${reqS.length} chars`, stored: `${gotS.length} chars`,
          severity: "error",
          detail:
            `${opts.operation}: '${field}' lost ${reqS.length - gotS.length} characters with no ` +
            `'${marker}' marker. A truncation the receiver cannot detect is indistinguishable ` +
            `from a message that was never longer. Content past the cut is UNRECOVERABLE.`,
        });
      } else if (gotS.length < reqS.length) {
        discrepancies.push({
          field, contract, requested: `${reqS.length} chars`, stored: `${gotS.length} chars`,
          severity: "warning",
          detail:
            `${opts.operation}: '${field}' was truncated by ${reqS.length - gotS.length} chars, ` +
            `announced in-band. Ask the sender for the full text if you need it.`,
        });
      }
      continue;
    }

    // normalised — report, never fatal.
    if (String(req ?? "") !== String(got ?? "")) {
      discrepancies.push({
        field, contract, requested: req, stored: got,
        severity: "warning",
        detail: `${opts.operation}: '${field}' was normalised from ${truncate(req)} to ${truncate(got)}.`,
      });
    }
  }

  const errors = discrepancies.filter((d) => d.severity === "error");
  const notice = discrepancies.length === 0
    ? ""
    : `[!] ${opts.operation}: ${errors.length} silent-failure discrepanc${errors.length === 1 ? "y" : "ies"}` +
      `${discrepancies.length > errors.length ? ` (+${discrepancies.length - errors.length} warning)` : ""} - ` +
      discrepancies.map((d) => d.detail).join(" | ");

  if (discrepancies.length > 0) {
    logger.warn("effect_verify", "write_discrepancy", {
      operation: opts.operation,
      errors: errors.length,
      warnings: discrepancies.length - errors.length,
      fields: discrepancies.map((d) => d.field),
    });
  }

  return { ok: errors.length === 0, discrepancies, notice };
}

/**
 * Detector B — an operation that returned NOTHING where it usually returns
 * something. This is the tripwire for "it silently did nothing": a regex that
 * stopped matching, a stub inheriting a benign default, a query whose filter
 * silently excluded everything.
 *
 * Deliberately statistical rather than absolute — an empty result is often
 * correct. It fires only when history says otherwise, and it ADVISES; it never
 * blocks, because a false positive that stops work is worse than a late warning.
 */
export function emptyResultAnomaly(
  operation: string,
  currentCount: number,
  history: number[],
  opts: { minSamples?: number } = {}
): { anomalous: boolean; notice: string } {
  const minSamples = opts.minSamples ?? Config.EMPTY_ANOMALY_MIN_SAMPLES;
  if (currentCount > 0) return { anomalous: false, notice: "" };
  const nonEmpty = history.filter((n) => n > 0);
  if (history.length < minSamples || nonEmpty.length === 0) return { anomalous: false, notice: "" };

  // Fire only if emptiness is genuinely unusual for this operation.
  const emptyRate = (history.length - nonEmpty.length) / history.length;
  if (emptyRate > Config.EMPTY_ANOMALY_MAX_RATE) return { anomalous: false, notice: "" };

  const lo = Math.min(...nonEmpty);
  const hi = Math.max(...nonEmpty);
  return {
    anomalous: true,
    notice:
      `⚠ ${operation} returned 0 results, but the last ${history.length} calls returned ` +
      `${lo}–${hi}. An operation that silently does nothing looks identical to one with ` +
      `nothing to do — verify the input reached it before trusting this empty result.`,
  };
}
