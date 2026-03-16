/**
 * MemGPT-inspired Hierarchical Memory for SecureContext
 *
 * Architecture (learned from MemGPT / Letta):
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  WORKING MEMORY (hot, bounded, fast)                    │
 *   │  - Key-value facts with importance scores (1–5)         │
 *   │  - Max 50 entries before auto-eviction                  │
 *   │  - Persisted in SQLite for cross-restart continuity     │
 *   │  - Returned in full on zc_recall_context()              │
 *   └─────────────────────────────────────────────────────────┘
 *                        │ eviction (low importance / oldest)
 *                        ▼
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  ARCHIVAL MEMORY (cold, unbounded, searchable)          │
 *   │  = the FTS5 knowledge base (knowledge.ts)               │
 *   │  - Evicted WM facts land here with source "memory:key"  │
 *   │  - Session summaries land here with source "[SUMMARY]"  │
 *   │  - Searchable via BM25 + vector hybrid (zc_search)      │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Key difference from MemGPT: we do NOT use an LLM to manage memory.
 * Instead, importance scores + recency drive eviction deterministically.
 * This is faster, cheaper, and has zero prompt injection risk in the
 * memory management path itself.
 *
 * SECURITY:
 * - All values sanitized (strip \r\n\x00) before storage
 * - Max 500 chars per value to prevent DB bloat attacks
 * - Max 100 chars per key
 * - Eviction is deterministic — no LLM call in the critical path
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { indexContent } from "./knowledge.js";

const DB_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");
const WORKING_MEMORY_MAX = 50;    // evict when this is exceeded
const WORKING_MEMORY_EVICT_TO = 40; // target size after eviction batch

export interface MemoryFact {
  key: string;
  value: string;
  importance: number;
  created_at: string;
}

// SECURITY: Strip control chars and limit length to prevent log injection / DB bloat
function sanitize(s: string, maxLen: number): string {
  return String(s).replace(/[\r\n\x00\x01-\x08\x0b\x0c\x0e-\x1f]/g, " ").trim().slice(0, maxLen);
}

function dbPath(projectPath: string): string {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(DB_DIR, `${hash}.db`);
}

function openDb(projectPath: string): DatabaseSync {
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(dbPath(projectPath));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS working_memory (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      key      TEXT    NOT NULL UNIQUE,
      value    TEXT    NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TEXT  NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wm_evict
      ON working_memory(importance ASC, created_at ASC);
  `);
  return db;
}

/**
 * MemGPT operation: WRITE to working memory.
 * If the key already exists, it is updated in place.
 * Triggers eviction to archival if working memory is full.
 */
export function rememberFact(
  projectPath: string,
  key: string,
  value: string,
  importance: number = 3
): void {
  const safeKey   = sanitize(key,   100);
  const safeValue = sanitize(value, 500);
  const safeImp   = Math.max(1, Math.min(5, Math.round(importance)));
  const now = new Date().toISOString();

  const db = openDb(projectPath);
  db.prepare(`
    INSERT INTO working_memory(key, value, importance, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, importance=excluded.importance, created_at=excluded.created_at
  `).run(safeKey, safeValue, safeImp, now);

  // Evict if over limit — evict lowest importance + oldest first (MemGPT eviction policy)
  const count = (db.prepare("SELECT COUNT(*) as n FROM working_memory").get() as { n: number }).n;
  if (count > WORKING_MEMORY_MAX) {
    type Row = { key: string; value: string };
    const toEvict = db.prepare(`
      SELECT key, value FROM working_memory
      ORDER BY importance ASC, created_at ASC
      LIMIT ?
    `).all(count - WORKING_MEMORY_EVICT_TO) as Row[];

    for (const row of toEvict) {
      db.prepare("DELETE FROM working_memory WHERE key = ?").run(row.key);
      // Archive evicted fact to KB — it's still findable via zc_search
      indexContent(projectPath, row.value, `memory:${row.key}`);
    }
  }

  db.close();
}

/**
 * MemGPT operation: RECALL working memory.
 * Returns all current working memory facts, ordered by importance (desc).
 */
export function recallWorkingMemory(projectPath: string): MemoryFact[] {
  const db = openDb(projectPath);
  const rows = db.prepare(`
    SELECT key, value, importance, created_at
    FROM working_memory
    ORDER BY importance DESC, created_at DESC
  `).all() as unknown as MemoryFact[];
  db.close();
  return rows;
}

/**
 * MemGPT operation: ARCHIVE SESSION SUMMARY.
 * Stores a high-level summary of the current session into archival memory (KB).
 * Also records it as a high-importance working memory fact for the next session.
 *
 * This is the equivalent of MemGPT's "main context eviction + archival write"
 * but driven by explicit agent action rather than automatic token counting.
 */
export function archiveSessionSummary(projectPath: string, summary: string): void {
  const safeSummary = sanitize(summary, 2000);
  const now = new Date().toISOString();
  const source = `[SESSION_SUMMARY] ${now.slice(0, 10)}`; // date-stamped

  // Write to archival (KB) — searchable across all future sessions
  indexContent(projectPath, safeSummary, source);

  // Also keep as high-importance working memory for the next session start
  rememberFact(projectPath, "last_session_summary", safeSummary, 5);
}

/**
 * MemGPT operation: DELETE from working memory.
 * Removes a specific key. Returns true if the key existed and was deleted.
 * Silently succeeds (returns false) if the key doesn't exist.
 */
export function forgetFact(projectPath: string, key: string): boolean {
  const safeKey = sanitize(key, 100);
  const db = openDb(projectPath);
  const result = db.prepare("DELETE FROM working_memory WHERE key = ?").run(safeKey) as { changes: number };
  db.close();
  return result.changes > 0;
}

/**
 * Format working memory for context injection.
 * Returns a compact, token-efficient representation.
 */
export function formatWorkingMemoryForContext(facts: MemoryFact[]): string {
  if (facts.length === 0) return "Working memory is empty.";
  const lines = facts.map(
    (f) => `[★${f.importance}] ${f.key}: ${f.value}`
  );
  return `## Working Memory (${facts.length} facts)\n${lines.join("\n")}`;
}
