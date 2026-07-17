/**
 * D4 (v0.46.1) — EMBED-LANE WATCHDOG.
 *
 * Failure class this catches (measured 2026-07-17): every embedding silently
 * timed out for HOURS while `/health` said ok — the fixed 5s embed timeout
 * lost every race while a chat model shared the CPU-only Ollama, the vector
 * index quietly stopped growing, and search degraded to BM25-only with no
 * signal anywhere. A delivery tool that runs multi-day programs must notice
 * its own degradation.
 *
 * Check (default every 5 min, ZC_EMBED_WATCHDOG=0 disables):
 *   stalled ⇔ (KB entries lacking a vector for the active model exist)
 *           ∧ (no embedding row written in the last ZC_EMBED_STALL_MIN minutes)
 *           ∧ (Ollama answers /api/tags — i.e. it's NOT a plain outage)
 *
 * Surfaced via getEmbedLaneHealth() → /health (`embedLane`) and the dashboard
 * overview strip. Log line rate-limited to once per stall episode.
 */
import { withClient } from "./pg_pool.js";
import { ACTIVE_MODEL, checkOllamaAvailable } from "./embedder.js";

export interface EmbedLaneHealth {
  status: "ok" | "stalled" | "idle" | "unknown";
  pendingEntries: number;
  lastEmbedAt: string | null;
  checkedAt: string | null;
  detail?: string;
}

let _health: EmbedLaneHealth = { status: "unknown", pendingEntries: 0, lastEmbedAt: null, checkedAt: null };
let _timer: NodeJS.Timeout | null = null;
let _stallLogged = false;

export function getEmbedLaneHealth(): EmbedLaneHealth {
  return _health;
}

export async function checkEmbedLane(): Promise<EmbedLaneHealth> {
  const stallMin = parseInt(process.env["ZC_EMBED_STALL_MIN"] ?? "10", 10) || 10;
  try {
    const { pending, lastEmbed } = await withClient(async (c) => {
      const p = await c.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM knowledge_entries ke
          WHERE LENGTH(TRIM(ke.content)) > 0
            AND NOT EXISTS (
            SELECT 1 FROM embeddings e
             WHERE e.project_hash = ke.project_hash AND e.source = ke.source AND e.model_name = $1)`,
        [ACTIVE_MODEL],
      );
      const l = await c.query<{ t: Date | null }>(`SELECT MAX(created_at) AS t FROM embeddings`);
      return { pending: parseInt(p.rows[0]?.n ?? "0", 10), lastEmbed: l.rows[0]?.t ?? null };
    });
    const lastIso = lastEmbed ? new Date(lastEmbed).toISOString() : null;
    const quietMs = lastEmbed ? Date.now() - new Date(lastEmbed).getTime() : Infinity;
    const now = new Date().toISOString();

    if (pending === 0) {
      _health = { status: "idle", pendingEntries: 0, lastEmbedAt: lastIso, checkedAt: now };
      _stallLogged = false;
      return _health;
    }
    if (quietMs < stallMin * 60_000) {
      _health = { status: "ok", pendingEntries: pending, lastEmbedAt: lastIso, checkedAt: now };
      _stallLogged = false;
      return _health;
    }
    // Pending work + quiet lane. Only call it STALLED when Ollama is reachable —
    // a plain Ollama outage already surfaces via /health ollamaAvailable=false.
    const ollama = await checkOllamaAvailable();
    if (!ollama.available) {
      _health = { status: "ok", pendingEntries: pending, lastEmbedAt: lastIso, checkedAt: now,
        detail: "embeds pending but Ollama is down (see ollamaAvailable)" };
      return _health;
    }
    _health = {
      status: "stalled", pendingEntries: pending, lastEmbedAt: lastIso, checkedAt: now,
      detail: `${pending} entr${pending === 1 ? "y" : "ies"} awaiting vectors; no embedding written in ${Math.round(quietMs / 60000)} min while Ollama answers — likely embed timeouts (chat-model CPU contention?). Check ZC_EMBED_TIMEOUT_MS / 'docker exec securecontext-ollama ollama ps'.`,
    };
    if (!_stallLogged) {
      _stallLogged = true;
      console.error(`[embed-watchdog] STALLED: ${_health.detail}`);
    }
    return _health;
  } catch (e) {
    _health = { status: "unknown", pendingEntries: 0, lastEmbedAt: null, checkedAt: new Date().toISOString(),
      detail: (e as Error).message };
    return _health;
  }
}

export type EmbedHealFn = (budget: number) => Promise<{ embedded: number; remaining: number; ollamaDown: boolean }>;
let _heal: EmbedHealFn | null = null;
let _healing = false;

/**
 * v0.46.1 — self-heal pass: when the lane is STALLED (pending vectors, quiet
 * lane, Ollama answering), detection alone leaves those entries BM25-only
 * forever. If a heal function is registered (PostgresStore.embedMissingVectors),
 * drain a budgeted batch per check. ZC_EMBED_BACKFILL=0 disables healing while
 * keeping detection; ZC_EMBED_BACKFILL_BATCH tunes the per-pass budget.
 */
async function _maybeHeal(): Promise<void> {
  if (!_heal || _healing || process.env["ZC_EMBED_BACKFILL"] === "0") return;
  if (_health.status !== "stalled") return;
  _healing = true;
  try {
    const budget = Math.max(1, parseInt(process.env["ZC_EMBED_BACKFILL_BATCH"] ?? "50", 10) || 50);
    // Loop until the backlog drains (or the embedder falters) — one stall episode
    // heals everything. Batch-at-a-time so each iteration yields between batches;
    // capped so a pathological corpus can't hold the healer forever.
    let total = 0;
    for (let i = 0; i < 40; i++) {
      const r = await _heal(budget);
      total += r.embedded;
      console.log(`[embed-watchdog] self-heal: embedded ${r.embedded} (total ${total}), ${r.remaining} remaining${r.ollamaDown ? " (embedder unavailable — will retry next check)" : ""}`);
      if (r.remaining <= 0 || r.embedded === 0 || r.ollamaDown) break;
    }
    if (total > 0) { _stallLogged = false; void checkEmbedLane(); }
  } catch (e) {
    console.error(`[embed-watchdog] self-heal failed: ${(e as Error).message}`);
  } finally {
    _healing = false;
  }
}

export function startEmbedWatchdog(heal?: EmbedHealFn): void {
  if (process.env["ZC_EMBED_WATCHDOG"] === "0") return;
  if (heal) _heal = heal;
  if (_timer) return;
  const intervalMin = Math.max(1, parseInt(process.env["ZC_EMBED_WATCHDOG_MIN"] ?? "5", 10) || 5);
  _timer = setInterval(() => { void checkEmbedLane().then(() => _maybeHeal()); }, intervalMin * 60_000);
  _timer.unref?.();
  // First check shortly after boot (give the embed lane a warm-up window).
  setTimeout(() => { void checkEmbedLane().then(() => _maybeHeal()); }, 90_000).unref?.();
  console.log(`Embed-lane watchdog: ENABLED (every ${intervalMin} min, stall threshold ${process.env["ZC_EMBED_STALL_MIN"] ?? "10"} min, self-heal ${process.env["ZC_EMBED_BACKFILL"] === "0" ? "OFF" : "on"})`);
}
