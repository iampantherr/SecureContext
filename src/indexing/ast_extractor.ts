/**
 * AST extractor for code files (v0.14.0 Phase B)
 * ===============================================
 *
 * Extracts structural facts from code files DETERMINISTICALLY (no LLM
 * call) and builds an L0/L1 summary from those facts. Used by
 * indexProject to skip the LLM step for code files where AST extraction
 * gives a comprehensive summary.
 *
 * Backend strategy:
 *   - v0.14.0 ships REGEX-based extraction for TS/JS/Python — zero
 *     install friction, works on any machine.
 *   - The interface is designed so a future v0.15.0 can swap in
 *     web-tree-sitter (WASM) for the same languages without breaking
 *     consumers. The output shape is identical.
 *
 * Why regex first:
 *   - Tree-sitter requires per-language WASM grammar files (~500KB each)
 *     that aren't bundled. Distributing them adds friction.
 *   - Regex covers the common cases that matter: top-level exports,
 *     imports, classes, functions, interfaces, types, module docstrings.
 *   - Regex misses some edge cases (deeply nested exports, computed
 *     property names) but those are rare in well-organized code.
 *   - The AST-extracted L0 IS deterministic — no LLM variability — which
 *     is the architectural property we want (provenance="EXTRACTED").
 *
 * Real user use case:
 *   For a 100-file TypeScript project, indexProject currently makes 100
 *   Ollama calls (one per file). With AST extraction, ~80% of those files
 *   get a deterministic L0 in <1ms each — only files that need semantic
 *   summarization (markdown, complex prose) hit Ollama. Net: ~80% LLM
 *   cost reduction, ~50x faster on the AST-eligible portion.
 */

import { extname } from "node:path";

// ─── Public types ──────────────────────────────────────────────────────────

export type AstLanguage = "typescript" | "javascript" | "python";

export interface AstExtractionResult {
  language:    AstLanguage;
  exports:     string[];          // names of exported items
  imports:     string[];          // module paths imported from
  classes:     string[];
  functions:   string[];
  interfaces:  string[];          // TS only
  types:       string[];          // TS only (type aliases)
  decorators?: string[];          // observed (JS/TS @decorator, Py @decorator)
  /** First doc-comment block at module top, if any. */
  moduleDocstring?: string;
  /** Total counts for L1 summary. */
  stats: {
    exportCount:    number;
    importCount:    number;
    classCount:     number;
    functionCount:  number;
    interfaceCount: number;
    typeCount:      number;
    lineCount:      number;
  };
  /** Composed L0 summary string (one-paragraph deterministic). */
  l0: string;
  /** Composed L1 summary string (more detailed but still deterministic). */
  l1: string;
}

// ─── Language detection ────────────────────────────────────────────────────

const EXT_TO_LANGUAGE: Record<string, AstLanguage> = {
  ".ts":  "typescript",
  ".tsx": "typescript",
  ".js":  "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py":  "python",
  ".pyw": "python",
};

/** Return the AstLanguage for a file path, or null if unsupported. */
export function detectLanguage(path: string): AstLanguage | null {
  const ext = extname(path).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? null;
}

// ─── Public extractor ──────────────────────────────────────────────────────

/**
 * Extract AST-derived facts from code content. Returns null if the
 * extraction failed (e.g. content too small, parse failure) — caller
 * should fall back to LLM summarization.
 *
 * Never throws.
 */
export function extractAst(content: string, language: AstLanguage): AstExtractionResult | null {
  try {
    if (!content || content.trim().length === 0) return null;
    if (content.length > 5_000_000) return null;  // sanity limit

    switch (language) {
      case "typescript":
      case "javascript":
        return extractTsJs(content, language);
      case "python":
        return extractPython(content);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ─── TypeScript / JavaScript extractor ─────────────────────────────────────

function extractTsJs(content: string, language: AstLanguage): AstExtractionResult {
  const lines = content.split("\n");
  const lineCount = lines.length;

  // Module-top docstring (JSDoc comment block at the very start)
  let moduleDocstring: string | undefined;
  const docMatch = content.match(/^\s*\/\*\*\s*([\s\S]*?)\s*\*\//);
  if (docMatch) {
    moduleDocstring = docMatch[1]
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 500);
  }

  // Imports — match: `import ... from "module"` and `require("module")`
  const imports = new Set<string>();
  for (const m of content.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm)) {
    imports.add(m[1]);
  }
  for (const m of content.matchAll(/(?<![\w.])require\(\s*["']([^"']+)["']\s*\)/g)) {
    imports.add(m[1]);
  }

  // Exports — match: export class/function/interface/type/const/let/var Name
  const exports = new Set<string>();
  const classes = new Set<string>();
  const functions = new Set<string>();
  const interfaces = new Set<string>();
  const types = new Set<string>();

  // export class Foo
  for (const m of content.matchAll(/^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/gm)) {
    exports.add(m[1]); classes.add(m[1]);
  }
  // export function foo / export async function foo
  for (const m of content.matchAll(/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/gm)) {
    exports.add(m[1]); functions.add(m[1]);
  }
  // export interface Foo (TS)
  for (const m of content.matchAll(/^\s*export\s+(?:default\s+)?interface\s+(\w+)/gm)) {
    exports.add(m[1]); interfaces.add(m[1]);
  }
  // export type Foo = ... (TS)
  for (const m of content.matchAll(/^\s*export\s+(?:default\s+)?type\s+(\w+)\s*=/gm)) {
    exports.add(m[1]); types.add(m[1]);
  }
  // export const/let/var foo = ...
  for (const m of content.matchAll(/^\s*export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)/gm)) {
    exports.add(m[1]);
  }
  // export { foo, bar } from "..."
  for (const m of content.matchAll(/^\s*export\s+\{\s*([^}]+)\s*\}/gm)) {
    for (const name of m[1].split(",")) {
      const clean = name.trim().split(/\s+as\s+/)[0].trim();
      if (clean && /^\w+$/.test(clean)) exports.add(clean);
    }
  }

  // Internal classes/functions (not exported but worth surfacing)
  for (const m of content.matchAll(/^\s*(?:abstract\s+)?class\s+(\w+)/gm)) {
    if (!classes.has(m[1])) classes.add(m[1]);
  }
  for (const m of content.matchAll(/^\s*(?:async\s+)?function\s*\*?\s*(\w+)/gm)) {
    if (!functions.has(m[1])) functions.add(m[1]);
  }

  // Decorators
  const decorators = new Set<string>();
  for (const m of content.matchAll(/^\s*@(\w+)/gm)) {
    decorators.add(m[1]);
  }

  const stats = {
    exportCount:    exports.size,
    importCount:    imports.size,
    classCount:     classes.size,
    functionCount:  functions.size,
    interfaceCount: interfaces.size,
    typeCount:      types.size,
    lineCount,
  };

  const l0 = composeL0TsJs(language, stats, exports, moduleDocstring);
  const l1 = composeL1TsJs(language, stats, exports, classes, functions, interfaces, types, imports, moduleDocstring);

  return {
    language,
    exports:    [...exports],
    imports:    [...imports],
    classes:    [...classes],
    functions:  [...functions],
    interfaces: [...interfaces],
    types:      [...types],
    decorators: decorators.size > 0 ? [...decorators] : undefined,
    moduleDocstring,
    stats,
    l0,
    l1,
  };
}

function composeL0TsJs(
  lang: AstLanguage,
  stats: AstExtractionResult["stats"],
  exports: Set<string>,
  doc?: string,
): string {
  const langLabel = lang === "typescript" ? "TypeScript" : "JavaScript";
  const parts: string[] = [];

  if (doc) {
    parts.push(doc.slice(0, 200));
  } else {
    const expDesc = stats.exportCount === 0 ? "no exports"
                  : stats.exportCount === 1 ? `1 export (${[...exports][0]})`
                  : `${stats.exportCount} exports`;
    parts.push(`${langLabel} module: ${expDesc}`);
  }

  const detail: string[] = [];
  if (stats.classCount     > 0) detail.push(`${stats.classCount} class${stats.classCount > 1 ? "es" : ""}`);
  if (stats.functionCount  > 0) detail.push(`${stats.functionCount} function${stats.functionCount > 1 ? "s" : ""}`);
  if (stats.interfaceCount > 0) detail.push(`${stats.interfaceCount} interface${stats.interfaceCount > 1 ? "s" : ""}`);
  if (stats.typeCount      > 0) detail.push(`${stats.typeCount} type alias${stats.typeCount > 1 ? "es" : ""}`);
  if (detail.length > 0) parts.push(`Contains ${detail.join(", ")}.`);

  if (stats.importCount > 0) parts.push(`${stats.importCount} import${stats.importCount > 1 ? "s" : ""}.`);

  return parts.join(" ").slice(0, 500);
}

function composeL1TsJs(
  lang: AstLanguage,
  stats: AstExtractionResult["stats"],
  exports: Set<string>,
  classes: Set<string>,
  functions: Set<string>,
  interfaces: Set<string>,
  types: Set<string>,
  imports: Set<string>,
  doc?: string,
): string {
  const lines: string[] = [];
  lines.push(`Language: ${lang}`);
  if (doc) lines.push(`Module purpose: ${doc.slice(0, 400)}`);
  lines.push(`File size: ${stats.lineCount} lines`);

  if (exports.size > 0) {
    lines.push(`Exports (${exports.size}):`);
    for (const name of [...exports].slice(0, 30)) lines.push(`  - ${name}`);
    if (exports.size > 30) lines.push(`  ... and ${exports.size - 30} more`);
  }

  if (classes.size > 0) {
    lines.push(`Classes (${classes.size}): ${[...classes].slice(0, 20).join(", ")}${classes.size > 20 ? ", ..." : ""}`);
  }
  if (functions.size > 0) {
    lines.push(`Functions (${functions.size}): ${[...functions].slice(0, 30).join(", ")}${functions.size > 30 ? ", ..." : ""}`);
  }
  if (interfaces.size > 0) {
    lines.push(`Interfaces (${interfaces.size}): ${[...interfaces].slice(0, 20).join(", ")}${interfaces.size > 20 ? ", ..." : ""}`);
  }
  if (types.size > 0) {
    lines.push(`Types (${types.size}): ${[...types].slice(0, 20).join(", ")}${types.size > 20 ? ", ..." : ""}`);
  }
  if (imports.size > 0) {
    lines.push(`Imports from (${imports.size}): ${[...imports].slice(0, 20).join(", ")}${imports.size > 20 ? ", ..." : ""}`);
  }

  return lines.join("\n").slice(0, 4000);
}

// ─── Python extractor ──────────────────────────────────────────────────────

function extractPython(content: string): AstExtractionResult {
  const lines = content.split("\n");
  const lineCount = lines.length;

  // Module docstring (top-of-file triple-quote string)
  let moduleDocstring: string | undefined;
  const docMatch = content.match(/^\s*"""([\s\S]*?)"""|^\s*'''([\s\S]*?)'''/);
  if (docMatch) {
    moduleDocstring = (docMatch[1] ?? docMatch[2] ?? "").trim().split("\n").map(l => l.trim()).filter(Boolean).join(" ").slice(0, 500);
  }

  const imports = new Set<string>();
  for (const m of content.matchAll(/^\s*from\s+([\w.]+)\s+import\s+/gm)) imports.add(m[1]);
  for (const m of content.matchAll(/^\s*import\s+([\w.]+)/gm)) imports.add(m[1]);

  const exports = new Set<string>();
  const classes = new Set<string>();
  const functions = new Set<string>();

  // Top-level class/def (not indented = module-level)
  for (const m of content.matchAll(/^class\s+(\w+)/gm)) { classes.add(m[1]); exports.add(m[1]); }
  for (const m of content.matchAll(/^(?:async\s+)?def\s+(\w+)/gm)) {
    if (!m[1].startsWith("_")) { functions.add(m[1]); exports.add(m[1]); }
    else functions.add(m[1]);  // private = not exported, but still tracked
  }

  // __all__ for explicit exports
  const allMatch = content.match(/^__all__\s*=\s*\[([\s\S]*?)\]/m);
  if (allMatch) {
    for (const m of allMatch[1].matchAll(/["']([^"']+)["']/g)) exports.add(m[1]);
  }

  const decorators = new Set<string>();
  for (const m of content.matchAll(/^\s*@(\w+)/gm)) decorators.add(m[1]);

  const stats = {
    exportCount:    exports.size,
    importCount:    imports.size,
    classCount:     classes.size,
    functionCount:  functions.size,
    interfaceCount: 0,
    typeCount:      0,
    lineCount,
  };

  const l0 = composeL0Python(stats, exports, moduleDocstring);
  const l1 = composeL1Python(stats, exports, classes, functions, imports, moduleDocstring);

  return {
    language: "python",
    exports:    [...exports],
    imports:    [...imports],
    classes:    [...classes],
    functions:  [...functions],
    interfaces: [],
    types:      [],
    decorators: decorators.size > 0 ? [...decorators] : undefined,
    moduleDocstring,
    stats,
    l0,
    l1,
  };
}

function composeL0Python(stats: AstExtractionResult["stats"], exports: Set<string>, doc?: string): string {
  const parts: string[] = [];
  if (doc) parts.push(doc.slice(0, 200));
  else {
    const expDesc = stats.exportCount === 0 ? "no top-level exports"
                  : stats.exportCount === 1 ? `1 top-level export (${[...exports][0]})`
                  : `${stats.exportCount} top-level exports`;
    parts.push(`Python module: ${expDesc}`);
  }
  const detail: string[] = [];
  if (stats.classCount    > 0) detail.push(`${stats.classCount} class${stats.classCount > 1 ? "es" : ""}`);
  if (stats.functionCount > 0) detail.push(`${stats.functionCount} function${stats.functionCount > 1 ? "s" : ""}`);
  if (detail.length > 0) parts.push(`Contains ${detail.join(", ")}.`);
  if (stats.importCount > 0) parts.push(`Imports ${stats.importCount} module${stats.importCount > 1 ? "s" : ""}.`);
  return parts.join(" ").slice(0, 500);
}

function composeL1Python(
  stats: AstExtractionResult["stats"],
  exports: Set<string>,
  classes: Set<string>,
  functions: Set<string>,
  imports: Set<string>,
  doc?: string,
): string {
  const lines: string[] = [];
  lines.push(`Language: python`);
  if (doc) lines.push(`Module docstring: ${doc.slice(0, 400)}`);
  lines.push(`File size: ${stats.lineCount} lines`);
  if (exports.size > 0) {
    lines.push(`Top-level exports (${exports.size}): ${[...exports].slice(0, 30).join(", ")}${exports.size > 30 ? ", ..." : ""}`);
  }
  if (classes.size > 0) {
    lines.push(`Classes: ${[...classes].slice(0, 20).join(", ")}${classes.size > 20 ? ", ..." : ""}`);
  }
  if (functions.size > 0) {
    lines.push(`Functions: ${[...functions].slice(0, 30).join(", ")}${functions.size > 30 ? ", ..." : ""}`);
  }
  if (imports.size > 0) {
    lines.push(`Imports: ${[...imports].slice(0, 20).join(", ")}${imports.size > 20 ? ", ..." : ""}`);
  }
  return lines.join("\n").slice(0, 4000);
}
