import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cwd } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { Config } from "./config.js";
import { runInSandbox, runFileInSandbox } from "./sandbox.js";
import { indexContent, searchKnowledge, getKbStats } from "./knowledge.js";
import { fetchAndConvert } from "./fetcher.js";
import { getRecentEvents } from "./session.js";
import {
  rememberFact,
  forgetFact,
  recallWorkingMemory,
  archiveSessionSummary,
  formatWorkingMemoryForContext,
  getMemoryStats,
} from "./memory.js";
import { checkIntegrity, type IntegrityResult } from "./integrity.js";
import { getCurrentSchemaVersion } from "./migrations.js";
import { ACTIVE_MODEL } from "./embedder.js";

const PROJECT_PATH = cwd();

// ─── Startup integrity check ─────────────────────────────────────────────────
const integrity: IntegrityResult = checkIntegrity(Config.VERSION);

if (integrity.firstRun) {
  process.stderr.write(`[zc-ctx] Integrity baseline established for v${Config.VERSION}\n`);
} else if (!integrity.ok) {
  for (const w of integrity.warnings) {
    process.stderr.write(`[zc-ctx] ⚠️  INTEGRITY WARNING: ${w}\n`);
  }
  // STRICT MODE: refuse to start if tampered (ZC_STRICT_INTEGRITY=1)
  if (integrity.strictMode) {
    process.stderr.write(
      `[zc-ctx] STRICT MODE: integrity failure is fatal. ` +
      `Run: rm ~/.claude/zc-ctx/integrity.json to re-baseline after a legitimate update.\n`
    );
    process.exit(1);
  }
}

// ─── Persistent fetch rate limiting ──────────────────────────────────────────
// Per-project, per-day counter stored in SQLite global.db.
// Resets at UTC midnight each day. More meaningful than per-session limits.
function openGlobalDb(): DatabaseSync {
  mkdirSync(Config.GLOBAL_DIR, { recursive: true });
  const db = new DatabaseSync(join(Config.GLOBAL_DIR, "global.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      project_hash TEXT    NOT NULL,
      date         TEXT    NOT NULL,
      fetch_count  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_hash, date)
    );
  `);
  return db;
}

function checkAndIncrementFetchLimit(projectPath: string): { remaining: number } {
  const db          = openGlobalDb();
  const projectHash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  const today       = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  type Row = { fetch_count: number };
  const row = db.prepare(
    "SELECT fetch_count FROM rate_limits WHERE project_hash = ? AND date = ?"
  ).get(projectHash, today) as Row | undefined;

  const currentCount = row?.fetch_count ?? 0;

  if (currentCount >= Config.FETCH_LIMIT) {
    db.close();
    throw new Error(
      `Daily fetch limit reached: ${Config.FETCH_LIMIT} fetches/day per project. ` +
      `Resets at UTC midnight. Use zc_index to manually add content instead.`
    );
  }

  db.prepare(`
    INSERT INTO rate_limits(project_hash, date, fetch_count) VALUES (?, ?, 1)
    ON CONFLICT(project_hash, date) DO UPDATE SET fetch_count = fetch_count + 1
  `).run(projectHash, today);

  db.close();
  return { remaining: Config.FETCH_LIMIT - currentCount - 1 };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS: Tool[] = [
  {
    name: "zc_execute",
    description:
      "Run code in a secure isolated sandbox. Code is delivered via stdin (not visible in process list). " +
      "No credentials in the sandbox environment — only PATH. " +
      "Hard limits: 30s timeout, 512KB stdout cap, 64KB stderr cap. " +
      "Supported languages: python, javascript, bash.",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "python3", "javascript", "js", "bash", "sh"] },
        code:     { type: "string", description: "Code to execute" },
      },
      required: ["language", "code"],
    },
  },
  {
    name: "zc_execute_file",
    description:
      "Run analysis code against a specific file in the sandbox. " +
      "TARGET_FILE variable is injected via stdin (not visible in process list — Gap 8 fix).",
    inputSchema: {
      type: "object",
      properties: {
        path:     { type: "string" },
        language: { type: "string", enum: ["python", "python3"] },
        code:     { type: "string", description: "Analysis code using TARGET_FILE variable" },
      },
      required: ["path", "language", "code"],
    },
  },
  {
    name: "zc_fetch",
    description:
      "Fetch a public URL, convert to markdown, and index into the knowledge base. " +
      "Private IPs, localhost, and cloud metadata endpoints are blocked. " +
      "DNS resolution checked to prevent rebinding attacks. " +
      "Rate limited to 50 fetches/day per project (persistent, resets at UTC midnight).",
    inputSchema: {
      type: "object",
      properties: {
        url:    { type: "string", description: "Public URL to fetch (http/https only)" },
        source: { type: "string", description: "Optional label for this KB entry" },
      },
      required: ["url"],
    },
  },
  {
    name: "zc_index",
    description: "Manually index text into the session knowledge base for later hybrid search.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        source:  { type: "string", description: "Label for this content entry" },
      },
      required: ["content", "source"],
    },
  },
  {
    name: "zc_search",
    description:
      "Hybrid BM25 + semantic vector search across the knowledge base. " +
      "If Ollama (nomic-embed-text) is running locally, cosine similarity reranking is applied. " +
      "Falls back to pure BM25 if Ollama is unavailable. " +
      "Pass multiple queries to search several topics at once.",
    inputSchema: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["queries"],
    },
  },
  {
    name: "zc_batch",
    description:
      "Execute shell commands in sandbox AND search the knowledge base in one parallel call. " +
      "Ideal for research: run commands while retrieving existing knowledge simultaneously.",
    inputSchema: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label:   { type: "string" },
              command: { type: "string" },
            },
            required: ["label", "command"],
          },
        },
        queries: { type: "array", items: { type: "string" } },
      },
      required: ["commands", "queries"],
    },
  },
  {
    name: "zc_remember",
    description:
      "Store a key-value fact in working memory (MemGPT-style). " +
      "Working memory is bounded (50 facts max) — lowest-importance facts auto-evict to archival KB. " +
      "Use importance 5 for critical facts, 1 for ephemeral notes. " +
      "Use agent_id to namespace facts for parallel agent use.",
    inputSchema: {
      type: "object",
      properties: {
        key:        { type: "string", description: "Short identifier (max 100 chars)" },
        value:      { type: "string", description: "The fact to remember (max 500 chars)" },
        importance: { type: "integer", minimum: 1, maximum: 5, description: "1=ephemeral, 3=normal, 5=critical" },
        agent_id:   { type: "string", description: "Agent namespace for parallel use (default: 'default')" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "zc_forget",
    description:
      "Delete a specific key from working memory. " +
      "Use to remove stale, incorrect, or sensitive facts. Safe to call even if key doesn't exist.",
    inputSchema: {
      type: "object",
      properties: {
        key:      { type: "string", description: "Working memory key to delete (max 100 chars)" },
        agent_id: { type: "string", description: "Agent namespace (default: 'default')" },
      },
      required: ["key"],
    },
  },
  {
    name: "zc_recall_context",
    description:
      "Recall working memory and recent session events. " +
      "Call this at the start of every session to restore project context. " +
      "Returns structured sections: Working Memory · Session Events · System Status.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent namespace (default: 'default')" },
      },
      required: [],
    },
  },
  {
    name: "zc_summarize_session",
    description:
      "Archive a session summary to long-term memory (MemGPT session eviction). " +
      "Call when a significant task is complete. Summary is searchable via zc_search. " +
      "Kept for 365 days (vs 30 days for regular KB content).",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "2–5 sentence summary of what was accomplished, key decisions made, and current state",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "zc_status",
    description:
      "Show SecureContext health: DB size, KB entry counts, working memory fill, " +
      "schema version, embedding model, today's fetch budget, and integrity status. " +
      "Call this to diagnose issues or verify the plugin is working correctly.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent namespace for memory stats (default: 'default')" },
      },
      required: [],
    },
  },
];

// ─── Server setup ──────────────────────────────────────────────────────────────
const server = new Server(
  { name: "zc-ctx", version: Config.VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      case "zc_execute": {
        const { language, code } = args as { language: string; code: string };
        const result = await runInSandbox(language, code);
        return { content: [{ type: "text", text: formatSandboxResult(result) }] };
      }

      case "zc_execute_file": {
        const { path, language, code } = args as { path: string; language: string; code: string };
        const result = await runFileInSandbox(path, language, code);
        return { content: [{ type: "text", text: formatSandboxResult(result) }] };
      }

      case "zc_fetch": {
        const { url, source } = args as { url: string; source?: string };
        // SECURITY: rate limit check BEFORE any network call
        const { remaining } = checkAndIncrementFetchLimit(PROJECT_PATH);
        const fetched  = await fetchAndConvert(url);
        const label    = source ?? fetched.title ?? url;
        indexContent(PROJECT_PATH, fetched.markdown, label, "external", "external");
        return {
          content: [{
            type: "text",
            text:
              `## Fetched: ${fetched.title}\n` +
              `Source: ${fetched.url}\n` +
              `Size: ${(fetched.byteSize / 1024).toFixed(1)} KB | ` +
              `Fetches remaining today: ${remaining}\n` +
              `Indexed as: "${label}"\n\n` +
              fetched.markdown.slice(0, 8_000),
          }],
        };
      }

      case "zc_index": {
        const { content, source } = args as { content: string; source: string };
        indexContent(PROJECT_PATH, content, source);
        return { content: [{ type: "text", text: `Indexed "${source}" (${content.length} chars). Embedding computing in background.` }] };
      }

      case "zc_search": {
        const { queries } = args as { queries: string[] };
        const results = await searchKnowledge(PROJECT_PATH, queries);
        if (results.length === 0) {
          return { content: [{ type: "text", text: "No results found in knowledge base." }] };
        }
        const formatted = results.map((r, i) => {
          const vecInfo     = r.vectorScore !== undefined ? ` | cosine: ${r.vectorScore.toFixed(3)}` : " | BM25 only";
          const trustBadge  = r.sourceType === "external" ? " [EXTERNAL]" : "";
          const asciiBadge  = r.nonAsciiSource ? " [⚠️ NON-ASCII SOURCE]" : "";
          return `### Result ${i + 1}: ${r.source}${trustBadge}${asciiBadge}\nScore: ${r.rank.toFixed(4)}${vecInfo}\n\n${r.snippet}`;
        }).join("\n\n---\n\n");
        return { content: [{ type: "text", text: formatted }] };
      }

      case "zc_batch": {
        const { commands, queries } = args as {
          commands: Array<{ label: string; command: string }>;
          queries:  string[];
        };
        const [commandResults, searchResults] = await Promise.all([
          Promise.all(commands.map(async ({ label, command }) => ({
            label,
            result: await runInSandbox("bash", command),
          }))),
          searchKnowledge(PROJECT_PATH, queries),
        ]);

        const sections: string[] = [];
        for (const { label, result } of commandResults) {
          sections.push(`## ${label}\n\`\`\`\n${formatSandboxResult(result)}\n\`\`\``);
        }
        if (searchResults.length > 0) {
          sections.push("## Knowledge Base Results");
          for (const r of searchResults) {
            const vecInfo    = r.vectorScore !== undefined ? ` (cosine: ${r.vectorScore.toFixed(3)})` : "";
            const trustBadge = r.sourceType === "external" ? " [EXTERNAL]" : "";
            const asciiBadge = r.nonAsciiSource ? " [⚠️ NON-ASCII SOURCE]" : "";
            sections.push(`### ${r.source}${trustBadge}${asciiBadge}${vecInfo}\n${r.snippet}`);
          }
        }
        return { content: [{ type: "text", text: sections.join("\n\n") }] };
      }

      case "zc_remember": {
        const { key, value, importance, agent_id } = args as {
          key: string; value: string; importance?: number; agent_id?: string;
        };
        rememberFact(PROJECT_PATH, key, value, importance, agent_id);
        const stats = getMemoryStats(PROJECT_PATH, agent_id);
        return {
          content: [{
            type: "text",
            text: `Remembered: [★${importance ?? 3}] ${key}\nWorking memory: ${stats.count}/${stats.max} facts`,
          }],
        };
      }

      case "zc_forget": {
        const { key, agent_id } = args as { key: string; agent_id?: string };
        const deleted = forgetFact(PROJECT_PATH, key, agent_id);
        const stats   = getMemoryStats(PROJECT_PATH, agent_id);
        return {
          content: [{
            type: "text",
            text: deleted
              ? `Forgotten: '${key}' removed.\nWorking memory: ${stats.count}/${stats.max} facts`
              : `Key '${key}' was not in working memory.\nWorking memory: ${stats.count}/${stats.max} facts`,
          }],
        };
      }

      case "zc_recall_context": {
        const { agent_id } = args as { agent_id?: string };
        const wm     = recallWorkingMemory(PROJECT_PATH, agent_id);
        const events = getRecentEvents(PROJECT_PATH, 20);

        const parts: string[] = [];

        // Section 1: Working Memory (structured by priority)
        parts.push(formatWorkingMemoryForContext(wm, agent_id));

        // Section 2: Recent Session Events
        parts.push("\n## Recent Session Events");
        if (events.length > 0) {
          for (const e of events) {
            if      (e.event_type === "file_write"    && e.file_path)  parts.push(`  • wrote: ${e.file_path}`);
            else if (e.event_type === "task_complete" && e.task_name)  parts.push(`  • completed: ${e.task_name}`);
            else if (e.event_type === "error"         && e.error_type) parts.push(`  • error: ${e.error_type}`);
            else if (e.event_type === "session_ended")                 parts.push(`  • [SESSION BOUNDARY] ended at ${e.created_at}`);
          }
        } else {
          parts.push("  No events recorded yet.");
        }

        // Section 3: System Status (inline — no tool call needed)
        parts.push("\n## System Status");
        parts.push(`  Plugin: zc-ctx v${Config.VERSION}`);
        parts.push(`  Embedding model: ${ACTIVE_MODEL}`);
        if (!integrity.ok) {
          parts.push(`  ⚠️  Integrity: ${integrity.warnings.join("; ")}`);
        } else {
          parts.push(`  Integrity: OK`);
        }

        return { content: [{ type: "text", text: parts.join("\n") }] };
      }

      case "zc_summarize_session": {
        const { summary } = args as { summary: string };
        archiveSessionSummary(PROJECT_PATH, summary);
        return {
          content: [{
            type: "text",
            text:
              `Session summary archived.\n` +
              `Retention: 365 days (searchable via zc_search(["session summary"]))\n` +
              `Recalled via: zc_recall_context()\n\n` +
              `Summary stored:\n${summary}`,
          }],
        };
      }

      case "zc_status": {
        const { agent_id } = args as { agent_id?: string };

        const kbStats  = getKbStats(PROJECT_PATH);
        const wmStats  = getMemoryStats(PROJECT_PATH, agent_id);

        // Schema version
        const { DatabaseSync } = await import("node:sqlite");
        const { mkdirSync: mkd } = await import("node:fs");
        const { join: pjoin }    = await import("node:path");
        const { createHash: ch } = await import("node:crypto");
        mkd(Config.DB_DIR, { recursive: true });
        const dbFile   = pjoin(Config.DB_DIR, `${ch("sha256").update(PROJECT_PATH).digest("hex").slice(0,16)}.db`);
        const statusDb = new DatabaseSync(dbFile);
        const schemaV  = getCurrentSchemaVersion(statusDb);
        statusDb.close();

        // Today's fetch budget
        const db          = openGlobalDb();
        const projectHash = createHash("sha256").update(PROJECT_PATH).digest("hex").slice(0, 16);
        const today       = new Date().toISOString().slice(0, 10);
        type FetchRow     = { fetch_count: number };
        const fetchRow    = db.prepare(
          "SELECT fetch_count FROM rate_limits WHERE project_hash = ? AND date = ?"
        ).get(projectHash, today) as FetchRow | undefined;
        db.close();
        const fetchUsed      = fetchRow?.fetch_count ?? 0;
        const fetchRemaining = Config.FETCH_LIMIT - fetchUsed;

        const lines = [
          `## SecureContext Status — v${Config.VERSION}`,
          ``,
          `**Knowledge Base**`,
          `  Total entries:    ${kbStats.totalEntries}`,
          `  External entries: ${kbStats.externalEntries} (web-fetched, expire in ${Config.STALE_DAYS_EXTERNAL}d)`,
          `  Session summaries: ${kbStats.summaryEntries} (expire in ${Config.STALE_DAYS_SUMMARY}d)`,
          `  Embeddings cached: ${kbStats.embeddingsCached}`,
          `  DB size:           ${(kbStats.dbSizeBytes / 1024).toFixed(1)} KB`,
          ``,
          `**Working Memory** (agent: ${agent_id ?? "default"})`,
          `  Facts: ${wmStats.count}/${wmStats.max}`,
          `  Critical facts (★4-5): ${wmStats.criticalCount}`,
          ``,
          `**Schema**`,
          `  Migration version: ${schemaV}`,
          `  Embedding model:   ${ACTIVE_MODEL}`,
          ``,
          `**Fetch Budget (today)**`,
          `  Used:      ${fetchUsed}/${Config.FETCH_LIMIT}`,
          `  Remaining: ${fetchRemaining}`,
          `  Resets at: UTC midnight`,
          ``,
          `**Integrity**`,
          integrity.ok
            ? `  Status: OK`
            : `  Status: ⚠️  WARNINGS\n  ${integrity.warnings.join("\n  ")}`,
          integrity.strictMode ? `  Mode: STRICT (ZC_STRICT_INTEGRITY=1)` : `  Mode: warn-only`,
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

function formatSandboxResult(result: {
  stdout:    string;
  stderr:    string;
  exitCode:  number | null;
  timedOut:  boolean;
  truncated: boolean;
}): string {
  const parts: string[] = [];
  if (result.timedOut)  parts.push("[TIMED OUT after 30s]");
  if (result.truncated) parts.push("[OUTPUT TRUNCATED at 512KB]");
  if (result.stdout)    parts.push(`STDOUT:\n${result.stdout}`);
  if (result.stderr)    parts.push(`STDERR:\n${result.stderr}`);
  parts.push(`Exit code: ${result.exitCode ?? "killed"}`);
  return parts.join("\n\n");
}

const transport = new StdioServerTransport();
await server.connect(transport);
