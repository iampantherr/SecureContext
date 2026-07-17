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
  VERSION: "0.46.0",

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

  // ── Knowledge-graph backlink ranking (Tier-1 A) ──────────────────────────
  // Additive, log-damped boost on the hybrid search score for highly-referenced
  // "hub" sources (in-degree from kb_backlinks). W_BACKLINK=0 ⇒ ranking is
  // byte-identical to pre-backlink behaviour (rollback / A-B kill-switch).
  // Default 0.08 keeps it a tiebreaker, never an override of BM25+cosine.
  W_BACKLINK:        parseFloat(env["ZC_W_BACKLINK"] ?? "0.08"),
  BACKLINK_LOG_BASE: parseInt(env["ZC_BACKLINK_LOG_BASE"] ?? "10", 10),

  // ── Retrieval fusion (Tier-2 #3) ─────────────────────────────────────────
  // How the BM25 + vector (+ backlink) candidate lists are combined.
  //   "weighted" — historical weighted-sum (W_BM25·bm25 + W_COSINE·cosine) plus the
  //                additive log-damped backlink boost. Byte-identical to v0.31.0.
  //   "rrf"      — Reciprocal Rank Fusion over per-list RANK positions
  //                (Σ w/(K+rank)); rank-based, scale-free, robust to score skew.
  // Default "rrf" (v0.31.x): A/B on a hub-recall corpus showed RRF surfaces the
  // heavily-referenced real answer above a keyword-stuffed decoy where weighted-sum
  // fails. Set ZC_RETRIEVAL_FUSION=weighted to roll back. Backlink folds in as a third
  // RRF list (kept off when W_BACKLINK=0, so that flag remains the backlink kill-switch).
  RETRIEVAL_FUSION:  (env["ZC_RETRIEVAL_FUSION"] ?? "rrf") as "weighted" | "rrf",
  RRF_K:             parseInt(env["ZC_RRF_K"] ?? "60", 10),
  RRF_W_BM25:        parseFloat(env["ZC_RRF_W_BM25"] ?? "1.0"),
  RRF_W_VEC:         parseFloat(env["ZC_RRF_W_VEC"] ?? "1.0"),
  RRF_W_BACKLINK:    parseFloat(env["ZC_RRF_W_BACKLINK"] ?? "0.25"),
  // v0.37.0 — 4th RRF list: 1-hop kb_edges neighbors of the top candidates (graph
  // retrieval channel — surfaces call-sites/linked memory a keyword match can't reach).
  // RRF_W_GRAPH=0 disables the channel entirely (kill-switch; ranking identical to v0.36).
  RRF_W_GRAPH:       parseFloat(env["ZC_RRF_W_GRAPH"] ?? "0.5"),
  GRAPH_EXPAND_TOP_K: parseInt(env["ZC_GRAPH_EXPAND_TOP_K"] ?? "5", 10),
  GRAPH_EXPAND_MAX:   parseInt(env["ZC_GRAPH_EXPAND_MAX"] ?? "20", 10),
  // M4 (v0.41.0) — bounded multi-hop BFS: the graph channel now walks up to
  // GRAPH_MAX_DEPTH hops from the top candidates (Graphiti-parity bfs_max_depth),
  // with per-hop weight decay so distant neighbors rank below direct ones.
  // =1 restores the previous single-hop behaviour exactly.
  GRAPH_MAX_DEPTH:    parseInt(env["ZC_GRAPH_MAX_DEPTH"] ?? "2", 10),
  GRAPH_HOP_DECAY:    parseFloat(env["ZC_GRAPH_HOP_DECAY"] ?? "0.5"),

  // ── M1 (v0.41.0) — retrieval candidate generation + focused recall ────────
  // The M0 benchmark exposed a hard gate: BM25 was the ONLY candidate source, and
  // plainto_tsquery/FTS5 AND-semantics meant one non-matching word in a natural-
  // language question returned ZERO results (embeddings never consulted).
  // VECTOR_CANDIDATES makes the vector index an INDEPENDENT candidate channel
  // (top-N nearest neighbors join the pool even with zero keyword overlap);
  // BM25_OR_FALLBACK adds an any-term keyword pass when the AND pass under-fills.
  // Kill-switches: ZC_VECTOR_CANDIDATES=0 / ZC_BM25_OR_FALLBACK=0 restore the
  // legacy BM25-gated behaviour byte-for-byte.
  VECTOR_CANDIDATES:  parseInt(env["ZC_VECTOR_CANDIDATES"] ?? "20", 10),
  // Similarity floor for vector-injected candidates: below this, a "nearest"
  // neighbor is just the least-unrelated garbage — injecting it pollutes
  // results for no-answer queries and breaks abstention behaviour.
  // Calibrated for nomic-embed-text (compressed similarity range): unrelated
  // content measures ~0.41-0.49, true matches ~0.75. 0.55 splits with margin.
  VECTOR_MIN_SIM:     parseFloat(env["ZC_VECTOR_MIN_SIM"] ?? "0.55"),
  BM25_OR_FALLBACK:   env["ZC_BM25_OR_FALLBACK"] !== "0",
  // Focused working-memory recall: when zc_recall_context is given a `focus`
  // string, live facts are re-ranked by blended relevance instead of raw
  // importance. Without focus the ordering is unchanged (backward-compatible).
  RECALL_W_REL:       parseFloat(env["ZC_RECALL_W_REL"] ?? "0.60"),
  RECALL_W_IMP:       parseFloat(env["ZC_RECALL_W_IMP"] ?? "0.25"),
  RECALL_W_SAL:       parseFloat(env["ZC_RECALL_W_SAL"] ?? "0.15"),
  // M3 (v0.41.0) — additive bonus for facts whose event-time (valid_at, falling
  // back to created_at) lies inside a temporal window parsed from the query
  // ("last week", "about six weeks ago"). Strong enough to outrank pure
  // relevance ties; facts outside the window still appear below.
  RECALL_W_TEMPORAL:  parseFloat(env["ZC_RECALL_W_TEMPORAL"] ?? "0.60"),
  // R3 (v0.42.0) — the window bonus only applies to facts at least somewhat ON-TOPIC
  // (relevance >= gate). Without this, high-importance noise that merely falls inside
  // the window ("worklog from 3 days ago") jumps above the topical answer.
  // Default 0 (flat bonus): measured on the labeled corpus, gating LOST to flat
  // (gold/noise relevance ranges overlap; the gate clipped real answers).
  RECALL_TEMPORAL_REL_GATE: parseFloat(env["ZC_RECALL_TEMPORAL_REL_GATE"] ?? "0"),

  // ── R8 (v0.43.0) — recall output budget + staleness demotion ─────────────
  // Measured failure: a mature project accumulated 237 live facts (87% marked
  // importance-5) and zc_recall_context rendered ~47k TOKENS — agents responded
  // by spawning subagents to "digest" the recall, which is slower, lossier, and
  // costs more than it saves. The budget makes recall a DIGEST again: top-ranked
  // facts render in full up to RECALL_MAX_CHARS; the tail collapses into a
  // grouped one-line index (counts by key prefix) that stays retrievable via
  // focus/zc_search. Facts inside a parsed temporal window get absolute priority
  // and any in-window overflow is reported explicitly (never silently truncated).
  // Kill-switch: ZC_RECALL_MAX_CHARS=0 renders everything (pre-R8 behaviour).
  RECALL_MAX_CHARS:   parseInt(env["ZC_RECALL_MAX_CHARS"] ?? "16000", 10),
  // Floor: always render at least this many facts even under a tiny budget, so
  // a misconfigured budget can never blank the recall entirely.
  RECALL_MIN_FACTS:   parseInt(env["ZC_RECALL_MIN_FACTS"] ?? "10", 10),
  // Staleness demotion (classic/unfocused ordering only): a fact not retrieved
  // (nor created) within STALE_DAYS sorts as importance - STALE_DEMOTE, so a
  // stale ★5 ranks below a fresh ★3+ and falls past the budget into the
  // collapsed tail. Counters importance inflation (87% ★5 on the live project)
  // without ever mutating the stored importance. ZC_RECALL_STALE_DEMOTE=0 ⇒
  // ordering byte-identical (the kill-switch).
  RECALL_STALE_DAYS:   parseInt(env["ZC_RECALL_STALE_DAYS"] ?? "30", 10),
  RECALL_STALE_DEMOTE: parseFloat(env["ZC_RECALL_STALE_DEMOTE"] ?? "2"),
  // Soft quota for importance-5 facts per namespace: zc_remember warns (never
  // blocks) beyond this count. "When everything is critical, nothing is."
  IMP5_SOFT_CAP:       parseInt(env["ZC_IMP5_SOFT_CAP"] ?? "25", 10),

  // ── S1 (v0.44.0) — temporal fact supersession (Zep/Graphiti parity) ───────
  // Measured failure (bench KU): when a fact is updated under a new key and the
  // old one is never retired, the OLD fact outranked its update 100% of the time
  // (higher importance, similar relevance). Two layers:
  //   PREFER_LATEST — at focused-recall time, a near-identical conflicting pair
  //   (sim ≥ NUMERIC_CONFLICT_SIM + conflict signal) among the top candidates
  //   demotes the OLDER fact to just below the newer one. Ranking-only, data
  //   untouched, and SKIPPED whenever the query targets the past (temporal
  //   window / as-of) — historical questions must still surface the old fact.
  //   AUTO_RESOLVE_NUMERIC — the contradiction scan may auto-retire the older
  //   side of a numeric_conflict when the NEWER value carries explicit update
  //   language ("now", "changed to", "migrated to"...). Revivable retire +
  //   dashboard Undo, same safety net as existing auto-resolution.
  PREFER_LATEST:        env["ZC_PREFER_LATEST"] !== "0",
  PREFER_LATEST_MARGIN: parseFloat(env["ZC_PREFER_LATEST_MARGIN"] ?? "0.05"),
  PREFER_LATEST_TOPK:   parseInt(env["ZC_PREFER_LATEST_TOPK"] ?? "12", 10),

  // ── Self-correcting memory v2 (v0.37.0) ──────────────────────────────────
  // Temporal fact retirement + contradiction auto-resolution. When the scan flags a
  // pair where one fact CLEARLY supersedes the other (strictly newer + carries an
  // action-reversal verb the older lacks), the older fact is retired (valid_to set,
  // archived to the KB, dropped from recall) automatically — with a dashboard Undo.
  // Ambiguous pairs still go to operator triage. AUTO_RESOLVE=0 ⇒ flag-only (v0.36 behaviour).
  AUTO_RESOLVE:        (env["ZC_AUTO_RESOLVE"] ?? "1") !== "0",
  RETIRE_PURGE_DAYS:   parseInt(env["ZC_RETIRE_PURGE_DAYS"] ?? "30", 10),
  CONTRA_PRUNE_DAYS:   parseInt(env["ZC_CONTRA_PRUNE_DAYS"] ?? "30", 10),

  // ── Recency-decay / salience (Tier-2 #4) ─────────────────────────────────
  // Secondary recall signal: how recently + how often a fact was retrieved. Folded
  // in AFTER importance, which stays the PRIMARY axis. W_SALIENCE=0 ⇒ recall ordering
  // is byte-identical (importance DESC, created_at DESC) — the kill-switch. Decay is an
  // exponential half-life (hours) on time since last retrieval; access adds a log-damped
  // frequency bonus. Default keeps it a tiebreaker, never an override of importance.
  W_SALIENCE:          parseFloat(env["ZC_W_SALIENCE"] ?? "0.15"),
  SALIENCE_HALFLIFE_H: parseFloat(env["ZC_SALIENCE_HALFLIFE_H"] ?? "168"), // 1 week
  W_SALIENCE_ACCESS:   parseFloat(env["ZC_W_SALIENCE_ACCESS"] ?? "0.5"),

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
  // S9 (v0.46.0): was a fixed 5s — on CPU-only Ollama a concurrent chat-model
  // generation (summarizer/entity qwen) makes nomic embeds exceed 5s routinely,
  // and every embed silently failed ("breaker open") while /health said OK.
  EMBED_TIMEOUT_MS:  parseInt(env["ZC_EMBED_TIMEOUT_MS"] ?? "20000", 10),
  EMBED_MAX_CHARS:   4_000,
  // S9 (v0.46.0) — CHUNKED embeddings for long KB content. EMBED_MAX_CHARS means a
  // 45k-char doc/session used to embed only its FIRST 4k chars — the vector channel
  // was blind to answers deeper in (measured on LongMemEval: preference/temporal
  // recall 20-47% while short-content categories scored fine). Content longer than
  // EMBED_CHUNK_SIZE also stores per-chunk vectors (`<source>#c<N>`, capped at
  // EMBED_MAX_CHUNKS); search MAX-POOLS similarity over a source's chunks.
  // Kill switch: ZC_EMBED_CHUNKS=0 (head-only embedding, exact prior behavior).
  EMBED_CHUNKS:      env["ZC_EMBED_CHUNKS"] !== "0",
  EMBED_CHUNK_SIZE:  parseInt(env["ZC_EMBED_CHUNK_SIZE"] ?? "3500", 10),
  EMBED_MAX_CHUNKS:  parseInt(env["ZC_EMBED_MAX_CHUNKS"] ?? "12", 10),
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
  // v0.23.3: bumped 30s → 120s. The 14B coder model takes ~80s to cold-load
  // from disk into VRAM (model file is 9GB). Any agent task that runs after
  // Ollama has unloaded the model hits a cold load, blowing the old 30s
  // budget and falling back to truncation. 120s comfortably absorbs cold
  // load + normal inference. Override via ZC_SUMMARY_TIMEOUT_MS for slower
  // hardware (CPU-only / older GPUs).
  SUMMARY_TIMEOUT_MS:     parseInt(env["ZC_SUMMARY_TIMEOUT_MS"] ?? "120000", 10),

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
  // v0.23.3: bumped 30s → 30m. Keep the coder model loaded in VRAM across
  // agent sessions so back-to-back zc_file_summary calls don't each pay
  // the 80s cold-load tax. Burn ~9GB VRAM continuously in exchange for
  // sub-second hot-call latency. Override via ZC_SUMMARY_KEEP_ALIVE on
  // VRAM-constrained hosts.
  SUMMARY_KEEP_ALIVE:      env["ZC_SUMMARY_KEEP_ALIVE"] ?? "30m",

  // Optional allowlist. When set, ONLY these model names are acceptable —
  // blocks misconfigured ZC_SUMMARY_MODEL or a malicious override from
  // pointing the summarizer at an untrusted model.
  SUMMARY_MODEL_ALLOWLIST: ((env["ZC_SUMMARY_MODEL_ALLOWLIST"] ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean)) as string[],
} as const;
