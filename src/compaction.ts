/**
 * v0.20.0 — Rolling conversation compaction (Tier A item #4).
 *
 * Plan §7.7 calls for a background process that compacts conversation
 * segments > 30 turns + > 30 min old + stable. v0.20.0 ships the
 * on-demand path (the MCP tool `zc_compact_window`); the background
 * daemon is v0.21+.
 *
 * What this does:
 *   1. Pull the last N broadcasts + tool_calls for this session/project
 *   2. Ask Ollama to produce a structured summary
 *   3. Write the summary into working_memory at importance=4 (so it
 *      survives eviction but doesn't crowd out [★5] critical facts)
 *   4. Return the summary so the agent can include it inline
 *
 * Configuration:
 *   ZC_COMPACT_DEFAULT_TURNS  default 30
 *   ZC_OLLAMA_URL             existing
 *   ZC_COMPACT_MODEL          default qwen2.5-coder:14b
 */

import { withClient } from "./pg_pool.js";
import { logger } from "./logger.js";
import { createHash } from "node:crypto";

// v0.20.0 — ZC_OLLAMA_URL might be set to the full embeddings endpoint
// (e.g. "http://sc-ollama:11434/api/embeddings"). Strip any /api/* suffix
// so we can construct path-specific URLs. Compaction needs /api/generate.
function ollamaBase(): string {
  const raw = process.env.ZC_OLLAMA_URL ?? "http://localhost:11435";
  return raw.replace(/\/api\/[^/]+\/?$/, "").replace(/\/$/, "");
}
const OLLAMA_URL    = ollamaBase();
const COMPACT_MODEL = process.env.ZC_COMPACT_MODEL ?? "qwen2.5-coder:14b";
const DEFAULT_TURNS = parseInt(process.env.ZC_COMPACT_DEFAULT_TURNS ?? "30", 10);

export interface CompactionResult {
  ok:                    boolean;
  turns_compacted:       number;
  summary:               string | null;
  written_to_memory_key: string | null;
  oldest_compacted_at:   string | null;
  newest_compacted_at:   string | null;
  error?:                string;
}

interface RecentTurn {
  kind:       "broadcast" | "tool_call";
  ts:         string;
  agent_id:   string;
  description: string;
}

async function loadRecentTurns(projectHash: string, sessionId: string | null, limit: number): Promise<RecentTurn[]> {
  return await withClient(async (c) => {
    const broadcastQ = `
      SELECT 'broadcast'::text AS kind, created_at AS ts, agent_id,
             type || COALESCE(' [' || NULLIF(task,'') || ']','') ||
             COALESCE(': ' || LEFT(NULLIF(summary,''), 200), '') AS description
        FROM broadcasts
       WHERE project_hash = $1
       ORDER BY id DESC
       LIMIT $2
    `;
    const toolQ = sessionId
      ? `SELECT 'tool_call'::text AS kind, ts::text, agent_id,
                tool_name || ' (' || latency_ms || 'ms, ' || input_tokens || '+' || output_tokens || 'tok)' AS description
           FROM tool_calls_pg
          WHERE project_hash = $1 AND session_id = $2
          ORDER BY id DESC LIMIT $3`
      : `SELECT 'tool_call'::text AS kind, ts::text, agent_id,
                tool_name || ' (' || latency_ms || 'ms, ' || input_tokens || '+' || output_tokens || 'tok)' AS description
           FROM tool_calls_pg
          WHERE project_hash = $1
          ORDER BY id DESC LIMIT $2`;
    const bcRes = await c.query<RecentTurn>(broadcastQ, [projectHash, limit]);
    const tcRes = sessionId
      ? await c.query<RecentTurn>(toolQ, [projectHash, sessionId, limit])
      : await c.query<RecentTurn>(toolQ, [projectHash, limit]);
    const merged: RecentTurn[] = [...bcRes.rows, ...tcRes.rows];
    merged.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return merged.slice(0, limit);
  });
}

async function summarizeViaOllama(turns: RecentTurn[]): Promise<string> {
  const transcript = turns.map((t, i) => `${i + 1}. [${t.ts}] ${t.agent_id}/${t.kind}: ${t.description}`).join("\n");
  const prompt = `You are summarizing a SecureContext multi-agent session for memory compaction. Below are the last ${turns.length} turns (broadcasts + tool calls), oldest at the top.

Produce a structured summary in this exact format (under 400 words total):

## What happened
- 3-6 bullets capturing the major events in chronological order

## Decisions made
- Any architectural / design / approval decisions reached

## Outstanding items
- Anything in-flight that the agent should resume on next session

## Key references
- File paths, broadcast IDs, task IDs, agent names that future searches need

TRANSCRIPT:
${transcript}

SUMMARY:`;

  const r = await fetch(`${OLLAMA_URL.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: COMPACT_MODEL, prompt, stream: false, options: { temperature: 0.2, num_predict: 800 } }),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
  const j = await r.json() as { response: string };
  return (j.response ?? "").trim();
}

async function persistCompactionFact(projectHash: string, sessionId: string | null, summary: string, turnsCount: number): Promise<string> {
  const key = `compact_${sessionId ?? "global"}_${Date.now().toString(36)}`;
  const value = `[Rolling compaction of ${turnsCount} turns]\n${summary.slice(0, 480)}`;
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO working_memory (project_hash, key, value, importance, agent_id, created_at)
       VALUES ($1, $2, $3, 4, 'system', now())
       ON CONFLICT (project_hash, key, agent_id) DO UPDATE
         SET value = EXCLUDED.value, created_at = EXCLUDED.created_at`,
      [projectHash, key.slice(0, 100), value.slice(0, 500)],
    );
  });
  return key;
}

export async function compactRecentWindow(opts: {
  projectPath: string;
  sessionId?:  string | null;
  turns?:      number;
}): Promise<CompactionResult> {
  const turnsLimit  = Math.max(5, Math.min(100, opts.turns ?? DEFAULT_TURNS));
  const projectHash = createHash("sha256").update(opts.projectPath).digest("hex").slice(0, 16);
  try {
    const turns = await loadRecentTurns(projectHash, opts.sessionId ?? null, turnsLimit);
    if (turns.length === 0) {
      return { ok: false, turns_compacted: 0, summary: null, written_to_memory_key: null, oldest_compacted_at: null, newest_compacted_at: null, error: "No recent turns found in this project/session" };
    }
    const summary = await summarizeViaOllama(turns);
    if (!summary) {
      return { ok: false, turns_compacted: turns.length, summary: null, written_to_memory_key: null, oldest_compacted_at: turns[turns.length - 1]?.ts ?? null, newest_compacted_at: turns[0]?.ts ?? null, error: "Ollama returned empty summary" };
    }
    const key = await persistCompactionFact(projectHash, opts.sessionId ?? null, summary, turns.length);
    logger.info("compaction", "window_compacted", {
      project_hash: projectHash, session_id: opts.sessionId, turns: turns.length, memory_key: key,
    });
    return {
      ok: true, turns_compacted: turns.length,
      summary, written_to_memory_key: key,
      oldest_compacted_at: turns[turns.length - 1]?.ts ?? null,
      newest_compacted_at: turns[0]?.ts ?? null,
    };
  } catch (e) {
    logger.error("compaction", "compact_failed", { error: (e as Error).message, project_path: opts.projectPath });
    return { ok: false, turns_compacted: 0, summary: null, written_to_memory_key: null, oldest_compacted_at: null, newest_compacted_at: null, error: (e as Error).message };
  }
}
