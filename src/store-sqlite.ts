/**
 * SqliteStore — Store implementation backed by the existing local SQLite infrastructure.
 *
 * This is a thin async wrapper. Every method delegates to the existing
 * memory.ts / knowledge.ts / access-control.ts functions, wrapping their
 * synchronous return values in Promise.resolve().
 *
 * This means:
 *   - Zero behaviour change from the current single-developer path
 *   - Full backward compatibility — existing tests pass unchanged
 *   - The Store interface is honoured, so the API server and HTTP client mode
 *     work transparently with SQLite for local development
 *
 * Performance note: DatabaseSync calls are synchronous and block the Node.js
 * event loop. This is acceptable for local single-developer use (one Claude
 * process, low concurrency). For high-concurrency multi-agent production use,
 * switch to ZC_STORE=postgres.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { Config } from "./config.js";
import { runMigrations } from "./migrations.js";
import {
  rememberFact,
  forgetFact,
  recallWorkingMemory,
  archiveSessionSummary,
  getMemoryStats as _getMemoryStats,
  getWorkingMemoryLimits as _getWorkingMemoryLimits,
  computeProjectComplexity,
  broadcastFact,
  recallSharedChannel,
  replayBroadcasts,
  ackBroadcast,
  getBroadcastChainStatus,
  setChannelKey as _setChannelKey,
  isChannelKeyConfigured as _isChannelKeyConfigured,
} from "./memory.js";
import type { EpistemicOpts } from "./memory.js";
import {
  indexContent,
  searchKnowledge,
  searchAllProjects,
  getKbStats as _getKbStats,
  explainRetrieval,
  openDb as openKbDb,
} from "./knowledge.js";
import { rebuildBacklinks as rebuildBacklinksSqlite } from "./indexing/backlinks.js";
import { detectContradictions, listOpenContradictions, reviewContradiction as reviewContradictionSqlite } from "./memory_contradictions.js";
import {
  issueToken as _issueToken,
  revokeAllAgentTokens,
  verifyToken as _verifyToken,
  countActiveSessions as _countActiveSessions,
  type AgentRole,
} from "./access-control.js";
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
import type { MemoryFact, BroadcastType, BroadcastMessage, BroadcastResult, KnowledgeEntry, CrossProjectEntry, RetentionTier } from "./store.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function openProjectDb(projectPath: string): DatabaseSync {
  mkdirSync(Config.DB_DIR, { recursive: true });
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  const db   = new DatabaseSync(join(Config.DB_DIR, `${hash}.db`));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  runMigrations(db);
  return db;
}

function openGlobalDb(): DatabaseSync {
  mkdirSync(Config.GLOBAL_DIR, { recursive: true });
  const db = new DatabaseSync(Config.GLOBAL_DB);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      project_hash TEXT NOT NULL,
      date         TEXT NOT NULL,
      fetch_count  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_hash, date)
    )
  `);
  return db;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function projectHashOf(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// SqliteStore
// ─────────────────────────────────────────────────────────────────────────────

export class SqliteStore implements Store {

  // ── Working Memory ────────────────────────────────────────────────────────

  async remember(projectPath: string, key: string, value: string, importance: number, agentId: string, epi?: EpistemicOpts): Promise<void> {
    rememberFact(projectPath, key, value, importance, agentId, undefined, epi);
  }

  async forget(projectPath: string, key: string, agentId: string): Promise<boolean> {
    return forgetFact(projectPath, key, agentId);
  }

  async recall(projectPath: string, agentId: string): Promise<MemoryFact[]> {
    return recallWorkingMemory(projectPath, agentId);
  }

  async archiveSummary(projectPath: string, summary: string): Promise<void> {
    archiveSessionSummary(projectPath, summary);
  }

  async getMemoryStats(projectPath: string, agentId: string): Promise<MemoryStats> {
    return _getMemoryStats(projectPath, agentId);
  }

  async getWorkingMemoryLimits(projectPath: string, forceRecompute = false): Promise<MemoryLimits> {
    const db = openProjectDb(projectPath);
    try {
      const limits = _getWorkingMemoryLimits(db, forceRecompute);
      return limits;
    } finally {
      db.close();
    }
  }

  // ── Knowledge Base ─────────────────────────────────────────────────────────

  async index(
    projectPath: string,
    content: string,
    source: string,
    sourceType: "internal" | "external" = "internal",
    retentionTier?: RetentionTier
  ): Promise<void> {
    indexContent(projectPath, content, source, sourceType, retentionTier);
  }

  async search(projectPath: string, queries: string[], opts: SearchOptions = {}): Promise<KnowledgeEntry[]> {
    // searchKnowledge signature: (projectPath, queries, depth?)
    return searchKnowledge(projectPath, queries, (opts.depth ?? "L2") as "L0" | "L1" | "L2");
  }

  async searchGlobal(queries: string[], limit = 10): Promise<CrossProjectEntry[]> {
    return searchAllProjects(queries, limit);
  }

  async getKbStats(projectPath: string): Promise<KbStats> {
    return _getKbStats(projectPath);
  }

  async explain(projectPath: string, query: string, depth = "L1"): Promise<ExplainResult> {
    return explainRetrieval(projectPath, query, depth as "L0" | "L1" | "L2") as unknown as ExplainResult;
  }

  // ── Knowledge graph + backlinks (Tier-1 A) ────────────────────────────────
  async rebuildBacklinks(projectPath: string): Promise<{ edges: number; nodes: number; topHub: { source: string; weightedIn: number } | null }> {
    const db = openProjectDb(projectPath);
    try {
      const r = rebuildBacklinksSqlite(db);
      return { edges: r.edges, nodes: r.nodes, topHub: r.topHub };
    } finally {
      db.close();
    }
  }

  async graphData(projectPath: string): Promise<{ nodes: Array<{ id: string; inDegree: number; weightedIn: number }>; edges: Array<{ from: string; to: string; relation: string; weight: number }> }> {
    const db = openProjectDb(projectPath);
    try {
      let edges: Array<{ from: string; to: string; relation: string; weight: number }> = [];
      const blMap = new Map<string, { inDegree: number; weightedIn: number }>();
      try {
        const br = db.prepare("SELECT source, in_degree, weighted_in FROM kb_backlinks").all() as Array<{ source: string; in_degree: number; weighted_in: number }>;
        for (const b of br) blMap.set(b.source, { inDegree: b.in_degree, weightedIn: b.weighted_in });
        const er = db.prepare("SELECT from_source, to_source, relation_type, weight FROM kb_edges LIMIT 2000").all() as Array<{ from_source: string; to_source: string; relation_type: string; weight: number }>;
        edges = er.map((e) => ({ from: e.from_source, to: e.to_source, relation: e.relation_type, weight: e.weight }));
      } catch { /* tables absent (pre-migration / never rebuilt) */ }
      const ids = new Set<string>();
      for (const e of edges) { ids.add(e.from); ids.add(e.to); }
      const nodes = [...ids].map((id) => ({ id, inDegree: blMap.get(id)?.inDegree ?? 0, weightedIn: blMap.get(id)?.weightedIn ?? 0 }));
      return { nodes, edges };
    } finally {
      db.close();
    }
  }

  async backlinksFor(projectPath: string, source: string, limit: number): Promise<{ inDegree: number; weightedIn: number; inbound: Array<{ from: string; relation: string; weight: number }> } | null> {
    const db = openProjectDb(projectPath);
    try {
      let bl: { in_degree: number; weighted_in: number } | undefined;
      let inbound: Array<{ from: string; relation: string; weight: number }> = [];
      try {
        bl = db.prepare("SELECT in_degree, weighted_in FROM kb_backlinks WHERE source = ?").get(source) as { in_degree: number; weighted_in: number } | undefined;
        const er = db.prepare("SELECT from_source, relation_type, weight FROM kb_edges WHERE to_source = ? ORDER BY weight DESC LIMIT ?").all(source, Math.min(Math.max(limit, 1), 100)) as Array<{ from_source: string; relation_type: string; weight: number }>;
        inbound = er.map((e) => ({ from: e.from_source, relation: e.relation_type, weight: e.weight }));
      } catch { return null; }
      if (!bl) return null;
      return { inDegree: bl.in_degree, weightedIn: bl.weighted_in, inbound };
    } finally {
      db.close();
    }
  }

  // ── Memory contradictions (Tier-1 B) ──────────────────────────────────────
  async scanContradictions(projectPath: string, agentId: string): Promise<{ scanned: number; flagged: number; ollamaAvailable: boolean }> {
    return detectContradictions(projectPath, agentId, "manual");
  }

  async listContradictions(projectPath: string, agentId: string): Promise<Array<{ key_a: string; key_b: string; similarity: number; reason: string; detail: string }>> {
    return listOpenContradictions(projectPath, agentId);
  }

  async reviewContradiction(projectPath: string, agentId: string, keyA: string, keyB: string, status: "dismissed" | "acknowledged" | "resolved"): Promise<number> {
    return reviewContradictionSqlite(projectPath, agentId, keyA, keyB, status);
  }

  // ── Broadcasts ────────────────────────────────────────────────────────────

  async broadcast(
    projectPath: string,
    type: BroadcastType,
    agentId: string,
    opts: BroadcastOptions
  ): Promise<BroadcastMessage> {
    return broadcastFact(projectPath, type, agentId, opts);
  }

  async recallBroadcasts(projectPath: string, opts: RecallOptions): Promise<BroadcastResult[]> {
    // recallSharedChannel only supports { limit?, type? }
    return recallSharedChannel(projectPath, { limit: opts.limit, type: opts.type });
  }

  async replay(projectPath: string, fromId?: number): Promise<BroadcastResult[]> {
    // replayBroadcasts uses a timestamp string, not an ID — query directly
    const db = openProjectDb(projectPath);
    try {
      type Row = BroadcastResult & { files: string; depends_on: string };
      const rows = (fromId !== undefined
        ? db.prepare(
            "SELECT id,type,agent_id,task,summary,files,state,depends_on,reason,importance,created_at FROM broadcasts WHERE id >= ? ORDER BY id ASC"
          ).all(fromId)
        : db.prepare(
            "SELECT id,type,agent_id,task,summary,files,state,depends_on,reason,importance,created_at FROM broadcasts ORDER BY id ASC LIMIT 500"
          ).all()
      ) as unknown as Row[];
      return rows.map(r => ({ ...r, files: JSON.parse(r.files || "[]"), depends_on: JSON.parse(r.depends_on || "[]") }));
    } finally {
      db.close();
    }
  }

  async ack(projectPath: string, id: number): Promise<void> {
    // ackBroadcast requires agentId — pass "system" for Store-level acks
    ackBroadcast(projectPath, id, "system");
  }

  async chainStatus(projectPath: string): Promise<ChainStatus> {
    const result = getBroadcastChainStatus(projectPath);
    return {
      ok:        result.ok,
      totalRows: result.totalRows,
      brokenAt:  result.brokenAt,
    };
  }

  async setChannelKey(projectPath: string, key: string): Promise<void> {
    _setChannelKey(projectPath, key);
  }

  async isChannelKeyConfigured(projectPath: string): Promise<boolean> {
    return _isChannelKeyConfigured(projectPath);
  }

  // ── RBAC & Tokens ─────────────────────────────────────────────────────────

  async issueToken(projectPath: string, agentId: string, role: AgentRole): Promise<string> {
    const db = openProjectDb(projectPath);
    try {
      return _issueToken(db, projectPath, agentId, role);
    } finally {
      db.close();
    }
  }

  async revokeTokens(projectPath: string, agentId: string): Promise<void> {
    const db = openProjectDb(projectPath);
    try {
      revokeAllAgentTokens(db, agentId);
    } finally {
      db.close();
    }
  }

  async verifyToken(projectPath: string, token: string): Promise<TokenPayload | null> {
    const db = openProjectDb(projectPath);
    try {
      const result = _verifyToken(db, token, projectPath);
      if (!result) return null;
      return result as unknown as TokenPayload;
    } finally {
      db.close();
    }
  }

  async countActiveSessions(projectPath: string): Promise<number> {
    const db = openProjectDb(projectPath);
    try {
      return _countActiveSessions(db);
    } finally {
      db.close();
    }
  }

  // ── Rate Limiting ──────────────────────────────────────────────────────────

  async getFetchStats(projectPath: string): Promise<FetchStats> {
    const db   = openGlobalDb();
    const hash = projectHashOf(projectPath);
    const today = todayUtc();
    try {
      const row = db.prepare(
        "SELECT fetch_count FROM rate_limits WHERE project_hash = ? AND date = ?"
      ).get(hash, today) as { fetch_count: number } | undefined;
      const used = row?.fetch_count ?? 0;
      return { used, remaining: Math.max(0, Config.FETCH_LIMIT - used) };
    } finally {
      db.close();
    }
  }

  async incrementFetch(projectPath: string): Promise<FetchStats> {
    const db    = openGlobalDb();
    const hash  = projectHashOf(projectPath);
    const today = todayUtc();
    try {
      db.prepare(`
        INSERT INTO rate_limits(project_hash, date, fetch_count) VALUES (?, ?, 1)
        ON CONFLICT(project_hash, date) DO UPDATE SET fetch_count = fetch_count + 1
      `).run(hash, today);
      const row = db.prepare(
        "SELECT fetch_count FROM rate_limits WHERE project_hash = ? AND date = ?"
      ).get(hash, today) as { fetch_count: number };
      const used = row.fetch_count;
      return { used, remaining: Math.max(0, Config.FETCH_LIMIT - used) };
    } finally {
      db.close();
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    // SQLite connections are opened and closed per-call — nothing to tear down
  }
}
