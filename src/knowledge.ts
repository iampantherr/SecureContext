// Uses Node.js 22+ built-in sqlite — no native compilation, no npm package required
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");
const MAX_RESULTS = 10;
const STALE_DAYS = 7;

export interface KnowledgeEntry {
  source: string;
  content: string;
  snippet: string;
  rank: number;
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
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge USING fts5(
      source,
      content,
      created_at UNINDEXED,
      tokenize='porter unicode61'
    );
  `);

  // Purge stale entries (older than STALE_DAYS)
  const cutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();
  db.prepare("DELETE FROM knowledge WHERE created_at < ?").run(cutoff);

  return db;
}

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
}

export function searchKnowledge(
  projectPath: string,
  queries: string[]
): KnowledgeEntry[] {
  const db = openDb(projectPath);
  const seen = new Set<string>();
  const results: KnowledgeEntry[] = [];

  for (const query of queries) {
    if (!query.trim()) continue;

    type Row = { source: string; content: string; rank: number };
    const rows = db.prepare(
      `SELECT source, content, rank
       FROM knowledge
       WHERE knowledge MATCH ?
       ORDER BY rank
       LIMIT ?`
    ).all(query, MAX_RESULTS) as Row[];

    for (const row of rows) {
      if (seen.has(row.source)) continue;
      seen.add(row.source);

      const idx = row.content.toLowerCase().indexOf(query.toLowerCase().split(" ")[0]!);
      const start = Math.max(0, idx - 100);
      const snippet = row.content.slice(start, start + 300).trim();

      results.push({
        source: row.source,
        content: row.content,
        snippet: snippet || row.content.slice(0, 300),
        rank: row.rank,
      });
    }
  }

  db.close();
  return results;
}

export function clearKnowledge(projectPath: string): void {
  const db = openDb(projectPath);
  db.prepare("DELETE FROM knowledge").run();
  db.close();
}
