// Uses Node.js 22+ built-in sqlite — no native compilation, no npm package required
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");

export type EventType = "file_write" | "file_edit" | "task_complete" | "error" | "fetch" | "session_ended";

export interface SessionEvent {
  event_type: EventType;
  file_path?: string;
  task_name?: string;
  error_type?: string;
  created_at?: string; // present in JSONL events from hooks
  // SECURITY: No content/output fields — we never store file contents or command output
}

function getEventLogPath(projectPath: string): string {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(DB_DIR, `${hash}.events.jsonl`);
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
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_active TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      file_path TEXT,
      task_name TEXT,
      error_type TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );
  `);

  return db;
}

export function getOrCreateSession(projectPath: string): number {
  const db = openDb(projectPath);
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  const now = new Date().toISOString();

  type Row = { id: number };
  const existing = db.prepare(
    "SELECT id FROM sessions WHERE project_hash = ? AND last_active > ? ORDER BY last_active DESC LIMIT 1"
  ).get(hash, new Date(Date.now() - 86_400_000).toISOString()) as Row | undefined;

  if (existing) {
    db.prepare("UPDATE sessions SET last_active = ? WHERE id = ?").run(now, existing.id);
    db.close();
    return existing.id;
  }

  const result = db.prepare(
    "INSERT INTO sessions(project_hash, created_at, last_active) VALUES (?, ?, ?)"
  ).run(hash, now, now) as { lastInsertRowid: number | bigint };

  db.close();
  return Number(result.lastInsertRowid);
}

export function recordEvent(projectPath: string, event: SessionEvent): void {
  const db = openDb(projectPath);
  const sessionId = getOrCreateSession(projectPath);

  db.prepare(
    `INSERT INTO events(session_id, event_type, file_path, task_name, error_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    event.event_type,
    event.file_path ?? null,
    event.task_name ?? null,
    event.error_type ?? null,
    new Date().toISOString()
  );

  db.close();
}

export function getRecentEvents(projectPath: string, limit = 50): SessionEvent[] {
  // Read from the JSONL event log written by hooks (posttooluse.mjs, stop.mjs).
  // The hooks write minimal metadata events there; this is the source of truth for
  // zc_recall_context(). Falls back to empty if the log doesn't exist yet.
  const logPath = getEventLogPath(projectPath);
  if (!existsSync(logPath)) return [];

  try {
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    // Return the last `limit` events, newest first
    return lines
      .slice(-limit)
      .reverse()
      .map((line) => {
        try { return JSON.parse(line) as SessionEvent; }
        catch { return null; }
      })
      .filter((e): e is SessionEvent => e !== null);
  } catch {
    return [];
  }
}
