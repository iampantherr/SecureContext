/**
 * SecureContext Storage Abstraction Layer
 *
 * PURPOSE:
 *   Decouples the MCP plugin and API server from any specific database backend.
 *   Two implementations ship out of the box:
 *
 *     SqliteStore  — local SQLite file per project (default, single-developer)
 *     PostgresStore — shared PostgreSQL + pgvector (production, multi-agent, multi-machine)
 *
 * SELECTION:
 *   Controlled by the ZC_STORE environment variable:
 *     ZC_STORE=sqlite   (or unset) → SqliteStore
 *     ZC_STORE=postgres            → PostgresStore (requires ZC_PG_URL)
 *
 * DESIGN PRINCIPLES:
 *   - All methods are async (Promise-returning).
 *     SqliteStore wraps synchronous DatabaseSync calls in Promise.resolve().
 *     PostgresStore uses pg.Pool with native async/await.
 *   - No method throws to the caller for expected errors (token-not-found,
 *     key-not-found, etc.) — those return null/false/empty array.
 *   - Security enforcement (RBAC, hash chain, rate limits) lives in the Store
 *     implementation, not in the caller.
 *   - projectPath is always the raw filesystem path (e.g. "C:/Users/Amit/AI_projects/RevClear").
 *     Implementations derive projectHash = SHA256(projectPath).slice(0,16) internally.
 *     Callers never need to know about hashing.
 */

import { createHash } from "node:crypto";
import type { MemoryFact, BroadcastType, BroadcastMessage, BroadcastResult, ComplexityProfile, EpistemicOpts } from "./memory.js";
import type { KnowledgeEntry, CrossProjectEntry, RetentionTier } from "./knowledge.js";
import type { AgentRole } from "./access-control.js";

// ─────────────────────────────────────────────────────────────────────────────
// Re-exported shared types (callers import from store.ts, not from sub-modules)
// ─────────────────────────────────────────────────────────────────────────────

export type {
  MemoryFact,
  BroadcastType,
  BroadcastMessage,
  BroadcastResult,
  ComplexityProfile,
  KnowledgeEntry,
  CrossProjectEntry,
  RetentionTier,
  AgentRole,
};

// ─────────────────────────────────────────────────────────────────────────────
// Store-specific types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One call target and everything that reaches it.
 *
 * `callers` and `sites` are different questions on purpose: callers is "how many
 * places must I check", sites is "how many edits might be needed". `ambiguous`
 * is what name-based resolution could not attribute confidently and is
 * deliberately NOT folded into callers.
 */
export interface CallImpactTarget {
  symbol:     string;
  declaredIn: string;
  callers:    number;
  sites:      number;
  files:      string[];
  ambiguous:  number;
}

export interface CallImpactResult {
  targets: CallImpactTarget[];
  /** Call sites in the queried file that could not be named. Coverage, not noise. */
  dynamicSites: number;
  /** False when the call layer has never been built. Never render this as zero impact. */
  built: boolean;
}

export interface MemoryStats {
  count:         number;
  max:           number;
  evictTo:       number;
  criticalCount: number;
  complexity:    ComplexityProfile | null;
}

export interface MemoryLimits {
  max:     number;
  evictTo: number;
  profile: ComplexityProfile | null;
}

export interface KbStats {
  totalEntries:    number;
  externalEntries: number;
  summaryEntries:  number;
  embeddingsCached: number;
  dbSizeBytes:     number;
}

export interface SearchOptions {
  limit?:   number;
  agentId?: string;
  depth?:   "L0" | "L1" | "L2";
  /** TR-2 internal: set on sub-searches spawned by temporal-question
   *  decomposition so they don't decompose recursively. */
  _noDecompose?: boolean;
  /** TKG-T2 (v0.47.0) — point-in-time KB view: only entries first seen at or
   *  before this ISO timestamp ("what did the KB contain on date X"). */
  asOf?: string;
}

export interface ExplainEntry {
  source:      string;
  bm25Score:   number;
  vectorScore: number;
  hybridScore: number;
  tier:        string;
  snippet:     string;
}

export interface ExplainResult {
  query:      string;
  depth:      string;
  results:    ExplainEntry[];
  model:      string;
  searchMode: string;
}

export interface BroadcastOptions {
  task?:          string;
  files?:         string[];
  state?:         string;
  summary?:       string;
  depends_on?:    string[];
  reason?:        string;
  importance?:    number;
  channel_key?:   string;
  session_token?: string;
}

export interface RecallOptions {
  limit?:         number;
  sinceId?:       number;
  type?:          BroadcastType;
  agentId?:       string;
}

export interface ChainStatus {
  ok:        boolean;
  totalRows: number;
  brokenAt?: number;
}

export interface TokenPayload {
  tokenId: string;
  agentId: string;
  role:    AgentRole;
  iat:     number;
  exp:     number;
}

export interface FetchStats {
  used:      number;
  remaining: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store interface
// ─────────────────────────────────────────────────────────────────────────────

export interface Store {
  // ── Working Memory ──────────────────────────────────────────────────────────
  /** Returns an effect-verification result when a write did not round-trip as requested (v0.52.0). */
  remember(projectPath: string, key: string, value: string, importance: number, agentId: string, epi?: EpistemicOpts): Promise<import("./effect_verify.js").VerifyResult | void>;
  forget(projectPath: string, key: string, agentId: string): Promise<boolean>;
  // M1 (v0.41.0): optional focus re-ranks live facts by blended relevance to the
  // agent's current task; without it, ordering is unchanged (backward-compatible).
  // M3 (v0.41.0): from/to = temporal-window bonus; asOf = point-in-time reconstruction.
  recall(projectPath: string, agentId: string, opts?: { focus?: string; from?: Date; to?: Date; asOf?: Date; role?: string }): Promise<MemoryFact[]>;
  archiveSummary(projectPath: string, summary: string): Promise<{ submitted: number; stored: number; dropped: number } | void>;
  getMemoryStats(projectPath: string, agentId: string): Promise<MemoryStats>;
  getWorkingMemoryLimits(projectPath: string, forceRecompute?: boolean): Promise<MemoryLimits>;
  // R8c (v0.43.0): live ★5 count in a namespace — importance-inflation soft-quota nudge.
  countImportance5(projectPath: string, agentId: string): Promise<number>;

  // ── Knowledge Base ──────────────────────────────────────────────────────────
  index(projectPath: string, content: string, source: string, sourceType?: "internal" | "external", retentionTier?: RetentionTier): Promise<void>;
  search(projectPath: string, queries: string[], opts?: SearchOptions): Promise<KnowledgeEntry[]>;
  /** D2 (v0.46.1): projectFilter narrows to projects whose label contains the
   *  string (case-insensitive) or whose hash starts with it — the cross-repo
   *  reference lookup ("how did SecureContext implement replay?"). */
  searchGlobal(queries: string[], limit?: number, projectFilter?: string): Promise<CrossProjectEntry[]>;
  getKbStats(projectPath: string): Promise<KbStats>;
  explain(projectPath: string, query: string, depth?: string): Promise<ExplainResult>;

  // ── Knowledge graph + backlinks (Tier-1 A) ───────────────────────────────────
  rebuildBacklinks(projectPath: string): Promise<{ edges: number; nodes: number; topHub: { source: string; weightedIn: number } | null }>;
  /** Optional boot heal: rebuild backlinks for every project with knowledge but an empty graph.
   *  PG-native (one DB, many project_hashes); the SQLite path is healed by indexProject's flush. */
  backfillBacklinks?(): Promise<{ projects: number; edges: number }>;
  /** Optional Tier-2 #6 enrichment cycle (run by the cron): re-scan contradictions for every
   *  active (project,agent) pair + backfill empty backlink graphs. PG-native. */
  runEnrichment?(): Promise<{ projects: number; flagged: number; backfilledProjects: number; ollamaDown: boolean; entities?: number }>;
  graphData(projectPath: string): Promise<{ nodes: Array<{ id: string; inDegree: number; weightedIn: number }>; edges: Array<{ from: string; to: string; relation: string; weight: number }> }>;
  backlinksFor(projectPath: string, source: string, limit: number): Promise<{ inDegree: number; weightedIn: number; inbound: Array<{ from: string; relation: string; weight: number }> } | null>;

  /**
   * Function-level impact: who calls what is declared in `file`, or who calls
   * `symbol` anywhere. Exactly one of file/symbol is used.
   *
   * `built: false` means the call layer has never been built for this project —
   * NOT that nothing depends on the target. Callers must render those
   * differently, which is the entire point of the feature.
   */
  callImpactFor(
    projectPath: string,
    query: { file?: string; symbol?: string },
  ): Promise<CallImpactResult>;

  // ── Community query mode (v0.37.0) ───────────────────────────────────────────
  /** Corpus-level Q&A over pre-computed Louvain community summaries (+ DRIFT-lite follow-ups). */
  globalSearch(projectPath: string, question: string): Promise<{ answer: string; followups: string[]; communities: Array<{ community_id: number; size: number; sample_sources: string; summary: string }> } | null>;

  // ── Temporal fact retirement (v0.37.0) ───────────────────────────────────────
  /** Retire a fact (valid_to close-out + KB archival, non-destructive). Returns false if no live fact. */
  retireFact(projectPath: string, key: string, agentId: string, supersededBy: string | null, reason: string): Promise<boolean>;
  /** Undo a retirement (clears valid_to). Returns false if the fact wasn't retired. */
  reviveFact(projectPath: string, key: string, agentId: string): Promise<boolean>;

  // ── Memory contradictions (Tier-1 B) ─────────────────────────────────────────
  // R8 (v0.43.0): `skipped` = facts whose embedding transiently failed (embedder busy) — the
  // scan continued without them, so a clean result with skipped>0 is INCOMPLETE, not clean.
  scanContradictions(projectPath: string, agentId: string): Promise<{ scanned: number; flagged: number; ollamaAvailable: boolean; skipped?: number }>;
  listContradictions(projectPath: string, agentId: string): Promise<Array<{ key_a: string; key_b: string; similarity: number; reason: string; detail: string }>>;
  reviewContradiction(projectPath: string, agentId: string, keyA: string, keyB: string, status: "dismissed" | "acknowledged" | "resolved", mode?: string): Promise<number>;

  // ── Broadcasts ──────────────────────────────────────────────────────────────
  broadcast(projectPath: string, type: BroadcastType, agentId: string, opts: BroadcastOptions): Promise<BroadcastMessage>;
  recallBroadcasts(projectPath: string, opts: RecallOptions): Promise<BroadcastResult[]>;
  replay(projectPath: string, fromId?: number): Promise<BroadcastResult[]>;
  ack(projectPath: string, id: number): Promise<void>;
  chainStatus(projectPath: string): Promise<ChainStatus>;
  setChannelKey(projectPath: string, key: string): Promise<void>;
  isChannelKeyConfigured(projectPath: string): Promise<boolean>;

  // ── RBAC & Tokens ──────────────────────────────────────────────────────────
  issueToken(projectPath: string, agentId: string, role: AgentRole): Promise<string>;
  revokeTokens(projectPath: string, agentId: string): Promise<void>;
  verifyToken(projectPath: string, token: string): Promise<TokenPayload | null>;
  countActiveSessions(projectPath: string): Promise<number>;

  // ── Rate Limiting ──────────────────────────────────────────────────────────
  getFetchStats(projectPath: string): Promise<FetchStats>;
  incrementFetch(projectPath: string): Promise<FetchStats>;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  /** Called once on shutdown — close connection pools, flush caches. */
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers used by both implementations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical form of a project path, so that spellings of the SAME directory
 * produce the SAME hash.
 *
 * This is not hypothetical tidying. Measured on the author's machine before the
 * fix: RevClear had TWO databases (6160 KB under the backslash form, 380 KB
 * under the forward-slash form) and Test_Agent_Coordination had two more
 * (1336 KB / 352 KB). Whatever an agent wrote through one spelling was
 * invisible to every component using the other — a silent partition of memory,
 * with no error at any layer.
 *
 * Deliberately conservative about WHAT is normalised:
 *   - separators and a trailing separator, which caused the observed split;
 *   - NOT case. Lower-casing would change the hash of every project that
 *     already exists and strand every database on disk. Windows is
 *     case-insensitive, so that is a real remaining gap — but a migration, not
 *     a one-line change, and it has not bitten anything yet.
 */
export function normalizeProjectPath(projectPath: string): string {
  let s = String(projectPath ?? "");
  const isWindows = /^[a-zA-Z]:/.test(s);
  if (isWindows) s = s.replace(/\//g, "\\");
  // A trailing separator does not make it a different project. Keep the root
  // separator itself ("C:\" / "/") so the path stays meaningful.
  const stripped = s.replace(/[\\/]+$/, "");
  return stripped === "" || /^[a-zA-Z]:$/.test(stripped) ? s.slice(0, stripped.length + 1) : stripped;
}

/**
 * Derive the 16-hex-char project discriminator.
 *
 * THE single definition. Everything that needs a project hash — stores, hooks,
 * scripts, the MCP tool handlers — must route through here rather than
 * re-deriving sha256(...).slice(0,16) inline, because a second copy is free to
 * disagree about the input and nothing will report it.
 */
export function projectHash(projectPath: string): string {
  return createHash("sha256").update(normalizeProjectPath(projectPath)).digest("hex").slice(0, 16);
}

/** Current UTC date string in YYYY-MM-DD format (for rate limit buckets). */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the appropriate Store based on the ZC_STORE environment variable.
 *
 * ZC_STORE=sqlite   (or unset) → SqliteStore  — no extra config needed
 * ZC_STORE=postgres            → PostgresStore — requires ZC_PG_URL
 *
 * The factory is async because PostgresStore needs to verify the connection
 * and run schema migrations before first use.
 */
/**
 * Connection string for the Postgres store.
 *
 * Accepts the SAME configuration pg_pool.ts already uses. Before this,
 * `createStore` read only `ZC_PG_URL` — a name referenced nowhere else in the
 * codebase — while every PG-native path (telemetry, kb_edges_pg, task queue)
 * read `ZC_POSTGRES_URL` / `ZC_POSTGRES_*`. A machine fully configured for
 * Postgres would therefore throw "requires ZC_PG_URL" the moment you set
 * ZC_STORE=postgres: the documented switch did not work with the documented
 * configuration.
 *
 * Returns null when nothing is configured, so the caller can say what is missing
 * rather than attempting a connection to a default that was never intended.
 */
export function resolvePgConnectionString(): string | null {
  const direct = process.env["ZC_POSTGRES_URL"] || process.env["ZC_PG_URL"];
  if (direct) return direct;

  const host = process.env["ZC_POSTGRES_HOST"];
  const password = process.env["ZC_POSTGRES_PASSWORD"];
  // Host alone is not enough to be sure Postgres was actually intended; requiring
  // one credential avoids silently connecting to a stray localhost server.
  if (!host && !password) return null;

  const user = process.env["ZC_POSTGRES_USER"] || "scuser";
  const port = process.env["ZC_POSTGRES_PORT"] || "5432";
  const db   = process.env["ZC_POSTGRES_DB"]   || "securecontext";
  const auth = `${encodeURIComponent(user)}${password ? ":" + encodeURIComponent(password) : ""}`;
  return `postgresql://${auth}@${host || "localhost"}:${port}/${db}`;
}

export async function createStore(): Promise<Store> {
  const backend = process.env["ZC_STORE"] ?? "sqlite";

  if (backend === "postgres") {
    const pgUrl = resolvePgConnectionString();
    if (!pgUrl) {
      throw new Error(
        "ZC_STORE=postgres needs connection details. Any of these works:\n" +
        "  ZC_POSTGRES_URL=postgresql://user:pass@host:5432/securecontext   (same var pg_pool.ts uses)\n" +
        "  ZC_POSTGRES_HOST / _PORT / _USER / _PASSWORD / _DB              (parts)\n" +
        "  ZC_PG_URL=...                                                    (legacy alias)"
      );
    }
    const { PostgresStore } = await import("./store-postgres.js");
    const store = new PostgresStore(pgUrl);
    await store.init();
    return store;
  }

  // Default: SQLite
  const { SqliteStore } = await import("./store-sqlite.js");
  return new SqliteStore();
}
