/**
 * Local embedding client for hybrid BM25+vector search.
 *
 * SECURITY DESIGN:
 * - Uses Ollama at hardcoded 127.0.0.1:11434 — NOT user-supplied, no SSRF risk
 * - Only sends text content to Ollama — no credentials, no code, no env vars
 * - Completely optional: gracefully returns null if Ollama is not running
 * - Vectors are float arrays — cannot contain injection payloads
 * - Inspired by: LlamaIndex semantic chunking + reranking approach
 *
 * Model: nomic-embed-text (768-dim, MIT license, runs fully offline via Ollama)
 * Install: ollama pull nomic-embed-text
 */

const OLLAMA_URL = "http://127.0.0.1:11434/api/embeddings";
const OLLAMA_MODEL = "nomic-embed-text";
const EMBED_TIMEOUT_MS = 5_000;
const MAX_EMBED_CHARS = 4_000; // truncate long text before embedding

// Module-level availability cache — avoid hammering Ollama on every call
let ollamaAvailable: boolean | null = null;
let lastAvailabilityCheck = 0;
const AVAILABILITY_TTL_MS = 60_000; // re-check every 60s

async function isOllamaAvailable(): Promise<boolean> {
  const now = Date.now();
  if (ollamaAvailable !== null && now - lastAvailabilityCheck < AVAILABILITY_TTL_MS) {
    return ollamaAvailable;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2_000);
    const resp = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    ollamaAvailable = resp.ok;
  } catch {
    ollamaAvailable = false;
  }
  lastAvailabilityCheck = now;
  return ollamaAvailable;
}

/**
 * Compute an embedding vector for the given text.
 * Returns null if Ollama is not available — caller falls back to BM25-only.
 */
export async function getEmbedding(text: string): Promise<Float32Array | null> {
  if (!(await isOllamaAvailable())) return null;

  const truncated = text.slice(0, MAX_EMBED_CHARS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

  try {
    const resp = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: truncated }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      ollamaAvailable = false; // mark unavailable on error
      return null;
    }

    const data = (await resp.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) return null;

    return new Float32Array(data.embedding);
  } catch {
    ollamaAvailable = false;
    return null;
  }
}

/**
 * Cosine similarity between two float vectors.
 * Returns 0 if either vector has zero magnitude (prevents division by zero).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
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
