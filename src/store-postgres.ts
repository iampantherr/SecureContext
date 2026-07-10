/**
 * PostgresStore — Production Store backed by PostgreSQL + pgvector
 *
 * ARCHITECTURE:
 *   • All projects share ONE PostgreSQL database.
 *   • Multi-tenancy: every table includes a `project_hash` column (first 16 hex chars
 *     of SHA-256(projectPath)). All queries filter by project_hash.
 *   • Vector search: pgvector `vector(768)` column + IVFFlat cosine index.
 *   • Full-text search: PostgreSQL tsvector/GIN index (replaces SQLite FTS5).
 *   • Hybrid search: BM25 (ts_rank) + cosine similarity, same formula as SqliteStore.
 *   • Hash chain: same SHA-256 chain logic, enforced by serialized INSERT via
 *     advisory locks (prevents concurrent writers racing on prev_hash).
 *   • RBAC: same token format (zcst.payload.hmac), same HMAC verification.
 *     Signing key stored in project_meta per project_hash.
 *
 * SECURITY:
 *   • All queries parameterized — no SQL injection possible.
 *   • project_hash is always derived server-side from projectPath — callers
 *     cannot supply an arbitrary hash to access another project's data.
 *   • Advisory lock (pg_advisory_xact_lock) serializes broadcast INSERTs per
 *     project to ensure hash chain integrity under concurrent writes.
 *   • Scrypt KDF for channel key (same as SqliteStore, same parameters).
 *   • Token HMAC verification is timing-safe (timingSafeEqual).
 *   • Row-level isolation: all queries include WHERE project_hash = $n.
 *
 * PERFORMANCE:
 *   • pg.Pool with configurable pool size (default 10 connections).
 *   • IVFFlat index on embeddings for O(√n) approximate cosine search.
 *   • GIN index on tsvector for O(log n) full-text search.
 *   • Complexity profile cached in project_meta (10-minute TTL, same as SqliteStore).
 */

import pg from "pg";
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { Config } from "./config.js";
import { computeRowHash } from "./chain.js";
import { getEmbedding, cosineSimilarity, ACTIVE_MODEL } from "./embedder.js";
import { classifyFactKind, type EpistemicOpts } from "./memory.js";
import { computeSalience, salienceEnabled } from "./salience.js";
import { extractCoReferences, classifyRelation } from "./indexing/community.js";
import { SIM_HIGH, MAX_SCAN_FACTS, detectConflict, autoResolveVictim } from "./contradiction_heuristics.js";
import { llmExtractEntities, entityEdgesFor, ENTITY_EXTRACT_ENABLED, ENTITY_BUDGET } from "./indexing/entity_extract.js";
import { detectCommunitiesFromRows } from "./indexing/community.js";
import { summarizeCommunity, answerGlobal, type CommunitySummaryRow } from "./indexing/community_summaries.js";
import { ROLE_PERMISSIONS, type AgentRole } from "./access-control.js";
import type {
  Store,
  MemoryStats,
  MemoryLimits,
  KbStats,
  SearchOptions,
  ExplainResult,
  BroadcastOptions,
  RecallOptions,
  ChainStatus,
  TokenPayload,
  FetchStats,
} from "./store.js";
import type {
  MemoryFact,
  BroadcastType,
  BroadcastMessage,
  BroadcastResult,
  KnowledgeEntry,
  CrossProjectEntry,
  RetentionTier,
  ComplexityProfile,
} from "./store.js";

const { Pool } = pg;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function ph(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function sanitize(s: string, max: number): string {
  return String(s).replace(/[\r\n\x00\x01-\x08\x0b\x0c\x0e-\x1f]/g, " ").trim().slice(0, max);
}

// Scrypt helpers (identical parameters to SqliteStore / memory.ts)
const SCRYPT_PREFIX = "scrypt:v1";
function hashChannelKeyScrypt(key: string): string {
  const { SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN, SCRYPT_SALT_BYTES, SCRYPT_MAXMEM } = Config;
  const saltBuf = randomBytes(SCRYPT_SALT_BYTES);
  const hashBuf = scryptSync(key, saltBuf, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `${SCRYPT_PREFIX}:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${saltBuf.toString("hex")}:${hashBuf.toString("hex")}`;
}

function verifyScryptHash(key: string, stored: string): boolean {
  try {
    if (!stored.startsWith(`${SCRYPT_PREFIX}:`)) return false;
    const parts = stored.split(":");
    if (parts.length !== 7) return false;
    const N = parseInt(parts[2]!, 10);
    const r = parseInt(parts[3]!, 10);
    const p = parseInt(parts[4]!, 10);
    const saltHex = parts[5]!;
    const hashHex = parts[6]!;
    if (isNaN(N) || isNaN(r) || isNaN(p) || N < 1024 || r < 1 || p < 1) return false;
    const saltBuf   = Buffer.from(saltHex, "hex");
    const storedBuf = Buffer.from(hashHex, "hex");
    const derivedBuf = scryptSync(key, saltBuf, storedBuf.length, {
      N, r, p, maxmem: Config.SCRYPT_MAXMEM,
    });
    return timingSafeEqual(derivedBuf, storedBuf);
  } catch {
    return false;
  }
}

// Token helpers (identical algorithm to access-control.ts)
function getOrCreateSigningKey(pool: pg.Pool, projectHash: string): Promise<string> {
  return pool.query<{ value: string }>(
    "SELECT value FROM project_meta WHERE project_hash = $1 AND key = 'zc_token_signing_key'",
    [projectHash]
  ).then(async (res) => {
    if (res.rows.length > 0) return res.rows[0]!.value;
    const newKey = randomBytes(32).toString("hex");
    await pool.query(
      "INSERT INTO project_meta(project_hash, key, value) VALUES ($1, 'zc_token_signing_key', $2) ON CONFLICT DO NOTHING",
      [projectHash, newKey]
    );
    // Re-read in case of race
    const res2 = await pool.query<{ value: string }>(
      "SELECT value FROM project_meta WHERE project_hash = $1 AND key = 'zc_token_signing_key'",
      [projectHash]
    );
    return res2.rows[0]!.value;
  });
}

function hmacSign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// PostgresStore
// ─────────────────────────────────────────────────────────────────────────────

export class PostgresStore implements Store {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max:            parseInt(process.env["ZC_PG_POOL_SIZE"] ?? "10", 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Statement timeout: 30s — prevents runaway queries
      options: "--statement_timeout=30000",
    });
  }

  /**
   * Run on first use. Verifies the connection and applies all schema migrations.
   * Idempotent — safe to call multiple times.
   */
  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Verify pgvector is available
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");

      // Apply all schema DDL (idempotent — uses IF NOT EXISTS / DO NOTHING)
      await client.query(PG_SCHEMA_DDL);
    } finally {
      client.release();
    }
  }

  // ── Working Memory ────────────────────────────────────────────────────────

  async remember(projectPath: string, key: string, value: string, importance: number, agentId: string, epi: EpistemicOpts = {}): Promise<void> {
    const projectHash = ph(projectPath);
    const safeKey    = sanitize(key,     100);
    const safeValue  = sanitize(value,   500);
    const safeImp    = Math.max(1, Math.min(5, Math.round(importance)));
    const safeAgent  = sanitize(agentId,  64);
    const now        = new Date().toISOString();

    // v0.31.0 epistemology — explicit kind wins, else auto-classify (parity with rememberFact).
    const KINDS = ["fact", "decision", "hypothesis", "prediction"];
    const RES   = ["open", "resolved_correct", "resolved_incorrect", "resolved_partial"];
    const safeKind = epi.kind && KINDS.includes(epi.kind) ? epi.kind : classifyFactKind(safeValue);
    const safeConf = (typeof epi.confidence === "number" && isFinite(epi.confidence)) ? Math.max(0, Math.min(1, epi.confidence)) : null;
    const safeRes  = epi.resolution && RES.includes(epi.resolution) ? epi.resolution : null;
    const resolvedAt = (safeRes && safeRes !== "open") ? now : null;

    await this.pool.query(`
      INSERT INTO working_memory(project_hash, key, value, importance, agent_id, created_at, kind, confidence, resolution_status, resolved_at, origin)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT(project_hash, key, agent_id) DO UPDATE SET
        value             = EXCLUDED.value,
        importance        = EXCLUDED.importance,
        created_at        = EXCLUDED.created_at,
        kind              = EXCLUDED.kind,
        confidence        = EXCLUDED.confidence,
        resolution_status = EXCLUDED.resolution_status,
        resolved_at       = EXCLUDED.resolved_at,
        origin            = EXCLUDED.origin,
        valid_to          = NULL,
        superseded_by     = NULL,
        retired_reason    = NULL
    `, [projectHash, safeKey, safeValue, safeImp, safeAgent, now, safeKind, safeConf, safeRes, resolvedAt, epi.origin ? sanitize(epi.origin, 120) : "zc_remember"]);
    // (valid_to reset: re-asserting a RETIRED key REVIVES it — the agent explicitly said it again.)

    // v0.36.0 — memory facts are now co-reference sources, so a memory WRITE must refresh
    // the backlink graph too (previously only indexing did — memory edges would go stale).
    // Debounced 5s + fire-and-forget: a burst of remembers still costs one rebuild.
    this._scheduleBacklinkRebuild(projectPath);

    // M1 (v0.41.0) — embed the LIVE fact (fire-and-forget, content-hash deduped) so
    // focused recall can rank it by relevance. Same memory:<agent>:<key> source the
    // eviction archive uses.
    void this._storeEmbedding(projectHash, safeValue, `memory:${safeAgent}:${safeKey}`);

    // Evict if over the dynamic limit
    const limits = await this.getWorkingMemoryLimits(projectPath);
    const countRes = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*) as n FROM working_memory WHERE project_hash = $1 AND agent_id = $2 AND valid_to IS NULL",
      [projectHash, safeAgent]
    );
    const count = parseInt(countRes.rows[0]!.n, 10);

    if (count > limits.max) {
      const toEvictCount = count - limits.evictTo;
      // v0.31.0: protect explicitly-tracked OPEN predictions/hypotheses + high-confidence decisions
      // (additive — plain facts match neither clause and evict exactly as before).
      const PROTECT = `NOT (
          (kind IN ('prediction','hypothesis') AND resolution_status = 'open')
       OR (kind = 'decision' AND confidence IS NOT NULL AND confidence >= 0.8)
      )`;
      const victims = (await this.pool.query<{ key: string; value: string }>(
        `SELECT key, value FROM working_memory
         WHERE project_hash = $1 AND agent_id = $2 AND valid_to IS NULL AND ${PROTECT}
         ORDER BY importance ASC, created_at ASC
         LIMIT $3`,
        [projectHash, safeAgent, toEvictCount]
      )).rows;

      // Safety valve: if protected facts leave us short, fall back to unfiltered eviction
      // for the remainder so the hard `max` bound always holds.
      if (victims.length < toEvictCount) {
        const have = new Set(victims.map((v) => v.key));
        const extra = (await this.pool.query<{ key: string; value: string }>(
          `SELECT key, value FROM working_memory
           WHERE project_hash = $1 AND agent_id = $2 AND valid_to IS NULL
           ORDER BY importance ASC, created_at ASC
           LIMIT $3`,
          [projectHash, safeAgent, toEvictCount]
        )).rows;
        for (const r of extra) { if (victims.length >= toEvictCount) break; if (!have.has(r.key)) { victims.push(r); have.add(r.key); } }
      }

      for (const row of victims) {
        await this.pool.query(
          "DELETE FROM working_memory WHERE project_hash = $1 AND key = $2 AND agent_id = $3",
          [projectHash, row.key, safeAgent]
        );
        // Archive evicted fact to KB
        await this.index(projectPath, row.value, `memory:${safeAgent}:${row.key}`);
      }
    }
  }

  // ── v0.37.0 Temporal fact retirement ───────────────────────────────────────
  async retireFact(projectPath: string, key: string, agentId: string, supersededBy: string | null, reason: string): Promise<boolean> {
    return this._retireFactByHash(ph(projectPath), key, agentId, supersededBy, reason);
  }

  private async _retireFactByHash(projectHash: string, key: string, agentId: string, supersededBy: string | null, reason: string): Promise<boolean> {
    const safeKey   = sanitize(key,     100);
    const safeAgent = sanitize(agentId,  64);
    const row = (await this.pool.query<{ value: string }>(
      "SELECT value FROM working_memory WHERE project_hash = $1 AND key = $2 AND agent_id = $3 AND valid_to IS NULL",
      [projectHash, safeKey, safeAgent])).rows[0];
    if (!row) return false;
    await this.pool.query(
      "UPDATE working_memory SET valid_to = NOW(), superseded_by = $4, retired_reason = $5 WHERE project_hash = $1 AND key = $2 AND agent_id = $3",
      [projectHash, safeKey, safeAgent, supersededBy ? sanitize(supersededBy, 100) : null, sanitize(reason, 100)]);
    // Archive to the KB by hash (mirrors index()'s upserts — retire is non-destructive:
    // the value stays findable via zc_search and revivable via reviveFact).
    const source = `memory:${safeAgent}:${safeKey}`;
    const now = new Date().toISOString();
    try {
      await this.pool.query(`
        INSERT INTO knowledge_entries(project_hash, source, content, created_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(project_hash, source) DO UPDATE SET content = EXCLUDED.content, created_at = EXCLUDED.created_at
      `, [projectHash, source, row.value, now]);
      await this.pool.query(`
        INSERT INTO source_meta(project_hash, source, source_type, retention_tier, created_at, l0_summary, l1_summary)
        VALUES ($1, $2, 'internal', 'internal', $3, $4, $5)
        ON CONFLICT(project_hash, source) DO UPDATE SET created_at = EXCLUDED.created_at, l0_summary = EXCLUDED.l0_summary, l1_summary = EXCLUDED.l1_summary
      `, [projectHash, source, now, row.value.slice(0, Config.TIER_L0_CHARS).trim(), row.value.slice(0, Config.TIER_L1_CHARS).trim()]);
    } catch { /* archival is best-effort — retirement itself already succeeded */ }
    void this._rebuildBacklinksByHash(projectHash).catch(() => undefined);
    return true;
  }

  async reviveFact(projectPath: string, key: string, agentId: string): Promise<boolean> {
    return this._reviveFactByHash(ph(projectPath), key, agentId);
  }

  private async _reviveFactByHash(projectHash: string, key: string, agentId: string): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE working_memory SET valid_to = NULL, superseded_by = NULL, retired_reason = NULL WHERE project_hash = $1 AND key = $2 AND agent_id = $3 AND valid_to IS NOT NULL",
      [projectHash, sanitize(key, 100), sanitize(agentId, 64)]);
    if ((r.rowCount ?? 0) > 0) { void this._rebuildBacklinksByHash(projectHash).catch(() => undefined); return true; }
    return false;
  }

  async forget(projectPath: string, key: string, agentId: string): Promise<boolean> {
    const projectHash = ph(projectPath);
    const safeKey    = sanitize(key,     100);
    const safeAgent  = sanitize(agentId,  64);
    // v0.38.0 — SOFT DELETE with a recovery window: forget RETIRES the fact (out of recall
    // immediately, KB-archived, revivable for RETIRE_PURGE_DAYS) instead of hard-deleting.
    void projectHash;
    return this.retireFact(projectPath, safeKey, safeAgent, null, "forgotten");
  }

  async recall(
    projectPath: string,
    agentId: string,
    opts: { focus?: string; from?: Date; to?: Date; asOf?: Date } = {},
  ): Promise<MemoryFact[]> {
    const projectHash = ph(projectPath);
    const safeAgent   = sanitize(agentId, 64);

    // M3 (v0.41.0) — AS-OF time travel: reconstruct what was true at a past moment.
    // Includes facts retired SINCE then (they were live at asOf) and excludes facts
    // created after — the transaction timeline (created_at/valid_to) makes this a
    // pure predicate change, no history table needed. (Applied in the branch SQL below.)
    // v0.22.2 — per-agent namespacing with shared pool. Each agent gets its
    // own private notebook (agent_id = ZC_AGENT_ID = "developer", "orchestrator",
    // etc.) AND always sees the project-wide "default" pool (cross-agent
    // coordination: ownership tracking, last_session_summary, project state).
    //
    // Why: previously every fact was written under "default" and recall
    // returned all 101+ facts for any agent on any task — massive token
    // overhead for "tiny work." Per-agent gives each agent ONLY their own
    // private decisions + the shared coordination layer.
    //
    // When agentId="default" explicitly: return only the shared pool
    // (avoids redundant self-join).
    let rows: MemoryFact[];
    const COLS = `key, value, importance, agent_id, created_at, kind, confidence, resolution_status, resolved_at, access_count, last_retrieved_at, origin, valid_at`;
    if (safeAgent === "default") {
      const live = opts.asOf ? `created_at <= $2 AND (valid_to IS NULL OR valid_to > $2)` : `valid_to IS NULL`;
      const params: unknown[] = opts.asOf ? [projectHash, opts.asOf] : [projectHash];
      const res = await this.pool.query<MemoryFact>(
        `SELECT ${COLS}
         FROM working_memory WHERE project_hash = $1 AND agent_id = 'default' AND ${live}
         ORDER BY importance DESC, created_at DESC`,
        params
      );
      rows = res.rows;
    } else {
      // For per-agent agentId: UNION (their private notebook) + (shared 'default' pool)
      const live = opts.asOf ? `created_at <= $3 AND (valid_to IS NULL OR valid_to > $3)` : `valid_to IS NULL`;
      const params: unknown[] = opts.asOf ? [projectHash, safeAgent, opts.asOf] : [projectHash, safeAgent];
      const res = await this.pool.query<MemoryFact>(
        `SELECT ${COLS}
         FROM working_memory
         WHERE project_hash = $1 AND (agent_id = $2 OR agent_id = 'default') AND ${live}
         ORDER BY
           CASE WHEN agent_id = $2 THEN 0 ELSE 1 END,
           importance DESC,
           created_at DESC`,
        params
      );
      rows = res.rows;
    }

    // Tier-2 #4: secondary salience re-sort (importance stays primary) + best-effort
    // access bump (single batched UPDATE via unnest, fire-and-forget). Inert when
    // W_SALIENCE=0 — byte-identical ordering, no writes (the kill-switch).
    if (salienceEnabled() && rows.length > 0) {
      const now = Date.now();
      const k    = (r: MemoryFact) => `${r.key} ${r.agent_id ?? ""}`;
      const sal  = new Map(rows.map((r) => [k(r), computeSalience(r.access_count, r.last_retrieved_at ?? null, now)]));
      const prio = (r: MemoryFact) => (safeAgent !== "default" && r.agent_id === safeAgent ? 0 : 1);
      rows = [...rows].sort((a, b) =>
        prio(a) - prio(b) ||
        b.importance - a.importance ||
        (sal.get(k(b)) ?? 0) - (sal.get(k(a)) ?? 0) ||
        (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)
      );
      void this.pool.query(
        `UPDATE working_memory AS w
            SET access_count = COALESCE(w.access_count,0) + 1, last_retrieved_at = NOW()
           FROM unnest($2::text[], $3::text[]) AS t(key, agent_id)
          WHERE w.project_hash = $1 AND w.key = t.key AND w.agent_id = t.agent_id`,
        [projectHash, rows.map((r) => r.key), rows.map((r) => r.agent_id ?? safeAgent)]
      ).catch(() => undefined);
    }

    // M1 (v0.41.0) — FOCUSED recall: with a focus string, re-rank live facts by
    // blended relevance to the agent's CURRENT task (the M0 benchmark showed
    // task-relevant facts ranking 74-79/81 under importance-only ordering).
    //   score = RECALL_W_REL·cosine + RECALL_W_IMP·(importance/5) + RECALL_W_SAL·salience
    // Missing vectors ⇒ rel=0 (importance still ranks them — graceful until the
    // backfill lands). Ollama down ⇒ unfocused order unchanged. No focus ⇒ byte-identical.
    if (opts.focus && opts.focus.trim() && rows.length > 0) {
      try {
        const qEmbed = await getEmbedding(opts.focus.slice(0, 2000));
        if (qEmbed) {
          const sources = rows.map((r) => `memory:${r.agent_id ?? safeAgent}:${r.key}`);
          const embRes = await this.pool.query<{ source: string; vector: string }>(
            `SELECT source, vector::text FROM embeddings
             WHERE project_hash = $1 AND model_name = $2 AND source = ANY($3)`,
            [projectHash, ACTIVE_MODEL, sources]
          );
          const vecMap = new Map(embRes.rows.map((r) => [r.source, r.vector]));
          const now = Date.now();
          const scoreOf = (r: MemoryFact): number => {
            const vs = vecMap.get(`memory:${r.agent_id ?? safeAgent}:${r.key}`);
            let rel = 0;
            if (vs) {
              const nums = vs.slice(1, -1).split(",").map(Number);
              rel = Math.max(0, cosineSimilarity(new Float32Array(nums), qEmbed.vector));
            }
            const sal = computeSalience(r.access_count, r.last_retrieved_at ?? null, now);
            let score = Config.RECALL_W_REL * rel + Config.RECALL_W_IMP * (r.importance / 5) + Config.RECALL_W_SAL * sal;
            // M3 — temporal window bonus: event-time (valid_at, else created_at)
            // inside the parsed window ranks the fact above topic-only matches.
            if (opts.from || opts.to) {
              const evRaw = (r as MemoryFact & { valid_at?: string | Date | null }).valid_at ?? r.created_at;
              const ev = evRaw instanceof Date ? evRaw.getTime() : Date.parse(String(evRaw));
              const inWindow =
                Number.isFinite(ev) &&
                (!opts.from || ev >= opts.from.getTime()) &&
                (!opts.to   || ev <= opts.to.getTime());
              if (inWindow) score += Config.RECALL_W_TEMPORAL;
            }
            return score;
          };
          const scores = new Map(rows.map((r) => [r, scoreOf(r)]));
          rows = [...rows].sort((a, b) =>
            (scores.get(b)! - scores.get(a)!) ||
            (b.importance - a.importance) ||
            (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)
          );
        }
      } catch { /* focus ranking is best-effort — fall back to unfocused order */ }
    }
    return rows;
  }

  async archiveSummary(projectPath: string, summary: string): Promise<void> {
    const safe = sanitize(summary, 2000);
    const now  = new Date().toISOString();
    const source = `[SESSION_SUMMARY] ${now.slice(0, 10)}`;
    await this.index(projectPath, safe, source, "internal", "summary");
    await this.remember(projectPath, "last_session_summary", safe, 5, "default");
  }

  async getMemoryStats(projectPath: string, agentId: string): Promise<MemoryStats> {
    const projectHash = ph(projectPath);
    const safeAgent   = sanitize(agentId, 64);
    const [countRes, critRes] = await Promise.all([
      this.pool.query<{ n: string }>(
        "SELECT COUNT(*) as n FROM working_memory WHERE project_hash = $1 AND agent_id = $2 AND valid_to IS NULL",
        [projectHash, safeAgent]
      ),
      this.pool.query<{ n: string }>(
        "SELECT COUNT(*) as n FROM working_memory WHERE project_hash = $1 AND agent_id = $2 AND importance >= 4 AND valid_to IS NULL",
        [projectHash, safeAgent]
      ),
    ]);
    const limits = await this.getWorkingMemoryLimits(projectPath);
    return {
      count:         parseInt(countRes.rows[0]!.n, 10),
      max:           limits.max,
      evictTo:       limits.evictTo,
      criticalCount: parseInt(critRes.rows[0]!.n, 10),
      complexity:    limits.profile,
    };
  }

  async getWorkingMemoryLimits(projectPath: string, forceRecompute = false): Promise<MemoryLimits> {
    const projectHash   = ph(projectPath);
    const WM_CACHE_TTL  = 10 * 60 * 1000;

    if (!forceRecompute) {
      const res = await this.pool.query<{ value: string }>(
        "SELECT value FROM project_meta WHERE project_hash = $1 AND key = 'zc_complexity_profile'",
        [projectHash]
      );
      if (res.rows.length > 0) {
        try {
          const cached = JSON.parse(res.rows[0]!.value) as ComplexityProfile;
          const ageMs  = Date.now() - new Date(cached.computedAt).getTime();
          if (ageMs < WM_CACHE_TTL) {
            return { max: cached.computedLimit, evictTo: cached.evictTo, profile: cached };
          }
        } catch {}
      }
    }

    // Compute fresh
    const [kbRes, bcRes, agRes] = await Promise.all([
      this.pool.query<{ n: string }>(
        "SELECT COUNT(*) as n FROM source_meta WHERE project_hash = $1", [projectHash]
      ),
      this.pool.query<{ n: string }>(
        "SELECT COUNT(*) as n FROM broadcasts WHERE project_hash = $1", [projectHash]
      ),
      this.pool.query<{ n: string }>(
        "SELECT COUNT(*) as n FROM agent_sessions WHERE project_hash = $1 AND revoked = 0 AND expires_at > $2",
        [projectHash, new Date().toISOString()]
      ),
    ]);

    const kbEntries      = parseInt(kbRes.rows[0]!.n, 10);
    const broadcastCount = parseInt(bcRes.rows[0]!.n, 10);
    const activeAgents   = parseInt(agRes.rows[0]!.n, 10);

    const kbBonus    = Math.min(Math.floor(kbEntries     / 15), 60);
    const bcBonus    = Math.min(Math.floor(broadcastCount / 30), 40);
    const agentBonus = Math.min(activeAgents * 15, 50);
    const computedLimit = Math.max(100, Math.min(250, 100 + kbBonus + bcBonus + agentBonus));
    const evictTo       = Math.floor(computedLimit * 0.80);
    const computedAt    = new Date().toISOString();

    const profile: ComplexityProfile = {
      kbEntries, broadcastCount, activeAgents,
      computedLimit, evictTo, computedAt,
    };

    await this.pool.query(`
      INSERT INTO project_meta(project_hash, key, value) VALUES ($1, 'zc_complexity_profile', $2)
      ON CONFLICT(project_hash, key) DO UPDATE SET value = EXCLUDED.value
    `, [projectHash, JSON.stringify(profile)]);

    return { max: computedLimit, evictTo, profile };
  }

  // ── Knowledge Base ─────────────────────────────────────────────────────────

  async index(
    projectPath: string,
    content: string,
    source: string,
    sourceType: "internal" | "external" = "internal",
    retentionTier: RetentionTier = sourceType === "external" ? "external" : "internal"
  ): Promise<void> {
    const projectHash = ph(projectPath);
    const now         = new Date().toISOString();
    const safeSource  = sanitize(source,  500);
    const safeContent = sanitize(content, 50_000);

    // L0/L1 summary tiers (same logic as knowledge.ts)
    const l0 = safeContent.slice(0, Config.TIER_L0_CHARS).trim();
    const l1 = safeContent.slice(0, Config.TIER_L1_CHARS).trim();

    // Upsert knowledge entry
    await this.pool.query(`
      INSERT INTO knowledge_entries(project_hash, source, content, created_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(project_hash, source) DO UPDATE SET
        content    = EXCLUDED.content,
        created_at = EXCLUDED.created_at
    `, [projectHash, safeSource, safeContent, now]);

    // Upsert source_meta
    await this.pool.query(`
      INSERT INTO source_meta(project_hash, source, source_type, retention_tier, created_at, l0_summary, l1_summary)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(project_hash, source) DO UPDATE SET
        source_type    = EXCLUDED.source_type,
        retention_tier = EXCLUDED.retention_tier,
        created_at     = EXCLUDED.created_at,
        l0_summary     = EXCLUDED.l0_summary,
        l1_summary     = EXCLUDED.l1_summary
    `, [projectHash, safeSource, sourceType, retentionTier, now, l0, l1]);

    // Fire-and-forget embedding computation
    void this._storeEmbedding(projectHash, safeContent, safeSource);

    // Tier-1 A: schedule a debounced backlink-graph rebuild over PG (fire-and-forget).
    // THIS is what makes the backlink boost actually fire in the live PG deployment —
    // PostgresStore.index does not route through indexContent's SQLite trigger.
    this._scheduleBacklinkRebuild(projectPath);
  }

  private async _storeEmbedding(projectHash: string, content: string, source: string): Promise<void> {
    try {
      // v0.39.0 — content-addressable dedup (SQLite parity): identical content + same model
      // ⇒ skip the Ollama call; hash-match with a DIFFERENT model ⇒ explicit re-embed.
      const contentHash = createHash("sha256").update(content).digest("hex");
      try {
        const existing = (await this.pool.query<{ content_hash: string | null; model_name: string }>(
          `SELECT content_hash, model_name FROM embeddings WHERE project_hash = $1 AND source = $2`,
          [projectHash, source])).rows[0];
        if (existing && existing.content_hash === contentHash && existing.model_name === ACTIVE_MODEL) return;
      } catch { /* content_hash column absent (pre-migration) — fall through */ }

      const result = await getEmbedding(content);
      if (!result) return;
      // pgvector expects "[x1,x2,...,xN]" string format
      const vectorStr = "[" + result.vector.join(",") + "]";
      await this.pool.query(`
        INSERT INTO embeddings(project_hash, source, vector, model_name, dimensions, created_at, content_hash)
        VALUES ($1, $2, $3::vector, $4, $5, $6, $7)
        ON CONFLICT(project_hash, source) DO UPDATE SET
          vector       = EXCLUDED.vector,
          model_name   = EXCLUDED.model_name,
          dimensions   = EXCLUDED.dimensions,
          created_at   = EXCLUDED.created_at,
          content_hash = EXCLUDED.content_hash
      `, [projectHash, source, vectorStr, result.modelName, result.dimensions, new Date().toISOString(), contentHash]);
    } catch {
      // Embedding failure is non-fatal — falls back to BM25-only search
    }
  }

  /**
   * v0.39.0 — SAFE EMBEDDING-MODEL MIGRATION: budgeted re-embed of rows whose vectors were
   * produced by a DIFFERENT model than the active one (they're invisible to search via the
   * ACTIVE_MODEL filter — silently stale). Run by the enrichment cron until the backlog drains.
   */
  async reembedStaleModels(budget: number = 40): Promise<{ reembedded: number; remaining: number; ollamaDown: boolean }> {
    const stale = (await this.pool.query<{ project_hash: string; source: string }>(
      `SELECT e.project_hash, e.source FROM embeddings e
        WHERE e.model_name <> $1 LIMIT $2`, [ACTIVE_MODEL, budget])).rows;
    const remainingRes = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM embeddings WHERE model_name <> $1`, [ACTIVE_MODEL]);
    let reembedded = 0;
    for (const s of stale) {
      const row = (await this.pool.query<{ content: string }>(
        `SELECT content FROM knowledge_entries WHERE project_hash = $1 AND source = $2`,
        [s.project_hash, s.source])).rows[0];
      if (!row) {
        // Source no longer exists — the stale vector is an orphan; drop it.
        await this.pool.query(`DELETE FROM embeddings WHERE project_hash = $1 AND source = $2`, [s.project_hash, s.source]);
        continue;
      }
      const emb = await getEmbedding(row.content);
      if (!emb) return { reembedded, remaining: Number(remainingRes.rows[0]!.n) - reembedded, ollamaDown: true };
      const vectorStr = "[" + emb.vector.join(",") + "]";
      const contentHash = createHash("sha256").update(row.content).digest("hex");
      await this.pool.query(`
        UPDATE embeddings SET vector = $3::vector, model_name = $4, dimensions = $5, created_at = $6, content_hash = $7
        WHERE project_hash = $1 AND source = $2`,
        [s.project_hash, s.source, vectorStr, emb.modelName, emb.dimensions, new Date().toISOString(), contentHash]);
      reembedded++;
    }
    return { reembedded, remaining: Math.max(0, Number(remainingRes.rows[0]!.n) - reembedded), ollamaDown: false };
  }

  async search(projectPath: string, queries: string[], opts: SearchOptions = {}): Promise<KnowledgeEntry[]> {
    const projectHash = ph(projectPath);
    const limit       = opts.limit ?? Config.MAX_RESULTS;
    const candidates  = Config.BM25_CANDIDATES;

    // Merge all query terms into one tsvector query
    const queryText = queries.join(" ");

    // BM25 candidates via ts_rank (PostgreSQL full-text)
    type CandRow = { source: string; content: string; rank: number; source_type: string; synthetic?: boolean };
    const bm25Res = await this.pool.query<CandRow>(`
      SELECT ke.source, ke.content,
             ts_rank(to_tsvector('english', ke.content), plainto_tsquery('english', $2)) AS rank,
             COALESCE(sm.source_type, 'internal') as source_type
      FROM   knowledge_entries ke
      LEFT JOIN source_meta sm ON sm.project_hash = ke.project_hash AND sm.source = ke.source
      WHERE  ke.project_hash = $1
        AND  to_tsvector('english', ke.content) @@ plainto_tsquery('english', $2)
      ORDER  BY rank DESC
      LIMIT  $3
    `, [projectHash, queryText, candidates]);

    // M1 (v0.41.0) — candidate-pool fix. plainto_tsquery is implicit-AND: one word the
    // target doc lacks ("what is the retry SCHEDULE…") returned ZERO results and the
    // vector index was never consulted (the M0 benchmark's day-one finding). Two new
    // channels fill the pool; ZC_BM25_OR_FALLBACK=0 / ZC_VECTOR_CANDIDATES=0 restore
    // the legacy BM25-gated behaviour exactly.
    const candMap = new Map<string, CandRow>(bm25Res.rows.map((r) => [r.source, r]));

    // (a) OR-fallback keyword pass — any-term matches join when the AND pass under-fills.
    if (Config.BM25_OR_FALLBACK && candMap.size < candidates) {
      const terms = [...new Set(queryText.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3))].slice(0, 12);
      if (terms.length >= 2) {
        try {
          const orRes = await this.pool.query<CandRow>(`
            SELECT ke.source, ke.content,
                   ts_rank(to_tsvector('english', ke.content), to_tsquery('english', $2)) AS rank,
                   COALESCE(sm.source_type, 'internal') as source_type
            FROM   knowledge_entries ke
            LEFT JOIN source_meta sm ON sm.project_hash = ke.project_hash AND sm.source = ke.source
            WHERE  ke.project_hash = $1
              AND  to_tsvector('english', ke.content) @@ to_tsquery('english', $2)
            ORDER  BY rank DESC
            LIMIT  $3
          `, [projectHash, terms.join(" | "), candidates]);
          for (const r of orRes.rows) if (!candMap.has(r.source)) candMap.set(r.source, r);
        } catch { /* malformed tsquery — AND results only */ }
      }
    }

    // (b) Independent vector candidates — nearest stored vectors join the pool even with
    // zero keyword overlap (synthetic: they score via the cosine/graph channels only).
    let qEmbedEarly: Awaited<ReturnType<typeof getEmbedding>> = null;
    if (Config.VECTOR_CANDIDATES > 0) {
      try {
        qEmbedEarly = await getEmbedding(queryText);
        if (qEmbedEarly) {
          const qVecStr = "[" + qEmbedEarly.vector.join(",") + "]";
          const vecRes = await this.pool.query<CandRow>(`
            SELECT ke.source, ke.content, 0 AS rank,
                   COALESCE(sm.source_type, 'internal') as source_type
            FROM   embeddings e
            JOIN   knowledge_entries ke ON ke.project_hash = e.project_hash AND ke.source = e.source
            LEFT JOIN source_meta sm ON sm.project_hash = ke.project_hash AND sm.source = ke.source
            WHERE  e.project_hash = $1 AND e.model_name = $2
              AND  (e.vector <=> $3::vector) <= $5
            ORDER  BY e.vector <=> $3::vector
            LIMIT  $4
          `, [projectHash, ACTIVE_MODEL, qVecStr, Config.VECTOR_CANDIDATES, 1 - Config.VECTOR_MIN_SIM]);
          for (const r of vecRes.rows) if (!candMap.has(r.source)) candMap.set(r.source, { ...r, synthetic: true });
        }
      } catch { /* pgvector unavailable — keyword candidates only */ }
    }

    if (candMap.size === 0) return [];
    const candRows = [...candMap.values()];

    // Tier-1 A: backlink in-degree boost (PG mirror). ONE batched lookup, shared by the
    // vector path AND the BM25 fallback. Empty when W_BACKLINK=0 / no rows / pre-migration
    // ⇒ blBoost()=0 ⇒ ranking byte-identical to pre-backlink behaviour.
    const blMap = new Map<string, number>();
    if (Config.W_BACKLINK > 0) {
      try {
        const blRes = await this.pool.query<{ source: string; weighted_in: number }>(
          `SELECT source, weighted_in FROM kb_backlinks_pg WHERE project_hash = $1 AND source = ANY($2)`,
          [projectHash, candRows.map(r => r.source)]
        );
        for (const r of blRes.rows) blMap.set(r.source, r.weighted_in);
      } catch { /* kb_backlinks_pg absent (pre-migration) — leave map empty */ }
    }
    const blBoost = (src: string): number => {
      const wIn = blMap.get(src) ?? 0;
      return wIn > 0 ? Config.W_BACKLINK * (Math.log(1 + wIn) / Math.log(1 + Config.BACKLINK_LOG_BASE)) : 0;
    };

    // Try vector reranking
    let results: KnowledgeEntry[] = [];
    try {
      const qEmbed = qEmbedEarly ?? await getEmbedding(queryText);
      if (qEmbed) {
        const qVec = "[" + qEmbed.vector.join(",") + "]";
        const sources = candRows.map(r => r.source);

        // Get stored embeddings for ALL candidates (keyword + OR-fallback + vector-injected)
        const embRes = await this.pool.query<{ source: string; vector: string }>(
          `SELECT source, vector::text FROM embeddings
           WHERE project_hash = $1 AND source = ANY($2) AND model_name = $3`,
          [projectHash, sources, ACTIVE_MODEL]
        );

        const embMap = new Map(embRes.rows.map(r => [r.source, r.vector]));
        const maxBm25 = Math.max(...candRows.map(r => r.rank), 1);

        // Compute cosine for every candidate up front (needed by both fusion modes).
        const withCos = candRows.map(row => {
          let cosScore = 0;
          const storedVecStr = embMap.get(row.source);
          if (storedVecStr) {
            // Parse pgvector "[x1,x2,...,xN]" string back to Float32Array
            const nums = storedVecStr.slice(1, -1).split(",").map(Number);
            cosScore   = cosineSimilarity(new Float32Array(nums), qEmbed.vector);
          }
          return { row, cosScore };
        });

        // Tier-2 #3: RRF fuses per-list RANK positions (scale-free); weighted fuses
        // normalized scores + additive backlink boost (byte-identical to v0.31.0).
        const useRRF = Config.RETRIEVAL_FUSION === "rrf";
        // BM25 rank list: keyword-evidence candidates ONLY (synthetic vector-injected
        // rows have no keyword signal — they score via the cosine/graph channels).
        const bm25RankMap = new Map(candRows.filter(r => !r.synthetic)
          .sort((a, b) => b.rank - a.rank).map((r, i) => [r.source, i + 1]));
        let cosRankMap: Map<string, number> | null = null;
        let blRankMap:  Map<string, number> | null = null;
        let graphRankMap: Map<string, number> | null = null;
        if (useRRF) {
          cosRankMap = new Map([...withCos].sort((a, b) => b.cosScore - a.cosScore).map((x, i) => [x.row.source, i + 1]));
          if (Config.W_BACKLINK > 0 && blMap.size > 0) {
            blRankMap = new Map(candRows.map(r => ({ s: r.source, w: blMap.get(r.source) ?? 0 }))
              .filter(x => x.w > 0).sort((a, b) => b.w - a.w).map((x, i) => [x.s, i + 1]));
          }
          // v0.37.0 — 4th list: graph neighbor expansion (SQLite parity). 1-hop kb_edges_pg
          // neighbors of the top candidates, ranked by aggregate weight; out-of-set neighbors
          // (KB sources + live memory facts) are pulled into the candidate pool.
          if (Config.RRF_W_GRAPH > 0) {
            try {
              const topSeeds = candRows.slice(0, Config.GRAPH_EXPAND_TOP_K).map(r => r.source);
              if (topSeeds.length > 0) {
                // M4 (v0.41.0) — bounded multi-hop BFS (was 1-hop). A doc chain
                // A→B→C where only A matches the query now surfaces C at depth 2,
                // with per-hop weight decay so nearer neighbors dominate.
                const seeds = new Set(topSeeds);
                const nScore = new Map<string, number>();
                let frontier = topSeeds;
                const visited = new Set(topSeeds);
                for (let depth = 1; depth <= Math.max(1, Config.GRAPH_MAX_DEPTH) && frontier.length > 0; depth++) {
                  const decay = Math.pow(Config.GRAPH_HOP_DECAY, depth - 1);
                  const eRows = (await this.pool.query<{ a: string; b: string; weight: number }>(
                    `SELECT from_source AS a, to_source AS b, weight FROM kb_edges_pg
                     WHERE project_hash = $1 AND (from_source = ANY($2) OR to_source = ANY($2))`,
                    [projectHash, frontier])).rows;
                  const frontierSet = new Set(frontier);
                  const next: string[] = [];
                  for (const e of eRows) {
                    const nb = frontierSet.has(e.a) ? e.b : (frontierSet.has(e.b) ? e.a : null);
                    if (!nb || seeds.has(nb)) continue;
                    nScore.set(nb, (nScore.get(nb) ?? 0) + (e.weight ?? 1) * decay);
                    if (!visited.has(nb)) { visited.add(nb); next.push(nb); }
                  }
                  frontier = next;
                }
                const rankedN = [...nScore.entries()].sort((x, y) => y[1] - x[1]).slice(0, Config.GRAPH_EXPAND_MAX);
                if (rankedN.length > 0) {
                  graphRankMap = new Map(rankedN.map(([s], i) => [s, i + 1]));
                  const inSet = new Set(candRows.map(r => r.source));
                  const missing = rankedN.map(([s]) => s).filter(s => !inSet.has(s));
                  const kbMissing  = missing.filter(s => !s.startsWith("memory:"));
                  const memMissing = missing.filter(s => s.startsWith("memory:"));
                  if (kbMissing.length > 0) {
                    const rows2 = (await this.pool.query<{ source: string; content: string }>(
                      `SELECT source, content FROM knowledge_entries WHERE project_hash = $1 AND source = ANY($2)`,
                      [projectHash, kbMissing])).rows;
                    for (const r of rows2) withCos.push({ row: { source: r.source, content: r.content, rank: 0, source_type: "internal" }, cosScore: 0 });
                  }
                  for (const s of memMissing) {
                    const parts = s.split(":");
                    if (parts.length < 3) continue;
                    const wm = (await this.pool.query<{ value: string }>(
                      `SELECT value FROM working_memory WHERE project_hash = $1 AND agent_id = $2 AND key = $3 AND valid_to IS NULL`,
                      [projectHash, parts[1], parts.slice(2).join(":")])).rows[0];
                    if (wm) withCos.push({ row: { source: s, content: wm.value, rank: 0, source_type: "internal" }, cosScore: 0 });
                  }
                }
              }
            } catch { /* kb_edges_pg absent — no graph channel */ }
          }
        }

        const scored = withCos.map(({ row, cosScore }) => {
          let hybrid: number;
          if (useRRF) {
            const K   = Config.RRF_K;
            const br  = bm25RankMap.get(row.source);
            const cr  = cosRankMap?.get(row.source);
            const blr = blRankMap?.get(row.source);
            const gr  = graphRankMap?.get(row.source);
            hybrid =
              (br  ? Config.RRF_W_BM25     / (K + br)  : 0) +
              (cr  ? Config.RRF_W_VEC      / (K + cr)  : 0) +
              (blr ? Config.RRF_W_BACKLINK / (K + blr) : 0) +
              (gr  ? Config.RRF_W_GRAPH    / (K + gr)  : 0);
          } else {
            hybrid = Config.W_BM25 * (row.rank / maxBm25) + Config.W_COSINE * cosScore + blBoost(row.source);
          }
          return { ...row, vectorScore: cosScore, hybridScore: hybrid };
        });

        scored.sort((a, b) => b.hybridScore - a.hybridScore);

        results = scored.slice(0, limit).map(r => ({
          source:         r.source,
          content:        r.content,
          snippet:        r.content.slice(0, 200),
          rank:           r.hybridScore,
          vectorScore:    r.vectorScore,
          backlinkScore:  blBoost(r.source) || undefined,
          sourceType:     r.source_type,
          nonAsciiSource: /[^\x00-\x7F]/.test(r.source),
        }));
      }
    } catch {
      // Vector reranking failed — fall back to BM25 only
    }

    if (results.length === 0) {
      // BM25-only fallback (Ollama down). Tier-1 A: same backlink boost. W_BACKLINK=0
      // ⇒ boost=0 ⇒ re-sort the already-rank-sorted rows by raw ts_rank ⇒ byte-identical.
      const kwRows = candRows.filter(r => !r.synthetic);
      const maxBm25Fb = Math.max(...kwRows.map(r => r.rank), 1);
      const fb = kwRows.map(r => {
        const boost = blBoost(r.source);
        const rank  = Config.W_BACKLINK > 0 ? (r.rank / maxBm25Fb) + boost : r.rank;
        return { r, rank, boost };
      });
      fb.sort((a, b) => b.rank - a.rank);
      results = fb.slice(0, limit).map(({ r, rank, boost }) => ({
        source:         r.source,
        content:        r.content,
        snippet:        r.content.slice(0, 200),
        rank,
        backlinkScore:  boost || undefined,
        sourceType:     r.source_type,
        nonAsciiSource: /[^\x00-\x7F]/.test(r.source),
      }));
    }

    // Apply depth filtering (L0/L1/L2)
    if (opts.depth && opts.depth !== "L2") {
      const smRes = await this.pool.query<{ source: string; l0_summary: string; l1_summary: string }>(
        "SELECT source, l0_summary, l1_summary FROM source_meta WHERE project_hash = $1 AND source = ANY($2)",
        [projectHash, results.map(r => r.source)]
      );
      const smMap = new Map(smRes.rows.map(r => [r.source, r]));
      results = results.map(r => {
        const sm = smMap.get(r.source);
        if (!sm) return r;
        const content = opts.depth === "L0"
          ? (sm.l0_summary || r.content.slice(0, Config.TIER_L0_CHARS))
          : (sm.l1_summary || r.content.slice(0, Config.TIER_L1_CHARS));
        return { ...r, content, snippet: content.slice(0, 200) };
      });
    }

    return results;
  }

  async searchGlobal(queries: string[], limit = 10): Promise<CrossProjectEntry[]> {
    const queryText = queries.join(" ");
    const res = await this.pool.query<{
      source: string; content: string; rank: number;
      source_type: string; project_hash: string; project_label: string;
    }>(`
      SELECT ke.source, ke.content,
             ts_rank(to_tsvector('english', ke.content), plainto_tsquery('english', $1))
               + (CASE WHEN $3 > 0 AND bl.weighted_in IS NOT NULL
                       THEN $3 * (ln(1 + bl.weighted_in) / ln(1 + $4)) ELSE 0 END) AS rank,
             COALESCE(sm.source_type, 'internal') as source_type,
             ke.project_hash,
             COALESCE(pm.value, ke.project_hash) as project_label
      FROM   knowledge_entries ke
      LEFT JOIN source_meta sm ON sm.project_hash = ke.project_hash AND sm.source = ke.source
      LEFT JOIN project_meta pm ON pm.project_hash = ke.project_hash AND pm.key = 'project_label'
      LEFT JOIN kb_backlinks_pg bl ON bl.project_hash = ke.project_hash AND bl.source = ke.source
      WHERE  to_tsvector('english', ke.content) @@ plainto_tsquery('english', $1)
      ORDER  BY rank DESC
      LIMIT  $2
    `, [queryText, limit, Config.W_BACKLINK, Config.BACKLINK_LOG_BASE]);

    return res.rows.map(r => ({
      source:         r.source,
      content:        r.content,
      snippet:        r.content.slice(0, 200),
      rank:           r.rank,
      sourceType:     r.source_type,
      nonAsciiSource: /[^\x00-\x7F]/.test(r.source),
      projectHash:    r.project_hash,
      projectLabel:   r.project_label,
    }));
  }

  async getKbStats(projectPath: string): Promise<KbStats> {
    const projectHash = ph(projectPath);
    const [totRes, extRes, sumRes, embRes] = await Promise.all([
      this.pool.query<{ n: string }>(
        "SELECT COUNT(*) as n FROM knowledge_entries WHERE project_hash = $1", [projectHash]
      ),
      this.pool.query<{ n: string }>(
        "SELECT COUNT(*) as n FROM source_meta WHERE project_hash = $1 AND source_type = 'external'", [projectHash]
      ),
      this.pool.query<{ n: string }>(
        "SELECT COUNT(*) as n FROM source_meta WHERE project_hash = $1 AND retention_tier = 'summary'", [projectHash]
      ),
      this.pool.query<{ n: string }>(
        "SELECT COUNT(*) as n FROM embeddings WHERE project_hash = $1", [projectHash]
      ),
    ]);

    // Approximate DB size from pg_total_relation_size
    const sizeRes = await this.pool.query<{ bytes: string }>(
      `SELECT pg_total_relation_size('knowledge_entries') +
              pg_total_relation_size('embeddings') +
              pg_total_relation_size('working_memory') +
              pg_total_relation_size('broadcasts') AS bytes`
    );

    return {
      totalEntries:    parseInt(totRes.rows[0]!.n, 10),
      externalEntries: parseInt(extRes.rows[0]!.n, 10),
      summaryEntries:  parseInt(sumRes.rows[0]!.n, 10),
      embeddingsCached: parseInt(embRes.rows[0]!.n, 10),
      dbSizeBytes:     parseInt(sizeRes.rows[0]?.bytes ?? "0", 10),
    };
  }

  async explain(projectPath: string, query: string, depth = "L1"): Promise<ExplainResult> {
    const entries = await this.search(projectPath, [query], { limit: 10, depth: depth as "L0" | "L1" | "L2" });
    return {
      query,
      depth,
      results: entries.map(e => ({
        source:      e.source,
        bm25Score:   e.rank,
        vectorScore: e.vectorScore ?? 0,
        hybridScore: e.rank,
        tier:        depth,
        snippet:     e.snippet,
      })),
      model:      ACTIVE_MODEL,
      searchMode: "hybrid-bm25-cosine",
    };
  }

  // ── Knowledge graph + backlinks (Tier-1 A, PG-native) ─────────────────────
  private static _blTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _scheduleBacklinkRebuild(projectPath: string): void {
    const existing = PostgresStore._blTimers.get(projectPath);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      PostgresStore._blTimers.delete(projectPath);
      this.rebuildBacklinks(projectPath).catch(() => undefined);
    }, 5_000);
    if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
    PostgresStore._blTimers.set(projectPath, t);
  }

  async rebuildBacklinks(projectPath: string): Promise<{ edges: number; nodes: number; topHub: { source: string; weightedIn: number } | null }> {
    return this._rebuildBacklinksByHash(ph(projectPath));
  }

  /**
   * Boot backfill: rebuild the backlink graph for every project that has
   * knowledge_entries but NO kb_backlinks_pg yet — i.e. projects indexed before
   * the rebuild trigger existed, or whose short-lived bulk-index process exited
   * before the debounced rebuild fired. Idempotent and safe: the NOT EXISTS
   * filter means it only ever touches projects with an EMPTY graph, so it can
   * never clobber a populated one. This is what makes the W_BACKLINK boost
   * actually active for the body of already-indexed projects in a live deployment.
   */
  async backfillBacklinks(): Promise<{ projects: number; edges: number }> {
    const rows = (await this.pool.query<{ project_hash: string }>(`
      SELECT DISTINCT ke.project_hash FROM knowledge_entries ke
      WHERE NOT EXISTS (SELECT 1 FROM kb_backlinks_pg b WHERE b.project_hash = ke.project_hash)
    `)).rows;
    let edges = 0;
    for (const r of rows) {
      try { edges += (await this._rebuildBacklinksByHash(r.project_hash)).edges; }
      catch { /* best-effort per project — one bad project must not abort the backfill */ }
    }
    return { projects: rows.length, edges };
  }

  private async _rebuildBacklinksByHash(projectHash: string): Promise<{ edges: number; nodes: number; topHub: { source: string; weightedIn: number } | null }> {
    // v0.36.0 — memory-aware extraction (SQLite parity): live working-memory facts join the
    // co-reference scan as "memory:<agent>:<key>" pseudo-sources (eviction-archival naming),
    // so a fact mentioning "session.ts" creates a memory→file edge and the file gains boost.
    const rows = (await this.pool.query<{ source: string; content: string }>(
      `SELECT source, content FROM knowledge_entries WHERE project_hash = $1
       UNION ALL
       SELECT ('memory:' || agent_id || ':' || key) AS source, value AS content
         FROM working_memory WHERE project_hash = $1 AND valid_to IS NULL`, [projectHash]
    )).rows;
    const typed = extractCoReferences(rows).map((e) => ({
      from: e.from, to: e.to, relation: classifyRelation(e.from, e.to, e.matchKind), matchKind: e.matchKind, weight: e.weight,
    }));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // v0.37.0 — preserve LLM-extracted entity edges across co-reference rebuilds.
      await client.query("DELETE FROM kb_edges_pg     WHERE project_hash = $1 AND match_kind <> 'entity'", [projectHash]);
      await client.query("DELETE FROM kb_backlinks_pg WHERE project_hash = $1", [projectHash]);
      const CHUNK = 100;
      for (let i = 0; i < typed.length; i += CHUNK) {
        const chunk = typed.slice(i, i + CHUNK);
        const vals: string[] = []; const params: unknown[] = []; let p = 1;
        for (const e of chunk) {
          vals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
          params.push(projectHash, e.from, e.to, e.relation, e.matchKind, e.weight);
        }
        await client.query(
          `INSERT INTO kb_edges_pg(project_hash, from_source, to_source, relation_type, match_kind, weight)
           VALUES ${vals.join(",")}
           ON CONFLICT (project_hash, from_source, to_source, relation_type) DO UPDATE SET
             match_kind = EXCLUDED.match_kind, weight = EXCLUDED.weight, computed_at = NOW()`, params);
      }
      await client.query(
        `INSERT INTO kb_backlinks_pg(project_hash, source, in_degree, weighted_in)
         SELECT $1, to_source, COUNT(DISTINCT from_source), SUM(weight)
         FROM kb_edges_pg WHERE project_hash = $1 GROUP BY to_source
         ON CONFLICT (project_hash, source) DO UPDATE SET
           in_degree = EXCLUDED.in_degree, weighted_in = EXCLUDED.weighted_in, computed_at = NOW()`, [projectHash]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK"); throw e;
    } finally {
      client.release();
    }
    const hub = (await this.pool.query<{ source: string; weighted_in: number }>(
      "SELECT source, weighted_in FROM kb_backlinks_pg WHERE project_hash = $1 ORDER BY weighted_in DESC LIMIT 1", [projectHash]
    )).rows[0];
    return { edges: typed.length, nodes: rows.length, topHub: hub ? { source: hub.source, weightedIn: hub.weighted_in } : null };
  }

  async graphData(projectPath: string): Promise<{ nodes: Array<{ id: string; inDegree: number; weightedIn: number }>; edges: Array<{ from: string; to: string; relation: string; weight: number }> }> {
    const projectHash = ph(projectPath);
    try {
      const er = (await this.pool.query<{ from_source: string; to_source: string; relation_type: string; weight: number }>(
        "SELECT from_source, to_source, relation_type, weight FROM kb_edges_pg WHERE project_hash = $1 LIMIT 2000", [projectHash])).rows;
      const br = (await this.pool.query<{ source: string; in_degree: number; weighted_in: number }>(
        "SELECT source, in_degree, weighted_in FROM kb_backlinks_pg WHERE project_hash = $1", [projectHash])).rows;
      const blMap = new Map(br.map((b) => [b.source, { inDegree: b.in_degree, weightedIn: b.weighted_in }]));
      const edges = er.map((e) => ({ from: e.from_source, to: e.to_source, relation: e.relation_type, weight: e.weight }));
      // Nodes = edge endpoints ∪ ALL KB sources ∪ live working-memory facts.
      // v0.35.0 — previously only edge endpoints rendered, so a research/memory-heavy
      // project (memory facts + session summaries, no file cross-references) showed an
      // EMPTY graph despite having real knowledge. Isolated sources and live memory
      // facts now render as nodes (weightedIn=0 → smallest size); edges are unchanged.
      const ids = new Set<string>();
      for (const e of edges) { ids.add(e.from); ids.add(e.to); }
      const src = (await this.pool.query<{ source: string }>(
        "SELECT source FROM knowledge_entries WHERE project_hash = $1 ORDER BY created_at DESC LIMIT 300", [projectHash])).rows;
      for (const r of src) ids.add(r.source);
      const wm = (await this.pool.query<{ agent_id: string; key: string }>(
        "SELECT agent_id, key FROM working_memory WHERE project_hash = $1 AND valid_to IS NULL ORDER BY importance DESC, created_at DESC LIMIT 200", [projectHash])).rows;
      for (const r of wm) ids.add(`memory:${r.agent_id}:${r.key}`); // same naming as eviction-archival sources
      const nodes = [...ids].slice(0, 500).map((id) => ({ id, inDegree: blMap.get(id)?.inDegree ?? 0, weightedIn: blMap.get(id)?.weightedIn ?? 0 }));
      return { nodes, edges };
    } catch { return { nodes: [], edges: [] }; }
  }

  async backlinksFor(projectPath: string, source: string, limit: number): Promise<{ inDegree: number; weightedIn: number; inbound: Array<{ from: string; relation: string; weight: number }> } | null> {
    const projectHash = ph(projectPath);
    try {
      const bl = (await this.pool.query<{ in_degree: number; weighted_in: number }>(
        "SELECT in_degree, weighted_in FROM kb_backlinks_pg WHERE project_hash = $1 AND source = $2", [projectHash, source])).rows[0];
      if (!bl) return null;
      const er = (await this.pool.query<{ from_source: string; relation_type: string; weight: number }>(
        "SELECT from_source, relation_type, weight FROM kb_edges_pg WHERE project_hash = $1 AND to_source = $2 ORDER BY weight DESC LIMIT $3",
        [projectHash, source, Math.min(Math.max(limit, 1), 100)])).rows;
      return { inDegree: bl.in_degree, weightedIn: bl.weighted_in, inbound: er.map((e) => ({ from: e.from_source, relation: e.relation_type, weight: e.weight })) };
    } catch { return null; }
  }

  // ── Memory contradictions (Tier-1 B, PG-native) ───────────────────────────
  async scanContradictions(projectPath: string, agentId: string): Promise<{ scanned: number; flagged: number; ollamaAvailable: boolean }> {
    return this._scanContradictionsByHash(ph(projectPath), sanitize(agentId, 64));
  }

  private async _scanContradictionsByHash(projectHash: string, safeAgent: string, sinceDays?: number): Promise<{ scanned: number; flagged: number; ollamaAvailable: boolean }> {
    // sinceDays (cron only) restricts the scan to RECENT facts so the periodic sweep flags fresh
    // conflicts rather than re-embedding + re-flagging years of accumulated history every cycle.
    // The recall-time path passes nothing ⇒ scans all facts (unchanged).
    const params: unknown[] = [projectHash, safeAgent, MAX_SCAN_FACTS];
    let recencyClause = "";
    if (typeof sinceDays === "number" && sinceDays > 0) {
      params.push(sinceDays);
      recencyClause = ` AND created_at > NOW() - ($${params.length}::int * INTERVAL '1 day')`;
    }
    const facts = (await this.pool.query<{ key: string; value: string; kind: string | null; resolution_status: string | null; created_at: Date; agent_id: string }>(
      `SELECT key, value, kind, resolution_status, created_at, agent_id FROM working_memory
       WHERE project_hash = $1 AND (agent_id = $2 OR agent_id = 'default') AND importance >= 3 AND valid_to IS NULL${recencyClause}
       ORDER BY importance DESC, created_at DESC LIMIT $3`, params)).rows;
    if (facts.length < 2) return { scanned: facts.length, flagged: 0, ollamaAvailable: true };

    // M5 hardening (v0.41.0): a single null embed (transient blip) used to ABORT the
    // whole scan and report "Ollama unavailable" while everything else worked. Now:
    // skip the failing fact and continue — only an all-null run means Ollama is down.
    const vectors = new Map<string, Float32Array>();
    let embFails = 0;
    for (const f of facts) {
      const emb = await getEmbedding(f.value);
      if (!emb) { embFails++; continue; }
      vectors.set(f.key, emb.vector);
    }
    if (vectors.size < 2) {
      return { scanned: facts.length, flagged: 0, ollamaAvailable: embFails < facts.length };
    }
    const found: Array<{ ka: string; kb: string; sim: number; reason: string; detail: string; victim: string | null }> = [];
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const a = facts[i]!, b = facts[j]!;
        const va = vectors.get(a.key), vb = vectors.get(b.key);
        if (!va || !vb) continue;
        const sim = cosineSimilarity(va, vb);
        if (sim < SIM_HIGH) continue;
        const conflict = detectConflict(a, b);
        if (!conflict) continue;
        const [ka, kb] = a.key < b.key ? [a.key, b.key] : [b.key, a.key];
        // v0.37.0 — clear supersession ⇒ auto-resolve (retire the stale side); else open triage.
        const victim = Config.AUTO_RESOLVE ? autoResolveVictim(a, b, conflict.reason) : null;
        found.push({ ka, kb, sim, reason: conflict.reason, detail: conflict.detail, victim });
      }
    }
    const agentOf = new Map(facts.map((f) => [f.key, f.agent_id]));
    let flagged = 0;
    for (const f of found) {
      // Operator override wins forever: a pair previously reviewed (dismissed/acknowledged/
      // resolved) is never auto-resolved and never re-opened by the scan.
      const existing = (await this.pool.query<{ status: string }>(
        `SELECT status FROM memory_contradictions_pg WHERE project_hash = $1 AND agent_id = $2 AND key_a = $3 AND key_b = $4`,
        [projectHash, safeAgent, f.ka, f.kb])).rows[0];
      if (existing && existing.status !== "open") continue;

      if (f.victim) {
        const winner = f.victim === f.ka ? f.kb : f.ka;
        const retired = await this._retireFactByHash(
          projectHash, f.victim, agentOf.get(f.victim) ?? "default", winner, "superseded",
        ).catch(() => false);
        if (retired) {
          await this.pool.query(
            `INSERT INTO memory_contradictions_pg(project_hash, agent_id, key_a, key_b, similarity, reason, detail, status, surfaced_by, reviewed_at, resolution_mode)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'resolved','cron',NOW(),'auto')
             ON CONFLICT (project_hash, agent_id, key_a, key_b) DO UPDATE SET
               similarity = EXCLUDED.similarity, reason = EXCLUDED.reason, detail = EXCLUDED.detail,
               status = 'resolved', reviewed_at = NOW(), resolution_mode = 'auto', surfaced_at = NOW()`,
            [projectHash, safeAgent, f.ka, f.kb, f.sim, f.reason, `Auto-resolved: '${f.victim}' superseded by '${winner}'. ${f.detail}`]);
          flagged++;
          continue;
        }
        // retire failed (e.g. hash→path unknown) → fall through to open triage
      }
      await this.pool.query(
        `INSERT INTO memory_contradictions_pg(project_hash, agent_id, key_a, key_b, similarity, reason, detail, status, surfaced_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open','cron')
         ON CONFLICT (project_hash, agent_id, key_a, key_b) DO UPDATE SET
           similarity = EXCLUDED.similarity, reason = EXCLUDED.reason, detail = EXCLUDED.detail, surfaced_at = NOW()`,
        [projectHash, safeAgent, f.ka, f.kb, f.sim, f.reason, f.detail]);
      flagged++;
    }
    return { scanned: facts.length, flagged, ollamaAvailable: true };
  }

  /**
   * Tier-2 #6 — background enrichment cycle. Re-scans contradictions for EVERY active
   * (project, agent) pair (so a contradiction is caught even with no recall to trigger the
   * recall-time scan) and backfills any empty backlink graphs. Idempotent + best-effort per
   * pair; bails early if Ollama is down (every scan would fail). Run on a schedule by the cron.
   */
  async runEnrichment(): Promise<{ projects: number; flagged: number; backfilledProjects: number; ollamaDown: boolean; entities?: number }> {
    // Scan the SHARED 'default' pool ONCE per project (NOT per agent). Contradictions stored
    // under agent_id='default' surface for every agent via recall's "agent OR default" clause,
    // so there is no per-agent row duplication (scanning per pair inflated 91 distinct conflicts
    // to 317 rows). Agent-PRIVATE conflicts are still caught by that agent's own recall-time scan
    // (the always-on write-time re-arm), so coverage is preserved.
    const scanDays = Math.max(1, parseInt(process.env.ZC_ENRICHMENT_SCAN_DAYS ?? "14", 10) || 14);
    const projects = (await this.pool.query<{ project_hash: string }>(
      `SELECT DISTINCT project_hash FROM working_memory`
    )).rows;
    let flagged = 0;
    let ollamaDown = false;
    for (const p of projects) {
      try {
        const r = await this._scanContradictionsByHash(p.project_hash, "default", scanDays);
        flagged += r.flagged;
        if (!r.ollamaAvailable) { ollamaDown = true; break; } // Ollama down ⇒ every scan fails; stop hammering
      } catch { /* best-effort per project — one bad project must not abort the cycle */ }
    }
    let backfilledProjects = 0;
    try { backfilledProjects = (await this.backfillBacklinks()).projects; } catch { /* best-effort */ }
    // v0.37.0 — keep the flag table and working memory lean:
    //  - reviewed contradiction rows older than CONTRA_PRUNE_DAYS are deleted (short audit
    //    window, then gone — the facts' own history lives in the KB archive);
    //  - retired facts older than RETIRE_PURGE_DAYS are deleted (they were archived to the
    //    KB at retire time, so this is a purge of the tombstone row, not of the knowledge).
    try {
      await this.pool.query(
        `DELETE FROM memory_contradictions_pg WHERE status <> 'open' AND reviewed_at < NOW() - ($1::int * INTERVAL '1 day')`,
        [Config.CONTRA_PRUNE_DAYS]);
      await this.pool.query(
        `DELETE FROM working_memory WHERE valid_to IS NOT NULL AND valid_to < NOW() - ($1::int * INTERVAL '1 day')`,
        [Config.RETIRE_PURGE_DAYS]);
    } catch { /* best-effort */ }
    // v0.37.0 — budgeted semantic entity extraction over unscanned KB entries.
    let entities = 0;
    if (!ollamaDown) {
      try {
        const er = await this.runEntityExtraction();
        entities = er.edges;
        if (er.ollamaDown) ollamaDown = true;
      } catch { /* best-effort */ }
    }
    // v0.37.0 — refresh community summaries for up to 2 projects with stale/missing
    // summaries per cycle (powers zc_search mode:"global").
    if (!ollamaDown) {
      try {
        const stale = (await this.pool.query<{ project_hash: string }>(
          `SELECT DISTINCT e.project_hash FROM kb_edges_pg e
            WHERE NOT EXISTS (SELECT 1 FROM kb_community_summaries_pg s
                               WHERE s.project_hash = e.project_hash AND s.computed_at > NOW() - INTERVAL '24 hours')
            LIMIT 2`)).rows;
        for (const p of stale) {
          const r2 = await this.refreshCommunitySummaries(p.project_hash);
          if (r2.ollamaDown) { ollamaDown = true; break; }
        }
      } catch { /* best-effort */ }
    }
    // v0.37.0 — automated trajectory→skill discovery (6h-gated internally, zero-LLM).
    try { await this.runSkillDiscovery(); } catch { /* best-effort */ }
    // v0.39.0 — drain any stale-model embedding backlog (budgeted; explicit model migration).
    if (!ollamaDown) {
      try {
        const re = await this.reembedStaleModels();
        if (re.ollamaDown) ollamaDown = true;
      } catch { /* best-effort */ }
    }
    // M1 (v0.41.0) — backfill embeddings for LIVE working-memory facts that predate
    // remember-time embedding (budgeted). Focused recall degrades gracefully without
    // them (rel=0), but each cycle closes more of the gap.
    if (!ollamaDown) {
      try { await this._backfillFactEmbeddings(40); } catch { /* best-effort */ }
    }
    // M2 (v0.41.0) — memory consolidation: merge near-duplicate facts (budgeted,
    // conservative, revivable). See src/consolidation.ts for the full contract.
    if (!ollamaDown) {
      try { await this.consolidateMemory(); } catch { /* best-effort */ }
    }
    return { projects: projects.length, flagged, backfilledProjects, ollamaDown, entities };
  }

  /**
   * M2 (v0.41.0) — one consolidation pass: for each (project, agent) namespace with
   * live facts, find paraphrase-level near-duplicate pairs (cosine ≥ CONSOLIDATE_SIM,
   * same kind, no conflict signal), LLM-merge them into a canonical statement on the
   * survivor (higher importance wins; tie → older key survives), and RETIRE the loser
   * (superseded_by=survivor, retired_reason='consolidated' — revivable like any
   * retirement). Budgeted to CONSOLIDATE_MAX_PER_CYCLE merges per cycle.
   */
  async consolidateMemory(): Promise<{ merged: number; examined: number }> {
    const { CONSOLIDATE_ENABLED, CONSOLIDATE_MAX_PER_CYCLE, selectMergePairs, pickSurvivor, llmMergeFacts } =
      await import("./consolidation.js");
    if (!CONSOLIDATE_ENABLED) return { merged: 0, examined: 0 };

    // Namespaces with enough live facts to bother (cheapest projects first is fine).
    const namespaces = (await this.pool.query<{ project_hash: string; agent_id: string; n: string }>(
      `SELECT project_hash, agent_id, COUNT(*)::text AS n FROM working_memory
        WHERE valid_to IS NULL GROUP BY project_hash, agent_id HAVING COUNT(*) >= 4
        ORDER BY COUNT(*) DESC LIMIT 20`)).rows;

    let merged = 0, examined = 0;
    for (const ns of namespaces) {
      if (merged >= CONSOLIDATE_MAX_PER_CYCLE) break;
      const facts = (await this.pool.query<{ key: string; value: string; importance: number; kind: string | null; created_at: Date; agent_id: string }>(
        `SELECT key, value, importance, kind, created_at, agent_id FROM working_memory
          WHERE project_hash = $1 AND agent_id = $2 AND valid_to IS NULL
          ORDER BY created_at DESC LIMIT 250`, [ns.project_hash, ns.agent_id])).rows;
      const embRes = (await this.pool.query<{ source: string; vector: string }>(
        `SELECT source, vector::text FROM embeddings
          WHERE project_hash = $1 AND model_name = $2 AND source = ANY($3)`,
        [ns.project_hash, ACTIVE_MODEL, facts.map((f) => `memory:${f.agent_id}:${f.key}`)])).rows;
      const vectors = new Map<string, Float32Array>();
      for (const e of embRes) {
        const key = e.source.split(":").slice(2).join(":");
        vectors.set(key, new Float32Array(e.vector.slice(1, -1).split(",").map(Number)));
      }
      examined += facts.length;

      const pairs = selectMergePairs(facts, vectors, cosineSimilarity);
      for (const p of pairs) {
        if (merged >= CONSOLIDATE_MAX_PER_CYCLE) break;
        const mergedText = await llmMergeFacts(p.a.value, p.b.value);
        if (!mergedText) continue; // LLM unavailable / vetoed (NOT_DUPLICATE) / junk — skip
        const { survivor, loser } = pickSurvivor(p.a, p.b);
        // 1. survivor gets the canonical merged text (+ re-embed, content-hash aware)
        await this.pool.query(
          `UPDATE working_memory SET value = $4 WHERE project_hash = $1 AND agent_id = $2 AND key = $3`,
          [ns.project_hash, ns.agent_id, survivor.key, mergedText.slice(0, 500)]);
        void this._storeEmbedding(ns.project_hash, mergedText.slice(0, 500), `memory:${ns.agent_id}:${survivor.key}`);
        // 2. loser is retired — out of recall, revivable, purged after RETIRE_PURGE_DAYS
        await this.pool.query(
          `UPDATE working_memory SET valid_to = NOW(), superseded_by = $4, retired_reason = 'consolidated'
            WHERE project_hash = $1 AND agent_id = $2 AND key = $3`,
          [ns.project_hash, ns.agent_id, loser.key, survivor.key]);
        merged++;
        const { logger } = await import("./logger.js");
        logger.info("memory", "facts_consolidated", {
          project_hash: ns.project_hash, agent_id: ns.agent_id,
          survivor: survivor.key, retired: loser.key, sim: +p.sim.toFixed(3),
        });
      }
    }
    return { merged, examined };
  }

  /**
   * M1 (v0.41.0) — embed live working-memory facts that don't yet have a vector
   * under their memory:<agent>:<key> source. Budgeted per enrichment cycle.
   */
  private async _backfillFactEmbeddings(budget: number): Promise<number> {
    const rows = (await this.pool.query<{ project_hash: string; agent_id: string; key: string; value: string }>(
      `SELECT wm.project_hash, wm.agent_id, wm.key, wm.value
         FROM working_memory wm
         LEFT JOIN embeddings e
           ON e.project_hash = wm.project_hash
          AND e.source = 'memory:' || wm.agent_id || ':' || wm.key
          AND e.model_name = $1
        WHERE wm.valid_to IS NULL AND e.source IS NULL
        LIMIT $2`, [ACTIVE_MODEL, budget])).rows;
    let done = 0;
    for (const r of rows) {
      try {
        await this._storeEmbedding(r.project_hash, r.value, `memory:${r.agent_id}:${r.key}`);
        done++;
      } catch { /* skip — retried next cycle */ }
    }
    return done;
  }

  /**
   * v0.37.0 — budgeted LLM entity/relation extraction (local Ollama only). Scans up to
   * ENTITY_BUDGET knowledge entries that have never been entity-scanned, persists
   * `match_kind='entity'` edges (preserved across co-reference rebuilds), marks the
   * entries scanned, and refreshes the backlink aggregate for the touched projects.
   * Failed extractions are NOT marked — they retry next cycle.
   */
  async runEntityExtraction(budget: number = ENTITY_BUDGET): Promise<{ scanned: number; edges: number; ollamaDown: boolean }> {
    if (!ENTITY_EXTRACT_ENABLED) return { scanned: 0, edges: 0, ollamaDown: false };
    const rows = (await this.pool.query<{ project_hash: string; source: string; content: string }>(
      `SELECT ke.project_hash, ke.source, ke.content
         FROM knowledge_entries ke
         JOIN source_meta sm ON sm.project_hash = ke.project_hash AND sm.source = ke.source
        WHERE sm.entity_scanned_at IS NULL AND ke.source NOT LIKE '[SESSION_SUMMARY]%'
        ORDER BY ke.created_at DESC LIMIT $1`, [budget])).rows;
    let scanned = 0, edges = 0;
    const touched = new Set<string>();
    for (const r of rows) {
      const x = await llmExtractEntities(r.content);
      if (x === null) return { scanned, edges, ollamaDown: true };
      for (const e of entityEdgesFor(r.source, x)) {
        await this.pool.query(
          `INSERT INTO kb_edges_pg(project_hash, from_source, to_source, relation_type, match_kind, weight)
           VALUES ($1,$2,$3,$4,'entity',$5)
           ON CONFLICT (project_hash, from_source, to_source, relation_type) DO UPDATE SET
             weight = kb_edges_pg.weight + 1, computed_at = NOW()`,
          [r.project_hash, e.from, e.to, e.relation, e.weight]);
        edges++;
      }
      await this.pool.query(
        `UPDATE source_meta SET entity_scanned_at = NOW() WHERE project_hash = $1 AND source = $2`,
        [r.project_hash, r.source]);
      scanned++;
      touched.add(r.project_hash);
    }
    // Refresh the backlink aggregate so entity hubs join the search boost + graph sizing.
    for (const h of touched) {
      try {
        await this.pool.query(`DELETE FROM kb_backlinks_pg WHERE project_hash = $1`, [h]);
        await this.pool.query(
          `INSERT INTO kb_backlinks_pg(project_hash, source, in_degree, weighted_in)
           SELECT $1, to_source, COUNT(DISTINCT from_source), SUM(weight)
           FROM kb_edges_pg WHERE project_hash = $1 GROUP BY to_source
           ON CONFLICT (project_hash, source) DO UPDATE SET
             in_degree = EXCLUDED.in_degree, weighted_in = EXCLUDED.weighted_in, computed_at = NOW()`, [h]);
      } catch { /* best-effort per project */ }
    }
    return { scanned, edges, ollamaDown: false };
  }

  /**
   * v0.37.0 — (re)compute Louvain communities over KB + live memory and pre-summarize the
   * top clusters (one budgeted local-LLM call each). These summaries power globalSearch.
   */
  async refreshCommunitySummaries(projectHash: string): Promise<{ communities: number; summarized: number; ollamaDown: boolean }> {
    const rows = (await this.pool.query<{ source: string; content: string }>(
      `SELECT source, content FROM knowledge_entries WHERE project_hash = $1
       UNION ALL
       SELECT ('memory:' || agent_id || ':' || key) AS source, value AS content
         FROM working_memory WHERE project_hash = $1 AND valid_to IS NULL`, [projectHash])).rows;
    const det = detectCommunitiesFromRows(rows);
    // v0.37.0 E2E fix: singleton clusters COUNT (an isolated research doc is still a theme —
    // dropping size-1 communities made global mode blind to them on small projects). Cap 8,
    // biggest first, so singletons only fill remaining slots.
    const top = det.communities.filter((c) => c.size >= 1).slice(0, 8);
    if (top.length === 0) return { communities: 0, summarized: 0, ollamaDown: false };
    const contentBySource = new Map(rows.map((r) => [r.source, r.content]));
    const membersOf = new Map<number, Array<{ source: string; snippet: string }>>();
    for (const a of det.assignments) {
      const list = membersOf.get(a.communityId) ?? [];
      if (list.length < 12) list.push({ source: a.source, snippet: (contentBySource.get(a.source) ?? "").slice(0, 300) });
      membersOf.set(a.communityId, list);
    }
    const out: Array<{ id: number; size: number; samples: string; summary: string }> = [];
    for (const c of top) {
      const s = await summarizeCommunity(membersOf.get(c.id) ?? []);
      if (s === null) return { communities: top.length, summarized: out.length, ollamaDown: true };
      out.push({ id: c.id, size: c.size, samples: c.sampleSources.slice(0, 4).join(","), summary: s });
    }
    await this.pool.query(`DELETE FROM kb_community_summaries_pg WHERE project_hash = $1`, [projectHash]);
    for (const o of out) {
      await this.pool.query(
        `INSERT INTO kb_community_summaries_pg(project_hash, community_id, size, sample_sources, summary)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (project_hash, community_id) DO UPDATE SET
           size = EXCLUDED.size, sample_sources = EXCLUDED.sample_sources, summary = EXCLUDED.summary, computed_at = NOW()`,
        [projectHash, o.id, o.size, o.samples, o.summary]);
    }
    return { communities: top.length, summarized: out.length, ollamaDown: false };
  }

  /**
   * v0.37.0 — corpus-level Q&A over the pre-computed community summaries (GraphRAG-style
   * global search at local cost) + DRIFT-lite follow-up queries. Generates summaries on
   * demand for a project that has never been summarized. Null ⇒ Ollama down / no corpus.
   */
  async globalSearch(projectPath: string, question: string): Promise<{ answer: string; followups: string[]; communities: CommunitySummaryRow[] } | null> {
    const projectHash = ph(projectPath);
    const fetchSums = async () => (await this.pool.query<CommunitySummaryRow>(
      `SELECT community_id, size, sample_sources, summary FROM kb_community_summaries_pg
        WHERE project_hash = $1 ORDER BY size DESC LIMIT 12`, [projectHash])).rows;
    let sums = await fetchSums();
    if (sums.length === 0) {
      await this.refreshCommunitySummaries(projectHash).catch(() => undefined);
      sums = await fetchSums();
    }
    if (sums.length === 0) return null;
    const res = await answerGlobal(question, sums);
    return res ? { ...res, communities: sums } : null;
  }

  /**
   * v0.37.0 — SPOTTER GRADUATION: the trajectory→skill discovery loop runs automatically.
   * Every ≥6h the cron (a) queues failure-cluster candidates (cooldown-gated internally),
   * (b) runs the zero-LLM success-pattern detectors over the last 7 days of tool calls, and
   * (c) auto-FILES high-confidence signals (confidence ≥ 0.6, ≥3 occurrences, deduped against
   * active skills + open candidates) into skill_candidates_pg — where the EXISTING operator
   * flow takes over (dashboard: generate body → approve → admission scan). Discovery is
   * automatic; authoring stays evidence-gated and human-approved. ZC_SPOTTER_AUTO=0 disables.
   */
  async runSkillDiscovery(): Promise<{ signals: number; filed: number }> {
    if ((process.env["ZC_SPOTTER_AUTO"] ?? "1") === "0") return { signals: 0, filed: 0 };
    // Gate: at most one auto dry-run per 6 hours.
    const last = (await this.pool.query<{ ts: Date | null }>(
      `SELECT MAX(started_at) AS ts FROM skill_spotter_runs_pg WHERE mode = 'dry-run'`)).rows[0];
    if (last?.ts && Date.now() - new Date(last.ts).getTime() < 6 * 3600_000) return { signals: 0, filed: 0 };

    try {
      const { detectAndQueueSkillCandidates } = await import("./skill_candidate_detector.js");
      await detectAndQueueSkillCandidates();
    } catch { /* failure-cluster path is best-effort */ }

    const { runSpotterDryRun } = await import("./skills/spotter/run.js");
    const summary = await runSpotterDryRun({ windowDays: 7 });

    const sigs = (await this.pool.query<{ signal_id: number; occurrences: number; confidence: number; proposed_trigger: string | null; proposed_name_hint: string | null; evidence: unknown }>(
      `SELECT signal_id, occurrences, confidence, proposed_trigger, proposed_name_hint, evidence
         FROM skill_spotter_signals_pg
        WHERE run_id = $1 AND confidence >= 0.6 AND occurrences >= 3 AND proposed_name_hint IS NOT NULL
        ORDER BY confidence DESC LIMIT 5`, [summary.run_id])).rows;
    let filed = 0;
    for (const s of sigs) {
      const hint = String(s.proposed_name_hint ?? "").slice(0, 60);
      if (!hint) continue;
      // Dedup: skip when an active skill or an open candidate already covers this name.
      const dupSkill = (await this.pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM skills_pg WHERE archived_at IS NULL AND name ILIKE $1`, [`%${hint.slice(0, 30)}%`])).rows[0];
      const dupCand = (await this.pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM skill_candidates_pg WHERE status IN ('pending','ready') AND headline ILIKE $1`, [`%${hint.slice(0, 30)}%`])).rows[0];
      if (Number(dupSkill?.n ?? 0) > 0 || Number(dupCand?.n ?? 0) > 0) continue;
      const candidateId = randomUUID();
      await this.pool.query(
        `INSERT INTO skill_candidates_pg (
           candidate_id, project_hash, target_role, rejection_count,
           first_rejection_at, last_rejection_at, rejection_outcomes, headline, status
         ) VALUES ($1, 'spotter-auto', 'developer', 0, now(), now(), $2::jsonb, $3, 'pending')`,
        [candidateId,
         JSON.stringify({ source: "spotter-cron", signal_id: s.signal_id, occurrences: s.occurrences, confidence: s.confidence, evidence: s.evidence }),
         `[spotter-auto] ${hint}: ${(s.proposed_trigger ?? "repeated successful pattern").slice(0, 150)} (${s.occurrences}x, conf ${s.confidence})`]);
      await this.pool.query(
        `UPDATE skill_spotter_signals_pg SET outcome = 'filed_candidate', outcome_reason = 'auto-filed by enrichment cron (v0.37.0)' WHERE signal_id = $1`,
        [s.signal_id]);
      filed++;
    }
    return { signals: summary.signals_emitted, filed };
  }

  async listContradictions(projectPath: string, agentId: string): Promise<Array<{ key_a: string; key_b: string; similarity: number; reason: string; detail: string }>> {
    const projectHash = ph(projectPath);
    const safeAgent = sanitize(agentId, 64);
    try {
      return (await this.pool.query<{ key_a: string; key_b: string; similarity: number; reason: string; detail: string }>(
        `SELECT key_a, key_b, similarity, reason, detail FROM memory_contradictions_pg
         WHERE project_hash = $1 AND (agent_id = $2 OR agent_id = 'default') AND status = 'open'
         ORDER BY surfaced_at DESC LIMIT 20`, [projectHash, safeAgent])).rows;
    } catch { return []; }
  }

  async reviewContradiction(projectPath: string, agentId: string, keyA: string, keyB: string, status: "dismissed" | "acknowledged" | "resolved", mode?: string): Promise<number> {
    const projectHash = ph(projectPath);
    const safeAgent = sanitize(agentId, 64);
    const [ka, kb] = keyA < keyB ? [keyA, keyB] : [keyB, keyA];
    try {
      const r = await this.pool.query(
        `UPDATE memory_contradictions_pg SET status = $1, reviewed_at = NOW(), resolution_mode = $6
         WHERE project_hash = $2 AND agent_id = $3 AND key_a = $4 AND key_b = $5`,
        [status, projectHash, safeAgent, ka, kb, mode ?? null]);
      return r.rowCount ?? 0;
    } catch { return 0; }
  }

  // ── Broadcasts ────────────────────────────────────────────────────────────

  async broadcast(
    projectPath: string,
    type: BroadcastType,
    agentId: string,
    opts: BroadcastOptions
  ): Promise<BroadcastMessage> {
    const projectHash  = ph(projectPath);
    const VALID_TYPES: BroadcastType[] = ["ASSIGN","STATUS","PROPOSED","DEPENDENCY","MERGE","REJECT","REVISE","LAUNCH_ROLE","RETIRE_ROLE"];
    if (!VALID_TYPES.includes(type)) {
      throw new Error(`Invalid broadcast type: ${type}`);
    }

    const safeAgent   = sanitize(agentId, 64);
    const safeTask    = sanitize(opts.task    ?? "", 500);
    const safeSummary = sanitize(opts.summary ?? "", 1000);
    const safeState   = sanitize(opts.state   ?? "", 200);
    const safeReason  = sanitize(opts.reason  ?? "", 500);
    const safeImp     = Math.max(1, Math.min(5, Math.round(opts.importance ?? 3)));
    const files       = JSON.stringify((opts.files      ?? []).slice(0, 20).map(f => String(f).slice(0, 300)));
    const dependsOn   = JSON.stringify((opts.depends_on ?? []).slice(0, 10).map(d => String(d).slice(0, 100)));
    const now         = new Date().toISOString();

    // v0.16.0 §8.1 — structured ASSIGN field sanitization (NULLABLE in PG)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = opts as any;
    const safeAccept    = Array.isArray(o.acceptance_criteria)
      ? JSON.stringify(o.acceptance_criteria.slice(0, 20).map((s: unknown) => String(s).slice(0, 500)))
      : null;
    let safeComplexity: number | null = null;
    if (typeof o.complexity_estimate === "number" && Number.isFinite(o.complexity_estimate)) {
      const c = Math.round(o.complexity_estimate);
      if (c >= 1 && c <= 5) safeComplexity = c;
    }
    const safeFileExcl = Array.isArray(o.file_ownership_exclusive)
      ? JSON.stringify(o.file_ownership_exclusive.slice(0, 50).map((s: unknown) => String(s).slice(0, 500)))
      : null;
    const safeFileRO = Array.isArray(o.file_ownership_read_only)
      ? JSON.stringify(o.file_ownership_read_only.slice(0, 50).map((s: unknown) => String(s).slice(0, 500)))
      : null;
    const safeTaskDeps = Array.isArray(o.task_dependencies)
      ? JSON.stringify(o.task_dependencies.filter((d: unknown) => typeof d === "number" && Number.isInteger(d) && d > 0).slice(0, 50))
      : null;
    const safeReqSkills = Array.isArray(o.required_skills)
      ? JSON.stringify(o.required_skills.slice(0, 20).map((s: unknown) => String(s).slice(0, 100)))
      : null;
    let safeEstTokens: number | null = null;
    if (typeof o.estimated_tokens === "number" && Number.isFinite(o.estimated_tokens) && o.estimated_tokens >= 0) {
      safeEstTokens = Math.floor(Math.min(o.estimated_tokens, 1_000_000_000));
    }

    // RBAC enforcement — if sessions exist, verify token and role permissions
    if (opts.session_token) {
      const tokenPayload = await this.verifyToken(projectPath, opts.session_token);
      if (!tokenPayload) throw new Error("RBAC: invalid or expired session token");
      const allowed = (ROLE_PERMISSIONS[tokenPayload.role] ?? []) as BroadcastType[];
      if (!allowed.includes(type)) {
        throw new Error(`RBAC: role '${tokenPayload.role}' cannot broadcast type '${type}'`);
      }
    }

    // Channel key verification
    if (opts.channel_key !== undefined) {
      const keyRow = await this.pool.query<{ value: string }>(
        "SELECT value FROM project_meta WHERE project_hash = $1 AND key = 'zc_channel_key_hash'",
        [projectHash]
      );
      if (keyRow.rows.length > 0 && keyRow.rows[0]!.value.length > 0) {
        if (!verifyScryptHash(opts.channel_key, keyRow.rows[0]!.value)) {
          throw new Error("Broadcast rejected: incorrect channel key");
        }
      }
    }

    // Rate limiting: max BROADCAST_RATE_LIMIT_PER_MINUTE per agent per minute
    const windowStart = new Date(Date.now() - 60_000).toISOString();
    const rateRes = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*) as n FROM broadcasts WHERE project_hash = $1 AND agent_id = $2 AND created_at > $3",
      [projectHash, safeAgent, windowStart]
    );
    if (parseInt(rateRes.rows[0]!.n, 10) >= Config.BROADCAST_RATE_LIMIT_PER_MINUTE) {
      throw new Error(`Rate limit: max ${Config.BROADCAST_RATE_LIMIT_PER_MINUTE} broadcasts per minute`);
    }

    // Hash chain: use advisory lock to serialize per-project (prevents concurrent prev_hash races)
    // pg_advisory_xact_lock takes a bigint — hash the projectHash to one
    const lockKey = BigInt("0x" + projectHash.slice(0, 15));

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey.toString()]);

      // Get last hash
      const lastRes = await client.query<{ row_hash: string }>(
        "SELECT row_hash FROM broadcasts WHERE project_hash = $1 ORDER BY id DESC LIMIT 1",
        [projectHash]
      );
      const prevHash = lastRes.rows.length > 0 ? lastRes.rows[0]!.row_hash : "genesis";
      const tokenId  = opts.session_token ? opts.session_token.split(".")[1] ?? "" : "";
      const rowHash  = computeRowHash(prevHash, type, safeAgent, safeTask, safeSummary, now, tokenId);

      const insertRes = await client.query<{ id: number }>(`
        INSERT INTO broadcasts(
          project_hash, type, agent_id, task, summary, files, state,
          depends_on, reason, importance, created_at,
          session_token_id, prev_hash, row_hash,
          acceptance_criteria, complexity_estimate,
          file_ownership_exclusive, file_ownership_read_only,
          task_dependencies, required_skills, estimated_tokens
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                  $15,$16,$17,$18,$19,$20,$21)
        RETURNING id
      `, [projectHash, type, safeAgent, safeTask, safeSummary, files, safeState,
          dependsOn, safeReason, safeImp, now, tokenId, prevHash, rowHash,
          safeAccept, safeComplexity, safeFileExcl, safeFileRO,
          safeTaskDeps, safeReqSkills, safeEstTokens]);

      await client.query("COMMIT");

      const id = insertRes.rows[0]!.id;
      return {
        id, type, agent_id: safeAgent, task: safeTask,
        files: JSON.parse(files), state: safeState, summary: safeSummary,
        depends_on: JSON.parse(dependsOn), reason: safeReason,
        importance: safeImp, created_at: now,
        acceptance_criteria:      safeAccept    ? JSON.parse(safeAccept)    : [],
        complexity_estimate:      safeComplexity,
        file_ownership_exclusive: safeFileExcl  ? JSON.parse(safeFileExcl)  : [],
        file_ownership_read_only: safeFileRO    ? JSON.parse(safeFileRO)    : [],
        task_dependencies:        safeTaskDeps  ? JSON.parse(safeTaskDeps)  : [],
        required_skills:          safeReqSkills ? JSON.parse(safeReqSkills) : [],
        estimated_tokens:         safeEstTokens,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async recallBroadcasts(projectPath: string, opts: RecallOptions): Promise<BroadcastResult[]> {
    const projectHash = ph(projectPath);
    const limit       = opts.limit ?? 30;
    const conditions  = ["project_hash = $1"];
    const params: unknown[] = [projectHash];
    let   pIdx = 2;

    if (opts.sinceId) { conditions.push(`id > $${pIdx++}`); params.push(opts.sinceId); }
    if (opts.type)    { conditions.push(`type = $${pIdx++}`); params.push(opts.type); }
    if (opts.agentId) { conditions.push(`agent_id = $${pIdx++}`); params.push(opts.agentId); }
    params.push(limit);

    // v0.20.0 — include v0.15.0 §8.1 structured ASSIGN columns in SELECT.
    // Without these the file-ownership overlap guard at POST /api/v1/broadcast
    // never sees file_ownership_exclusive — every overlap returned 200 instead
    // of 409. Caught by E2E test E1 in the v0.19.0 report.
    const res = await this.pool.query<BroadcastResult & {
      files: string; depends_on: string;
      file_ownership_exclusive: string | null;
      file_ownership_read_only: string | null;
      task_dependencies: string | null;
      required_skills: string | null;
      acceptance_criteria: string | null;
    }>(
      `SELECT id, type, agent_id, task, summary, files, state, depends_on, reason,
              importance, created_at,
              file_ownership_exclusive, file_ownership_read_only,
              task_dependencies, required_skills, acceptance_criteria,
              complexity_estimate, estimated_tokens
       FROM   broadcasts
       WHERE  ${conditions.join(" AND ")}
       ORDER  BY id DESC LIMIT $${pIdx}`,
      params
    );

    return res.rows.map(r => ({
      ...r,
      files:                    JSON.parse(r.files      || "[]"),
      depends_on:               JSON.parse(r.depends_on || "[]"),
      file_ownership_exclusive: r.file_ownership_exclusive ? JSON.parse(r.file_ownership_exclusive) : [],
      file_ownership_read_only: r.file_ownership_read_only ? JSON.parse(r.file_ownership_read_only) : [],
      task_dependencies:        r.task_dependencies        ? JSON.parse(r.task_dependencies)        : [],
      required_skills:          r.required_skills          ? JSON.parse(r.required_skills)          : [],
      acceptance_criteria:      r.acceptance_criteria      ? JSON.parse(r.acceptance_criteria)      : [],
    }));
  }

  async replay(projectPath: string, fromId?: number): Promise<BroadcastResult[]> {
    const projectHash = ph(projectPath);
    const res = await this.pool.query<BroadcastResult & { files: string; depends_on: string }>(
      `SELECT id, type, agent_id, task, summary, files, state, depends_on,
              reason, importance, created_at
       FROM   broadcasts
       WHERE  project_hash = $1 ${fromId ? "AND id >= $2" : ""}
       ORDER  BY id ASC
       ${fromId ? "" : "LIMIT 500"}`,
      fromId ? [projectHash, fromId] : [projectHash]
    );
    return res.rows.map(r => ({
      ...r,
      files:      JSON.parse(r.files      || "[]"),
      depends_on: JSON.parse(r.depends_on || "[]"),
    }));
  }

  async ack(projectPath: string, id: number): Promise<void> {
    const projectHash = ph(projectPath);
    await this.pool.query(
      "UPDATE broadcasts SET acked_at = $1 WHERE project_hash = $2 AND id = $3 AND acked_at IS NULL",
      [new Date().toISOString(), projectHash, id]
    );
  }

  async chainStatus(projectPath: string): Promise<ChainStatus> {
    const projectHash = ph(projectPath);
    const res = await this.pool.query<{
      id: number; type: string; agent_id: string; task: string;
      summary: string; created_at: string; session_token_id: string;
      prev_hash: string; row_hash: string;
    }>(
      `SELECT id, type, agent_id, task, summary, created_at, session_token_id, prev_hash, row_hash
       FROM broadcasts WHERE project_hash = $1 ORDER BY id ASC`,
      [projectHash]
    );

    if (res.rows.length === 0) return { ok: true, totalRows: 0 };

    let prevHash = "genesis";
    for (const row of res.rows) {
      const expected = computeRowHash(
        prevHash, row.type, row.agent_id, row.task,
        row.summary, row.created_at, row.session_token_id
      );
      if (expected !== row.row_hash) {
        return { ok: false, totalRows: res.rows.length, brokenAt: row.id };
      }
      prevHash = row.row_hash;
    }
    return { ok: true, totalRows: res.rows.length };
  }

  async setChannelKey(projectPath: string, key: string): Promise<void> {
    if (key.trim().length < Config.MIN_CHANNEL_KEY_LENGTH) {
      throw new Error(`Channel key must be at least ${Config.MIN_CHANNEL_KEY_LENGTH} characters`);
    }
    const projectHash = ph(projectPath);
    const hashed      = hashChannelKeyScrypt(key);
    await this.pool.query(`
      INSERT INTO project_meta(project_hash, key, value) VALUES ($1, 'zc_channel_key_hash', $2)
      ON CONFLICT(project_hash, key) DO UPDATE SET value = EXCLUDED.value
    `, [projectHash, hashed]);
  }

  async isChannelKeyConfigured(projectPath: string): Promise<boolean> {
    const projectHash = ph(projectPath);
    const res = await this.pool.query<{ value: string }>(
      "SELECT value FROM project_meta WHERE project_hash = $1 AND key = 'zc_channel_key_hash'",
      [projectHash]
    );
    return res.rows.length > 0 && res.rows[0]!.value.length > 0;
  }

  // ── RBAC & Tokens ─────────────────────────────────────────────────────────

  async issueToken(projectPath: string, agentId: string, role: AgentRole): Promise<string> {
    const projectHash = ph(projectPath);
    const signingKey  = await getOrCreateSigningKey(this.pool, projectHash);

    const tokenId = randomBytes(16).toString("hex");
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + Config.SESSION_TOKEN_TTL_SECONDS;

    const payload = {
      tid:  tokenId,
      aid:  agentId,
      role,
      ph:   projectHash,
      iat:  issuedAt,
      exp:  expiresAt,
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const hmac       = hmacSign(payloadB64, signingKey);
    const token      = `zcst.${payloadB64}.${hmac}`;

    const issuedAtISO  = new Date(issuedAt  * 1000).toISOString();
    const expiresAtISO = new Date(expiresAt * 1000).toISOString();

    await this.pool.query(`
      INSERT INTO agent_sessions(project_hash, token_id, agent_id, role, token_hmac, issued_at, expires_at, revoked)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
    `, [projectHash, tokenId, agentId, role, hmac, issuedAtISO, expiresAtISO]);

    return token;
  }

  async revokeTokens(projectPath: string, agentId: string): Promise<void> {
    const projectHash = ph(projectPath);
    await this.pool.query(
      "UPDATE agent_sessions SET revoked = 1 WHERE project_hash = $1 AND agent_id = $2",
      [projectHash, agentId]
    );
  }

  async verifyToken(projectPath: string, token: string): Promise<TokenPayload | null> {
    try {
      if (!token.startsWith("zcst.")) return null;
      const parts = token.split(".");
      if (parts.length !== 3) return null;

      const payloadB64 = parts[1]!;
      const suppliedHmac = parts[2]!;
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));

      // Validate structure
      if (!payload.tid || !payload.aid || !payload.role || !payload.ph || !payload.iat || !payload.exp) return null;

      // Project scope check
      const projectHash = ph(projectPath);
      if (payload.ph !== projectHash) return null;

      // Expiry check
      if (Math.floor(Date.now() / 1000) > payload.exp) return null;

      // HMAC verification
      const signingKey = await getOrCreateSigningKey(this.pool, projectHash);
      const expectedHmac = hmacSign(payloadB64, signingKey);
      if (!timingSafeEqual(Buffer.from(suppliedHmac, "hex"), Buffer.from(expectedHmac, "hex"))) return null;

      // DB check (not revoked)
      const res = await this.pool.query<{ revoked: number }>(
        "SELECT revoked FROM agent_sessions WHERE project_hash = $1 AND token_id = $2",
        [projectHash, payload.tid]
      );
      if (res.rows.length === 0 || res.rows[0]!.revoked !== 0) return null;

      return { tokenId: payload.tid, agentId: payload.aid, role: payload.role, iat: payload.iat, exp: payload.exp };
    } catch {
      return null;
    }
  }

  async countActiveSessions(projectPath: string): Promise<number> {
    const projectHash = ph(projectPath);
    const res = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*) as n FROM agent_sessions WHERE project_hash = $1 AND revoked = 0 AND expires_at > $2",
      [projectHash, new Date().toISOString()]
    );
    return parseInt(res.rows[0]!.n, 10);
  }

  // ── Rate Limiting ──────────────────────────────────────────────────────────

  async getFetchStats(projectPath: string): Promise<FetchStats> {
    const projectHash = ph(projectPath);
    const today       = todayUtc();
    const res = await this.pool.query<{ fetch_count: number }>(
      "SELECT fetch_count FROM rate_limits WHERE project_hash = $1 AND date = $2",
      [projectHash, today]
    );
    const used = res.rows[0]?.fetch_count ?? 0;
    return { used, remaining: Math.max(0, Config.FETCH_LIMIT - used) };
  }

  async incrementFetch(projectPath: string): Promise<FetchStats> {
    const projectHash = ph(projectPath);
    const today       = todayUtc();
    await this.pool.query(`
      INSERT INTO rate_limits(project_hash, date, fetch_count) VALUES ($1, $2, 1)
      ON CONFLICT(project_hash, date) DO UPDATE SET fetch_count = rate_limits.fetch_count + 1
    `, [projectHash, today]);
    const res = await this.pool.query<{ fetch_count: number }>(
      "SELECT fetch_count FROM rate_limits WHERE project_hash = $1 AND date = $2",
      [projectHash, today]
    );
    const used = res.rows[0]!.fetch_count;
    return { used, remaining: Math.max(0, Config.FETCH_LIMIT - used) };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL Schema DDL
// Applied by init() — all statements are idempotent (IF NOT EXISTS / DO NOTHING)
// ─────────────────────────────────────────────────────────────────────────────

const PG_SCHEMA_DDL = `
-- Multi-tenant working memory
CREATE TABLE IF NOT EXISTS working_memory (
  id           SERIAL PRIMARY KEY,
  project_hash TEXT    NOT NULL,
  key          TEXT    NOT NULL,
  value        TEXT    NOT NULL,
  importance   INTEGER NOT NULL DEFAULT 3,
  agent_id     TEXT    NOT NULL DEFAULT 'default',
  created_at   TIMESTAMPTZ NOT NULL,
  -- v0.31.0 epistemology layer (+ provenance parity with SQLite migration 16)
  provenance        TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (provenance IN ('EXTRACTED','INFERRED','AMBIGUOUS','UNKNOWN')),
  kind              TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact','decision','hypothesis','prediction')),
  confidence        REAL,
  resolution_status TEXT CHECK (resolution_status IN ('open','resolved_correct','resolved_incorrect','resolved_partial')),
  resolved_at       TIMESTAMPTZ,
  UNIQUE(project_hash, key, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_wm_project_agent ON working_memory(project_hash, agent_id);
CREATE INDEX IF NOT EXISTS idx_wm_evict ON working_memory(project_hash, agent_id, importance ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_wm_kind ON working_memory(project_hash, agent_id, kind, resolution_status);

-- Knowledge base (full-text search via tsvector/GIN)
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id           SERIAL PRIMARY KEY,
  project_hash TEXT NOT NULL,
  source       TEXT NOT NULL,
  content      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  UNIQUE(project_hash, source)
);
CREATE INDEX IF NOT EXISTS idx_ke_project     ON knowledge_entries(project_hash);
CREATE INDEX IF NOT EXISTS idx_ke_fts         ON knowledge_entries USING GIN (to_tsvector('english', content));

-- Source metadata with L0/L1 tiers
CREATE TABLE IF NOT EXISTS source_meta (
  project_hash   TEXT NOT NULL,
  source         TEXT NOT NULL,
  source_type    TEXT NOT NULL DEFAULT 'internal',
  retention_tier TEXT NOT NULL DEFAULT 'internal',
  created_at     TIMESTAMPTZ NOT NULL,
  l0_summary     TEXT NOT NULL DEFAULT '',
  l1_summary     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_hash, source)
);
CREATE INDEX IF NOT EXISTS idx_sm_retention ON source_meta(project_hash, retention_tier, created_at);

-- Embeddings (pgvector — shared cosine similarity via IVFFlat index)
CREATE TABLE IF NOT EXISTS embeddings (
  project_hash TEXT NOT NULL,
  source       TEXT NOT NULL,
  vector       vector(768),
  model_name   TEXT NOT NULL DEFAULT 'nomic-embed-text',
  dimensions   INTEGER NOT NULL DEFAULT 768,
  created_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_hash, source)
);
-- IVFFlat index: approximate cosine search in O(√n). lists=100 covers up to ~1M vectors.
-- NOTE: The index is created after first insert — CREATE INDEX on empty table is fine,
-- but VACUUM ANALYZE is recommended after bulk-loading >10k vectors to rebuild list centroids.
CREATE INDEX IF NOT EXISTS idx_emb_cosine ON embeddings USING ivfflat (vector vector_cosine_ops)
  WITH (lists = 100);

-- Broadcasts (A2A coordination + hash chain)
CREATE TABLE IF NOT EXISTS broadcasts (
  id               SERIAL PRIMARY KEY,
  project_hash     TEXT    NOT NULL,
  type             TEXT    NOT NULL CHECK(type IN ('ASSIGN','STATUS','PROPOSED','DEPENDENCY','MERGE','REJECT','REVISE','LAUNCH_ROLE','RETIRE_ROLE')),
  agent_id         TEXT    NOT NULL DEFAULT 'default',
  task             TEXT    NOT NULL DEFAULT '',
  files            TEXT    NOT NULL DEFAULT '[]',
  state            TEXT    NOT NULL DEFAULT '',
  summary          TEXT    NOT NULL DEFAULT '',
  depends_on       TEXT    NOT NULL DEFAULT '[]',
  reason           TEXT    NOT NULL DEFAULT '',
  importance       INTEGER NOT NULL DEFAULT 3,
  -- TEXT not TIMESTAMPTZ: hash chain requires the exact ISO-8601 string that was hashed at write time.
  -- TIMESTAMPTZ would be returned as a JS Date object by pg driver, causing computeRowHash to fail.
  -- ISO-8601 strings sort lexicographically correctly so range queries (rate limiting) still work.
  created_at       TEXT    NOT NULL DEFAULT '',
  session_token_id TEXT    NOT NULL DEFAULT '',
  prev_hash        TEXT    NOT NULL DEFAULT 'genesis',
  row_hash         TEXT    NOT NULL DEFAULT '',
  acked_at         TEXT,
  -- v0.15.0 §8.1 — structured ASSIGN columns (all NULLABLE, additive)
  acceptance_criteria      TEXT,
  complexity_estimate      INTEGER,
  file_ownership_exclusive TEXT,
  file_ownership_read_only TEXT,
  task_dependencies        TEXT,
  required_skills          TEXT,
  estimated_tokens         INTEGER
);
-- v0.16.0: ALTER existing tables to add structured ASSIGN columns
-- (idempotent — IF NOT EXISTS doesn't exist for ADD COLUMN in older PG, so we
--  use a DO/EXCEPTION block per column)
DO $$
BEGIN
  ALTER TABLE broadcasts ADD COLUMN acceptance_criteria      TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$
BEGIN
  ALTER TABLE broadcasts ADD COLUMN complexity_estimate      INTEGER;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$
BEGIN
  ALTER TABLE broadcasts ADD COLUMN file_ownership_exclusive TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$
BEGIN
  ALTER TABLE broadcasts ADD COLUMN file_ownership_read_only TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$
BEGIN
  ALTER TABLE broadcasts ADD COLUMN task_dependencies        TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$
BEGIN
  ALTER TABLE broadcasts ADD COLUMN required_skills          TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$
BEGIN
  ALTER TABLE broadcasts ADD COLUMN estimated_tokens         INTEGER;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_bc_project    ON broadcasts(project_hash, id);
CREATE INDEX IF NOT EXISTS idx_bc_type       ON broadcasts(project_hash, type);
CREATE INDEX IF NOT EXISTS idx_bc_agent      ON broadcasts(project_hash, agent_id);
CREATE INDEX IF NOT EXISTS idx_bc_created    ON broadcasts(project_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bc_complexity ON broadcasts(complexity_estimate, type);

-- Agent sessions (RBAC)
CREATE TABLE IF NOT EXISTS agent_sessions (
  project_hash TEXT    NOT NULL,
  token_id     TEXT    NOT NULL,
  agent_id     TEXT    NOT NULL,
  role         TEXT    NOT NULL CHECK(role IN ('orchestrator','developer','marketer','researcher','worker')),
  token_hmac   TEXT    NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_hash, token_id)
);
CREATE INDEX IF NOT EXISTS idx_as_agent ON agent_sessions(project_hash, agent_id, revoked);

-- Project metadata (signing keys, channel key hashes, complexity profiles, labels)
CREATE TABLE IF NOT EXISTS project_meta (
  project_hash TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  PRIMARY KEY (project_hash, key)
);

-- Rate limits (per project per day)
CREATE TABLE IF NOT EXISTS rate_limits (
  project_hash TEXT NOT NULL,
  date         TEXT NOT NULL,
  fetch_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_hash, date)
);

-- Migration: expand broadcasts type CHECK to include LAUNCH_ROLE and RETIRE_ROLE
-- This ALTER is idempotent — if the constraint already allows the new types, the
-- DROP will succeed on the old constraint name and ADD will recreate with the new list.
-- If the constraint name doesn't match (fresh DB), this is a no-op since CREATE TABLE above
-- already includes the expanded CHECK.
DO $$
BEGIN
  -- Try to drop the old constraint (Postgres auto-names it broadcasts_type_check)
  ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_type_check;
  -- Recreate with expanded type list
  ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_type_check
    CHECK(type IN ('ASSIGN','STATUS','PROPOSED','DEPENDENCY','MERGE','REJECT','REVISE','LAUNCH_ROLE','RETIRE_ROLE'));
EXCEPTION WHEN OTHERS THEN
  -- Constraint may have a different name or already be correct — ignore
  NULL;
END $$;
`;
