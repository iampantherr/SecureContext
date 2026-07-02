/**
 * Semantic entity/relation extraction (v0.37.0 — Tier-1 #3)
 * ==========================================================
 *
 * OPTIONAL local-LLM layer on top of the zero-LLM co-reference engine: extracts named
 * entities + relations from KB content via Ollama and persists them as graph edges
 * (`match_kind='entity'`), giving research/memory-heavy projects real semantic structure
 * ("CompetitorX —competes_with→ pricing-model") where string co-reference finds nothing.
 *
 * Design constraints:
 *   - LOCAL ONLY (Ollama /api/generate, format:"json") — no cloud calls, ever.
 *   - BUDGETED — the enrichment cron scans ENTITY_BUDGET unscanned entries per cycle
 *     (source_meta.entity_scanned_at is the marker), so cost is bounded and predictable.
 *   - NON-DESTRUCTIVE — entity edges are PRESERVED by the co-reference rebuild
 *     (which now deletes only match_kind<>'entity' rows) and refresh the same
 *     kb_backlinks aggregate, so entity hubs participate in the search boost.
 *   - Kill-switch: ZC_ENTITY_EXTRACT=0 disables the layer entirely.
 */

import { Config } from "../config.js";

export interface EntityExtraction {
  /** entity slugs (lowercase, dash-separated), already deduped + capped */
  entities:  string[];
  /** relations between slugs (from/to are slugs present in `entities`) */
  relations: Array<{ from: string; to: string; relation: string }>;
}

export interface EntityEdge {
  from:      string;   // source id ("file:x.ts" / "memory:agent:key") or "entity:<slug>"
  to:        string;   // "entity:<slug>"
  relation:  string;   // "mentions_entity" | LLM-provided relation slug
  matchKind: "entity";
  weight:    number;
}

export const ENTITY_EXTRACT_ENABLED = (process.env["ZC_ENTITY_EXTRACT"] ?? "1") !== "0";
export const ENTITY_BUDGET = Math.max(1, parseInt(process.env["ZC_ENTITY_BUDGET"] ?? "15", 10) || 15);
const ENTITY_MODEL = process.env["ZC_ENTITY_MODEL"] ?? process.env["ZC_HYDE_MODEL"] ?? "qwen2.5-coder:14b";

function ollamaBase(): string {
  const raw = process.env["ZC_OLLAMA_URL"] ?? "http://localhost:11435";
  return raw.replace(/\/api\/[^/]+\/?$/, "").replace(/\/$/, "");
}

/** lowercase, alphanumeric+dash slug; empty string when nothing survives */
export function slugifyEntity(name: string): string {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9\s_-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// Generic terms that would create useless mega-hubs connecting everything.
const ENTITY_STOPLIST = new Set([
  "user", "users", "system", "data", "file", "files", "code", "project", "projects",
  "function", "test", "tests", "error", "errors", "api", "app", "application",
  "update", "updates", "issue", "issues", "task", "tasks", "agent", "agents",
]);

/**
 * One budgeted LLM call → entities + relations for a piece of content.
 * Returns null on any failure (Ollama down, bad JSON) — callers treat null as
 * "retry next cycle" and do NOT mark the entry scanned.
 */
export async function llmExtractEntities(content: string): Promise<EntityExtraction | null> {
  const prompt =
    `Extract the important NAMED entities from this text (products, companies, tools, ` +
    `technologies, features, people, projects — NOT generic words like "user" or "code"), ` +
    `and the relations between them that the text states.\n\nTEXT:\n${content.slice(0, 3000)}\n\n` +
    `Return ONLY JSON: {"entities": ["name", ...], "relations": [{"from": "name", "to": "name", "relation": "verb_phrase"}, ...]}. ` +
    `At most 10 entities and 8 relations. Use snake_case for relation verbs.`;
  try {
    const r = await fetch(`${ollamaBase()}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ENTITY_MODEL, prompt, stream: false, format: "json",
        options: { temperature: 0, num_predict: 500 },
      }),
    });
    if (!r.ok) return null;
    const j = await r.json() as { response: string };
    let parsed: unknown;
    try { parsed = JSON.parse(j.response ?? ""); } catch { return null; }
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as { entities?: unknown[]; relations?: unknown[] };
    const entities: string[] = [];
    const seen = new Set<string>();
    for (const e of Array.isArray(o.entities) ? o.entities : []) {
      const name = typeof e === "string" ? e : (e && typeof e === "object" ? String((e as { name?: unknown }).name ?? "") : "");
      const slug = slugifyEntity(name);
      if (slug.length >= 3 && !ENTITY_STOPLIST.has(slug) && !seen.has(slug)) { seen.add(slug); entities.push(slug); }
      if (entities.length >= 10) break;
    }
    const relations: EntityExtraction["relations"] = [];
    for (const rel of Array.isArray(o.relations) ? o.relations : []) {
      if (!rel || typeof rel !== "object") continue;
      const rr = rel as { from?: unknown; to?: unknown; relation?: unknown };
      const from = slugifyEntity(String(rr.from ?? "")), to = slugifyEntity(String(rr.to ?? ""));
      const relSlug = slugifyEntity(String(rr.relation ?? "related_to")) || "related_to";
      if (seen.has(from) && seen.has(to) && from !== to) relations.push({ from, to, relation: relSlug });
      if (relations.length >= 8) break;
    }
    return { entities, relations };
  } catch { return null; }
}

/** Map an extraction to graph edges: source→entity mentions + entity→entity relations. */
export function entityEdgesFor(source: string, x: EntityExtraction): EntityEdge[] {
  const edges: EntityEdge[] = [];
  for (const e of x.entities) {
    edges.push({ from: source, to: `entity:${e}`, relation: "mentions_entity", matchKind: "entity", weight: 1 });
  }
  for (const r of x.relations) {
    edges.push({ from: `entity:${r.from}`, to: `entity:${r.to}`, relation: r.relation, matchKind: "entity", weight: 1 });
  }
  return edges;
}

// ── SQLite variant (parity) ──────────────────────────────────────────────────
// The PG deployment runs extraction automatically via the enrichment cron; SQLite-only
// installs run it whenever the graph is rebuilt (zc_graph_rebuild / zc_kb_cluster).
import type { DatabaseSync } from "node:sqlite";

export async function runEntityExtractionOnDb(db: DatabaseSync, budget: number = ENTITY_BUDGET): Promise<{ scanned: number; edges: number; ollamaDown: boolean }> {
  if (!ENTITY_EXTRACT_ENABLED) return { scanned: 0, edges: 0, ollamaDown: false };
  try { db.exec(`ALTER TABLE source_meta ADD COLUMN entity_scanned_at TEXT`); } catch { /* exists */ }
  let rows: Array<{ source: string; content: string }> = [];
  try {
    rows = db.prepare(`
      SELECT k.source, k.content FROM knowledge k
      JOIN source_meta sm ON sm.source = k.source
      WHERE sm.entity_scanned_at IS NULL AND k.source NOT LIKE '[SESSION_SUMMARY]%'
      ORDER BY k.created_at DESC LIMIT ?`).all(budget) as Array<{ source: string; content: string }>;
  } catch { return { scanned: 0, edges: 0, ollamaDown: false }; }
  let scanned = 0, edges = 0;
  const now = new Date().toISOString();
  for (const r of rows) {
    const x = await llmExtractEntities(r.content);
    if (x === null) return { scanned, edges, ollamaDown: true };
    for (const e of entityEdgesFor(r.source, x)) {
      try {
        db.prepare(
          `INSERT INTO kb_edges(from_source, to_source, relation_type, match_kind, weight, computed_at)
           VALUES (?, ?, ?, 'entity', ?, ?)
           ON CONFLICT(from_source, to_source, relation_type) DO UPDATE SET weight = weight + 1, computed_at = excluded.computed_at`
        ).run(e.from, e.to, e.relation, e.weight, now);
        edges++;
      } catch { /* kb_edges absent on a pre-migration DB */ }
    }
    try { db.prepare(`UPDATE source_meta SET entity_scanned_at = ? WHERE source = ?`).run(now, r.source); } catch { /* no-op */ }
    scanned++;
  }
  // Refresh the aggregate so entity hubs join the boost + graph sizing.
  if (edges > 0) {
    try {
      db.exec("DELETE FROM kb_backlinks");
      db.prepare(
        `INSERT INTO kb_backlinks(source, in_degree, weighted_in, computed_at)
         SELECT to_source, COUNT(DISTINCT from_source), SUM(weight), ? FROM kb_edges GROUP BY to_source`
      ).run(now);
    } catch { /* best-effort */ }
  }
  return { scanned, edges, ollamaDown: false };
}

// Config referenced so a future budget knob can live there without an import churn.
void Config;
