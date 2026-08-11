/**
 * Evidence-record tests.
 *
 * The regression fixture is the real incident: a probe run against the hub,
 * written up as a claim about the console. The parsing must keep those two
 * distinguishable, and replay must never execute a shell.
 */
import { describe, it, expect } from "vitest";
import { parseHttpProbe, parseStatus, extractHttpAssertions, replayProbe } from "./evidence.js";

describe("parseHttpProbe", () => {
  it("extracts the URL from a real curl invocation", () => {
    const p = parseHttpProbe(`curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:3020/api/soc/compliance?framework=soc2"`);
    expect(p).toEqual({ method: "GET", url: "http://localhost:3020/api/soc/compliance?framework=soc2" });
  });

  it("keeps hub and console probes distinct — the whole incident", () => {
    const hub = parseHttpProbe("curl http://localhost:8001/api/soc/compliance?framework=soc2");
    const con = parseHttpProbe("curl http://localhost:3020/api/soc/compliance?framework=soc2");
    expect(hub!.url).not.toBe(con!.url);
  });

  it("handles a bare verb form", () => {
    expect(parseHttpProbe("GET http://h/x")).toEqual({ method: "GET", url: "http://h/x" });
  });

  it("refuses non-HTTP commands rather than guessing", () => {
    expect(parseHttpProbe("psql -c 'select 1'")).toBeNull();
    expect(parseHttpProbe("rm -rf /")).toBeNull();
    expect(parseHttpProbe("")).toBeNull();
  });

  it("refuses state-changing methods — a recorded POST must not be re-fired", () => {
    expect(parseHttpProbe("curl -X POST http://h/x")).toBeNull();
    expect(parseHttpProbe("curl -X DELETE http://h/x")).toBeNull();
  });
});

describe("parseStatus", () => {
  it("reads a status out of the shapes agents write", () => {
    expect(parseStatus("200")).toBe(200);
    expect(parseStatus("HTTP 404")).toBe(404);
    expect(parseStatus("→ 307 redirect")).toBe(307);
  });
  it("returns null when there is no status to compare", () => {
    expect(parseStatus("renders the controls table")).toBeNull();
  });
});

describe("extractHttpAssertions", () => {
  it("pairs a URL with an explicit status in the same clause", () => {
    const a = extractHttpAssertions("probe http://localhost:8001/api/x returned 404");
    expect(a).toHaveLength(1);
    expect(a[0]!.url).toBe("http://localhost:8001/api/x");
    expect(a[0]!.status).toBe(404);
  });

  it("stays silent when there is no status — a miss beats a false refutation", () => {
    expect(extractHttpAssertions("the page at http://localhost:3020/compliance is empty")).toHaveLength(0);
  });

  it("ignores prose with no URL", () => {
    expect(extractHttpAssertions("all 34 criteria passed, 200 lines changed")).toHaveLength(0);
  });
});

describe("replayProbe", () => {
  it("reports non-HTTP probes as manual instead of executing them", async () => {
    const r = await replayProbe({
      claim: "table has 5 rows", probe_command: "psql -c 'select count(*)'",
      observed_output: "5", target_context: "pg",
    });
    expect(r.verdict).toBe("manual");
  });

  it("returns an error verdict, never a throw, on an unreachable target", async () => {
    const r = await replayProbe({
      claim: "x", probe_command: "curl http://127.0.0.1:9/nope",
      observed_output: "200", target_context: "nowhere",
    });
    expect(["error", "mismatch"]).toContain(r.verdict);
  });
});
