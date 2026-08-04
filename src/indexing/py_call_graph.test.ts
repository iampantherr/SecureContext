/**
 * Python call-graph extraction (v0.56.0) — ground-truth fixture.
 *
 * The first run of this exact fixture caught a real bug: Python decls were
 * emitted without `path`, so every node became `func:undefined#name` and all
 * edges collapsed to ambiguous. Fixtures with hand-known answers, again.
 * Skips (loudly) when python is not installed rather than passing vacuously.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { extractPythonBatch, pythonAvailable } from "./py_call_graph.js";
import { resolveCallGraph } from "./call_graph.js";

describe("python extractor", () => {
  it("resolves aliased imports, keeps decoys local, distrusts property calls", () => {
    if (!pythonAvailable()) {
      console.warn("[py_call_graph.test] python not installed — SKIPPED, not passed");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "zc-pyt-"));
    try {
      writeFileSync(join(dir, "money.py"), "def to_cents(x):\n    return round(x*100)\n\ndef unused_helper(x):\n    return x\n");
      writeFileSync(join(dir, "billing.py"), "from money import to_cents as minor\n\ndef invoice(xs):\n    return sum(minor(x) for x in xs)\n\ndef refund(x):\n    return minor(x)\n");
      writeFileSync(join(dir, "legacy.py"), "def to_cents(x):\n    return x*100\n\ndef legacy_total(xs):\n    return sum(to_cents(x) for x in xs)\n\nclass DB:\n    def close(self): pass\n\ndef teardown(db):\n    db.close()\n");
      const toRel = (a: string) => a.slice(dir.length + 1).split(sep).join("/");
      const py = extractPythonBatch([join(dir, "money.py"), join(dir, "billing.py"), join(dir, "legacy.py")], toRel);
      expect(py.errors).toEqual([]);
      expect(py.files).toHaveLength(3);
      const g = resolveCallGraph(py.files);
      const has = (f: string, t: string) => g.edges.some((e) => e.from === f && e.to === t && e.relation === "calls");
      expect(has("func:billing.py#invoice", "func:money.py#to_cents")).toBe(true);
      expect(has("func:billing.py#refund", "func:money.py#to_cents")).toBe(true);
      expect(has("func:legacy.py#legacy_total", "func:legacy.py#to_cents")).toBe(true);
      expect(g.edges.some((e) => e.to.endsWith("#close") && e.relation === "calls")).toBe(false);
      expect(g.edges.some((e) => e.to === "func:money.py#unused_helper")).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
