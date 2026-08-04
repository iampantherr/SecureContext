/**
 * Python call-graph extraction (v0.56.0)
 * ======================================
 *
 * Fills the gap the TS/JS extractor left: Python files had L0/L1 summaries but
 * no call edges, so a Python read served a summary with no blast radius.
 *
 * Uses Python's OWN `ast` module — the same real-parser-not-regex decision the
 * TS side made, for the same reason: a regex graph reports "no callers" for
 * `obj.method()` and a confident zero is worse than no answer.
 *
 * ONE batch subprocess for the whole repo (file list on stdin, JSON on stdout),
 * not one per file — a 400-file repo must not pay 400 interpreter startups.
 * Output is the same FileCalls shape the shared resolver consumes, so
 * resolution, ambiguity handling, and import pinning stay in one place.
 */

import { spawnSync } from "node:child_process";
import type { FileCalls } from "./call_graph.js";

/**
 * The extractor that runs inside Python. Emits one JSON object per file:
 * { path, decls:[{symbol,line,endLine}], sites:[{from,callee,line,viaProperty}],
 *   imports:{local:{name,from}}, dynamicSites }
 */
const PY_SCRIPT = `
import ast, json, sys

def extract(path):
    try:
        with open(path, encoding="utf8", errors="replace") as f:
            tree = ast.parse(f.read())
    except Exception as e:
        return {"path": path, "error": str(e)[:200]}

    decls, sites, imports = [], [], {}
    dynamic = [0]

    class V(ast.NodeVisitor):
        def __init__(self):
            self.stack = []
        def visit_FunctionDef(self, node):
            decls.append({"symbol": node.name, "line": node.lineno,
                          "endLine": getattr(node, "end_lineno", node.lineno)})
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()
        visit_AsyncFunctionDef = visit_FunctionDef
        def visit_ImportFrom(self, node):
            # from x.y import a as b  ->  b: {name: a, from: "x/y.py"}
            mod = (node.module or "").replace(".", "/")
            for a in node.names:
                imports[a.asname or a.name] = {"name": a.name,
                    "from": (mod + ".py") if node.level == 0 and mod else None}
            self.generic_visit(node)
        def visit_Call(self, node):
            f = node.func
            frm = self.stack[-1] if self.stack else "<top>"
            if isinstance(f, ast.Name):
                sites.append({"from": frm, "callee": f.id, "line": node.lineno, "viaProperty": False})
            elif isinstance(f, ast.Attribute):
                sites.append({"from": frm, "callee": f.attr, "line": node.lineno, "viaProperty": True})
            else:
                dynamic[0] += 1          # lambda()(), d[k](), getattr(...)()
            self.generic_visit(node)

    V().visit(tree)
    return {"path": path, "decls": decls, "sites": sites,
            "imports": imports, "dynamicSites": dynamic[0]}

out = [extract(p) for p in sys.stdin.read().splitlines() if p.strip()]
print(json.dumps(out))
`;

/** True when a working python3 is on PATH. Callers MUST branch — same
 *  could-not-look-vs-nothing-depends discipline as the TS parser. */
export function pythonAvailable(): boolean {
  for (const exe of ["python", "python3"]) {
    const r = spawnSync(exe, ["-c", "import ast, json"], { timeout: 10_000 });
    if (r.status === 0) return true;
  }
  return false;
}

/**
 * Extract FileCalls for a batch of .py files (absolute paths in, repo-relative
 * paths keyed by the caller). Files that fail to parse are DROPPED with their
 * error carried in `errors` — never silently, because a parse failure means
 * "no information", not "no callers".
 */
export function extractPythonBatch(
  absPaths: string[],
  toRel: (abs: string) => string,
): { files: FileCalls[]; errors: Array<{ path: string; error: string }> } {
  if (absPaths.length === 0) return { files: [], errors: [] };

  let out: string | null = null;
  for (const exe of ["python", "python3"]) {
    const r = spawnSync(exe, ["-c", PY_SCRIPT], {
      input: absPaths.join("\n"),
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      timeout: 120_000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    if (r.status === 0 && r.stdout) { out = r.stdout; break; }
  }
  if (!out) return { files: [], errors: absPaths.map((p) => ({ path: toRel(p), error: "python unavailable or extractor failed" })) };

  const files: FileCalls[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  let parsed: Array<Record<string, unknown>>;
  try { parsed = JSON.parse(out); } catch {
    return { files: [], errors: [{ path: "(batch)", error: "extractor emitted invalid JSON" }] };
  }

  for (const f of parsed) {
    const rel = toRel(String(f.path));
    if (f.error) { errors.push({ path: rel, error: String(f.error) }); continue; }
    // Rebase python-module import targets onto repo-relative guesses. Name-based
    // resolution with import pinning tolerates a miss here — an unresolvable
    // `from` just falls back to name matching, same as TS bare specifiers.
    const imports: FileCalls["imports"] = {};
    for (const [local, b] of Object.entries((f.imports ?? {}) as Record<string, { name: string; from: string | null }>)) {
      imports[local] = { name: b.name, from: b.from };
    }
    files.push({
      path: rel,
      // The Python side emits decls without `path` (it does not know the repo-
      // relative name); the resolver builds node ids from d.path, and without
      // this stamp every Python node became `func:undefined#name` — all edges
      // collapsed to ambiguous. Caught by the ground-truth fixture, not by eye.
      decls: (((f.decls as FileCalls["decls"]) ?? []).map((d) => ({ ...d, path: rel }))),
      sites: (f.sites as FileCalls["sites"]) ?? [],
      imports,
      dynamicSites: Number(f.dynamicSites ?? 0),
    });
  }
  return { files, errors };
}
