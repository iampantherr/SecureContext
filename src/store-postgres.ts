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
import { hashChannelKeyScrypt, verifyScryptHash, SCRYPT_PREFIX } from "./security/scrypt.js";
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { Config } from "./config.js";
import { computeRowHash } from "./chain.js";
import { scheduleEventExtraction, supersedeEventEntries } from "./event_extractor.js";
import { getEmbedding, getEmbeddingQueued, cosineSimilarity, ACTIVE_MODEL } from "./embedder.js";
import { classifyFactKind, clampBroadcastSummary, clampWithMarker, MEMORY_KINDS, type EpistemicOpts } from "./memory.js";
import { isPinnedKind } from "./memory_quality.js";
import { verifyWrite, type VerifyResult } from "./effect_verify.js";
import { computeSalience, salienceEnabled } from "./salience.js";
import { budgetFacts, effectiveImportance } from "./recall_budget.js";
import { extractCoReferences, extractCoReferencesAsync, classifyRelation, graphMaxNodes } from "./indexing/community.js";
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
  CallImpactResult,
  CallImpactTarget,
} from "./store.js";
import { projectHash as scopedProjectHash, todayUtc } from "./store.js";

const { Pool } = pg;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function ph(projectPath: string): string {
  return scopedProjectHash(projectPath);
}

/** Lever-4 diversity guard: `event:` pseudo-entries are one-liners, so BM25's
 *  length normalization over-ranks them and they crowd real content out of
 *  top-K (measured on the T5c bench: multi-session dropped 13 pts). Cap them
 *  per result set; freed slots fill with the next-best non-event candidates.
 *  ZC_EVENT_RESULT_CAP overrides (default 3). */
export function capEventEntries<T>(ranked: T[], limit: number, src: (x: T) => string): T[] {
  const cap = Math.max(0, parseInt(process.env["ZC_EVENT_RESULT_CAP"] || "3", 10));
  const out: T[] = [];
  let ev = 0;
  for (const r of ranked) {
    if (out.length >= limit) break;
    if (src(r).startsWith("event:")) {
      if (ev >= cap) continue;
      ev++;
    }
    out.push(r);
  }
  return out;
}


function sanitize(s: string, max: number): string {
  return String(s).replace(/[\r\n\x00\x01-\x08\x0b\x0c\x0e-\x1f]/g, " ").trim().slice(0, max);
}

// Scrypt helpers (identical parameters to SqliteStore / memory.ts)


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

  async remember(projectPath: string, key: string, value: string, importance: number, agentId: string, epi: EpistemicOpts = {}): Promise<VerifyResult | void> {
    const projectHash = ph(projectPath);
    const safeKey    = sanitize(key,     100);
    // v0.52.0 — a clamp that the caller cannot detect is a silent failure, which
    // effect verification now flags on every write. Announce it instead: the
    // detector immediately caught this one on its first live run (900 chars in,
    // 500 stored, {ok:true} out, 400 chars gone with no trace).
    const clamped500 = clampWithMarker(sanitize(value, 100_000), Math.max(500, epi.valueMax ?? 0), "fact value");
    const safeImp    = Math.max(1, Math.min(5, Math.round(importance)));
    const safeAgent  = sanitize(agentId,  64);
    const now        = new Date().toISOString();

    // v0.31.0 epistemology — explicit kind wins, else auto-classify (parity with rememberFact).
    const KINDS: readonly string[] = MEMORY_KINDS;   // single source of truth — see memory.ts
    const RES   = ["open", "resolved_correct", "resolved_incorrect", "resolved_partial"];
    const safeKind = epi.kind && KINDS.includes(epi.kind) ? epi.kind : classifyFactKind(clamped500);

    // v0.51.2 — pinned kinds get a longer value budget than the flat 500 chars.
    // Reported by an agent reading its own recall: every pinned rule was cut
    // mid-word at exactly the actionable clause ("HOW TO A…", "assigns QA the
    // lit…"). A constraint truncated before it says what to DO is decoration.
    // Non-pinned facts keep the 500-char clamp byte-for-byte, and the kind is
    // still classified from the 500-char text so classification is unchanged.
    // The pinned path must clamp WITH THE MARKER, exactly as the 500 path does.
    // Found by a live agent test 2026-08-12: a 2504-char constraint lost 505
    // characters with no TRUNCATED marker, so effect-verification reported the
    // write as FAILED — correctly, because silent loss is indistinguishable from
    // a broken write. v0.51.2 raised the pinned budget and dropped this path off
    // clampWithMarker at the same time; the longer budget was the point, losing
    // the marker was not.
    const safeValue = isPinnedKind({ key: safeKey, importance: safeImp, kind: safeKind })
      ? clampWithMarker(sanitize(value, 100_000), Math.max(500, Config.PINNED_VALUE_MAX), "fact value")
      : clamped500;
    const safeConf = (typeof epi.confidence === "number" && isFinite(epi.confidence)) ? Math.max(0, Math.min(1, epi.confidence)) : null;
    const safeRes  = epi.resolution && RES.includes(epi.resolution) ? epi.resolution : null;
    const resolvedAt = (safeRes && safeRes !== "open") ? now : null;

    // R1 — optional TTL: validate ISO, must be in the future; invalid values dropped.
    // v0.51.3 — per-task markers get a DEFAULT TTL when the writer omits one.
    //
    // Measured on the live A2A project: 97 live OWNERSHIP_*/ACCEPTANCE_* markers
    // consumed 52,982 chars — more than 3x the entire recall budget — and 29 of
    // them carried no expiry at all. The convention "per-task notes must set
    // ttl_days" was documented but unenforced, so it decayed to a suggestion.
    // The orchestrator, asked what was actually crowding out its recall, named
    // these markers rather than the pinned rules I suspected.
    //
    // Only convention-named, non-pinned, importance<=4 facts are affected, so a
    // durable decision or constraint can never be silently expired.
    // ZC_TASK_MARKER_TTL_DAYS=0 disables (previous behaviour, byte-identical).
    const looksPerTask = /^(OWNERSHIP|ACCEPTANCE|ACCEPT|TASK|CKPT|CLAIM)[_-]/i.test(safeKey);
    const autoTtlDays  = Config.TASK_MARKER_TTL_DAYS;
    const wantsAutoTtl =
      !epi.expiresAt && autoTtlDays > 0 && looksPerTask && safeImp <= 4 &&
      !isPinnedKind({ key: safeKey, importance: safeImp, kind: safeKind });
    const safeExpires: string | null = (() => {
      if (wantsAutoTtl) return new Date(Date.now() + autoTtlDays * 864e5).toISOString();
      if (!epi.expiresAt) return null;
      const t = Date.parse(String(epi.expiresAt));
      return Number.isFinite(t) && t > Date.now() ? new Date(t).toISOString() : null;
    })();

    const _ins = await this.pool.query(`
      INSERT INTO working_memory(project_hash, key, value, importance, agent_id, created_at, kind, confidence, resolution_status, resolved_at, origin, expires_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT(project_hash, key, agent_id) DO UPDATE SET
        value             = EXCLUDED.value,
        importance        = EXCLUDED.importance,
        created_at        = EXCLUDED.created_at,
        kind              = EXCLUDED.kind,
        confidence        = EXCLUDED.confidence,
        resolution_status = EXCLUDED.resolution_status,
        resolved_at       = EXCLUDED.resolved_at,
        origin            = EXCLUDED.origin,
        expires_at        = EXCLUDED.expires_at,
        created_by        = COALESCE(EXCLUDED.created_by, working_memory.created_by),
        valid_to          = NULL,
        superseded_by     = NULL,
        retired_reason    = NULL
      RETURNING key, value, importance, kind, agent_id
    `, [projectHash, safeKey, safeValue, safeImp, safeAgent, now, safeKind, safeConf, safeRes, resolvedAt, epi.origin ? sanitize(epi.origin, 120) : "zc_remember", safeExpires, epi.createdBy ? sanitize(epi.createdBy, 64) : null]);
    // (valid_to reset: re-asserting a RETIRED key REVIVES it — the agent explicitly said it again.)

    // v0.52.0 — EFFECT VERIFICATION. Compare what the database actually stored
    // against what the caller asked for. This is the detector that would have
    // caught the kind:'constraint' -> 'fact' coercion on the day it shipped,
    // instead of three live E2E rounds later. `kind` is 'exact' precisely
    // because silently changing it is the bug; `value` is 'lossy-marked' so a
    // clamp must announce itself.
    let verification: VerifyResult | undefined;
    if (Config.EFFECT_VERIFY) {
      const stored = _ins.rows?.[0] ?? {};
      verification = verifyWrite(
        { key: safeKey, value, importance: safeImp, kind: safeKind, agent_id: safeAgent },
        stored as Record<string, unknown>,
        { key: "exact", kind: "exact", importance: "exact", agent_id: "exact", value: "lossy-marked" },
        { operation: "zc_remember" }
      );
      if (!verification.ok && Config.EFFECT_VERIFY_STRICT) {
        throw new Error(`effect verification failed — ${verification.notice}`);
      }
    }

    // v0.36.0 — memory facts are now co-reference sources, so a memory WRITE must refresh
    // the backlink graph too (previously only indexing did — memory edges would go stale).
    // Debounced 5s + fire-and-forget: a burst of remembers still costs one rebuild.
    this._scheduleBacklinkRebuild(projectPath);

    // S1 (v0.44.0) — WRITE-TIME embedding (PG parity with memory.ts). Found during the
    // S1 bench: the PG path relied entirely on the 30-min enrichment cron backfill
    // (40 facts/cycle), so focused recall ran with rel=0 on every fact for up to an
    // hour after a write burst. Fire-and-forget; the cron backfill remains the healer
    // for anything dropped here (Ollama down, transient failure).
    this._embedFactAsync(projectHash, safeAgent, safeKey, safeValue);

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

    // Surfaced to the caller so the AGENT sees it — a discrepancy that only
    // reaches a log is still a silent failure from the agent's point of view.
    return verification;
  }

  /**
   * v0.52.1 — per-agent liveness signal for the dispatcher's turn-death detector.
   *
   * A live agent that receives input ALWAYS does something observable: it calls a
   * zc_* tool or it broadcasts. An agent whose turn died on a transient API error
   * (529 Overloaded, rate limit, network blip) does neither, while its process
   * stays alive and idle — indistinguishable from "thinking" unless you can see
   * that it has produced nothing since the moment it was last spoken to.
   *
   * Measured cost of not having this: a 529 parked three agents for 2.5 hours.
   * Nothing detected it; the dispatcher's idle heuristic mislabelled it as a
   * stuck worker and escalated a false alarm to the wrong agent.
   */
  async agentActivity(projectPath: string): Promise<Array<{
    agent_id: string; last_tool_call: string | null; last_broadcast: string | null; last_any: string | null;
  }>> {
    const projectHash = ph(projectPath);
    const res = await this.pool.query<{
      agent_id: string; last_tool_call: string | null; last_broadcast: string | null;
    }>(`
      WITH t AS (
        SELECT agent_id, MAX(ts) AS last_tool_call
          FROM tool_calls_pg WHERE project_hash = $1 GROUP BY agent_id
      ), b AS (
        SELECT agent_id, MAX(created_at::timestamptz) AS last_broadcast
          FROM broadcasts WHERE project_hash = $1 GROUP BY agent_id
      )
      SELECT COALESCE(t.agent_id, b.agent_id) AS agent_id,
             t.last_tool_call::text,
             b.last_broadcast::text
        FROM t FULL OUTER JOIN b ON t.agent_id = b.agent_id
       WHERE COALESCE(t.agent_id, b.agent_id) IS NOT NULL
    `, [projectHash]);
    return res.rows.map((r) => {
      const times = [r.last_tool_call, r.last_broadcast]
        .filter(Boolean).map((x) => Date.parse(String(x))).filter(Number.isFinite);
      return {
        agent_id: r.agent_id,
        last_tool_call: r.last_tool_call,
        last_broadcast: r.last_broadcast,
        last_any: times.length ? new Date(Math.max(...times)).toISOString() : null,
      };
    });
  }

  // ── v0.37.0 Temporal fact retirement ───────────────────────────────────────
  async retireFact(projectPath: string, key: string, agentId: string, supersededBy: string | null, reason: string): Promise<boolean> {
    return this._retireFactByHash(ph(projectPath), key, agentId, supersededBy, reason);
  }

  private async _retireFactByHash(projectHash: string, key: string, agentId: string, supersededBy: string | null, reason: string): Promise<boolean> {
    const safeKey   = sanitize(key,     100);
    const safeAgent = sanitize(agentId,  64);
    const row = (await this.pool.query<{ value: string; kind: string | null; importance: number }>(
      "SELECT value, kind, importance FROM working_memory WHERE project_hash = $1 AND key = $2 AND agent_id = $3 AND valid_to IS NULL",
      [projectHash, safeKey, safeAgent])).rows[0];
    if (!row) return false;

    // v0.51.2 — AUTOMATIC retirement can never remove a pinned kind.
    //
    // Caught by dogfooding on the live A2A project: four standing operator rules
    // typed as 'constraint' were auto-retired with reason 'superseded'. Two of
    // them lost to `last_session_summary`, and one rule was killed by a DIFFERENT
    // rule. The contradiction adjudicator picks the survivor by recency, so a June
    // constraint always loses to a July note that merely embeds near it.
    //
    // That is the same incident this feature exists to prevent, arriving through
    // another door: the pinned tier stops the BUDGET from hiding a constraint, but
    // supersession deleted it from recall outright — and silently, since retirement
    // leaves the fact findable by zc_search, so it looks present while being absent
    // from every recall. An operator rule may only be retired by an operator.
    //
    // Explicit retirement (zc_forget, operator dashboard) passes its own reason and
    // is unaffected. ZC_PIN_CONSTRAINTS=0 restores the previous behaviour.
    const AUTOMATIC_REASONS = new Set(["superseded", "consolidated", "expired"]);
    if (AUTOMATIC_REASONS.has(reason) && isPinnedKind({ key: safeKey, importance: 0, kind: row.kind })) {
      const { logger } = await import("./logger.js");
      logger.info("memory", "pinned_retire_refused", {
        project_hash: projectHash, agent_id: safeAgent, key: safeKey,
        kind: row.kind, reason, superseded_by: supersededBy,
      });
      return false;
    }
    // v0.53.1 — AUTOMATIC retirement can never remove a five-star fact, of ANY kind.
    //
    // The pinned-kind guard above closed one door; the 2026-08 audits showed the
    // house had more. Fifty of fifty audited auto-retirements were wrong, and the
    // victims that hurt were plain ★5 FACTS: shipped-commit records, a live
    // trading-system switch, the P0 credential finding (eaten four separate times),
    // and — at the very moment of a shutdown checkpoint — the release-completion
    // record, invalidated by the LLM adjudicator in favour of a summary that merely
    // mentioned it. ★5 is defined as "loss breaks future sessions"; no autonomous
    // process gets to make that call. Operator-explicit paths (zc_forget, the
    // dashboard, TTL the writer set themselves via expireFacts) are unaffected —
    // note "expired" stays automatic-refusable ONLY for importance 5, because a
    // writer who marks a fact both ★5 and TTL'd has stated two intents and the
    // safer one wins. ZC_STAR5_RETIRE=1 restores the old behaviour.
    if (AUTOMATIC_REASONS.has(reason) && (row.importance ?? 0) >= 5 && process.env["ZC_STAR5_RETIRE"] !== "1") {
      const { logger } = await import("./logger.js");
      logger.info("memory", "star5_retire_refused", {
        project_hash: projectHash, agent_id: safeAgent, key: safeKey,
        importance: row.importance, reason, superseded_by: supersededBy,
      });
      return false;
    }
    await this.pool.query(
      "UPDATE working_memory SET valid_to = NOW(), superseded_by = $4, retired_reason = $5 WHERE project_hash = $1 AND key = $2 AND agent_id = $3",
      [projectHash, safeKey, safeAgent, supersededBy ? sanitize(supersededBy, 100) : null, sanitize(reason, 100)]);
    // Archive to the KB by hash (mirrors index()'s upserts — retire is non-destructive:
    // the value stays findable via zc_search and revivable via reviveFact).
    const source = `memory:${safeAgent}:${safeKey}`;
    const now = new Date().toISOString();
    try {
      await this.pool.query(`
        INSERT INTO knowledge_entries(project_hash, source, content, created_at, first_seen_at, last_indexed_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT(project_hash, source) DO UPDATE SET content = EXCLUDED.content, created_at = EXCLUDED.created_at,
          first_seen_at = COALESCE(knowledge_entries.first_seen_at, EXCLUDED.first_seen_at), last_indexed_at = NOW()
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
    opts: { focus?: string; from?: Date; to?: Date; asOf?: Date; role?: string } = {},
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
    const COLS = `key, value, importance, agent_id, created_at, kind, confidence, resolution_status, resolved_at, access_count, last_retrieved_at, origin, valid_at, created_by`;
    // S1 (v0.44.0) — historical WINDOW queries include RETIRED facts whose
    // event-time falls inside the window. Once auto-supersession retires a stale
    // fact, "what did we decide three weeks ago, before the change?" must still
    // surface it — it was the truth THEN (Zep invalid_at semantics: superseded,
    // not erased). Live-only remains the rule for unwindowed recall.
    const windowClause = (base: number): { sql: string; params: unknown[] } => {
      const parts: string[] = [];
      const params: unknown[] = [];
      let n = base;
      if (opts.from) { params.push(opts.from); parts.push(`COALESCE(valid_at::timestamptz, created_at::timestamptz) >= $${n++}`); }
      if (opts.to)   { params.push(opts.to);   parts.push(`COALESCE(valid_at::timestamptz, created_at::timestamptz) <= $${n++}`); }
      return { sql: `(valid_to IS NOT NULL AND ${parts.join(" AND ")})`, params };
    };
    if (safeAgent === "default") {
      // R1 — expired facts are excluded from live recall (the sweep formally retires them).
      let live = opts.asOf ? `created_at <= $2 AND (valid_to IS NULL OR valid_to > $2)` : `valid_to IS NULL AND (expires_at IS NULL OR expires_at > NOW())`;
      const params: unknown[] = opts.asOf ? [projectHash, opts.asOf] : [projectHash];
      if (!opts.asOf && (opts.from || opts.to)) {
        const w = windowClause(params.length + 1);
        live = `(${live} OR ${w.sql})`;
        params.push(...w.params);
      }
      const res = await this.pool.query<MemoryFact>(
        `SELECT ${COLS}
         FROM working_memory WHERE project_hash = $1 AND agent_id = 'default' AND ${live}
         ORDER BY importance DESC, created_at DESC`,
        params
      );
      rows = res.rows;
    } else {
      // For per-agent agentId: UNION (their private notebook) + (shared 'default' pool)
      let live = opts.asOf ? `created_at <= $3 AND (valid_to IS NULL OR valid_to > $3)` : `valid_to IS NULL AND (expires_at IS NULL OR expires_at > NOW())`;
      const params: unknown[] = opts.asOf ? [projectHash, safeAgent, opts.asOf] : [projectHash, safeAgent];
      if (!opts.asOf && (opts.from || opts.to)) {
        const w = windowClause(params.length + 1);
        live = `(${live} OR ${w.sql})`;
        params.push(...w.params);
      }
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

    // v0.54.0 - CROSS-PROJECT pinned lessons. An antipattern about how code fails
    // ("a stub returning a benign default hides a missing implementation") is not
    // about one repo. Measured: the identical class hit SecureContext and A2A
    // hours apart with nothing connecting them, because memory is per-project.
    //
    // Only PINNED kinds cross the boundary, and only from the reserved global
    // scope an author opts into - project facts never leak sideways.
    if (Config.SHARE_GLOBAL_PINNED && !opts.asOf) {
      try {
        const g = await this.pool.query<MemoryFact>(
          `SELECT ${COLS} FROM working_memory
            WHERE project_hash = $1 AND valid_to IS NULL
              AND kind IN ('constraint','antipattern')
            ORDER BY importance DESC, created_at DESC
            LIMIT 12`,
          // ph() the sentinel: remember() hashes whatever projectPath it is given,
          // so the write lands under hash("__global__"). Matching the raw literal
          // here made the pool unreachable - a write that succeeds into something
          // nothing reads. Both sides must hash identically.
          [ph(Config.GLOBAL_PROJECT_HASH)]);
        const seen = new Set(rows.map((r) => r.key));
        for (const gr of g.rows) if (!seen.has(gr.key)) rows.push(gr);
      } catch { /* global scope is additive; never break recall */ }
    }

    // Tier-2 #4: secondary salience re-sort (importance stays primary) + best-effort
    // access bump (single batched UPDATE via unnest, fire-and-forget). Inert when
    // W_SALIENCE=0 — byte-identical ordering, no writes (the kill-switch).
    // R8 (v0.43.0): sort key is EFFECTIVE importance (staleness-demoted, see
    // recall_budget.ts; inert when ZC_RECALL_STALE_DEMOTE=0) and the bump covers
    // only the facts that will RENDER under the recall budget — bumping every row
    // reset last_retrieved_at project-wide each recall, making "stale" undetectable.
    const demoteStale = Config.RECALL_STALE_DEMOTE > 0;
    if ((salienceEnabled() || demoteStale) && rows.length > 0) {
      const now = Date.now();
      const k    = (r: MemoryFact) => `${r.key} ${r.agent_id ?? ""}`;
      const sal  = salienceEnabled()
        ? new Map(rows.map((r) => [k(r), computeSalience(r.access_count, r.last_retrieved_at ?? null, now)]))
        : null;
      const prio = (r: MemoryFact) => (safeAgent !== "default" && r.agent_id === safeAgent ? 0 : 1);
      const eff  = (r: MemoryFact) => (demoteStale ? effectiveImportance(r, now) : r.importance);
      // v0.54.0 - role affinity RANKS, it does not filter. QA carrying the
      // developer's private constraints is noise worth demoting; hiding a fact
      // from a role that turns out to need it is the silent-loss failure this
      // codebase spent a day removing. Pinned kinds are exempt - a standing rule
      // applies to everyone regardless of who wrote it.
      const wRole = Config.W_ROLE_AFFINITY;
      const callerRole = String(opts.role ?? "").trim().toLowerCase();
      const roleBoost = (r: MemoryFact): number => {
        if (!wRole || !callerRole) return 0;
        if (["constraint", "antipattern"].includes(String(r.kind ?? ""))) return 0;
        const owner = String(r.agent_id ?? "").toLowerCase();
        if (owner === callerRole) return wRole;            // mine
        if (owner === "default")  return wRole / 2;        // shared, applies to all
        return -wRole;                                     // another role's private note
      };
      rows = [...rows].sort((a, b) =>
        prio(a) - prio(b) ||
        (eff(b) + roleBoost(b)) - (eff(a) + roleBoost(a)) ||
        (sal ? (sal.get(k(b)) ?? 0) - (sal.get(k(a)) ?? 0) : 0) ||
        (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)
      );
      if (salienceEnabled()) {
        const toBump = budgetFacts(rows).rendered;
        void this.pool.query(
          `UPDATE working_memory AS w
              SET access_count = COALESCE(w.access_count,0) + 1, last_retrieved_at = NOW()
             FROM unnest($2::text[], $3::text[]) AS t(key, agent_id)
            WHERE w.project_hash = $1 AND w.key = t.key AND w.agent_id = t.agent_id`,
          [projectHash, toBump.map((r) => r.key), toBump.map((r) => r.agent_id ?? safeAgent)]
        ).catch(() => undefined);
      }
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
              // R3 — measured verdict: on the labeled corpus BOTH a hard relevance
              // gate and a proportional bonus scored WORSE than the flat bonus
              // (gold/noise relevance ranges overlap). Flat is the default;
              // ZC_RECALL_TEMPORAL_REL_GATE>0 re-enables gating for corpora
              // where the ranges separate.
              if (inWindow) {
                score += Config.RECALL_TEMPORAL_REL_GATE > 0
                  ? (rel >= Config.RECALL_TEMPORAL_REL_GATE ? Config.RECALL_W_TEMPORAL : 0)
                  : Config.RECALL_W_TEMPORAL;
              }
            }
            return score;
          };
          const scores = new Map(rows.map((r) => [r, scoreOf(r)]));
          const bySorted = (a: MemoryFact, b: MemoryFact) =>
            (scores.get(b)! - scores.get(a)!) ||
            (b.importance - a.importance) ||
            (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);
          rows = [...rows].sort(bySorted);

          // S1 (v0.44.0) — prefer-latest (mirrors memory.ts): among the top candidates,
          // a near-identical conflicting pair demotes the OLDER fact below the newer.
          // Skipped for temporal/as-of queries — historical questions want the old fact.
          if (Config.PREFER_LATEST && !opts.from && !opts.to && !opts.asOf && rows.length > 1) {
            const { preferLatestAdjust } = await import("./contradiction_heuristics.js");
            const parseVec = (r: MemoryFact): Float32Array | undefined => {
              const vs = vecMap.get(`memory:${r.agent_id ?? safeAgent}:${r.key}`);
              return vs ? new Float32Array(vs.slice(1, -1).split(",").map(Number)) : undefined;
            };
            const evOf = (r: MemoryFact): number => {
              const raw = (r as MemoryFact & { valid_at?: string | Date | null }).valid_at ?? r.created_at;
              return raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
            };
            // Fixpoint loop: demoting a stale duplicate frees top-K slots that can
            // expose NEW conflicting pairs (measured: 6 stale worklogs blocked the
            // updated cache-TTL fact out of the window, so its stale twin was never
            // co-examined). Re-slice and re-run until a pass adjusts nothing (≤3).
            for (let pass = 0; pass < 3; pass++) {
              const top = rows.slice(0, Config.PREFER_LATEST_TOPK).map((r) => ({
                fact: r, score: scores.get(r)!, vec: parseVec(r), ev: evOf(r),
              }));
              const adjusted = preferLatestAdjust(top, cosineSimilarity, Config.PREFER_LATEST_MARGIN);
              if (adjusted.size === 0) break;
              for (const r of rows) {
                const adj = adjusted.get(r.key);
                if (adj !== undefined && adj < scores.get(r)!) scores.set(r, adj);
              }
              rows = [...rows].sort(bySorted);
            }
          }
        }
      } catch { /* focus ranking is best-effort — fall back to unfocused order */ }
    }
    return rows;
  }

  async archiveSummary(projectPath: string, summary: string): Promise<{ submitted: number; stored: number; dropped: number }> {
    // v0.52.5 - ONE clamp, not two. A live agent measured the gap: 2456 chars
    // submitted, 400 kept, a marker naming 1499 lost - and 557 chars that died
    // in this upstream sanitize() before the marker logic ever saw them, so the
    // marker under-reported the loss. A truncation notice that is itself wrong
    // is worse than none: it tells the reader the damage is bounded when it is not.
    const safe = clampWithMarker(sanitize(summary, 100_000), Config.BROADCAST_SUMMARY_MAX, "session summary");
    const now  = new Date().toISOString();
    const source = `[SESSION_SUMMARY] ${now.slice(0, 10)}`;
    await this.index(projectPath, safe, source, "internal", "summary");
    // v0.52.4 - a live agent found this one: zc_summarize_session silently lost
    // 1500 chars of session summary and reported "Session summary archived."
    // The session summary is what the NEXT session reads to resume, so a silent
    // clamp here loses continuity precisely where it matters most.
    await this.remember(projectPath, "last_session_summary", safe, 5, "default",
                        { valueMax: Config.BROADCAST_SUMMARY_MAX });
    return { submitted: summary.length, stored: safe.length, dropped: Math.max(0, summary.length - safe.length) };
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

  async countImportance5(projectPath: string, agentId: string): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*) as n FROM working_memory WHERE project_hash = $1 AND agent_id = $2 AND importance = 5 AND valid_to IS NULL",
      [ph(projectPath), sanitize(agentId, 64)]
    );
    return parseInt(res.rows[0]!.n, 10);
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
        } catch { /* malformed or stale cache row -> fall through and recompute */ }
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

    // Upsert knowledge entry.
    // TKG-T1 (v0.47.0) — bi-temporal: first_seen_at is IMMUTABLE (kept from the
    // existing row on conflict), last_indexed_at always bumps. created_at keeps
    // its historical bump-on-reindex behavior for backward compat; new temporal
    // features read the two explicit columns instead.
    await this.pool.query(`
      INSERT INTO knowledge_entries(project_hash, source, content, created_at, first_seen_at, last_indexed_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT(project_hash, source) DO UPDATE SET
        content         = EXCLUDED.content,
        created_at      = EXCLUDED.created_at,
        first_seen_at   = COALESCE(knowledge_entries.first_seen_at, EXCLUDED.first_seen_at),
        last_indexed_at = NOW()
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

    // Lever-4 (v0.48.0): event-fact extraction for session-tier sources (PG
    // parity — PostgresStore.index does not route through indexContent).
    scheduleEventExtraction(safeContent, safeSource, async (evSource, evContent) => {
      await this.index(projectPath, evContent, evSource, sourceType, retentionTier);
    });
  }

  private async _storeEmbedding(projectHash: string, content: string, source: string): Promise<boolean> {
    try {
      // v0.39.0 — content-addressable dedup (SQLite parity): identical content + same model
      // ⇒ skip the Ollama call; hash-match with a DIFFERENT model ⇒ explicit re-embed.
      const contentHash = createHash("sha256").update(content).digest("hex");
      try {
        const existing = (await this.pool.query<{ content_hash: string | null; model_name: string }>(
          `SELECT content_hash, model_name FROM embeddings WHERE project_hash = $1 AND source = $2`,
          [projectHash, source])).rows[0];
        if (existing && existing.content_hash === contentHash && existing.model_name === ACTIVE_MODEL) {
          // S9 — the HEAD is deduped, but chunks may not exist yet (content indexed
          // before chunking shipped, or a prior chunk pass died mid-way). Ensure
          // them; each chunk self-dedups via its own content_hash.
          if (Config.EMBED_CHUNKS && !source.startsWith("memory:") && content.length > Config.EMBED_CHUNK_SIZE) {
            void this._storeChunkEmbeddings(projectHash, content, source, contentHash).catch(() => undefined);
          }
          return true;
        }
      } catch { /* content_hash column absent (pre-migration) — fall through */ }

      const result = await getEmbeddingQueued(content); // S1 — background lane
      if (!result) {
        const now = Date.now();
        if (now - PostgresStore._lastEmbedErrLog > 60_000) {
          PostgresStore._lastEmbedErrLog = now;
          console.error(`[embed] getEmbedding returned null for ${source} (Ollama down/breaker open)`);
        }
        return false;
      }
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

      // S9 (v0.46.0) — chunk embeddings for long content: the head vector only
      // covers the first EMBED_MAX_CHARS; store additional per-chunk vectors so
      // search can max-pool similarity over the WHOLE document. Chunk rows are
      // keyed `<source>#c<N>` (never joined as KB entries; search maps them back
      // to the parent). Fire-and-forget per chunk via the background lane.
      if (Config.EMBED_CHUNKS && !source.startsWith("memory:") && content.length > Config.EMBED_CHUNK_SIZE) {
        void this._storeChunkEmbeddings(projectHash, content, source, contentHash).catch(() => undefined);
      }
      return true;
    } catch (e) {
      // Embedding failure is non-fatal — falls back to BM25-only search.
      // S1: but never fully silent — five rounds of debugging were spent on a
      // pipeline that failed without a single log line. Rate-limited to 1/min.
      const now = Date.now();
      if (now - PostgresStore._lastEmbedErrLog > 60_000) {
        PostgresStore._lastEmbedErrLog = now;
        console.error(`[embed] store failed for ${source}: ${(e as Error)?.message || (e as Error)?.name || "unknown"}`);
      }
      return false;
    }
  }
  private static _lastEmbedErrLog = 0;

  /**
   * S9 (v0.46.0) — store per-chunk embeddings for content beyond the head window.
   * Chunk 0 is the head (already stored under the bare source); chunks start at
   * offset EMBED_CHUNK_SIZE with a small overlap so boundary sentences aren't
   * split blind. content_hash carries the PARENT hash + chunk index so re-index
   * of unchanged content skips cleanly; stale chunks beyond the new count are
   * deleted (content shrank).
   */
  private async _storeChunkEmbeddings(projectHash: string, content: string, source: string, parentHash: string): Promise<void> {
    const size = Math.max(500, Config.EMBED_CHUNK_SIZE);
    const overlap = Math.min(300, Math.floor(size / 10));
    const chunks: string[] = [];
    for (let off = size - overlap; off < content.length && chunks.length < Math.max(1, Config.EMBED_MAX_CHUNKS); off += size - overlap) {
      const piece = content.slice(off, off + size);
      if (piece.trim().length < 100) break; // tail too small to be a useful vector
      chunks.push(piece);
    }
    for (let i = 0; i < chunks.length; i++) {
      const chunkSource = `${source}#c${i + 1}`;
      const chunkHash = `${parentHash}:${i + 1}`;
      try {
        const existing = (await this.pool.query<{ content_hash: string | null; model_name: string }>(
          `SELECT content_hash, model_name FROM embeddings WHERE project_hash = $1 AND source = $2`,
          [projectHash, chunkSource])).rows[0];
        if (existing && existing.content_hash === chunkHash && existing.model_name === ACTIVE_MODEL) continue;
        const result = await getEmbeddingQueued(chunks[i]!);
        if (!result) return; // embedder down — the backfill cron heals later re-writes
        await this.pool.query(`
          INSERT INTO embeddings(project_hash, source, vector, model_name, dimensions, created_at, content_hash)
          VALUES ($1, $2, $3::vector, $4, $5, $6, $7)
          ON CONFLICT(project_hash, source) DO UPDATE SET
            vector = EXCLUDED.vector, model_name = EXCLUDED.model_name,
            dimensions = EXCLUDED.dimensions, created_at = EXCLUDED.created_at,
            content_hash = EXCLUDED.content_hash
        `, [projectHash, chunkSource, "[" + result.vector.join(",") + "]", result.modelName, result.dimensions, new Date().toISOString(), chunkHash]);
      } catch { /* per-chunk best-effort */ }
    }
    // Content shrank since last index → drop chunk rows beyond the new count.
    try {
      await this.pool.query(
        `DELETE FROM embeddings WHERE project_hash = $1 AND source LIKE $2
           AND CAST(substring(source from '#c([0-9]+)$') AS int) > $3`,
        [projectHash, `${source.replace(/([%_\\])/g, "\\$1")}#c%`, chunks.length],
      );
    } catch { /* best-effort */ }
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
      const emb = await getEmbeddingQueued(row.content); // S1 — background lane
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

  /**
   * v0.46.1 (D4) — SELF-HEAL for the embed lane: budgeted embed of KB entries that
   * have NO head vector for the active model. These are orphans left behind when
   * index-time embedding died (timeouts under CPU contention, process restarts
   * mid-bulk-ingest, breaker-open windows) — previously they stayed BM25-only
   * FOREVER because nothing ever retried them. Called by the embed watchdog when
   * it detects a stalled lane; each pass drains up to `budget` entries.
   */
  async embedMissingVectors(budget = 50): Promise<{ embedded: number; remaining: number; ollamaDown: boolean }> {
    // Empty/whitespace content can NEVER embed (Ollama returns a zero-length
    // vector) — exclude it here AND in the watchdog's pending count, or a single
    // empty __init__.py head-of-line-blocks the whole drain forever (live-caught
    // 2026-07-17: 699 entries stuck behind one empty file).
    const missingSql = `FROM knowledge_entries ke
      WHERE LENGTH(TRIM(ke.content)) > 0 AND NOT EXISTS (SELECT 1 FROM embeddings e
        WHERE e.project_hash = ke.project_hash AND e.source = ke.source AND e.model_name = $1)`;
    const missing = (await this.pool.query<{ project_hash: string; source: string; content: string }>(
      `SELECT ke.project_hash, ke.source, ke.content ${missingSql} LIMIT $2`, [ACTIVE_MODEL, budget])).rows;
    let embedded = 0;
    let consecutiveFails = 0;
    for (const m of missing) {
      const ok = await this._storeEmbedding(m.project_hash, m.content, m.source);
      if (ok) { embedded++; consecutiveFails = 0; continue; }
      // Skip individual failures (a poison document must not block the queue);
      // only abort when failures are consecutive — that means the LANE is down.
      consecutiveFails++;
      if (consecutiveFails >= 3) {
        const rem0 = await this.pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n ${missingSql}`, [ACTIVE_MODEL]);
        return { embedded, remaining: Number(rem0.rows[0]?.n ?? 0), ollamaDown: true };
      }
    }
    const rem = await this.pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n ${missingSql}`, [ACTIVE_MODEL]);
    return { embedded, remaining: Number(rem.rows[0]?.n ?? 0), ollamaDown: false };
  }

  async search(projectPath: string, queries: string[], opts: SearchOptions = {}): Promise<KnowledgeEntry[]> {
    // TR-2 (v0.46.1) — COMPOUND temporal questions ("how many days between the
    // day I did X and the day I did Y") embed as a blend that matches neither
    // event. Decompose into event clauses, search each INDEPENDENTLY (plus the
    // full query), and RRF-fuse the lists. Temporal-scoped + recursion-guarded;
    // ZC_QUERY_DECOMPOSE=0 disables (splitEventClauses returns []).
    if (!opts._noDecompose) {
      const raw = queries.join(" ");
      const { isTemporalQuestion, stripInterrogativeScaffolding: stripQ, splitEventClauses } =
        await import("./temporal_parse.js");
      if (isTemporalQuestion(raw)) {
        const clauses = splitEventClauses(stripQ(raw));
        if (clauses.length >= 2) {
          const sub = { ...opts, _noDecompose: true };
          const lists = await Promise.all([
            this.search(projectPath, queries, sub),
            ...clauses.map((c) => this.search(projectPath, [c], sub)),
          ]);
          const K = 60;
          const scored = new Map<string, { entry: KnowledgeEntry; score: number; bestRank: number }>();
          for (const list of lists) {
            list.forEach((entry, i) => {
              const cur = scored.get(entry.source);
              const add = 1 / (K + i + 1);
              if (cur) { cur.score += add; if (i + 1 < cur.bestRank) { cur.bestRank = i + 1; cur.entry = entry; } }
              else scored.set(entry.source, { entry, score: add, bestRank: i + 1 });
            });
          }
          return [...scored.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, opts.limit ?? Config.MAX_RESULTS)
            .map((x) => ({ ...x.entry, rank: x.score }));
        }
      }
    }
    const projectHash = ph(projectPath);
    const limit       = opts.limit ?? Config.MAX_RESULTS;
    const candidates  = Config.BM25_CANDIDATES;

    // Merge all query terms into one tsvector query
    const rawQueryText = queries.join(" ");

    // R4 (v0.42.0) — NL temporal window in KB search: "docs indexed last week about X"
    // constrains candidates by created_at; the cleaned text (time phrase removed)
    // does the matching so keyword/vector relevance concentrates on the topic.
    const { parseTemporalQuery: parseTQ, stripInterrogativeScaffolding } = await import("./temporal_parse.js");
    const tw = parseTQ(rawQueryText);
    // S11 (v0.46.1) — strip interrogative-temporal scaffolding ("how many weeks
    // ago did I…") so BM25 + the query embedding concentrate on the EVENT content.
    // Declarative queries pass through unchanged; ZC_QUERY_DESCAFFOLD=0 disables.
    const queryText = stripInterrogativeScaffolding(
      (tw.from || tw.to) && tw.cleaned.trim() ? tw.cleaned : rawQueryText);

    // BM25 candidates via ts_rank (PostgreSQL full-text)
    type CandRow = { source: string; content: string; rank: number; source_type: string; synthetic?: boolean; created_at?: string | Date };
    const bm25Res = await this.pool.query<CandRow>(`
      SELECT ke.source, ke.content, ke.created_at, ke.first_seen_at,
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
            SELECT ke.source, ke.content, ke.created_at, ke.first_seen_at,
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
          // S9 (v0.46.0) — chunk rows (`<source>#c<N>`) map back to their PARENT
          // entry and the parent takes its BEST chunk's distance (max-pooled
          // similarity), so a match deep inside a long doc surfaces the doc.
          const vecRes = await this.pool.query<CandRow>(`
            SELECT q.source, q.content, q.created_at, q.first_seen_at, 0 AS rank, q.source_type
            FROM (
              SELECT DISTINCT ON (ke.source)
                     ke.source, ke.content, ke.created_at,
                     COALESCE(sm.source_type, 'internal') as source_type,
                     (e.vector <=> $3::vector) AS dist
              FROM   embeddings e
              JOIN   knowledge_entries ke
                ON   ke.project_hash = e.project_hash
               AND   ke.source = regexp_replace(e.source, '#c[0-9]+$', '')
              LEFT JOIN source_meta sm ON sm.project_hash = ke.project_hash AND sm.source = ke.source
              WHERE  e.project_hash = $1 AND e.model_name = $2
                AND  (e.vector <=> $3::vector) <= $5
              ORDER  BY ke.source, e.vector <=> $3::vector
            ) q
            ORDER  BY q.dist
            LIMIT  $4
          `, [projectHash, ACTIVE_MODEL, qVecStr, Config.VECTOR_CANDIDATES, 1 - Config.VECTOR_MIN_SIM]);
          for (const r of vecRes.rows) if (!candMap.has(r.source)) candMap.set(r.source, { ...r, synthetic: true });
        }
      } catch { /* pgvector unavailable — keyword candidates only */ }
    }

    if (candMap.size === 0) return [];
    let candRows = [...candMap.values()];
    // R4 — apply the temporal window to candidates (created_at range).
    if (tw.from || tw.to) {
      candRows = candRows.filter((r) => {
        const t = r.created_at instanceof Date ? r.created_at.getTime() : Date.parse(String(r.created_at ?? ""));
        return Number.isFinite(t) &&
          (!tw.from || t >= tw.from.getTime()) &&
          (!tw.to   || t <= tw.to.getTime());
      });
      if (candRows.length === 0) return [];
    }

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

        // Get stored embeddings for ALL candidates (keyword + OR-fallback + vector-injected).
        // S9 (v0.46.0): includes chunk rows (`<source>#c<N>`) — a candidate's cosine
        // score is the MAX over its head + chunk vectors (max-pooling), so long docs
        // aren't penalized for burying the relevant span past the head window.
        const embRes = await this.pool.query<{ source: string; vector: string }>(
          `SELECT source, vector::text FROM embeddings
           WHERE project_hash = $1 AND model_name = $3
             AND regexp_replace(source, '#c[0-9]+$', '') = ANY($2)`,
          [projectHash, sources, ACTIVE_MODEL]
        );

        const embsBySource = new Map<string, string[]>();
        for (const r of embRes.rows) {
          const parent = r.source.replace(/#c[0-9]+$/, "");
          const arr = embsBySource.get(parent);
          if (arr) arr.push(r.vector); else embsBySource.set(parent, [r.vector]);
        }
        const maxBm25 = Math.max(...candRows.map(r => r.rank), 1);

        // Compute cosine for every candidate up front (needed by both fusion modes).
        const withCos = candRows.map(row => {
          let cosScore = 0;
          for (const storedVecStr of embsBySource.get(row.source) ?? []) {
            // Parse pgvector "[x1,x2,...,xN]" string back to Float32Array
            const nums = storedVecStr.slice(1, -1).split(",").map(Number);
            const c = cosineSimilarity(new Float32Array(nums), qEmbed.vector);
            if (c > cosScore) cosScore = c;
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

        // v0.52.3 - RELEVANCE FLOOR. Caught by a live terminal agent: searching
        // 'zzzqqxx_no_such_token_anywhere_12345' returned TEN results. BM25
        // correctly matched nothing, then the vector channel filled the pool with
        // its ten nearest neighbours regardless of distance - so a query with no
        // answer produced ten plausible-looking answers, and an agent acting on
        // them would be acting on noise.
        //
        // Nearest-neighbour is always defined; RELEVANT is not. Drop candidates
        // whose vector score clears no meaningful bar, but only when BM25 also
        // found nothing (a real keyword hit is evidence on its own).
        // ZC_SEARCH_MIN_COSINE=0 restores the previous behaviour exactly.
        const _floor = Config.SEARCH_MIN_COSINE;
        if (_floor > 0) {
          const _kept = scored.filter((r) => (r.rank ?? 0) > 0 || (r.vectorScore ?? 0) >= _floor);
          if (_kept.length !== scored.length) {
            scored.length = 0;
            scored.push(..._kept);
          }
        }

        // Lever-4: stale same-subject events collapse to the latest BEFORE the
        // cap (freed slots refill) — but never on solver sub-searches, which
        // need every occurrence of a repeated event.
        const sup = opts._noDecompose ? scored : supersedeEventEntries(scored, (r) => ({ source: r.source, content: r.content }));
        results = capEventEntries(sup, limit, (r) => r.source).map(r => ({
          source:         r.source,
          content:        r.content,
          snippet:        r.content.slice(0, 200),
          rank:           r.hybridScore,
          vectorScore:    r.vectorScore,
          createdAt:      r.created_at ? new Date(r.created_at as string | Date).toISOString() : undefined,
          firstSeenAt:    (r as { first_seen_at?: string | Date }).first_seen_at ? new Date((r as { first_seen_at?: string | Date }).first_seen_at as string | Date).toISOString() : undefined,
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
      const fbSup = opts._noDecompose ? fb : supersedeEventEntries(fb, (x) => ({ source: x.r.source, content: x.r.content }));
      results = capEventEntries(fbSup, limit, (x) => x.r.source).map(({ r, rank, boost }) => ({
        source:         r.source,
        content:        r.content,
        snippet:        r.content.slice(0, 200),
        rank,
        createdAt:      r.created_at ? new Date(r.created_at as string | Date).toISOString() : undefined,
          firstSeenAt:    (r as { first_seen_at?: string | Date }).first_seen_at ? new Date((r as { first_seen_at?: string | Date }).first_seen_at as string | Date).toISOString() : undefined,
        backlinkScore:  boost || undefined,
        sourceType:     r.source_type,
        nonAsciiSource: /[^\x00-\x7F]/.test(r.source),
      }));
    }

    // TKG-T2 (v0.47.0) — point-in-time KB view: keep only entries first seen at
    // or before asOf. Entries without a first_seen_at (pre-migration) pass
    // through — fail-open so old projects don't silently vanish from history.
    if (opts.asOf) {
      const cutoff = new Date(opts.asOf).toISOString();
      if (!Number.isNaN(Date.parse(cutoff))) {
        results = results.filter((r) => !r.firstSeenAt || r.firstSeenAt <= cutoff);
      }
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

  async searchGlobal(queries: string[], limit = 10, projectFilter?: string): Promise<CrossProjectEntry[]> {
    const queryText = queries.join(" ");
    // D2 — optional project narrowing for cross-repo reference lookups. Names
    // resolve via project_paths_pg (hash → filesystem path, telemetry-populated —
    // the same source the dashboard uses; project_meta labels are optional extras).
    const pf = (projectFilter ?? "").trim();
    const filterClause = pf
      ? ` AND (COALESCE(pm.value, '') ILIKE $5 OR ke.project_hash LIKE $6
             OR ke.project_hash IN (SELECT pp2.project_hash FROM project_paths_pg pp2 WHERE pp2.project_path ILIKE $5))`
      : "";
    const filterParams = pf ? [`%${pf}%`, `${pf.toLowerCase()}%`] : [];
    const res = await this.pool.query<{
      source: string; content: string; rank: number;
      source_type: string; project_hash: string; project_label: string;
    }>(`
      SELECT ke.source, ke.content,
             ts_rank(to_tsvector('english', ke.content), plainto_tsquery('english', $1))
               + (CASE WHEN $3::float8 > 0 AND bl.weighted_in IS NOT NULL
                       THEN $3::float8 * (ln(1 + bl.weighted_in) / ln(1 + $4::float8)) ELSE 0 END) AS rank,
             COALESCE(sm.source_type, 'internal') as source_type,
             ke.project_hash,
             COALESCE(pm.value, pp.project_path, ke.project_hash) as project_label
      FROM   knowledge_entries ke
      LEFT JOIN source_meta sm ON sm.project_hash = ke.project_hash AND sm.source = ke.source
      LEFT JOIN project_meta pm ON pm.project_hash = ke.project_hash AND pm.key = 'project_label'
      LEFT JOIN project_paths_pg pp ON pp.project_hash = ke.project_hash
      LEFT JOIN kb_backlinks_pg bl ON bl.project_hash = ke.project_hash AND bl.source = ke.source
      WHERE  to_tsvector('english', ke.content) @@ plainto_tsquery('english', $1)${filterClause}
      ORDER  BY rank DESC
      LIMIT  $2
    `, [queryText, limit, Config.W_BACKLINK, Config.BACKLINK_LOG_BASE, ...filterParams]);

    return res.rows.map(r => ({
      source:         r.source,
      content:        r.content,
      snippet:        r.content.slice(0, 200),
      rank:           r.rank,
      sourceType:     r.source_type,
      nonAsciiSource: /[^\x00-\x7F]/.test(r.source),
      projectHash:    r.project_hash,
      // A path label renders as its folder name ("SecureContext"), not the full path.
      projectLabel:   /[/\\]/.test(r.project_label) ? (r.project_label.split(/[/\\]/).pop() || r.project_label) : r.project_label,
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
    // Explicit (tool/API) rebuild — bypasses the auto-rebuild node cap.
    return this._rebuildBacklinksByHash(ph(projectPath), { force: true });
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

  private static _capLogged = new Set<string>();
  private async _rebuildBacklinksByHash(projectHash: string, opts: { force?: boolean } = {}): Promise<{ edges: number; nodes: number; topHub: { source: string; weightedIn: number } | null }> {
    // v0.36.0 — memory-aware extraction (SQLite parity): live working-memory facts join the
    // co-reference scan as "memory:<agent>:<key>" pseudo-sources (eviction-archival naming),
    // so a fact mentioning "session.ts" creates a memory→file edge and the file gains boost.
    const rows = (await this.pool.query<{ source: string; content: string }>(
      `SELECT source, content FROM knowledge_entries WHERE project_hash = $1
       UNION ALL
       SELECT ('memory:' || agent_id || ':' || key) AS source, value AS content
         FROM working_memory WHERE project_hash = $1 AND valid_to IS NULL`, [projectHash]
    )).rows;
    // v0.46.1 — the O(N²) scan on a bulk-ingested corpus blocked the event loop for
    // minutes (pool timeouts, breaker-open, frozen ingest). Auto rebuilds skip huge
    // corpora; explicit zc_graph_rebuild still runs (yielding via the async extractor).
    if (!opts.force && rows.length > graphMaxNodes()) {
      if (!PostgresStore._capLogged.has(projectHash)) {
        PostgresStore._capLogged.add(projectHash);
        console.error(`[backlinks] auto-rebuild skipped for ${projectHash}: ${rows.length} nodes > ZC_GRAPH_MAX_NODES(${graphMaxNodes()}) — run zc_graph_rebuild to force`);
      }
      return { edges: 0, nodes: rows.length, topHub: null };
    }
    const typed = (await extractCoReferencesAsync(rows)).map((e) => ({
      from: e.from, to: e.to, relation: classifyRelation(e.from, e.to, e.matchKind), matchKind: e.matchKind, weight: e.weight,
    }));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // v0.37.0 — preserve LLM-extracted entity edges across co-reference rebuilds.
      // Live E2E 2026-08-04 — preserve the call layer too: this DELETE and the one in
      // backlinks.ts had diverged, so every API-side backlinks rebuild (including the
      // enrichment cron) silently wiped call edges and zc_impact reverted to "NOT built".
      await client.query("DELETE FROM kb_edges_pg     WHERE project_hash = $1 AND match_kind NOT IN ('entity', 'call')", [projectHash]);
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

  async callImpactFor(
    projectPath: string,
    query: { file?: string; symbol?: string },
  ): Promise<CallImpactResult> {
    const projectHash = ph(projectPath);
    const empty: CallImpactResult = { targets: [], dynamicSites: 0, built: false };
    try {
      // Built-ness is a property of the layer, not of this query matching rows.
      // Without this an unbuilt graph and a genuinely uncalled symbol return the
      // same shape, which is the fabricated zero this feature exists to avoid.
      const built = ((await this.pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM kb_edges_pg WHERE project_hash = $1 AND match_kind = 'call' LIMIT 1`,
        [projectHash])).rows[0]?.n ?? "0") !== "0";
      if (!built) return empty;

      const isSymbol = typeof query.symbol === "string" && query.symbol.length > 0;
      const pattern = isSymbol
        ? `func:%#${query.symbol}`
        : `func:${(query.file ?? "").split("\\").join("/")}#%`;

      const rows = (await this.pool.query<{
        to_source: string; from_source: string; relation_type: string; weight: number;
      }>(
        `SELECT to_source, from_source, relation_type, weight
           FROM kb_edges_pg
          WHERE project_hash = $1 AND match_kind = 'call'
            AND relation_type <> 'unresolved_calls'
            AND to_source LIKE $2`,
        [projectHash, pattern])).rows;

      const byTarget = new Map<string, CallImpactTarget>();
      for (const r of rows) {
        const hash = r.to_source.lastIndexOf("#");
        const symbol = r.to_source.slice(hash + 1);
        // LIKE 'func:%#name' can also match a path containing '#'; require an exact tail.
        if (isSymbol && symbol !== query.symbol) continue;

        let t = byTarget.get(r.to_source);
        if (!t) {
          t = {
            symbol, declaredIn: r.to_source.slice("func:".length, hash),
            callers: 0, sites: 0, files: [], ambiguous: 0,
          };
          byTarget.set(r.to_source, t);
        }
        if (r.relation_type === "calls_ambiguous") { t.ambiguous++; continue; }
        t.callers++;
        t.sites += r.weight;
        const f = r.from_source.slice("func:".length).split("#")[0]!;
        if (!t.files.includes(f)) t.files.push(f);
      }

      let dynamicSites = 0;
      if (!isSymbol) {
        dynamicSites = (await this.pool.query<{ weight: number }>(
          `SELECT weight FROM kb_edges_pg
            WHERE project_hash = $1 AND match_kind = 'call'
              AND relation_type = 'unresolved_calls' AND to_source = $2`,
          [projectHash, `unresolved:${(query.file ?? "").split("\\").join("/")}`])).rows[0]?.weight ?? 0;
      }

      const targets = [...byTarget.values()].sort((a, b) => b.callers - a.callers);
      for (const t of targets) t.files.sort();
      return { targets, dynamicSites, built: true };
    } catch {
      return empty;
    }
  }

  // ── Memory contradictions (Tier-1 B, PG-native) ───────────────────────────
  async scanContradictions(projectPath: string, agentId: string): Promise<{ scanned: number; flagged: number; ollamaAvailable: boolean; skipped?: number }> {
    return this._scanContradictionsByHash(ph(projectPath), sanitize(agentId, 64));
  }

  /**
   * v0.46.2 — close open contradictions whose facts are no longer BOTH live.
   * Caught live: 1,053 of 1,123 open flags referenced a retired/superseded/
   * evicted fact — zombie triage debt that grew forever because nothing ever
   * re-checked liveness. A contradiction about a dead fact is moot by definition.
   */
  private async _pruneStaleContradictions(projectHash: string): Promise<number> {
    try {
      const r = await this.pool.query(
        `UPDATE memory_contradictions_pg mc
            SET status = 'dismissed', reviewed_at = NOW(), resolution_mode = 'auto',
                detail = mc.detail || ' [auto-closed: a side was retired/superseded/evicted]'
          WHERE mc.project_hash = $1 AND mc.status = 'open'
            AND (NOT EXISTS (SELECT 1 FROM working_memory w
                              WHERE w.project_hash = mc.project_hash AND w.key = mc.key_a
                                AND w.agent_id IN (mc.agent_id, 'default') AND w.valid_to IS NULL)
              OR NOT EXISTS (SELECT 1 FROM working_memory w
                              WHERE w.project_hash = mc.project_hash AND w.key = mc.key_b
                                AND w.agent_id IN (mc.agent_id, 'default') AND w.valid_to IS NULL))`,
        [projectHash]);
      return r.rowCount ?? 0;
    } catch { return 0; }
  }

  private async _scanContradictionsByHash(projectHash: string, safeAgent: string, sinceDays?: number): Promise<{ scanned: number; flagged: number; ollamaAvailable: boolean; skipped?: number }> {
    // v0.46.2 — every scan first sweeps zombie flags so the triage queue
    // self-maintains instead of accumulating forever.
    void this._pruneStaleContradictions(projectHash).then((n) => {
      if (n > 0) console.log(`[contradictions] auto-closed ${n} stale flag(s) for ${projectHash} (retired/evicted facts)`);
    });
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
       WHERE project_hash = $1 AND (agent_id = $2 OR agent_id = 'default') AND importance >= 2 AND valid_to IS NULL${recencyClause}
       ORDER BY created_at DESC, importance DESC LIMIT $3`, params)).rows;
    // S1 — RECENT-first (was importance-first): on a mature project (~130 ★5 facts)
    // the importance-ordered budget was consumed entirely by old facts scanned in
    // every prior session, while NEW facts — the actual conflict candidates — never
    // entered the window. Past pairs' verdicts persist in memory_contradictions_pg,
    // so re-scanning old-vs-old adds nothing.
    if (facts.length < 2) return { scanned: facts.length, flagged: 0, ollamaAvailable: true };

    // S1 (v0.44.0) — the scan READS STORED VECTORS first (facts are embedded at
    // write time since S1) and only embeds the missing few via the background
    // lane. Re-embedding all 80 facts per scan took minutes once embeds were
    // serialized (measured: the MCP proxy timed out with "fetch failed") and
    // hammered Ollama for vectors that already existed.
    const vectors = new Map<string, Float32Array>();
    let embFails = 0;
    const srcOf = (f: { agent_id: string; key: string }) => `memory:${f.agent_id}:${f.key}`;
    try {
      const stored = await this.pool.query<{ source: string; vector: string }>(
        `SELECT source, vector::text FROM embeddings
          WHERE project_hash = $1 AND model_name = $2 AND source = ANY($3)`,
        [projectHash, ACTIVE_MODEL, facts.map(srcOf)]);
      const bySource = new Map(stored.rows.map((r) => [r.source, r.vector]));
      for (const f of facts) {
        const vs = bySource.get(srcOf(f));
        if (vs) vectors.set(f.key, new Float32Array(vs.slice(1, -1).split(",").map(Number)));
      }
    } catch { /* embeddings table absent — fall through to live embeds */ }
    for (const f of facts) {
      if (vectors.has(f.key)) continue;
      const emb = await getEmbeddingQueued(f.value); // S1 — background lane
      if (!emb) { embFails++; continue; }
      vectors.set(f.key, emb.vector);
      // Persist the vector we already computed so the NEXT scan (and focused
      // recall) reads it for free — NOT via _storeEmbedding, which would re-embed.
      void this._persistVector(projectHash, srcOf(f), f.value, emb).catch(() => undefined);
    }
    if (vectors.size < 2) {
      return { scanned: facts.length, flagged: 0, ollamaAvailable: embFails < facts.length, skipped: embFails };
    }
    const found: Array<{ ka: string; kb: string; sim: number; reason: string; detail: string; victim: string | null }> = [];
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const a = facts[i]!, b = facts[j]!;
        // v0.46.2 — acceptance_* keys are WORKFLOW STATE (per-phase checklists
        // from the acceptance-gate skill), not claims about the world. Two
        // phases' checklists naturally share phrasing and differ in numbers —
        // flagging them as contradictions is pure noise (seen live:
        // acceptance_E4_security vs acceptance_e4_final).
        if (a.key.startsWith("acceptance_") || b.key.startsWith("acceptance_")) continue;
        const va = vectors.get(a.key), vb = vectors.get(b.key);
        if (!va || !vb) continue;
        const sim = cosineSimilarity(va, vb);
        if (sim < SIM_HIGH) continue;
        const conflict = detectConflict(a, b, sim); // R2 — sim enables numeric_conflict
        if (!conflict) continue;
        const [ka, kb] = a.key < b.key ? [a.key, b.key] : [b.key, a.key];
        // v0.37.0 — clear supersession ⇒ auto-resolve (retire the stale side); else open triage.
        const victim = Config.AUTO_RESOLVE ? autoResolveVictim(a, b, conflict.reason) : null;
        found.push({ ka, kb, sim, reason: conflict.reason, detail: conflict.detail, victim });
      }
    }
    const agentOf = new Map(facts.map((f) => [f.key, f.agent_id]));
    const factByKey = new Map(facts.map((f) => [f.key, f]));
    let flagged = 0;
    // TKG-T3 (v0.47.0) — LLM adjudication budget per scan: ambiguous pairs (no
    // algorithmic victim) get one constrained local-LLM judgment each, capped so
    // a noisy scan can't monopolize the model. Bakeoff-derived policy: verdict
    // "compatible" suppresses the false-positive flag entirely; "update"
    // invalidates the OLDER side (recency wins — the model never picks);
    // "contradiction"/failure falls through to open triage exactly as before.
    let adjudicationsLeft = parseInt(process.env["ZC_LLM_ADJUDICATE_BUDGET"] ?? "8", 10) || 8;
    const { adjudicatePair, adjudicatorEnabled } = await import("./llm_adjudicator.js");
    for (const f of found) {
      // Operator override wins forever: a pair previously reviewed (dismissed/acknowledged/
      // resolved) is never auto-resolved and never re-opened by the scan.
      const existing = (await this.pool.query<{ status: string }>(
        `SELECT status FROM memory_contradictions_pg WHERE project_hash = $1 AND agent_id = $2 AND key_a = $3 AND key_b = $4`,
        [projectHash, safeAgent, f.ka, f.kb])).rows[0];
      if (existing && existing.status !== "open") continue;

      if (!f.victim && adjudicatorEnabled() && adjudicationsLeft > 0) {
        const fa = factByKey.get(f.ka), fb = factByKey.get(f.kb);
        if (fa && fb) {
          adjudicationsLeft--;
          const j = await adjudicatePair({ key: fa.key, value: fa.value }, { key: fb.key, value: fb.value });
          if (j?.verdict === "compatible") {
            // False-positive suppression: record as dismissed so the pair is
            // never re-flagged; operator sees nothing (that's the point).
            await this.pool.query(
              `INSERT INTO memory_contradictions_pg(project_hash, agent_id, key_a, key_b, similarity, reason, detail, status, surfaced_by, reviewed_at, resolution_mode)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'dismissed','cron',NOW(),'auto-llm')
               ON CONFLICT (project_hash, agent_id, key_a, key_b) DO UPDATE SET
                 status = 'dismissed', reviewed_at = NOW(), resolution_mode = 'auto-llm'`,
              [projectHash, safeAgent, f.ka, f.kb, f.sim, f.reason, `LLM adjudicated compatible (suppressed). ${f.detail}`]);
            continue;
          }
          if (j?.verdict === "update") {
            // Recency picks the survivor (bakeoff: no model reliably picks sides).
            const older = new Date(fa.created_at) <= new Date(fb.created_at) ? fa : fb;
            const newer = older === fa ? fb : fa;
            if (Config.AUTO_RESOLVE) {
              f.victim = older.key;
              f.detail = `LLM adjudicated update; recency invalidated '${older.key}' in favor of '${newer.key}'. ${f.detail}`;
            } else {
              // v0.53.1 — ADVISORY, not destructive. This branch used to install a
              // victim directly, bypassing the AUTO_RESOLVE gate that only wrapped
              // the heuristic path — the hole through which the adjudicator retired
              // the release-completion record at the moment of a shutdown checkpoint
              // (its "superseding" fact was a summary that merely mentioned it).
              // With auto-resolve off, the adjudicator's opinion now travels WITH the
              // open flag so the operator gets the triage head-start and keeps the
              // decision: informing is autonomous, destroying is not.
              f.detail = `LLM advisory: likely update — '${newer.key}' appears to supersede '${older.key}' (auto-resolve disabled; operator decides). ${f.detail}`;
            }
          }
          // "contradiction" or null → fall through to the open-triage path below.
        }
      }

      if (f.victim) {
        const winner = f.victim === f.ka ? f.kb : f.ka;
        const retired = await this._retireFactByHash(
          projectHash, f.victim, agentOf.get(f.victim) ?? "default", winner, "superseded",
        ).catch(() => false);
        if (retired) {
          // TKG-T3 — world-time invalidation: the victim stopped being true when
          // the winning fact was recorded (best local approximation of t_invalid).
          try {
            const winnerFact = factByKey.get(winner);
            await this.pool.query(
              `UPDATE working_memory SET invalid_from = $4 WHERE project_hash = $1 AND key = $2 AND agent_id = $3 AND invalid_from IS NULL`,
              [projectHash, f.victim, agentOf.get(f.victim) ?? "default",
               winnerFact ? new Date(winnerFact.created_at) : new Date()]);
          } catch { /* pre-migration — retirement itself already succeeded */ }
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
    // R8 — surface transiently-skipped facts: a "clean" scan that skipped facts is incomplete.
    return { scanned: facts.length, flagged, ollamaAvailable: true, skipped: embFails };
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
    // R1 (v0.42.0) — TTL sweep: formally retire facts past their expires_at
    // ('expired', revivable for RETIRE_PURGE_DAYS like any retirement). Recall
    // already excludes them; the sweep keeps the table + dashboard honest.
    try {
      await this.pool.query(
        `UPDATE working_memory SET valid_to = NOW(), retired_reason = 'expired'
          WHERE expires_at IS NOT NULL AND expires_at <= NOW() AND valid_to IS NULL`);
    } catch { /* pre-migration — next cycle */ }
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
  /**
   * S1 — write-time fact embedding, SERIALIZED through a promise chain.
   * Measured failure: a burst of 81 rapid remembers fired 81 concurrent embed
   * calls, saturated Ollama after ~12, tripped the embedder's failure breaker,
   * and every remaining embed dropped (healed only by the 30-min cron). The
   * chain drains one at a time in the background — a burst costs seconds, not
   * an open breaker. Depth-capped as a runaway guard; drops heal via the cron.
   */
  /** S1 — persist an ALREADY-COMPUTED vector (no Ollama call). */
  private async _persistVector(projectHash: string, source: string, content: string, emb: { vector: Float32Array; modelName: string; dimensions: number }): Promise<void> {
    const contentHash = createHash("sha256").update(content).digest("hex");
    await this.pool.query(`
      INSERT INTO embeddings(project_hash, source, vector, model_name, dimensions, created_at, content_hash)
      VALUES ($1, $2, $3::vector, $4, $5, $6, $7)
      ON CONFLICT(project_hash, source) DO UPDATE SET
        vector = EXCLUDED.vector, model_name = EXCLUDED.model_name,
        dimensions = EXCLUDED.dimensions, created_at = EXCLUDED.created_at,
        content_hash = EXCLUDED.content_hash
    `, [projectHash, source, "[" + emb.vector.join(",") + "]", emb.modelName, emb.dimensions, new Date().toISOString(), contentHash]);
  }

  private _embedFactAsync(projectHash: string, agentId: string, key: string, value: string): void {
    // Serialization + per-item retry live in the embedder's global BACKGROUND
    // lane (getEmbeddingQueued, used by _storeEmbedding) — shared with scans and
    // backfills so no combination of callers can stampede Ollama.
    void this._storeEmbedding(projectHash, value, `memory:${agentId}:${key}`).catch(() => undefined);
  }

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
    // v0.53.1 - task and reason announce their truncation. A REJECT 'reason'
    // explaining why work failed, cut silently at 500 chars, is the same
    // silent-clamp class as the 1000-char summary that cost a worker its
    // acceptance criteria. Summary already announced; these two did not.
    const safeTask    = clampWithMarker(sanitize(opts.task ?? "", 100_000), 500, "task id");
    const safeSummary = clampBroadcastSummary(sanitize(opts.summary ?? "", Config.BROADCAST_SUMMARY_MAX * 2));
    const safeState   = sanitize(opts.state   ?? "", 200);
    const safeReason  = clampWithMarker(sanitize(opts.reason ?? "", 100_000), 500, "reason");
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

      // Attribution: prefer the declared sender (MCP proxy passes its own ZC_AGENT_ID);
      // for non-ASSIGN types agent_id IS the sender; ASSIGN with no declared sender
      // stays NULL — unknown, never fabricated. Mirrors memory.ts broadcastFact.
      const safeSender = (opts as { sender?: string }).sender ?? (type !== "ASSIGN" ? safeAgent : null);

      const insertRes = await client.query<{ id: number }>(`
        INSERT INTO broadcasts(
          project_hash, type, agent_id, task, summary, files, state,
          depends_on, reason, importance, created_at,
          session_token_id, prev_hash, row_hash,
          acceptance_criteria, complexity_estimate,
          file_ownership_exclusive, file_ownership_read_only,
          task_dependencies, required_skills, estimated_tokens, sender_agent_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                  $15,$16,$17,$18,$19,$20,$21,$22)
        RETURNING id, type, agent_id, task, summary, reason
      `, [projectHash, type, safeAgent, safeTask, safeSummary, files, safeState,
          dependsOn, safeReason, safeImp, now, tokenId, prevHash, rowHash,
          safeAccept, safeComplexity, safeFileExcl, safeFileRO,
          safeTaskDeps, safeReqSkills, safeEstTokens, safeSender]);

      await client.query("COMMIT");

      // v0.53.1 - readback verification on the broadcast path. The clamp fixes
      // above stop the SILENCE; this catches what a clamp cannot predict - a DB
      // CHECK or trigger quietly changing a value, which is exactly how
      // kind:'constraint' became 'fact' and cost three live rounds to find.
      if (Config.EFFECT_VERIFY) {
        const stored = insertRes.rows[0] as unknown as Record<string, unknown>;
        const v = verifyWrite(
          { type, agent_id: safeAgent, task: safeTask, summary: safeSummary, reason: safeReason },
          stored,
          { type: "exact", agent_id: "exact", task: "lossy-marked", summary: "lossy-marked", reason: "lossy-marked" },
          { operation: "zc_broadcast" }
        );
        if (!v.ok) {
          const { logger: lg } = await import("./logger.js");
          lg.warn("effect_verify", "broadcast_discrepancy", { notice: v.notice.slice(0, 400) });
        }
      }

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
      // v0.53.0 — sender_agent_id joins the poll payload. The column existed since
      // migration 47 and replay() already returned it, but the dispatcher's poll goes
      // through HERE — so consumers kept disambiguating direction from agent_id alone,
      // which is the sender on STATUS and the target on ASSIGN. Cost, measured live: a
      // worker's STATUS(answer) was routed back to the worker and the orchestrator
      // deadlocked ~2h waiting for an answer that had already been delivered.
      `SELECT id, type, agent_id, sender_agent_id, task, summary, files, state, depends_on, reason,
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
      `SELECT id, type, agent_id, sender_agent_id, task, summary, files, state, depends_on,
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
  kind              TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact','decision','hypothesis','prediction','constraint','antipattern')),
  confidence        REAL,
  resolution_status TEXT CHECK (resolution_status IN ('open','resolved_correct','resolved_incorrect','resolved_partial')),
  resolved_at       TIMESTAMPTZ,
  -- S3 (v0.46.0) team attribution: which USER (api key owner) wrote the fact
  created_by        TEXT,
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
