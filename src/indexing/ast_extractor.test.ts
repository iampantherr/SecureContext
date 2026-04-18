/**
 * Tests for AST extractor (v0.14.0 Phase B).
 *
 * Coverage:
 *   - detectLanguage: every supported extension + unsupported cases
 *   - extractAst for TS/JS/Python: real-world fixtures
 *   - Edge cases: empty file, syntax-error file, very large file,
 *     comments-only file, duplicate exports, default exports, async
 *     functions, generator functions, abstract classes, decorators,
 *     re-exports, __all__ in Python
 *   - Real user patterns: a TypeScript module with class+functions+
 *     interfaces+types+imports gets a coherent L0/L1
 */

import { describe, it, expect } from "vitest";
import { detectLanguage, extractAst, type AstExtractionResult } from "./ast_extractor.js";

describe("detectLanguage", () => {
  it.each([
    [".ts",  "typescript"], [".tsx", "typescript"],
    [".js",  "javascript"], [".jsx", "javascript"],
    [".mjs", "javascript"], [".cjs", "javascript"],
    [".py",  "python"],     [".pyw", "python"],
  ] as const)("%s → %s", (ext, expected) => {
    expect(detectLanguage(`/some/path/file${ext}`)).toBe(expected);
  });

  it.each([".md", ".txt", ".json", ".yaml", ".rs", ".go", ".java", ""])(
    "unsupported %s → null", (ext) => {
      expect(detectLanguage(`/file${ext}`)).toBeNull();
    },
  );

  it("is case-insensitive on the extension", () => {
    expect(detectLanguage("/foo.TS")).toBe("typescript");
    expect(detectLanguage("/foo.PY")).toBe("python");
  });
});

describe("extractAst — TypeScript: real-world patterns", () => {

  it("extracts a class with exports + imports + methods", () => {
    const r = extractAst(`/**
 * UserService — handles user CRUD
 */
import { foo } from "./utils.js";
import type { Bar } from "./types.js";

export class UserService {
  constructor(private db: Db) {}
  async findById(id: string): Promise<User> { return this.db.users.get(id); }
}
`, "typescript")!;
    expect(r).not.toBeNull();
    expect(r.language).toBe("typescript");
    expect(r.classes).toContain("UserService");
    expect(r.exports).toContain("UserService");
    expect(r.imports).toContain("./utils.js");
    expect(r.imports).toContain("./types.js");
    expect(r.moduleDocstring).toContain("UserService");
    expect(r.l0).toContain("UserService");
  });

  it("extracts multiple exports of various kinds", () => {
    const r = extractAst(`
export interface Config { apiUrl: string; }
export type Mode = "dev" | "prod";
export class App { run() {} }
export function init() {}
export const VERSION = "1.0.0";
export async function fetchData() {}
`, "typescript")!;
    expect(r.interfaces).toContain("Config");
    expect(r.types).toContain("Mode");
    expect(r.classes).toContain("App");
    expect(r.functions).toContain("init");
    expect(r.functions).toContain("fetchData");
    expect(r.exports).toEqual(expect.arrayContaining(["Config", "Mode", "App", "init", "VERSION", "fetchData"]));
    expect(r.stats.exportCount).toBe(6);
  });

  it("handles export { x, y } from \"...\"  re-exports", () => {
    const r = extractAst(`
export { foo, bar as renamed } from "./mod.js";
`, "typescript")!;
    expect(r.exports).toContain("foo");
    expect(r.exports).toContain("bar");
  });

  it("[edge] empty TypeScript file → null", () => {
    expect(extractAst("", "typescript")).toBeNull();
    expect(extractAst("   \n  \n", "typescript")).toBeNull();
  });

  it("[edge] comments-only file → still gets a result (lineCount + zero exports)", () => {
    const r = extractAst(`/**
 * Just a comment block.
 */
// nothing here
`, "typescript")!;
    expect(r).not.toBeNull();
    expect(r.exports).toEqual([]);
    expect(r.classes).toEqual([]);
    expect(r.moduleDocstring).toContain("Just a comment");
  });

  it("[edge] very large file (>5MB) → null (refuses to OOM)", () => {
    const big = "export const x = 1;\n".repeat(300_000);  // >6MB
    expect(extractAst(big, "typescript")).toBeNull();
  });

  it("[edge] syntax-broken file still returns SOMETHING (regex is forgiving)", () => {
    const r = extractAst(`
export class Foo {
  oops broken syntax }}
export function valid() {}
`, "typescript")!;
    // We extract what we can — broken syntax doesn't crash the regex
    expect(r.classes).toContain("Foo");
    expect(r.functions).toContain("valid");
  });

  it("[edge] abstract class is recognized", () => {
    const r = extractAst(`export abstract class Base { abstract run(): void; }`, "typescript")!;
    expect(r.classes).toContain("Base");
  });

  it("[edge] generator functions are recognized", () => {
    const r = extractAst(`export function* counter() { yield 1; }`, "typescript")!;
    expect(r.functions).toContain("counter");
  });

  it("[edge] default export is included", () => {
    const r = extractAst(`export default class Defaulted {}`, "typescript")!;
    expect(r.exports).toContain("Defaulted");
    expect(r.classes).toContain("Defaulted");
  });

  it("captures decorators", () => {
    const r = extractAst(`@Injectable\nexport class Svc {}`, "typescript")!;
    expect(r.decorators).toContain("Injectable");
  });

  it("[user case] L0 reads naturally for a typical module", () => {
    const r = extractAst(`
/**
 * Handles user authentication and session management.
 */
import { db } from "./db.js";
import bcrypt from "bcrypt";

export class AuthService {
  async login(u: string, p: string) {}
  async logout(token: string) {}
}

export function hashPassword(p: string) { return bcrypt.hash(p, 12); }
`, "typescript")!;
    expect(r.l0).toMatch(/Handles user authentication/);
    expect(r.l0.length).toBeGreaterThan(20);
    expect(r.l0.length).toBeLessThanOrEqual(500);
    // L1 should be a structured summary
    expect(r.l1).toContain("AuthService");
    expect(r.l1).toContain("hashPassword");
    expect(r.l1).toContain("./db.js");
  });
});

describe("extractAst — JavaScript: real-world patterns", () => {

  it("handles CommonJS require + module.exports", () => {
    const r = extractAst(`
const fs = require("node:fs");
const path = require("node:path");

function read(p) { return fs.readFileSync(p, "utf8"); }
function write(p, c) { return fs.writeFileSync(p, c); }

module.exports = { read, write };
`, "javascript")!;
    expect(r.imports).toContain("node:fs");
    expect(r.imports).toContain("node:path");
    expect(r.functions).toContain("read");
    expect(r.functions).toContain("write");
  });

  it("handles ES module imports", () => {
    const r = extractAst(`
import { useState } from "react";
import App from "./App.jsx";

export function Layout() { return null; }
`, "javascript")!;
    expect(r.imports).toContain("react");
    expect(r.imports).toContain("./App.jsx");
    expect(r.functions).toContain("Layout");
  });
});

describe("extractAst — Python: real-world patterns", () => {

  it("extracts classes + functions + imports from a typical module", () => {
    const r = extractAst(`"""
User authentication module.
Provides login and session helpers.
"""
import bcrypt
from typing import Optional
from .db import Database

class AuthService:
    def __init__(self, db: Database):
        self.db = db

    def login(self, user: str, password: str) -> Optional[str]:
        return None

def hash_password(p: str) -> str:
    return bcrypt.hashpw(p.encode(), bcrypt.gensalt()).decode()

def _internal_helper():
    pass
`, "python")!;
    expect(r.language).toBe("python");
    expect(r.classes).toContain("AuthService");
    expect(r.functions).toContain("hash_password");
    expect(r.functions).toContain("_internal_helper");  // tracked but not exported
    expect(r.exports).toContain("AuthService");
    expect(r.exports).toContain("hash_password");
    expect(r.exports).not.toContain("_internal_helper");  // private
    expect(r.imports).toContain("bcrypt");
    expect(r.imports).toContain("typing");
    expect(r.imports).toContain(".db");
    expect(r.moduleDocstring).toContain("User authentication");
  });

  it("respects __all__ for explicit exports", () => {
    const r = extractAst(`
__all__ = ["foo", "Bar"]

class Bar: pass
class Hidden: pass
def foo(): pass
def hidden(): pass
`, "python")!;
    expect(r.exports).toEqual(expect.arrayContaining(["foo", "Bar"]));
  });

  it("[edge] async def is recognized", () => {
    const r = extractAst(`
async def fetch_data():
    return None
`, "python")!;
    expect(r.functions).toContain("fetch_data");
    expect(r.exports).toContain("fetch_data");
  });

  it("[edge] decorators on top-level classes", () => {
    const r = extractAst(`
@dataclass
class User:
    name: str
`, "python")!;
    expect(r.classes).toContain("User");
    expect(r.decorators).toContain("dataclass");
  });

  it("[edge] empty Python file → null", () => {
    expect(extractAst("", "python")).toBeNull();
  });
});

describe("extractAst — error path safety", () => {

  it("never throws on garbage input", () => {
    const garbage = "\x00\x01\x02💥💥💥\nrandom \"unclosed string";
    expect(() => extractAst(garbage, "typescript")).not.toThrow();
    expect(() => extractAst(garbage, "javascript")).not.toThrow();
    expect(() => extractAst(garbage, "python")).not.toThrow();
  });

  it("returns null for unsupported language input (defensive)", () => {
    // @ts-expect-error
    expect(extractAst("export class Foo {}", "ruby")).toBeNull();
  });
});

describe("L0/L1 properties — deterministic, bounded", () => {

  it("L0 same input → same output (deterministic)", () => {
    const code = `export function foo() {}\nexport class Bar {}`;
    const r1 = extractAst(code, "typescript")!;
    const r2 = extractAst(code, "typescript")!;
    expect(r1.l0).toBe(r2.l0);
    expect(r1.l1).toBe(r2.l1);
  });

  it("L0 is bounded ≤ 500 chars", () => {
    // 100 exports
    const many = Array.from({ length: 100 }, (_, i) => `export const x${i} = ${i};`).join("\n");
    const r = extractAst(many, "typescript")!;
    expect(r.l0.length).toBeLessThanOrEqual(500);
  });

  it("L1 is bounded ≤ 4000 chars", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      `export class ClassWithLongName${i} { method${i}() {} }`
    ).join("\n");
    const r = extractAst(many, "typescript")!;
    expect(r.l1.length).toBeLessThanOrEqual(4000);
    // And exports/classes truncate gracefully with "..."
    expect(r.l1).toContain("...");
  });

  it("[user case] L1 includes the most useful structural facts", () => {
    const r = extractAst(`
import { db } from "./db.js";
export class Service {}
export function init() {}
export interface Config {}
export type Mode = "x";
`, "typescript")!;
    // L1 should mention all four kinds
    expect(r.l1).toContain("Classes");
    expect(r.l1).toContain("Functions");
    expect(r.l1).toContain("Interfaces");
    expect(r.l1).toContain("Types");
    expect(r.l1).toContain("Imports from");
  });
});
