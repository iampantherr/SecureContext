/**
 * zc-ctx Stop Hook — Automatic Background Memory Extraction (v0.40.0)
 *
 * Closes the "hands-free extraction" gap vs AWS AgentCore Memory / Google Memory
 * Bank / Mem0: agents no longer have to call zc_remember for a fact to survive the
 * session. On every Stop event this hook reads the NEW portion of the session
 * transcript, asks the LOCAL Ollama model to distill 0–5 DURABLE facts (decisions,
 * constraints, gotchas, preferences, project-state changes), and writes them through
 * the normal SecureContext memory API tagged `origin=auto-extract` — so citations,
 * epistemology typing, contradiction detection, and the retirement lifecycle all
 * apply to extracted facts exactly as to hand-written ones.
 *
 * SECURITY CONTRACT (deliberately DIFFERENT from stop.mjs — do not merge them):
 * 1. Reads the transcript ONLY from the path Claude Code passes on stdin.
 * 2. Talks ONLY to the two loopback/private services the agent already trusts:
 *    the SecureContext API (ZC_API_URL + bearer ZC_API_KEY) and Ollama
 *    (ZC_AUTO_EXTRACT_OLLAMA / default http://127.0.0.1:11434). Never the internet.
 * 3. Persists DISTILLED facts only — never raw conversation text. Values are capped
 *    at 400 chars and secret-looking strings are dropped.
 * 4. State (per-session transcript offset + budget) lives under ~/.claude/zc-ctx/.
 * 5. Fails silent and always exits 0 — a hook error must never break the session.
 *
 * Kill-switch: ZC_AUTO_EXTRACT=0. Budgets: ZC_AUTO_EXTRACT_MAX (default 10 facts
 * per session), min 1500 new transcript chars per run (accumulates across turns).
 */

import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const STATE_DIR = join(homedir(), ".claude", "zc-ctx", "autoextract");
const MIN_NEW_CHARS = 500; // one substantive brief is enough; short nudges still accumulate
const MAX_CHAT_CHARS = 20000;
const MAX_FACTS_PER_RUN = 5;
const OLLAMA_TIMEOUT_MS = 45_000;
const API_TIMEOUT_MS = 10_000;

const SECRET_RE = /(api[_-]?key|secret|password|passwd|bearer\s+[a-z0-9]|token\s*[:=]|BEGIN [A-Z]+ PRIVATE KEY|[a-f0-9]{40,})/i;

function sha16(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

async function fetchJson(url, opts = {}, timeoutMs = API_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// v0.40.1 — coordination filter (kept in sync with userprompt-autoextract.mjs;
// duplicated because each hook is a self-contained script by security contract).
// Harness-authored coordination traffic (dispatcher ASSIGN pings, nudges, alerts,
// shutdown signals) is transient machine-to-machine state — never memory material.
const IGNORE_PREFIXES = ["DISPATCHER:", "ALERT:", "REMINDER:", "A2A SHUTDOWN SIGNAL:"];
function isCoordinationMessage(text) {
  const extra = (process.env.ZC_AUTO_EXTRACT_IGNORE_PREFIXES || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const t = text.trimStart();
  return [...IGNORE_PREFIXES, ...extra].some((p) => t.startsWith(p));
}

/** Pull user/assistant TEXT out of the new transcript slice (JSONL). */
function extractChatText(raw) {
  const parts = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const role = obj?.type;
    if (role !== "user" && role !== "assistant") continue;
    const content = obj?.message?.content;
    if (typeof content === "string") {
      if (content.trim() && !(role === "user" && isCoordinationMessage(content))) {
        parts.push(`${role}: ${content.trim()}`);
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          if (role === "user" && isCoordinationMessage(block.text)) continue;
          parts.push(`${role}: ${block.text.trim()}`);
        }
      }
    }
  }
  return parts.join("\n");
}

async function main() {
  if (process.env.ZC_AUTO_EXTRACT === "0") return;
  const apiUrl = (process.env.ZC_API_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.ZC_API_KEY || "";
  if (!apiUrl || !apiKey) return; // API mode required — nothing to write to otherwise

  // --- Stop-event payload ---
  const lines = [];
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) lines.push(line);
  let event;
  try { event = JSON.parse(lines.join("\n")); } catch { return; }

  const transcriptPath = event?.transcript_path;
  const sessionId = event?.session_id || "unknown";
  const projectPath = event?.cwd || process.cwd();

  // --- Per-session state: transcript offset + extraction budget ---
  mkdirSync(STATE_DIR, { recursive: true });
  const statePath = join(STATE_DIR, `${sha16(sessionId)}.json`);
  const bufPath = join(STATE_DIR, `${sha16(sessionId)}.buf`);
  let state = { offset: 0, extracted: 0 };
  try { state = { ...state, ...JSON.parse(readFileSync(statePath, "utf8")) }; } catch { /* fresh */ }

  const maxPerSession = parseInt(process.env.ZC_AUTO_EXTRACT_MAX || "10", 10) || 10;
  if (state.extracted >= maxPerSession) return;

  // Source 1 — the transcript file, when this CLI actually persists one.
  // (Interactive npm-CLI sessions since ~June 2026 write only a title stub, so
  //  this is often empty for A2A terminal agents.)
  let transcriptChat = "";
  let size = state.offset;
  if (transcriptPath && existsSync(transcriptPath)) {
    size = statSync(transcriptPath).size;
    if (size > state.offset) {
      const raw = readFileSync(transcriptPath, "utf8");
      transcriptChat = extractChatText(raw.slice(state.offset));
    }
  }
  // Source 2 — the prompt buffer appended by userprompt-autoextract.mjs
  // (UserPromptSubmit hands us the user text directly; assistant side is
  //  unavailable without a transcript, and the prompt side carries most
  //  durable constraints/decisions anyway).
  let bufferChat = "";
  if (existsSync(bufPath)) {
    try { bufferChat = readFileSync(bufPath, "utf8"); } catch { bufferChat = ""; }
  }

  const chat = [transcriptChat, bufferChat].filter(Boolean).join("\n");
  if (chat.length < MIN_NEW_CHARS) return; // accumulate — do NOT advance offset or drain buffer

  const chatCapped = chat.length > MAX_CHAT_CHARS ? chat.slice(-MAX_CHAT_CHARS) : chat;

  // --- Ask the local model to distill durable facts ---
  const ollamaBase = (process.env.ZC_AUTO_EXTRACT_OLLAMA || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = process.env.ZC_AUTO_EXTRACT_MODEL || process.env.ZC_SUMMARY_MODEL || "qwen2.5-coder:14b";
  const prompt =
    "You maintain an engineering agent's long-term memory. From the conversation excerpt below, " +
    "extract at most 5 DURABLE facts worth remembering in FUTURE sessions: decisions made and why, " +
    "constraints or gotchas discovered, user preferences stated, project-state changes. " +
    "NEVER extract: transient status, greetings, anything containing credentials/tokens/keys, " +
    "restatements of what code already says, task assignments, agent-coordination or dispatcher/" +
    "orchestrator status instructions (who was assigned what, reminders to broadcast/merge/claim " +
    "tasks). If nothing durable, return an empty list.\n" +
    'Respond with JSON ONLY: {"facts":[{"key":"short_snake_case_id","value":"one-sentence fact",' +
    '"importance":2,"kind":"fact"}]} where importance is 2-4 and kind is one of ' +
    '"fact","decision","hypothesis","prediction".\n\nCONVERSATION:\n' + chatCapped;

  const resp = await fetchJson(`${ollamaBase}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      format: "json",
      options: { temperature: 0.1, num_predict: 700 },
    }),
  }, OLLAMA_TIMEOUT_MS);
  if (!resp) return; // Ollama down — try again next Stop (offset not advanced)

  let facts = [];
  try {
    const parsed = JSON.parse(resp?.message?.content ?? "{}");
    if (Array.isArray(parsed?.facts)) facts = parsed.facts;
  } catch { facts = []; }

  // The model has spoken — advance the transcript offset and drain the prompt
  // buffer now even if 0 facts, so we never re-bill the same text next turn.
  state.offset = size;
  try { if (existsSync(bufPath)) writeFileSync(bufPath, "", "utf8"); } catch { /* best-effort */ }

  // --- Validate + sanitize candidates ---
  const clean = [];
  for (const f of facts.slice(0, MAX_FACTS_PER_RUN)) {
    const key = String(f?.key ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
    const value = String(f?.value ?? "").trim().slice(0, 400);
    if (key.length < 3 || value.length < 12) continue;
    if (SECRET_RE.test(value) || SECRET_RE.test(key)) continue;
    const importance = Math.min(4, Math.max(2, parseInt(f?.importance, 10) || 3));
    const kind = ["fact", "decision", "hypothesis", "prediction"].includes(f?.kind) ? f.kind : undefined;
    clean.push({ key, value, importance, kind });
  }
  if (clean.length === 0) { writeFileSync(statePath, JSON.stringify(state)); return; }

  // --- Dedup against existing working memory (keys + near-identical values) ---
  const agentId = process.env.ZC_AGENT_ID || "default";
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const existing = await fetchJson(
    `${apiUrl}/api/v1/recall?projectPath=${encodeURIComponent(projectPath)}&agentId=${encodeURIComponent(agentId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const existingKeys = new Set();
  const existingVals = [];
  for (const f of existing?.facts ?? []) {
    if (f?.key) existingKeys.add(String(f.key));
    if (f?.value) existingVals.push(norm(String(f.value)));
  }

  // --- Write the survivors through the normal memory path ---
  for (const f of clean) {
    if (state.extracted >= maxPerSession) break;
    if (existingKeys.has(f.key)) continue;
    const nv = norm(f.value);
    if (existingVals.some((ev) => ev.includes(nv) || nv.includes(ev))) continue;
    const ok = await fetchJson(`${apiUrl}/api/v1/remember`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        projectPath,
        key: f.key,
        value: f.value,
        importance: f.importance,
        agentId,
        ...(f.kind ? { kind: f.kind } : {}),
        origin: `auto-extract:${sessionId.slice(0, 12)}`,
      }),
    });
    if (ok?.ok) {
      state.extracted += 1;
      existingKeys.add(f.key);
      existingVals.push(nv);
    }
  }

  try { writeFileSync(statePath, JSON.stringify(state)); } catch { /* best-effort */ }
}

// No explicit process.exit(): calling it while undici's keep-alive sockets are
// mid-teardown trips libuv's UV_HANDLE_CLOSING assert on Windows (exit 127).
// Natural exit drains handles cleanly; the few-second keep-alive tail is fine
// for a Stop hook. Errors are swallowed — a hook must never break the session.
main().catch(() => { /* silent */ });
