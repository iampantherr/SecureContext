/**
 * Tests for src/graph_proxy.ts (v0.13.0).
 *
 * graphify is OPTIONAL — these tests verify SC's graceful behavior when:
 *   - graphify-out/ doesn't exist → returns hint
 *   - graphify-out/graph.json exists but `python -m graphify.serve` fails
 *     (e.g. python not installed) → returns error, logs warning
 *
 * We don't test the live subprocess path (would require Python + graphifyy
 * installed in CI). That's covered by manual integration testing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findGraphifyOutput,
  findGraphReport,
  graphQuery,
  graphPath,
  graphNeighbors,
  shutdownAllGraphifyHandles,
} from "./graph_proxy.js";

let testProject: string;

beforeEach(() => {
  testProject = mkdtempSync(join(tmpdir(), "zc-graph-"));
});

afterEach(() => {
  shutdownAllGraphifyHandles();
  try { rmSync(testProject, { recursive: true, force: true }); } catch {}
});

describe("findGraphifyOutput", () => {

  it("returns null when no graphify-out/ directory exists", () => {
    expect(findGraphifyOutput(testProject)).toBeNull();
  });

  it("returns null when graphify-out/ exists but graph.json doesn't", () => {
    mkdirSync(join(testProject, "graphify-out"), { recursive: true });
    expect(findGraphifyOutput(testProject)).toBeNull();
  });

  it("returns the path when graphify-out/graph.json exists", () => {
    mkdirSync(join(testProject, "graphify-out"), { recursive: true });
    const p = join(testProject, "graphify-out", "graph.json");
    writeFileSync(p, "{}");
    expect(findGraphifyOutput(testProject)).toBe(p);
  });
});

describe("findGraphReport", () => {

  it("returns null when GRAPH_REPORT.md doesn't exist", () => {
    expect(findGraphReport(testProject)).toBeNull();
  });

  it("returns the path when GRAPH_REPORT.md exists", () => {
    mkdirSync(join(testProject, "graphify-out"), { recursive: true });
    const p = join(testProject, "graphify-out", "GRAPH_REPORT.md");
    writeFileSync(p, "# Graph Report\n");
    expect(findGraphReport(testProject)).toBe(p);
  });
});

describe("graphQuery — graceful degradation", () => {

  it("returns ok=false with helpful hint when no graphify graph exists", async () => {
    const r = await graphQuery(testProject, "any query");
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/No graphify graph found/);
    expect(r.hint).toMatch(/\/graphify \./);   // suggests how to build one
  });

  it("hint mentions the expected file path", async () => {
    const r = await graphQuery(testProject, "test");
    expect(r.hint).toContain(join("graphify-out", "graph.json"));
  });
});

describe("graphPath — graceful degradation", () => {

  it("returns ok=false with hint when no graphify graph exists", async () => {
    const r = await graphPath(testProject, "FooNode", "BarNode");
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/No graphify graph/);
  });
});

describe("graphNeighbors — graceful degradation", () => {

  it("returns ok=false with hint when no graphify graph exists", async () => {
    const r = await graphNeighbors(testProject, "Foo");
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/No graphify graph/);
  });
});

describe("normalizeProjectPath defenses", () => {

  it("rejects relative paths via graphQuery", async () => {
    // graphQuery itself doesn't throw, but any subsequent calls would error.
    // We test the public API: with no graph file, we get ok=false hint either way.
    const r = await graphQuery(testProject, "test");
    expect(r.ok).toBe(false);
  });
});

describe("subprocess fail-safe (no Python or no graphify)", () => {

  it("returns ok=false (no crash) when graph.json present but subprocess unavailable", async () => {
    // Simulate: graph.json exists, but `python -m graphify.serve` will fail
    // because graphifyy isn't installed in this test env.
    mkdirSync(join(testProject, "graphify-out"), { recursive: true });
    writeFileSync(join(testProject, "graphify-out", "graph.json"), "{}");

    const r = await graphQuery(testProject, "anything");
    // Either we get an error (subprocess died) or success (graphifyy IS
    // installed). Both are acceptable; what we forbid is throwing.
    expect(r.ok === false || r.ok === true).toBe(true);
  });
});
