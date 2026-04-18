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
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, sep, extname } from "node:path";
import { createHash } from "node:crypto";
import { Config } from "./config.js";
import { openDb, indexContent, dbPath } from "./knowledge.js";
import { summarizeFile, selectSummaryModel } from "./summarizer.js";

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
  graphReportIndexed:   boolean;    // v0.13.0: graphify-out/GRAPH_REPORT.md auto-indexed
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
 *   2. Per-file pipeline: summarize via Ollama, immediately write to KB (v0.10.4 write-as-you-go).
 *   3. Fall back to deterministic truncation per-file on Ollama failure.
 *   4. Write each file to FTS + source_meta with its best summary.
 *   5. Fire-and-forget embeddings (indexContent handles this).
 *
 * Each file becomes a KB entry with source=`file:<relative-path>`.
 * Re-running is idempotent — `indexContent` uses INSERT OR REPLACE on source.
 */
export async function indexProject(
  projectPath: string,
  options: {
    excludes?:   string[];
    extensions?: string[];
    maxBytes?:   number;
    /** Called after each file is summarized. Enables live progress UI
     *  (e.g. background-index.mjs writes a status file on each tick). */
    onProgress?: (done: number, total: number, path: string) => void;
  } = {}
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

  // Phase 2+3 (v0.10.4): write-as-you-go pipeline. Each worker summarizes a
  // file via Ollama, then immediately writes the result to the KB. Benefits
  // over the old batch-then-write design:
  //   - Crash at file N preserves all N-1 summaries (incremental durability).
  //   - Other sessions probing the KB mid-index see real-time progress,
  //     not "0 files done" until the very end.
  //   - onProgress callback fires AFTER the DB write, so status files and
  //     consumer UIs reflect actual KB state, not mid-flight summarization.
  //
  // Concurrency replicates the bounded-worker pattern from summarizeBatch
  // (which would otherwise accumulate all summaries in memory).
  let filesIndexed    = 0;
  let bytesRead       = 0;
  let semanticCount   = 0;
  let truncationCount = 0;
  let semanticModel: string | null = null;

  const concurrency = Math.max(1, Config.SUMMARY_CONCURRENCY);
  const queue       = [...candidates];
  const total       = candidates.length;
  let done = 0;

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const c = queue.shift();
      if (!c) return;

      // Summarize (semantic via Ollama, or deterministic truncation fallback)
      let sum;
      try {
        sum = await summarizeFile(c.relPath, c.content);
      } catch {
        // Summarization should never throw (summarizeFile returns truncation on
        // error), but belt-and-suspenders:
        sum = { l0: c.content.slice(0, Config.TIER_L0_CHARS).trim(),
                l1: c.content.slice(0, Config.TIER_L1_CHARS).trim(),
                source: "truncation" as const };
      }

      // Immediately persist to KB (no waiting for the whole batch)
      const source = `file:${c.relPath}`;
      try {
        indexContent(projectPath, c.content, source, "internal", "internal", sum.l0, sum.l1);
        bytesRead    += c.bytes;
        filesIndexed += 1;
        if (sum.source === "semantic") {
          semanticCount += 1;
          if (!semanticModel && sum.modelUsed) semanticModel = sum.modelUsed;
        } else {
          truncationCount += 1;
        }
      } catch {
        filesSkipped += 1;
      }

      // Progress fires AFTER the write — status files now reflect real DB state
      done += 1;
      options.onProgress?.(done, total, c.relPath);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Re-probe in case no file summary populated modelUsed (all truncation)
  if (!semanticModel && Config.SUMMARY_ENABLED) {
    try { semanticModel = await selectSummaryModel(); } catch { /* noop */ }
  }

  // v0.13.0: auto-index graphify GRAPH_REPORT.md if present.
  // The structural map produced by graphify gives architectural orientation
  // at near-zero cost — having it in the KB means agents can find it via
  // normal zc_search instead of needing to know graphify's tools exist.
  let graphReportIndexed = false;
  try {
    const { findGraphReport } = await import("./graph_proxy.js");
    const reportPath = findGraphReport(projectPath);
    if (reportPath) {
      const reportContent = readFileSync(reportPath, "utf8");
      // Use a special source name so it's identifiable in zc_search results
      indexContent(
        projectPath,
        reportContent,
        "graphify://GRAPH_REPORT.md",
        "internal",
        "internal",
        // L0: a deterministic blurb so the agent knows what this is
        "GRAPH_REPORT.md from graphify — structural knowledge graph: god nodes, communities, suggested architectural questions. Use zc_graph_query / zc_graph_path / zc_graph_neighbors for deeper queries.",
        // L1: first ~2000 chars of the report itself
        reportContent.slice(0, 2000),
      );
      graphReportIndexed = true;
    }
  } catch { /* graphify integration optional */ }

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
    graphReportIndexed,
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

// ─── Indexing status (v0.10.2 — auto-index awareness) ───────────────────────
// The background-indexer (scripts/background-index.mjs) writes a small JSON
// "status" file per project while indexing is running. These helpers read it
// so the health banner can show "indexing: 12/50 files" live.

export interface IndexingStatus {
  state:            "not-indexed" | "indexing" | "indexed";
  totalFiles?:      number;
  completedFiles?:  number;
  startedAt?:       string;
  finishedAt?:      string;
  model?:           string | null;
  error?:           string | null;
  fileCountInKb?:   number;         // current number of file:-prefixed KB entries
}

function statusFilePath(projectPath: string): string {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(Config.DB_DIR, `${hash}.indexing.status`);
}

/**
 * Determine where this project sits in the indexing lifecycle. Reads both the
 * status file (written by background-index.mjs while it's running) and the
 * source_meta table (to detect "already indexed"). Never throws.
 */
export function getIndexingStatus(projectPath: string): IndexingStatus {
  const statusPath = statusFilePath(projectPath);

  // Check source_meta first — definitive "are there entries yet?"
  let fileCount = 0;
  try {
    const db = openDb(projectPath);
    try {
      type Row = { n: number };
      const r = db.prepare(`SELECT COUNT(*) as n FROM source_meta WHERE source LIKE 'file:%'`).get() as Row;
      fileCount = r.n;
    } finally {
      db.close();
    }
  } catch { /* no DB yet → fileCount stays 0 */ }

  // Is a background indexer currently running?
  if (existsSync(statusPath)) {
    try {
      const raw = readFileSync(statusPath, "utf8");
      const s   = JSON.parse(raw) as {
        started_at?: string; finished_at?: string; total_files?: number;
        completed_files?: number; model?: string; error?: string;
      };
      // Stale? (> 1h since start and not finished → consider abandoned)
      const ageMs = s.started_at ? Date.now() - new Date(s.started_at).getTime() : 0;
      if (!s.finished_at && ageMs > 3600_000) {
        // Fall through — report as not-indexed if fileCount is 0
      } else if (!s.finished_at) {
        return {
          state:            "indexing",
          totalFiles:       s.total_files,
          completedFiles:   s.completed_files ?? 0,
          startedAt:        s.started_at,
          model:            s.model ?? null,
          fileCountInKb:    fileCount,
        };
      }
    } catch { /* unreadable — fall through */ }
  }

  return {
    state:         fileCount > 0 ? "indexed" : "not-indexed",
    fileCountInKb: fileCount,
  };
}

// ─── System Health (degradation awareness) ────────────────────────────────────

export interface SystemHealth {
  mode:              "full" | "degraded" | "onboarding";
  ollamaReachable:   boolean;
  embeddingReady:    boolean;     // nomic-embed-text (or configured embed model) installed
  summarizerReady:   boolean;     // a coder/chat model installed for semantic L0/L1
  summarizerModel:   string | null;
  httpApiReachable:  boolean | null;   // null if not configured (SQLite mode)
  httpApiUrl:        string | null;
  indexingStatus:    IndexingStatus | null;  // v0.10.2 — null if not probed
  warnings:          string[];
  fixes:             string[];    // actionable commands to restore full mode
}

/**
 * Probe external dependencies and report what's healthy and what's degraded.
 * Cached ~30s to avoid hitting Ollama/API on every zc_status call.
 *
 * Non-throwing — if any probe errors, that dependency is flagged unhealthy.
 */
let _healthCache: SystemHealth | null = null;
let _healthCheckedAt = 0;
const HEALTH_TTL_MS = 30_000;

export async function getSystemHealth(projectPath?: string): Promise<SystemHealth> {
  const now = Date.now();
  if (_healthCache && now - _healthCheckedAt < HEALTH_TTL_MS) return _healthCache;

  const warnings: string[] = [];
  const fixes:    string[] = [];

  // Derive Ollama base from the configured URL (same as summarizer)
  const ollamaBase = Config.OLLAMA_URL.replace(/\/api\/[^/]*\/?$/, "");

  // ── Ollama reachability + model inventory ───────────────────────────────
  let ollamaReachable = false;
  let installed = new Set<string>();
  try {
    const res = await fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    if (res.ok) {
      ollamaReachable = true;
      const j = await res.json() as { models?: Array<{ name: string }> };
      installed = new Set((j.models ?? []).map((m) => m.name));
    }
  } catch { /* stays false */ }

  // Ollama treats "nomic-embed-text" and "nomic-embed-text:latest" as the
  // same model. Normalize for both lookup directions.
  const embedModel = Config.OLLAMA_MODEL;
  const installedNormalized = new Set(
    [...installed].flatMap((n) => [n, n.replace(/:latest$/, "")])
  );
  const embeddingReady = ollamaReachable &&
    (installedNormalized.has(embedModel) || installedNormalized.has(`${embedModel}:latest`));

  // Check for any coder/chat model (same preference list the summarizer probes)
  const PREFERRED = [
    "qwen2.5-coder:14b", "qwen2.5-coder:7b", "qwen2.5-coder:32b",
    "deepseek-coder:14b", "deepseek-coder:6.7b",
    "codellama:13b-instruct", "codellama:7b-instruct",
    "starcoder2:15b", "starcoder2:7b",
    "qwen2.5:14b", "qwen2.5:7b", "qwen2.5:3b",
    "llama3.1:latest", "llama3.1:8b", "llama3.2:3b", "llama3.2:latest",
  ];
  let summarizerModel: string | null = null;
  if (Config.SUMMARY_MODEL_OVERRIDE && installedNormalized.has(Config.SUMMARY_MODEL_OVERRIDE)) {
    summarizerModel = Config.SUMMARY_MODEL_OVERRIDE;
  } else {
    for (const m of PREFERRED) if (installedNormalized.has(m) || installedNormalized.has(`${m}:latest`)) { summarizerModel = m; break; }
  }
  const summarizerReady = ollamaReachable && summarizerModel !== null && Config.SUMMARY_ENABLED;

  if (!ollamaReachable) {
    warnings.push(`Ollama unreachable at ${ollamaBase} — search falls back to BM25-only, summaries fall back to truncation`);
    fixes.push(`Start Ollama: 'ollama serve' (native) OR 'docker compose up -d sc-ollama' (Docker stack)`);
  } else {
    if (!embeddingReady) {
      warnings.push(`Embedding model '${embedModel}' not installed — no semantic search, pure BM25 keyword match only`);
      fixes.push(`ollama pull ${embedModel}`);
    }
    if (!summarizerReady) {
      warnings.push(`No coder/chat model installed — L0/L1 summaries fall back to first-N-char truncation (agents may re-Read files instead)`);
      fixes.push(`ollama pull qwen2.5-coder:14b   (recommended sweet spot for 16GB+ VRAM)`);
    }
  }

  // ── HTTP API reachability (only meaningful in Docker mode) ──────────────
  const apiUrl = process.env.ZC_API_URL ?? null;
  let httpApiReachable: boolean | null = null;
  if (apiUrl) {
    httpApiReachable = false;
    try {
      const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(2_000) });
      httpApiReachable = res.ok;
    } catch { /* stays false */ }
    if (!httpApiReachable) {
      warnings.push(`HTTP API at ${apiUrl} unreachable — storage tools (zc_remember, zc_search, zc_broadcast) will fail`);
      fixes.push(`docker compose up -d sc-api sc-postgres`);
    }
  }

  // ── Indexing status (v0.10.2) ────────────────────────────────────────────
  // If a project path is supplied, probe whether this project has been indexed.
  // "not-indexed" and "indexing" are NOT hard errors — they're onboarding states,
  // so we use mode='onboarding' rather than 'degraded' to keep full-mode agents
  // from seeing the big yellow warning block.
  let indexingStatus: IndexingStatus | null = null;
  if (projectPath) {
    try { indexingStatus = getIndexingStatus(projectPath); } catch { /* noop */ }
  }

  let mode: "full" | "degraded" | "onboarding";
  if (warnings.length > 0) {
    mode = "degraded";
  } else if (indexingStatus && indexingStatus.state !== "indexed") {
    mode = "onboarding";
  } else {
    mode = "full";
  }

  _healthCache = {
    mode,
    ollamaReachable,
    embeddingReady,
    summarizerReady,
    summarizerModel,
    httpApiReachable,
    httpApiUrl: apiUrl,
    indexingStatus,
    warnings,
    fixes,
  };
  _healthCheckedAt = now;
  return _healthCache;
}

/**
 * Format a SystemHealth as a short banner suitable for prepending to
 * tool output (zc_status, zc_recall_context). Returns empty string in
 * full-mode so happy paths stay noise-free.
 *
 * Three banner shapes:
 *   - "full"       → empty string (happy path, no noise)
 *   - "onboarding" → short info block about initial indexing (not an error)
 *   - "degraded"   → yellow warning block with fix commands
 */
export function formatHealthBanner(h: SystemHealth): string {
  if (h.mode === "full") return "";

  const lines: string[] = [];

  if (h.mode === "onboarding") {
    // Indexing state takes precedence over a missing project card etc.
    const st = h.indexingStatus;
    if (st?.state === "indexing") {
      const pct = (st.completedFiles && st.totalFiles)
        ? Math.floor((st.completedFiles / st.totalFiles) * 100)
        : null;
      lines.push(`ℹ  SecureContext — indexing in progress (${st.completedFiles ?? 0}/${st.totalFiles ?? "?"} files${pct !== null ? `, ${pct}%` : ""})`);
      lines.push(`   Semantic L0/L1 summaries are being generated in the background.`);
      lines.push(`   zc_file_summary(path) may return 'not indexed' for files not yet processed —`);
      lines.push(`   fall back to Read for those; the PostEdit hook will catch them up on any edit.`);
      if (st.model) lines.push(`   Model: ${st.model}`);
      lines.push(``);
    } else if (st?.state === "not-indexed") {
      lines.push(`ℹ  SecureContext — this project has no indexed source files yet`);
      lines.push(`   Run zc_index_project() to generate semantic L0/L1 summaries (~30-60s typical).`);
      lines.push(`   Or: let the PostEdit hook index files one-by-one as you edit them.`);
      lines.push(`   The SessionStart auto-indexer should have started this in the background;`);
      lines.push(`   if you don't see progress, check hooks/INSTALL.md to enable it.`);
      lines.push(``);
    }
    return lines.join("\n");
  }

  // mode === "degraded"
  lines.push(`⚠️  SecureContext — DEGRADED MODE (${h.warnings.length} issue${h.warnings.length === 1 ? "" : "s"})`);
  lines.push(`   Some v0.10.0 harness features are unavailable. Session will work but less efficiently.`);
  lines.push(``);
  for (const w of h.warnings) lines.push(`   • ${w}`);
  if (h.fixes.length > 0) {
    lines.push(``);
    lines.push(`   Fix:`);
    for (const f of h.fixes) lines.push(`     $ ${f}`);
  }
  lines.push(``);
  return lines.join("\n");
}

/** Reset the health probe cache. Useful in tests. */
export function resetHealthCache(): void {
  _healthCache = null;
  _healthCheckedAt = 0;
}

// ─── Small utility: DB path helper re-export (for tests) ─────────────────────
export { dbPath as harnessDbPath };
