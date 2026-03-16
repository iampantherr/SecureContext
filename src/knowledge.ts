/**
 * Hybrid BM25 + Vector Knowledge Base
 *
 * SEARCH ARCHITECTURE (inspired by LlamaIndex hybrid retrieval):
 *
 *   Query → BM25 (FTS5) top-20 candidates (fast, exact keyword match)
 *         ↓
 *         Load stored embeddings for each candidate (from SQLite BLOB)
 *         ↓
 *         Compute query embedding (Ollama nomic-embed-text, async)
 *         ↓
 *         Cosine similarity reranking
 *         ↓
 *         Hybrid score: 0.35 × BM25_norm + 0.65 × cosine
 *         ↓
 *         Return top-10 by hybrid score
 *
 * If Ollama is not running: falls back to pure BM25 (rank field used directly).
 * Embeddings are computed fire-and-forget after indexing — never block indexing.
 *
 * SECURITY:
 * - All SQL queries are parameterized — no injection possible
 * - FTS5 MATCH wrapped per-query in try/catch — malformed queries return empty
 * - Embedding computation is input-capped at 4000 chars
 * - Vector BLOBs are bounded (768 floats = 3072 bytes) — no bloat attack vector
 * - SHA256-scoped DB filenames — no path traversal possible
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getEmbedding, cosineSimilarity, serializeVector, deserializeVector } from "./embedder.js";

const DB_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");
const MAX_RESULTS = 10;
const BM25_CANDIDATES = 20;  // over-fetch for reranking
const STALE_DAYS = 14;       // longer retention with hybrid search (14 days vs 7)

// Hybrid weight: how much to trust each signal
const W_COSINE = 0.65;
const W_BM25   = 0.35;

export interface KnowledgeEntry {
  source:  string;
  content: string;
  snippet: string;
  rank:    number;
  vectorScore?: number; // cosine similarity (0–1), undefined if no embedding available
}

export function dbPath(projectPath: string): string {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(DB_DIR, `${hash}.db`);
}

export function openDb(projectPath: string): DatabaseSync {
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(dbPath(projectPath));
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    -- FTS5 full-text knowledge table (BM25 ranking via rank)
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge USING fts5(
      source,
      content,
      created_at UNINDEXED,
      tokenize='porter unicode61'
    );

    -- Vector embeddings table (one row per indexed source)
    CREATE TABLE IF NOT EXISTS embeddings (
      source     TEXT    PRIMARY KEY,
      vector     BLOB    NOT NULL,
      created_at TEXT    NOT NULL
    );

    -- Working memory table (MemGPT-inspired hot facts)
    CREATE TABLE IF NOT EXISTS working_memory (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT    NOT NULL UNIQUE,
      value      TEXT    NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wm_evict
      ON working_memory(importance ASC, created_at ASC);
  `);

  // Purge stale knowledge and embeddings
  const cutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();
  db.prepare("DELETE FROM knowledge WHERE created_at < ?").run(cutoff);
  db.prepare("DELETE FROM embeddings WHERE created_at < ?").run(cutoff);

  return db;
}

/** Fire-and-forget: compute embedding and store asynchronously */
async function storeEmbeddingAsync(projectPath: string, content: string, source: string): Promise<void> {
  const vector = await getEmbedding(content);
  if (!vector) return; // Ollama not available — BM25-only fallback

  const db = openDb(projectPath);
  try {
    db.prepare(
      "INSERT OR REPLACE INTO embeddings(source, vector, created_at) VALUES (?, ?, ?)"
    ).run(source, serializeVector(vector), new Date().toISOString());
  } finally {
    db.close();
  }
}

/**
 * Index content into the knowledge base.
 * FTS5 insert is synchronous. Embedding is computed asynchronously (fire-and-forget).
 */
export function indexContent(
  projectPath: string,
  content: string,
  source: string
): void {
  const db = openDb(projectPath);
  db.prepare("DELETE FROM knowledge WHERE source = ?").run(source);
  db.prepare(
    "INSERT INTO knowledge(source, content, created_at) VALUES (?, ?, ?)"
  ).run(source, content, new Date().toISOString());
  db.close();

  // Async embedding computation — does not block indexing
  storeEmbeddingAsync(projectPath, content, source).catch(() => undefined);
}

/**
 * Hybrid BM25 + vector search.
 * Returns results ranked by combined score (BM25 + cosine similarity).
 * Falls back to pure BM25 if Ollama is unavailable.
 */
export async function searchKnowledge(
  projectPath: string,
  queries: string[]
): Promise<KnowledgeEntry[]> {
  const db = openDb(projectPath);
  const seen = new Set<string>();

  type BM25Row = { source: string; content: string; rank: number };
  type EmbedRow = { source: string; vector: Buffer };

  // Collect all unique BM25 candidates across all queries
  const candidateMap = new Map<string, BM25Row>();

  for (const query of queries) {
    if (!query.trim()) continue;

    let rows: BM25Row[];
    try {
      rows = db.prepare(
        `SELECT source, content, rank
         FROM knowledge
         WHERE knowledge MATCH ?
         ORDER BY rank
         LIMIT ?`
      ).all(query, BM25_CANDIDATES) as BM25Row[];
    } catch {
      // SECURITY: malformed FTS5 query (unclosed quote, bare *, etc.) — skip gracefully
      continue;
    }

    for (const row of rows) {
      if (!candidateMap.has(row.source)) {
        candidateMap.set(row.source, row);
      }
    }
  }

  if (candidateMap.size === 0) {
    db.close();
    return [];
  }

  // Load pre-computed embeddings for all candidates in one query
  const sources = Array.from(candidateMap.keys());
  const placeholders = sources.map(() => "?").join(",");
  const embedRows = db.prepare(
    `SELECT source, vector FROM embeddings WHERE source IN (${placeholders})`
  ).all(...sources) as EmbedRow[];
  db.close();

  const embeddingMap = new Map<string, Float32Array>();
  for (const row of embedRows) {
    embeddingMap.set(row.source, deserializeVector(row.vector));
  }

  // Compute query embedding (one vector for all queries combined)
  const queryText = queries.filter((q) => q.trim()).join(" ");
  const queryVector = await getEmbedding(queryText);

  // Normalize BM25 ranks (FTS5 rank is negative; more negative = better match)
  const ranks = Array.from(candidateMap.values()).map((r) => r.rank);
  const minRank = Math.min(...ranks);
  const maxRank = Math.max(...ranks);
  const rankRange = maxRank - minRank || 1;

  const scored: Array<KnowledgeEntry & { _hybrid: number }> = [];

  for (const [source, row] of candidateMap) {
    if (seen.has(source)) continue;
    seen.add(source);

    // Normalize BM25: invert (lower rank = better) → 0–1 scale
    const bm25Norm = 1 - (row.rank - minRank) / rankRange;

    // Cosine similarity (0 if no embedding available for this source)
    let cosine = 0;
    const storedVec = embeddingMap.get(source);
    if (queryVector && storedVec) {
      cosine = cosineSimilarity(queryVector, storedVec);
    }

    // Hybrid score: weighted combination
    const hybridScore = queryVector && storedVec
      ? W_BM25 * bm25Norm + W_COSINE * cosine
      : bm25Norm; // BM25-only if no embeddings

    // Extract relevant snippet around first query term
    const firstTerm = queries[0]?.toLowerCase().split(" ")[0] ?? "";
    const idx = row.content.toLowerCase().indexOf(firstTerm);
    const start = Math.max(0, idx - 100);
    const snippet = row.content.slice(start, start + 400).trim();

    scored.push({
      source,
      content: row.content,
      snippet: snippet || row.content.slice(0, 400),
      rank: hybridScore,
      vectorScore: queryVector && storedVec ? cosine : undefined,
      _hybrid: hybridScore,
    });
  }

  // Sort by hybrid score (descending) and return top MAX_RESULTS
  scored.sort((a, b) => b._hybrid - a._hybrid);
  return scored.slice(0, MAX_RESULTS).map(({ _hybrid: _, ...rest }) => rest);
}

export function clearKnowledge(projectPath: string): void {
  const db = openDb(projectPath);
  db.prepare("DELETE FROM knowledge").run();
  db.prepare("DELETE FROM embeddings").run();
  db.close();
}
