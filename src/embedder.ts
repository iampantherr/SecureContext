/**
 * Local embedding client for hybrid BM25+vector search.
 *
 * SECURITY DESIGN:
 * - Uses Ollama at hardcoded 127.0.0.1:11434 — NOT user-supplied, no SSRF risk
 * - Only sends text content to Ollama — no credentials, no code, no env vars
 * - Completely optional: gracefully returns null if Ollama is not running
 * - Vectors are float arrays — cannot contain injection payloads
 *
 * MODEL VERSION TRACKING:
 * - Returns model name and dimensions alongside the vector
 * - knowledge.ts stores model_name in embeddings table
 * - On model change, stale embeddings are excluded from cosine reranking
 * - Switch models with: ZC_OLLAMA_MODEL=mxbai-embed-large
 *
 * Supported models (via Ollama):
 *   nomic-embed-text    (768d, MIT license, default)
 *   mxbai-embed-large   (1024d, Apache 2.0)
 *   all-minilm          (384d, Apache 2.0, fastest)
 */

import { Config } from "./config.js";

/** The currently active model name — exported so knowledge.ts can filter stale vectors */
export const ACTIVE_MODEL = Config.OLLAMA_MODEL;

export interface EmbeddingResult {
  vector:    Float32Array;
  modelName: string;
  dimensions: number;
}

// Module-level availability cache — avoid hammering Ollama on every call
let ollamaAvailable: boolean | null = null;
let lastAvailabilityCheck = 0;
// M1 hardening (v0.41.0): one transient embed failure used to flip the cache to
// "down" for a full EMBED_AVAIL_TTL, silently disabling EVERY semantic feature
// (vector search, focused recall, contradiction scan) for 60s — found when a
// benchmark's rapid-fire calls degraded mid-run. Now: only a STREAK of failures
// flips the flag, and a cached "down" is re-probed quickly (DOWN_RETRY_MS)
// instead of waiting out the full up-state TTL.
let embedFailureStreak = 0;
const EMBED_FAILURE_STREAK_LIMIT = 2;
const DOWN_RETRY_MS = 5_000;

// Resolved embedding URL — may differ from Config.OLLAMA_URL if Docker fallback is used
let resolvedOllamaUrl: string = Config.OLLAMA_URL;

/**
 * Candidate Ollama embedding URLs tried in order on first availability check.
 * Covers: native install, plugin outside Docker with Ollama in Docker (host.docker.internal),
 * and Docker default bridge gateway fallback.
 */
function ollamaFallbackUrls(): string[] {
  const primary = Config.OLLAMA_URL;
  const base = primary.replace(/\/api\/embeddings$/, "");
  const urls = [primary];
  // Only add Docker fallbacks if the primary points to localhost/127.0.0.1
  if (/127\.0\.0\.1|localhost/.test(base)) {
    urls.push("http://host.docker.internal:11434/api/embeddings");
    urls.push("http://172.17.0.1:11434/api/embeddings");
  }
  return urls;
}

async function isOllamaAvailable(): Promise<boolean> {
  const now = Date.now();
  // "Up" is trusted for the full TTL; "down" is re-probed quickly so a transient
  // blip doesn't blind semantic features for a whole minute.
  const cacheTtl = ollamaAvailable === false ? DOWN_RETRY_MS : Config.EMBED_AVAIL_TTL;
  if (ollamaAvailable !== null && now - lastAvailabilityCheck < cacheTtl) {
    return ollamaAvailable;
  }

  // On first check (or after TTL), probe primary URL then Docker fallbacks
  const candidates = ollamaFallbackUrls();
  for (const url of candidates) {
    try {
      const tagsUrl = url.replace(/\/api\/embeddings$/, "/api/tags");
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2_000);
      const resp  = await fetch(tagsUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        if (url !== Config.OLLAMA_URL) {
          console.error(`[zc-ctx] Ollama not at primary URL — using fallback: ${url}`);
        }
        resolvedOllamaUrl = url;
        ollamaAvailable = true;
        lastAvailabilityCheck = now;
        return true;
      }
    } catch {
      // try next candidate
    }
  }

  ollamaAvailable = false;
  lastAvailabilityCheck = now;
  return false;
}

/**
 * Returns whether Ollama is currently reachable.
 * Uses the same module-level TTL cache as getEmbedding — no extra network call
 * if a check has been made recently.
 * Exported so zc_status and zc_recall_context can surface a clear user warning.
 */
export async function checkOllamaAvailable(): Promise<{ available: boolean; url: string }> {
  const available = await isOllamaAvailable();
  return { available, url: resolvedOllamaUrl };
}

/**
 * Compute an embedding vector for the given text.
 * Returns null if Ollama is not available — caller falls back to BM25-only.
 * Returns EmbeddingResult with model metadata for version-tracking.
 */
export async function getEmbedding(text: string): Promise<EmbeddingResult | null> {
  if (!(await isOllamaAvailable())) return null;

  const attempt = async (input: string): Promise<EmbeddingResult | null | "retryable" | "too_long"> => {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), Config.EMBED_TIMEOUT_MS);
    try {
      const resp = await fetch(resolvedOllamaUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ model: Config.OLLAMA_MODEL, prompt: input }),
        signal:  controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        // v0.46.1 — token-dense content (code, CJK) can exceed the model context
        // at char counts well below EMBED_MAX_CHARS; Ollama 500s with a specific
        // message. That's a CONTENT error, not an availability error — it must
        // not count toward the failure streak, and it's fixable by shortening.
        let msg = "";
        try { msg = ((await resp.json()) as { error?: string }).error ?? ""; } catch { /* non-JSON body */ }
        return /context length/i.test(msg) ? "too_long" : "retryable";
      }
      const data = (await resp.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) return null;
      const vector = new Float32Array(data.embedding);
      embedFailureStreak = 0; // success heals the streak
      return { vector, modelName: Config.OLLAMA_MODEL, dimensions: vector.length };
    } catch {
      clearTimeout(timer);
      return "retryable"; // timeout/abort/network — worth one retry
    }
  };

  let input = text.slice(0, Config.EMBED_MAX_CHARS);
  let result = await attempt(input);
  // Halve-and-retry for over-long content (chars are a poor proxy for tokens —
  // 3.4k chars of ShareGPT dialogue overflowed an 8k-token context in the wild).
  for (let halvings = 0; result === "too_long" && halvings < 3 && input.length > 400; halvings++) {
    input = input.slice(0, Math.floor(input.length / 2));
    result = await attempt(input);
  }
  if (result === "too_long") return null; // still too dense at 1/8 length — give up on this content
  if (result === "retryable") {
    // M1 hardening: absorb a single transient blip (saturation, GC pause) with
    // one short-backoff retry instead of instantly poisoning the availability cache.
    await new Promise((r) => setTimeout(r, 300));
    result = await attempt(input);
  }
  if (result === "retryable") {
    embedFailureStreak++;
    if (embedFailureStreak >= EMBED_FAILURE_STREAK_LIMIT) {
      ollamaAvailable = false;          // re-probed after DOWN_RETRY_MS, not the full TTL
      lastAvailabilityCheck = Date.now();
    }
    return null;
  }
  return result === "too_long" ? null : result;
}

/**
 * S1 (v0.44.0) — BACKGROUND embedding lane: one global serialized queue with
 * per-item retry, for every non-interactive caller (contradiction scans,
 * embedding backfills, write-time fact embeds, re-embeds).
 *
 * Why: each agent recall kicks a background scan that embeds up to
 * MAX_SCAN_FACTS facts. Four agents booting concurrently stampeded Ollama with
 * ~320 parallel embed calls, tripped the failure breaker, and EVERY semantic
 * feature silently degraded for the whole burst (measured live: both terminal
 * E2E agents reported "embeddings unavailable" while Ollama itself was fine).
 * Interactive callers (recall focus, search queries) keep calling getEmbedding
 * directly — they must never wait behind a 300-item background drain.
 */
let _bgChain: Promise<void> = Promise.resolve();
let _bgDepth = 0;
export function getEmbeddingQueued(text: string): Promise<EmbeddingResult | null> {
  if (_bgDepth > 2000) return Promise.resolve(null); // runaway guard
  _bgDepth++;
  const run = async (): Promise<EmbeddingResult | null> => {
    for (let i = 0; i < 3; i++) {
      const r = await getEmbedding(text);
      if (r) return r;
      // Breaker may be open — back off past its DOWN_RETRY_MS reprobe window.
      await new Promise((res) => setTimeout(res, 2_000 * (i + 1)));
    }
    return null;
  };
  const result = _bgChain.then(run);
  _bgChain = result
    .then(() => new Promise<void>((res) => setTimeout(res, 100))) // gentle pacing
    .catch(() => undefined)
    .finally(() => { _bgDepth--; });
  return result;
}

/**
 * Cosine similarity between two float vectors.
 * Returns 0 if lengths differ or either vector has zero magnitude.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Serialize Float32Array to Buffer for SQLite BLOB storage */
export function serializeVector(v: Float32Array): Buffer {
  return Buffer.from(v.buffer);
}

/** Deserialize Buffer from SQLite BLOB back to Float32Array */
export function deserializeVector(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
