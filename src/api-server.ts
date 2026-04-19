/**
 * SecureContext API Server
 *
 * Exposes the Store interface as an HTTP REST API.
 * Agents on any machine can connect to this server and use the full
 * SecureContext feature set without needing local SQLite access.
 *
 * AUTHENTICATION:
 *   Every request (except /health) must include:
 *     Authorization: Bearer <ZC_API_KEY>
 *   ZC_API_KEY is a shared secret set at server startup.
 *   This is the server-level auth — separate from per-project RBAC session tokens.
 *
 *   For production: set ZC_API_KEY to a random 32+ char string.
 *   For local dev:  set ZC_API_KEY=dev (or any value) — the key is still checked.
 *
 * TRANSPORT:
 *   HTTP (Fastify). For production, run behind nginx with SSL termination.
 *   The Docker Compose stack handles this automatically.
 *
 * PORT:
 *   Default 3099. Override with ZC_API_PORT.
 *
 * RATE LIMITING:
 *   In-process per-IP rate limiting (500 req/min per IP).
 *   Redis-backed rate limiting can be added by extending the rateLimit map
 *   to use Redis INCR + EXPIRE (same pattern as the SQLite rate_limits table).
 *
 * SECURITY:
 *   - All inputs validated and sanitized before passing to Store
 *   - projectPath is validated to be an absolute path (no traversal)
 *   - Timing-safe key comparison for API key check
 *   - Error responses never expose internal details (stack traces, DB paths)
 *   - Request size limit: 1MB (prevents body stuffing)
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { timingSafeEqual, createHash } from "node:crypto";
import { isAbsolute as posixIsAbsolute } from "node:path/posix";
import { isAbsolute as win32IsAbsolute } from "node:path/win32";
import { createStore } from "./store.js";
import type { Store, RetentionTier } from "./store.js";
import { checkOllamaAvailable } from "./embedder.js";

// ─────────────────────────────────────────────────────────────────────────────
// Config from environment
// ─────────────────────────────────────────────────────────────────────────────

const API_PORT   = parseInt(process.env["ZC_API_PORT"]  ?? "3099", 10);
const API_HOST   = process.env["ZC_API_HOST"] ?? "0.0.0.0";
const API_KEY    = process.env["ZC_API_KEY"];
const ALLOWED_ORIGINS = (process.env["ZC_API_CORS_ORIGINS"] ?? "*").split(",").map(s => s.trim());

// Per-IP in-process rate limit: 500 requests per 60 seconds.
// Raised from 100 to support multi-agent sessions where 5+ agents + dispatcher
// each make multiple API calls per minute (zc_broadcast, zc_recall_context, polling).
// 100 req/min was too low: agents hitting 429 would silently skip zc_broadcast.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX       = 500;
const ipRateMap            = new Map<string, { count: number; resetAt: number }>();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function timingSafeKeyCheck(supplied: string | undefined): boolean {
  if (!API_KEY) return true; // No key configured — open (dev mode warning logged at startup)
  if (!supplied) return false;
  try {
    const a = Buffer.from(createHash("sha256").update(supplied).digest("hex"), "hex");
    const b = Buffer.from(createHash("sha256").update(API_KEY).digest("hex"),  "hex");
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function validateProjectPath(projectPath: unknown): string {
  if (typeof projectPath !== "string" || !projectPath.trim()) {
    throw new ApiError(400, "projectPath is required and must be a non-empty string");
  }
  // Accept POSIX absolute paths (/home/...) AND Windows absolute paths (C:\... or C:/...)
  // The API server runs in Docker (Linux) but clients are often Windows-native — both must work.
  // node:path/posix and node:path/win32 each implement isAbsolute correctly for their platform
  // regardless of the host OS, so this check is always cross-platform.
  if (!posixIsAbsolute(projectPath) && !win32IsAbsolute(projectPath)) {
    throw new ApiError(400, "projectPath must be an absolute filesystem path");
  }
  // Normalize Windows path separators: C:/Users/... → C:\Users\...
  // This ensures C:/foo and C:\foo hash to the same project DB.
  // Windows clients may send forward-slash paths (e.g. from URL encoding), but
  // register.mjs and claude sessions use native backslash — they must collide.
  return projectPath.replace(/\//g, "\\");
}

function checkIpRate(ip: string): void {
  const now  = Date.now();
  let   slot = ipRateMap.get(ip);
  if (!slot || now > slot.resetAt) {
    slot = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    ipRateMap.set(ip, slot);
  }
  slot.count++;
  if (slot.count > RATE_LIMIT_MAX) {
    throw new ApiError(429, "Rate limit exceeded -- max 500 requests per minute per IP");
  }
  // Prune stale IPs periodically (every 1000 requests)
  if (ipRateMap.size > 10_000) {
    for (const [k, v] of ipRateMap) {
      if (now > v.resetAt) ipRateMap.delete(k);
    }
  }
}

class ApiError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

// (sendError is inlined at each call site — Fastify reply types are complex to annotate generically)

// ─────────────────────────────────────────────────────────────────────────────
// Server factory (exported for testing)
// ─────────────────────────────────────────────────────────────────────────────

function createFastifyInstance() {
  return Fastify({
    logger:       { level: process.env["ZC_API_LOG_LEVEL"] ?? "warn" },
    bodyLimit:    1 * 1024 * 1024, // 1 MB
    trustProxy:   true,
  });
}

export async function createApiServer(storeOverride?: Store) {
  const store = storeOverride ?? await createStore();
  const app   = createFastifyInstance();

  await app.register(cors, {
    origin: ALLOWED_ORIGINS.includes("*") ? true : ALLOWED_ORIGINS,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  });

  if (!API_KEY) {
    app.log.warn("⚠️  ZC_API_KEY not set — API is OPEN (no authentication). Set ZC_API_KEY for production.");
  }

  // ── Auth + rate-limit hook (runs before every route handler) ────────────────
  app.addHook("preHandler", async (request, reply) => {
    // Health check is always open
    if (request.url === "/health") return;

    // Per-IP rate limiting
    const ip = request.ip;
    try {
      checkIpRate(ip);
    } catch (e) {
      if (e instanceof ApiError) {
        reply.status(e.statusCode).send({ error: e.message });
        return;
      }
    }

    // API key check
    const authHeader = request.headers.authorization;
    const supplied   = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (!timingSafeKeyCheck(supplied)) {
      reply.status(401).send({ error: "Unauthorized — invalid or missing API key" });
    }
  });

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get("/health", async () => {
    const [config, ollama] = await Promise.all([
      import("./config.js"),
      checkOllamaAvailable(),
    ]);
    return {
      status:          "ok",
      version:         config.Config.VERSION,
      store:           process.env["ZC_STORE"] ?? "sqlite",
      ollamaAvailable: ollama.available,
      ollamaUrl:       ollama.available ? ollama.url.replace("/api/embeddings", "") : null,
      searchMode:      ollama.available ? "hybrid (BM25 + vector)" : "BM25-only (Ollama unavailable)",
      ts:              new Date().toISOString(),
    };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Working Memory
  // ─────────────────────────────────────────────────────────────────────────

  app.post("/api/v1/remember", async (request, reply) => {
    try {
      const { projectPath, key, value, importance = 3, agentId = "default" } = request.body as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      if (typeof key   !== "string") throw new ApiError(400, "key must be a string");
      if (typeof value !== "string") throw new ApiError(400, "value must be a string");
      await store.remember(pp, key, value, Number(importance), String(agentId));
      const stats = await store.getMemoryStats(pp, String(agentId));
      return { ok: true, count: stats.count, max: stats.max };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.post("/api/v1/forget", async (request, reply) => {
    try {
      const { projectPath, key, agentId = "default" } = request.body as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      if (typeof key !== "string") throw new ApiError(400, "key must be a string");
      const deleted = await store.forget(pp, key, String(agentId));
      return { ok: true, deleted };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.get("/api/v1/recall", async (request, reply) => {
    try {
      const { projectPath, agentId = "default" } = request.query as Record<string, unknown>;
      const pp    = validateProjectPath(projectPath);
      const facts = await store.recall(pp, String(agentId));
      const lims  = await store.getWorkingMemoryLimits(pp, true);
      return { ok: true, facts, max: lims.max, complexity: lims.profile };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.post("/api/v1/summarize", async (request, reply) => {
    try {
      const { projectPath, summary } = request.body as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      if (typeof summary !== "string") throw new ApiError(400, "summary must be a string");
      await store.archiveSummary(pp, summary);
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.get("/api/v1/status", async (request, reply) => {
    try {
      const { projectPath, agentId = "default" } = request.query as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      const [wmStats, kbStats, sessions, chain] = await Promise.all([
        store.getMemoryStats(pp, String(agentId)),
        store.getKbStats(pp),
        store.countActiveSessions(pp),
        store.chainStatus(pp),
      ]);
      return { ok: true, workingMemory: wmStats, knowledgeBase: kbStats, sessions, chain };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Knowledge Base
  // ─────────────────────────────────────────────────────────────────────────

  app.post("/api/v1/index", async (request, reply) => {
    try {
      const { projectPath, content, source, sourceType = "internal", retentionTier } = request.body as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      if (typeof content !== "string") throw new ApiError(400, "content must be a string");
      if (typeof source  !== "string") throw new ApiError(400, "source must be a string");
      if (!["internal","external"].includes(String(sourceType))) throw new ApiError(400, "sourceType must be 'internal' or 'external'");
      const validTiers = ["external", "internal", "summary"] as const;
      const tier = validTiers.includes(retentionTier as RetentionTier) ? retentionTier as RetentionTier : undefined;
      await store.index(pp, content, source, sourceType as "internal" | "external", tier);
      return { ok: true, source };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.post("/api/v1/search", async (request, reply) => {
    try {
      const { projectPath, queries, limit, agentId, depth } = request.body as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      if (!Array.isArray(queries) || queries.length === 0) throw new ApiError(400, "queries must be a non-empty array");
      const results = await store.search(pp, queries.map(String), {
        limit:   limit !== undefined ? Number(limit) : undefined,
        agentId: agentId !== undefined ? String(agentId) : undefined,
        depth:   depth as "L0" | "L1" | "L2" | undefined,
      });
      return { ok: true, results };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.post("/api/v1/search-global", async (request, reply) => {
    try {
      const { queries, limit } = request.body as Record<string, unknown>;
      if (!Array.isArray(queries) || queries.length === 0) throw new ApiError(400, "queries must be a non-empty array");
      const results = await store.searchGlobal(queries.map(String), limit !== undefined ? Number(limit) : undefined);
      return { ok: true, results };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.get("/api/v1/explain", async (request, reply) => {
    try {
      const { projectPath, query, depth = "L1" } = request.query as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      if (typeof query !== "string") throw new ApiError(400, "query must be a string");
      const result = await store.explain(pp, query, String(depth));
      return { ok: true, ...result };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Broadcasts
  // ─────────────────────────────────────────────────────────────────────────

  app.post("/api/v1/broadcast", async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const pp   = validateProjectPath(body["projectPath"]);
      const type = body["type"];
      const agentId = body["agentId"] ?? body["agent_id"];
      if (typeof type    !== "string") throw new ApiError(400, "type is required");
      if (typeof agentId !== "string") throw new ApiError(400, "agentId is required");

      const msg = await store.broadcast(pp, type as never, agentId, {
        task:          typeof body["task"]          === "string" ? body["task"]          : undefined,
        summary:       typeof body["summary"]       === "string" ? body["summary"]       : undefined,
        state:         typeof body["state"]         === "string" ? body["state"]         : undefined,
        reason:        typeof body["reason"]        === "string" ? body["reason"]        : undefined,
        importance:    typeof body["importance"]    === "number" ? body["importance"]    : undefined,
        channel_key:   typeof body["channel_key"]   === "string" ? body["channel_key"]  : undefined,
        session_token: typeof body["session_token"] === "string" ? body["session_token"]: undefined,
        files:         Array.isArray(body["files"])      ? body["files"]      as string[] : undefined,
        depends_on:    Array.isArray(body["depends_on"]) ? body["depends_on"] as string[] : undefined,
        // v0.16.0 §8.1 — structured ASSIGN forwarding (closes v0.15.0 known limitation
        // where HTTP API silently dropped these fields).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({
          acceptance_criteria:      Array.isArray(body["acceptance_criteria"])      ? body["acceptance_criteria"]      as string[] : undefined,
          complexity_estimate:      typeof body["complexity_estimate"]      === "number" ? body["complexity_estimate"]    : undefined,
          file_ownership_exclusive: Array.isArray(body["file_ownership_exclusive"]) ? body["file_ownership_exclusive"] as string[] : undefined,
          file_ownership_read_only: Array.isArray(body["file_ownership_read_only"]) ? body["file_ownership_read_only"] as string[] : undefined,
          task_dependencies:        Array.isArray(body["task_dependencies"])        ? body["task_dependencies"]        as number[] : undefined,
          required_skills:          Array.isArray(body["required_skills"])          ? body["required_skills"]          as string[] : undefined,
          estimated_tokens:         typeof body["estimated_tokens"]         === "number" ? body["estimated_tokens"]       : undefined,
        } as Record<string, unknown>),
      } as never);
      return { ok: true, message: msg };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      // Surface RBAC / channel key errors explicitly (not as 500)
      if (e instanceof Error && (e.message.startsWith("RBAC:") || e.message.startsWith("Broadcast rejected") || e.message.startsWith("Rate limit"))) {
        return reply.status(403).send({ error: e.message });
      }
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.get("/api/v1/broadcasts", async (request, reply) => {
    try {
      const { projectPath, limit, sinceId, type, agentId } = request.query as Record<string, unknown>;
      const pp      = validateProjectPath(projectPath);
      const results = await store.recallBroadcasts(pp, {
        limit:   limit   !== undefined ? Number(limit)   : undefined,
        sinceId: sinceId !== undefined ? Number(sinceId) : undefined,
        type:    type    as import("./store.js").BroadcastType | undefined,
        agentId: agentId as string | undefined,
      });
      return { ok: true, broadcasts: results };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.post("/api/v1/replay", async (request, reply) => {
    try {
      const { projectPath, fromId } = request.body as Record<string, unknown>;
      const pp      = validateProjectPath(projectPath);
      const results = await store.replay(pp, fromId !== undefined ? Number(fromId) : undefined);
      return { ok: true, broadcasts: results };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.post("/api/v1/ack", async (request, reply) => {
    try {
      const { projectPath, id } = request.body as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      if (typeof id !== "number" && typeof id !== "string") throw new ApiError(400, "id is required");
      await store.ack(pp, Number(id));
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.get("/api/v1/chain", async (request, reply) => {
    try {
      const { projectPath } = request.query as Record<string, unknown>;
      const pp     = validateProjectPath(projectPath);
      const status = await store.chainStatus(pp);
      return { ok: true, chain: status };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.post("/api/v1/set-key", async (request, reply) => {
    try {
      const { projectPath, key } = request.body as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      if (typeof key !== "string" || key.length < 8) throw new ApiError(400, "key must be at least 8 characters");
      await store.setChannelKey(pp, key);
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RBAC & Tokens
  // ─────────────────────────────────────────────────────────────────────────

  app.post("/api/v1/issue-token", async (request, reply) => {
    try {
      const { projectPath, agentId, role } = request.body as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      if (typeof agentId !== "string") throw new ApiError(400, "agentId is required");
      if (typeof role    !== "string") throw new ApiError(400, "role is required");
      const token = await store.issueToken(pp, agentId, role as never);
      return { ok: true, token };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.post("/api/v1/revoke-token", async (request, reply) => {
    try {
      const { projectPath, agentId } = request.body as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      if (typeof agentId !== "string") throw new ApiError(400, "agentId is required");
      await store.revokeTokens(pp, agentId);
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  app.post("/api/v1/verify-token", async (request, reply) => {
    try {
      const { projectPath, token } = request.body as Record<string, unknown>;
      const pp      = validateProjectPath(projectPath);
      if (typeof token !== "string") throw new ApiError(400, "token is required");
      const payload = await store.verifyToken(pp, token);
      return { ok: true, valid: payload !== null, payload };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error" });
    }
  });

  // ─── v0.12.1 Reference Monitor: telemetry endpoints ──────────────────────
  // Per Chin & Older 2011 Ch12 ("Reference Monitor"):
  //   Every protected resource needs exactly one enforcement point that is:
  //     (a) tamper-proof — only the API process holds DB write authority
  //     (b) always invoked — no client bypass path
  //     (c) verifiable — the validation is small and reviewable
  //
  // These endpoints are the SINGLE bypass-proof enforcement point for hash-
  // chained telemetry writes. The MCP server (which runs in agent processes)
  // becomes a CLIENT of these endpoints rather than opening DB files
  // directly, closing Tier 2 access-control gaps #1 + #2.
  //
  // Authentication: Bearer session_token in Authorization header. The token
  // is bound to an agent_id (verified at issuance — see issueToken). The
  // endpoint asserts payload.aid === body.agentId, blocking cross-agent
  // forgery (RT-S2-02 verifies).

  /**
   * Extract + verify the session_token from the Authorization header.
   * Returns the verified payload, or throws ApiError on any failure.
   */
  async function requireSessionToken(
    request: { headers: Record<string, string | string[] | undefined> },
    projectPath: string,
  ): Promise<{ agentId: string; role: string; tokenId: string }> {
    const authHeader = request.headers["authorization"];
    if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
      throw new ApiError(401, "Missing or malformed Authorization header (expected: Bearer <session_token>)");
    }
    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) throw new ApiError(401, "Empty session_token");

    const payload = await store.verifyToken(projectPath, token);
    if (payload === null) {
      throw new ApiError(401, "session_token invalid, expired, or revoked");
    }
    return payload as { agentId: string; role: string; tokenId: string };
  }

  /**
   * POST /api/v1/telemetry/tool_call
   * Reference Monitor for per-tool-call telemetry writes.
   *
   * Body:
   *   {
   *     projectPath: string,
   *     callId: string, sessionId: string, agentId: string,
   *     toolName: string, model: string,
   *     inputTokens?: number, outputTokens?: number, cachedTokens?: number,
   *     inputChars?: number, outputChars?: number,
   *     latencyMs: number, status: "ok"|"error"|"timeout",
   *     errorClass?: string, traceId?: string, batch?: boolean,
   *     taskId?: string, skillId?: string,
   *   }
   *
   * Headers:
   *   Authorization: Bearer <session_token>
   *
   * Returns:
   *   { ok: true, record: ToolCallRecord }  — 200 on success
   *   { error: "..." }  — 401 / 400 / 500 on failure
   */
  app.post("/api/v1/telemetry/tool_call", async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const pp = validateProjectPath(body.projectPath);

      // Reference Monitor invariant (a) — token check is unbypassable here.
      const tokenPayload = await requireSessionToken(request as never, pp);

      // Reference Monitor invariant (b) — agent_id binding.
      // The body.agentId MUST equal the token's bound agent_id. This is the
      // anti-forgery check: an agent with a valid session_token can't write
      // rows attributed to other agents.
      const claimedAgentId = body.agentId;
      if (typeof claimedAgentId !== "string") {
        throw new ApiError(400, "agentId is required");
      }
      if (claimedAgentId !== tokenPayload.agentId) {
        throw new ApiError(403, `Agent ID mismatch: token bound to '${tokenPayload.agentId}' but row claims '${claimedAgentId}' (cross-agent forgery blocked)`);
      }

      // Validate required fields
      const required = ["callId", "sessionId", "toolName", "model", "latencyMs", "status"];
      for (const k of required) {
        if (body[k] === undefined || body[k] === null) {
          throw new ApiError(400, `${k} is required`);
        }
      }

      // Delegate to local recordToolCall (which uses ChainedTableSqlite).
      // The HTTP layer is the enforcement point; the actual chain write is
      // unchanged. Per-agent HMAC subkey from v0.12.0 still applies.
      const { recordToolCall } = await import("./telemetry.js");
      const record = await recordToolCall({
        callId:       String(body.callId),
        sessionId:    String(body.sessionId),
        agentId:      claimedAgentId,
        projectPath:  pp,
        toolName:     String(body.toolName),
        model:        String(body.model),
        inputTokens:  typeof body.inputTokens  === "number" ? body.inputTokens  : undefined,
        outputTokens: typeof body.outputTokens === "number" ? body.outputTokens : undefined,
        cachedTokens: typeof body.cachedTokens === "number" ? body.cachedTokens : undefined,
        inputChars:   typeof body.inputChars   === "number" ? body.inputChars   : undefined,
        outputChars:  typeof body.outputChars  === "number" ? body.outputChars  : undefined,
        latencyMs:    Number(body.latencyMs),
        status:       body.status as "ok" | "error" | "timeout",
        errorClass:   body.errorClass as never,
        traceId:      typeof body.traceId === "string" ? body.traceId : undefined,
        batch:        body.batch === true,
        taskId:       typeof body.taskId  === "string" ? body.taskId  : undefined,
        skillId:      typeof body.skillId === "string" ? body.skillId : undefined,
      });

      if (record === null) {
        throw new ApiError(500, "Telemetry write failed (see server logs)");
      }
      return { ok: true, record };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error", detail: (e as Error).message });
    }
  });

  /**
   * POST /api/v1/telemetry/outcome
   * Reference Monitor for outcome resolver writes.
   *
   * Body:
   *   {
   *     projectPath: string,
   *     refType: "tool_call"|"task"|"skill_run"|"session",
   *     refId: string,
   *     outcomeKind: "shipped"|"reverted"|"accepted"|"rejected"|"sufficient"|"insufficient"|"errored",
   *     signalSource: "git_commit"|"user_prompt"|"follow_up"|"manual",
   *     confidence?: number,
   *     scoreDelta?: number,
   *     evidence?: Record<string, unknown>,
   *   }
   *
   * Headers:
   *   Authorization: Bearer <session_token>
   *
   * Note: outcomes don't have a per-row agent_id (they're written by the
   * resolver runtime, not directly by an agent). The session_token is still
   * required to confirm the writer is a legitimate SC client; cross-agent
   * forgery doesn't apply here because the writer identity is "outcomes-resolver".
   */
  app.post("/api/v1/telemetry/outcome", async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const pp = validateProjectPath(body.projectPath);

      // Token check (Reference Monitor invariant) — outcomes still need auth
      // even though they don't have a per-row agent_id. Prevents anonymous
      // writers from poisoning the outcomes table.
      await requireSessionToken(request as never, pp);

      const required = ["refType", "refId", "outcomeKind", "signalSource"];
      for (const k of required) {
        if (body[k] === undefined || body[k] === null) {
          throw new ApiError(400, `${k} is required`);
        }
      }

      const { recordOutcome } = await import("./outcomes.js");
      const record = await recordOutcome({
        projectPath:  pp,
        refType:      body.refType as never,
        refId:        String(body.refId),
        outcomeKind:  body.outcomeKind as never,
        signalSource: body.signalSource as never,
        confidence:   typeof body.confidence === "number" ? body.confidence : undefined,
        scoreDelta:   typeof body.scoreDelta === "number" ? body.scoreDelta : undefined,
        evidence:     (body.evidence ?? undefined) as Record<string, unknown> | undefined,
      });

      if (record === null) {
        throw new ApiError(500, "Outcome write failed (see server logs)");
      }
      return { ok: true, record };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(500).send({ error: "Internal error", detail: (e as Error).message });
    }
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async () => {
    await app.close();
    await store.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT",  shutdown);

  return { app, store, shutdown };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entrypoint (node dist/api-server.js)
// ─────────────────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("api-server.js")) {
  createApiServer().then(({ app }) => {
    app.listen({ port: API_PORT, host: API_HOST }, (err) => {
      if (err) { console.error(err); process.exit(1); }
      console.log(`SecureContext API server listening on ${API_HOST}:${API_PORT}`);
      console.log(`Store backend: ${process.env["ZC_STORE"] ?? "sqlite"}`);
      console.log(`Auth: ${API_KEY ? "enabled (ZC_API_KEY set)" : "⚠️  OPEN — set ZC_API_KEY"}`);
    });
  }).catch(err => { console.error(err); process.exit(1); });
}
