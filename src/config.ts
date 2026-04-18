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
 *
 *   ── v0.10.0 Harness Engineering ──
 *   ZC_BASH_CAPTURE_LINES  — Line threshold above which bash output is auto-captured to KB (default: 50)
 *   ZC_BASH_TAIL_LINES     — Lines from end of output to include in the compact summary (default: 20)
 *   ZC_READ_DEDUP_ENABLED  — "0" to disable per-session Read dedup guard (default: enabled)
 *   ZC_INDEX_PROJECT_EXCLUDES — Comma-separated glob patterns excluded from zc_index_project
 *                               (default: node_modules,dist,build,.git,coverage,.worktrees)
 *   ZC_SUMMARY_ENABLED     — "0" to force deterministic truncation summaries (default: enabled if Ollama reachable)
 *   ZC_SUMMARY_MODEL       — Force a specific Ollama chat model (default: auto-probe coder preferred)
 *   ZC_SUMMARY_TIMEOUT_MS  — Per-file summarization timeout (default: 30000)
 *   ZC_SUMMARY_CONCURRENCY — Concurrent summarization requests during indexProject (default: 4)
 *   ZC_SUMMARY_KEEP_ALIVE  — Ollama keep_alive — how long to keep model in VRAM after last request
 *                            (default: "30s"; use "0" to unload immediately, "-1" to keep forever)
 *   ZC_SUMMARY_MODEL_ALLOWLIST — Comma-separated model name allowlist (default: empty = any installed model OK)
 */

import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;

export const Config = {
  // ── Version ──────────────────────────────────────────────────────────────
  VERSION: "0.10.5",

  // ── Storage paths ────────────────────────────────────────────────────────
  DB_DIR:      join(homedir(), ".claude", "zc-ctx", "sessions"),
  GLOBAL_DIR:  join(homedir(), ".claude", "zc-ctx"),
  GLOBAL_DB:   join(homedir(), ".claude", "zc-ctx", "global.db"),  // cross-project rate limits

  // ── Working memory ────────────────────────────────────────────────────────
  WORKING_MEMORY_MAX:      100,  // evict when this count is exceeded
  WORKING_MEMORY_EVICT_TO: 80,   // target count after eviction batch (80% of MAX)

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

  // ── RBAC + Session Token (v0.9.0) ────────────────────────────────────────────
  // Token TTL: 24 hours. Short enough to limit blast radius, long enough for a full work session.
  // Chapter 6 (session tokens): short-lived tickets reduce exposure window.
  SESSION_TOKEN_TTL_SECONDS: 24 * 60 * 60,  // 24h

  // RBAC enforcement — DEFAULT ON in v0.9.0 (BREAKING CHANGE from v0.8.0).
  // Every zc_broadcast now requires a valid session_token bound to an agent_id + role.
  // Opt-out: set ZC_RBAC_ENFORCE=0 to restore pre-v0.9.0 advisory behaviour.
  // Chapter 14 RBAC: enforcement at the reference monitor, not advisory.
  // See CHANGELOG.md v0.9.0 and README "Migration to v0.9.0" for upgrade steps.
  RBAC_ENFORCE: env["ZC_RBAC_ENFORCE"] !== "0",

  // Channel key enforcement — DEFAULT ON in v0.9.0 (BREAKING CHANGE from v0.8.0).
  // verifyChannelKey() used to return true when no key was registered ("open mode").
  // In v0.9.0 an unregistered project rejects broadcasts until the operator calls
  // zc_broadcast(type='set_key', channel_key=...) or sets ZC_CHANNEL_KEY_REQUIRED=0.
  // Chapter 11 (capabilities): a project is not writable without a capability.
  CHANNEL_KEY_REQUIRED: env["ZC_CHANNEL_KEY_REQUIRED"] !== "0",

  // L0/L1/L2 content tier lengths
  // Tiered loading reduces token consumption by returning only as much as needed
  TIER_L0_CHARS: 100,    // one-sentence summary
  TIER_L1_CHARS: 1500,   // planning-level overview

  // Hash chain enabled by default for all new broadcasts (Chapter 13 Biba integrity)
  // Set ZC_CHAIN_DISABLED=1 to disable (not recommended — disables tamper detection)
  CHAIN_ENABLED: env["ZC_CHAIN_DISABLED"] !== "1",

  // ── v0.10.0 Harness Engineering ──────────────────────────────────────────
  // Bash output auto-capture threshold. When a bash tool output exceeds this
  // line count, the PostToolUse hook pushes the full output into KB and
  // replaces it in agent context with a compact summary.
  // Empirically, 50 lines ≈ 400 tokens — above that, savings compound fast.
  BASH_CAPTURE_LINES: parseInt(env["ZC_BASH_CAPTURE_LINES"] ?? "50", 10),

  // Lines preserved in the compact summary (head + tail slice).
  // 20 tail lines = ~160 tokens, enough for an error message + stack trace.
  BASH_TAIL_LINES:   parseInt(env["ZC_BASH_TAIL_LINES"] ?? "20", 10),

  // Per-session Read dedup. Blocks re-Read of a path already Read this session
  // unless the agent just wrote to it (or passes force=true).
  READ_DEDUP_ENABLED: env["ZC_READ_DEDUP_ENABLED"] !== "0",

  // Default exclusions for zc_index_project walker. Comma-separated glob-like
  // path prefixes. Override with ZC_INDEX_PROJECT_EXCLUDES.
  INDEX_PROJECT_EXCLUDES: (env["ZC_INDEX_PROJECT_EXCLUDES"] ??
    // Build/cache artefacts
    "node_modules,dist,build,coverage,.next,.cache,out,target,vendor," +
    // Version control
    ".git,.hg,.svn,.worktrees," +
    // Per-editor / per-agent scratch — not real source
    ".claude,.cursor,.idea,.vscode,.agent-prompts,.gstack," +
    // Virtual environments
    ".venv,venv,__pycache__," +
    // Logs
    "logs,tmp").split(","),

  // Max file size (bytes) the project indexer will read. Skips binaries/lockfiles.
  INDEX_MAX_FILE_BYTES: 256 * 1024,  // 256 KB

  // Source-code extensions the project indexer will summarize.
  INDEX_FILE_EXTENSIONS: [
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".rs", ".go", ".java", ".kt", ".scala",
    ".rb", ".php", ".cs", ".cpp", ".c", ".h", ".hpp",
    ".sh", ".ps1", ".psm1",
    ".md", ".mdx", ".txt",
    ".json", ".yaml", ".yml", ".toml",
    ".sql", ".graphql", ".proto",
  ],

  // ── Semantic Summaries (Ollama chat) ─────────────────────────────────────
  // When enabled, indexProject uses a local Ollama chat model (code-specialized
  // preferred) to generate L0/L1 summaries instead of first-N-char truncation.
  // Falls back to truncation if Ollama is unreachable or no suitable model
  // is installed. See src/summarizer.ts PREFERRED_MODELS for the probe order.
  SUMMARY_ENABLED:        env["ZC_SUMMARY_ENABLED"] !== "0",

  // User override — if set, bypass the auto-probe and use this model exclusively.
  // Empty string means "use auto-probe".
  SUMMARY_MODEL_OVERRIDE: env["ZC_SUMMARY_MODEL"] ?? "",

  // Per-file timeout. 30s comfortably fits a 7B coder model on CPU;
  // raise if using a 32B model or if you see frequent timeouts.
  SUMMARY_TIMEOUT_MS:     parseInt(env["ZC_SUMMARY_TIMEOUT_MS"] ?? "30000", 10),

  // Max file chars sent to the model. Larger files are truncated for
  // summarization only (the full file remains in KB FTS). 8000 chars
  // ≈ 2000 tokens — safe for any 4k-context model.
  SUMMARY_MAX_INPUT_CHARS: parseInt(env["ZC_SUMMARY_MAX_INPUT_CHARS"] ?? "8000", 10),

  // Concurrent summarization requests during indexProject. 4 is comfortable
  // for a 14B coder on 16GB+ VRAM (RTX 4070/4080/4090/5090 all handle it).
  // Drop to 2 for 8GB cards, or raise to 6-8 on a dedicated inference box.
  SUMMARY_CONCURRENCY:     parseInt(env["ZC_SUMMARY_CONCURRENCY"] ?? "4", 10),

  // VRAM lifecycle: how long Ollama keeps the model loaded after the last
  // request. "30s" = model warms up on first index call, stays hot through
  // the batch (each request resets the timer), unloads shortly after the
  // batch finishes. Set "0" to unload immediately, "-1" to keep forever.
  SUMMARY_KEEP_ALIVE:      env["ZC_SUMMARY_KEEP_ALIVE"] ?? "30s",

  // Optional allowlist. When set, ONLY these model names are acceptable —
  // blocks misconfigured ZC_SUMMARY_MODEL or a malicious override from
  // pointing the summarizer at an untrusted model.
  SUMMARY_MODEL_ALLOWLIST: ((env["ZC_SUMMARY_MODEL_ALLOWLIST"] ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean)) as string[],
} as const;
