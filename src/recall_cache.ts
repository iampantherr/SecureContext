/**
 * In-memory cache for zc_recall_context (v0.17.1)
 * ================================================
 *
 * PROBLEM:
 *   Live telemetry showed zc_recall_context was 82% of a typical session's
 *   MCP tool-call cost. The call returns ~800 tokens of working-memory +
 *   broadcasts + system status; on Opus ($75/Mtok output) that's ~$0.06/call.
 *   Sessions typically call it 3× (boot, mid-task, review) → ~$0.18/session
 *   just for context restore. That nearly defeats the token-saving purpose
 *   of the whole harness.
 *
 * FIX:
 *   Cache the full formatted response keyed by (project_path, agent_id).
 *   On repeat calls within 60s, return the exact prior response with a
 *   small prefix note "(cached XYs ago)". The agent sees identical
 *   structure so its downstream reasoning is unchanged.
 *
 *   A staleness check runs on every hit: if any of the underlying
 *   tables (working_memory, broadcasts, session_events) have grown since
 *   the cache was populated, the cache is busted. Cheap — two SELECT
 *   MAX(id) queries on indexed columns.
 *
 * BYPASS:
 *   zc_recall_context({force: true}) skips the cache regardless. Useful
 *   when an agent explicitly wants a fresh pull.
 *
 * SAFETY:
 *   - Cache is in-memory per MCP server process; no disk persistence.
 *     A new session / new agent / new process starts cold.
 *   - Scoped per (project_hash, agent_id) so cross-agent leakage is
 *     impossible — agent A's cached recall cannot leak to agent B.
 *   - TTL of 60s bounds max staleness window; plus change-detection.
 *   - Hit counter + miss counter exposed for observability.
 */

import type { DatabaseSync } from "node:sqlite";

interface RecallCacheEntry {
  cachedAt:          number;  // Date.now() ms
  response:          string;  // the full formatted text we returned last time
  workingMemoryMaxId: number; // max(id) in working_memory at cache time
  broadcastsMaxId:    number; // max(id) in broadcasts at cache time
  eventsMaxId:        number; // max(id) in session_events at cache time
}

// Module-scope map. Keyed by `${projectPath}::${agentId}`. Process-lifetime
// scope — a Map with no maximum size would theoretically grow unbounded,
// but each MCP server is single-agent in practice, so we cap defensively.
const cache = new Map<string, RecallCacheEntry>();
const MAX_CACHE_ENTRIES = 64;
const TTL_MS = 60_000;

let cacheHits   = 0;
let cacheMisses = 0;

function cacheKey(projectPath: string, agentId: string | undefined): string {
  return `${projectPath}::${agentId ?? "default"}`;
}

function pruneIfOverLimit() {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  // Drop the oldest entry (FIFO approximation — Map iteration is insertion order)
  const firstKey = cache.keys().next().value;
  if (firstKey !== undefined) cache.delete(firstKey);
}

/**
 * Quick change-detection via 3 SELECT MAX(id) queries on indexed tables.
 * Returns true if any store has grown since the cache was populated.
 *
 * These queries are O(1) on SQLite when the PK / id is indexed, which
 * all of our tables are. Cost: sub-millisecond each.
 */
function hasChangedSinceCache(db: DatabaseSync, entry: RecallCacheEntry): boolean {
  try {
    const wmMax = (db.prepare("SELECT COALESCE(MAX(id), 0) AS mx FROM working_memory").get() as { mx: number }).mx;
    if (wmMax > entry.workingMemoryMaxId) return true;
    const bcMax = (db.prepare("SELECT COALESCE(MAX(id), 0) AS mx FROM broadcasts").get() as { mx: number }).mx;
    if (bcMax > entry.broadcastsMaxId) return true;
    // session_events may not exist on legacy projects; guard
    try {
      const evMax = (db.prepare("SELECT COALESCE(MAX(id), 0) AS mx FROM session_events").get() as { mx: number }).mx;
      if (evMax > entry.eventsMaxId) return true;
    } catch { /* table absent — skip */ }
    return false;
  } catch {
    // On any DB error, treat as changed (safer to re-fetch than stale-serve)
    return true;
  }
}

export interface CachedRecall {
  hit:   boolean;
  response?: string;      // populated when hit
  ageMs?:    number;
}

/**
 * Return a cached response if one exists, is young enough, AND the
 * underlying data hasn't changed. Otherwise returns { hit: false }.
 */
export function tryGetCachedRecall(
  projectPath: string,
  agentId:     string | undefined,
  db:          DatabaseSync,
): CachedRecall {
  const entry = cache.get(cacheKey(projectPath, agentId));
  if (!entry) { cacheMisses++; return { hit: false }; }
  const age = Date.now() - entry.cachedAt;
  if (age > TTL_MS)           { cacheMisses++; cache.delete(cacheKey(projectPath, agentId)); return { hit: false }; }
  if (hasChangedSinceCache(db, entry)) {
    cacheMisses++;
    cache.delete(cacheKey(projectPath, agentId));
    return { hit: false };
  }
  cacheHits++;
  return { hit: true, response: entry.response, ageMs: age };
}

/**
 * Store a recall response + the current max ids so future hits can
 * verify freshness cheaply.
 */
export function putCachedRecall(
  projectPath: string,
  agentId:     string | undefined,
  response:    string,
  db:          DatabaseSync,
): void {
  const wmMax = (() => { try { return (db.prepare("SELECT COALESCE(MAX(id), 0) AS mx FROM working_memory").get() as { mx: number }).mx; } catch { return 0; } })();
  const bcMax = (() => { try { return (db.prepare("SELECT COALESCE(MAX(id), 0) AS mx FROM broadcasts").get() as { mx: number }).mx; } catch { return 0; } })();
  const evMax = (() => { try { return (db.prepare("SELECT COALESCE(MAX(id), 0) AS mx FROM session_events").get() as { mx: number }).mx; } catch { return 0; } })();
  cache.set(cacheKey(projectPath, agentId), {
    cachedAt: Date.now(),
    response,
    workingMemoryMaxId: wmMax,
    broadcastsMaxId:    bcMax,
    eventsMaxId:        evMax,
  });
  pruneIfOverLimit();
}

/** Format a cached response with a small "(cached Xs ago)" prefix. */
export function decorateCachedResponse(response: string, ageMs: number): string {
  const ageSec = Math.round(ageMs / 1000);
  return `_(cached ${ageSec}s ago — no changes since; call zc_recall_context({force: true}) to force a fresh pull)_\n\n${response}`;
}

/** Observability — current hit/miss counts. Exposed so zc_status can surface it. */
export function getCacheStats(): { hits: number; misses: number; entries: number; hitRate: number } {
  const total = cacheHits + cacheMisses;
  return {
    hits:    cacheHits,
    misses:  cacheMisses,
    entries: cache.size,
    hitRate: total === 0 ? 0 : cacheHits / total,
  };
}

/** Test-only helper: wipe the cache between tests. */
export function _resetRecallCacheForTesting(): void {
  cache.clear();
  cacheHits   = 0;
  cacheMisses = 0;
}
