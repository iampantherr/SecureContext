/**
 * Cross-repo dependency edges (v0.55.0)
 * =====================================
 *
 * The call graph stops at the repository boundary, and that is exactly where the
 * most expensive breakages live. Concrete case from 2026-07-30: SC gained
 * `GET /api/v1/agent-activity`, and A2A_dispatcher's turn-death detector depends
 * on it. Nothing in SC records that. Rename or reshape the route and SC's 1084
 * tests stay green while the dispatcher silently goes blind — the same
 * success-shaped failure the rest of this work exists to prevent.
 *
 * Two edge kinds, both cheap and both static:
 *
 *   http_calls   consumer function  ->  route:<file>#<METHOD path>   (provider)
 *   spawns       consumer function  ->  script:<path>                 (provider)
 *
 * Edges are stored in the PROVIDER's graph, because the provider is who needs
 * the warning. An SC developer reading api-server.ts should see that a different
 * repository depends on the route they are about to change.
 *
 * Deliberately NOT attempted: matching the HTTP verb at the call site. A fetch's
 * method often lives in an options object several lines from the URL, and a
 * wrong verb would be a confident wrong answer. Path-level coupling is the real
 * signal; the verb is decoration.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import type { CallEdge } from "./call_graph.js";
import { extractFileCalls } from "./call_graph.js";

export const ROUTE_PREFIX  = "route:";
export const SCRIPT_PREFIX = "script:";
export const HTTP_RELATION   = "http_calls";
export const SPAWN_RELATION  = "spawns";

export interface RouteDef {
  /** e.g. "GET /api/v1/agent-activity" */
  signature: string;
  path:      string;   // repo-relative file that declares it
  line:      number;
}

/** `route:<file>#<METHOD> <path>` — same shape as func: so file-scoped queries work. */
export const routeNode = (file: string, signature: string): string =>
  `${ROUTE_PREFIX}${file}#${signature}`;

// ─── Provider side: what routes and scripts does this repo expose? ─────────

const ROUTE_DEF = /\bapp\.(get|post|put|patch|delete)\(\s*["'`](\/[^"'`]*)["'`]/g;

/** Routes declared in one file, from fastify/express-style registrations. */
export function extractRouteDefs(content: string, file: string): RouteDef[] {
  const out: RouteDef[] = [];
  for (const m of content.matchAll(ROUTE_DEF)) {
    const line = content.slice(0, m.index).split("\n").length;
    out.push({ signature: `${m[1]!.toUpperCase()} ${m[2]!}`, path: file, line });
  }
  return out;
}

// ─── Consumer side: what does this repo reach for? ─────────────────────────

/**
 * A route path anywhere in the source, NOT only immediately after a quote.
 *
 * The first version required `["'\`]` directly before `/api/`, which missed the
 * dominant real-world form — `fetch(\`${ZC_API_URL}/api/v1/operator-inbox\`)` —
 * because the base URL sits between the backtick and the path. It found 3 edges
 * where 9 call sites existed, and would have reported "nothing depends on this"
 * for routes that three functions call.
 */
const URL_LITERAL = /(\/api\/[A-Za-z0-9/_.$-]*)/g;
const PS1_LITERAL = /["'`]?([A-Za-z0-9_.-]+\.ps1)["'`]?/g;

export interface Usage {
  target: string;   // the route path or script name
  from:   string;   // enclosing function in the consumer
  line:   number;
}

/**
 * Route paths and .ps1 scripts referenced by a consumer file, attributed to the
 * enclosing function so the edge names a caller rather than a whole file.
 *
 * Template-literal URLs (`${base}/api/v1/queue?x=1`) keep only the static
 * prefix, which is what a route match needs.
 */
export async function extractUsages(content: string, file: string): Promise<{ http: Usage[]; scripts: Usage[] }> {
  const parsed = await extractFileCalls(content, file);
  // Line -> enclosing function, derived from the call sites the AST already found.
  const fnByLine = new Map<number, string>();
  for (const s of parsed?.sites ?? []) fnByLine.set(s.line, s.from);

  const enclosing = (line: number): string => {
    for (let l = line; l > 0 && line - l < 200; l--) {
      const f = fnByLine.get(l);
      if (f && f !== "<top>") return f;
    }
    return "<top>";
  };

  const collect = (re: RegExp, filter: (s: string) => boolean): Usage[] => {
    const seen = new Set<string>();
    const out: Usage[] = [];
    for (const m of content.matchAll(re)) {
      const target = m[1]!;
      if (!filter(target)) continue;
      const line = content.slice(0, m.index).split("\n").length;
      const from = enclosing(line);
      const key = `${from}|${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ target, from, line });
    }
    return out;
  };

  return {
    http:    collect(URL_LITERAL, (t) => t.length > 5),
    scripts: collect(PS1_LITERAL, (t) => t.endsWith(".ps1")),
  };
}

// ─── Matching consumer usages to provider declarations ─────────────────────

/**
 * Longest-prefix match of a used URL against declared routes.
 *
 * Fastify paths carry parameters (`/api/v1/operator-inbox/:id`) that a caller
 * fills in, so exact equality would miss real dependencies. Matching on the
 * static prefix up to the first parameter keeps it honest without inventing a
 * router.
 */
function matchRoute(used: string, routes: RouteDef[]): RouteDef | null {
  let best: RouteDef | null = null;
  let bestLen = 0;
  for (const r of routes) {
    const declared = r.signature.split(" ")[1]!;
    const stat = declared.split("/:")[0]!;          // static prefix
    if (used === declared || used === stat || used.startsWith(stat + "/") || used.startsWith(stat + "?")) {
      if (stat.length > bestLen) { best = r; bestLen = stat.length; }
    }
  }
  return best;
}

export interface CrossRepoResult {
  edges: CallEdge[];
  /** Route paths a consumer calls that this provider does not declare. */
  unmatched: Array<{ consumer: string; target: string; from: string }>;
  consumersScanned: number;
  filesScanned:     number;
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const VENDOR_DIRS = new Set([
  "node_modules", "dist", "build", ".git",
  "venv", ".venv", "site-packages", "__pycache__", "vendor", "out", ".next",
]);

function listFiles(root: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(root); } catch { return out; }
  for (const name of entries) {
    // Vendored trees are not this project's code. Without site-packages/venv a
    // bundled litellm JS chunk was reported as a consumer of /api/v1/models.
    if (VENDOR_DIRS.has(name) || name.startsWith(".")) continue;
    const abs = join(root, name);
    let isDir: boolean;
    try { isDir = statSync(abs).isDirectory(); } catch { continue; }
    if (isDir) listFiles(abs, out);
    else if (SOURCE_EXT.test(name)) out.push(abs);
  }
  return out;
}

/**
 * Build edges from consumer repos into this provider's routes and scripts.
 *
 * `unmatched` is returned rather than dropped: a consumer calling a route the
 * provider does not declare is either a stale caller or a route that moved, and
 * both are worth seeing. Silently discarding them would make the result look
 * complete when it is not.
 */
export async function buildCrossRepoEdges(
  providerRoot: string,
  consumerRoots: string[],
): Promise<CrossRepoResult> {
  const routes: RouteDef[] = [];
  const scripts = new Set<string>();

  for (const abs of listFiles(providerRoot)) {
    const rel = relative(providerRoot, abs).split("\\").join("/");
    let content: string;
    try { content = readFileSync(abs, "utf8"); } catch { continue; }
    routes.push(...extractRouteDefs(content, rel));
  }
  // Provider-side scripts a consumer might invoke.
  for (const abs of listFilesByExt(providerRoot, ".ps1")) {
    scripts.add(basename(abs));
  }

  // The path namespaces this provider actually serves, e.g. "/api/v1".
  const servedNamespaces = new Set(routes.map((r) => namespaceOf(r.signature.split(" ")[1]!)));

  const edges: CallEdge[] = [];
  const unmatched: CrossRepoResult["unmatched"] = [];
  let filesScanned = 0;

  for (const consumerRoot of consumerRoots) {
    if (!existsSync(consumerRoot)) continue;
    const consumerName = basename(consumerRoot);
    for (const abs of listFiles(consumerRoot)) {
      filesScanned++;
      const rel = relative(consumerRoot, abs).split("\\").join("/");
      let content: string;
      try { content = readFileSync(abs, "utf8"); } catch { continue; }
      if (!content.includes("/api/") && !content.includes(".ps1")) continue;   // cheap prefilter

      const { http, scripts: used } = await extractUsages(content, rel);
      const from = (fn: string) => `func:${consumerName}/${rel}#${fn}`;

      for (const u of http) {
        const hit = matchRoute(u.target, routes);
        if (!hit) {
          // Only report a miss for paths that plausibly target THIS provider.
          // Without this, a consumer with its own HTTP API (A2A's Next.js
          // frontend has ~479 of them) drowns the real misses in its own
          // internal routes, and a list nobody reads is the same as no list.
          if (servedNamespaces.has(namespaceOf(u.target))) {
            unmatched.push({ consumer: consumerName, target: u.target, from: from(u.from) });
          }
          continue;
        }
        edges.push({ from: from(u.from), to: routeNode(hit.path, hit.signature), relation: "calls", sites: 1 });
      }
      for (const u of used) {
        if (!scripts.has(u.target)) continue;
        edges.push({ from: from(u.from), to: `${SCRIPT_PREFIX}${u.target}`, relation: "calls", sites: 1 });
      }
    }
  }

  return { edges: dedupe(edges), unmatched, consumersScanned: consumerRoots.length, filesScanned };
}

function listFilesByExt(root: string, ext: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(root); } catch { return out; }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git") continue;
    const abs = join(root, name);
    let isDir: boolean;
    try { isDir = statSync(abs).isDirectory(); } catch { continue; }
    if (isDir) listFilesByExt(abs, ext, out);
    else if (name.endsWith(ext)) out.push(abs);
  }
  return out;
}

function dedupe(edges: CallEdge[]): CallEdge[] {
  const byKey = new Map<string, CallEdge>();
  for (const e of edges) {
    const k = `${e.from}|${e.to}`;
    const prev = byKey.get(k);
    if (prev) prev.sites += e.sites;
    else byKey.set(k, { ...e });
  }
  return [...byKey.values()];
}

/**
 * Sibling git repositories of the provider — the default consumer set.
 *
 * Opt-in via ZC_CROSS_REPO_SCAN=1, because walking every sibling repo is real
 * work and most projects have no cross-repo consumers. ZC_CROSS_REPO_ROOTS
 * (path-separator delimited) overrides the discovery entirely.
 */
export function discoverConsumerRoots(providerRoot: string): string[] {
  const explicit = process.env.ZC_CROSS_REPO_ROOTS;
  if (explicit) return explicit.split(/[;:](?![\\/])/).map((s) => s.trim()).filter(Boolean);
  if (process.env.ZC_CROSS_REPO_SCAN !== "1") return [];

  const parent = join(providerRoot, "..");
  let entries: string[];
  try { entries = readdirSync(parent); } catch { return []; }
  return entries
    .map((n) => join(parent, n))
    .filter((p) => p !== providerRoot && existsSync(join(p, ".git")));
}

/** First two path segments, e.g. "/api/v1/queue/stats" -> "/api/v1". */
function namespaceOf(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return "/" + parts.slice(0, 2).join("/");
}
