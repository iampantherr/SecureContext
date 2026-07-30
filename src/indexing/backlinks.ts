/**
 * Persistent knowledge-graph backlinks (Tier-1 A)
 * ================================================
 *
 * Turns the (previously transient) co-reference graph into a PERSISTENT, directed,
 * typed edge set + a materialized in-degree aggregate that the search ranker reads
 * on the hot path. This is what lets a highly-referenced "hub" source rank higher
 * (gbrain-style backlink boost) without any agent changing how it calls zc_search.
 *
 *   kb_edges     — directed `from → to` ("from's content mentions to"), typed + weighted
 *   kb_backlinks — per-source in-degree (distinct inbound) + weighted_in (Σ weight)
 *
 * The extraction is the SAME zero-LLM engine the community detector uses
 * (extractCoReferences in community.ts) — no second scanner, no LLM cost.
 *
 * Triggers (see knowledge.ts + server.ts):
 *   - fire-and-forget + 5s debounce after indexContent (so a 500-file bulk index
 *     rebuilds ONCE, never O(N²))
 *   - batch-authoritative inside zc_kb_cluster / zc_graph_rebuild
 *
 * PG parity (operator's feedback_pg_first_storage rule): every rebuild mirrors to
 * kb_edges_pg / kb_backlinks_pg, project_hash-scoped, best-effort fire-and-forget.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { openDb } from "../knowledge.js";
import { extractCoReferences, classifyRelation } from "./community.js";
import { projectHash as scopedProjectHash } from "../store.js";

interface TypedEdge {
  from:      string;
  to:        string;
  relation:  string;
  matchKind: "full_key" | "basename";
  weight:    number;
}

export interface BacklinkRebuildResult {
  edges:      number;
  nodes:      number;
  topHub:     { source: string; weightedIn: number } | null;
  elapsedMs:  number;
  /** The typed edges just persisted — handed to the PG mirror to avoid re-extraction. */
  typedEdges: TypedEdge[];
}

/** DDL kept here too (belt-and-suspenders with migration 30) so a pre-migration DB still works. */
function ensureTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_edges (
      from_source   TEXT    NOT NULL,
      to_source     TEXT    NOT NULL,
      relation_type TEXT    NOT NULL DEFAULT 'code_ref',
      match_kind    TEXT    NOT NULL DEFAULT 'full_key',
      weight        INTEGER NOT NULL DEFAULT 1,
      computed_at   TEXT    NOT NULL,
      PRIMARY KEY (from_source, to_source, relation_type)
    );
    CREATE INDEX IF NOT EXISTS idx_kbe_to   ON kb_edges(to_source);
    CREATE INDEX IF NOT EXISTS idx_kbe_from ON kb_edges(from_source);
    CREATE TABLE IF NOT EXISTS kb_backlinks (
      source       TEXT    PRIMARY KEY,
      in_degree    INTEGER NOT NULL DEFAULT 0,
      weighted_in  INTEGER NOT NULL DEFAULT 0,
      computed_at  TEXT    NOT NULL
    );
  `);
}

/**
 * Full DELETE + rebuild of kb_edges + kb_backlinks for one open project DB.
 * Idempotent and orphan-free (full replace, like storeCommunities). Caller owns the DB.
 */
export function rebuildBacklinks(db: DatabaseSync): BacklinkRebuildResult {
  const start = Date.now();
  type Row = { source: string; content: string };
  const rows = db.prepare("SELECT source, content FROM knowledge").all() as Row[];

  // v0.36.0 — memory-aware extraction: LIVE working-memory facts join the scan as
  // pseudo-sources ("memory:<agent>:<key>", the same naming eviction-archival uses, so
  // edges survive a fact's eviction unchanged). A research note whose value mentions
  // "session.ts" now creates a memory→file edge — the file gains graph structure AND
  // backlink search boost from what the agent's memory talks about.
  try {
    const wm = db.prepare(
      "SELECT ('memory:' || agent_id || ':' || key) AS source, value AS content FROM working_memory WHERE valid_to IS NULL ORDER BY importance DESC LIMIT 500"
    ).all() as Row[];
    for (const r of wm) rows.push(r);
  } catch { /* working_memory absent on a KB-only DB */ }

  const typed: TypedEdge[] = extractCoReferences(rows).map((e) => ({
    from:      e.from,
    to:        e.to,
    relation:  classifyRelation(e.from, e.to, e.matchKind),
    matchKind: e.matchKind,
    weight:    e.weight,
  }));

  const now = new Date().toISOString();
  ensureTables(db);

  db.exec("BEGIN");
  try {
    // v0.37.0 — LLM-extracted entity edges (match_kind='entity') are a separate, budgeted
    // layer maintained by the entity extractor; the co-reference rebuild must not wipe them.
    db.exec("DELETE FROM kb_edges WHERE match_kind <> 'entity'");
    db.exec("DELETE FROM kb_backlinks");
    const ins = db.prepare(
      `INSERT OR REPLACE INTO kb_edges(from_source, to_source, relation_type, match_kind, weight, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const e of typed) ins.run(e.from, e.to, e.relation, e.matchKind, e.weight, now);
    db.prepare(
      `INSERT INTO kb_backlinks(source, in_degree, weighted_in, computed_at)
       SELECT to_source, COUNT(DISTINCT from_source), SUM(weight), ?
       FROM kb_edges GROUP BY to_source`
    ).run(now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  const hub = db.prepare(
    "SELECT source, weighted_in FROM kb_backlinks ORDER BY weighted_in DESC LIMIT 1"
  ).get() as { source: string; weighted_in: number } | undefined;

  return {
    edges:      typed.length,
    nodes:      rows.length,
    topHub:     hub ? { source: hub.source, weightedIn: hub.weighted_in } : null,
    elapsedMs:  Date.now() - start,
    typedEdges: typed,
  };
}

// ─── Debounced fire-and-forget rebuild (mirrors storeEmbeddingAsync) ────────

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 5_000;

/**
 * Schedule a backlink rebuild for a project, 5s after the LAST call (trailing
 * debounce). A bulk index of N files therefore triggers exactly ONE rebuild after
 * it settles — never N rebuilds, never O(N²). Never blocks the caller; never holds
 * the process open (timer is unref'd).
 */
export function rebuildBacklinksAsync(projectPath: string): void {
  const existing = debounceTimers.get(projectPath);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    debounceTimers.delete(projectPath);
    try {
      const db = openDb(projectPath);
      let result: BacklinkRebuildResult;
      try {
        result = rebuildBacklinks(db);
      } finally {
        db.close();
      }
      // PG mirror — fire-and-forget, reuses the freshly built edges (no re-extraction).
      rebuildBacklinksPgAsync(projectPath, result.typedEdges).catch(() => undefined);
    } catch {
      // best-effort background work — search degrades to baseScore if this never runs
    }
  }, DEBOUNCE_MS);
  if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
  debounceTimers.set(projectPath, t);
}

/**
 * Synchronous, AWAITED rebuild for the SHORT-LIVED bulk-index path
 * (background-index.mjs / indexProject). The debounced rebuildBacklinksAsync
 * relies on an unref'd 5s timer that `process.exit()` kills before it fires — so
 * a bulk index would otherwise leave kb_edges/kb_backlinks EMPTY and the
 * W_BACKLINK boost permanently dormant for every auto-onboarded project (the
 * "generated-but-not-used" trap). This runs the rebuild inline and AWAITS the PG
 * mirror so both stores are populated before the caller — and the process — can
 * exit. Cancels any pending debounce first so we never double-rebuild. Returns
 * the result (or null on any error — never breaks indexing).
 */
export async function flushBacklinkRebuild(projectPath: string): Promise<BacklinkRebuildResult | null> {
  const pending = debounceTimers.get(projectPath);
  if (pending) { clearTimeout(pending); debounceTimers.delete(projectPath); }
  try {
    const db = openDb(projectPath);
    let result: BacklinkRebuildResult;
    try {
      result = rebuildBacklinks(db);
    } finally {
      db.close();
    }
    await rebuildBacklinksPgAsync(projectPath, result.typedEdges);
    return result;
  } catch {
    return null; // best-effort — a backlink-rebuild failure must never fail the index
  }
}

/**
 * Best-effort PG mirror of the project's backlink graph. Same fire-and-forget shape
 * as storeSourceMetaPgAsync: skips silently with no PG creds; full replace inside a
 * transaction so PG never drifts from SQLite. Edges are chunked to bound round-trips.
 */
export async function rebuildBacklinksPgAsync(projectPath: string, edges: TypedEdge[]): Promise<void> {
  if (!process.env.ZC_POSTGRES_HOST && !process.env.ZC_POSTGRES_PASSWORD) return;
  try {
    const { withTransaction } = await import("../pg_pool.js");
    const projectHash = scopedProjectHash(projectPath);
    await withTransaction(async (c) => {
      await c.query(`DELETE FROM kb_edges_pg     WHERE project_hash = $1`, [projectHash]);
      await c.query(`DELETE FROM kb_backlinks_pg WHERE project_hash = $1`, [projectHash]);

      const CHUNK = 100;
      for (let i = 0; i < edges.length; i += CHUNK) {
        const chunk = edges.slice(i, i + CHUNK);
        const vals: string[] = [];
        const params: unknown[] = [];
        let p = 1;
        for (const e of chunk) {
          vals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
          params.push(projectHash, e.from, e.to, e.relation, e.matchKind, e.weight);
        }
        await c.query(
          `INSERT INTO kb_edges_pg(project_hash, from_source, to_source, relation_type, match_kind, weight)
           VALUES ${vals.join(",")}
           ON CONFLICT (project_hash, from_source, to_source, relation_type) DO UPDATE SET
             match_kind = EXCLUDED.match_kind, weight = EXCLUDED.weight, computed_at = NOW()`,
          params,
        );
      }

      await c.query(
        `INSERT INTO kb_backlinks_pg(project_hash, source, in_degree, weighted_in)
         SELECT $1, to_source, COUNT(DISTINCT from_source), SUM(weight)
         FROM kb_edges_pg WHERE project_hash = $1 GROUP BY to_source
         ON CONFLICT (project_hash, source) DO UPDATE SET
           in_degree = EXCLUDED.in_degree, weighted_in = EXCLUDED.weighted_in, computed_at = NOW()`,
        [projectHash],
      );
    });
  } catch {
    // best-effort — SQLite is authoritative for the agent's own reads
  }
}
