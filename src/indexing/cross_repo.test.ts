/**
 * Tests for cross-repo dependency extraction (v0.55.0).
 *
 * The case that motivated it: SC added GET /api/v1/agent-activity and
 * A2A_dispatcher's turn-death detector depends on it. Rename the route and SC's
 * whole suite stays green while the dispatcher goes blind.
 */

import { describe, it, expect } from "vitest";
import { extractRouteDefs, extractUsages, routeNode } from "./cross_repo.js";

describe("extractRouteDefs", () => {
  it("finds fastify/express registrations with their verb", () => {
    const defs = extractRouteDefs(
      `app.get("/api/v1/agent-activity", h);\n` +
      `app.post('/api/v1/operator-inbox', h);\n` +
      `app.delete(\`/api/v1/thing/:id\`, h);`,
      "src/api-server.ts",
    );
    expect(defs.map((d) => d.signature)).toEqual([
      "GET /api/v1/agent-activity",
      "POST /api/v1/operator-inbox",
      "DELETE /api/v1/thing/:id",
    ]);
    expect(defs[0]!.path).toBe("src/api-server.ts");
  });

  it("ignores unrelated app method calls", () => {
    expect(extractRouteDefs(`app.listen(3000); app.register(plugin);`, "x.ts")).toEqual([]);
  });
});

describe("extractUsages", () => {
  it("finds a route inside a template literal with a base URL", async () => {
    // The original regex demanded a quote immediately before "/api/", so this
    // exact form -- the dominant one in real code -- matched nothing, and the
    // extractor reported 3 edges where 9 call sites existed.
    const { http } = await extractUsages(
      "async function fetchAgentActivity() {\n" +
      "  const r = await fetch(`${ZC_API_URL}/api/v1/agent-activity?limit=5`);\n" +
      "  return r.json();\n}",
      "dispatcher.mjs",
    );
    expect(http).toHaveLength(1);
    expect(http[0]!.target).toBe("/api/v1/agent-activity");
    expect(http[0]!.from).toBe("fetchAgentActivity");
  });

  it("attributes the usage to the enclosing function, not the file", async () => {
    const { http } = await extractUsages(
      "function a() { fetch(`${B}/api/v1/one`); }\n" +
      "function b() { fetch(`${B}/api/v1/two`); }",
      "c.mjs",
    );
    expect(http.map((u) => [u.from, u.target])).toEqual([
      ["a", "/api/v1/one"],
      ["b", "/api/v1/two"],
    ]);
  });

  it("picks up plain-string URLs too", async () => {
    const { http } = await extractUsages(`function f(){ get("/api/v1/queue/stats"); }`, "x.mjs");
    expect(http[0]!.target).toBe("/api/v1/queue/stats");
  });

  it("finds referenced PowerShell scripts", async () => {
    const { scripts } = await extractUsages(
      `function launch(){ spawn("powershell", ["-File", "spawn-agent.ps1"]); }`, "d.mjs");
    expect(scripts.map((s) => s.target)).toContain("spawn-agent.ps1");
  });
});

describe("routeNode", () => {
  it("is file-scoped so a file-impact query finds it alongside functions", () => {
    // getFileImpact matches on "<prefix>:<file>#", so the route must carry the
    // declaring file or an SC developer reading api-server.ts would never see it.
    expect(routeNode("src/api-server.ts", "GET /api/v1/x"))
      .toBe("route:src/api-server.ts#GET /api/v1/x");
  });
});
