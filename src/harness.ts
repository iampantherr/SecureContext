/**
 * Harness Engineering (v0.10.0)
 * =============================
 *
 * The "harness" is SecureContext's token-optimization layer on top of the
 * existing memory / KB / broadcast primitives. Its goal: make Tier 1
 * (compressed knowledge) the DEFAULT answer for "check / review / verify"
 * questions, and reserve Tier 2 (raw file reads) for the moment an agent
 * is actually editing something.
 *
 * Five helpers are exposed, each backing one MCP tool:
 *
 *   indexProject()       → walks the repo, generates L0/L1 per source file
 *   getFileSummary()     → direct accessor for a path's L0/L1 (no Read)
 *   getProjectCard()     → per-project orientation card (500-token session start)
 *   setProjectCard()     → write the project card
 *   captureToolOutput()  → bash output archive + compact summary
 *
 * Plus two hook-support helpers:
 *   recordSessionRead()  → populates session_read_log from PreToolUse hook
 *   wasReadThisSession() → query for PreToolUse dedup guard
 *
 * L0/L1 generation is deterministic truncation (same approach as indexContent
 * in knowledge.ts) — no LLM dependency. v0.11.0 may add Ollama-generated
 * semantic summaries as an opt-in.
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep, extname } from "node:path";
import { createHash } from "node:crypto";
import { Config } from "./config.js";
import { openDb, indexContent, dbPath } from "./knowledge.js";
import { summarizeBatch, selectSummaryModel } from "./summarizer.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FileSummary {
  source:     string;
  l0:         string;
  l1:         string;
  indexedAt:  string;
  sourceType: string;
  stale:      boolean;        // true if file mtime > source_meta.created_at
}

export interface ProjectCard {
  stack:     string;
  layout:    string;
  state:     string;
  gotchas:   string;
  hotFiles:  string[];
  updatedAt: string | null;
}

export interface IndexProjectResult {
  filesScanned:         number;
  filesIndexed:         number;
  filesSkipped:         number;
  bytesRead:            number;
  elapsedMs:            number;
  excluded:             string[];
  semanticSummaries:    boolean;    // true if Ollama semantic summarizer was used
  semanticModel:        string | null;
  semanticCount:        number;     // files that got a semantic summary
  truncationCount:      number;     // files that fell back to truncation
}

export interface CapturedOutput {
  hash:      string;
  summary:   string;
  exitCode:  number;
  fullRef:   string;        // knowledge.source key for FTS retrieval
  truncated: boolean;
  lineCount: number;
}

// ─── Project Indexer ──────────────────────────────────────────────────────────

/**
 * Walk the project tree and index every qualifying source file into the KB
 * with an L0 (semantic one-line purpose) + L1 (detailed summary) summary.
 *
 * Qualifying files:
 *   - extension in Config.INDEX_FILE_EXTENSIONS
 *   - size <= Config.INDEX_MAX_FILE_BYTES
 *   - path not under Config.INDEX_PROJECT_EXCLUDES
 *
 * Summarization strategy (v0.10.0):
 *   1. Collect qualifying files (walk + size/ext filter).
 *   2. Batch-summarize via Ollama coder model (summarizeBatch, bounded concurrency).
 *   3. Fall back to deterministic truncation per-file on Ollama failure.
 *   4. Write each file to FTS + source_meta with its best summary.
 *   5. Fire-and-forget embeddings (indexContent handles this).
 *
 * Each file becomes a KB entry with source=`file:<relative-path>`.
 * Re-running is idempotent — `indexContent` uses INSERT OR REPLACE on source.
 */
export async function indexProject(
  projectPath: string,
  options: { excludes?: string[]; extensions?: string[]; maxBytes?: number } = {}
): Promise<IndexProjectResult> {
  const start     = Date.now();
  const excludes  = options.excludes   ?? [...Config.INDEX_PROJECT_EXCLUDES];
  const exts      = new Set(options.extensions ?? [...Config.INDEX_FILE_EXTENSIONS]);
  const maxBytes  = options.maxBytes   ?? Config.INDEX_MAX_FILE_BYTES;

  // Phase 1: walk the tree, collect qualifying files with content.
  const candidates: Array<{ path: string; relPath: string; content: string; bytes: number }> = [];
  let filesScanned = 0;
  let filesSkipped = 0;

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (excludes.some((ex) => name === ex || name.startsWith(ex))) {
        filesSkipped++;
        continue;
      }
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }

      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile()) continue;

      filesScanned++;
      const ext = extname(name).toLowerCase();
      if (!exts.has(ext)) { filesSkipped++; continue; }
      if (st.size > maxBytes) { filesSkipped++; continue; }

      let content: string;
      try { content = readFileSync(full, "utf8"); } catch { filesSkipped++; continue; }

      const rel = relative(projectPath, full).split(sep).join("/");
      candidates.push({ path: full, relPath: rel, content, bytes: st.size });
    }
  }
  walk(projectPath);

  // Phase 2: batch-summarize. Returns a Map keyed by relPath with semantic or
  // truncation fallback per file. Bounded concurrency prevents GPU thrash.
  const summaries = await summarizeBatch(
    candidates.map((c) => ({ path: c.relPath, content: c.content }))
  );

  // Phase 3: write to KB, counting semantic vs truncation hits.
  let filesIndexed    = 0;
  let bytesRead       = 0;
  let semanticCount   = 0;
  let truncationCount = 0;
  let semanticModel: string | null = null;

  for (const c of candidates) {
    const sum    = summaries.get(c.relPath);
    const l0     = sum?.l0;
    const l1     = sum?.l1;
    const source = `file:${c.relPath}`;
    try {
      indexContent(projectPath, c.content, source, "internal", "internal", l0, l1);
      bytesRead    += c.bytes;
      filesIndexed += 1;
      if (sum?.source === "semantic") {
        semanticCount += 1;
        if (!semanticModel && sum.modelUsed) semanticModel = sum.modelUsed;
      } else {
        truncationCount += 1;
      }
    } catch {
      filesSkipped += 1;
    }
  }

  // Re-probe in case no file summary populated modelUsed (all truncation)
  if (!semanticModel && Config.SUMMARY_ENABLED) {
    try { semanticModel = await selectSummaryModel(); } catch { /* noop */ }
  }

  return {
    filesScanned,
    filesIndexed,
    filesSkipped,
    bytesRead,
    elapsedMs:         Date.now() - start,
    excluded:          excludes,
    semanticSummaries: semanticCount > 0,
    semanticModel,
    semanticCount,
    truncationCount,
  };
}

// ─── File Summary Accessor ────────────────────────────────────────────────────

/**
 * Direct L0/L1 accessor for a single file path. The primary Tier-1 verb —
 * agents call this for "check/review/what-does-X-do" questions instead of Read.
 *
 * Returns null if the file is not indexed yet. Sets stale=true if the file
 * on disk is newer than the indexed version (hint: run indexProject or the
 * PostEdit hook will refresh it automatically).
 */
export function getFileSummary(
  projectPath: string,
  path: string
): FileSummary | null {
  const source = path.startsWith("file:") ? path : `file:${path}`;
  const db = openDb(projectPath);

  try {
    type Row = {
      source: string;
      source_type: string;
      created_at: string;
      l0_summary: string;
      l1_summary: string;
    };
    const row = db.prepare(
      `SELECT source, source_type, created_at, l0_summary, l1_summary
       FROM source_meta WHERE source = ?`
    ).get(source) as Row | undefined;

    if (!row) return null;

    // Detect staleness: file mtime vs indexed timestamp
    let stale = false;
    try {
      const abs = source.replace(/^file:/, "");
      const full = abs.startsWith("/") || /^[a-zA-Z]:/.test(abs)
        ? abs
        : join(projectPath, abs);
      const st = statSync(full);
      stale = st.mtime.toISOString() > row.created_at;
    } catch { /* file may be gone or on a different host */ }

    return {
      source:     row.source,
      l0:         row.l0_summary ?? "",
      l1:         row.l1_summary ?? "",
      indexedAt:  row.created_at,
      sourceType: row.source_type ?? "internal",
      stale,
    };
  } finally {
    db.close();
  }
}

// ─── Project Card ─────────────────────────────────────────────────────────────

/**
 * Return the per-project orientation card. Called once per session after
 * zc_recall_context to replace the Read-CLAUDE.md + ls + Glob + Read-a-few
 * orientation ritual. ~500 tokens vs ~8k.
 */
export function getProjectCard(projectPath: string): ProjectCard {
  const db = openDb(projectPath);
  try {
    type Row = {
      stack: string; layout: string; state: string;
      gotchas: string; hot_files: string; updated_at: string;
    };
    const row = db.prepare(
      `SELECT stack, layout, state, gotchas, hot_files, updated_at
       FROM project_card WHERE id = 1`
    ).get() as Row | undefined;

    if (!row) {
      return {
        stack: "", layout: "", state: "", gotchas: "",
        hotFiles: [], updatedAt: null,
      };
    }

    let hot: string[] = [];
    try { hot = JSON.parse(row.hot_files) as string[]; } catch {}

    return {
      stack:     row.stack,
      layout:    row.layout,
      state:     row.state,
      gotchas:   row.gotchas,
      hotFiles:  Array.isArray(hot) ? hot : [],
      updatedAt: row.updated_at,
    };
  } finally {
    db.close();
  }
}

/**
 * Write (create or replace) the per-project card. All fields optional —
 * a partial update merges with the existing row.
 */
export function setProjectCard(
  projectPath: string,
  patch: Partial<Omit<ProjectCard, "updatedAt">>
): ProjectCard {
  const db = openDb(projectPath);
  try {
    const existing = getProjectCardRaw(db);
    const merged = {
      stack:     patch.stack    ?? existing?.stack    ?? "",
      layout:    patch.layout   ?? existing?.layout   ?? "",
      state:     patch.state    ?? existing?.state    ?? "",
      gotchas:   patch.gotchas  ?? existing?.gotchas  ?? "",
      hotFiles:  patch.hotFiles ?? existing?.hotFiles ?? [],
    };
    const now = new Date().toISOString();

    db.prepare(
      `INSERT OR REPLACE INTO project_card(id, stack, layout, state, gotchas, hot_files, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`
    ).run(
      merged.stack,
      merged.layout,
      merged.state,
      merged.gotchas,
      JSON.stringify(merged.hotFiles),
      now
    );

    return { ...merged, updatedAt: now };
  } finally {
    db.close();
  }
}

function getProjectCardRaw(db: DatabaseSync): ProjectCard | null {
  try {
    type Row = {
      stack: string; layout: string; state: string;
      gotchas: string; hot_files: string; updated_at: string;
    };
    const row = db.prepare(
      `SELECT stack, layout, state, gotchas, hot_files, updated_at
       FROM project_card WHERE id = 1`
    ).get() as Row | undefined;
    if (!row) return null;
    let hot: string[] = [];
    try { hot = JSON.parse(row.hot_files) as string[]; } catch {}
    return {
      stack: row.stack, layout: row.layout, state: row.state,
      gotchas: row.gotchas, hotFiles: hot, updatedAt: row.updated_at,
    };
  } catch { return null; }
}

// ─── Tool Output Capture ──────────────────────────────────────────────────────

/**
 * Capture a long bash output: store the full text in the KB (FTS-searchable),
 * keep a compact summary in tool_output_digest, and return both. The caller
 * (PostToolUse hook) replaces the in-context output with the summary.
 *
 * Dedup: hash = sha256(command + stdout). Running the same command with the
 * same output twice returns the existing digest without re-indexing.
 */
export function captureToolOutput(
  projectPath: string,
  command:     string,
  stdout:      string,
  exitCode:    number
): CapturedOutput {
  const hash = createHash("sha256")
    .update(command + "\n\n" + stdout)
    .digest("hex")
    .slice(0, 32);

  const db = openDb(projectPath);
  try {
    type Row = {
      hash: string; summary: string; exit_code: number; full_ref: string;
    };
    const existing = db.prepare(
      `SELECT hash, summary, exit_code, full_ref FROM tool_output_digest WHERE hash = ?`
    ).get(hash) as Row | undefined;

    if (existing) {
      return {
        hash:      existing.hash,
        summary:   existing.summary,
        exitCode:  existing.exit_code,
        fullRef:   existing.full_ref,
        truncated: false,
        lineCount: stdout.split("\n").length,
      };
    }

    // Build a compact summary: first 10 lines + last BASH_TAIL_LINES lines,
    // annotated with "[... N lines omitted ...]" in the middle if needed.
    const lines = stdout.split("\n");
    const tail  = Config.BASH_TAIL_LINES;
    const head  = 10;
    let summary: string;
    let truncated = false;
    if (lines.length <= head + tail) {
      summary = stdout.trim();
    } else {
      const headPart = lines.slice(0, head).join("\n");
      const tailPart = lines.slice(-tail).join("\n");
      const omitted  = lines.length - head - tail;
      summary  = `${headPart}\n[... ${omitted} lines omitted; use zc_search to query full output ...]\n${tailPart}`;
      truncated = true;
    }

    // Full content into KB for FTS retrieval. Source key is human-readable.
    const fullRef = `tool_output/${hash}`;
    const header  = `$ ${command}\n[exit ${exitCode}]\n\n`;
    indexContent(projectPath, header + stdout, fullRef, "internal", "internal");

    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO tool_output_digest(hash, command, summary, exit_code, full_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(hash, command, summary, exitCode, fullRef, now);

    return { hash, summary, exitCode, fullRef, truncated, lineCount: lines.length };
  } finally {
    db.close();
  }
}

// ─── Session Read Log (PreToolUse Read dedup) ────────────────────────────────

/**
 * Record a Read of `path` in the current session. Called by the PreToolUse
 * hook AFTER it allows the Read through (so duplicate-Read detection fires
 * on the second attempt).
 */
export function recordSessionRead(
  projectPath: string,
  sessionId:   string,
  path:        string
): void {
  const db = openDb(projectPath);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO session_read_log(session_id, path, read_at) VALUES (?, ?, ?)`
    ).run(sessionId, path, new Date().toISOString());
  } finally {
    db.close();
  }
}

/**
 * True if `path` was already Read in this session. Used by PreToolUse
 * hook to block duplicate Reads and route the agent to zc_file_summary.
 */
export function wasReadThisSession(
  projectPath: string,
  sessionId:   string,
  path:        string
): boolean {
  if (!Config.READ_DEDUP_ENABLED) return false;
  const db = openDb(projectPath);
  try {
    type Row = { n: number };
    const r = db.prepare(
      `SELECT COUNT(*) as n FROM session_read_log WHERE session_id = ? AND path = ?`
    ).get(sessionId, path) as Row;
    return r.n > 0;
  } finally {
    db.close();
  }
}

/**
 * Wipe the session_read_log for a given session (called on SessionEnd /
 * next SessionStart). Prevents cross-session false positives.
 */
export function clearSessionReadLog(projectPath: string, sessionId: string): void {
  const db = openDb(projectPath);
  try {
    db.prepare(`DELETE FROM session_read_log WHERE session_id = ?`).run(sessionId);
  } finally {
    db.close();
  }
}

// ─── zc_check — memory-first answer wrapper ──────────────────────────────────

/**
 * Memory-first: search the KB for the question. If we have reasonable
 * matches, return them with the indexed sources. If not, return a prompt
 * telling the agent which files to Read to fill the gap.
 *
 * This is intentionally thin — it wraps the existing searchKnowledge so
 * the agent has a clear memory-first verb to reach for instead of Read.
 */
export interface CheckResult {
  question:   string;
  answered:   boolean;
  confidence: "high" | "medium" | "low" | "none";
  sources:    string[];
  snippet:    string;
  suggestion: string;
}

export function checkAnswer(
  projectPath: string,
  question:    string,
  hits:        Array<{ source: string; snippet: string; rank: number }>
): CheckResult {
  if (hits.length === 0) {
    return {
      question,
      answered:   false,
      confidence: "none",
      sources:    [],
      snippet:    "",
      suggestion: "No KB match. Run zc_index_project first, or Read the specific file you need — but only the byte range you actually care about.",
    };
  }

  // Very rough confidence heuristic based on top BM25 rank magnitude.
  // (BM25 ranks in this codebase are negative — closer-to-0 = better.)
  const topRank = Math.abs(hits[0].rank);
  let confidence: CheckResult["confidence"];
  if (topRank < 2)      confidence = "high";
  else if (topRank < 5) confidence = "medium";
  else                  confidence = "low";

  const sources = hits.slice(0, 5).map((h) => h.source);
  const snippet = hits.slice(0, 3).map((h) => `[${h.source}]\n${h.snippet}`).join("\n\n");

  return {
    question,
    answered:   true,
    confidence,
    sources,
    snippet,
    suggestion: confidence === "high"
      ? "High-confidence KB hit. Prefer this over a file Read."
      : "Lower confidence — if the snippet isn't enough, Read the top source with a targeted line range.",
  };
}

// ─── Small utility: DB path helper re-export (for tests) ─────────────────────
export { dbPath as harnessDbPath };
