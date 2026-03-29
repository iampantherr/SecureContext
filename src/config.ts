/**
 * Centralized configuration for SecureContext.
 *
 * All constants and tunables live here. Sensitive paths use homedir().
 * Key settings are overridable via environment variables for power users.
 *
 * Environment variables:
 *   ZC_OLLAMA_URL          — Ollama embeddings endpoint (default: http://127.0.0.1:11434/api/embeddings)
 *   ZC_OLLAMA_MODEL        — Embedding model name (default: nomic-embed-text)
 *   ZC_STRICT_INTEGRITY    — "1" to crash on integrity failure instead of warn (default: warn only)
 *   ZC_FETCH_LIMIT         — Max fetches per session per project (default: 50)
 *   ZC_STALE_DAYS_EXTERNAL — Days before external (web-fetched) KB entries expire (default: 14)
 *   ZC_STALE_DAYS_INTERNAL — Days before internal KB entries expire (default: 30)
 *   ZC_STALE_DAYS_SUMMARY  — Days before session summaries expire (default: 365)
 */

import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;

export const Config = {
  // ── Version ──────────────────────────────────────────────────────────────
  VERSION: "0.7.0",

  // ── Storage paths ────────────────────────────────────────────────────────
  DB_DIR:      join(homedir(), ".claude", "zc-ctx", "sessions"),
  GLOBAL_DIR:  join(homedir(), ".claude", "zc-ctx"),
  GLOBAL_DB:   join(homedir(), ".claude", "zc-ctx", "global.db"),  // cross-project rate limits

  // ── Working memory ────────────────────────────────────────────────────────
  WORKING_MEMORY_MAX:      50,   // evict when this count is exceeded
  WORKING_MEMORY_EVICT_TO: 40,   // target count after eviction batch

  // ── Knowledge base retention (tiered by content type) ────────────────────
  // External (web-fetched) content expires soonest — untrusted, ephemeral
  STALE_DAYS_EXTERNAL:  parseInt(env["ZC_STALE_DAYS_EXTERNAL"] ?? "14",  10),
  // Internal (agent-indexed) content kept longer
  STALE_DAYS_INTERNAL:  parseInt(env["ZC_STALE_DAYS_INTERNAL"] ?? "30",  10),
  // Session summaries kept for a year — these are the highest-value long-term memory
  STALE_DAYS_SUMMARY:   parseInt(env["ZC_STALE_DAYS_SUMMARY"]  ?? "365", 10),

  // ── Search parameters ─────────────────────────────────────────────────────
  MAX_RESULTS:      10,
  BM25_CANDIDATES:  20,  // over-fetch for reranking
  W_COSINE:         0.65,
  W_BM25:           0.35,

  // ── Fetch / SSRF ──────────────────────────────────────────────────────────
  FETCH_LIMIT:       parseInt(env["ZC_FETCH_LIMIT"] ?? "50", 10),
  FETCH_TIMEOUT_MS:  15_000,
  MAX_RESPONSE_BYTES: 2 * 1024 * 1024,
  MAX_REDIRECTS:     5,

  // ── Sandbox ───────────────────────────────────────────────────────────────
  SANDBOX_TIMEOUT_MS: 30_000,
  SANDBOX_STDOUT_CAP: 512 * 1024,
  SANDBOX_STDERR_CAP: 64  * 1024,

  // ── Embedding / Ollama ───────────────────────────────────────────────────
  OLLAMA_URL:        env["ZC_OLLAMA_URL"]   ?? "http://127.0.0.1:11434/api/embeddings",
  OLLAMA_TAGS_URL:   "http://127.0.0.1:11434/api/tags",
  OLLAMA_MODEL:      env["ZC_OLLAMA_MODEL"] ?? "nomic-embed-text",
  EMBED_TIMEOUT_MS:  5_000,
  EMBED_MAX_CHARS:   4_000,
  EMBED_AVAIL_TTL:   60_000, // re-check Ollama availability every 60s

  // ── Security ──────────────────────────────────────────────────────────────
  // When true, integrity mismatch crashes the server instead of just logging
  STRICT_INTEGRITY:  env["ZC_STRICT_INTEGRITY"] === "1",
} as const;
