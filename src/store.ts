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
  remember(projectPath: string, key: string, value: string, importance: number, agentId: string, epi?: EpistemicOpts): Promise<void>;
  forget(projectPath: string, key: string, agentId: string): Promise<boolean>;
  recall(projectPath: string, agentId: string): Promise<MemoryFact[]>;
  archiveSummary(projectPath: string, summary: string): Promise<void>;
  getMemoryStats(projectPath: string, agentId: string): Promise<MemoryStats>;
  getWorkingMemoryLimits(projectPath: string, forceRecompute?: boolean): Promise<MemoryLimits>;

  // ── Knowledge Base ──────────────────────────────────────────────────────────
  index(projectPath: string, content: string, source: string, sourceType?: "internal" | "external", retentionTier?: RetentionTier): Promise<void>;
  search(projectPath: string, queries: string[], opts?: SearchOptions): Promise<KnowledgeEntry[]>;
  searchGlobal(queries: string[], limit?: number): Promise<CrossProjectEntry[]>;
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

  // ── Community query mode (v0.37.0) ───────────────────────────────────────────
  /** Corpus-level Q&A over pre-computed Louvain community summaries (+ DRIFT-lite follow-ups). */
  globalSearch(projectPath: string, question: string): Promise<{ answer: string; followups: string[]; communities: Array<{ community_id: number; size: number; sample_sources: string; summary: string }> } | null>;

  // ── Temporal fact retirement (v0.37.0) ───────────────────────────────────────
  /** Retire a fact (valid_to close-out + KB archival, non-destructive). Returns false if no live fact. */
  retireFact(projectPath: string, key: string, agentId: string, supersededBy: string | null, reason: string): Promise<boolean>;
  /** Undo a retirement (clears valid_to). Returns false if the fact wasn't retired. */
  reviveFact(projectPath: string, key: string, agentId: string): Promise<boolean>;

  // ── Memory contradictions (Tier-1 B) ─────────────────────────────────────────
  scanContradictions(projectPath: string, agentId: string): Promise<{ scanned: number; flagged: number; ollamaAvailable: boolean }>;
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

/** Derive the 16-hex-char project discriminator from the raw path. */
export function projectHash(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
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
export async function createStore(): Promise<Store> {
  const backend = process.env["ZC_STORE"] ?? "sqlite";

  if (backend === "postgres") {
    const pgUrl = process.env["ZC_PG_URL"];
    if (!pgUrl) {
      throw new Error(
        "ZC_STORE=postgres requires ZC_PG_URL to be set.\n" +
        "Example: ZC_PG_URL=postgresql://postgres:password@localhost:5432/securecontext"
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
