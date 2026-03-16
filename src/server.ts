import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cwd } from "node:process";
import { runInSandbox, runFileInSandbox } from "./sandbox.js";
import { indexContent, searchKnowledge } from "./knowledge.js";
import { fetchAndConvert } from "./fetcher.js";
import { getRecentEvents } from "./session.js";
import { rememberFact, recallWorkingMemory, archiveSessionSummary, formatWorkingMemoryForContext } from "./memory.js";
import { checkIntegrity } from "./integrity.js";

const VERSION = "0.3.0";
const PROJECT_PATH = cwd();

// ─── Startup integrity check ─────────────────────────────────────────────────
const integrity = checkIntegrity(VERSION);
if (integrity.firstRun) {
  process.stderr.write("[zc-ctx] Integrity baseline established for v" + VERSION + "\n");
} else if (!integrity.ok) {
  // Log to stderr — visible in Claude Code's MCP log, doesn't crash the plugin
  for (const w of integrity.warnings) {
    process.stderr.write(`[zc-ctx] ⚠️  INTEGRITY WARNING: ${w}\n`);
  }
}

// ─── Fetch rate limiting ──────────────────────────────────────────────────────
// Per-session in-memory counter. Prevents zc_fetch being used as a web crawler
// or network scanner. Resets when the MCP server process restarts (per session).
// SECURITY: rate limiting by project path (each project has its own limit)
const fetchCounts = new Map<string, number>();
const FETCH_LIMIT = 50;

function checkFetchLimit(projectPath: string): void {
  const count = fetchCounts.get(projectPath) ?? 0;
  if (count >= FETCH_LIMIT) {
    throw new Error(
      `Fetch rate limit reached: ${FETCH_LIMIT} fetches per session. ` +
      `Use zc_index to manually add content instead.`
    );
  }
  fetchCounts.set(projectPath, count + 1);
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
        language: {
          type: "string",
          enum: ["python", "python3", "javascript", "js", "bash", "sh"],
        },
        code: { type: "string", description: "Code to execute" },
      },
      required: ["language", "code"],
    },
  },
  {
    name: "zc_execute_file",
    description:
      "Run analysis code against a specific file in the sandbox. " +
      "TARGET_FILE variable is injected with the absolute path.",
    inputSchema: {
      type: "object",
      properties: {
        path:     { type: "string" },
        language: { type: "string", enum: ["python", "python3"] },
        code:     { type: "string", description: "Analysis code using TARGET_FILE" },
      },
      required: ["path", "language", "code"],
    },
  },
  {
    name: "zc_fetch",
    description:
      "Fetch a public URL, convert to markdown, and index into the knowledge base. " +
      "Private IPs, localhost, and cloud metadata endpoints (AWS/GCP/Azure) are blocked. " +
      "DNS resolution is checked to prevent rebinding attacks. " +
      "Credential headers are stripped automatically. " +
      "Rate limited to 50 fetches per session.",
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
        queries: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
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
        queries: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["commands", "queries"],
    },
  },
  {
    name: "zc_remember",
    description:
      "Store a key-value fact in working memory (MemGPT-style). " +
      "Working memory is bounded (50 facts max) — lowest-importance facts are auto-evicted to " +
      "archival memory (the KB) when full. Use importance 5 for critical facts (API decisions, " +
      "architecture choices), 1 for ephemeral notes. " +
      "Facts survive MCP server restarts within a project.",
    inputSchema: {
      type: "object",
      properties: {
        key:        { type: "string", description: "Short identifier for this fact (max 100 chars)" },
        value:      { type: "string", description: "The fact to remember (max 500 chars)" },
        importance: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          description: "1=ephemeral, 3=normal, 5=critical — drives eviction priority",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "zc_recall_context",
    description:
      "Recall current working memory and recent session events. " +
      "Call this at the start of a session to restore project context without reading files. " +
      "Returns: working memory facts (importance-ranked) + last 20 session events.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "zc_summarize_session",
    description:
      "Archive a session summary to long-term memory (MemGPT session eviction). " +
      "Call this when a significant task is complete. The summary is stored in the knowledge " +
      "base (searchable via zc_search) and promoted to high-importance working memory. " +
      "Future sessions can recall this context via zc_recall_context or zc_search.",
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
];

// ─── Server setup ─────────────────────────────────────────────────────────────
const server = new Server(
  { name: "zc-ctx", version: VERSION },
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
        // SECURITY: rate limit check BEFORE making any network call
        checkFetchLimit(PROJECT_PATH);
        const fetched = await fetchAndConvert(url);
        const label = source ?? fetched.title ?? url;
        indexContent(PROJECT_PATH, fetched.markdown, label);
        const remaining = FETCH_LIMIT - (fetchCounts.get(PROJECT_PATH) ?? 0);
        return {
          content: [{
            type: "text",
            text:
              `## Fetched: ${fetched.title}\n` +
              `Source: ${fetched.url}\n` +
              `Size: ${(fetched.byteSize / 1024).toFixed(1)} KB | ` +
              `Fetches remaining this session: ${remaining}\n` +
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
          const vecInfo = r.vectorScore !== undefined
            ? ` | cosine: ${r.vectorScore.toFixed(3)}`
            : " | BM25 only";
          return `### Result ${i + 1}: ${r.source}\nScore: ${r.rank.toFixed(4)}${vecInfo}\n\n${r.snippet}`;
        }).join("\n\n---\n\n");
        return { content: [{ type: "text", text: formatted }] };
      }

      case "zc_batch": {
        const { commands, queries } = args as {
          commands: Array<{ label: string; command: string }>;
          queries: string[];
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
            const vecInfo = r.vectorScore !== undefined ? ` (cosine: ${r.vectorScore.toFixed(3)})` : "";
            sections.push(`### ${r.source}${vecInfo}\n${r.snippet}`);
          }
        }
        return { content: [{ type: "text", text: sections.join("\n\n") }] };
      }

      case "zc_remember": {
        const { key, value, importance } = args as { key: string; value: string; importance?: number };
        rememberFact(PROJECT_PATH, key, value, importance);
        const wm = recallWorkingMemory(PROJECT_PATH);
        return {
          content: [{
            type: "text",
            text: `Remembered: [★${importance ?? 3}] ${key}\nWorking memory: ${wm.length}/50 facts`,
          }],
        };
      }

      case "zc_recall_context": {
        const wm = recallWorkingMemory(PROJECT_PATH);
        const events = getRecentEvents(PROJECT_PATH, 20);

        const parts: string[] = [formatWorkingMemoryForContext(wm)];

        if (events.length > 0) {
          parts.push("\n## Recent Session Events");
          for (const e of events) {
            if (e.event_type === "file_write" && e.file_path)
              parts.push(`- wrote: ${e.file_path}`);
            else if (e.event_type === "task_complete" && e.task_name)
              parts.push(`- completed: ${e.task_name}`);
            else if (e.event_type === "error" && e.error_type)
              parts.push(`- error: ${e.error_type}`);
          }
        } else {
          parts.push("\n## Recent Session Events\nNo events recorded yet.");
        }

        // Integrity status
        if (!integrity.ok) {
          parts.push("\n## ⚠️ Integrity Warning");
          parts.push(integrity.warnings.join("\n"));
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
              `Session summary archived to long-term memory.\n` +
              `Searchable via: zc_search(["session summary"])\n` +
              `Recallable via: zc_recall_context()\n\n` +
              `Summary stored:\n${summary}`,
          }],
        };
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
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
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
