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
import { persistCallEdges, getFileImpact, getSymbolImpact, renderImpact, HIGH_FAN_IN, CALL_MATCH_KIND } from "./call_edges.js";
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

  it("reports the real count of unnameable call sites, not an assumed zero", () => {
    persistCallEdges(db, CALLS, new Map([["lib.ts", 4]]));
    expect(getFileImpact(db, "lib.ts").dynamicSites).toBe(4);
    expect(getFileImpact(db, "app.ts").dynamicSites).toBe(0);
  });

  it("keeps the unresolved sentinel out of the symbol list", () => {
    persistCallEdges(db, CALLS, new Map([["lib.ts", 4]]));
    const symbols = getFileImpact(db, "lib.ts").symbols.map((s) => s.symbol);
    expect(symbols).toEqual(expect.arrayContaining(["helper", "close"]));
    expect(symbols.some((s) => s.includes("unresolved"))).toBe(false);
  });

  it("does not match a different file that shares a prefix", () => {
    persistCallEdges(db, [edge(nodeId("app.ts", "main"), nodeId("lib.ts.bak", "helper"))]);
    expect(getFileImpact(db, "lib.ts").symbols).toHaveLength(0);
  });
});

describe("getSymbolImpact", () => {
  it("reports one entry per declaring file, never merging same-named functions", () => {
    persistCallEdges(db, [
      edge(nodeId("a.ts", "useA"), nodeId("store.ts", "ph"), 2),
      edge(nodeId("b.ts", "useB"), nodeId("other.ts", "ph"), 1),
    ]);
    const out = getSymbolImpact(db, "ph");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ declaredIn: "store.ts", callers: 1, sites: 2 });
    expect(out.map((o) => o.declaredIn).sort()).toEqual(["other.ts", "store.ts"]);
  });

  it("does not match a symbol whose name merely ends with the query", () => {
    persistCallEdges(db, [edge(nodeId("a.ts", "x"), nodeId("lib.ts", "projectHash"))]);
    expect(getSymbolImpact(db, "Hash")).toEqual([]);
  });

  it("returns an empty list for an unknown symbol", () => {
    persistCallEdges(db, CALLS);
    expect(getSymbolImpact(db, "nonexistent")).toEqual([]);
  });
});

describe("renderImpact", () => {
  const target = (symbol: string, callers: number, ambiguous = 0) =>
    ({ symbol, declaredIn: "lib.ts", callers, sites: callers, files: callers ? ["a.ts"] : [], ambiguous });

  it("says unknown, not zero, when the graph was never built", () => {
    const out = renderImpact({ targets: [], dynamicSites: 0, built: false }, { file: "lib.ts" });
    expect(out).toMatch(/NOT been built/);
    expect(out).not.toMatch(/safe to change/);
  });

  it("refuses to call an empty result safe", () => {
    const out = renderImpact({ targets: [], dynamicSites: 0, built: true }, { symbol: "x" });
    expect(out).toMatch(/No static callers found/);
    expect(out).toMatch(/not the same as safe to change/);
  });

  it("marks high fan-in and always states unresolved coverage", () => {
    const out = renderImpact(
      { targets: [target("hub", HIGH_FAN_IN)], dynamicSites: 7, built: true }, { file: "lib.ts" });
    expect(out).toMatch(/HIGH FAN-IN/);
    expect(out).toMatch(/7 call sites in this file could not be resolved/);
  });

  it("counts name-only symbols instead of listing them as zero-caller findings", () => {
    const out = renderImpact(
      { targets: [target("real", 2), target("noise", 0, 3)], dynamicSites: 0, built: true },
      { file: "lib.ts" });
    expect(out).toMatch(/real\(\)/);
    expect(out).not.toMatch(/noise\(\).*0 callers/);
    expect(out).toMatch(/1 further symbol is referenced by name only/);
  });

  it("caps the list but reports how many were withheld", () => {
    const many = Array.from({ length: 30 }, (_, i) => target(`f${i}`, 2));
    const out = renderImpact({ targets: many, dynamicSites: 0, built: true }, { file: "lib.ts" }, { limit: 5 });
    expect(out).toMatch(/and 25 more symbols with callers/);
  });
});
