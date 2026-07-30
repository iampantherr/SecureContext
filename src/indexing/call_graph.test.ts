/**
 * Tests for call-graph extraction (v0.55.0).
 *
 * Two tiers, and the second is the one that matters:
 *
 *   1. Fixtures — declaration forms, attribution, ambiguity, dynamic calls.
 *   2. THE ORACLE — a run over SecureContext's own src/, asserting numbers
 *      established BY HAND during the 2026-07-29 session. If the extractor
 *      disagrees with a hand count, the extractor is wrong. Fixtures can
 *      only confirm what I already believed; this can falsify it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractFileCalls, resolveCallGraph, impactOf, nodeId, callGraphAvailable,
  type FileCalls,
} from "./call_graph.js";

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));  // .../src

describe("extractFileCalls", () => {
  it("attributes a call to the innermost enclosing function", async () => {
    const r = await extractFileCalls(`
      function outer() {
        function inner() { target(); }
        other();
      }
    `, "a.ts");
    expect(r!.sites.find(s => s.callee === "target")!.from).toBe("inner");
    expect(r!.sites.find(s => s.callee === "other")!.from).toBe("outer");
  });

  it("records every declaration form we rely on", async () => {
    const r = await extractFileCalls(`
      export function declared() {}
      const arrow = () => {};
      const expr = function () {};
      class K { method() {} }
    `, "a.ts");
    expect(r!.decls.map(d => d.symbol).sort()).toEqual(["arrow", "declared", "expr", "method"]);
  });

  it("counts unnameable calls as dynamic instead of dropping them", async () => {
    const r = await extractFileCalls(`
      function f(handlers: any, t: string) { handlers[t](); (await g())(); }
    `, "a.ts");
    expect(r!.dynamicSites).toBeGreaterThan(0);
  });

  it("attributes top-level calls to <top>, not to the previous function", async () => {
    const r = await extractFileCalls(`function f() {}\nsideEffect();`, "a.ts");
    expect(r!.sites.find(s => s.callee === "sideEffect")!.from).toBe("<top>");
  });

  it("returns null — not an empty graph — for unparseable input", async () => {
    expect(await extractFileCalls("x", "a.py")).toBeNull();   // wrong language
    expect(await extractFileCalls("", "a.ts")).toBeNull();    // empty
  });
});

describe("resolveCallGraph", () => {
  const build = async (files: Record<string, string>): Promise<FileCalls[]> => {
    const out: FileCalls[] = [];
    for (const [path, content] of Object.entries(files)) {
      const r = await extractFileCalls(content, path);
      if (r) out.push(r);
    }
    return out;
  };

  it("emits a calls edge for an unambiguous single declaration", async () => {
    const g = resolveCallGraph(await build({
      "lib.ts": `export function helper() {}`,
      "app.ts": `function main() { helper(); helper(); }`,
    }));
    const edge = g.edges.find(e => e.to === nodeId("lib.ts", "helper"));
    expect(edge).toMatchObject({ from: nodeId("app.ts", "main"), relation: "calls", sites: 2 });
    expect(impactOf(g, nodeId("lib.ts", "helper"))).toMatchObject({ callers: 1, sites: 2 });
  });

  it("marks a name declared twice as ambiguous, and does NOT count it as fan-in", async () => {
    const g = resolveCallGraph(await build({
      "a.ts":   `export function dup() {}`,
      "b.ts":   `export function dup() {}`,
      "app.ts": `function main() { dup(); }`,
    }));
    expect(g.edges.every(e => e.relation === "calls_ambiguous")).toBe(true);
    const impact = impactOf(g, nodeId("a.ts", "dup"));
    expect(impact.callers).toBe(0);
    expect(impact.ambiguousCallers).toBe(1);
  });

  it("never trusts a common method name even with one declaration", async () => {
    // The probe's failure: 70 'callers' of close(), nearly all db.close().
    const g = resolveCallGraph(await build({
      "store.ts": `export function close() {}`,
      "app.ts":   `function main(db: any) { db.close(); }`,
    }));
    expect(impactOf(g, nodeId("store.ts", "close")).callers).toBe(0);
  });

  it("follows import aliases to the original symbol", async () => {
    // Regression: scopedProjectHash reported 0 callers despite 42 call sites.
    const g = resolveCallGraph(await build({
      "store.ts": `export function projectHash(p: string) { return p; }`,
      "app.ts":   `import { projectHash as scoped } from "./store.js";\n` +
                  `function main() { scoped("a"); scoped("b"); }`,
    }));
    expect(impactOf(g, nodeId("store.ts", "projectHash")))
      .toMatchObject({ callers: 1, sites: 2, files: ["app.ts"] });
  });

  it("uses the import path to pick between two same-named declarations", async () => {
    // The real case: projectHash is declared in BOTH store.ts and
    // access-control.ts, so name-only resolution buried all 47 call sites.
    const g = resolveCallGraph(await build({
      "store.ts":          `export function projectHash(p: string) { return p; }`,
      "access-control.ts": `export function projectHash(p: string) { return p; }`,
      "app.ts":            `import { projectHash } from "./store.js";\n` +
                           `function main() { projectHash("a"); }`,
    }));
    expect(impactOf(g, nodeId("store.ts", "projectHash"))).toMatchObject({ callers: 1, sites: 1 });
    expect(impactOf(g, nodeId("access-control.ts", "projectHash")).callers).toBe(0);
  });

  it("trusts an explicitly imported common name but not a bare method call", async () => {
    const g = resolveCallGraph(await build({
      "store.ts": `export function close() {}`,
      "app.ts":   `import { close } from "./store.js";\n` +
                  `function main(db: any) { close(); db.close(); }`,
    }));
    // The import binds; the db.close() alongside it must not inflate the count.
    expect(impactOf(g, nodeId("store.ts", "close"))).toMatchObject({ callers: 1, sites: 1 });
  });

  it("drops calls to symbols this repo does not declare", async () => {
    const g = resolveCallGraph(await build({ "app.ts": `function main() { JSON.parse("{}"); }` }));
    expect(g.edges).toHaveLength(0);
    expect(g.stats.external).toBe(1);
  });

  it("does not report self-recursion as impact", async () => {
    const g = resolveCallGraph(await build({ "app.ts": `function loop() { loop(); }` }));
    expect(g.edges).toHaveLength(0);
  });
});

// ─── The oracle ────────────────────────────────────────────────────────────

describe("oracle: SecureContext's own src/", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) out.push(p);
    }
    return out;
  };

  it("matches counts established by hand", async () => {
    if (!(await callGraphAvailable())) return;   // parser absent: assert nothing rather than a false pass

    const files: FileCalls[] = [];
    for (const abs of walk(SRC)) {
      const r = await extractFileCalls(readFileSync(abs, "utf8"), relative(SRC, abs).replace(/\\/g, "/"));
      if (r) files.push(r);
    }
    const g = resolveCallGraph(files);
    expect(g.stats.files).toBeGreaterThan(80);

    // Hand counts from the 2026-07-29 session. These are ground truth.
    const byName = (sym: string) =>
      g.edges.filter(e => e.to.endsWith(`#${sym}`) && e.relation === "calls").length;

    expect(byName("clampWithMarker")).toBe(4);
    expect(byName("verifyWrite")).toBe(2);

    // The symbol that reported a fabricated zero twice — once for the import
    // alias, once because it is declared in two files. 31 distinct callers was
    // established by hand. This assertion is the guard for both regressions.
    const ph = impactOf(g, nodeId("store.ts", "projectHash"));
    expect(ph.callers).toBe(31);
    expect(ph.files.length).toBe(18);
    expect(ph.sites).toBeGreaterThan(ph.callers);   // several callers call it twice

    // The probe's noise symbols must land in the ambiguous bucket, not fan-in.
    for (const noisy of ["close", "run", "add"]) {
      expect(byName(noisy)).toBe(0);
    }

    // Coverage must be honest and visible, never silently zero.
    expect(g.stats.dynamicSites).toBeGreaterThan(0);
  });
});
