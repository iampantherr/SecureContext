/**
 * graphify integration proxy (v0.13.0)
 * =====================================
 *
 * Spawns + speaks to a `graphify.serve` MCP subprocess so SC's MCP tools
 * can query the structural knowledge graph that graphify built. Adds three
 * new SC tools (zc_graph_query, zc_graph_path, zc_graph_neighbors) that
 * forward to graphify's exposed MCP methods (query_graph, get_node,
 * get_neighbors, shortest_path).
 *
 * WHY THIS EXISTS
 * ---------------
 * graphify (https://github.com/safishamsi/graphify) builds a structural
 * knowledge graph of a codebase using tree-sitter AST + Claude subagents
 * and exposes it as MCP. SC's strength is persistent state + multi-agent
 * coordination + telemetry; graphify's strength is structural map of code
 * + multimodal corpus. They stack multiplicatively for token savings on
 * architectural questions:
 *
 *   "How does auth work?"
 *     Without either: read 5-10 auth files (~25k tokens)
 *     SC alone:       BM25/vector chunks (~2k tokens)
 *     graphify alone: god-node + community (~500 tokens orient)
 *     STACKED:        graph orient → SC fetch precise ~1.5k tokens
 *
 * DESIGN
 * ------
 * - graphify is OPTIONAL. SC works without Python or graphify installed.
 * - When called, we look for `graphify-out/graph.json` in the project.
 *   If absent: return a helpful "run /graphify ." hint.
 *   If present: spawn `python -m graphify.serve graphify-out/graph.json`
 *   over stdio, send a JSON-RPC request, return the response.
 * - Lazy spawn — no graphify subprocess until first zc_graph_* call.
 * - Subprocess is reused across calls within a session (cached handle).
 *
 * SECURITY
 * --------
 * - graphify subprocess runs with the SAME UID as the SC server (no
 *   privilege escalation).
 * - Project path is normalized + validated before being passed (no shell
 *   interpolation; uses spawn with arg array).
 * - Subprocess timeout: 10 s per call.
 * - Stderr output is captured + logged at WARN level (debugging surface).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { logger } from "./logger.js";

// ─── Cache: per-project graphify subprocess + JSON-RPC channel ─────────────

interface GraphifyHandle {
  proc:       ChildProcessWithoutNullStreams;
  buffer:     string;
  pendingResolvers: Map<number, (val: unknown) => void>;
  pendingRejecters: Map<number, (err: Error) => void>;
  nextRequestId: number;
}

const _handles = new Map<string, GraphifyHandle>();
const SUBPROCESS_TIMEOUT_MS = 10_000;
const PYTHON_CMD = process.env.ZC_PYTHON_CMD || (process.platform === "win32" ? "python" : "python3");

/** Normalize + validate project path — defense against weird inputs. */
function normalizeProjectPath(projectPath: string): string {
  if (typeof projectPath !== "string" || !projectPath) {
    throw new Error("graph_proxy: projectPath must be a non-empty string");
  }
  if (!isAbsolute(projectPath)) {
    throw new Error(`graph_proxy: projectPath must be absolute, got: ${projectPath}`);
  }
  return resolve(projectPath);
}

/** Locate graphify-out/graph.json relative to a project. Returns null if absent. */
export function findGraphifyOutput(projectPath: string): string | null {
  const candidate = join(projectPath, "graphify-out", "graph.json");
  try {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  } catch { /* fall through */ }
  return null;
}

/** Locate GRAPH_REPORT.md alongside graph.json. Returns null if absent. */
export function findGraphReport(projectPath: string): string | null {
  const candidate = join(projectPath, "graphify-out", "GRAPH_REPORT.md");
  try {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  } catch { /* fall through */ }
  return null;
}

/**
 * Lazily spawn (or reuse) a graphify.serve subprocess for a project.
 * Returns null if graphify-out/graph.json is missing (caller should hint).
 */
async function ensureHandle(projectPath: string): Promise<GraphifyHandle | null> {
  projectPath = normalizeProjectPath(projectPath);
  const existing = _handles.get(projectPath);
  if (existing && !existing.proc.killed) return existing;

  const graphPath = findGraphifyOutput(projectPath);
  if (!graphPath) return null;

  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(PYTHON_CMD, ["-m", "graphify.serve", graphPath], {
      cwd:   projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env:   { ...process.env },
    });
  } catch (e) {
    logger.warn("retrieval", "graphify_spawn_failed", { error: (e as Error).message });
    return null;
  }

  const handle: GraphifyHandle = {
    proc,
    buffer: "",
    pendingResolvers: new Map(),
    pendingRejecters: new Map(),
    nextRequestId: 1,
  };

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    handle.buffer += chunk;
    // graphify uses NDJSON or JSON-RPC over stdio. Try parsing complete lines.
    let nl;
    while ((nl = handle.buffer.indexOf("\n")) !== -1) {
      const line = handle.buffer.slice(0, nl).trim();
      handle.buffer = handle.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        if (typeof msg.id !== "number") continue;
        const resolveFn = handle.pendingResolvers.get(msg.id);
        const rejectFn  = handle.pendingRejecters.get(msg.id);
        if (resolveFn && rejectFn) {
          handle.pendingResolvers.delete(msg.id);
          handle.pendingRejecters.delete(msg.id);
          if (msg.error) rejectFn(new Error(msg.error.message ?? "graphify error"));
          else resolveFn(msg.result);
        }
      } catch {
        // malformed line — log + continue
        logger.debug("retrieval", "graphify_parse_skip", { line: line.slice(0, 200) });
      }
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    logger.warn("retrieval", "graphify_stderr", { msg: chunk.toString().slice(0, 500) });
  });

  proc.on("exit", (code) => {
    logger.info("retrieval", "graphify_subprocess_exit", { code });
    _handles.delete(projectPath);
    // Reject any in-flight requests
    for (const [, reject] of handle.pendingRejecters) {
      reject(new Error(`graphify subprocess exited with code ${code}`));
    }
    handle.pendingResolvers.clear();
    handle.pendingRejecters.clear();
  });

  _handles.set(projectPath, handle);
  return handle;
}

/**
 * Send a JSON-RPC request to the graphify subprocess and await its reply.
 * Returns null on timeout, missing subprocess, or error.
 */
async function callGraphify(
  projectPath: string,
  method:      string,
  params:      Record<string, unknown>,
): Promise<unknown | null> {
  const handle = await ensureHandle(projectPath);
  if (!handle) return null;

  const id = handle.nextRequestId++;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

  const responsePromise = new Promise<unknown>((resolve, reject) => {
    handle.pendingResolvers.set(id, resolve);
    handle.pendingRejecters.set(id, reject);
  });

  try {
    handle.proc.stdin.write(msg);
  } catch (e) {
    handle.pendingResolvers.delete(id);
    handle.pendingRejecters.delete(id);
    logger.warn("retrieval", "graphify_write_failed", { error: (e as Error).message });
    return null;
  }

  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => {
      handle.pendingResolvers.delete(id);
      handle.pendingRejecters.delete(id);
      logger.warn("retrieval", "graphify_call_timeout", { method, id });
      resolve(null);
    }, SUBPROCESS_TIMEOUT_MS);
  });

  return Promise.race([responsePromise, timeoutPromise]).catch((e) => {
    logger.warn("retrieval", "graphify_call_error", { method, error: (e as Error).message });
    return null;
  });
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface GraphQueryResult {
  ok:       boolean;
  hint?:    string;             // human-readable guidance when graphify isn't set up
  data?:    unknown;            // forwarded from graphify
  error?:   string;
}

/**
 * Query the graph in natural language. Forwards to graphify's `query_graph`.
 * Returns matching nodes with relationships and confidence tags.
 */
export async function graphQuery(projectPath: string, query: string): Promise<GraphQueryResult> {
  if (!findGraphifyOutput(projectPath)) {
    return {
      ok:   false,
      hint: `No graphify graph found at ${join(projectPath, "graphify-out", "graph.json")}. ` +
            `Run \`/graphify .\` in this project (requires the graphify CLI: \`pip install graphifyy && graphify install\`). ` +
            `Then retry zc_graph_query.`,
    };
  }
  const result = await callGraphify(projectPath, "query_graph", { query });
  if (result === null) return { ok: false, error: "graphify call failed (see logs)" };
  return { ok: true, data: result };
}

/**
 * Find the shortest path between two named nodes. Forwards to graphify's
 * `shortest_path`. Useful for "how does X connect to Y" questions.
 */
export async function graphPath(projectPath: string, from: string, to: string): Promise<GraphQueryResult> {
  if (!findGraphifyOutput(projectPath)) {
    return { ok: false, hint: `No graphify graph found. Run \`/graphify .\` first.` };
  }
  const result = await callGraphify(projectPath, "shortest_path", { from, to });
  if (result === null) return { ok: false, error: "graphify call failed" };
  return { ok: true, data: result };
}

/**
 * Get the immediate neighbors of a named node. Forwards to graphify's
 * `get_neighbors`. Useful for "what's related to X" questions.
 */
export async function graphNeighbors(projectPath: string, node: string): Promise<GraphQueryResult> {
  if (!findGraphifyOutput(projectPath)) {
    return { ok: false, hint: `No graphify graph found. Run \`/graphify .\` first.` };
  }
  const result = await callGraphify(projectPath, "get_neighbors", { node });
  if (result === null) return { ok: false, error: "graphify call failed" };
  return { ok: true, data: result };
}

/** Shut down all cached graphify subprocesses (called on SC server exit). */
export function shutdownAllGraphifyHandles(): void {
  for (const [, handle] of _handles) {
    try { handle.proc.kill(); } catch { /* ignore */ }
  }
  _handles.clear();
}
