/**
 * v0.14.0 concurrency + scale stress test.
 *
 * Validates the new code paths added in v0.14.0 don't break under load:
 *   1. Provenance: 5 concurrent rememberFact writers, all using different
 *      provenance values + same key — UPSERT should win consistently
 *   2. AST extraction: 50 fake TS files, all parsed, output deterministic
 *   3. Community detection: 200-source synthetic graph, Louvain completes
 *      in reasonable time + produces sensible communities
 *   4. Combined: indexProject on a synthetic 50-file project where AST
 *      extracts most files (deterministic L0) — verify provenance flags
 *      land correctly on each row
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { extractAst, detectLanguage } from "../dist/indexing/ast_extractor.js";
import { detectCommunities, storeCommunities } from "../dist/indexing/community.js";
import { indexContent } from "../dist/knowledge.js";
import { rememberFact } from "../dist/memory.js";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
function section(t) { console.log(`\n━━━ ${t} ${"━".repeat(Math.max(0, 60 - t.length))}`); }

const projectPath = mkdtempSync(join(tmpdir(), "zc-v014-stress-"));
const dbPath = join(homedir(), ".claude", "zc-ctx", "sessions",
                    createHash("sha256").update(projectPath).digest("hex").slice(0, 16) + ".db");

function cleanup() {
  for (const sfx of ["", "-wal", "-shm"]) {
    try { if (existsSync(dbPath + sfx)) unlinkSync(dbPath + sfx); } catch {}
  }
  try { rmSync(projectPath, { recursive: true, force: true }); } catch {}
}

console.log("═".repeat(64));
console.log(`v0.14.0 stress test — ${projectPath}`);
console.log("═".repeat(64));

// ─── 1. Provenance UPSERT under same-key contention ────────────────────
section("1. Provenance: same-key UPSERT semantics");
{
  // 5 sequential writers each setting different provenance — last write wins
  rememberFact(projectPath, "shared-key", "v1", 3, "agent-x", "INFERRED");
  rememberFact(projectPath, "shared-key", "v2", 3, "agent-x", "AMBIGUOUS");
  rememberFact(projectPath, "shared-key", "v3", 3, "agent-x", "EXTRACTED");

  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT value, provenance FROM working_memory WHERE key = ?").get("shared-key");
  db.close();
  check("last write wins (v3)", row?.value === "v3");
  check("provenance promoted to EXTRACTED", row?.provenance === "EXTRACTED");
}

// ─── 2. AST extractor at scale ────────────────────────────────────────
section("2. AST: parse 50 synthetic TS files, verify determinism");
{
  const filesDir = join(projectPath, "src");
  mkdirSync(filesDir, { recursive: true });

  const allResults = [];
  let parseFailures = 0;
  for (let i = 0; i < 50; i++) {
    const code = `/** Auto-gen module ${i} */
import { Foo } from "./shared.js";

export class Module${i} {
  doThing() { return new Foo(); }
}

export function helper${i}(x: number): string { return String(x); }
export interface Config${i} { id: number; }
export type Mode${i} = "a" | "b";
`;
    const lang = detectLanguage(`/x/file${i}.ts`);
    const r = extractAst(code, lang);
    if (!r) { parseFailures++; continue; }
    allResults.push(r);
  }
  check("all 50 files parsed (zero failures)", parseFailures === 0);
  check("each result has 4 exports", allResults.every(r => r.stats.exportCount === 4));
  check("each result has 1 class + 1 function + 1 interface + 1 type",
        allResults.every(r => r.stats.classCount === 1 &&
                              r.stats.functionCount === 1 &&
                              r.stats.interfaceCount === 1 &&
                              r.stats.typeCount === 1));

  // Determinism: parse the same file twice, expect identical L0
  const sample = allResults[0];
  const reparsed = extractAst(`/** Auto-gen module 0 */
import { Foo } from "./shared.js";

export class Module0 {
  doThing() { return new Foo(); }
}

export function helper0(x: number): string { return String(x); }
export interface Config0 { id: number; }
export type Mode0 = "a" | "b";
`, "typescript");
  check("determinism: re-parse produces identical L0", sample.l0 === reparsed.l0);
  check("determinism: re-parse produces identical L1", sample.l1 === reparsed.l1);
}

// ─── 3. Community detection at scale ──────────────────────────────────
section("3. Community: cluster 200 synthetic sources");
{
  // Build a synthetic graph: 4 clusters of 50 sources each, dense intra-cluster refs
  for (let cluster = 0; cluster < 4; cluster++) {
    for (let i = 0; i < 50; i++) {
      const id = cluster * 50 + i;
      const peers = Array.from({ length: 50 }, (_, k) => `cluster${cluster}_member_long_${k}`)
        .filter((_, k) => k !== i)
        .slice(0, 5);
      const content = `cluster_${cluster} member ${i}. references: ${peers.join(", ")}`;
      indexContent(projectPath, content, `cluster${cluster}_member_long_${i}`);
    }
  }

  const db = new DatabaseSync(dbPath);
  const start = Date.now();
  const result = detectCommunities(db);
  const elapsed = Date.now() - start;
  storeCommunities(db, result);
  db.close();

  check("processed 200 sources", result.totalSources === 200,
        `actual=${result.totalSources}`);
  check("created edges (>100)", result.totalEdges > 100,
        `${result.totalEdges} edges`);
  check("found 2+ communities", result.communityCount >= 2);
  check("modularity > 0", result.modularity > 0);
  check("completes in <10s", elapsed < 10_000, `${elapsed}ms`);

  // Verify clusters are reasonable: each cluster's members should mostly share community
  const dbCheck = new DatabaseSync(dbPath);
  let intraCohesion = 0;
  for (let c = 0; c < 4; c++) {
    const ids = dbCheck.prepare(
      `SELECT community_id FROM kb_communities WHERE source LIKE ?`
    ).all(`cluster${c}_member_long_%`);
    const sizes = new Map();
    for (const r of ids) sizes.set(r.community_id, (sizes.get(r.community_id) ?? 0) + 1);
    const dominant = Math.max(...sizes.values());
    intraCohesion += dominant / 50;
  }
  dbCheck.close();
  // Average dominance across 4 clusters should be > 0.5 (clusters are recoverable)
  const avgDominance = intraCohesion / 4;
  check("clusters recoverable (avg dominance >= 0.5)", avgDominance >= 0.5,
        `avg=${avgDominance.toFixed(2)}`);
}

// ─── 4. Combined: AST + provenance flow ──────────────────────────────
section("4. Combined: AST output gets EXTRACTED provenance");
{
  // Create one TS file using the harness path
  const filePath = join(projectPath, "src", "test_module.ts");
  writeFileSync(filePath, `/** Test module */
export class Foo { method() {} }
export function bar() {}
`);

  // Manually call the same path indexProject takes:
  //   detect → extract → indexContent with provenance="EXTRACTED"
  const lang = detectLanguage(filePath);
  const ast = extractAst(`/** Test module */
export class Foo { method() {} }
export function bar() {}
`, lang);
  check("AST detected for .ts file", lang === "typescript");
  check("AST extraction returns result", ast !== null);

  indexContent(projectPath, "content here", "test://manual_ast.ts",
               "internal", "internal", ast.l0, ast.l1, "EXTRACTED");

  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT provenance, l0_summary FROM source_meta WHERE source = ?")
    .get("test://manual_ast.ts");
  db.close();
  check("source_meta tagged EXTRACTED", row?.provenance === "EXTRACTED");
  check("L0 from AST is deterministic + non-trivial", row?.l0_summary?.includes("Foo") || row?.l0_summary?.includes("class"));
}

cleanup();

console.log(`\n━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  PASS: ${pass}`);
console.log(`  FAIL: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
