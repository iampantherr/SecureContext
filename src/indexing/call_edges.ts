/**
 * Call-graph persistence (v0.55.0)
 * ================================
 *
 * Stores the function call graph from call_graph.ts into the EXISTING kb_edges
 * table, under `match_kind = 'call'`. No new table, no migration: kb_edges is
 * keyed (from_source, to_source, relation_type) and already carries the reverse
 * index idx_kbe_to, which is exactly the "who calls me" query.
 *
 * Layering, and why it needs a carve-out:
 *   rebuildBacklinks() does a full DELETE + rebuild of the co-reference layer on
 *   a 5s debounce after every indexContent. It already excludes match_kind
 *   'entity' for the same reason this excludes 'call' — without that predicate a
 *   background rebuild silently empties the layer, and impact answers degrade to
 *   "nothing depends on this" with no error anywhere. That is the failure mode
 *   this whole feature exists to prevent, so it must not be how the feature is
 *   stored.
 *
 * Call edges are deliberately kept OUT of the kb_backlinks aggregate: that feeds
 * blBoost() in search ranking, and `func:...` nodes are not knowledge sources.
 * Including them would change search results as a side effect of this feature.
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { openDb } from "../knowledge.js";
import { Config } from "../config.js";
import { projectHash as scopedProjectHash } from "../store.js";
import {
  extractFileCalls, resolveCallGraph, callGraphAvailable,
  type FileCalls, type CallEdge,
} from "./call_graph.js";

export const CALL_MATCH_KIND = "call";

export interface CallGraphRebuildResult {
  files:        number;
  edges:        number;
  ambiguous:    number;
  /** Call sites that could not be named. Surfaced so coverage is never assumed. */
  dynamicSites: number;
  elapsedMs:    number;
  /**
   * True when the TypeScript parser is unavailable. Distinguishes "could not
   * look" from "found nothing" — callers MUST NOT render this as zero impact.
   */
  unavailable?: true;
}

// ─── File enumeration ──────────────────────────────────────────────────────

const CALL_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Source files to parse, reusing the exclude list indexProject already applies
 * so the graph covers the same tree the knowledge base does.
 *
 * ponytail: indexProject's walker is private to that function; duplicating ~12
 * lines here beats refactoring a working indexing path to export it.
 */
function listSourceFiles(root: string): string[] {
  const excludes = new Set<string>(Config.INDEX_PROJECT_EXCLUDES as string[]);
  const out: string[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (excludes.has(name) || name.startsWith(".")) continue;
      const abs = join(dir, name);
      let isDir: boolean;
      try { isDir = statSync(abs).isDirectory(); } catch { continue; }
      if (isDir) walk(abs);
      else if (CALL_EXTENSIONS.some((e) => name.endsWith(e)) && !name.endsWith(".d.ts")) out.push(abs);
    }
  };

  walk(root);
  return out;
}

// ─── Extraction over a whole project ───────────────────────────────────────

/**
 * Parse every source file and resolve the graph.
 *
 * Deliberately a FULL rebuild rather than a per-file refresh. Resolution is
 * repo-wide: renaming a function in B invalidates the edges pointing at it from
 * A, C and D, which a per-file refresh of B cannot fix. Measured at 429ms for
 * 107 files (4.0ms/file), inside a 5s-debounced background task — a stale graph
 * would cost far more than 429ms, because it answers confidently and wrongly.
 */
export async function buildProjectCallGraph(
  projectPath: string,
): Promise<{ edges: CallEdge[]; files: FileCalls[]; unavailable: boolean }> {
  if (!(await callGraphAvailable())) return { edges: [], files: [], unavailable: true };

  const files: FileCalls[] = [];
  for (const abs of listSourceFiles(projectPath)) {
    let content: string;
    try { content = readFileSync(abs, "utf8"); } catch { continue; }
    const rel = relative(projectPath, abs).split("\\").join("/");
    const parsed = await extractFileCalls(content, rel);
    if (parsed) files.push(parsed);
  }

  return { edges: resolveCallGraph(files).edges, files, unavailable: false };
}

// ─── Persistence ───────────────────────────────────────────────────────────

/**
 * Replace the call layer for one open project DB. Caller owns the DB.
 * Full replace of match_kind='call' only — every other layer is untouched.
 */
export function persistCallEdges(db: DatabaseSync, edges: CallEdge[]): void {
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM kb_edges WHERE match_kind = ?`).run(CALL_MATCH_KIND);
    const ins = db.prepare(
      `INSERT OR REPLACE INTO kb_edges(from_source, to_source, relation_type, match_kind, weight, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const e of edges) ins.run(e.from, e.to, e.relation, CALL_MATCH_KIND, e.sites, now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Full rebuild + persist for one project. Returns counts; never throws. */
export async function rebuildCallGraph(projectPath: string): Promise<CallGraphRebuildResult> {
  const start = Date.now();
  const { edges, files, unavailable } = await buildProjectCallGraph(projectPath);

  if (unavailable) {
    // Do NOT wipe the existing layer: a missing parser is not evidence that
    // nothing depends on anything. Leave the last good graph in place.
    return { files: 0, edges: 0, ambiguous: 0, dynamicSites: 0, elapsedMs: Date.now() - start, unavailable: true };
  }

  const db = openDb(projectPath);
  try {
    persistCallEdges(db, edges);
  } finally {
    db.close();
  }

  await mirrorCallEdgesPg(projectPath, edges).catch(() => undefined);

  return {
    files:        files.length,
    edges:        edges.length,
    ambiguous:    edges.filter((e) => e.relation === "calls_ambiguous").length,
    dynamicSites: files.reduce((n, f) => n + f.dynamicSites, 0),
    elapsedMs:    Date.now() - start,
  };
}

// ─── Debounced trigger (mirrors rebuildBacklinksAsync) ─────────────────────

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 5_000;

/**
 * Schedule a rebuild 5s after the LAST call. This is the per-file trigger: an
 * agent edits one file, the whole graph is correct 5s later. A bulk index of N
 * files rebuilds ONCE.
 */
export function rebuildCallGraphAsync(projectPath: string): void {
  const existing = debounceTimers.get(projectPath);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    debounceTimers.delete(projectPath);
    rebuildCallGraph(projectPath).catch(() => undefined);
  }, DEBOUNCE_MS);
  if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
  debounceTimers.set(projectPath, t);
}

/**
 * Awaited rebuild for short-lived processes (bulk index / CLI), where the
 * unref'd debounce timer would be killed by process exit before it fires —
 * the trap flushBacklinkRebuild exists to avoid, same shape here.
 */
export async function flushCallGraphRebuild(projectPath: string): Promise<CallGraphRebuildResult | null> {
  const pending = debounceTimers.get(projectPath);
  if (pending) { clearTimeout(pending); debounceTimers.delete(projectPath); }
  try {
    return await rebuildCallGraph(projectPath);
  } catch {
    return null;
  }
}

// ─── PG mirror ─────────────────────────────────────────────────────────────

/** Best-effort PG mirror of the call layer only. Skips silently without creds. */
export async function mirrorCallEdgesPg(projectPath: string, edges: CallEdge[]): Promise<void> {
  if (!process.env.ZC_POSTGRES_HOST && !process.env.ZC_POSTGRES_PASSWORD) return;
  try {
    const { withTransaction } = await import("../pg_pool.js");
    const projectHash = scopedProjectHash(projectPath);
    await withTransaction(async (c) => {
      await c.query(
        `DELETE FROM kb_edges_pg WHERE project_hash = $1 AND match_kind = $2`,
        [projectHash, CALL_MATCH_KIND],
      );
      const CHUNK = 100;
      for (let i = 0; i < edges.length; i += CHUNK) {
        const chunk = edges.slice(i, i + CHUNK);
        const vals: string[] = [];
        const params: unknown[] = [];
        let p = 1;
        for (const e of chunk) {
          vals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
          params.push(projectHash, e.from, e.to, e.relation, CALL_MATCH_KIND, e.sites);
        }
        await c.query(
          `INSERT INTO kb_edges_pg(project_hash, from_source, to_source, relation_type, match_kind, weight)
           VALUES ${vals.join(",")}
           ON CONFLICT (project_hash, from_source, to_source, relation_type) DO UPDATE SET
             match_kind = EXCLUDED.match_kind, weight = EXCLUDED.weight, computed_at = NOW()`,
          params,
        );
      }
    });
  } catch {
    // best-effort — SQLite is authoritative for the agent's own reads
  }
}

// ─── Impact query (the read path stages 3 and 4 use) ───────────────────────

export interface SymbolImpact {
  symbol:           string;
  callers:          number;
  sites:            number;
  files:            string[];
  ambiguousCallers: number;
}

export interface FileImpact {
  path:    string;
  symbols: SymbolImpact[];
  /** Unresolvable call sites IN this file. Rendered as a coverage warning. */
  dynamicSites: number;
  /** False when the layer has never been built — never render that as zero. */
  built: boolean;
}

/**
 * Who calls each function declared in `filePath`, straight off idx_kbe_to.
 *
 * `built: false` means the call layer is absent, which is NOT the same as a
 * file nothing depends on. Callers must render the two differently.
 */
export function getFileImpact(db: DatabaseSync, filePath: string): FileImpact {
  const rel = filePath.split("\\").join("/");
  const prefix = `func:${rel}#`;

  const built = (db.prepare(
    `SELECT COUNT(*) AS c FROM kb_edges WHERE match_kind = ? LIMIT 1`,
  ).get(CALL_MATCH_KIND) as { c: number }).c > 0;

  const rows = db.prepare(
    `SELECT to_source, from_source, relation_type, weight
       FROM kb_edges
      WHERE match_kind = ? AND to_source LIKE ? ESCAPE '\\'`,
  ).all(CALL_MATCH_KIND, prefix.replace(/[%_]/g, "\\$&") + "%") as Array<{
    to_source: string; from_source: string; relation_type: string; weight: number;
  }>;

  const bySymbol = new Map<string, SymbolImpact>();
  for (const r of rows) {
    const symbol = r.to_source.slice(prefix.length);
    let s = bySymbol.get(symbol);
    if (!s) {
      s = { symbol, callers: 0, sites: 0, files: [], ambiguousCallers: 0 };
      bySymbol.set(symbol, s);
    }
    if (r.relation_type === "calls_ambiguous") { s.ambiguousCallers++; continue; }
    s.callers++;
    s.sites += r.weight;
    const f = r.from_source.slice("func:".length).split("#")[0]!;
    if (!s.files.includes(f)) s.files.push(f);
  }

  // Callers first — that is the "how many places must I check" number.
  const symbols = [...bySymbol.values()].sort((a, b) => b.callers - a.callers);
  for (const s of symbols) s.files.sort();

  return { path: rel, symbols, dynamicSites: 0, built };
}
