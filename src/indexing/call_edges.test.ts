/**
 * Tests for call-graph persistence (v0.55.0).
 *
 * The load-bearing test here is "survives a backlink rebuild". Storing the call
 * layer in a table that another subsystem periodically DELETEs is how this
 * feature would fail in production: quietly, with every impact answer becoming
 * "nothing depends on this", and no error anywhere to notice.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { persistCallEdges, getFileImpact, CALL_MATCH_KIND } from "./call_edges.js";
import { rebuildBacklinks } from "./backlinks.js";
import { nodeId, type CallEdge } from "./call_graph.js";

const edge = (from: string, to: string, sites = 1, relation: CallEdge["relation"] = "calls"): CallEdge =>
  ({ from, to, relation, sites });

const CALLS: CallEdge[] = [
  edge(nodeId("app.ts", "main"),    nodeId("lib.ts", "helper"), 3),
  edge(nodeId("other.ts", "run"),   nodeId("lib.ts", "helper"), 1),
  edge(nodeId("app.ts", "main"),    nodeId("lib.ts", "close"), 1, "calls_ambiguous"),
];

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // Minimal slice of the real schema that both subsystems touch.
  db.exec(`
    CREATE VIRTUAL TABLE knowledge USING fts5(source, content);
    CREATE TABLE kb_edges (
      from_source TEXT NOT NULL, to_source TEXT NOT NULL,
      relation_type TEXT NOT NULL DEFAULT 'code_ref',
      match_kind TEXT NOT NULL DEFAULT 'full_key',
      weight INTEGER NOT NULL DEFAULT 1, computed_at TEXT NOT NULL,
      PRIMARY KEY (from_source, to_source, relation_type)
    );
    CREATE TABLE kb_backlinks (
      source TEXT PRIMARY KEY, in_degree INTEGER NOT NULL DEFAULT 0,
      weighted_in INTEGER NOT NULL DEFAULT 0, computed_at TEXT NOT NULL
    );
  `);
});

const callEdgeCount = (): number =>
  (db.prepare(`SELECT COUNT(*) c FROM kb_edges WHERE match_kind = ?`).get(CALL_MATCH_KIND) as { c: number }).c;

describe("persistCallEdges", () => {
  it("writes edges under the call match_kind with site counts as weight", () => {
    persistCallEdges(db, CALLS);
    expect(callEdgeCount()).toBe(3);
    const row = db.prepare(
      `SELECT weight, relation_type FROM kb_edges WHERE from_source = ? AND to_source = ?`,
    ).get(nodeId("app.ts", "main"), nodeId("lib.ts", "helper")) as { weight: number; relation_type: string };
    expect(row).toMatchObject({ weight: 3, relation_type: "calls" });
  });

  it("fully replaces the layer, leaving no orphans from the previous build", () => {
    persistCallEdges(db, CALLS);
    persistCallEdges(db, [edge(nodeId("app.ts", "main"), nodeId("lib.ts", "helper"))]);
    expect(callEdgeCount()).toBe(1);
  });

  it("does not touch other layers", () => {
    db.prepare(
      `INSERT INTO kb_edges VALUES ('a', 'b', 'mentions_entity', 'entity', 1, 'now')`,
    ).run();
    persistCallEdges(db, CALLS);
    persistCallEdges(db, []);
    const entity = db.prepare(`SELECT COUNT(*) c FROM kb_edges WHERE match_kind = 'entity'`).get() as { c: number };
    expect(entity.c).toBe(1);
  });
});

describe("coexistence with the co-reference layer", () => {
  it("SURVIVES a backlink rebuild", () => {
    // rebuildBacklinks runs debounced after every indexContent and does a full
    // DELETE of kb_edges. Before the 'call' carve-out this wiped the layer.
    db.prepare(`INSERT INTO knowledge(source, content) VALUES ('doc.md', 'mentions app.ts and lib.ts')`).run();
    persistCallEdges(db, CALLS);
    expect(callEdgeCount()).toBe(3);

    rebuildBacklinks(db);

    expect(callEdgeCount()).toBe(3);
  });

  it("keeps call edges out of kb_backlinks so search ranking is unchanged", () => {
    db.prepare(`INSERT INTO knowledge(source, content) VALUES ('doc.md', 'mentions app.ts')`).run();
    persistCallEdges(db, CALLS);
    rebuildBacklinks(db);

    const funcRows = db.prepare(
      `SELECT COUNT(*) c FROM kb_backlinks WHERE source LIKE 'func:%'`,
    ).get() as { c: number };
    expect(funcRows.c).toBe(0);
  });
});

describe("getFileImpact", () => {
  it("groups callers by symbol and keeps ambiguous edges out of the count", () => {
    persistCallEdges(db, CALLS);
    const impact = getFileImpact(db, "lib.ts");

    expect(impact.built).toBe(true);
    const helper = impact.symbols.find((s) => s.symbol === "helper")!;
    expect(helper).toMatchObject({ callers: 2, sites: 4, files: ["app.ts", "other.ts"] });

    const close = impact.symbols.find((s) => s.symbol === "close")!;
    expect(close).toMatchObject({ callers: 0, ambiguousCallers: 1 });
  });

  it("reports built=false when the layer was never built, not an empty result", () => {
    // The distinction that matters: "could not look" must never render as
    // "nothing depends on this".
    const impact = getFileImpact(db, "lib.ts");
    expect(impact.built).toBe(false);
    expect(impact.symbols).toEqual([]);
  });

  it("normalises Windows separators so a native path still matches", () => {
    persistCallEdges(db, [edge(nodeId("app.ts", "main"), nodeId("src/lib.ts", "helper"))]);
    expect(getFileImpact(db, "src\\lib.ts").symbols).toHaveLength(1);
  });

  it("does not match a different file that shares a prefix", () => {
    persistCallEdges(db, [edge(nodeId("app.ts", "main"), nodeId("lib.ts.bak", "helper"))]);
    expect(getFileImpact(db, "lib.ts").symbols).toHaveLength(0);
  });
});
