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
import { indexContent, searchKnowledge, searchAllProjects, getKbStats, explainRetrieval } from "./knowledge.js";
import { fetchAndConvert } from "./fetcher.js";
import { getRecentEvents } from "./session.js";
import {
  rememberFact,
  forgetFact,
  recallWorkingMemory,
  archiveSessionSummary,
  formatWorkingMemoryForContext,
  getMemoryStats,
  broadcastFact,
  recallSharedChannel,
  replayBroadcasts,
  ackBroadcast,
  getBroadcastChainStatus,
  setChannelKey,
  isChannelKeyConfigured,
  formatSharedChannelForContext,
  computeProjectComplexity,
  type BroadcastType,
  type ComplexityProfile,
} from "./memory.js";
import {
  issueToken,
  revokeAllAgentTokens,
  countActiveSessions,
  type AgentRole,
} from "./access-control.js";
import { checkIntegrity, type IntegrityResult } from "./integrity.js";
import { getCurrentSchemaVersion } from "./migrations.js";
// Sprint 1 Phase B: telemetry interception
import { recordToolCall, newCallId, formatCostHeader } from "./telemetry.js";
import { computeCost } from "./pricing.js";
import { logger, newTraceId } from "./logger.js";
import { randomUUID } from "node:crypto";
import {
  indexProject,
  getFileSummary,
  getProjectCard,
  setProjectCard,
  captureToolOutput,
  checkAnswer,
  getSystemHealth,
  formatHealthBanner,
  type ProjectCard,
} from "./harness.js";
import { ACTIVE_MODEL, checkOllamaAvailable } from "./embedder.js";

const PROJECT_PATH = process.env["ZC_PROJECT_PATH"] || cwd();

// ─── HTTP client mode ─────────────────────────────────────────────────────────
// When ZC_API_URL is set, all tool calls are proxied to the SecureContext API
// server instead of accessing SQLite directly.  The tool schemas are identical —
// agents never know whether they are talking to a local DB or a remote server.
//
// Usage:
//   ZC_API_URL=http://sc-api:3099  ZC_API_KEY=<key>  node dist/server.js
//
// Authentication: every HTTP request carries "Authorization: Bearer <ZC_API_KEY>"
// ─────────────────────────────────────────────────────────────────────────────

const ZC_API_URL = process.env["ZC_API_URL"]?.replace(/\/$/, ""); // strip trailing slash
const ZC_API_KEY = process.env["ZC_API_KEY"];

/**
 * Proxy a tool call to the remote API server.
 * Returns the parsed JSON response body.
 * Throws on HTTP error or network failure.
 */
async function apiCall(
  method: "GET" | "POST" | "DELETE",
  path:   string,
  body?:  Record<string, unknown>
): Promise<Record<string, unknown>> {
  const url     = `${ZC_API_URL}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ZC_API_KEY) headers["Authorization"] = `Bearer ${ZC_API_KEY}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(String(json["error"] ?? `API error ${res.status}`));
  }
  return json;
}

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
    name: "zc_search_global",
    description:
      "Search across ALL projects in your SecureContext knowledge base (cross-project federated search). " +
      "Use when looking for patterns, decisions, or notes you remember from a different project. " +
      "Searches the N most recently active projects. External content trust warnings still apply.",
    inputSchema: {
      type: "object",
      properties: {
        queries:      { type: "array", items: { type: "string" }, minItems: 1, description: "Search terms (up to 5)" },
        max_projects: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "Max projects to search (most recently active first)" },
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
      "Working memory is bounded (100 facts base, scales up to 250 by project complexity) — lowest-importance facts auto-evict to archival KB. " +
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
      "Returns structured sections: Working Memory · Session Events · System Status. " +
      "v0.17.1: repeat calls within 60s by the same agent/project return a cached response " +
      "(unchanged if no new memory / broadcasts / events have landed), saving ~$0.06 per cached call. " +
      "Pass force:true to bypass the cache.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent namespace (default: 'default')" },
        force:    { type: "boolean", description: "Skip the recall cache and force a fresh pull (default: false)" },
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
  {
    name: "zc_broadcast",
    description:
      "Broadcast a coordination message to the shared A2A channel (Agent-to-Agent). " +
      "Use for multi-agent orchestration: assign tasks, report status, propose changes, " +
      "declare file dependencies, approve/reject/revise proposals. " +
      "Shared channel is readable by all agents via zc_recall_context(). " +
      "If a channel key is configured (via set_key action), all WRITE operations require it. " +
      "READ and STATUS actions never require a key. " +
      "Actions: ASSIGN · STATUS · PROPOSED · DEPENDENCY · MERGE · REJECT · REVISE · LAUNCH_ROLE · RETIRE_ROLE · set_key",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["ASSIGN", "STATUS", "PROPOSED", "DEPENDENCY", "MERGE", "REJECT", "REVISE", "LAUNCH_ROLE", "RETIRE_ROLE", "set_key"],
          description:
            "ASSIGN=orchestrator assigns task | STATUS=report progress | " +
            "PROPOSED=propose file changes | DEPENDENCY=declare file deps | " +
            "MERGE=approve changes | REJECT=reject changes | REVISE=request revision | " +
            "LAUNCH_ROLE=spawn new agent role (orchestrator, via dispatcher) | " +
            "RETIRE_ROLE=retire agent role (orchestrator, via dispatcher) | " +
            "set_key=configure channel key (orchestrator only)",
        },
        agent_id: {
          type: "string",
          description: "Sending agent identifier (e.g. 'orchestrator', 'agent-auth', 'agent-db')",
        },
        task: {
          type: "string",
          description: "Task name or description (max 500 chars)",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "File paths affected by this broadcast (max 50 entries)",
        },
        state: {
          type: "string",
          description: "Current state: e.g. 'in-progress', 'blocked', 'done'",
        },
        summary: {
          type: "string",
          description: "Human-readable summary of work done or decision made (max 1000 chars)",
        },
        depends_on: {
          type: "array",
          items: { type: "string" },
          description: "agent_ids whose outputs this broadcast depends on",
        },
        reason: {
          type: "string",
          description: "Reason for a REJECT or REVISE decision (max 500 chars)",
        },
        importance: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          description: "Priority: 1=low, 3=normal, 5=critical",
        },
        channel_key: {
          type: "string",
          description: "Channel capability key — required if key is configured. For set_key action, this IS the new key to set.",
        },
        session_token: {
          type: "string",
          description: "Session token from zc_issue_token — required when RBAC sessions are active.",
        },
      },
      required: ["type", "agent_id"],
    },
  },
  {
    name: "zc_issue_token",
    description:
      "Issue a signed RBAC session token for an agent (orchestrator use). " +
      "Token grants role-specific broadcast permissions. Valid 24 hours. " +
      "Chapter 6 session tokens + Chapter 14 RBAC. Requires channel_key if configured.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id:    { type: "string", description: "Agent identifier to issue token for" },
        role: {
          type: "string",
          enum: ["orchestrator", "developer", "marketer", "researcher", "worker"],
          description: "RBAC role — determines allowed broadcast types",
        },
        channel_key: { type: "string", description: "Channel key (required if configured)" },
      },
      required: ["agent_id", "role"],
    },
  },
  {
    name: "zc_revoke_token",
    description:
      "Revoke all session tokens for an agent. Requires channel_key if configured. " +
      "Agent will need a new token from zc_issue_token before it can broadcast again.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id:    { type: "string", description: "Agent whose tokens should be revoked" },
        channel_key: { type: "string", description: "Channel key (required if configured)" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "zc_explain",
    description:
      "Show retrieval transparency for a search query — BM25 scores, vector scores, merged rank, " +
      "and tier loaded for each result. Use to debug why certain content was or wasn't returned.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to explain" },
        depth: {
          type: "string",
          enum: ["L0", "L1", "L2"],
          description: "Content depth: L0=one-sentence, L1=planning detail, L2=full (default)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "zc_replay",
    description:
      "Replay broadcast history from a given time. Returns all broadcasts from that point, oldest first. " +
      "Use for session post-mortems and context reconstruction.",
    inputSchema: {
      type: "object",
      properties: {
        from:  { type: "string", description: "ISO timestamp to replay from (optional — all if omitted)" },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Max broadcasts to return (default: 100)" },
      },
      required: [],
    },
  },
  {
    name: "zc_ack",
    description:
      "Acknowledge receipt of a broadcast. Marks the broadcast as delivered in the audit log. " +
      "Call after you have read and acted on an ASSIGN broadcast.",
    inputSchema: {
      type: "object",
      properties: {
        broadcast_id:  { type: "integer", description: "Broadcast ID to acknowledge" },
        agent_id:      { type: "string", description: "Acknowledging agent ID" },
        session_token: { type: "string", description: "Session token (optional)" },
      },
      required: ["broadcast_id", "agent_id"],
    },
  },

  // ── v0.10.0 Harness Engineering ─────────────────────────────────────────────
  {
    name: "zc_index_project",
    description:
      "Walk the current project and index every source file into the KB with an L0 (first 100-char purpose) + L1 (first 1500-char detail) summary. " +
      "Run once per project after initial clone — afterward, agents call zc_file_summary(path) for 'check/review' questions instead of Read. " +
      "Idempotent: re-running refreshes summaries for changed files. " +
      "Excludes node_modules, dist, build, .git, coverage, .worktrees by default. " +
      "This is the foundation of the v0.10.0 harness — Tier 1 (KB) becomes the default, Tier 2 (Read) the exception.",
    inputSchema: {
      type: "object",
      properties: {
        excludes:   { type: "array", items: { type: "string" }, description: "Path prefixes to skip (overrides default)" },
        extensions: { type: "array", items: { type: "string" }, description: "File extensions to index (e.g. '.ts', '.py')" },
        max_bytes:  { type: "integer", minimum: 1024, description: "Max file size to read in bytes (default 262144)" },
      },
      required: [],
    },
  },
  {
    name: "zc_file_summary",
    description:
      "Return the L0 (one-line purpose) + L1 (1500-char detail) summary for a single file — no Read required. " +
      "The primary Tier-1 verb for check/review questions. ~400 tokens vs ~4000 for a full Read. " +
      "Returns stale=true if the file on disk is newer than the indexed version (run zc_index_project to refresh, or the PostEdit hook will do it automatically).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to project root (or absolute)" },
      },
      required: ["path"],
    },
  },
  {
    name: "zc_project_card",
    description:
      "Return (or update) the per-project orientation card: stack + layout + state + gotchas + hot_files. " +
      "Call once per session after zc_recall_context to replace the Read-CLAUDE.md / ls / Glob ritual. ~500 tokens vs ~8k. " +
      "Pass any of stack/layout/state/gotchas/hot_files to UPDATE the card; omit them to READ it.",
    inputSchema: {
      type: "object",
      properties: {
        stack:     { type: "string", description: "e.g. 'Node 22 + TypeScript + SQLite + MCP'" },
        layout:    { type: "string", description: "Top-level dirs with one-line purpose each" },
        state:     { type: "string", description: "Current work state / sprint / pending" },
        gotchas:   { type: "string", description: "Known pitfalls and constraints" },
        hot_files: { type: "array", items: { type: "string" }, description: "Top-N frequently-edited paths" },
      },
      required: [],
    },
  },
  {
    name: "zc_check",
    description:
      "Memory-first answer wrapper: searches the KB for the question and returns top hits with a confidence score. " +
      "Use this BEFORE reaching for Read/Grep — if the KB answer is high-confidence, skip the file read entirely. " +
      "Confidence levels: high (use this), medium (corroborate), low (might miss details), none (Read required).",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Natural-language question" },
        path:     { type: "string", description: "Optional: scope search to one source file" },
      },
      required: ["question"],
    },
  },
  {
    name: "zc_capture_output",
    description:
      "Store a long bash/tool output in the KB and return a compact summary (head + tail + omission marker). " +
      "Called by the PostToolUse bash hook automatically; callable directly when an agent knows it ran a noisy command. " +
      "Full output becomes FTS-searchable via source='tool_output/<hash>'. Dedup by sha256(cmd+stdout).",
    inputSchema: {
      type: "object",
      properties: {
        command:   { type: "string", description: "The command that was run" },
        stdout:    { type: "string", description: "Full output" },
        exit_code: { type: "integer", description: "Process exit code" },
      },
      required: ["command", "stdout", "exit_code"],
    },
  },
  {
    name: "zc_logs",
    description:
      "Query structured telemetry logs from the harness (Sprint 1 v0.11.0). " +
      "Components: telemetry, outcomes, learnings-mirror, skills, mutations, budget, compaction, " +
      "tasks, ownership, routing, retrieval. Returns newest-first. When ZC_AGENT_ID env is set, " +
      "results are agent-scoped (only entries matching this agent_id or system entries). " +
      "Use this to diagnose cost spikes, trace outcome resolution, or correlate events across " +
      "components via trace_id. Logs are ON THE LOCAL DISK — this tool is local-only.",
    inputSchema: {
      type: "object",
      properties: {
        component:     { type: "string", description: "One of: telemetry, outcomes, learnings-mirror, skills, mutations, budget, compaction, tasks, ownership, routing, retrieval" },
        since_date:    { type: "string", description: "Inclusive ISO date YYYY-MM-DD (default: today)" },
        until_date:    { type: "string", description: "Inclusive ISO date YYYY-MM-DD (default: today)" },
        min_level:     { type: "string", enum: ["DEBUG", "INFO", "WARN", "ERROR"], description: "Minimum severity (default: INFO)" },
        event_contains: { type: "string", description: "Substring to match (case-insensitive) against event name" },
        trace_id:      { type: "string", description: "Exact trace_id match (for cross-log correlation)" },
        agent_id:      { type: "string", description: "Filter by agent_id (falls back to ZC_AGENT_ID env)" },
        limit:         { type: "integer", minimum: 1, maximum: 5000, description: "Max rows (default: 200)" },
      },
      required: ["component"],
    },
  },

  // ── v0.13.0 graphify integration ──────────────────────────────────────
  {
    name: "zc_graph_query",
    description:
      "Query the project's structural knowledge graph (built by graphify). " +
      "Use for ARCHITECTURAL questions like 'how does auth work' or 'what depends on the user model'. " +
      "Returns graph nodes + relationships + confidence tags. " +
      "Requires `graphify-out/graph.json` in the project (run `/graphify .` first to build it). " +
      "Pairs with zc_search for precise content retrieval — graph orient first, then targeted reads.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language graph query (e.g. 'how does auth flow connect to the database')" },
      },
      required: ["query"],
    },
  },
  {
    name: "zc_graph_path",
    description:
      "Find the shortest path between two named nodes in the structural graph. " +
      "Use for 'how does X connect to Y' questions. Returns the chain of nodes + edges. " +
      "Requires graphify-out/graph.json (see zc_graph_query for setup).",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source node name" },
        to:   { type: "string", description: "Target node name" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "zc_graph_neighbors",
    description:
      "Get the immediate neighbors of a named node in the structural graph. " +
      "Use for 'what's related to X' questions. Returns directly-connected nodes + their edge types. " +
      "Requires graphify-out/graph.json.",
    inputSchema: {
      type: "object",
      properties: {
        node: { type: "string", description: "Node name to inspect" },
      },
      required: ["node"],
    },
  },

  // ── v0.14.0 community detection (Louvain over SC's KB) ────────────────
  {
    name: "zc_kb_cluster",
    description:
      "Run Louvain community detection over the project's knowledge base. " +
      "Identifies clusters of related sources by graph topology (no embeddings). " +
      "For 'what's the architecture of this project' questions, this surfaces higher-order " +
      "structure (e.g. 'auth cluster', 'data layer cluster') that pure top-k similarity misses. " +
      "Persists results to kb_communities table for fast subsequent lookups via zc_kb_community_for.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "zc_kb_community_for",
    description:
      "Look up the community of a single KB source plus its community-mates. " +
      "Use for 'what's related to X' questions where X is a known KB source path. " +
      "Run zc_kb_cluster first to populate community assignments.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "KB source identifier (e.g. 'file:src/auth.ts')" },
      },
      required: ["source"],
    },
  },
  {
    name: "zc_choose_model",
    description:
      "v0.17.0 §8.5 — Recommend a Claude model tier for a task given its complexity_estimate (1-5). " +
      "Maps 1-2→Haiku (cheap/trivial), 3-4→Sonnet (standard), 5→Opus (hard reasoning). " +
      "Returns model id, tier, rationale, per-Mtok input cost, and whether the input was clamped. " +
      "Use before dispatching a task to a worker pool to route by cost-efficiency. " +
      "Operators can override via ZC_MODEL_TIER_{HAIKU,SONNET,OPUS} env vars.",
    inputSchema: {
      type: "object",
      properties: {
        complexity: {
          type: "number",
          description: "Task complexity 1-5 (from v0.15.0 §8.1 structured ASSIGN). " +
            "Values outside 1-5, NaN, or missing → defaults to Sonnet with inputClamped=true.",
        },
      },
      required: [],
    },
  },
  {
    name: "zc_enqueue_task",
    description:
      "v0.17.0 §8.2 — Enqueue a task into the work-stealing queue (task_queue_pg). " +
      "Requires Postgres backend (falls back to error if ZC_TELEMETRY_BACKEND is sqlite). " +
      "Idempotent: returns {inserted:false} if task_id already exists. " +
      "Used by orchestrator to create tasks that any worker in a role can claim.",
    inputSchema: {
      type: "object",
      properties: {
        task_id:  { type: "string", description: "Unique task identifier (typically the ASSIGN broadcast task field)." },
        role:     { type: "string", description: "Role name — workers with matching role can claim (e.g. 'developer')." },
        payload:  { type: "object", description: "Task payload (full ASSIGN body as JSON). Workers receive this on claim." },
      },
      required: ["task_id", "role", "payload"],
    },
  },
  {
    name: "zc_claim_task",
    description:
      "v0.17.0 §8.2 — Atomically claim the oldest queued task for the given role. " +
      "Uses Postgres FOR UPDATE SKIP LOCKED so multiple workers can call concurrently " +
      "without blocking. Returns null if queue is empty. Once claimed, worker MUST call " +
      "zc_heartbeat_task every 30s or zc_complete_task/zc_fail_task on completion.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "Role to claim tasks for (worker's own role)." },
      },
      required: ["role"],
    },
  },
  {
    name: "zc_heartbeat_task",
    description:
      "v0.17.0 §8.2 — Refresh heartbeat on a claimed task. Workers MUST call every 30s " +
      "while processing — otherwise reclaimStaleTasks (5min threshold) will return the " +
      "task to queue. Returns {ok:false} if the worker no longer owns the task (reclaimed).",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to refresh." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "zc_complete_task",
    description:
      "v0.17.0 §8.2 — Mark a claimed task as done. Idempotent: returns {ok:false} if " +
      "the task was already completed or no longer owned by this worker.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to mark done." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "zc_fail_task",
    description:
      "v0.17.0 §8.2 — Mark a claimed task as failed + bump retries counter so a backoff " +
      "layer can decide whether to re-enqueue. Records failure_reason (truncated to 1000 chars).",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to mark failed." },
        reason:  { type: "string", description: "Short description of failure cause." },
      },
      required: ["task_id", "reason"],
    },
  },
  {
    name: "zc_queue_stats",
    description:
      "v0.17.0 §8.2 — Return queue counts by state {queued, claimed, done, failed}. " +
      "Orchestrator uses this for flow control: back off spawning new tasks if queued>N.",
    inputSchema: {
      type: "object",
      properties: {},
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

// ─────────────────────────────────────────────────────────────────────────────
// Remote tool handler — routes tool calls to the SecureContext API server
// when ZC_API_URL is set. Maps each tool name to its REST endpoint.
// ─────────────────────────────────────────────────────────────────────────────
async function _handleRemoteTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    // All remote calls inject PROJECT_PATH as projectPath so agents don't need to supply it
    const body: Record<string, unknown> = { projectPath: PROJECT_PATH, ...args };

    let result: Record<string, unknown>;

    switch (toolName) {
      case "zc_remember":
        result = await apiCall("POST", "/api/v1/remember", {
          projectPath: PROJECT_PATH,
          key:         body["key"],
          value:       body["value"],
          importance:  body["importance"] ?? 3,
          agentId:     body["agent_id"] ?? "default",
        });
        return { content: [{ type: "text", text: `Remembered. Working memory: ${result["count"]}/${result["max"]} facts` }] };

      case "zc_forget":
        result = await apiCall("POST", "/api/v1/forget", {
          projectPath: PROJECT_PATH,
          key:         body["key"],
          agentId:     body["agent_id"] ?? "default",
        });
        return { content: [{ type: "text", text: (result["deleted"] ? `Forgotten: '${body["key"]}' removed.` : `Key '${body["key"]}' was not in working memory.`) }] };

      case "zc_recall_context": {
        const recallRes = await apiCall("GET", `/api/v1/recall?projectPath=${encodeURIComponent(PROJECT_PATH)}&agentId=${encodeURIComponent(String(body["agent_id"] ?? "default"))}`);
        const facts     = recallRes["facts"] as Array<{ key: string; value: string; importance: number }> ?? [];
        const max       = recallRes["max"] as number ?? 50;
        const lines     = [`## Working Memory (${facts.length}/${max} facts)`];
        for (const f of facts.filter(f => f.importance >= 4)) lines.push(`  [★${f.importance}] ${f.key}: ${f.value}`);
        for (const f of facts.filter(f => f.importance === 3))  lines.push(`  [★${f.importance}] ${f.key}: ${f.value}`);
        for (const f of facts.filter(f => f.importance <= 2))  lines.push(`  [★${f.importance}] ${f.key}: ${f.value}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "zc_summarize_session":
        await apiCall("POST", "/api/v1/summarize", { projectPath: PROJECT_PATH, summary: body["summary"] });
        return { content: [{ type: "text", text: `Session summary archived.` }] };

      case "zc_index":
        await apiCall("POST", "/api/v1/index", {
          projectPath: PROJECT_PATH,
          content:     body["content"],
          source:      body["source"],
          sourceType:  body["source_type"] ?? "internal",
        });
        return { content: [{ type: "text", text: `Indexed "${body["source"]}" (${String(body["content"] ?? "").length} chars).` }] };

      case "zc_search": {
        const sr = await apiCall("POST", "/api/v1/search", { projectPath: PROJECT_PATH, queries: body["queries"] });
        const results = sr["results"] as Array<{ source: string; snippet: string }> ?? [];
        if (results.length === 0) return { content: [{ type: "text", text: "No results found." }] };
        const lines = results.map((r, i) => `${i + 1}. [${r.source}]\n   ${r.snippet}`);
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      }

      case "zc_search_global": {
        const gsr = await apiCall("POST", "/api/v1/search-global", { queries: body["queries"] });
        const results = gsr["results"] as Array<{ source: string; snippet: string; projectLabel: string }> ?? [];
        if (results.length === 0) return { content: [{ type: "text", text: "No global results found." }] };
        const lines = results.map((r, i) => `${i + 1}. [${r.projectLabel}] ${r.source}\n   ${r.snippet}`);
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      }

      case "zc_status": {
        const st = await apiCall("GET", `/api/v1/status?projectPath=${encodeURIComponent(PROJECT_PATH)}&agentId=${encodeURIComponent(String(body["agent_id"] ?? "default"))}`);
        const wm = st["workingMemory"] as Record<string, unknown>;
        const kb = st["knowledgeBase"] as Record<string, unknown>;
        const ch = st["chain"]         as Record<string, unknown>;
        return { content: [{ type: "text", text:
          `## SecureContext Status (remote — ${ZC_API_URL})\n` +
          `Working Memory: ${wm?.["count"]}/${wm?.["max"]} facts\n` +
          `KB entries: ${kb?.["totalEntries"]}  |  Embeddings: ${kb?.["embeddingsCached"]}\n` +
          `Chain: ${ch?.["ok"] ? `OK (${ch?.["totalRows"]} rows)` : `BROKEN at #${ch?.["brokenAt"]}`}\n` +
          `Active sessions: ${st["sessions"]}`
        }] };
      }

      case "zc_broadcast":
        result = await apiCall("POST", "/api/v1/broadcast", {
          projectPath:   PROJECT_PATH,
          type:          body["type"],
          agentId:       body["agent_id"],
          task:          body["task"],
          summary:       body["summary"],
          state:         body["state"],
          reason:        body["reason"],
          importance:    body["importance"],
          files:         body["files"],
          depends_on:    body["depends_on"],
          channel_key:   body["channel_key"],
          session_token: body["session_token"],
        });
        return { content: [{ type: "text", text: `Broadcast #${(result["message"] as Record<string, unknown>)?.["id"]} posted.` }] };

      case "zc_replay":
        result = await apiCall("POST", "/api/v1/replay", { projectPath: PROJECT_PATH, fromId: body["from_id"] });
        return { content: [{ type: "text", text: `Replay: ${(result["broadcasts"] as unknown[])?.length ?? 0} broadcasts returned.` }] };

      case "zc_ack":
        await apiCall("POST", "/api/v1/ack", { projectPath: PROJECT_PATH, id: body["id"] });
        return { content: [{ type: "text", text: `Broadcast #${body["id"]} acknowledged.` }] };

      case "zc_explain": {
        const er = await apiCall("GET", `/api/v1/explain?projectPath=${encodeURIComponent(PROJECT_PATH)}&query=${encodeURIComponent(String(body["query"] ?? ""))}&depth=${body["depth"] ?? "L1"}`);
        const entries = er["results"] as Array<{ source: string; hybridScore: number; snippet: string }> ?? [];
        const lines   = entries.map((e, i) => `${i+1}. [${e.source}] score=${e.hybridScore.toFixed(3)}\n   ${e.snippet}`);
        return { content: [{ type: "text", text: `## Retrieval explanation\n${lines.join("\n\n")}` }] };
      }

      case "zc_issue_token":
        result = await apiCall("POST", "/api/v1/issue-token", { projectPath: PROJECT_PATH, agentId: body["agent_id"], role: body["role"] });
        return { content: [{ type: "text", text: `Token: ${result["token"]}` }] };

      case "zc_revoke_token":
        await apiCall("POST", "/api/v1/revoke-token", { projectPath: PROJECT_PATH, agentId: body["agent_id"] });
        return { content: [{ type: "text", text: `Tokens revoked for agent '${body["agent_id"]}'.` }] };

      default:
        return { content: [{ type: "text", text: `Unknown remote tool: ${toolName}` }] };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `Remote API error: ${msg}` }] };
  }
}

/**
 * Inner tool dispatcher. Implements all tool logic. Wrapped by the outer
 * setRequestHandler below which adds Sprint 1 telemetry capture + cost
 * header injection.
 */
async function dispatchToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {

  // ── HTTP client mode ───────────────────────────────────────────────────────
  // When ZC_API_URL is configured, proxy storage-touching tools to the API
  // server. Sandbox/fetch/execute tools run locally (they don't need DB access).
  // ─────────────────────────────────────────────────────────────────────────────
  const REMOTE_TOOLS = new Set([
    "zc_remember", "zc_forget", "zc_recall_context", "zc_summarize_session",
    "zc_index", "zc_search", "zc_search_global", "zc_status",
    "zc_broadcast", "zc_replay", "zc_ack", "zc_explain",
    "zc_issue_token", "zc_revoke_token",
  ]);

  if (ZC_API_URL && REMOTE_TOOLS.has(name)) {
    return _handleRemoteTool(name, (args ?? {}) as Record<string, unknown>);
  }

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

        // SECURITY: Warn agent if injection patterns were redacted from content
        const injectionWarning = fetched.injectionPatternsFound > 0
          ? `\n⚠️  INJECTION PATTERNS DETECTED AND REDACTED: ` +
            `${fetched.injectionPatternsFound} match(es) found. ` +
            `Types: ${fetched.injectionTypes.join(", ")}. ` +
            `Matched spans replaced with ⚠️[INJECTION PATTERN REDACTED] markers. ` +
            `Treat all content from this URL as potentially adversarial.\n`
          : "";

        return {
          content: [{
            type: "text",
            text:
              `## Fetched: ${fetched.title}\n` +
              `Source: ${fetched.url}\n` +
              `Size: ${(fetched.byteSize / 1024).toFixed(1)} KB | ` +
              `Fetches remaining today: ${remaining}\n` +
              `Indexed as: "${label}"` +
              injectionWarning + `\n\n` +
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
        const allBm25Only = results.every(r => r.vectorScore === undefined);
        const ollamaBanner = allBm25Only
          ? `⚠️  Ollama unavailable — results ranked by BM25 keyword score only (no semantic reranking).\n` +
            `    Run 'ollama serve' locally or start the Docker stack for better search quality.\n\n`
          : "";
        const formatted = results.map((r, i) => {
          const vecInfo     = r.vectorScore !== undefined ? ` | cosine: ${r.vectorScore.toFixed(3)}` : " | BM25 only";
          const trustBadge  = r.sourceType === "external" ? " [EXTERNAL]" : "";
          const asciiBadge  = r.nonAsciiSource ? " [⚠️ NON-ASCII SOURCE]" : "";
          return `### Result ${i + 1}: ${r.source}${trustBadge}${asciiBadge}\nScore: ${r.rank.toFixed(4)}${vecInfo}\n\n${r.snippet}`;
        }).join("\n\n---\n\n");
        return { content: [{ type: "text", text: ollamaBanner + formatted }] };
      }

      case "zc_search_global": {
        const { queries, max_projects } = args as { queries: string[]; max_projects?: number };
        const results = await searchAllProjects(queries, max_projects ?? 5);
        if (results.length === 0) {
          return { content: [{ type: "text", text: "No results found across any projects." }] };
        }
        const allBm25Only = results.every(r => r.vectorScore === undefined);
        const ollamaBanner = allBm25Only
          ? `⚠️  Ollama unavailable — results ranked by BM25 keyword score only (no semantic reranking).\n` +
            `    Run 'ollama serve' locally or start the Docker stack for better search quality.\n\n`
          : "";
        const formatted = results.map((r, i) => {
          const vecInfo    = r.vectorScore !== undefined ? ` | cosine: ${r.vectorScore.toFixed(3)}` : " | BM25 only";
          const trustBadge = r.sourceType === "external" ? " [EXTERNAL]" : "";
          const asciiBadge = r.nonAsciiSource ? " [⚠️ NON-ASCII SOURCE]" : "";
          return (
            `### Result ${i + 1}: ${r.source}${trustBadge}${asciiBadge}\n` +
            `Project: **${r.projectLabel}** (${r.projectHash})\n` +
            `Score: ${r.rank.toFixed(4)}${vecInfo}\n\n` +
            r.snippet
          );
        }).join("\n\n---\n\n");
        return { content: [{ type: "text", text: ollamaBanner + formatted }] };
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
          const allBm25Only = searchResults.every(r => r.vectorScore === undefined);
          const bm25Header = allBm25Only
            ? `⚠️  Ollama unavailable — KB results ranked by BM25 only (no semantic reranking).\n` +
              `    Run 'ollama serve' or start the Docker stack for better search quality.\n`
            : "";
          sections.push(`## Knowledge Base Results\n${bm25Header}`);
          for (const r of searchResults) {
            const vecInfo    = r.vectorScore !== undefined ? ` (cosine: ${r.vectorScore.toFixed(3)})` : " (BM25 only)";
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
        const { agent_id, force } = args as { agent_id?: string; force?: boolean };

        // v0.17.1 — open DB once, use it for BOTH the cache freshness check AND
        // the full recompute path below. This avoids opening the SQLite file twice.
        const { DatabaseSync: RcDs } = await import("node:sqlite");
        const { mkdirSync: rcMkd }   = await import("node:fs");
        const { join: rcJoin }       = await import("node:path");
        const { createHash: rcCh }   = await import("node:crypto");
        rcMkd(Config.DB_DIR, { recursive: true });
        const rcDbFile = rcJoin(Config.DB_DIR, `${rcCh("sha256").update(PROJECT_PATH).digest("hex").slice(0,16)}.db`);
        const rcDb     = new RcDs(rcDbFile);
        rcDb.exec("PRAGMA journal_mode = WAL");
        rcDb.exec("PRAGMA busy_timeout = 5000");

        // v0.17.1 — fast-path: if we have a fresh cached response for this
        // (project, agent) and nothing has changed in working_memory /
        // broadcasts / session_events, return the cached text with a small
        // "(cached Ns ago)" prefix. Skips ~800 output tokens on Opus (~$0.06).
        // Bypass via force=true.
        if (!force) {
          const { tryGetCachedRecall, decorateCachedResponse } = await import("./recall_cache.js");
          const cached = tryGetCachedRecall(PROJECT_PATH, agent_id, rcDb);
          if (cached.hit && cached.response !== undefined && cached.ageMs !== undefined) {
            rcDb.close();
            return { content: [{ type: "text", text: decorateCachedResponse(cached.response, cached.ageMs) }] };
          }
        }

        const wm         = recallWorkingMemory(PROJECT_PATH, agent_id);
        const events     = getRecentEvents(PROJECT_PATH, 20);
        const broadcasts = recallSharedChannel(PROJECT_PATH, { limit: 30 });

        // Force-recompute complexity on every session start so the working memory
        // limit immediately reflects any new agents, KB growth, or broadcast history.
        const complexity = computeProjectComplexity(rcDb);

        const parts: string[] = [];

        // Section 0 (v0.10.0): Health banner — visible at the TOP of every
        // session so degradation is impossible to miss. Empty in full mode.
        const rcHealth = await getSystemHealth(PROJECT_PATH);
        const rcBanner = formatHealthBanner(rcHealth);
        if (rcBanner) parts.push(rcBanner);

        // Section 1: Working Memory (structured by priority — limit is project-aware)
        parts.push(formatWorkingMemoryForContext(wm, agent_id, complexity.computedLimit));

        // Section 2: Shared Broadcast Channel (A2A coordination)
        parts.push("\n" + formatSharedChannelForContext(broadcasts));

        // Section 3: Recent Session Events
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

        // Section 4: System Status (inline — no tool call needed)
        parts.push("\n## System Status");
        parts.push(`  Plugin: zc-ctx v${Config.VERSION}`);

        // Ollama availability — checked once per session (TTL-cached), surfaces clearly here
        const ollamaStatus = await checkOllamaAvailable();
        if (ollamaStatus.available) {
          parts.push(`  Embedding (Ollama): ✓ available  [${ACTIVE_MODEL} @ ${ollamaStatus.url.replace("/api/embeddings", "")}]`);
        } else {
          parts.push(`  ⚠️  Embedding (Ollama): NOT AVAILABLE — search is running in BM25-only mode`);
          parts.push(`      Semantic similarity reranking is disabled. Results are keyword-only.`);
          parts.push(`      Fix (local):  ollama serve  (then: ollama pull ${ACTIVE_MODEL})`);
          parts.push(`      Fix (Docker): .\\docker\\start.ps1  (Windows) or ./docker/start.sh`);
        }

        const channelKeySet = isChannelKeyConfigured(PROJECT_PATH);
        parts.push(`  Broadcast channel: ${channelKeySet ? "key-protected" : "open"}`);
        if (!integrity.ok) {
          parts.push(`  ⚠️  Integrity: ${integrity.warnings.join("; ")}`);
        } else {
          parts.push(`  Integrity: OK`);
        }

        // v0.17.1 — cache the full response for future calls within 60s.
        // Done BEFORE rcDb.close() so the change-detection max-id queries
        // can piggyback on the already-open connection.
        const _recallText = parts.join("\n");
        try {
          const { putCachedRecall } = await import("./recall_cache.js");
          putCachedRecall(PROJECT_PATH, agent_id, _recallText, rcDb);
        } catch { /* caching is best-effort; never fail the recall */ }
        rcDb.close();
        return { content: [{ type: "text", text: _recallText }] };
      }

      case "zc_broadcast": {
        const {
          type, agent_id, task, files, state, summary,
          depends_on, reason, importance, channel_key, session_token,
        } = args as {
          type:           string;
          agent_id:       string;
          task?:          string;
          files?:         string[];
          state?:         string;
          summary?:       string;
          depends_on?:    string[];
          reason?:        string;
          importance?:    number;
          channel_key?:   string;
          session_token?: string;
        };

        // Special action: configure the channel key
        if (type === "set_key") {
          if (!channel_key || channel_key.trim().length < 8) {
            return {
              content: [{ type: "text", text: "Error: channel_key must be at least 8 characters for set_key action." }],
              isError: true,
            };
          }
          setChannelKey(PROJECT_PATH, channel_key);
          return {
            content: [{
              type: "text",
              text:
                `Channel key configured.\n` +
                `All future broadcasts to this project require the correct key.\n` +
                `Workers must supply channel_key= to use zc_broadcast.`,
            }],
          };
        }

        // Validate broadcast type
        const VALID_TYPES: BroadcastType[] = [
          "ASSIGN", "STATUS", "PROPOSED", "DEPENDENCY", "MERGE", "REJECT", "REVISE",
          "LAUNCH_ROLE", "RETIRE_ROLE",
        ];
        if (!VALID_TYPES.includes(type as BroadcastType)) {
          return {
            content: [{ type: "text", text: `Error: unknown type "${type}". Valid: ${VALID_TYPES.join(", ")}, set_key` }],
            isError: true,
          };
        }

        const msg = broadcastFact(
          PROJECT_PATH,
          type as BroadcastType,
          agent_id,
          { task, files, state, summary, depends_on, reason, importance, channel_key, session_token }
        );

        const fileStr  = msg.files.length   > 0 ? `\nFiles:      ${msg.files.join(", ")}` : "";
        const depStr   = msg.depends_on.length > 0 ? `\nDepends on: ${msg.depends_on.join(", ")}` : "";
        const reasonStr = msg.reason ? `\nReason:     ${msg.reason}` : "";

        return {
          content: [{
            type: "text",
            text:
              `Broadcast #${msg.id} posted to shared channel.\n` +
              `Type:       ${msg.type}\n` +
              `Agent:      ${msg.agent_id}` +
              (msg.task ? `\nTask:       ${msg.task}` : "") +
              fileStr + depStr + reasonStr +
              (msg.summary ? `\nSummary:    ${msg.summary}` : "") +
              `\nImportance: ★${msg.importance}` +
              `\nAt:         ${msg.created_at.slice(0, 19)}Z`,
          }],
        };
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

        // RBAC status
        const { DatabaseSync: DS2 } = await import("node:sqlite");
        const { mkdirSync: mkd2 } = await import("node:fs");
        const { join: pjoin2 } = await import("node:path");
        const { createHash: ch2 } = await import("node:crypto");
        mkd2(Config.DB_DIR, { recursive: true });
        const dbFile2  = pjoin2(Config.DB_DIR, `${ch2("sha256").update(PROJECT_PATH).digest("hex").slice(0,16)}.db`);
        const rbacDb   = new DS2(dbFile2);
        rbacDb.exec("PRAGMA journal_mode = WAL");
        rbacDb.exec("PRAGMA busy_timeout = 5000");
        const activeSessions = countActiveSessions(rbacDb);
        const chainStatus    = getBroadcastChainStatus(PROJECT_PATH);
        rbacDb.close();

        // Build complexity label for working memory display
        const cx = wmStats.complexity;
        const complexityLabel = cx
          ? (() => {
              const kb    = Math.min(Math.floor(cx.kbEntries     / 15), 60);
              const bc    = Math.min(Math.floor(cx.broadcastCount / 30), 40);
              const ag    = Math.min(cx.activeAgents * 15,               50);
              const cacheAgeMin = Math.round((Date.now() - new Date(cx.computedAt).getTime()) / 60000);
              return (
                `  Limit (dynamic):  ${wmStats.max} facts  (evict-to: ${wmStats.evictTo})\n` +
                `  Complexity score: KB +${kb}  |  Broadcasts +${bc}  |  Agents +${ag}\n` +
                `  Signals:          ${cx.kbEntries} KB entries · ${cx.broadcastCount} broadcasts · ${cx.activeAgents} active agent(s)\n` +
                `  Cache age:        ${cacheAgeMin < 1 ? "just computed" : `${cacheAgeMin}m ago`} (auto-refreshes every 10m)`
              );
            })()
          : `  Limit:  ${wmStats.max} facts`;

        // System health banner (v0.10.0) — warn the agent if any dep is degraded
        const health = await getSystemHealth(PROJECT_PATH);
        const healthBanner = formatHealthBanner(health);

        const lines = [
          ...(healthBanner ? [healthBanner] : []),
          `## SecureContext Status — v${Config.VERSION}`,
          ``,
          `**System Health:** ${health.mode === "full" ? "✓ full mode" : `⚠️ degraded (${health.warnings.length} issue${health.warnings.length === 1 ? "" : "s"})`}`,
          `  Ollama:            ${health.ollamaReachable ? "✓ reachable" : "⚠️ unreachable"}`,
          `  Embedding model:   ${health.embeddingReady ? `✓ ${ACTIVE_MODEL} ready` : `⚠️ missing`}`,
          `  Summarizer model:  ${health.summarizerReady ? `✓ ${health.summarizerModel} ready` : "⚠️ no coder model (truncation fallback)"}`,
          ...(health.httpApiReachable !== null
            ? [`  HTTP API:          ${health.httpApiReachable ? `✓ ${health.httpApiUrl}` : `⚠️ ${health.httpApiUrl} unreachable`}`]
            : [`  Storage mode:      local SQLite (ZC_API_URL not set)`]),
          ``,
          `**Knowledge Base**`,
          `  Total entries:    ${kbStats.totalEntries}`,
          `  External entries: ${kbStats.externalEntries} (web-fetched, expire in ${Config.STALE_DAYS_EXTERNAL}d)`,
          `  Session summaries: ${kbStats.summaryEntries} (expire in ${Config.STALE_DAYS_SUMMARY}d)`,
          `  Embeddings cached: ${kbStats.embeddingsCached}`,
          `  DB size:           ${(kbStats.dbSizeBytes / 1024).toFixed(1)} KB`,
          ``,
          `**Working Memory** (agent: ${agent_id ?? "default"})`,
          `  Facts: ${wmStats.count}/${wmStats.max}  (★4-5 critical: ${wmStats.criticalCount})`,
          complexityLabel,
          ``,
          `**Schema**`,
          `  Migration version: ${schemaV}`,
          ``,
          `**Search / Embeddings**`,
          `  Embedding model:   ${ACTIVE_MODEL}`,
          `  Ollama status:     ${await checkOllamaAvailable().then(s => s.available
            ? `✓ available  (${s.url.replace("/api/embeddings", "")})`
            : `⚠️  NOT AVAILABLE — running BM25-only\n` +
              `                    Fix: ollama serve  (then: ollama pull ${ACTIVE_MODEL})\n` +
              `                    Or start the Docker stack: .\\docker\\start.ps1`
          )}`,
          `  Embeddings cached: ${kbStats.embeddingsCached}`,
          ``,
          `**Fetch Budget (today)**`,
          `  Used:      ${fetchUsed}/${Config.FETCH_LIMIT}`,
          `  Remaining: ${fetchRemaining}`,
          `  Resets at: UTC midnight`,
          ``,
          `**RBAC & Security**`,
          `  Sessions active:   ${activeSessions > 0 ? "YES" : "NO"} (${activeSessions} session${activeSessions === 1 ? "" : "s"})`,
          `  RBAC enforcement:  ${Config.RBAC_ENFORCE ? "ACTIVE (v0.9.0 default)" : "DISABLED (ZC_RBAC_ENFORCE=0 — legacy mode)"}`,
          `  Channel key:       ${Config.CHANNEL_KEY_REQUIRED ? "REQUIRED (v0.9.0 default)" : "optional (ZC_CHANNEL_KEY_REQUIRED=0 — legacy mode)"}`,
          `  Hash chain:        ${chainStatus.ok ? `OK (${chainStatus.totalRows} rows)` : `BROKEN at row #${chainStatus.brokenAt}`}`,
          `  Chain enabled:     ${Config.CHAIN_ENABLED ? "YES" : "NO (ZC_CHAIN_DISABLED=1)"}`,
          ``,
          `**Integrity**`,
          integrity.ok
            ? `  Status: OK`
            : `  Status: ⚠️  WARNINGS\n  ${integrity.warnings.join("\n  ")}`,
          integrity.strictMode ? `  Mode: STRICT (ZC_STRICT_INTEGRITY=1)` : `  Mode: warn-only`,
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "zc_issue_token": {
        const { agent_id: issueAgentId, role, channel_key: issueChannelKey } = args as {
          agent_id:     string;
          role:         AgentRole;
          channel_key?: string;
        };

        // Import memory helpers to open the correct DB and verify channel key
        const { openDb: openMemDb } = await import("./knowledge.js");
        const issueDb = openMemDb(PROJECT_PATH);

        // Verify channel key if configured (same reference monitor)
        if (isChannelKeyConfigured(PROJECT_PATH)) {
          // Re-use broadcastFact channel key check by reading from DB
          const keyRow = issueDb.prepare(
            "SELECT value FROM project_meta WHERE key = 'zc_channel_key_hash'"
          ).get() as { value: string } | undefined;
          if (keyRow && keyRow.value.length > 0 && !issueChannelKey) {
            issueDb.close();
            return {
              content: [{ type: "text", text: "Error: channel_key required for zc_issue_token when channel is key-protected." }],
              isError: true,
            };
          }
        }

        const token = issueToken(issueDb, PROJECT_PATH, issueAgentId, role);
        issueDb.close();

        return {
          content: [{
            type: "text",
            text:
              `Token issued for agent '${issueAgentId}' (role: ${role}).\n` +
              `Token: ${token}\n\n` +
              `Inject this token into the agent's --append-system-prompt before launch.\n` +
              `Pass it as session_token= in all zc_broadcast calls.\n` +
              `Expires: ${new Date(Date.now() + Config.SESSION_TOKEN_TTL_SECONDS * 1000).toISOString()}`,
          }],
        };
      }

      case "zc_revoke_token": {
        const { agent_id: revokeAgentId } = args as { agent_id: string; channel_key?: string };
        const { openDb: openRevDb } = await import("./knowledge.js");
        const revokeDb = openRevDb(PROJECT_PATH);
        revokeAllAgentTokens(revokeDb, revokeAgentId);
        revokeDb.close();
        return {
          content: [{
            type: "text",
            text: `All tokens revoked for agent '${revokeAgentId}'. Agent must re-issue a token before broadcasting.`,
          }],
        };
      }

      case "zc_explain": {
        const { query, depth } = args as { query: string; depth?: "L0" | "L1" | "L2" };
        const explanation = await explainRetrieval(PROJECT_PATH, query, depth ?? "L2");

        if (explanation.results.length === 0) {
          return { content: [{ type: "text", text: `No results found for query: "${query}"` }] };
        }

        const header = [
          `## Retrieval Explanation`,
          `Query: "${explanation.query}"`,
          `Depth: ${explanation.depth} | BM25-only: ${explanation.bm25Only ? "YES (Ollama unavailable)" : "NO (hybrid)"}`,
          `Results: ${explanation.results.length}`,
          ``,
        ];

        const rows = explanation.results.map((r, i) => {
          const vecStr = r.vectorScore !== null ? r.vectorScore.toFixed(4) : "N/A";
          const contentPreview = r.tieredContent.slice(0, 200).replace(/\n/g, " ");
          return [
            `### #${i + 1}: ${r.source} [${r.sourceType}]`,
            `  BM25 raw: ${r.bm25Score.toFixed(4)} | BM25 norm: ${r.bm25Normalized.toFixed(4)} | Vector: ${vecStr} | Hybrid: ${r.hybridScore.toFixed(4)}`,
            `  Content length: ${r.contentLength} chars`,
            `  Preview (${explanation.depth}): ${contentPreview}`,
          ].join("\n");
        });

        return { content: [{ type: "text", text: header.join("\n") + rows.join("\n\n") }] };
      }

      case "zc_replay": {
        const { from, limit } = args as { from?: string; limit?: number };
        const broadcasts = replayBroadcasts(PROJECT_PATH, from, { limit });

        if (broadcasts.length === 0) {
          return { content: [{ type: "text", text: "No broadcasts found in the requested range." }] };
        }

        const lines = [
          `## Broadcast Replay`,
          from ? `From: ${from}` : "From: beginning",
          `Total: ${broadcasts.length}`,
          ``,
        ];

        for (const b of broadcasts) {
          lines.push(
            `[#${b.id}] ${b.created_at.slice(0, 19)}Z ${b.type} agent=${b.agent_id}` +
            (b.task    ? ` task="${b.task}"` : "") +
            (b.summary ? `\n  → ${b.summary}` : "")
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "zc_ack": {
        const { broadcast_id, agent_id: ackAgentId } = args as {
          broadcast_id: number;
          agent_id:     string;
          session_token?: string;
        };
        const acked = ackBroadcast(PROJECT_PATH, broadcast_id, ackAgentId);
        return {
          content: [{
            type: "text",
            text: acked
              ? `Broadcast #${broadcast_id} acknowledged by '${ackAgentId}'.`
              : `Broadcast #${broadcast_id} not found.`,
          }],
        };
      }

      // ── v0.10.0 Harness Engineering ──────────────────────────────────────────
      case "zc_index_project": {
        const { excludes, extensions, max_bytes } = args as {
          excludes?: string[]; extensions?: string[]; max_bytes?: number;
        };
        const res = await indexProject(PROJECT_PATH, { excludes, extensions, maxBytes: max_bytes });
        return {
          content: [{
            type: "text",
            text: `Indexed ${res.filesIndexed} of ${res.filesScanned} files (${res.filesSkipped} skipped, ${(res.bytesRead / 1024).toFixed(1)} KB, ${res.elapsedMs}ms). ` +
                  `Semantic summaries: ${res.semanticSummaries ? "ENABLED (Ollama)" : "DISABLED (truncation fallback — see logs)"}. ` +
                  `Excluded prefixes: ${res.excluded.join(", ")}`,
          }],
        };
      }

      case "zc_file_summary": {
        const { path: summaryPath } = args as { path: string };
        const sum = getFileSummary(PROJECT_PATH, summaryPath);
        if (!sum) {
          return {
            content: [{
              type: "text",
              text: `[not indexed] ${summaryPath}\nRun zc_index_project first, or Read the file directly if you're about to edit it.`,
            }],
          };
        }
        const staleFlag = sum.stale ? " [STALE — file newer than index]" : "";
        return {
          content: [{
            type: "text",
            text: `## ${sum.source}${staleFlag}\n` +
                  `**indexed:** ${sum.indexedAt}\n\n` +
                  `### L0 (purpose)\n${sum.l0 || "(empty)"}\n\n` +
                  `### L1 (detail)\n${sum.l1 || "(empty)"}`,
          }],
        };
      }

      case "zc_project_card": {
        const { stack, layout, state, gotchas, hot_files } = args as Partial<{
          stack: string; layout: string; state: string; gotchas: string; hot_files: string[];
        }>;
        const isWrite = stack !== undefined || layout !== undefined || state !== undefined ||
                        gotchas !== undefined || hot_files !== undefined;
        let card: ProjectCard;
        if (isWrite) {
          card = setProjectCard(PROJECT_PATH, {
            ...(stack    !== undefined && { stack    }),
            ...(layout   !== undefined && { layout   }),
            ...(state    !== undefined && { state    }),
            ...(gotchas  !== undefined && { gotchas  }),
            ...(hot_files !== undefined && { hotFiles: hot_files }),
          });
        } else {
          card = getProjectCard(PROJECT_PATH);
        }
        if (!card.updatedAt) {
          return {
            content: [{
              type: "text",
              text: `No project card yet. Populate with zc_project_card({stack, layout, state, gotchas, hot_files}).`,
            }],
          };
        }
        return {
          content: [{
            type: "text",
            text: `# Project Card (updated ${card.updatedAt})\n\n` +
                  `**Stack:** ${card.stack || "—"}\n\n` +
                  `**Layout:**\n${card.layout || "—"}\n\n` +
                  `**State:** ${card.state || "—"}\n\n` +
                  `**Gotchas:** ${card.gotchas || "—"}\n\n` +
                  `**Hot files:** ${card.hotFiles.length ? card.hotFiles.join(", ") : "—"}`,
          }],
        };
      }

      case "zc_check": {
        const { question, path: scopePath } = args as { question: string; path?: string };
        const hits = await searchKnowledge(PROJECT_PATH, [question]);
        const filtered = scopePath
          ? hits.filter((h) => h.source.includes(scopePath))
          : hits;
        const result = checkAnswer(PROJECT_PATH, question, filtered.slice(0, 5));
        return {
          content: [{
            type: "text",
            text: `## Check: "${result.question}"\n` +
                  `**answered:** ${result.answered} | **confidence:** ${result.confidence}\n\n` +
                  (result.sources.length
                    ? `**sources:** ${result.sources.join(", ")}\n\n${result.snippet}\n\n`
                    : ``) +
                  `**suggestion:** ${result.suggestion}`,
          }],
        };
      }

      case "zc_capture_output": {
        const { command: capCmd, stdout: capOut, exit_code: capExit } = args as {
          command: string; stdout: string; exit_code: number;
        };
        const cap = captureToolOutput(PROJECT_PATH, capCmd, capOut, capExit);
        return {
          content: [{
            type: "text",
            text: `Captured ${cap.lineCount} lines (hash=${cap.hash.slice(0,12)}, exit=${cap.exitCode}). ` +
                  `Full output searchable via source='${cap.fullRef}'.\n\n` +
                  `## Summary\n${cap.summary}`,
          }],
        };
      }

      case "zc_logs": {
        const { readLogs } = await import("./logger.js");
        const lArgs = args as {
          component: string;
          since_date?: string;
          until_date?: string;
          min_level?: "DEBUG" | "INFO" | "WARN" | "ERROR";
          event_contains?: string;
          trace_id?: string;
          agent_id?: string;
          limit?: number;
        };
        // Agent-scope: fall back to ZC_AGENT_ID env when not supplied.
        // When neither is set, no agent-scoping (system/admin view).
        const effectiveAgentId = lArgs.agent_id ?? process.env.ZC_AGENT_ID ?? undefined;
        const entries = readLogs({
          component:      lArgs.component,
          sinceDate:      lArgs.since_date,
          untilDate:      lArgs.until_date,
          minLevel:       lArgs.min_level,
          eventContains:  lArgs.event_contains,
          traceId:        lArgs.trace_id,
          agentId:        effectiveAgentId,
          limit:          lArgs.limit,
        });

        if (entries.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No log entries found for component='${lArgs.component}' with the given filters.`,
            }],
          };
        }

        const header =
          `## ${lArgs.component} (${entries.length} entries, newest first` +
          (effectiveAgentId ? `, scoped to agent_id='${effectiveAgentId}'` : ``) +
          `)\n`;
        const body = entries.map((e) => {
          const ctx = e.context ? ` ${JSON.stringify(e.context)}` : "";
          const trace = e.trace_id ? ` [${e.trace_id}]` : "";
          return `${e.ts} ${e.level.padEnd(5)} ${e.event}${trace}${ctx}`;
        }).join("\n");

        return { content: [{ type: "text", text: header + body }] };
      }

      // ── v0.13.0 graphify integration ────────────────────────────────
      case "zc_graph_query": {
        const { query } = args as { query: string };
        const { graphQuery } = await import("./graph_proxy.js");
        const r = await graphQuery(PROJECT_PATH, query);
        if (!r.ok) {
          return { content: [{ type: "text", text: r.hint ?? r.error ?? "graphify call failed" }], isError: !r.hint };
        }
        return { content: [{ type: "text", text: `## Graph query: ${query}\n\`\`\`json\n${JSON.stringify(r.data, null, 2)}\n\`\`\`` }] };
      }

      case "zc_graph_path": {
        const { from, to } = args as { from: string; to: string };
        const { graphPath } = await import("./graph_proxy.js");
        const r = await graphPath(PROJECT_PATH, from, to);
        if (!r.ok) {
          return { content: [{ type: "text", text: r.hint ?? r.error ?? "graphify call failed" }], isError: !r.hint };
        }
        return { content: [{ type: "text", text: `## Path: ${from} → ${to}\n\`\`\`json\n${JSON.stringify(r.data, null, 2)}\n\`\`\`` }] };
      }

      case "zc_graph_neighbors": {
        const { node } = args as { node: string };
        const { graphNeighbors } = await import("./graph_proxy.js");
        const r = await graphNeighbors(PROJECT_PATH, node);
        if (!r.ok) {
          return { content: [{ type: "text", text: r.hint ?? r.error ?? "graphify call failed" }], isError: !r.hint };
        }
        return { content: [{ type: "text", text: `## Neighbors of: ${node}\n\`\`\`json\n${JSON.stringify(r.data, null, 2)}\n\`\`\`` }] };
      }

      // ── v0.14.0 community detection ─────────────────────────────────
      case "zc_kb_cluster": {
        const { detectCommunities, storeCommunities } = await import("./indexing/community.js");
        const { DatabaseSync: DSC } = await import("node:sqlite");
        const { mkdirSync: mkdC } = await import("node:fs");
        const { join: pjoinC } = await import("node:path");
        const { createHash: chC } = await import("node:crypto");
        mkdC(Config.DB_DIR, { recursive: true });
        const dbFileC = pjoinC(Config.DB_DIR, `${chC("sha256").update(PROJECT_PATH).digest("hex").slice(0,16)}.db`);
        const cdb = new DSC(dbFileC);
        cdb.exec("PRAGMA journal_mode = WAL");
        const result = detectCommunities(cdb);
        if (result.totalSources > 0) storeCommunities(cdb, result);
        cdb.close();

        const lines: string[] = [];
        lines.push(`## KB Community Detection (Louvain) — v0.14.0`);
        lines.push(``);
        lines.push(`Sources: ${result.totalSources}  Edges: ${result.totalEdges}  Communities: ${result.communityCount}  Modularity: ${result.modularity.toFixed(3)}`);
        lines.push(`Computed in ${result.elapsedMs}ms.`);
        lines.push(``);
        lines.push(`### Top communities`);
        for (const c of result.communities.slice(0, 8)) {
          lines.push(`- **community ${c.id}** (${c.size} sources): ${c.sampleSources.slice(0, 3).join(", ")}${c.sampleSources.length > 3 ? ", ..." : ""}`);
        }
        lines.push(``);
        lines.push(`Use \`zc_kb_community_for(source)\` to look up a specific source's community-mates.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "zc_kb_community_for": {
        const { source } = args as { source: string };
        const { getCommunityForSource } = await import("./indexing/community.js");
        const { DatabaseSync: DSC2 } = await import("node:sqlite");
        const { mkdirSync: mkdC2 } = await import("node:fs");
        const { join: pjoinC2 } = await import("node:path");
        const { createHash: chC2 } = await import("node:crypto");
        mkdC2(Config.DB_DIR, { recursive: true });
        const dbFileC2 = pjoinC2(Config.DB_DIR, `${chC2("sha256").update(PROJECT_PATH).digest("hex").slice(0,16)}.db`);
        const cdb2 = new DSC2(dbFileC2);
        const info = getCommunityForSource(cdb2, source);
        cdb2.close();

        if (info.communityId === null) {
          return { content: [{ type: "text", text: `Source '${source}' not found in kb_communities. Run \`zc_kb_cluster\` first to compute community assignments.` }] };
        }
        const lines: string[] = [];
        lines.push(`## Community of: ${source}`);
        lines.push(`Community ID: ${info.communityId}  |  Size: ${info.communitySize}`);
        if (info.mates.length > 0) {
          lines.push(``);
          lines.push(`### Community-mates (${info.mates.length})`);
          for (const m of info.mates.slice(0, 30)) lines.push(`- ${m}`);
          if (info.mates.length > 30) lines.push(`... and ${info.mates.length - 30} more`);
        } else {
          lines.push(`This source is in a singleton community.`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "zc_choose_model": {
        const { complexity } = args as { complexity?: number };
        const { chooseModel } = await import("./indexing/model_router.js");
        const rec = chooseModel(complexity ?? null);
        const lines: string[] = [];
        lines.push(`## Model recommendation`);
        lines.push(`- **Tier:** ${rec.tier}`);
        lines.push(`- **Model:** ${rec.model}`);
        lines.push(`- **Input cost:** $${rec.estimatedInputCostPerMtok.toFixed(2)}/Mtok`);
        lines.push(`- **Clamped:** ${rec.inputClamped ? "yes" : "no"}`);
        lines.push(``);
        lines.push(rec.reason);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── v0.17.0 §8.2 — work-stealing queue MCP tools ──────────────────────
      // All of these require the Postgres telemetry backend. The task_queue_pg
      // table lives in the same PG instance as tool_calls_pg / outcomes_pg
      // and is migrated via pg_migrations.ts id=5.
      case "zc_enqueue_task": {
        const { task_id, role, payload } = args as {
          task_id: string; role: string; payload: Record<string, unknown>;
        };
        if (!task_id || !role) {
          return { content: [{ type: "text", text: "Error: task_id and role are required" }], isError: true };
        }
        const { enqueueTask } = await import("./task_queue.js");
        const projectHashTq = createHash("sha256").update(PROJECT_PATH).digest("hex").slice(0, 16);
        const inserted = await enqueueTask({
          taskId:      task_id,
          projectHash: projectHashTq,
          role,
          payload:     payload ?? {},
        });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, inserted, task_id, role }) }] };
      }
      case "zc_claim_task": {
        const { role } = args as { role: string };
        if (!role) {
          return { content: [{ type: "text", text: "Error: role is required" }], isError: true };
        }
        const { claimTask } = await import("./task_queue.js");
        const projectHashCt = createHash("sha256").update(PROJECT_PATH).digest("hex").slice(0, 16);
        const workerIdCt = process.env.ZC_AGENT_ID || "unknown-worker";
        const claim = await claimTask(projectHashCt, role, workerIdCt);
        if (!claim) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, claim: null, note: "queue empty for this role" }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, claim, worker_id: workerIdCt }) }] };
      }
      case "zc_heartbeat_task": {
        const { task_id } = args as { task_id: string };
        if (!task_id) return { content: [{ type: "text", text: "Error: task_id is required" }], isError: true };
        const { heartbeatTask } = await import("./task_queue.js");
        const workerIdHb = process.env.ZC_AGENT_ID || "unknown-worker";
        const ok = await heartbeatTask(task_id, workerIdHb);
        return { content: [{ type: "text", text: JSON.stringify({ ok, task_id, worker_id: workerIdHb, note: ok ? "heartbeat accepted" : "task no longer owned (reclaimed or completed)" }) }] };
      }
      case "zc_complete_task": {
        const { task_id } = args as { task_id: string };
        if (!task_id) return { content: [{ type: "text", text: "Error: task_id is required" }], isError: true };
        const { completeTask } = await import("./task_queue.js");
        const workerIdCp = process.env.ZC_AGENT_ID || "unknown-worker";
        const ok = await completeTask(task_id, workerIdCp);
        return { content: [{ type: "text", text: JSON.stringify({ ok, task_id, worker_id: workerIdCp, note: ok ? "marked done" : "not owned or already terminal" }) }] };
      }
      case "zc_fail_task": {
        const { task_id, reason } = args as { task_id: string; reason: string };
        if (!task_id) return { content: [{ type: "text", text: "Error: task_id is required" }], isError: true };
        const { failTask } = await import("./task_queue.js");
        const workerIdFl = process.env.ZC_AGENT_ID || "unknown-worker";
        const ok = await failTask(task_id, workerIdFl, reason ?? "unspecified");
        return { content: [{ type: "text", text: JSON.stringify({ ok, task_id, worker_id: workerIdFl, note: ok ? "marked failed (retries++)" : "not owned or already terminal" }) }] };
      }
      case "zc_queue_stats": {
        const { getQueueStats } = await import("./task_queue.js");
        const projectHashSt = createHash("sha256").update(PROJECT_PATH).digest("hex").slice(0, 16);
        const stats = await getQueueStats(projectHashSt);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, stats }) }] };
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
}  // end dispatchToolCall

// ─── Sprint 1 Phase B: Tool dispatch wrapper with telemetry ─────────────────
// Wraps every MCP tool call with:
//   - Per-call telemetry (cost, latency, status) into the tool_calls table
//     via src/telemetry.ts (hash-chained for tamper detection)
//   - [cost: ...] header line prepended to every response (so the agent
//     learns its own cost in the live loop, per §6.5)
//   - Cross-log trace_id for correlation across telemetry/outcomes/etc

// MCP server-side session UUID. Generated once per process start; identifies
// "this MCP server instance" for grouping all calls into the same session.
const MCP_SESSION_ID = `mcp-${randomUUID().slice(0, 12)}`;

// Resolve the agent_id + model from env (set by start-agents.ps1 launchers).
// Defaults to "default"/"unknown" for ad-hoc / non-A2A use.
const AGENT_ID    = process.env.ZC_AGENT_ID    || "default";
const AGENT_MODEL = process.env.ZC_AGENT_MODEL || "unknown";

/** Classify an error for telemetry's error_class taxonomy. */
function classifyError(e: unknown): "transient" | "permission" | "logic" | "unknown" {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (msg.includes("timeout") || msg.includes("etimedout") || msg.includes("econnrefused")) return "transient";
  if (msg.includes("permission") || msg.includes("denied") || msg.includes("forbidden") ||
      msg.includes("unauthorized") || msg.includes("rbac")) return "permission";
  if (msg.includes("invalid") || msg.includes("required") || msg.includes("expected") ||
      msg.includes("must be")) return "logic";
  return "unknown";
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const argsObj = (args ?? {}) as Record<string, unknown>;

  const callId  = newCallId();
  const traceId = newTraceId("call");
  const t0      = Date.now();

  let status: "ok" | "error" = "ok";
  let errorClass: "transient" | "permission" | "logic" | "unknown" | undefined;
  let result:  Awaited<ReturnType<typeof dispatchToolCall>>;

  try {
    result = await dispatchToolCall(name, argsObj);
    if (result.isError) {
      status = "error";
      errorClass = "logic";
    }
  } catch (e) {
    status = "error";
    errorClass = classifyError(e);
    // Re-throw so MCP transport returns the error to the caller
    // (telemetry write happens in the finally block below)
    const inputChars  = JSON.stringify(argsObj).length;
    // Fire-and-forget: telemetry failure must not block the error from
    // propagating. The void operator silences @typescript-eslint/no-floating-promises
    // while documenting that the promise is intentionally un-awaited.
    void recordToolCall({
      callId,
      sessionId:   MCP_SESSION_ID,
      agentId:     AGENT_ID,
      projectPath: PROJECT_PATH,
      toolName:    name,
      model:       AGENT_MODEL,
      inputChars,
      outputChars: 0,
      latencyMs:   Date.now() - t0,
      status,
      errorClass,
      traceId,
    });
    throw e;
  }

  // ── Append cost header to response ───────────────────────────────────────
  // (the agent reads this header to learn its own cost in real time)
  const inputChars  = JSON.stringify(argsObj).length;
  const outputText  = result.content.map((c) => c.text ?? "").join("\n");
  const outputChars = outputText.length;

  const inputTokens  = Math.ceil(inputChars  / 4);
  const outputTokens = Math.ceil(outputChars / 4);
  const cost         = computeCost(AGENT_MODEL, inputTokens, outputTokens);
  const header       = formatCostHeader({
    inputTokens,
    outputTokens,
    cost,
    latencyMs: Date.now() - t0,
  });

  // Inject header as the FIRST line of the FIRST text content block
  if (result.content.length > 0 && result.content[0].type === "text") {
    result.content[0].text = `${header}\n${result.content[0].text}`;
  } else {
    result.content.unshift({ type: "text", text: header });
  }

  // ── Record telemetry (fire-and-forget; never throws; never blocks return) ──
  // void operator documents intent + silences no-floating-promises lint
  void recordToolCall({
    callId,
    sessionId:   MCP_SESSION_ID,
    agentId:     AGENT_ID,
    projectPath: PROJECT_PATH,
    toolName:    name,
    model:       AGENT_MODEL,
    inputChars,
    outputChars,
    latencyMs:   Date.now() - t0,
    status,
    errorClass,
    traceId,
  });

  return result;
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
