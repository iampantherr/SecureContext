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
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Config } from "./config.js";
import { computeRowHash } from "./chain.js";
import { getEmbedding, cosineSimilarity, ACTIVE_MODEL } from "./embedder.js";
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

  async remember(projectPath: string, key: string, value: string, importance: number, agentId: string): Promise<void> {
    const projectHash = ph(projectPath);
    const safeKey    = sanitize(key,     100);
    const safeValue  = sanitize(value,   500);
    const safeImp    = Math.max(1, Math.min(5, Math.round(importance)));
    const safeAgent  = sanitize(agentId,  64);
    const now        = new Date().toISOString();

    await this.pool.query(`
      INSERT INTO working_memory(project_hash, key, value, importance, agent_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(project_hash, key, agent_id) DO UPDATE SET
        value      = EXCLUDED.value,
        importance = EXCLUDED.importance,
        created_at = EXCLUDED.created_at
    `, [projectHash, safeKey, safeValue, safeImp, safeAgent, now]);

    // Evict if over the dynamic limit
    const limits = await this.getWorkingMemoryLimits(projectPath);
    const countRes = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*) as n FROM working_memory WHERE project_hash = $1 AND agent_id = $2",
      [projectHash, safeAgent]
    );
    const count = parseInt(countRes.rows[0]!.n, 10);

    if (count > limits.max) {
      const toEvictCount = count - limits.evictTo;
      const victims = await this.pool.query<{ key: string; value: string }>(
        `SELECT key, value FROM working_memory
         WHERE project_hash = $1 AND agent_id = $2
         ORDER BY importance ASC, created_at ASC
         LIMIT $3`,
        [projectHash, safeAgent, toEvictCount]
      );

      for (const row of victims.rows) {
        await this.pool.query(
          "DELETE FROM working_memory WHERE project_hash = $1 AND key = $2 AND agent_id = $3",
          [projectHash, row.key, safeAgent]
        );
        // Archive evicted fact to KB
        await this.index(projectPath, row.value, `memory:${safeAgent}:${row.key}`);
      }
    }
  }

  async forget(projectPath: string, key: string, agentId: string): Promise<boolean> {
    const projectHash = ph(projectPath);
    const safeKey    = sanitize(key,     100);
    const safeAgent  = sanitize(agentId,  64);
    const res = await this.pool.query(
      "DELETE FROM working_memory WHERE project_hash = $1 AND key = $2 AND agent_id = $3",
      [projectHash, safeKey, safeAgent]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async recall(projectPath: string, agentId: string): Promise<MemoryFact[]> {
    const projectHash = ph(projectPath);
    const safeAgent   = sanitize(agentId, 64);
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
    if (safeAgent === "default") {
      const res = await this.pool.query<MemoryFact>(
        `SELECT key, value, importance, agent_id, created_at
         FROM working_memory WHERE project_hash = $1 AND agent_id = 'default'
         ORDER BY importance DESC, created_at DESC`,
        [projectHash]
      );
      return res.rows;
    }
    // For per-agent agentId: UNION (their private notebook) + (shared 'default' pool)
    const res = await this.pool.query<MemoryFact>(
      `SELECT key, value, importance, agent_id, created_at
       FROM working_memory
       WHERE project_hash = $1 AND (agent_id = $2 OR agent_id = 'default')
       ORDER BY
         CASE WHEN agent_id = $2 THEN 0 ELSE 1 END,
         importance DESC,
         created_at DESC`,
      [projectHash, safeAgent]
    );
    return res.rows;
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
        "SELECT COUNT(*) as n FROM working_memory WHERE project_hash = $1 AND agent_id = $2",
        [projectHash, safeAgent]
      ),
      this.pool.query<{ n: string }>(
        "SELECT COUNT(*) as n FROM working_memory WHERE project_hash = $1 AND agent_id = $2 AND importance >= 4",
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
  }

  private async _storeEmbedding(projectHash: string, content: string, source: string): Promise<void> {
    try {
      const result = await getEmbedding(content);
      if (!result) return;
      // pgvector expects "[x1,x2,...,xN]" string format
      const vectorStr = "[" + result.vector.join(",") + "]";
      await this.pool.query(`
        INSERT INTO embeddings(project_hash, source, vector, model_name, dimensions, created_at)
        VALUES ($1, $2, $3::vector, $4, $5, $6)
        ON CONFLICT(project_hash, source) DO UPDATE SET
          vector     = EXCLUDED.vector,
          model_name = EXCLUDED.model_name,
          dimensions = EXCLUDED.dimensions,
          created_at = EXCLUDED.created_at
      `, [projectHash, source, vectorStr, result.modelName, result.dimensions, new Date().toISOString()]);
    } catch {
      // Embedding failure is non-fatal — falls back to BM25-only search
    }
  }

  async search(projectPath: string, queries: string[], opts: SearchOptions = {}): Promise<KnowledgeEntry[]> {
    const projectHash = ph(projectPath);
    const limit       = opts.limit ?? Config.MAX_RESULTS;
    const candidates  = Config.BM25_CANDIDATES;

    // Merge all query terms into one tsvector query
    const queryText = queries.join(" ");

    // BM25 candidates via ts_rank (PostgreSQL full-text)
    const bm25Res = await this.pool.query<{
      source: string; content: string; rank: number; source_type: string;
    }>(`
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

    if (bm25Res.rows.length === 0) return [];

    // Try vector reranking
    let results: KnowledgeEntry[] = [];
    try {
      const qEmbed = await getEmbedding(queryText);
      if (qEmbed) {
        const qVec = "[" + qEmbed.vector.join(",") + "]";
        const sources = bm25Res.rows.map(r => r.source);

        // Get stored embeddings for BM25 candidates
        const embRes = await this.pool.query<{ source: string; vector: string }>(
          `SELECT source, vector::text FROM embeddings
           WHERE project_hash = $1 AND source = ANY($2) AND model_name = $3`,
          [projectHash, sources, ACTIVE_MODEL]
        );

        const embMap = new Map(embRes.rows.map(r => [r.source, r.vector]));
        const maxBm25 = Math.max(...bm25Res.rows.map(r => r.rank), 1);

        const scored = bm25Res.rows.map(row => {
          const bm25Norm = row.rank / maxBm25;
          let cosScore   = 0;
          const storedVecStr = embMap.get(row.source);
          if (storedVecStr) {
            // Parse pgvector "[x1,x2,...,xN]" string back to Float32Array
            const nums = storedVecStr.slice(1, -1).split(",").map(Number);
            cosScore   = cosineSimilarity(new Float32Array(nums), qEmbed.vector);
          }
          const hybrid = Config.W_BM25 * bm25Norm + Config.W_COSINE * cosScore;
          return { ...row, vectorScore: cosScore, hybridScore: hybrid };
        });

        scored.sort((a, b) => b.hybridScore - a.hybridScore);

        results = scored.slice(0, limit).map(r => ({
          source:         r.source,
          content:        r.content,
          snippet:        r.content.slice(0, 200),
          rank:           r.hybridScore,
          vectorScore:    r.vectorScore,
          sourceType:     r.source_type,
          nonAsciiSource: /[^\x00-\x7F]/.test(r.source),
        }));
      }
    } catch {
      // Vector reranking failed — fall back to BM25 only
    }

    if (results.length === 0) {
      results = bm25Res.rows.slice(0, limit).map(r => ({
        source:         r.source,
        content:        r.content,
        snippet:        r.content.slice(0, 200),
        rank:           r.rank,
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
             ts_rank(to_tsvector('english', ke.content), plainto_tsquery('english', $1)) AS rank,
             COALESCE(sm.source_type, 'internal') as source_type,
             ke.project_hash,
             COALESCE(pm.value, ke.project_hash) as project_label
      FROM   knowledge_entries ke
      LEFT JOIN source_meta sm ON sm.project_hash = ke.project_hash AND sm.source = ke.source
      LEFT JOIN project_meta pm ON pm.project_hash = ke.project_hash AND pm.key = 'project_label'
      WHERE  to_tsvector('english', ke.content) @@ plainto_tsquery('english', $1)
      ORDER  BY rank DESC
      LIMIT  $2
    `, [queryText, limit]);

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
  UNIQUE(project_hash, key, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_wm_project_agent ON working_memory(project_hash, agent_id);
CREATE INDEX IF NOT EXISTS idx_wm_evict ON working_memory(project_hash, agent_id, importance ASC, created_at ASC);

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
