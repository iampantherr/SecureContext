/**
 * Recency-decay / salience (Tier-2 #4) — pure, shared by the SQLite (memory.ts) and
 * PG (store-postgres.ts) recall paths so both rank identically.
 *
 * Salience is a SECONDARY recall signal folded in AFTER importance (which stays the
 * primary axis): a log-damped access-frequency bonus plus an exponential recency decay
 * on time since the fact was last retrieved. Returns 0 when W_SALIENCE=0 (the kill-switch)
 * so callers can detect "disabled" and skip re-sorting entirely (byte-identical recall).
 */
import { Config } from "./config.js";

export function salienceEnabled(): boolean {
  return Config.W_SALIENCE > 0;
}

export function computeSalience(
  accessCount:     number | null | undefined,
  lastRetrievedAt: string | Date | null | undefined,  // PG TIMESTAMPTZ comes back as Date
  nowMs:           number,
): number {
  if (Config.W_SALIENCE <= 0) return 0;
  const access = Math.log(1 + Math.max(0, accessCount ?? 0)) * Config.W_SALIENCE_ACCESS;
  let recency = 0;
  if (lastRetrievedAt != null) {
    const t = lastRetrievedAt instanceof Date ? lastRetrievedAt.getTime() : Date.parse(String(lastRetrievedAt));
    if (Number.isFinite(t)) {
      const ageH = Math.max(0, (nowMs - t) / 3_600_000);
      recency = Math.exp(-ageH / Math.max(1, Config.SALIENCE_HALFLIFE_H));
    }
  }
  return Config.W_SALIENCE * (access + recency);
}
