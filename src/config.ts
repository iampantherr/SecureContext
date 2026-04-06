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
 *   ZC_RBAC_ENABLED        — "1" to force-enable RBAC even without registered sessions
 *   ZC_CHAIN_DISABLED      — "1" to disable hash chain (not recommended, audit use only)
 */

import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;

export const Config = {
  // ── Version ──────────────────────────────────────────────────────────────
  VERSION: "0.8.0",

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

  // ── Broadcast channel security ────────────────────────────────────────────
  // Channel key KDF: scrypt parameters (OWASP Interactive Login recommended minimum)
  // N=32768 (2^15): cost factor — the minimum specified by OWASP for interactive use.
  // Memory required: 128 * N * r = 128 * 32768 * 8 = 32MB per hash operation.
  // Offline brute force: ~10^9 guesses/sec GPU cluster → a 20-char random key takes decades.
  //
  // WHY NOT N=65536: Node.js scryptSync's default maxmem cap is 32MB. N=65536 requires
  // 64MB and throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS without an explicit maxmem override.
  // N=32768 exactly meets the OWASP minimum AND fits within Node's default limits when
  // SCRYPT_MAXMEM is set to 256MB (which we do explicitly in every scrypt call).
  SCRYPT_N:   32768,
  SCRYPT_R:   8,
  SCRYPT_P:   1,
  SCRYPT_KEYLEN: 64,     // 512-bit output
  SCRYPT_SALT_BYTES: 32, // 256-bit random salt
  // Explicit memory cap for scrypt. Prevents DoS via a crafted stored hash with huge N/r.
  // 256MB is generous for N=32768 (requires 32MB) while capping runaway parameters.
  SCRYPT_MAXMEM: 256 * 1024 * 1024, // 256MB

  // Minimum channel key length — enforced at set_key time.
  // 16 chars is the minimum for a key used with a proper KDF.
  MIN_CHANNEL_KEY_LENGTH: 16,

  // Broadcast rate limit — max broadcasts per agent per 60 seconds.
  // Prevents DoS via broadcast spam causing context window overflow.
  BROADCAST_RATE_LIMIT_PER_MINUTE: 10,

  // ── RBAC + Session Token (v0.8.0) ────────────────────────────────────────────
  // Token TTL: 24 hours. Short enough to limit blast radius, long enough for a full work session.
  // Chapter 6 (session tokens): short-lived tickets reduce exposure window.
  SESSION_TOKEN_TTL_SECONDS: 24 * 60 * 60,  // 24h

  // RBAC enforcement is opt-in: activates only when agent sessions are registered.
  // Keeps backward compatibility — existing setups without sessions work unchanged.
  // Chapter 14 RBAC: progressive security hardening without breaking changes.
  RBAC_ENABLED_ENV: env["ZC_RBAC_ENABLED"] === "1",  // force-enable even without sessions

  // L0/L1/L2 content tier lengths
  // Tiered loading reduces token consumption by returning only as much as needed
  TIER_L0_CHARS: 100,    // one-sentence summary
  TIER_L1_CHARS: 1500,   // planning-level overview

  // Hash chain enabled by default for all new broadcasts (Chapter 13 Biba integrity)
  // Set ZC_CHAIN_DISABLED=1 to disable (not recommended — disables tamper detection)
  CHAIN_ENABLED: env["ZC_CHAIN_DISABLED"] !== "1",
} as const;
