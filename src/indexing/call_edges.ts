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
import { makeDebounced } from "./debounce.js";
import {
  extractFileCalls, resolveCallGraph, callGraphAvailable,
  type FileCalls, type CallEdge,
} from "./call_graph.js";

export const CALL_MATCH_KIND = "call";

/**
 * Per-file count of call sites that could not be named at all (`handlers[t]()`).
 * Stored as an edge to a sentinel node so no schema change is needed, and so the
 * coverage number travels with the graph instead of being recomputed — or, as it
 * was in the first cut of this file, hardcoded to 0 and quietly wrong.
 */
export const UNRESOLVED_RELATION = "unresolved_calls";
const unresolvedNode = (path: string): string => `unresolved:${path}`;

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

// v0.56.0 — .py included: extraction goes through py_call_graph (Python ast).
const CALL_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];

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
  const pyPaths: string[] = [];
  for (const abs of listSourceFiles(projectPath)) {
    if (abs.endsWith(".py")) { pyPaths.push(abs); continue; }
    let content: string;
    try { content = readFileSync(abs, "utf8"); } catch { continue; }
    const rel = relative(projectPath, abs).split("\\").join("/");
    const parsed = await extractFileCalls(content, rel);
    if (parsed) files.push(parsed);
  }

  // v0.56.0 — Python files, one batch subprocess for the whole repo. If python
  // is absent the batch reports errors rather than silently contributing zero
  // edges; the TS side of the graph is unaffected either way.
  if (pyPaths.length > 0) {
    const { extractPythonBatch } = await import("./py_call_graph.js");
    const rel = (abs: string) => relative(projectPath, abs).split("\\").join("/");
    const py = extractPythonBatch(pyPaths, rel);
    files.push(...py.files);
  }

  return { edges: resolveCallGraph(files).edges, files, unavailable: false };
}

// ─── Persistence ───────────────────────────────────────────────────────────

/**
 * Replace the call layer for one open project DB. Caller owns the DB.
 * Full replace of match_kind='call' only — every other layer is untouched.
 */
export function persistCallEdges(
  db: DatabaseSync,
  edges: CallEdge[],
  unresolvedByFile?: Map<string, number>,
): void {
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM kb_edges WHERE match_kind = ?`).run(CALL_MATCH_KIND);
    const ins = db.prepare(
      `INSERT OR REPLACE INTO kb_edges(from_source, to_source, relation_type, match_kind, weight, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const e of edges) ins.run(e.from, e.to, e.relation, CALL_MATCH_KIND, e.sites, now);
    for (const [path, count] of unresolvedByFile ?? []) {
      if (count > 0) {
        ins.run(`file:${path}`, unresolvedNode(path), UNRESOLVED_RELATION, CALL_MATCH_KIND, count, now);
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Full rebuild + persist for one project. Returns counts; never throws. */
export async function rebuildCallGraph(projectPath: string): Promise<CallGraphRebuildResult> {
  const start = Date.now();
  const { edges: baseEdges, files, unavailable } = await buildProjectCallGraph(projectPath);
  const edges = [...baseEdges];

  if (unavailable) {
    // Do NOT wipe the existing layer: a missing parser is not evidence that
    // nothing depends on anything. Leave the last good graph in place.
    return { files: 0, edges: 0, ambiguous: 0, dynamicSites: 0, elapsedMs: Date.now() - start, unavailable: true };
  }

  const unresolved = new Map<string, number>();
  for (const f of files) if (f.dynamicSites > 0) unresolved.set(f.path, f.dynamicSites);

  // Cross-repo consumers, opt-in (ZC_CROSS_REPO_SCAN=1 or ZC_CROSS_REPO_ROOTS).
  // Stored in THIS project's layer because the provider is who needs the warning
  // before changing a route another repository calls.
  let crossRepo: CallEdge[] = [];
  try {
    const { discoverConsumerRoots, buildCrossRepoEdges } = await import("./cross_repo.js");
    const consumers = discoverConsumerRoots(projectPath);
    if (consumers.length > 0) {
      crossRepo = (await buildCrossRepoEdges(projectPath, consumers)).edges;
    }
  } catch { /* never fail a rebuild on the cross-repo pass */ }
  edges.push(...crossRepo);

  const db = openDb(projectPath);
  try {
    persistCallEdges(db, edges, unresolved);
  } finally {
    db.close();
  }

  // Mirror the unresolved sentinels too. They were written to SQLite only, so
  // the operator dashboard read 0 unresolved sites from Postgres and claimed
  // complete coverage for a graph with 649 unfollowed dynamic calls — a
  // fabricated zero on the one field whose entire job is admitting what is
  // missing.
  await mirrorCallEdgesPg(projectPath, edges, unresolved).catch(() => undefined);

  return {
    files:        files.length,
    edges:        edges.length,
    ambiguous:    edges.filter((e) => e.relation === "calls_ambiguous").length,
    dynamicSites: files.reduce((n, f) => n + f.dynamicSites, 0),
    elapsedMs:    Date.now() - start,
  };
}

// ─── Debounced trigger (mirrors rebuildBacklinksAsync) ─────────────────────

const DEBOUNCE_MS = 5_000;
const debouncedCallGraph = makeDebounced((projectPath) => {
  rebuildCallGraph(projectPath).catch(() => undefined);
}, DEBOUNCE_MS);

/**
 * Schedule a rebuild 5s after the LAST call. This is the per-file trigger: an
 * agent edits one file, the whole graph is correct 5s later. A bulk index of N
 * files rebuilds ONCE.
 */
export function rebuildCallGraphAsync(projectPath: string): void {
  debouncedCallGraph.run(projectPath);
}

/**
 * Awaited rebuild for short-lived processes (bulk index / CLI), where the
 * unref'd debounce timer would be killed by process exit before it fires —
 * the trap flushBacklinkRebuild exists to avoid, same shape here.
 */
export async function flushCallGraphRebuild(projectPath: string): Promise<CallGraphRebuildResult | null> {
  debouncedCallGraph.cancel(projectPath);
  try {
    return await rebuildCallGraph(projectPath);
  } catch {
    return null;
  }
}

// ─── PG mirror ─────────────────────────────────────────────────────────────

/** Best-effort PG mirror of the call layer only. Skips silently without creds. */
export async function mirrorCallEdgesPg(
  projectPath: string,
  edges: CallEdge[],
  unresolvedByFile?: Map<string, number>,
): Promise<void> {
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

      // Coverage sentinels. Without these the dashboard reads 0 unresolved sites
      // from Postgres and reports complete coverage for a graph that could not
      // follow hundreds of dynamic calls.
      for (const [path, count] of unresolvedByFile ?? []) {
        if (count <= 0) continue;
        await c.query(
          `INSERT INTO kb_edges_pg(project_hash, from_source, to_source, relation_type, match_kind, weight)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (project_hash, from_source, to_source, relation_type) DO UPDATE SET
             weight = EXCLUDED.weight, computed_at = NOW()`,
          [projectHash, `file:${path}`, unresolvedNode(path), UNRESOLVED_RELATION, CALL_MATCH_KIND, count],
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

  // Two node kinds live in a file: functions it declares (func:) and HTTP routes
  // it registers (route:). A route is the cross-repo coupling point, so omitting
  // it here would hide exactly the dependency the graph was extended to find.
  const esc = (s: string) => s.replace(/[%_]/g, "\\$&") + "%";
  const rows = db.prepare(
    `SELECT to_source, from_source, relation_type, weight
       FROM kb_edges
      WHERE match_kind = ? AND relation_type <> ?
        AND (to_source LIKE ? ESCAPE '\\' OR to_source LIKE ? ESCAPE '\\')`,
  ).all(
    CALL_MATCH_KIND, UNRESOLVED_RELATION,
    esc(prefix), esc(`route:${rel}#`),
  ) as Array<{
    to_source: string; from_source: string; relation_type: string; weight: number;
  }>;

  // Real count of unnameable call sites in this file, not an assumed zero.
  const unresolvedRow = db.prepare(
    `SELECT weight FROM kb_edges WHERE match_kind = ? AND relation_type = ? AND to_source = ?`,
  ).get(CALL_MATCH_KIND, UNRESOLVED_RELATION, unresolvedNode(rel)) as { weight: number } | undefined;

  const bySymbol = new Map<string, SymbolImpact>();
  for (const r of rows) {
    // "func:src/x.ts#foo" -> "foo";  "route:src/x.ts#GET /api/v1/y" -> "GET /api/v1/y"
    const symbol = r.to_source.slice(r.to_source.indexOf("#") + 1);
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

  return { path: rel, symbols, dynamicSites: unresolvedRow?.weight ?? 0, built };
}

/**
 * Fan-in threshold for the HIGH marker. From the measured distribution over this
 * repo: a handful of genuine hubs at 20-126 and a long tail under 10, so 10
 * flags about a dozen symbols rather than hundreds.
 */
export const HIGH_FAN_IN = 10;

/**
 * Render an impact result for an agent.
 *
 * ONE renderer, used by the MCP local handler, the MCP remote handler and the
 * PreRead hook. Three copies is how the `warning` field silently went missing
 * from three MCP tools and had to be fixed three times.
 */
export function renderImpact(
  result: { targets: Array<{ symbol: string; declaredIn: string; callers: number; sites: number; files: string[]; ambiguous: number }>; dynamicSites: number; built: boolean },
  query: { file?: string; symbol?: string },
  opts: {
    /** Omit symbols below this caller count from the list. Default 1. */
    minCallers?: number;
    /** Cap the listed symbols. Default 25. The remainder is counted, never dropped silently. */
    limit?: number;
    /**
     * Only symbols called from a DIFFERENT file. For the pre-edit case that is
     * the whole question — a function used only inside its own file is visible
     * in the file you are already looking at, while a cross-file caller is
     * exactly what you cannot see and are about to break.
     */
    crossFileOnly?: boolean;
  } = {},
): string {
  const subject = query.file ?? query.symbol ?? "(unknown)";
  const minCallers = opts.minCallers ?? 1;
  const limit = opts.limit ?? 25;

  if (!result.built) {
    return `## Impact — ${subject}\n\n` +
      `The call graph has NOT been built for this project, so this is not an answer of ` +
      `"nothing depends on it" — it is "unknown". Index the project (zc_index_project) or ` +
      `run zc_graph_rebuild, then ask again.`;
  }

  const lines: string[] = [`## Impact — what depends on ${subject}`];

  // A symbol reached only by name-only matches would otherwise render as
  // "← 0 callers in 0 files", which reads like a finding and is just noise.
  // Counted below instead of listed, so nothing is silently dropped.
  const nameOnly = result.targets.filter((t) => t.callers < minCallers && t.ambiguous > 0).length;
  const isCrossFile = (t: { declaredIn: string; files: string[] }): boolean =>
    t.files.some((f) => f !== (query.file ?? t.declaredIn));
  const shown = result.targets
    .filter((t) => t.callers >= minCallers)
    .filter((t) => !opts.crossFileOnly || isCrossFile(t));
  const localOnly = opts.crossFileOnly
    ? result.targets.filter((t) => t.callers >= minCallers && !isCrossFile(t)).length
    : 0;
  const truncated = Math.max(0, shown.length - limit);

  if (shown.length === 0) {
    lines.push(``);
    lines.push(
      query.symbol
        ? `No static callers found for '${query.symbol}'. That is not the same as safe to change: `
        : opts.crossFileOnly && localOnly > 0
          ? `Nothing here is called from another file (${localOnly} ${localOnly === 1 ? "symbol is" : "symbols are"} ` +
            `used only within it). That is not the same as safe to change: `
          : `No functions declared here have static callers. That is not the same as safe to change: `);
    lines.push(`dynamic dispatch, callbacks and string-keyed routing are invisible to static ` +
               `extraction, and cross-repo callers are not counted at all.`);
  } else {
    lines.push(``);
    for (const t of shown.slice(0, limit)) {
      const high = t.callers >= HIGH_FAN_IN ? "   ⚠ HIGH FAN-IN" : "";
      const where = query.symbol ? `  [declared in ${t.declaredIn}]` : "";
      // An HTTP route is not a function; "GET /api/v1/x()" reads like a bug.
      const isRoute = /^[A-Z]+ \//.test(t.symbol);
      const label = isRoute ? t.symbol : `${t.symbol}()`;
      // A caller path carrying a repo prefix comes from ANOTHER repository —
      // the coupling static analysis usually cannot see, and the one most worth
      // flagging before an edit.
      const external = t.files.some((f) => !f.startsWith("src/") && f.includes("/") && /^[A-Za-z0-9_]+\//.test(f)
                                            && !f.startsWith("scripts/") && !f.startsWith("hooks/")
                                            && !f.startsWith("security-tests/") && !f.startsWith("bench/"));
      const cross = external ? "   ⚠ CROSS-REPO CONSUMER" : "";
      lines.push(
        `  ${label}${where}  ← ${t.callers} caller${t.callers === 1 ? "" : "s"} ` +
        `in ${t.files.length} file${t.files.length === 1 ? "" : "s"} (${t.sites} call site${t.sites === 1 ? "" : "s"})${high}${cross}`,
      );
      if (t.files.length > 0) {
        const shown = t.files.slice(0, 6).join(", ");
        lines.push(`      ${shown}${t.files.length > 6 ? `, +${t.files.length - 6} more` : ""}`);
      }
      if (t.ambiguous > 0) {
        lines.push(`      (${t.ambiguous} further reference${t.ambiguous === 1 ? "" : "s"} matched by name only ` +
                   `and are NOT counted — same-named functions or a common method name)`);
      }
    }
  }

  if (truncated > 0) {
    lines.push(`      … and ${truncated} more symbol${truncated === 1 ? "" : "s"} with callers (not shown)`);
  }
  if (localOnly > 0) {
    lines.push(`  (${localOnly} more ${localOnly === 1 ? "symbol is" : "symbols are"} called only within this file)`);
  }
  if (nameOnly > 0) {
    lines.push(``);
    lines.push(`  ${nameOnly} further symbol${nameOnly === 1 ? " is" : "s are"} referenced by name only ` +
               `and could not be attributed confidently.`);
  }

  // Coverage is mandatory, not decorative: an impact answer that hides what it
  // could not see is how a confident wrong number gets believed.
  if (result.dynamicSites > 0) {
    lines.push(``);
    lines.push(`  ⚠ ${result.dynamicSites} call site${result.dynamicSites === 1 ? "" : "s"} in this file ` +
               `could not be resolved statically (dynamic dispatch / computed callee). Coverage is incomplete.`);
  }

  return lines.join("\n");
}

/**
 * Fan-in for one symbol name across the whole project — the deliberate-lookup
 * path behind zc_impact, as opposed to the by-file path the PreRead hook uses.
 *
 * Returns one entry per declaring file, because a name declared twice is two
 * different functions and collapsing them would be the same mistake the
 * resolver already refuses to make.
 */
export function getSymbolImpact(
  db: DatabaseSync,
  symbol: string,
): Array<SymbolImpact & { declaredIn: string }> {
  const rows = db.prepare(
    `SELECT to_source, from_source, relation_type, weight
       FROM kb_edges
      WHERE match_kind = ? AND relation_type <> ? AND to_source LIKE ? ESCAPE '\\'`,
  ).all(
    CALL_MATCH_KIND,
    UNRESOLVED_RELATION,
    "func:%#" + symbol.replace(/[%_]/g, "\\$&"),
  ) as Array<{ to_source: string; from_source: string; relation_type: string; weight: number }>;

  const byTarget = new Map<string, SymbolImpact & { declaredIn: string }>();
  for (const r of rows) {
    // LIKE 'func:%#name' can also match 'func:a.ts#other#name'; require an exact tail.
    const hash = r.to_source.lastIndexOf("#");
    if (r.to_source.slice(hash + 1) !== symbol) continue;

    let t = byTarget.get(r.to_source);
    if (!t) {
      t = {
        symbol,
        declaredIn: r.to_source.slice("func:".length, hash),
        callers: 0, sites: 0, files: [], ambiguousCallers: 0,
      };
      byTarget.set(r.to_source, t);
    }
    if (r.relation_type === "calls_ambiguous") { t.ambiguousCallers++; continue; }
    t.callers++;
    t.sites += r.weight;
    const f = r.from_source.slice("func:".length).split("#")[0]!;
    if (!t.files.includes(f)) t.files.push(f);
  }

  const out = [...byTarget.values()].sort((a, b) => b.callers - a.callers);
  for (const t of out) t.files.sort();
  return out;
}
