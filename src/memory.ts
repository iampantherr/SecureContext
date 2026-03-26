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
 * AGENT NAMESPACING:
 * When multiple agents run in parallel (e.g., ZeroClaw Conductor pattern),
 * keys are namespaced by agent_id to prevent last-write-wins collisions.
 * Default agent_id is "default" — single-agent use is unchanged.
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
import { join } from "node:path";
import { Config } from "./config.js";
import { runMigrations } from "./migrations.js";
import { indexContent } from "./knowledge.js";

export interface MemoryFact {
  key:        string;
  value:      string;
  importance: number;
  created_at: string;
  agent_id?:  string;
}

// SECURITY: Strip control chars and limit length to prevent log injection / DB bloat
function sanitize(s: string, maxLen: number): string {
  return String(s).replace(/[\r\n\x00\x01-\x08\x0b\x0c\x0e-\x1f]/g, " ").trim().slice(0, maxLen);
}

function dbPath(projectPath: string): string {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(Config.DB_DIR, `${hash}.db`);
}

function openDb(projectPath: string): DatabaseSync {
  mkdirSync(Config.DB_DIR, { recursive: true });
  const db = new DatabaseSync(dbPath(projectPath));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  // Base working_memory table with agent_id support
  db.exec(`
    CREATE TABLE IF NOT EXISTS working_memory (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT    NOT NULL,
      value      TEXT    NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      agent_id   TEXT    NOT NULL DEFAULT 'default',
      created_at TEXT    NOT NULL,
      UNIQUE(key, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wm_evict
      ON working_memory(agent_id, importance ASC, created_at ASC);
  `);

  runMigrations(db);
  return db;
}

/**
 * Ensure agent_id column exists on existing v0.5 databases.
 * Safe to call repeatedly — silently ignored if already present.
 */
function ensureAgentIdColumn(db: DatabaseSync): void {
  try {
    db.exec(`ALTER TABLE working_memory ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'`);
  } catch {}
}

/**
 * MemGPT operation: WRITE to working memory.
 * If the key already exists for this agent, it is updated in place.
 * Triggers eviction to archival if working memory is full.
 *
 * @param agentId  Optional agent namespace for parallel multi-agent use (default: "default")
 */
export function rememberFact(
  projectPath: string,
  key: string,
  value: string,
  importance: number = 3,
  agentId: string = "default"
): void {
  const safeKey   = sanitize(key,     100);
  const safeValue = sanitize(value,   500);
  const safeImp   = Math.max(1, Math.min(5, Math.round(importance)));
  const safeAgent = sanitize(agentId,  64);
  const now       = new Date().toISOString();

  const db = openDb(projectPath);
  ensureAgentIdColumn(db);

  db.prepare(`
    INSERT INTO working_memory(key, value, importance, agent_id, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key, agent_id) DO UPDATE SET
      value      = excluded.value,
      importance = excluded.importance,
      created_at = excluded.created_at
  `).run(safeKey, safeValue, safeImp, safeAgent, now);

  // Evict if over limit — evict lowest importance + oldest first (MemGPT eviction policy)
  const count = (db.prepare(
    "SELECT COUNT(*) as n FROM working_memory WHERE agent_id = ?"
  ).get(safeAgent) as { n: number }).n;

  if (count > Config.WORKING_MEMORY_MAX) {
    type Row = { key: string; value: string };
    const toEvict = db.prepare(`
      SELECT key, value FROM working_memory
      WHERE agent_id = ?
      ORDER BY importance ASC, created_at ASC
      LIMIT ?
    `).all(safeAgent, count - Config.WORKING_MEMORY_EVICT_TO) as Row[];

    for (const row of toEvict) {
      db.prepare("DELETE FROM working_memory WHERE key = ? AND agent_id = ?").run(row.key, safeAgent);
      // Archive evicted fact to KB — still findable via zc_search
      indexContent(projectPath, row.value, `memory:${safeAgent}:${row.key}`);
    }
  }

  db.close();
}

/**
 * MemGPT operation: RECALL working memory.
 * Returns all facts for the given agent, ordered by importance (desc).
 *
 * @param agentId  Defaults to "default" (standard single-agent use)
 */
export function recallWorkingMemory(
  projectPath: string,
  agentId: string = "default"
): MemoryFact[] {
  const db        = openDb(projectPath);
  ensureAgentIdColumn(db);
  const safeAgent = sanitize(agentId, 64);

  const rows = db.prepare(`
    SELECT key, value, importance, agent_id, created_at
    FROM working_memory
    WHERE agent_id = ?
    ORDER BY importance DESC, created_at DESC
  `).all(safeAgent) as unknown as MemoryFact[];

  db.close();
  return rows;
}

/**
 * MemGPT operation: ARCHIVE SESSION SUMMARY.
 * Stored with 'summary' retention tier — kept for 365 days.
 */
export function archiveSessionSummary(projectPath: string, summary: string): void {
  const safeSummary = sanitize(summary, 2000);
  const now         = new Date().toISOString();
  const source      = `[SESSION_SUMMARY] ${now.slice(0, 10)}`;

  // Write to archival KB with summary retention tier (365 days)
  indexContent(projectPath, safeSummary, source, "internal", "summary");

  // Also keep as high-importance working memory for the next session
  rememberFact(projectPath, "last_session_summary", safeSummary, 5);
}

/**
 * MemGPT operation: DELETE from working memory.
 * Returns true if the key existed and was deleted.
 */
export function forgetFact(
  projectPath: string,
  key: string,
  agentId: string = "default"
): boolean {
  const safeKey   = sanitize(key,     100);
  const safeAgent = sanitize(agentId,  64);
  const db        = openDb(projectPath);

  ensureAgentIdColumn(db);

  const result = db.prepare(
    "DELETE FROM working_memory WHERE key = ? AND agent_id = ?"
  ).run(safeKey, safeAgent) as { changes: number };

  db.close();
  return result.changes > 0;
}

/**
 * Format working memory for context injection.
 * Returns a structured, token-efficient representation with priority sections.
 */
export function formatWorkingMemoryForContext(
  facts: MemoryFact[],
  agentId: string = "default"
): string {
  if (facts.length === 0) return "## Working Memory\nEmpty — no facts stored yet.";

  const critical  = facts.filter((f) => f.importance >= 4);
  const normal    = facts.filter((f) => f.importance === 3);
  const ephemeral = facts.filter((f) => f.importance <= 2);

  const lines: string[] = [
    `## Working Memory (${facts.length}/${Config.WORKING_MEMORY_MAX} facts${agentId !== "default" ? ` · agent: ${agentId}` : ""})`,
  ];

  if (critical.length > 0) {
    lines.push("\n**Critical [★4-5]**");
    for (const f of critical) lines.push(`  [★${f.importance}] ${f.key}: ${f.value}`);
  }
  if (normal.length > 0) {
    lines.push("\n**Normal [★3]**");
    for (const f of normal) lines.push(`  [★${f.importance}] ${f.key}: ${f.value}`);
  }
  if (ephemeral.length > 0) {
    lines.push("\n**Ephemeral [★1-2]**");
    for (const f of ephemeral) lines.push(`  [★${f.importance}] ${f.key}: ${f.value}`);
  }

  return lines.join("\n");
}

/** Returns working memory stats for the zc_status tool */
export function getMemoryStats(
  projectPath: string,
  agentId: string = "default"
): { count: number; max: number; criticalCount: number } {
  const db        = openDb(projectPath);
  const safeAgent = sanitize(agentId, 64);

  const count = (db.prepare(
    "SELECT COUNT(*) as n FROM working_memory WHERE agent_id = ?"
  ).get(safeAgent) as { n: number }).n;

  const criticalCount = (db.prepare(
    "SELECT COUNT(*) as n FROM working_memory WHERE agent_id = ? AND importance >= 4"
  ).get(safeAgent) as { n: number }).n;

  db.close();
  return { count, max: Config.WORKING_MEMORY_MAX, criticalCount };
}
