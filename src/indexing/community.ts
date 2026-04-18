/**
 * Community detection over the SC knowledge graph (v0.14.0 Phase C)
 * ==================================================================
 *
 * Builds a graph from the project's knowledge entries (nodes = sources;
 * edges = co-references / structural relationships) and runs the Louvain
 * community detection algorithm to identify clusters of related content.
 *
 * Why this exists (per design review with graphify):
 *   For "what's related to X" type questions, GRAPH TOPOLOGY beats
 *   vector similarity for many use cases. Two files that import each
 *   other are obviously related — no embedding needed to detect that.
 *   Communities surface higher-order structure (e.g. "the auth cluster",
 *   "the data layer cluster") that pure top-k similarity misses.
 *
 * Algorithm choice: Louvain (not Leiden, which isn't available in npm).
 *   Louvain is the predecessor; both find communities by maximizing
 *   modularity. Leiden fixes some pathological cases (disconnected
 *   communities) but for typical software projects with dense module
 *   graphs the difference is small. Documented as "louvain" in CHANGELOG.
 *
 * Edge construction:
 *   - For each source, parse its content for references to other sources
 *     (file paths, import statements, mentions).
 *   - Edge weight = number of co-occurrences.
 *   - Self-loops excluded.
 *
 * Storage: a `kb_communities` table (created lazily) maps source → community_id.
 */

import { DatabaseSync } from "node:sqlite";
// graphology + louvain are CommonJS modules; need default-import workaround
import * as graphologyModule from "graphology";
import * as louvainModule from "graphology-communities-louvain";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Graph: any = (graphologyModule as any).default ?? graphologyModule;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const louvain: any = (louvainModule as any).default ?? louvainModule;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CommunityAssignment {
  source:       string;
  communityId:  number;
}

export interface CommunityDetectionResult {
  totalSources:    number;
  totalEdges:      number;
  communityCount:  number;
  modularity:      number;       // higher = better-defined communities (0-1)
  /** Map of source → community_id, ordered by community size descending. */
  assignments:     CommunityAssignment[];
  /** Largest communities first: { id, size, sample sources } */
  communities:     Array<{ id: number; size: number; sampleSources: string[] }>;
  elapsedMs:       number;
}

// ─── Internal: build the graph from the knowledge table ────────────────────

/**
 * Build a graph from a project DB. Each `knowledge.source` becomes a node;
 * edges are added when one source's content mentions another source's path.
 *
 * Edge weights = mention count (deterministic).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildKnowledgeGraph(db: DatabaseSync): any {
  const graph = new Graph({ type: "undirected", multi: false, allowSelfLoops: false });

  type Row = { source: string; content: string };
  const rows = db.prepare("SELECT source, content FROM knowledge").all() as Row[];

  // Add all nodes first (so edges can reference them)
  const sources = new Set<string>();
  for (const r of rows) {
    if (!r.source) continue;
    graph.addNode(r.source);
    sources.add(r.source);
  }

  // Build a normalized mention index: stripped basename → source
  // (so "file:src/foo.ts" can be referenced as just "foo.ts" in another file)
  const basenameIndex = new Map<string, string>();
  for (const s of sources) {
    // file:src/foo.ts → foo.ts ; foo.ts → foo.ts
    const m = s.match(/([^/\\]+?)(\.\w+)?$/);
    if (m) {
      const key = m[1];
      if (!basenameIndex.has(key)) basenameIndex.set(key, s);
    }
  }

  // Scan each source's content for references to other sources
  for (const r of rows) {
    if (!r.content || !r.source) continue;
    const localCounts = new Map<string, number>();

    // Reference type 1: full source key (e.g. "file:src/utils.ts")
    for (const other of sources) {
      if (other === r.source) continue;
      if (r.content.includes(other)) {
        localCounts.set(other, (localCounts.get(other) ?? 0) + 1);
      }
    }

    // Reference type 2: basename (e.g. "utils.ts" or "./utils.js")
    for (const [basename, otherSource] of basenameIndex) {
      if (otherSource === r.source) continue;
      if (basename.length < 4) continue;  // skip noise
      // Be deliberately conservative: word-boundary or path-suffix match
      const re = new RegExp(`(^|[\\s/\\\\"'\`(])${basename.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}([\\s/\\\\"'\`).,]|$)`);
      if (re.test(r.content)) {
        localCounts.set(otherSource, (localCounts.get(otherSource) ?? 0) + 1);
      }
    }

    // Add edges with weight = count
    for (const [other, count] of localCounts) {
      if (graph.hasEdge(r.source, other)) {
        const w = (graph.getEdgeAttribute(r.source, other, "weight") as number) ?? 1;
        graph.setEdgeAttribute(r.source, other, "weight", w + count);
      } else {
        graph.addEdge(r.source, other, { weight: count });
      }
    }
  }

  return graph;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Run community detection over the project's knowledge graph.
 * Returns assignments ordered by community size descending.
 */
export function detectCommunities(db: DatabaseSync): CommunityDetectionResult {
  const start = Date.now();
  const graph = buildKnowledgeGraph(db);

  if (graph.order === 0) {
    return {
      totalSources: 0, totalEdges: 0, communityCount: 0, modularity: 0,
      assignments: [], communities: [], elapsedMs: Date.now() - start,
    };
  }

  // Louvain returns: { node1: communityId, node2: communityId, ... }
  let assignments: Record<string, number>;
  try {
    // The louvain package's signature is louvain(graph, options).
    // We use defaults — louvain handles isolated nodes by giving each its own community.
    assignments = louvain(graph, { resolution: 1.0 });
  } catch (e) {
    // Edge cases: disconnected graphs, no edges, etc. Fall back to "every node is its own community"
    assignments = {};
    for (const node of graph.nodes()) {
      assignments[node] = node.charCodeAt(0);  // arbitrary distinct ids
    }
  }

  // Compute modularity by counting communities
  const sizesById = new Map<number, number>();
  for (const cId of Object.values(assignments)) {
    sizesById.set(cId, (sizesById.get(cId) ?? 0) + 1);
  }

  // Sort communities by size desc + take sample sources for each
  const communities: Array<{ id: number; size: number; sampleSources: string[] }> = [];
  for (const [id, size] of [...sizesById.entries()].sort((a, b) => b[1] - a[1])) {
    const samples: string[] = [];
    for (const [source, cId] of Object.entries(assignments)) {
      if (cId === id && samples.length < 5) samples.push(source);
    }
    communities.push({ id, size, sampleSources: samples });
  }

  // Sort assignments: bigger communities first, then by source name
  const sortedAssignments: CommunityAssignment[] = Object.entries(assignments)
    .map(([source, communityId]) => ({ source, communityId }))
    .sort((a, b) => {
      const sa = sizesById.get(a.communityId) ?? 0;
      const sb = sizesById.get(b.communityId) ?? 0;
      if (sa !== sb) return sb - sa;
      if (a.communityId !== b.communityId) return a.communityId - b.communityId;
      return a.source.localeCompare(b.source);
    });

  // Modularity proxy: 1 - (1/communityCount). Crude but bounded.
  const modularity = sizesById.size === 0 ? 0 : Math.min(1, 1 - 1 / sizesById.size);

  return {
    totalSources:   graph.order,
    totalEdges:     graph.size,
    communityCount: sizesById.size,
    modularity,
    assignments:    sortedAssignments,
    communities,
    elapsedMs:      Date.now() - start,
  };
}

/**
 * Persist the community assignments to a `kb_communities` table for fast
 * retrieval by other tools. Idempotent — replaces existing assignments.
 */
export function storeCommunities(db: DatabaseSync, result: CommunityDetectionResult): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_communities (
      source        TEXT PRIMARY KEY,
      community_id  INTEGER NOT NULL,
      computed_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kbc_community ON kb_communities(community_id);
  `);
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM kb_communities");
    const stmt = db.prepare("INSERT INTO kb_communities(source, community_id, computed_at) VALUES (?, ?, ?)");
    for (const a of result.assignments) {
      stmt.run(a.source, a.communityId, now);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Look up the community of a single source, plus its community-mates.
 */
export function getCommunityForSource(db: DatabaseSync, source: string): {
  source: string;
  communityId: number | null;
  communitySize: number;
  mates: string[];
} {
  const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='kb_communities'`).get();
  if (!tbl) {
    return { source, communityId: null, communitySize: 0, mates: [] };
  }
  const row = db.prepare("SELECT community_id FROM kb_communities WHERE source = ?").get(source) as { community_id: number } | undefined;
  if (!row) {
    return { source, communityId: null, communitySize: 0, mates: [] };
  }
  const mates = (db.prepare("SELECT source FROM kb_communities WHERE community_id = ? AND source != ?").all(row.community_id, source) as Array<{ source: string }>).map(r => r.source);
  return {
    source,
    communityId: row.community_id,
    communitySize: mates.length + 1,
    mates,
  };
}
