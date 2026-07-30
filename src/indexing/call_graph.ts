/**
 * Function call-graph extraction (v0.55.0)
 * ========================================
 *
 * Answers the question an agent cannot answer by reading one file:
 * "if I change this function, what breaks?"
 *
 * Sibling of ast_extractor.ts, which records what a file DECLARES. This
 * records what it CALLS, so the two compose into a directed graph stored
 * as `calls` edges in kb_edges (which already has the reverse index
 * idx_kbe_to — the "who calls me" query is free).
 *
 * Real AST, not regex. Deliberate: a regex graph reports "no callers" for
 * anything invoked as obj.method(), and a confident zero is worse than no
 * answer. ast_extractor.ts can use regex because a missed export is a
 * thinner summary; a missed CALLER is a green test suite and a broken
 * caller in production.
 *
 * Two phases, because resolution is repo-wide but parsing is per-file:
 *   1. extractFileCalls(content, path)  — declarations + call sites, no resolution
 *   2. resolveCallGraph(files)          — names → edges, against every declaration
 *
 * That split is what makes incremental refresh cheap: re-parse the one
 * changed file, re-resolve against the existing declaration index.
 */

import { detectLanguage } from "./ast_extractor.js";

// ─── Public types ──────────────────────────────────────────────────────────

/** A function/method declared in the repo. */
export interface CallDecl {
  symbol: string;
  path:   string;
  line:   number;
  /**
   * Last line of the declaration. Lets a changed line be attributed to the
   * function that contains it, which is what the commit-time advisory needs —
   * without it, a diff can only be reported per FILE, and "you touched
   * api-server.ts" is not an impact answer.
   */
  endLine: number;
}

/** One invocation, before resolution. `from` is the enclosing symbol. */
export interface CallSite {
  from:   string;
  callee: string;
  line:   number;
  /** obj.foo() rather than foo(). Only bare identifiers can bind to an import. */
  viaProperty: boolean;
}

/** A named import, with the file it resolves to when that is knowable. */
export interface ImportBinding {
  /** Original exported name — differs from the local name for `a as b`. */
  name: string;
  /** Repo-relative path of the declaring file, or null for bare/node_modules specifiers. */
  from: string | null;
}

export interface FileCalls {
  path:  string;
  decls: CallDecl[];
  sites: CallSite[];
  /**
   * localName -> what it actually refers to. Both halves were forced by the
   * oracle, not by fixtures:
   *   - the alias half: `import { projectHash as scopedProjectHash }` meant
   *     47 call sites resolved to nothing and the target read "no callers".
   *   - the module half: projectHash is declared TWICE (store.ts,
   *     access-control.ts), so name-only resolution then buried all 47 as
   *     ambiguous — a second fabricated zero on the same symbol.
   * The import specifier says which one the caller meant. Use it.
   */
  imports: Record<string, ImportBinding>;
  /** Calls whose callee could not be named at all — handlers[t](), (await f)(). */
  dynamicSites: number;
}

export type CallRelation = "calls" | "calls_ambiguous";

export interface CallEdge {
  /** func:<path>#<symbol> */
  from:     string;
  to:       string;
  relation: CallRelation;
  /** Number of call sites this pair represents. Two functions can call each other 9 times. */
  sites:    number;
}

export interface CallGraph {
  edges: CallEdge[];
  stats: {
    files:        number;
    decls:        number;
    callSites:    number;
    resolved:     number;
    ambiguous:    number;
    /** Named but declared nowhere in the repo — console.log, JSON.parse, node builtins. */
    external:     number;
    /** Not nameable at all. THIS is the coverage hole that must be surfaced to agents. */
    dynamicSites: number;
  };
}

// ─── Parser availability ───────────────────────────────────────────────────

/**
 * `typescript` is a devDependency, so `npm i --omit=dev` has no parser.
 * Load it lazily and let the caller distinguish "no callers" from "could
 * not look" — the whole point of this module is not fabricating zeros.
 */
let tsModule: any;
let tsLoadFailed = false;

async function loadTs(): Promise<any | null> {
  if (tsModule) return tsModule;
  if (tsLoadFailed) return null;
  try {
    tsModule = (await import("typescript")).default ?? (await import("typescript"));
    return tsModule;
  } catch {
    tsLoadFailed = true;
    return null;
  }
}

/** True if call extraction can actually run. Callers MUST branch on this. */
export async function callGraphAvailable(): Promise<boolean> {
  return (await loadTs()) !== null;
}

// ─── Ambiguity control ─────────────────────────────────────────────────────

/**
 * Resolution is name-based, so `store.close()` and `db.close()` and
 * `server.close()` all look like a call to whatever `close` the repo
 * happens to declare. The feasibility probe reported "70 callers of
 * close" — confident and meaningless.
 *
 * Names here are never counted as fan-in even when exactly one
 * declaration matches; they are recorded as `calls_ambiguous` so the
 * information is not lost, just not trusted.
 *
 * ponytail: name-based resolution with a denylist. Receiver-type
 * resolution needs a full ts.Program over the repo — upgrade to that if
 * the ambiguous bucket ever gets used for anything load-bearing.
 */
const AMBIGUOUS_NAMES = new Set([
  // container / iterable protocol
  "add", "get", "set", "has", "delete", "clear", "push", "pop", "shift", "unshift",
  "map", "filter", "forEach", "find", "some", "every", "reduce", "sort", "concat",
  "slice", "splice", "join", "keys", "values", "entries", "includes", "indexOf",
  // string
  "split", "trim", "replace", "match", "test", "toString", "padStart", "padEnd",
  "toLowerCase", "toUpperCase", "startsWith", "endsWith", "repeat", "substring",
  // promise / stream / lifecycle
  "then", "catch", "finally", "resolve", "reject", "all", "race",
  "on", "off", "once", "emit", "close", "end", "destroy", "next", "return",
  "open", "start", "stop", "init", "run", "exec", "send", "write", "read",
  // json / http
  "json", "text", "parse", "stringify", "status", "send", "query",
]);

// ─── Phase 1: per-file extraction ──────────────────────────────────────────

/**
 * Parse one TS/JS file into declarations and call sites.
 *
 * Returns null when the file is not TS/JS, is empty, or the parser is
 * unavailable — all three mean "no information", NOT "no callers".
 * Never throws.
 */
export async function extractFileCalls(content: string, path: string): Promise<FileCalls | null> {
  const lang = detectLanguage(path);
  if (lang !== "typescript" && lang !== "javascript") return null;
  if (!content || content.trim().length === 0) return null;
  if (content.length > 5_000_000) return null;

  const ts = await loadTs();
  if (!ts) return null;

  try {
    const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, /* setParentNodes */ true);
    const decls: CallDecl[] = [];
    const sites: CallSite[] = [];
    const imports: Record<string, ImportBinding> = {};
    let dynamicSites = 0;

    const lineOf = (node: any): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

    /** Name of a node that introduces a callable, else null. */
    const declaredName = (node: any): string | null => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
        return node.name.getText(sf);
      }
      // const foo = () => {} / const foo = function () {}
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
        ts.isIdentifier(node.name)
      ) {
        return node.name.getText(sf);
      }
      return null;
    };

    // Innermost enclosing named callable, so an edge is attributed to a real caller.
    const enclosing: string[] = [];

    const visit = (node: any): void => {
      const name = declaredName(node);
      if (name) {
        decls.push({
          symbol: name, path,
          line:    lineOf(node),
          endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
        });
        enclosing.push(name);
      }

      // Named imports, aliased or not — both the original name and the file
      // it came from, so a call can be tied to one declaration exactly.
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          const from = resolveModule(path, node.moduleSpecifier.text);
          for (const el of named.elements) {
            imports[el.name.getText(sf)] = {
              name: (el.propertyName ?? el.name).getText(sf),
              from,
            };
          }
        }
      }

      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        let name: string | null = null;
        let viaProperty = false;
        if (ts.isIdentifier(callee)) {
          name = callee.getText(sf);                 // foo()
        } else if (ts.isPropertyAccessExpression(callee)) {
          name = callee.name.getText(sf);            // obj.foo()
          viaProperty = true;
        }

        if (name) {
          sites.push({ from: enclosing[enclosing.length - 1] ?? "<top>", callee: name, line: lineOf(node), viaProperty });
        } else {
          dynamicSites++;                            // handlers[t](), (await f)()
        }
      }

      ts.forEachChild(node, visit);
      if (name) enclosing.pop();
    };

    visit(sf);
    return { path, decls, sites, imports, dynamicSites };
  } catch {
    return null;
  }
}

// ─── Phase 2: repo-wide resolution ─────────────────────────────────────────

export const nodeId = (path: string, symbol: string): string => `func:${path}#${symbol}`;

/**
 * Repo-relative path an import specifier points at, or null for bare
 * specifiers (node builtins, node_modules) which are never repo nodes.
 *
 * ESM emits `./store.js` for `store.ts`, so the extension is rewritten.
 * Purely lexical — no filesystem access, so this stays usable on content
 * that is not on disk.
 */
export function resolveModule(fromPath: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const parts = fromPath.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/").replace(/\.(js|mjs|cjs)$/, ".ts");
}

/**
 * Resolve call sites against every declaration in the repo.
 *
 * A `calls` edge is emitted ONLY when the callee name matches exactly one
 * declaration and is not a common method name. Everything else that
 * matched something becomes `calls_ambiguous` — recorded, never counted
 * as fan-in. Names matching nothing are external and dropped.
 */
export function resolveCallGraph(files: FileCalls[]): CallGraph {
  const declIndex = new Map<string, CallDecl[]>();
  for (const f of files) {
    for (const d of f.decls) {
      const list = declIndex.get(d.symbol);
      if (list) list.push(d);
      else declIndex.set(d.symbol, [d]);
    }
  }

  // from|to|relation -> site count
  const weights = new Map<string, number>();
  let resolved = 0, ambiguous = 0, external = 0, callSites = 0, dynamicSites = 0, declCount = 0;

  for (const f of files) {
    declCount += f.decls.length;
    dynamicSites += f.dynamicSites;
    for (const site of f.sites) {
      callSites++;

      // Only a bare identifier can refer to an import; obj.close() never does.
      const binding = site.viaProperty ? undefined : f.imports[site.callee];
      const callee = binding?.name ?? site.callee;
      const all = declIndex.get(callee);
      if (!all) { external++; continue; }

      // Two things settle a same-name collision, in the order a reader would:
      //  - an explicit import names the file (`import { close }` is that close,
      //    unlike a stray db.close());
      //  - otherwise a declaration in this very file wins, because that is what
      //    lexical scope does. Without this, two files each declaring a private
      //    `ph` helper made all 36 of their local calls ambiguous — the tool
      //    blaming the code for its own name-only resolution.
      const pinned   = binding?.from ? all.filter(t => t.path === binding.from) : [];
      const sameFile = all.filter(t => t.path === f.path);

      // A property call has an unknown receiver, so a common name stays untrusted
      // even when this file happens to declare one: `db.close()` is not our close.
      const localTrustworthy =
        sameFile.length === 1 && !(site.viaProperty && AMBIGUOUS_NAMES.has(callee));

      let targets: CallDecl[];
      let relation: CallRelation;
      if (pinned.length === 1) {
        targets = pinned;   relation = "calls";
      } else if (localTrustworthy) {
        targets = sameFile; relation = "calls";
      } else {
        targets = all;
        relation = all.length > 1 || AMBIGUOUS_NAMES.has(callee) ? "calls_ambiguous" : "calls";
      }
      if (relation === "calls") resolved++; else ambiguous++;

      const from = nodeId(f.path, site.from);
      for (const t of targets) {
        const to = nodeId(t.path, t.symbol);
        if (from === to) continue;                   // self-recursion is not impact
        const key = `${from} ${to} ${relation}`;
        weights.set(key, (weights.get(key) ?? 0) + 1);
      }
    }
  }

  const edges: CallEdge[] = [];
  for (const [key, sites] of weights) {
    const [from, to, relation] = key.split(" ");
    edges.push({ from, to, relation: relation as CallRelation, sites });
  }

  return {
    edges,
    stats: { files: files.length, decls: declCount, callSites, resolved, ambiguous, external, dynamicSites },
  };
}

// ─── Impact query ──────────────────────────────────────────────────────────

export interface Impact {
  symbol:  string;
  /** Distinct calling functions. "How many places must I check." */
  callers: number;
  /** Total call sites. "How many edits might be needed." */
  sites:   number;
  files:   string[];
  /** Same-shape counts for edges we deliberately do not trust. */
  ambiguousCallers: number;
}

/**
 * Fan-in for one node, from an in-memory graph. The persisted equivalent
 * (stage 2) is a single indexed query on kb_edges(to_source).
 */
export function impactOf(graph: CallGraph, target: string): Impact {
  const files = new Set<string>();
  let callers = 0, sites = 0, ambiguousCallers = 0;

  for (const e of graph.edges) {
    if (e.to !== target) continue;
    if (e.relation === "calls_ambiguous") { ambiguousCallers++; continue; }
    callers++;
    sites += e.sites;
    files.add(e.from.slice("func:".length).split("#")[0]);
  }

  return {
    symbol: target.slice("func:".length).split("#")[1] ?? target,
    callers,
    sites,
    files: [...files].sort(),
    ambiguousCallers,
  };
}
