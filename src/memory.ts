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

// ─────────────────────────────────────────────────────────────────────────────
// A2A SHARED BROADCAST CHANNEL (Phase 2)
//
// Architecture (Chin & Older 2011 access control principles):
//
//   BIBA INTEGRITY:    No-write-up — worker agents cannot push to the shared
//                      channel without the channel key (a capability token).
//                      Orchestrators hold the key; workers do not.
//
//   BELL-LA PADULA:    No-read-up — private working_memory facts are invisible
//                      to other agents. Broadcasts are explicitly public.
//
//   REFERENCE MONITOR: broadcastFact() is the single enforcement point. Every
//                      shared write goes through key verification here.
//
//   LEAST PRIVILEGE:   Default visibility = private (working_memory only).
//                      Shared broadcast requires explicit channel_key capability.
//
//   NON-TRANSITIVE DELEGATION: Workers can READ broadcasts but cannot
//                      re-broadcast as orchestrator (key is never returned to
//                      caller; comparison is hash-constant-time only).
//
// Channel key stored as SHA256 hash in project_meta.
// Comparison is always timing-safe (timingSafeEqual) to prevent oracle attacks.
// ─────────────────────────────────────────────────────────────────────────────

import { timingSafeEqual } from "node:crypto";

// Valid broadcast types — drives CHECK constraint in DB schema too
export type BroadcastType =
  | "ASSIGN"      // orchestrator assigns a task to an agent
  | "STATUS"      // agent reports current work state
  | "PROPOSED"    // agent proposes file changes pending review
  | "DEPENDENCY"  // agent declares it depends on another agent's output
  | "MERGE"       // orchestrator approves and merges proposed changes
  | "REJECT"      // orchestrator rejects proposed changes
  | "REVISE";     // orchestrator requests revision of proposed changes

export interface BroadcastMessage {
  id:         number;
  type:       BroadcastType;
  agent_id:   string;
  task:       string;
  files:      string[];  // parsed JSON array of affected file paths
  state:      string;
  summary:    string;
  depends_on: string[];  // parsed JSON array of agent_ids this depends on
  reason:     string;
  importance: number;
  created_at: string;
}

export interface BroadcastResult {
  id:         number;
  type:       BroadcastType;
  agent_id:   string;
  task:       string;
  files:      string[];
  state:      string;
  summary:    string;
  depends_on: string[];
  reason:     string;
  importance: number;
  created_at: string;
}

/** SECURITY: Constant-time string comparison to prevent timing oracle attacks */
function secureCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/** Compute SHA256 hash of a channel key for storage */
function hashChannelKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * CHANNEL KEY MANAGEMENT — Capability-based access control
 *
 * The channel key is a shared secret that grants broadcast rights.
 * Stored as SHA256 hash in project_meta — raw key never persisted.
 * Only agents holding the plaintext key can write to the shared channel.
 */

export function setChannelKey(projectPath: string, plainKey: string): void {
  const safeKey = sanitize(plainKey, 256);
  if (safeKey.length < 8) throw new Error("Channel key must be at least 8 characters");
  const hashed = hashChannelKey(safeKey);
  const db     = openDb(projectPath);
  db.prepare(
    "INSERT OR REPLACE INTO project_meta(key, value) VALUES ('zc_channel_key_hash', ?)"
  ).run(hashed);
  db.close();
}

export function isChannelKeyConfigured(projectPath: string): boolean {
  const db  = openDb(projectPath);
  const row = db.prepare(
    "SELECT value FROM project_meta WHERE key = 'zc_channel_key_hash'"
  ).get() as { value: string } | undefined;
  db.close();
  return row !== undefined && row.value.length > 0;
}

/** Verify a plaintext key against the stored hash. Internal helper — never export the hash. */
function verifyChannelKey(db: ReturnType<typeof openDb>, plainKey: string): boolean {
  const row = db.prepare(
    "SELECT value FROM project_meta WHERE key = 'zc_channel_key_hash'"
  ).get() as { value: string } | undefined;
  if (!row) return true; // OPEN MODE: no key configured — allow all writes
  const hashed = hashChannelKey(sanitize(plainKey, 256));
  return secureCompare(hashed, row.value);
}

/**
 * A2A BROADCAST — Write to the shared coordination channel.
 *
 * SECURITY:
 * - If a channel key is configured, caller must supply the correct key.
 * - Key comparison is SHA256 + timing-safe (no oracle).
 * - files and depends_on are JSON-serialised arrays; sanitized individually.
 * - All string fields sanitized and length-capped before DB write.
 * - append-only: no UPDATE path — audit trail is immutable.
 */
export function broadcastFact(
  projectPath: string,
  type:       BroadcastType,
  agentId:    string,
  opts: {
    task?:       string;
    files?:      string[];
    state?:      string;
    summary?:    string;
    depends_on?: string[];
    reason?:     string;
    importance?: number;
    channel_key?: string;
  } = {}
): BroadcastResult {
  const safeAgent = sanitize(agentId, 64);
  const safeTask  = sanitize(opts.task ?? "", 500);
  const safeState = sanitize(opts.state ?? "", 100);
  const safeSummary = sanitize(opts.summary ?? "", 1000);
  const safeReason  = sanitize(opts.reason ?? "", 500);
  const safeImp     = Math.max(1, Math.min(5, Math.round(opts.importance ?? 3)));
  const safeFiles   = JSON.stringify(
    (opts.files ?? []).map((f) => sanitize(f, 500)).slice(0, 50)
  );
  const safeDepends = JSON.stringify(
    (opts.depends_on ?? []).map((d) => sanitize(d, 64)).slice(0, 20)
  );
  const now = new Date().toISOString();

  const db = openDb(projectPath);

  // REFERENCE MONITOR: enforce channel key before any write
  if (!verifyChannelKey(db, opts.channel_key ?? "")) {
    db.close();
    throw new Error("Broadcast rejected: invalid or missing channel key");
  }

  const result = db.prepare(`
    INSERT INTO broadcasts(type, agent_id, task, files, state, summary, depends_on, reason, importance, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(type, safeAgent, safeTask, safeFiles, safeState, safeSummary, safeDepends, safeReason, safeImp, now) as {
    lastInsertRowid: number;
  };

  const id = Number(result.lastInsertRowid);
  db.close();

  return {
    id,
    type,
    agent_id:   safeAgent,
    task:       safeTask,
    files:      opts.files ?? [],
    state:      safeState,
    summary:    safeSummary,
    depends_on: opts.depends_on ?? [],
    reason:     safeReason,
    importance: safeImp,
    created_at: now,
  };
}

/**
 * Recall recent broadcasts from the shared channel.
 * Returns most-recent first. Optional type filter.
 */
export function recallSharedChannel(
  projectPath: string,
  opts: { limit?: number; type?: BroadcastType } = {}
): BroadcastMessage[] {
  const db    = openDb(projectPath);
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

  type RawRow = {
    id: number; type: string; agent_id: string; task: string;
    files: string; state: string; summary: string; depends_on: string;
    reason: string; importance: number; created_at: string;
  };

  let rows: RawRow[];
  if (opts.type) {
    rows = db.prepare(`
      SELECT id, type, agent_id, task, files, state, summary, depends_on, reason, importance, created_at
      FROM broadcasts WHERE type = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(opts.type, limit) as RawRow[];
  } else {
    rows = db.prepare(`
      SELECT id, type, agent_id, task, files, state, summary, depends_on, reason, importance, created_at
      FROM broadcasts
      ORDER BY created_at DESC LIMIT ?
    `).all(limit) as RawRow[];
  }

  db.close();

  return rows.map((r) => ({
    id:         r.id,
    type:       r.type as BroadcastType,
    agent_id:   r.agent_id,
    task:       r.task,
    files:      tryParseJsonArray(r.files),
    state:      r.state,
    summary:    r.summary,
    depends_on: tryParseJsonArray(r.depends_on),
    reason:     r.reason,
    importance: r.importance,
    created_at: r.created_at,
  }));
}

/** Safe JSON array parse — returns [] on any error */
function tryParseJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Format the shared broadcast channel for context injection.
 * Groups by type for quick scanning. Most-recent at the top.
 */
export function formatSharedChannelForContext(
  broadcasts: BroadcastMessage[]
): string {
  if (broadcasts.length === 0) {
    return "## Shared Channel\nEmpty — no broadcasts yet.";
  }

  // Group by type in a defined display order
  const ORDER: BroadcastType[] = [
    "ASSIGN", "MERGE", "REJECT", "REVISE",
    "PROPOSED", "DEPENDENCY", "STATUS",
  ];

  const grouped = new Map<BroadcastType, BroadcastMessage[]>();
  for (const type of ORDER) grouped.set(type, []);
  for (const msg of broadcasts) {
    const bucket = grouped.get(msg.type);
    if (bucket) bucket.push(msg);
  }

  const lines: string[] = [
    `## Shared Channel (${broadcasts.length} broadcasts)`,
  ];

  for (const type of ORDER) {
    const msgs = grouped.get(type) ?? [];
    if (msgs.length === 0) continue;

    lines.push(`\n**${type}** (${msgs.length})`);
    for (const m of msgs) {
      const fileStr   = m.files.length   > 0 ? ` files=[${m.files.join(", ")}]`   : "";
      const depStr    = m.depends_on.length > 0 ? ` depends_on=[${m.depends_on.join(", ")}]` : "";
      const reasonStr = m.reason ? ` reason="${m.reason}"` : "";
      const taskStr   = m.task ? ` task="${m.task}"` : "";
      lines.push(
        `  [#${m.id}] ${m.agent_id}${taskStr}${fileStr}${depStr}${reasonStr}` +
        (m.summary ? `\n    → ${m.summary}` : "") +
        `  (${m.created_at.slice(0, 16)})`
      );
    }
  }

  return lines.join("\n");
}
