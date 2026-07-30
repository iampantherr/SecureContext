/**
 * Every declared MCP tool must actually dispatch (v0.55.0).
 *
 * Two tools shipped advertised-but-unreachable: zc_context_status and
 * zc_compact_window. Their handlers sat inside _handleRemoteTool, which only
 * runs for names listed in REMOTE_TOOLS — neither was listed, so the function
 * was never entered for them and every call returned "Unknown tool". Agents
 * could see both in their tool list, and the tool description for
 * zc_context_status even tells them when to call it.
 *
 * No test caught it because nothing asserted the link between the DECLARATION
 * (what agents can call) and the DISPATCH (what actually runs). A live E2E agent
 * found it by calling the tool. This closes that gap statically.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "server.ts"), "utf8");

/** Tool names advertised to agents. */
const declared = [...SRC.matchAll(/^\s+name: "(zc_[a-z_]+)"/gm)].map((m) => m[1]!);

/** Names routed to the API server. */
const remoteBlock = SRC.slice(SRC.indexOf("const REMOTE_TOOLS"), SRC.indexOf("]);", SRC.indexOf("const REMOTE_TOOLS")));
const remoteRouted = new Set([...remoteBlock.matchAll(/"(zc_[a-z_]+)"/g)].map((m) => m[1]!));

/** Case labels, split by the function they live in. */
const remoteFnStart = SRC.indexOf("async function _handleRemoteTool");
const dispatchStart = SRC.indexOf("async function dispatchToolCall");
const casesIn = (from: number, to: number) =>
  new Set([...SRC.slice(from, to).matchAll(/case "(zc_[a-z_]+)"/g)].map((m) => m[1]!));

const remoteCases = casesIn(remoteFnStart, dispatchStart);
const localCases  = casesIn(dispatchStart, SRC.length);

describe("MCP tool dispatch", () => {
  it("declares a plausible number of tools (guards against a broken parse)", () => {
    // If this regex ever stops matching, every assertion below would pass
    // vacuously — the exact failure mode this file exists to prevent.
    expect(declared.length).toBeGreaterThan(50);
    expect(new Set(declared).size).toBe(declared.length);   // no duplicate declarations
  });

  it("has a reachable handler for EVERY declared tool", () => {
    const unreachable = declared.filter((t) => {
      if (localCases.has(t)) return false;                       // handled locally
      if (remoteRouted.has(t) && remoteCases.has(t)) return false; // routed and handled remotely
      return true;
    });
    expect(unreachable, "declared but nothing dispatches them — agents get 'Unknown tool'").toEqual([]);
  });

  it("routes every remote-only handler through REMOTE_TOOLS", () => {
    // A case inside _handleRemoteTool that is not in REMOTE_TOOLS is dead code:
    // the function is never entered for it. This is the precise shape of the bug.
    const orphaned = [...remoteCases].filter((t) => !remoteRouted.has(t) && declared.includes(t));
    expect(orphaned, "handler lives in _handleRemoteTool but REMOTE_TOOLS never routes there").toEqual([]);
  });

  it("gives every REMOTE_TOOLS entry a local branch", () => {
    // With ZC_API_URL unset, a remote-routed tool falls through to the local
    // switch; without a case it dies on the default with "Unknown tool".
    //
    // This started as an informational log — and that softness was wrong. The
    // one tool it listed, zc_program, then failed in front of a real E2E agent
    // with exactly that error. A branch may simply explain that the API is
    // required, but a dead end is not acceptable for a tool agents can see.
    const noLocal = [...remoteRouted].filter((t) => declared.includes(t) && !localCases.has(t));
    expect(noLocal, "no local branch: these die on 'Unknown tool' without ZC_API_URL").toEqual([]);
  });
});
