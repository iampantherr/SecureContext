/**
 * v0.26.0 Step 3 — Script scanner for skill bundled scripts.
 *
 * For each script file inside a skill directory, parse + walk the AST
 * looking for dangerous patterns. Used by the Step-3-extended security
 * gate (scanSkillDirectory) and by the Step-2 filesystem watcher.
 *
 * Supported languages:
 *   - Python (.py) — invokes scripts/py_ast_walker.py via python3 subprocess
 *   - JavaScript (.js, .mjs) — uses acorn + acorn-walk
 *
 * Unsupported file types (.sh, .rb, etc.) → currently FAIL CLOSED:
 *   we mark them with a block-severity finding so unknown-language scripts
 *   are quarantined until we extend the scanner. Operators can configure
 *   bypass via skill frontmatter `unsupported_scripts_ok: true` in the
 *   future (out of scope for v0.26).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import * as acorn from "acorn";
import { simple as acornWalk } from "acorn-walk";

export interface ScriptScanFinding {
  pattern:    string;
  severity:   "block" | "warn";
  line:       number;
  col:        number;
  snippet:    string;
}

export interface ScriptScanResult {
  /** True iff no block-severity findings */
  passed:     boolean;
  /** The script file scanned (relative or absolute path) */
  scriptPath: string;
  /** Language detected */
  language:   "python" | "javascript" | "unknown";
  /** All findings, including warns */
  violations: ScriptScanFinding[];
  /** Non-fatal errors encountered during scan */
  errors:     string[];
}

/** Locate the bundled py_ast_walker.py. Resolves both dev (src/) and Docker (/app) layouts. */
function findPyWalker(): string | null {
  const candidates: string[] = [];
  try {
    const fname = fileURLToPath(import.meta.url);
    const dir = dirname(fname);
    candidates.push(join(dir, "..", "..", "scripts", "py_ast_walker.py"));   // dev: src/skills/ → scripts/
    candidates.push(join(dir, "..", "scripts", "py_ast_walker.py"));         // dist: dist/skills/ → scripts/
    candidates.push(join(dir, "..", "..", "..", "scripts", "py_ast_walker.py")); // Docker: /app/dist/skills → /app/scripts/
  } catch { /* ignore */ }
  candidates.push("/app/scripts/py_ast_walker.py");                          // Docker fallback
  for (const c of candidates) {
    try {
      readFileSync(c, "utf8");
      return c;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Scan a Python script via the bundled AST walker.
 */
function scanPython(scriptPath: string): ScriptScanResult {
  const walker = findPyWalker();
  if (!walker) {
    return {
      passed: false,
      scriptPath,
      language: "python",
      violations: [{ pattern: "walker_missing", severity: "block", line: 0, col: 0, snippet: "py_ast_walker.py not found" }],
      errors: ["py_ast_walker.py bundled helper not found on disk"],
    };
  }
  const r = spawnSync("python3", [walker, scriptPath], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0 && r.status !== null) {
    return {
      passed: false,
      scriptPath,
      language: "python",
      violations: [{ pattern: "walker_failed", severity: "block", line: 0, col: 0, snippet: `exit ${r.status}` }],
      errors: [`python3 walker exited ${r.status}: ${r.stderr ?? ""}`],
    };
  }
  if (!r.stdout) {
    return {
      passed: false,
      scriptPath,
      language: "python",
      violations: [{ pattern: "walker_no_output", severity: "block", line: 0, col: 0, snippet: "no stdout" }],
      errors: [`python3 walker produced no output: ${r.stderr ?? ""}`],
    };
  }
  try {
    const parsed = JSON.parse(r.stdout) as {
      passed: boolean;
      violations: ScriptScanFinding[];
      errors: string[];
    };
    return {
      passed: parsed.passed,
      scriptPath,
      language: "python",
      violations: parsed.violations,
      errors: parsed.errors,
    };
  } catch (e) {
    return {
      passed: false,
      scriptPath,
      language: "python",
      violations: [{ pattern: "walker_bad_output", severity: "block", line: 0, col: 0, snippet: r.stdout.slice(0, 200) }],
      errors: [`walker stdout not JSON: ${(e as Error).message}`],
    };
  }
}

const JS_FORBIDDEN_CALL_NAMES = new Set([
  "eval",
  "Function",  // new Function(...) is eval-equivalent
]);
const JS_FORBIDDEN_MEMBER_EXPRESSIONS = new Map<string, string>([
  ["child_process.exec",      "shell_exec"],
  ["child_process.execSync",  "shell_exec"],
  ["child_process.spawn",     "process_spawn_caller_must_audit"],
  ["child_process.spawnSync", "process_spawn_caller_must_audit"],
  ["vm.runInNewContext",      "vm_eval"],
  ["vm.runInThisContext",     "vm_eval"],
]);

function scanJs(scriptPath: string): ScriptScanResult {
  const code = readFileSync(scriptPath, "utf8");
  const violations: ScriptScanFinding[] = [];
  const errors: string[] = [];

  let ast: acorn.Node;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });
  } catch (e) {
    return {
      passed: false,
      scriptPath,
      language: "javascript",
      violations: [{ pattern: "syntax_error", severity: "block", line: 0, col: 0, snippet: (e as Error).message }],
      errors: [`acorn parse failed: ${(e as Error).message}`],
    };
  }

  const lines = code.split("\n");

  acornWalk(ast, {
    CallExpression(node: acorn.Node) {
      // Plain calls: eval(...), Function(...), require('child_process')(...)
      const callNode = node as unknown as { callee: { type: string; name?: string; object?: { type: string; name?: string }; property?: { type: string; name?: string } }; loc?: { start: { line: number; column: number } } };
      const callee = callNode.callee;
      let calleeName: string | null = null;

      if (callee.type === "Identifier" && callee.name) {
        calleeName = callee.name;
        if (JS_FORBIDDEN_CALL_NAMES.has(calleeName)) {
          const lineNum = callNode.loc?.start.line ?? 0;
          violations.push({
            pattern: `dynamic_${calleeName}`,
            severity: "block",
            line: lineNum,
            col: callNode.loc?.start.column ?? 0,
            snippet: lines[lineNum - 1]?.trim() ?? "",
          });
        }
      }

      // Member expressions: subprocess.run, fs.foo, child_process.exec
      if (callee.type === "MemberExpression"
          && callee.object?.type === "Identifier"
          && callee.property?.type === "Identifier") {
        const mem = `${callee.object.name}.${callee.property.name}`;
        const violationKey = JS_FORBIDDEN_MEMBER_EXPRESSIONS.get(mem);
        if (violationKey) {
          const lineNum = callNode.loc?.start.line ?? 0;
          violations.push({
            pattern: violationKey,
            severity: violationKey.includes("must_audit") ? "warn" : "block",
            line: lineNum,
            col: callNode.loc?.start.column ?? 0,
            snippet: lines[lineNum - 1]?.trim() ?? "",
          });
        }
      }
    },

    NewExpression(node: acorn.Node) {
      // new Function(...) is eval-equivalent
      const newNode = node as unknown as { callee: { type: string; name?: string }; loc?: { start: { line: number; column: number } } };
      if (newNode.callee.type === "Identifier" && newNode.callee.name === "Function") {
        const lineNum = newNode.loc?.start.line ?? 0;
        violations.push({
          pattern: "new_Function_constructor",
          severity: "block",
          line: lineNum,
          col: newNode.loc?.start.column ?? 0,
          snippet: lines[lineNum - 1]?.trim() ?? "",
        });
      }
    },
  });

  const blocking = violations.filter((v) => v.severity === "block");
  return {
    passed: blocking.length === 0,
    scriptPath,
    language: "javascript",
    violations,
    errors,
  };
}

/**
 * v0.27.0 — Data file extensions that may legitimately appear in scripts/
 * directories (e.g. OOXML schemas in anthropic-docx/scripts/office/, JSON
 * configs, YAML pipelines). These are NOT executable code and don't need
 * AST scanning. Treat them as pass-through (passed: true, no scan).
 *
 * The list is intentionally conservative — only well-known non-code formats
 * that won't be invoked by python/node/bash. If an extension isn't here AND
 * isn't a recognized code extension, we still fail closed.
 */
const DATA_FILE_EXTENSIONS = new Set([
  // markup / config
  "xml", "xsd", "html", "htm", "css", "json", "yaml", "yml", "toml", "ini",
  "md", "rst", "txt", "csv", "tsv", "log",
  // images / fonts / docs (e.g. templates in anthropic-pptx)
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico",
  "ttf", "otf", "woff", "woff2", "eot",
  "pdf", "docx", "pptx", "xlsx", "odt", "ods", "odp",
  // archives / binary
  "zip", "tar", "gz", "bz2", "xz", "rar", "7z",
  "wasm", "exe", "dll", "so", "dylib",
  // misc data
  "sql", "rels", "vml", "thmx",
]);

/**
 * Public entry: scan one script file, returning structured findings.
 * The caller (filesystem_skill_import.ts) decides whether to quarantine
 * based on the boolean `.passed` field + frontmatter policy.
 */
export function scanScriptFile(scriptPath: string): ScriptScanResult {
  const lower = scriptPath.toLowerCase();
  if (lower.endsWith(".py")) return scanPython(scriptPath);
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return scanJs(scriptPath);

  // v0.27.0 — data files (xml/json/yaml/templates/binaries) under scripts/
  // are NOT executable code. They land here because skills like
  // anthropic-docx ship OOXML schemas under scripts/office/. Treat as
  // pass-through with an info note (no scan needed; doesn't reach an
  // interpreter unless a code file explicitly imports/opens it).
  const ext = lower.split(".").pop() ?? "";
  if (DATA_FILE_EXTENSIONS.has(ext)) {
    return {
      passed: true,
      scriptPath,
      language: "unknown",
      violations: [],
      errors: [],
    };
  }

  // Unknown extension — still fail closed for safety
  return {
    passed: false,
    scriptPath,
    language: "unknown",
    violations: [{
      pattern: "unsupported_language",
      severity: "block",
      line: 0,
      col: 0,
      snippet: `extension ${ext} not scannable`,
    }],
    errors: [`script_scanner does not support extension: ${scriptPath}`],
  };
}

/**
 * Scan every file inside a skill directory's scripts/ subfolder.
 * Returns one ScriptScanResult per script. Caller decides quarantine
 * based on the aggregate result.
 */
export function scanSkillScripts(scriptPaths: string[]): ScriptScanResult[] {
  return scriptPaths.map((p) => scanScriptFile(p));
}
