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
  // v0.28.0 fix: read ZC_API_KEY dynamically per call rather than module-load capture.
  // The module-load capture broke under test interleaving: when test file A set
  // ZC_API_KEY before test file B's `beforeAll`, file B's `import { createApiServer }`
  // ran with the stale key cached in the module-scope `API_KEY` constant, and
  // subsequent requests using B's freshly-minted testApiKey returned 401.
  // The original comment near the global gate said:
  //   "API_KEY is captured at module-load. The test process imports api-server.ts
  //    BEFORE beforeAll() sets ZC_API_KEY, so API_KEY is undefined and
  //    timingSafeKeyCheck returns true regardless."
  // …which was only true when api-server.ts was the FIRST module to import in
  // the test worker. Once vitest started sharing workers across files (or once
  // any other test file imports api-server.ts while having ZC_API_KEY set), the
  // assumption broke. Reading per-call is the simple fix; perf cost is one
  // env lookup, negligible vs. the sha256 + timingSafeEqual.
  const apiKey = process.env["ZC_API_KEY"];
  if (!apiKey) return true; // No key configured — open (dev mode warning logged at startup)
  if (!supplied) return false;
  try {
    const a = Buffer.from(createHash("sha256").update(supplied).digest("hex"), "hex");
    const b = Buffer.from(createHash("sha256").update(apiKey).digest("hex"),   "hex");
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
  //
  // v0.28.0 fix: ONLY apply this normalization to Windows-style paths
  // (drive letter prefix like "C:/" or "C:\"). POSIX paths start with "/"
  // and MUST keep their forward slashes — replacing `/` → `\` mangles
  // "/tmp/foo" into "\tmp\foo" which:
  //   (a) is not a valid Linux path,
  //   (b) hashes to a different DB than the client computed it under,
  //   (c) caused every session-token-bearing telemetry request on Linux/CI
  //       to 401 since `requireSessionToken` would look up the token under
  //       the mangled hash and find nothing. Local Windows always passed
  //       because the normalization round-trips on Windows paths; CI Linux
  //       always failed because POSIX paths got butchered.
  // The regex matches drive letter + separator only at string start.
  if (/^[a-zA-Z]:[\/\\]/.test(projectPath)) {
    return projectPath.replace(/\//g, "\\");
  }
  return projectPath;
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
  // v0.18.2 Sprint 2.6 — register a urlencoded body parser inline (avoids a
  // new dependency on @fastify/formbody). HTMX forms POST as
  // application/x-www-form-urlencoded; without this Fastify rejects them with
  // 415 Unsupported Media Type.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" },
    (_req, body, done) => {
      try {
        // v0.25.0: handle duplicate keys (e.g. multiple checkbox<input> with
        // the same name="intended_roles" — HTMX submits each checked value
        // as a separate key-value pair). Without this fix the iteration
        // overwrites: only the LAST value survives. Caught when operator
        // checked developer + qa but only qa landed in skills_pg.
        const params = new URLSearchParams(body as string);
        const obj: Record<string, string | string[]> = {};
        for (const [k, v] of params.entries()) {
          if (k in obj) {
            const prev = obj[k];
            obj[k] = Array.isArray(prev) ? [...prev, v] : [prev as string, v];
          } else {
            obj[k] = v;
          }
        }
        done(null, obj);
      } catch (e) { done(e as Error, undefined); }
    },
  );

  app.addHook("preHandler", async (request, reply) => {
    // Health check is always open
    if (request.url === "/health") return;

    // v0.18.2 Sprint 2.6 — operator dashboard. Local-only by design (HOST default
    // 0.0.0.0 in dev, but operators are expected to firewall :3099 to localhost
    // for now). Routes under /dashboard render HTML for browser viewing without
    // an Authorization header. When a multi-tenant story lands (Sprint 3.x),
    // these routes will gate via the existing per-project RBAC token system.
    if (request.url === "/dashboard" || request.url.startsWith("/dashboard/")) return;

    // v0.26.0 Step 4 — PreToolUse hook (~/.claude/hooks/skill-script-hmac-verify.mjs)
    // calls /api/v1/skills/<name>/verify-script to ask "is this script's HMAC
    // intact?" The hook is spawned per Bash invocation by Claude Code; it doesn't
    // know the API key (the key lives in MCP env, not host env). Exempt this
    // route from the global API key gate. The endpoint is READ-ONLY (verify by
    // hash, no DB writes, no secret leakage) so the exemption is safe.
    if (request.url.startsWith("/api/v1/skills/") && request.url.includes("/verify-script")) return;

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

    // v0.18.9 fix — telemetry endpoints have their own per-agent session_token
    // auth (the Reference Monitor pattern from v0.12.1, see RT-S2-02..RT-S2-06).
    // The Authorization header here carries the session_token, NOT the global
    // API key. The route handler validates it via requireSessionToken() and
    // enforces the agent_id binding. Skip the global API key gate here so
    // legitimate session-token requests aren't 401'd.
    //
    // Why this didn't fail in tests: API_KEY is captured at module-load. The
    // test process imports api-server.ts BEFORE beforeAll() sets ZC_API_KEY,
    // so API_KEY is undefined and timingSafeKeyCheck returns true regardless.
    // Production (real settings.json env at MCP-spawn time) had API_KEY set,
    // and every tool_call write was rejected with 401. Telemetry has been
    // silently dropped on the floor for everyone running with API mode +
    // ZC_API_KEY since v0.12.1.
    if (request.url.startsWith("/api/v1/telemetry/")) return;

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
  // v0.18.2 Sprint 2.6 — Operator Dashboard
  // ─────────────────────────────────────────────────────────────────────────
  // Local-only HTMX dashboard for reviewing pending skill-mutation results
  // and approving / rejecting them. Bypasses the API key auth (see preHandler
  // exemption above) so it can be opened in a browser without setting headers.
  // For a multi-tenant story (Sprint 3.x), replace this exemption with
  // session-token gating via the existing RBAC system.

  app.get("/dashboard", async (_request, reply) => {
    const { renderDashboardHtml } = await import("./dashboard/render.js");
    reply.type("text/html").send(renderDashboardHtml());
  });

  app.get("/dashboard/health", async (_request, _reply) => {
    const { withClient } = await import("./pg_pool.js");
    try {
      const n = await withClient(async (c) => {
        const res = await c.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM mutation_results_pg WHERE consumed_at IS NULL`,
        );
        return Number(res.rows[0]?.n ?? 0);
      });
      return { pending_count: n, ts: new Date().toISOString() };
    } catch (e) {
      return { pending_count: 0, error: (e as Error).message, ts: new Date().toISOString() };
    }
  });

  // v0.22.9 — Generic pretool-event telemetry. Records EVERY PreRead hook
  // invocation regardless of outcome (redirect / block_unindexed /
  // bypass_force_read / bypass_partial_read / pass_through / error).
  // Diagnoses the "read_redirects=0 forever" silent-failure mode found
  // in the v0.22.x audit: read_redirects_pg only logs the success path,
  // so the operator couldn't tell if the hook was firing at all when
  // count==0. With this table, the dashboard can show "hook fires N
  // times/day, 0 of them produce redirects because all reads are of
  // unindexed project-root files" — actionable signal vs invisible gap.
  app.post("/api/v1/telemetry/pretool-event", async (request, reply) => {
    try {
      const b = request.body as Record<string, unknown>;
      const pp = validateProjectPath(b["projectPath"]);
      const agentId  = typeof b["agentId"]  === "string" ? b["agentId"].slice(0, 64)  : "default";
      const toolName = typeof b["toolName"] === "string" ? b["toolName"].slice(0, 64) : "Read";
      const filePath = typeof b["filePath"] === "string" ? b["filePath"].slice(0, 1024) : null;
      const outcome  = String(b["outcome"] ?? "error").slice(0, 32);
      const detail   = typeof b["detail"] === "string" ? b["detail"].slice(0, 2048) : null;
      const allowed = ["redirect", "block_unindexed", "block_dedup",
                       "bypass_force_read", "bypass_partial_read", "pass_through", "error"];
      if (!allowed.includes(outcome)) {
        return reply.status(400).send({ error: `outcome must be one of ${allowed.join(", ")}` });
      }
      const { createHash } = await import("node:crypto");
      const { realpathSync } = await import("node:fs");
      let normalized = pp;
      try { normalized = realpathSync(pp); } catch { /* use raw */ }
      const projectHash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
      const { withClient } = await import("./pg_pool.js");
      await withClient(async (c) => {
        await c.query(
          `INSERT INTO pretool_events_pg
             (project_hash, agent_id, tool_name, file_path, outcome, detail)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [projectHash, agentId, toolName, filePath, outcome, detail],
        );
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      // Hook is fire-and-forget — never break agent flow on telemetry failures
      return { ok: false, error: (e as Error).message };
    }
  });

  // v0.22.7 — Summarizer-event telemetry receiver. Mirrors the v0.22.5
  // read-redirect pattern: harness.ts fires POSTs after every L0/L1
  // generation (success, fallback, error). Stores rows in
  // summarizer_events_pg so the dashboard "Summarizer activity" panel
  // can surface real-time indexing health — currently the operator was
  // completely blind to whether file summaries were being created or
  // failing silently.
  app.post("/api/v1/telemetry/summarizer-event", async (request, reply) => {
    try {
      const b = request.body as Record<string, unknown>;
      const pp = validateProjectPath(b["projectPath"]);
      const agentId = typeof b["agentId"] === "string" ? b["agentId"].slice(0, 64) : "default";
      const source  = typeof b["source"]  === "string" ? b["source"].slice(0, 1024) : "";
      const size    = Number(b["sourceSizeBytes"] ?? 0);
      const l0Len   = Number(b["l0Length"] ?? 0);
      const l1Len   = Number(b["l1Length"] ?? 0);
      const durMs   = Number(b["durationMs"] ?? 0);
      const model   = typeof b["model"] === "string" ? b["model"].slice(0, 128) : null;
      const summarySource = String(b["summarySource"] ?? "unknown").slice(0, 32);
      const status  = String(b["status"] ?? "error").slice(0, 32);
      const errorMsg = typeof b["errorMessage"] === "string" ? b["errorMessage"].slice(0, 2048) : null;
      if (!source) {
        return reply.status(400).send({ error: "source is required" });
      }
      const allowedSrc = ["ast", "semantic", "truncation", "unknown"];
      const allowedStat = ["ok", "fallback_truncation", "error", "skipped"];
      if (!allowedSrc.includes(summarySource)) {
        return reply.status(400).send({ error: `summarySource must be one of ${allowedSrc.join(", ")}` });
      }
      if (!allowedStat.includes(status)) {
        return reply.status(400).send({ error: `status must be one of ${allowedStat.join(", ")}` });
      }
      const { createHash } = await import("node:crypto");
      const { realpathSync } = await import("node:fs");
      let normalized = pp;
      try { normalized = realpathSync(pp); } catch { /* use raw */ }
      const projectHash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
      const { withClient } = await import("./pg_pool.js");
      await withClient(async (c) => {
        await c.query(
          `INSERT INTO summarizer_events_pg
             (project_hash, agent_id, source, source_size_bytes, l0_length, l1_length,
              duration_ms, model, summary_source, status, error_message)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [projectHash, agentId, source,
           Math.max(0, Math.floor(size)),
           Math.max(0, Math.floor(l0Len)),
           Math.max(0, Math.floor(l1Len)),
           Math.max(0, Math.floor(durMs)),
           model, summarySource, status, errorMsg],
        );
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      return { ok: false, error: (e as Error).message };
    }
  });

  // v0.22.7 — Summarizer-activity dashboard panel. Returns rendered HTML
  // with: (a) total file summaries indexed for the project (from
  // source_meta), (b) recent summarizer events grouped by status, (c) the
  // last 10 successful summarizations, (d) the last 5 failures with full
  // error messages so the operator can debug. Polls every 60s from the UI.
  app.get("/dashboard/summarizer-health", async (request, reply) => {
    const { renderSummarizerHealthFragment, loadProjectNameMap } = await import(
      "./dashboard/render.js"
    );
    const { withClient } = await import("./pg_pool.js");
    const q = request.query as Record<string, unknown>;
    const projectFilter = typeof q.project === "string" && /^[0-9a-f]{16}$/.test(q.project)
      ? q.project
      : null;
    try {
      const result = await withClient(async (c) => {
        // v0.22.8 — total_file_summaries is now the AUTHORITATIVE count
        // from source_meta (the STATE table). After v0.22.8, the agent's
        // every L0/L1 write dual-mirrors here, and the v0.22.8 backfill
        // copied existing SQLite-only summaries. So this count = "files
        // the system actually has L0/L1 summaries for." Operator policy:
        // PG and SQLite must have feature parity; PG is preferred when
        // available. See feedback_pg_first_storage.md.
        //
        // distinct_summarized_v0227 is the secondary "telemetry-tracked"
        // count — distinct sources seen in summarizer_events_pg since
        // v0.22.7. Useful for "how much has been summarized in the last
        // <window>" but not for "total available." Surfaced below.
        const totalQ = projectFilter
          ? `SELECT COUNT(*)::text AS n FROM source_meta WHERE project_hash = $1 AND source LIKE 'file:%'`
          : `SELECT COUNT(*)::text AS n FROM source_meta WHERE source LIKE 'file:%'`;
        const totalR = await c.query<{ n: string }>(totalQ, projectFilter ? [projectFilter] : []);
        const total_file_summaries = Number(totalR.rows[0]?.n ?? 0);

        const distinctQ = projectFilter
          ? `SELECT COUNT(DISTINCT source)::text AS n FROM summarizer_events_pg WHERE project_hash = $1 AND status IN ('ok', 'fallback_truncation')`
          : `SELECT COUNT(DISTINCT source)::text AS n FROM summarizer_events_pg WHERE status IN ('ok', 'fallback_truncation')`;
        const distinctR = await c.query<{ n: string }>(distinctQ, projectFilter ? [projectFilter] : []);
        const distinct_summarized_v0227 = Number(distinctR.rows[0]?.n ?? 0);

        // 2) breakdown of last 24h events by status × source
        const eventQ = projectFilter
          ? `SELECT status, summary_source, COUNT(*)::text AS n,
                    AVG(duration_ms)::int AS avg_ms
               FROM summarizer_events_pg
              WHERE ts > NOW() - INTERVAL '24 hours' AND project_hash = $1
              GROUP BY status, summary_source
              ORDER BY 3 DESC`
          : `SELECT status, summary_source, COUNT(*)::text AS n,
                    AVG(duration_ms)::int AS avg_ms
               FROM summarizer_events_pg
              WHERE ts > NOW() - INTERVAL '24 hours'
              GROUP BY status, summary_source
              ORDER BY 3 DESC`;
        const eventP = projectFilter ? [projectFilter] : [];
        const eventR = await c.query<{ status: string; summary_source: string; n: string; avg_ms: number }>(
          eventQ, eventP,
        );
        const events_24h = eventR.rows.map((r) => ({
          status: r.status, summary_source: r.summary_source,
          count: Number(r.n), avg_duration_ms: Number(r.avg_ms ?? 0),
        }));

        // 3) recent successful summaries (last 10)
        const recentQ = projectFilter
          ? `SELECT source, summary_source, model, duration_ms, ts, agent_id, l0_length, l1_length
               FROM summarizer_events_pg
              WHERE project_hash = $1 AND status IN ('ok', 'fallback_truncation')
              ORDER BY ts DESC LIMIT 10`
          : `SELECT source, summary_source, model, duration_ms, ts, agent_id, l0_length, l1_length, project_hash
               FROM summarizer_events_pg
              WHERE status IN ('ok', 'fallback_truncation')
              ORDER BY ts DESC LIMIT 10`;
        const recentR = await c.query<Record<string, unknown>>(
          recentQ, projectFilter ? [projectFilter] : [],
        );

        // 4) recent failures (last 5)
        const failQ = projectFilter
          ? `SELECT source, status, summary_source, error_message, ts, agent_id, model
               FROM summarizer_events_pg
              WHERE project_hash = $1 AND status IN ('error', 'skipped')
              ORDER BY ts DESC LIMIT 5`
          : `SELECT source, status, summary_source, error_message, ts, agent_id, model, project_hash
               FROM summarizer_events_pg
              WHERE status IN ('error', 'skipped')
              ORDER BY ts DESC LIMIT 5`;
        const failR = await c.query<Record<string, unknown>>(
          failQ, projectFilter ? [projectFilter] : [],
        );

        return {
          total_file_summaries,
          distinct_summarized_v0227,
          events_24h,
          recent_success: recentR.rows,
          recent_failures: failR.rows,
        };
      });
      const nameMap = await loadProjectNameMap();
      reply.type("text/html").send(renderSummarizerHealthFragment(result, nameMap, projectFilter));
    } catch (e) {
      reply
        .type("text/html")
        .send(
          `<div class="skill-health-empty">Failed to load summarizer health: ${(e as Error).message}</div>`,
        );
    }
  });

  // v0.22.6 — Skill-activity health: surface projects that are active
  // (broadcasting) but recording zero skill outcomes. Catches the failure
  // mode where the v0.21.0 enforcement levers got dropped from agent
  // system prompts (e.g. spawn-agent.ps1 not patched, settings.json
  // fallback missing on a worker). Run-once every 60s by HTMX from the
  // top of the dashboard.
  app.get("/dashboard/skill-health", async (_request, reply) => {
    const { renderSkillHealthFragment, loadProjectNameMap } = await import(
      "./dashboard/render.js"
    );
    const { withClient } = await import("./pg_pool.js");
    try {
      type Row = {
        project_hash: string;
        broadcasts_24h: string;
        skill_runs_24h: string;
        skill_show_calls_24h: string;
        outcome_calls_24h: string;
        unique_agents: string;
        last_broadcast_at: string;
      };
      const rows = await withClient(async (c) => {
        const res = await c.query<Row>(
          `WITH broadcast_activity AS (
             -- v0.25.2: dropped HAVING COUNT(*) >= 3 filter. The threshold
             -- hid genuinely-active projects in their first hour: real-life
             -- A2A_communication had 2 broadcasts (1 LAUNCH_ROLE + 1 ASSIGN)
             -- in the first 2 minutes of a session, was filtered out, and
             -- the operator saw "All 1 active project is healthy" instead
             -- of seeing their newly-started project. Now any project with
             -- ≥1 broadcast in the last 24h shows up — a much truer
             -- definition of "active project right now."
             SELECT project_hash,
                    COUNT(*) AS broadcasts_24h,
                    COUNT(DISTINCT agent_id) AS unique_agents,
                    MAX(created_at) AS last_broadcast_at
               FROM broadcasts
              WHERE created_at::timestamptz > NOW() - INTERVAL '24 hours'
              GROUP BY project_hash
           ),
           skill_run_counts AS (
             SELECT project_hash, COUNT(*) AS skill_runs_24h
               FROM skill_runs_pg
              WHERE ts > NOW() - INTERVAL '24 hours'
              GROUP BY project_hash
           ),
           skill_show_counts AS (
             -- v0.23.3: zc_skill_show window widened to 7 days. Window-boundary
             -- artifact: a single agent session that loads a skill at hour 0
             -- and records 5 outcomes over the next 30h would, with a 24h
             -- window, show "0 skill_show, N outcomes" once the show drops
             -- out of the 24h count. zc_skill_show is one-per-skill-load
             -- (not one-per-task) so the load signal is multi-day. Outcomes
             -- still measure recent (24h) activity.
             SELECT project_hash,
                    COUNT(*) FILTER (WHERE tool_name = 'zc_skill_show'
                                     AND ts > NOW() - INTERVAL '7 days') AS skill_show_calls_24h,
                    COUNT(*) FILTER (WHERE tool_name = 'zc_record_skill_outcome'
                                     AND ts > NOW() - INTERVAL '24 hours') AS outcome_calls_24h
               FROM tool_calls_pg
              WHERE ts > NOW() - INTERVAL '7 days'
                AND tool_name IN ('zc_skill_show', 'zc_record_skill_outcome')
              GROUP BY project_hash
           )
           SELECT b.project_hash,
                  b.broadcasts_24h::text,
                  COALESCE(s.skill_runs_24h, 0)::text       AS skill_runs_24h,
                  COALESCE(c.skill_show_calls_24h, 0)::text AS skill_show_calls_24h,
                  COALESCE(c.outcome_calls_24h, 0)::text    AS outcome_calls_24h,
                  b.unique_agents::text,
                  b.last_broadcast_at
             FROM broadcast_activity b
        LEFT JOIN skill_run_counts s ON s.project_hash = b.project_hash
        LEFT JOIN skill_show_counts c ON c.project_hash = b.project_hash
            ORDER BY b.last_broadcast_at DESC
            LIMIT 20`,
        );
        return res.rows;
      });
      const nameMap = await loadProjectNameMap();
      const fragRows = rows.map((r) => ({
        project_hash:         r.project_hash,
        project_name:         nameMap.get(r.project_hash) ?? null,
        broadcasts_24h:       Number(r.broadcasts_24h),
        skill_runs_24h:       Number(r.skill_runs_24h),
        skill_show_calls_24h: Number(r.skill_show_calls_24h),
        outcome_calls_24h:    Number(r.outcome_calls_24h),
        unique_agents:        Number(r.unique_agents),
        last_broadcast_at:    String(r.last_broadcast_at ?? ""),
      }));
      reply.type("text/html").send(renderSkillHealthFragment(fragRows));
    } catch (e) {
      reply
        .type("text/html")
        .send(
          `<div class="skill-health-empty">Failed to load skill health: ${(e as Error).message}</div>`,
        );
    }
  });

  app.get("/dashboard/pending", async (_request, reply) => {
    const { renderPendingFragment, loadProjectNameMap } = await import("./dashboard/render.js");
    const { withClient } = await import("./pg_pool.js");
    try {
      const rows = await withClient(async (c) => {
        // v0.18.4: LEFT JOIN skills_pg to fetch the parent body for the
        // diff view in the dashboard (so each candidate can be shown
        // side-by-side against what it's replacing).
        const res = await c.query<Record<string, unknown>>(
          `SELECT mr.result_id, mr.mutation_id, mr.skill_id, mr.project_hash, mr.proposer_model,
                  mr.proposer_role, mr.candidate_count, mr.best_score, mr.bodies, mr.bodies_hash,
                  mr.headline, mr.created_at, mr.original_task_id, mr.original_role,
                  mr.mutator_pool, sp.body AS parent_body
             FROM mutation_results_pg mr
        LEFT JOIN skills_pg sp ON sp.skill_id = mr.skill_id
            WHERE mr.consumed_at IS NULL
            ORDER BY mr.created_at DESC LIMIT 50`,
        );
        return res.rows;
      });
      // v0.18.3: resolve project_hash → name once per request (sync read of
      // agents.json; cheap enough for a 10s poll, no caching needed yet).
      const nameMap = await loadProjectNameMap();
      reply.type("text/html").send(renderPendingFragment(rows, nameMap));
    } catch (e) {
      reply.type("text/html").send(`<div class="error">Failed to load pending: ${(e as Error).message}</div>`);
    }
  });

  app.post("/dashboard/approve", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const result_id            = String(body.result_id ?? "").trim();
    const confirm_id           = String(body.confirm_id ?? "").trim();
    const picked_candidate_idx = Number(body.picked_candidate_index);
    const rationale            = String(body.rationale ?? "").trim();
    const auto_reassign        = body.auto_reassign === "on" || body.auto_reassign === "true" || body.auto_reassign === true;

    if (!result_id || result_id !== confirm_id) {
      reply.type("text/html").send(`<div class="error">❌ Confirmation failed: typed ID does not match result_id.</div>`);
      return;
    }
    if (!Number.isFinite(picked_candidate_idx) || picked_candidate_idx < 0) {
      reply.type("text/html").send(`<div class="error">❌ picked_candidate_index missing or invalid.</div>`);
      return;
    }
    if (!rationale) {
      reply.type("text/html").send(`<div class="error">❌ Rationale required.</div>`);
      return;
    }

    try {
      const { handleApproveFromDashboard } = await import("./dashboard/operator_review.js");
      const result = await handleApproveFromDashboard({ result_id, picked_candidate_index: picked_candidate_idx, rationale, auto_reassign });
      reply.type("text/html").send(
        `<div class="ok">✓ Approved <code>${escapeHtml(result_id)}</code><br>` +
        `→ promoted to <code>${escapeHtml(result.new_skill_id)}</code> (candidate #${picked_candidate_idx})<br>` +
        (result.retry_task_id ? `→ auto-reassigned retry task <code>${escapeHtml(result.retry_task_id)}</code> to role <code>${escapeHtml(result.original_role ?? "?")}</code><br>` : `→ no auto-reassign (operator unchecked OR no original_role)<br>`) +
        `</div>`,
      );
    } catch (e) {
      reply.type("text/html").send(`<div class="error">❌ ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  app.post("/dashboard/reject", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const result_id  = String(body.result_id ?? "").trim();
    const confirm_id = String(body.confirm_id ?? "").trim();
    const rationale  = String(body.rationale ?? "").trim();

    if (!result_id || result_id !== confirm_id) {
      reply.type("text/html").send(`<div class="error">❌ Confirmation failed: typed ID does not match.</div>`);
      return;
    }
    if (!rationale) {
      reply.type("text/html").send(`<div class="error">❌ Rationale required.</div>`);
      return;
    }
    try {
      const { handleRejectFromDashboard } = await import("./dashboard/operator_review.js");
      await handleRejectFromDashboard({ result_id, rationale });
      reply.type("text/html").send(`<div class="ok">✗ Rejected <code>${escapeHtml(result_id)}</code></div>`);
    } catch (e) {
      reply.type("text/html").send(`<div class="error">❌ ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ─── v0.18.5 Sprint 2.7 — Skill frontmatter editor ──────────────────────
  // Lists active skills + provides an inline edit form per skill. Body is
  // preserved verbatim; only frontmatter fields the operator owns are
  // editable through this surface (description, intended_roles,
  // mutation_guidance, acceptance_criteria, tags).
  app.get("/dashboard/skills", async (_request, reply) => {
    const { renderSkillsListFragment } = await import("./dashboard/render.js");
    const { withClient } = await import("./pg_pool.js");
    try {
      const rows = await withClient(async (c) => {
        const res = await c.query<Record<string, unknown>>(
          // v0.26.0 Step 7 — also pull skill_dir + script_hmacs so the renderer
          // can show the "📁 filesystem" badge and script count.
          `SELECT skill_id, name, version, scope, description, frontmatter, skill_dir, script_hmacs
             FROM skills_pg
            WHERE archived_at IS NULL
              AND (quarantined IS NULL OR quarantined = FALSE)
            ORDER BY scope, name`,
        );
        return res.rows;
      });
      const { loadProjectNameMap } = await import("./dashboard/render.js");
      const { fetchSkillEfficiency } = await import("./dashboard/savings_snapshotter.js");
      const nameMap = await loadProjectNameMap();
      // v0.18.8 Loop B — pull per-skill avg cost (cross-project; we filter by skill_id, not project)
      const effMap = await fetchSkillEfficiency("");
      // v0.25.0 — last 20 scored runs per skill, used for the inline
      // sparkline trend. Single query, grouped client-side.
      const trendMap = await withClient(async (c) => {
        const r = await c.query<{ skill_id: string; ts: string; outcome_score: string | null }>(
          `SELECT skill_id, ts::text AS ts, outcome_score::text AS outcome_score
             FROM (
               SELECT skill_id, ts, outcome_score,
                      ROW_NUMBER() OVER (PARTITION BY skill_id ORDER BY ts DESC) AS rn
                 FROM skill_runs_pg
                WHERE outcome_score IS NOT NULL
             ) ranked
            WHERE rn <= 20
            ORDER BY skill_id, ts`,
        );
        const m = new Map<string, Array<{ ts: string; score: number | null }>>();
        for (const row of r.rows) {
          const sid = String(row.skill_id);
          if (!m.has(sid)) m.set(sid, []);
          m.get(sid)!.push({
            ts: String(row.ts),
            score: row.outcome_score === null ? null : Number(row.outcome_score),
          });
        }
        return m;
      });
      reply.type("text/html").send(renderSkillsListFragment(rows, nameMap, effMap, trendMap));
    } catch (e) {
      reply.type("text/html").send(`<div class="error">Failed to load skills: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.26.0 Step 7 — HTML fragment: chain integrity banner for the
  // filesystem-skills security panel. Green pill if intact, red if broken.
  app.get("/dashboard/fs-skills/chain-banner", async (_request, reply) => {
    try {
      const { verifyAdmissionChain } = await import("./skills/admission_log.js");
      const r = await verifyAdmissionChain();
      const html = r.ok
        ? `<div class="chain-banner chain-ok">
             <span class="chain-status">🟢 CHAIN OK</span>
             <span class="chain-detail">${r.totalRows} HMAC-chained admission event${r.totalRows === 1 ? "" : "s"} verified · machine_secret-keyed</span>
           </div>`
        : `<div class="chain-banner chain-broken">
             <span class="chain-status">🔴 CHAIN TAMPERED</span>
             <span class="chain-detail">Break at row #${r.brokenAt ?? "?"} (${escapeHtml(r.brokenKind ?? "unknown")}); ${r.totalRows} total rows. Investigate audit.log JSONL anchors for ground truth.</span>
           </div>`;
      reply.type("text/html").send(html);
    } catch (e) {
      reply.type("text/html").send(`<div class="chain-banner chain-error">⚠️ Chain verify failed: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.26.0 Step 7 — HTML fragment: quarantined-skill list with reasons.
  // Pulls from skills_pg WHERE quarantined=TRUE; shows skill name, quarantine
  // path, and the first-line reason. No bulk-restore button — operator must
  // re-import explicitly (defense-in-depth).
  app.get("/dashboard/fs-skills/quarantine", async (_request, reply) => {
    try {
      const { withClient: wc } = await import("./pg_pool.js");
      const rows = await wc(async (c) => {
        const r = await c.query<{
          skill_id: string; name: string; skill_dir: string | null;
          quarantine_reason: string | null; created_at: string;
        }>(
          `SELECT skill_id, name, skill_dir, quarantine_reason, created_at::text
             FROM skills_pg
            WHERE quarantined = TRUE
            ORDER BY created_at DESC
            LIMIT 50`,
        );
        return r.rows;
      });
      if (rows.length === 0) {
        reply.type("text/html").send(`<p class="empty" style="color:#10b981">✅ No quarantined skills.</p>`);
        return;
      }
      const html = `
        <table class="fs-quarantine-table">
          <thead>
            <tr><th>Skill</th><th>Quarantine path</th><th>Reason</th><th>When</th></tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td><code>${escapeHtml(row.name)}</code> <small style="color:#94a3b8">${escapeHtml(row.skill_id)}</small></td>
                <td><code style="font-size:0.78rem">${escapeHtml(row.skill_dir ?? "(unknown)")}</code></td>
                <td style="max-width:380px; color:#fca5a5">${escapeHtml((row.quarantine_reason ?? "").slice(0, 200))}${(row.quarantine_reason ?? "").length > 200 ? "…" : ""}</td>
                <td style="color:#94a3b8; font-size:0.85rem">${escapeHtml(row.created_at.slice(0, 19))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
      reply.type("text/html").send(html);
    } catch (e) {
      reply.type("text/html").send(`<div class="error">Failed to load quarantine: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.26.0 Step 7 — HTML fragment: recent admission events (HMAC-chained).
  app.get("/dashboard/fs-skills/admission-log", async (_request, reply) => {
    try {
      const { withClient: wc } = await import("./pg_pool.js");
      const rows = await wc(async (c) => {
        const r = await c.query<{
          id: string; ts: string; event: string; skill_name: string;
          skill_version: string | null; quarantined: boolean;
          reason: string | null; row_hash: string;
        }>(
          `SELECT id, ts::text, event, skill_name, skill_version, quarantined, reason, row_hash
             FROM skill_admission_log_pg
            ORDER BY id DESC
            LIMIT 25`,
        );
        return r.rows;
      });
      if (rows.length === 0) {
        reply.type("text/html").send(`<p class="empty">No admission events yet.</p>`);
        return;
      }
      const html = `
        <table class="fs-admission-table">
          <thead><tr><th>#</th><th>When</th><th>Event</th><th>Skill</th><th>Reason</th><th>row_hash</th></tr></thead>
          <tbody>
            ${rows.map((row) => {
              const eventBadge = row.quarantined
                ? `<span class="evt-badge evt-quar">${escapeHtml(row.event)}</span>`
                : row.event === "admitted"
                  ? `<span class="evt-badge evt-ok">${escapeHtml(row.event)}</span>`
                  : `<span class="evt-badge evt-info">${escapeHtml(row.event)}</span>`;
              return `
                <tr>
                  <td>${row.id}</td>
                  <td style="color:#94a3b8; font-size:0.82rem">${escapeHtml(row.ts.slice(0, 19))}</td>
                  <td>${eventBadge}</td>
                  <td><code>${escapeHtml(row.skill_name)}</code> ${row.skill_version ? `<small style="color:#94a3b8">v${escapeHtml(row.skill_version)}</small>` : ""}</td>
                  <td style="max-width:340px; color:#fca5a5; font-size:0.85rem">${escapeHtml((row.reason ?? "").slice(0, 140))}${(row.reason ?? "").length > 140 ? "…" : ""}</td>
                  <td><code style="font-size:0.72rem; color:#94a3b8">${escapeHtml(row.row_hash.slice(0, 16))}…</code></td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      `;
      reply.type("text/html").send(html);
    } catch (e) {
      reply.type("text/html").send(`<div class="error">Failed to load admission log: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  app.get("/dashboard/skills/edit", async (request, reply) => {
    const skillId = String((request.query as Record<string, unknown>)?.skill_id ?? "");
    if (!skillId) {
      reply.type("text/html").send(`<div class="error">Missing skill_id query parameter.</div>`);
      return;
    }
    const { renderSkillEditForm } = await import("./dashboard/render.js");
    const { withClient } = await import("./pg_pool.js");
    try {
      const row = await withClient(async (c) => {
        const res = await c.query<Record<string, unknown>>(
          `SELECT skill_id, name, version, scope, description, frontmatter, body
             FROM skills_pg
            WHERE skill_id = $1`,
          [skillId],
        );
        return res.rows[0] ?? null;
      });
      if (!row) {
        reply.type("text/html").send(`<div class="error">Skill not found: ${escapeHtml(skillId)}</div>`);
        return;
      }
      reply.type("text/html").send(renderSkillEditForm(row));
    } catch (e) {
      reply.type("text/html").send(`<div class="error">Failed to load skill: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // ─── v0.18.7 — Token savings panel ──────────────────────────────────────
  app.get("/dashboard/savings", async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const projectHash = String(q.project ?? "").trim();
    const window      = String(q.window  ?? "7d").trim();  // "7d" | "24h" | "session" (= 1h proxy)
    if (!projectHash || !/^[0-9a-f]{16}$/.test(projectHash)) {
      reply.type("text/html").send(`<div class="empty">Pick a project to compute savings. (No project_hash supplied.)</div>`);
      return;
    }
    const until = new Date();
    const since = new Date(until);
    if      (window === "24h")     since.setHours(until.getHours() - 24);
    else if (window === "session") since.setHours(until.getHours() - 1);
    else                           since.setDate(until.getDate() - 7);  // default 7d

    try {
      const { computeSavings, renderSavingsHtml } = await import("./dashboard/token_savings.js");
      const { loadProjectNameMap } = await import("./dashboard/render.js");
      const summary = await computeSavings(projectHash, since.toISOString(), until.toISOString());
      const projectName = (await loadProjectNameMap()).get(projectHash) ?? null;
      reply.type("text/html").send(renderSavingsHtml(summary, projectName));
    } catch (e) {
      reply.type("text/html").send(`<div class="error">Failed to compute savings: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.18.8 — snapshotter trigger (called by dispatcher tick). No-auth (local).
  // Supports ?force=true + ?cadence=<4h|daily> + ?anchor=<ISO> for explicit
  // backfills (testing or manual recovery).
  app.post("/dashboard/savings/snapshot", async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    try {
      if (q.force === "true" || q.force === "1") {
        const { runSnapshotter } = await import("./dashboard/savings_snapshotter.js");
        const cadence = (String(q.cadence ?? "4h") === "daily" ? "daily" : "4h") as "4h" | "daily";
        const anchor = q.anchor ? new Date(String(q.anchor)) : undefined;
        const result = await runSnapshotter(cadence, { force: true, anchor });
        reply.send({ ok: true, mode: "force", ...result });
      } else {
        const { maybeRunSnapshotter } = await import("./dashboard/savings_snapshotter.js");
        await maybeRunSnapshotter();
        reply.send({ ok: true, mode: "cooldown-checked" });
      }
    } catch (e) {
      reply.send({ ok: false, error: (e as Error).message });
    }
  });

  // v0.18.8 — trend data + per-agent + anti-patterns for the project's panel
  app.get("/dashboard/savings/trend", async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const projectHash = String(q.project ?? "").trim();
    const cadence     = (String(q.cadence ?? "daily") === "4h" ? "4h" : "daily") as "4h" | "daily";
    const count       = Math.max(1, Math.min(60, parseInt(String(q.count ?? (cadence === "daily" ? 30 : 24)), 10) || 30));
    if (!/^[0-9a-f]{16}$/.test(projectHash)) {
      reply.type("text/html").send(`<div class="empty">Pick a project for trend data.</div>`);
      return;
    }
    try {
      const { fetchTrend, renderTrendSparkline, detectAntiPatterns,
              renderAntiPatterns, renderPerAgentBreakdown } = await import("./dashboard/savings_snapshotter.js");
      const points = await fetchTrend(projectHash, cadence, count);

      // Latest snapshot for per_agent breakdown
      let perAgentHtml = "";
      try {
        const { withClient } = await import("./pg_pool.js");
        const latest = await withClient(async (c) => {
          const res = await c.query<{ per_agent: unknown }>(
            `SELECT per_agent FROM token_savings_snapshots_pg
              WHERE project_hash = $1 AND cadence = $2
              ORDER BY period_start DESC LIMIT 1`,
            [projectHash, cadence],
          );
          return res.rows[0]?.per_agent;
        });
        if (latest) {
          const perAgent = typeof latest === "string" ? JSON.parse(latest) : (latest as Record<string, never>);
          perAgentHtml = renderPerAgentBreakdown(perAgent);
        }
      } catch { /* tolerate */ }

      const antiPatterns     = await detectAntiPatterns(projectHash);
      const antiPatternsHtml = renderAntiPatterns(antiPatterns);
      const trendHtml        = renderTrendSparkline(points);
      reply.type("text/html").send(trendHtml + perAgentHtml + antiPatternsHtml);
    } catch (e) {
      reply.type("text/html").send(`<div class="error">Failed to load trend: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  app.get("/dashboard/savings/projects", async (_request, reply) => {
    // Returns the list of projects that have ANY tool_calls — for the picker
    const { withClient } = await import("./pg_pool.js");
    const { loadProjectNameMap } = await import("./dashboard/render.js");
    try {
      const rows = await withClient(async (c) => {
        const res = await c.query<{ project_hash: string; n: string }>(
          `SELECT project_hash, COUNT(*)::text AS n
             FROM tool_calls_pg
            WHERE ts > now() - interval '30 days'
            GROUP BY project_hash
            ORDER BY n DESC LIMIT 20`,
        );
        return res.rows;
      });
      const nameMap = await loadProjectNameMap();
      const opts = rows.map((r) => {
        const name = nameMap.get(r.project_hash) ?? `project:${r.project_hash.slice(0, 8)}…`;
        return `<option value="${escapeHtml(r.project_hash)}">${escapeHtml(name)} (${r.n} calls)</option>`;
      }).join("");
      reply.type("text/html").send(opts || `<option value="">(no projects with activity)</option>`);
    } catch (e) {
      reply.type("text/html").send(`<option value="">Error loading projects: ${escapeHtml((e as Error).message)}</option>`);
    }
  });

  // v0.21.0 lever #1 — return active skills for a role. Used by
  // A2A_dispatcher/generate-role-skill-block.mjs at agent spawn to format
  // the "## YOUR SKILLS" block. Public read-only (skill IDs + names +
  // descriptions are not sensitive).
  app.get("/api/v1/skills/by-role", async (request, reply) => {
    try {
      const { role } = request.query as Record<string, unknown>;
      if (typeof role !== "string" || !role) throw new ApiError(400, "role query param is required");
      const { withClient: wc } = await import("./pg_pool.js");
      const rows = await wc(async (c) => {
        const r = await c.query<{ skill_id: string; name: string; version: string; scope: string; description: string }>(
          `SELECT skill_id, name, version, scope, description FROM skills_pg
            WHERE archived_at IS NULL
              AND frontmatter::text ILIKE $1
              AND frontmatter::text ILIKE '%intended_roles%'
            ORDER BY name`,
          [`%${role}%`],
        );
        return r.rows;
      });
      reply.type("application/json").send({ ok: true, role, skills: rows });
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      reply.status(500).type("application/json").send({ error: (e as Error).message });
    }
  });

  // v0.26.0 Step 4 — Return the expected HMAC for a script bundled inside a
  // filesystem-style skill. Consumed by the PreToolUse hook
  // (~/.claude/hooks/skill-script-hmac-verify.mjs) which intercepts Bash calls
  // that invoke ~/.claude/skills/<name>/scripts/... and verifies the on-disk
  // HMAC matches what was stored at admission time.
  //
  // Response shape:
  //   { expected: <hex hmac> | null,
  //     quarantined: boolean,
  //     quarantine_reason: string | null }
  //
  // Returns 404 only if the SKILL itself isn't known; if the skill is known
  // but the requested script path isn't in script_hmacs, returns expected:null
  // so the hook fails closed (it's treated as "no admission record → block").
  app.get("/api/v1/skills/:name/script-hmac", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const { path: scriptPath } = request.query as Record<string, unknown>;
      if (!name || typeof name !== "string") throw new ApiError(400, "skill name path param is required");
      if (typeof scriptPath !== "string" || !scriptPath) throw new ApiError(400, "path query param is required (e.g. scripts/foo.py)");
      const { withClient: wc } = await import("./pg_pool.js");
      const row = await wc(async (c) => {
        const r = await c.query<{ script_hmacs: Record<string, string> | null; quarantined: boolean; quarantine_reason: string | null }>(
          `SELECT script_hmacs, quarantined, quarantine_reason
             FROM skills_pg
            WHERE name = $1 AND archived_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1`,
          [name],
        );
        return r.rows[0] ?? null;
      });
      if (!row) return reply.status(404).type("application/json").send({ error: `skill not found: ${name}` });
      const expected = row.script_hmacs && typeof row.script_hmacs === "object"
        ? row.script_hmacs[scriptPath] ?? null
        : null;
      reply.type("application/json").send({
        expected,
        quarantined: row.quarantined === true,
        quarantine_reason: row.quarantine_reason ?? null,
      });
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).type("application/json").send({ error: e.message });
      reply.status(500).type("application/json").send({ error: (e as Error).message });
    }
  });

  // v0.26.0 Step 4 — Server-side script HMAC verification. The PreToolUse hook
  // calls this so it doesn't need access to the machine_secret (which lives in
  // the container's api_state volume, not on the host filesystem).
  //
  // Request: GET /api/v1/skills/:name/verify-script?path=scripts/foo.py
  //          [&skill_dir=/abs/path] (optional; defaults to ~/.claude/skills/:name)
  //
  // The server:
  //   1. Looks up the skill in skills_pg (must be non-archived, non-quarantined)
  //   2. Resolves the file under its bind-mounted view of ~/.claude/skills/<name>/
  //   3. Computes HMAC-SHA256("script:" || content) with machine_secret
  //   4. Compares to stored value in script_hmacs JSONB
  //
  // Response:
  //   { verified: bool, quarantined: bool, has_admission: bool,
  //     reason: <description if not verified>, expected_present: bool }
  app.get("/api/v1/skills/:name/verify-script", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const { path: scriptPath } = request.query as Record<string, unknown>;
      if (!name || typeof name !== "string") throw new ApiError(400, "skill name path param is required");
      if (typeof scriptPath !== "string" || !scriptPath) throw new ApiError(400, "path query param required (e.g. scripts/foo.py)");

      // Basic path-traversal defense — only allow paths inside scripts/, references/, resources/
      if (scriptPath.includes("..") || scriptPath.startsWith("/") || scriptPath.startsWith("\\")) {
        throw new ApiError(400, "invalid path: traversal segments are not allowed");
      }

      const { withClient: wc } = await import("./pg_pool.js");
      const row = await wc(async (c) => {
        const r = await c.query<{
          skill_dir: string | null;
          script_hmacs: Record<string, string> | null;
          quarantined: boolean;
          quarantine_reason: string | null;
        }>(
          `SELECT skill_dir, script_hmacs, quarantined, quarantine_reason
             FROM skills_pg
            WHERE name = $1 AND archived_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1`,
          [name],
        );
        return r.rows[0] ?? null;
      });

      if (!row) {
        return reply.status(404).type("application/json").send({
          verified: false, has_admission: false, quarantined: false,
          expected_present: false, reason: `skill not found in registry: ${name}`,
        });
      }
      if (row.quarantined) {
        return reply.type("application/json").send({
          verified: false, has_admission: true, quarantined: true,
          expected_present: false,
          reason: `skill QUARANTINED: ${row.quarantine_reason ?? "see dashboard"}`,
        });
      }
      const expected = row.script_hmacs && typeof row.script_hmacs === "object"
        ? row.script_hmacs[scriptPath] ?? null
        : null;
      if (!expected) {
        return reply.type("application/json").send({
          verified: false, has_admission: false, quarantined: false,
          expected_present: false,
          reason: `no HMAC on record for ${name}/${scriptPath} (script not admitted)`,
        });
      }

      // Resolve absolute path. If skill_dir was recorded at admission, use it;
      // otherwise default to ~/.claude/skills/<name>/.
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      const { existsSync, readFileSync } = await import("node:fs");
      const skillRoot = row.skill_dir ?? join(homedir(), ".claude", "skills", name);
      const abs = join(skillRoot, scriptPath);

      // Security: ensure the resolved path is still under the expected skill root.
      const { resolve } = await import("node:path");
      const absResolved = resolve(abs);
      const rootResolved = resolve(skillRoot);
      if (!absResolved.startsWith(rootResolved)) {
        return reply.status(400).type("application/json").send({
          verified: false, has_admission: true, quarantined: false,
          expected_present: true,
          reason: `resolved script path escapes skill root: ${absResolved}`,
        });
      }
      if (!existsSync(abs)) {
        return reply.status(404).type("application/json").send({
          verified: false, has_admission: true, quarantined: false,
          expected_present: true,
          reason: `script not found on disk: ${scriptPath}`,
        });
      }

      const { getMachineSecret } = await import("./security/machine_secret.js");
      const { createHmac } = await import("node:crypto");
      const content = readFileSync(abs);
      const actual = createHmac("sha256", getMachineSecret())
        .update("script:")
        .update(content)
        .digest("hex");

      const verified = actual === expected;
      reply.type("application/json").send({
        verified,
        has_admission: true,
        quarantined: false,
        expected_present: true,
        reason: verified
          ? null
          : `HMAC mismatch: expected=${expected.slice(0, 16)}... actual=${actual.slice(0, 16)}... (script tampered after admission)`,
      });
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).type("application/json").send({ error: e.message });
      reply.status(500).type("application/json").send({ error: (e as Error).message });
    }
  });

  // v0.27.0 — Trigger admission import on a specific project directory.
  // Use this to admit project-scoped skills at <projectPath>/.claude/skills/<name>/.
  // The project path must be readable by the container (bind-mounted).
  app.post("/api/v1/skills/import-project", async (request, reply) => {
    try {
      const { path: projectPath } = request.query as Record<string, unknown>;
      if (typeof projectPath !== "string" || !projectPath) {
        return reply.status(400).type("application/json").send({ error: "path query param required" });
      }
      const { importFilesystemSkills } = await import("./skills/filesystem_skill_import.js");
      const summary = await importFilesystemSkills({ projectPaths: [projectPath] });
      reply.type("application/json").send(summary);
    } catch (e) {
      reply.status(500).type("application/json").send({ error: (e as Error).message });
    }
  });

  // v0.26.0 Step 6 — Verify the HMAC chain of the skill admission log.
  // Public read endpoint (everyone with access to the API can ask "is the
  // audit trail tamper-free?"). The verification recomputes every row's
  // HMAC using the machine_secret and walks prev_hash linkage.
  //
  // Response:
  //   { ok: bool, total_rows: number, broken_at?: id, broken_kind?: string }
  app.get("/api/v1/skills/admission-log/verify", async (_request, reply) => {
    try {
      const { verifyAdmissionChain } = await import("./skills/admission_log.js");
      const result = await verifyAdmissionChain();
      reply.type("application/json").send({
        ok: result.ok,
        total_rows: result.totalRows,
        broken_at: result.brokenAt ?? null,
        broken_kind: result.brokenKind ?? null,
      });
    } catch (e) {
      reply.status(500).type("application/json").send({ error: (e as Error).message });
    }
  });

  // v0.28.0-α — Skill-spotter dry-run: detector library mines tool_calls_pg +
  // pretool_events_pg for repeated patterns and writes them as observed
  // signals to skill_spotter_signals_pg. No LLM, no candidate filing —
  // operator inspects via the dashboard and decides whether the signal
  // quality is strong enough to enable the β step's spotter agent.
  app.post("/api/v1/skills/spotter/dry-run", async (request, reply) => {
    try {
      const { days, ngram, min_occurrences } = request.query as Record<string, unknown>;
      const opts = {
        windowDays:     days ? Math.max(1, Math.min(90, parseInt(String(days), 10) || 7)) : 7,
        ngram:          ngram ? Math.max(2, Math.min(5, parseInt(String(ngram), 10) || 3)) : 3,
        minOccurrences: min_occurrences ? Math.max(2, Math.min(20, parseInt(String(min_occurrences), 10) || 3)) : 3,
      };
      const { runSpotterDryRun } = await import("./skills/spotter/run.js");
      const summary = await runSpotterDryRun(opts);
      reply.type("application/json").send(summary);
    } catch (e) {
      reply.status(500).type("application/json").send({ error: (e as Error).message });
    }
  });

  // v0.28.0-α — List recent spotter runs (read-only).
  app.get("/api/v1/skills/spotter/runs", async (request, reply) => {
    try {
      const { limit } = request.query as Record<string, unknown>;
      const lim = limit ? Math.max(1, Math.min(200, parseInt(String(limit), 10) || 20)) : 20;
      const { listSpotterRuns } = await import("./skills/spotter/run.js");
      const runs = await listSpotterRuns(lim);
      reply.type("application/json").send({ runs });
    } catch (e) {
      reply.status(500).type("application/json").send({ error: (e as Error).message });
    }
  });

  // v0.28.0-α — Signals from one run.
  app.get("/api/v1/skills/spotter/runs/:run_id", async (request, reply) => {
    try {
      const { run_id } = request.params as { run_id: string };
      const { listSpotterSignals } = await import("./skills/spotter/run.js");
      const signals = await listSpotterSignals(run_id);
      reply.type("application/json").send({ run_id, signals });
    } catch (e) {
      reply.status(500).type("application/json").send({ error: (e as Error).message });
    }
  });

  // v0.28.0-β — Run the LLM filer on a specific spotter run. Spawns the
  // claude CLI subprocess with sonnet-4-6, applies the four Anthropic
  // skill-quality gates to each observed signal, files matching ones as
  // skill_candidates_pg rows with status='ready' (operator approves to
  // trigger the existing mutator-generated body → admission flow).
  //
  // Cost: ~$0.15 per run with the operator's Pro plan. Time: ~30-90s.
  //
  // POST /api/v1/skills/spotter/runs/:run_id/llm-file
  //   [?model=claude-sonnet-4-6] [?timeout_ms=300000]
  app.post("/api/v1/skills/spotter/runs/:run_id/llm-file", async (request, reply) => {
    try {
      const { run_id } = request.params as { run_id: string };
      const { model, timeout_ms } = request.query as Record<string, unknown>;
      const { runSpotterLlmFiler } = await import("./skills/spotter/llm_filer.js");
      const result = await runSpotterLlmFiler({
        run_id,
        model:      typeof model === "string" && model.trim() ? model : undefined,
        timeout_ms: timeout_ms ? Math.max(60_000, Math.min(900_000, parseInt(String(timeout_ms), 10) || 300_000)) : undefined,
      });
      reply.type("application/json").send(result);
    } catch (e) {
      reply.status(500).type("application/json").send({ error: (e as Error).message });
    }
  });

  // v0.28.0-α — Dashboard HTML fragments for the spotter panel.
  app.get("/dashboard/spotter/runs", async (_request, reply) => {
    try {
      const { listSpotterRuns } = await import("./skills/spotter/run.js");
      const runs = await listSpotterRuns(15);
      if (runs.length === 0) {
        reply.type("text/html").send(`<p class="empty">No spotter runs yet. Click "Run dry-run" to mine 7 days of activity for repeated patterns.</p>`);
        return;
      }
      const html = `
        <table class="spotter-runs-table">
          <thead><tr><th>When</th><th>Mode</th><th>Window</th><th>Signals</th><th>Candidates filed</th><th>Duration</th><th></th></tr></thead>
          <tbody>
            ${runs.map((r) => `
              <tr>
                <td style="color:#94a3b8; font-size:0.84rem">${escapeHtml(r.started_at.slice(0, 19))}</td>
                <td><span class="evt-badge evt-info">${escapeHtml(r.mode)}</span></td>
                <td>${r.window_days}d</td>
                <td><strong>${r.signals_emitted}</strong></td>
                <td>${r.candidates_filed}</td>
                <td style="color:#94a3b8">${r.duration_ms ?? "?"} ms</td>
                <td><button class="link-btn"
                            hx-get="/dashboard/spotter/runs/${encodeURIComponent(r.run_id)}"
                            hx-target="#spotter-run-detail"
                            hx-swap="innerHTML">view signals →</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <div id="spotter-run-detail" style="margin-top:12px"></div>
      `;
      reply.type("text/html").send(html);
    } catch (e) {
      reply.type("text/html").send(`<div class="error">Failed to load spotter runs: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  app.get("/dashboard/spotter/runs/:run_id", async (request, reply) => {
    try {
      const { run_id } = request.params as { run_id: string };
      const { listSpotterSignals } = await import("./skills/spotter/run.js");
      const signals = await listSpotterSignals(run_id, 50);
      if (signals.length === 0) {
        reply.type("text/html").send(`<p class="empty">This run found zero signals. Try widening the window with <code>days=30</code> or lowering <code>min_occurrences</code>.</p>`);
        return;
      }
      const observed = signals.filter((s) => s.outcome === "observed").length;
      const filed = signals.filter((s) => s.outcome === "filed_candidate").length;
      const llmButton = observed > 0
        ? `<button class="pull-marketplace-btn"
                  hx-post="/dashboard/spotter/runs/${encodeURIComponent(run_id)}/llm-file"
                  hx-target="#spotter-llm-result" hx-swap="innerHTML"
                  hx-on:htmx:before-request="this.disabled=true; this.textContent='Calling claude-sonnet-4-6 (30-90s)...'"
                  hx-on:htmx:after-request="this.disabled=false; this.textContent='🤖 Run LLM filer (sonnet-4-6)'; htmx.trigger('#spotter-runs-list', 'refresh')">
            🤖 Run LLM filer (sonnet-4-6) — files candidates for ${observed} observed signal${observed === 1 ? "" : "s"}
          </button>`
        : `<span class="market-meta">All signals from this run have been classified by the LLM filer. ${filed} candidate${filed === 1 ? "" : "s"} filed.</span>`;
      const html = `
        <div class="spotter-signals">
          <h4 style="color:#94a3b8; margin-top:0">${signals.length} signal${signals.length === 1 ? "" : "s"} from run ${escapeHtml(run_id.slice(0, 8))}…</h4>
          <div style="margin: 8px 0 12px">${llmButton}</div>
          <div id="spotter-llm-result"></div>
          ${signals.map((s) => {
            const ev = s.evidence as Record<string, unknown> | null;
            const seq = (ev?.tool_sequence as string[] | undefined)?.join(" → ") ?? "";
            const files = (ev?.file_paths as string[] | undefined)?.join(", ") ?? "";
            const ssn = (ev?.session_ids as string[] | undefined) ?? [];
            const outcome = s.outcome ?? "observed";
            const outcomeBadge = outcome === "observed"
              ? `<span class="evt-badge evt-info">observed</span>`
              : outcome === "filed_candidate"
                ? `<span class="evt-badge evt-ok">filed_candidate</span>`
                : `<span class="evt-badge evt-quar">${escapeHtml(outcome)}</span>`;
            return `
              <div class="signal-row">
                <div class="signal-header">
                  <span class="evt-badge evt-info">${escapeHtml(s.signal_type)}</span>
                  <span style="margin-left:8px">×${s.occurrences} sessions</span>
                  <span style="margin-left:8px; color:#94a3b8">confidence ${s.confidence}</span>
                  <span style="margin-left:8px; color:#94a3b8">effort: ${escapeHtml(s.effort_estimate ?? "?")}</span>
                  <span style="margin-left:8px">${outcomeBadge}</span>
                </div>
                ${s.proposed_name_hint ? `<div class="signal-name">name hint: <code>${escapeHtml(s.proposed_name_hint)}</code></div>` : ""}
                ${s.proposed_trigger ? `<div class="signal-trigger"><em>${escapeHtml(s.proposed_trigger)}</em></div>` : ""}
                ${seq ? `<div class="signal-evidence">sequence: <code>${escapeHtml(seq)}</code></div>` : ""}
                ${files ? `<div class="signal-evidence">file(s): <code>${escapeHtml(files)}</code></div>` : ""}
                ${ssn.length > 0 ? `<div class="signal-evidence" style="color:#94a3b8; font-size:0.78rem">sessions: ${escapeHtml(ssn.slice(0, 3).join(", "))}${ssn.length > 3 ? ` (+${ssn.length - 3} more)` : ""}</div>` : ""}
                ${s.outcome_reason ? `<div class="signal-evidence" style="color:#fca5a5; font-size:0.84rem">LLM verdict: ${escapeHtml(s.outcome_reason)}</div>` : ""}
              </div>
            `;
          }).join("")}
        </div>
      `;
      reply.type("text/html").send(html);
    } catch (e) {
      reply.type("text/html").send(`<div class="error">Failed to load signals: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.28.0-β — POST handler: triggers LLM filer + returns inline summary fragment.
  app.post("/dashboard/spotter/runs/:run_id/llm-file", async (request, reply) => {
    try {
      const { run_id } = request.params as { run_id: string };
      const { runSpotterLlmFiler } = await import("./skills/spotter/llm_filer.js");
      const result = await runSpotterLlmFiler({ run_id });
      const errorsHtml = result.errors.length > 0
        ? `<div style="color:#fca5a5; margin-top:6px">Errors: ${result.errors.map(e => escapeHtml(e)).join("; ")}</div>`
        : "";
      reply.type("text/html").send(`
        <div class="spotter-result">
          <p><strong>LLM filer complete</strong> — ${result.signals_processed} signal${result.signals_processed === 1 ? "" : "s"} classified · <strong>${result.candidates_filed}</strong> candidate${result.candidates_filed === 1 ? "" : "s"} filed · ${result.llm_duration_ms}ms</p>
          <div style="margin-top:6px">
            ${Object.entries(result.by_outcome)
              .filter(([_, n]) => n > 0)
              .map(([t, n]) => `<span class="evt-badge evt-info" style="margin-right:6px">${escapeHtml(t)} ×${n}</span>`)
              .join("")}
          </div>
          ${errorsHtml}
        </div>
      `);
    } catch (e) {
      reply.type("text/html").send(`<div class="error">LLM filer failed: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.28.0-α — POST handler: triggers dry-run + returns the signals fragment.
  app.post("/dashboard/spotter/dry-run", async (request, reply) => {
    try {
      const { days } = request.query as Record<string, unknown>;
      const windowDays = days ? Math.max(1, Math.min(90, parseInt(String(days), 10) || 7)) : 7;
      const { runSpotterDryRun } = await import("./skills/spotter/run.js");
      const summary = await runSpotterDryRun({ windowDays });
      reply.type("text/html").send(`
        <div class="spotter-result">
          <p><strong>Run ${escapeHtml(summary.run_id.slice(0, 8))}…</strong> · ${summary.signals_emitted} signal${summary.signals_emitted === 1 ? "" : "s"} in ${summary.duration_ms} ms · window ${summary.window_days}d</p>
          ${Object.entries(summary.signals_by_type).map(([t, n]) => `<span class="evt-badge evt-info" style="margin-right:6px">${escapeHtml(t)} ×${n}</span>`).join("")}
        </div>
      `);
    } catch (e) {
      reply.type("text/html").send(`<div class="error">Dry-run failed: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.26.0 Step 6 — Return recent admission log rows for dashboard display.
  app.get("/api/v1/skills/admission-log", async (request, reply) => {
    try {
      const { limit } = request.query as Record<string, unknown>;
      const lim = Math.min(Math.max(parseInt(String(limit ?? 50), 10) || 50, 1), 500);
      const { withClient: wc } = await import("./pg_pool.js");
      const rows = await wc(async (c) => {
        const r = await c.query(
          `SELECT id, ts, event, skill_name, skill_version, skill_scope,
                  skill_dir, body_hmac, script_count, quarantined, reason,
                  prev_hash, row_hash
             FROM skill_admission_log_pg
            ORDER BY id DESC
            LIMIT $1`,
          [lim],
        );
        return r.rows;
      });
      reply.type("application/json").send({ rows });
    } catch (e) {
      reply.status(500).type("application/json").send({ error: (e as Error).message });
    }
  });

  // v0.20.0 — Generate skill body from rejection cluster (LLM-driven)
  app.post("/dashboard/skill-candidates/:id/generate", async (request, reply) => {
    try {
      const candId = (request.params as { id: string }).id;
      const { generateForCandidate } = await import("./skill_candidate_generator.js");
      const result = await generateForCandidate(candId);
      reply.type("application/json").send(result);
    } catch (e) {
      reply.status(500).type("application/json").send({ ok: false, error: (e as Error).message });
    }
  });

  // v0.20.0 — Approve a generated candidate: write the proposed body to skills/
  // (the next auto-import will pick it up + mark candidate superseded)
  app.post("/dashboard/skill-candidates/:id/approve", async (request, reply) => {
    try {
      const candId = (request.params as { id: string }).id;
      const { withClient: wc } = await import("./pg_pool.js");
      const row = await wc(async (c) => {
        const r = await c.query<{ proposed_skill_body: string | null; target_role: string; status: string }>(
          `SELECT proposed_skill_body, target_role, status FROM skill_candidates_pg WHERE candidate_id=$1`,
          [candId],
        );
        return r.rows[0] ?? null;
      });
      if (!row) return reply.status(404).type("application/json").send({ ok: false, error: "Candidate not found" });
      if (row.status !== "ready" || !row.proposed_skill_body) {
        return reply.status(400).type("application/json").send({ ok: false, error: `Candidate not ready (status=${row.status}). Run /generate first.` });
      }
      // Write to skills/ then trigger auto-import. File name: <role>-from-rejections-<short>.skill.md
      const { writeFileSync, existsSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const skillsDir = process.env.ZC_SKILLS_DIR ?? "/app/skills";
      if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });
      const filename = `${row.target_role}-from-rejections-${candId.slice(-8)}.skill.md`;
      const fullPath = join(skillsDir, filename);
      writeFileSync(fullPath, row.proposed_skill_body, "utf-8");

      // Auto-import + mark approved
      const { autoImportSkills } = await import("./skill_auto_import.js");
      const importSummary = await autoImportSkills();
      await wc(async (c) => {
        await c.query(
          `UPDATE skill_candidates_pg SET status='approved', reviewed_at=now(),
              installed_skill_id = (
                SELECT skill_id FROM skills_pg WHERE source_path=$2 AND archived_at IS NULL LIMIT 1
              )
            WHERE candidate_id=$1`,
          [candId, fullPath],
        );
      });
      reply.type("application/json").send({
        ok: true, written_to: fullPath, filename,
        imported: { inserted: importSummary.inserted, updated: importSummary.updated },
      });
    } catch (e) {
      reply.status(500).type("application/json").send({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/dashboard/skill-candidates/:id/reject", async (request, reply) => {
    try {
      const candId = (request.params as { id: string }).id;
      const body   = request.body as Record<string, unknown>;
      const notes  = typeof body.notes === "string" ? body.notes.slice(0, 500) : null;
      const { withClient: wc } = await import("./pg_pool.js");
      await wc(async (c) => {
        await c.query(
          `UPDATE skill_candidates_pg SET status='rejected', reviewed_at=now(), review_notes=$2 WHERE candidate_id=$1`,
          [candId, notes],
        );
      });
      reply.type("application/json").send({ ok: true });
    } catch (e) {
      reply.status(500).type("application/json").send({ ok: false, error: (e as Error).message });
    }
  });

  // v0.20.0 — manual trigger to re-import skills from disk into skills_pg.
  // Useful when the operator drops a new *.skill.md into skills/ and doesn't
  // want to restart the container. Idempotent.
  app.post("/dashboard/skills/import", async (_request, reply) => {
    try {
      const { autoImportSkills } = await import("./skill_auto_import.js");
      const summary = await autoImportSkills({ verbose: false });
      reply.type("application/json").send({ ok: true, summary });
    } catch (e) {
      reply.status(500).type("application/json").send({ ok: false, error: (e as Error).message });
    }
  });

  // v0.23.0 Phase 1 F — Tag a skill_run as an operator-exemplar. The
  // mutator uses these as positive training signal: when generating new
  // candidates for a skill, exemplar runs are quoted in the proposer
  // prompt as "this is what good looks like."
  app.post("/dashboard/skill-runs/:run_id/tag-exemplar", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const runId = String(params.run_id ?? "").trim();
    const body = request.body as Record<string, unknown> | null;
    const operator = typeof body?.operator === "string" ? body.operator : "operator";
    const note = typeof body?.note === "string" ? body.note.slice(0, 1024) : null;
    const isExemplar = body?.is_exemplar !== false;  // default true unless explicitly false
    if (!runId) {
      reply.status(400).type("application/json").send({ ok: false, error: "missing run_id" });
      return;
    }
    try {
      const { withClient } = await import("./pg_pool.js");
      const updated = await withClient(async (c) => {
        const r = await c.query(
          `UPDATE skill_runs_pg
              SET is_exemplar = $1,
                  exemplar_tagged_by = CASE WHEN $1 THEN $2 ELSE NULL END,
                  exemplar_tagged_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
                  exemplar_note = CASE WHEN $1 THEN $3 ELSE NULL END
            WHERE run_id = $4
            RETURNING run_id, skill_id, is_exemplar, exemplar_tagged_by, exemplar_tagged_at`,
          [isExemplar, operator, note, runId],
        );
        return r.rows[0] ?? null;
      });
      if (!updated) {
        reply.status(404).type("application/json").send({ ok: false, error: `skill_run ${runId} not found` });
        return;
      }
      reply.type("application/json").send({ ok: true, run: updated });
    } catch (e) {
      reply.status(500).type("application/json").send({ ok: false, error: (e as Error).message });
    }
  });

  // v0.23.2 — HTML variant for the dashboard ⭐ button. Same DB write, but
  // returns a single rendered <tr> so HTMX can swap it inline in the runs
  // table. The note comes from HTMX's hx-prompt header (operator's typed
  // input on click).
  app.post("/dashboard/skill-runs/:run_id/tag-exemplar/html", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const runId = String(params.run_id ?? "").trim();
    // HTMX URL-encodes the HX-Prompt header value because HTTP headers can't
    // carry raw non-ASCII bytes (em dashes, emoji, multi-byte UTF-8). Without
    // decodeURIComponent here the operator's note lands in PG as
    // "Hello%20world%20%E2%80%94" instead of "Hello world —". Caught in
    // browser E2E click-through.
    const headers = request.headers as Record<string, string | string[] | undefined>;
    const promptRaw = headers["hx-prompt"];
    let note: string | null = null;
    if (typeof promptRaw === "string" && promptRaw.length > 0) {
      try { note = decodeURIComponent(promptRaw).slice(0, 1024); }
      catch { note = promptRaw.slice(0, 1024); }  // graceful fallback if not valid percent-encoding
    }
    if (!runId) {
      reply.status(400).type("text/html").send(`<tr><td colspan="6" class="error">missing run_id</td></tr>`);
      return;
    }
    try {
      const { withClient } = await import("./pg_pool.js");
      const updated = await withClient(async (c) => {
        const r = await c.query(
          `UPDATE skill_runs_pg
              SET is_exemplar = TRUE,
                  exemplar_tagged_by = $1,
                  exemplar_tagged_at = NOW(),
                  exemplar_note = $2
            WHERE run_id = $3
            RETURNING run_id, skill_id, status, outcome_score, ts, agent_id,
                      is_exemplar, exemplar_note`,
          ["operator", note, runId],
        );
        return r.rows[0] ?? null;
      });
      if (!updated) {
        reply.status(404).type("text/html").send(`<tr><td colspan="6" class="error">run ${escapeHtml(runId)} not found</td></tr>`);
        return;
      }
      const { renderSkillRunRow } = await import("./dashboard/render.js");
      const html = renderSkillRunRow({
        run_id:        updated.run_id,
        skill_id:      updated.skill_id,
        status:        updated.status,
        outcome_score: updated.outcome_score === null ? null : Number(updated.outcome_score),
        ts:            updated.ts instanceof Date ? updated.ts.toISOString() : String(updated.ts),
        agent_id:      updated.agent_id,
        is_exemplar:   Boolean(updated.is_exemplar),
        exemplar_note: updated.exemplar_note,
      });
      reply.type("text/html").send(html);
    } catch (e) {
      reply.status(500).type("text/html").send(`<tr><td colspan="6" class="error">error: ${escapeHtml((e as Error).message)}</td></tr>`);
    }
  });

  // v0.23.2 — Recent skill_runs for a skill (HTML for HTMX)
  app.get("/dashboard/skills/:id/runs", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const skillId = String(params.id ?? "").trim();
    if (!skillId) {
      reply.status(400).type("text/html").send(`<div class="error">missing skill_id</div>`);
      return;
    }
    try {
      const { withClient } = await import("./pg_pool.js");
      const rows = await withClient(async (c) => {
        const r = await c.query(
          `SELECT run_id, skill_id, status, outcome_score, ts, agent_id,
                  is_exemplar, exemplar_note
             FROM skill_runs_pg
             WHERE skill_id = $1
             ORDER BY ts DESC
             LIMIT 50`,
          [skillId],
        );
        return r.rows;
      });
      const { renderSkillRunsFragment } = await import("./dashboard/render.js");
      const html = renderSkillRunsFragment(skillId, rows.map((r: Record<string, unknown>) => ({
        run_id:        String(r.run_id),
        skill_id:      String(r.skill_id),
        status:        String(r.status),
        outcome_score: r.outcome_score === null ? null : Number(r.outcome_score),
        ts:            r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
        agent_id:      r.agent_id === null ? null : String(r.agent_id),
        is_exemplar:   Boolean(r.is_exemplar),
        exemplar_note: r.exemplar_note === null ? null : String(r.exemplar_note),
      })));
      reply.type("text/html").send(html);
    } catch (e) {
      reply.status(500).type("text/html").send(`<div class="error">error: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.23.2 — Security scan history for a skill (HTML for HTMX)
  app.get("/dashboard/skills/:id/security", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const skillId = String(params.id ?? "").trim();
    if (!skillId) {
      reply.status(400).type("text/html").send(`<div class="error">missing skill_id</div>`);
      return;
    }
    try {
      const { withClient } = await import("./pg_pool.js");
      const rows = await withClient(async (c) => {
        const r = await c.query(
          `SELECT scanned_at, score, passed, source, failures
             FROM skill_security_scans_pg
             WHERE skill_id = $1
             ORDER BY scanned_at DESC
             LIMIT 30`,
          [skillId],
        );
        return r.rows;
      });
      const { renderSecurityScansFragment } = await import("./dashboard/render.js");
      const html = renderSecurityScansFragment(skillId, rows.map((r: Record<string, unknown>) => ({
        scanned_at: r.scanned_at instanceof Date ? r.scanned_at.toISOString() : String(r.scanned_at),
        score:      Number(r.score),
        passed:     Boolean(r.passed),
        source:     String(r.source),
        failures:   typeof r.failures === "string" ? JSON.parse(r.failures) : (r.failures as Array<{ name: string; severity: string; detail: string | null }>),
      })));
      reply.type("text/html").send(html);
    } catch (e) {
      reply.status(500).type("text/html").send(`<div class="error">error: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.23.2 — HTML wrapper around the JSON polish endpoint. Same logic, but
  // returns a rendered preview <div> with the diff + Apply button.
  app.post("/dashboard/skills/:id/polish/html", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const skillId = String(params.id ?? "").trim();
    if (!skillId) {
      reply.status(400).type("text/html").send(`<div class="error">missing skill_id</div>`);
      return;
    }
    try {
      const { withClient } = await import("./pg_pool.js");
      const skill = await withClient(async (c) => {
        const r = await c.query("SELECT skill_id, frontmatter, body, body_hmac FROM skills_pg WHERE skill_id = $1 AND archived_at IS NULL", [skillId]);
        if (r.rows.length === 0) return null;
        const row = r.rows[0];
        return {
          skill_id: row.skill_id,
          frontmatter: typeof row.frontmatter === "string" ? JSON.parse(row.frontmatter) : row.frontmatter,
          body: row.body,
          body_hmac: row.body_hmac,
          source_path: null,
          promoted_from: null,
          created_at: new Date().toISOString(),
          archived_at: null,
          archive_reason: null,
        };
      });
      if (!skill) {
        reply.status(404).type("text/html").send(`<div class="error">skill ${escapeHtml(skillId)} not found or archived</div>`);
        return;
      }
      const { polishSkillDescription } = await import("./skills/polisher.js");
      const result = await polishSkillDescription(skill);
      const { renderPolishPreview } = await import("./dashboard/render.js");
      const html = renderPolishPreview({
        skill_id:      skill.skill_id,
        original:      result.original,
        polished:      result.polished,
        lint_passed:   result.lint_passed,
        lint_warnings: result.lint_warnings,
        lint_errors:   result.lint_errors,
        backend:       result.backend,
        duration_ms:   result.duration_ms,
      });
      reply.type("text/html").send(html);
    } catch (e) {
      reply.status(500).type("text/html").send(`<div class="error">polish error: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.24.1 — view active skill body (📄 View body button on each skill row)
  app.get("/dashboard/skills/:id/body", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const skillId = String(params.id ?? "").trim();
    if (!skillId) {
      reply.status(400).type("text/html").send(`<div class="error">missing skill_id</div>`);
      return;
    }
    try {
      const { withClient } = await import("./pg_pool.js");
      const row = await withClient(async (c) => {
        const r = await c.query<{ body: string }>(
          `SELECT body FROM skills_pg WHERE skill_id = $1 AND archived_at IS NULL`,
          [skillId],
        );
        return r.rows[0] ?? null;
      });
      if (!row) {
        reply.status(404).type("text/html").send(`<div class="error">skill ${escapeHtml(skillId)} not found or archived</div>`);
        return;
      }
      const body = row.body ?? "";
      const { renderSkillBody } = await import("./dashboard/render.js");
      reply.type("text/html").send(renderSkillBody({
        skill_id: skillId,
        body,
        body_len: body.length,
        body_lines: body.split("\n").length,
        source: "active",
      }));
    } catch (e) {
      reply.status(500).type("text/html").send(`<div class="error">view body error: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.24.1 — view body of a marketplace pull attempt (rejected or accepted)
  // by audit row id. Lets operator inspect the actual SKILL.md content of any
  // historic pull so they can decide whether to manually trim and retry.
  app.get("/dashboard/marketplace/pulls/row/:row_id/body", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const rowId = parseInt(String(params.row_id ?? ""), 10);
    if (!Number.isFinite(rowId)) {
      reply.status(400).type("text/html").send(`<div class="error">invalid row_id</div>`);
      return;
    }
    try {
      const { withClient } = await import("./pg_pool.js");
      const row = await withClient(async (c) => {
        const r = await c.query<{ skill_name: string; candidate_body: string | null; decision: string; decision_reason: string }>(
          `SELECT skill_name, candidate_body, decision, decision_reason
             FROM skill_marketplace_pulls_pg WHERE id = $1`,
          [rowId],
        );
        return r.rows[0] ?? null;
      });
      if (!row) {
        reply.status(404).type("text/html").send(`<div class="error">pull row ${rowId} not found</div>`);
        return;
      }
      if (!row.candidate_body) {
        reply.type("text/html").send(`<div class="skill-body-warning">No body stored for this pull attempt. (Pre-v0.24.1 audit rows didn't capture the body — only newer pulls have it.)</div>`);
        return;
      }
      const body = row.candidate_body;
      const { renderSkillBody } = await import("./dashboard/render.js");
      reply.type("text/html").send(renderSkillBody({
        skill_id: row.skill_name,
        body,
        body_len: body.length,
        body_lines: body.split("\n").length,
        source: row.decision === "added" ? "active" : "rejected_marketplace",
        reason: row.decision !== "added" ? `${row.decision} — ${row.decision_reason}` : undefined,
      }));
    } catch (e) {
      reply.status(500).type("text/html").send(`<div class="error">view pull-body error: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.25.3 — per-project skills-used rollup. Operator clicks 📋 Skills used
  // on a project row in Skill-activity health → expandable HTML table
  // showing exactly which skills the agents on this project loaded /
  // recorded outcomes for in the last 24h, with avg + latest score.
  app.get("/dashboard/projects/:hash/skills-used", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const projectHash = String(params.hash ?? "").trim();
    if (!projectHash) {
      reply.status(400).type("text/html").send(`<div class="error">missing project_hash</div>`);
      return;
    }
    try {
      const { withClient } = await import("./pg_pool.js");
      const { renderProjectSkillsUsed } = await import("./dashboard/render.js");
      // Combine tool_calls (zc_skill_show / zc_record_skill_outcome counts +
      // agents) with skill_runs (avg + latest score) per skill_id.
      const rows = await withClient(async (c) => {
        const r = await c.query<Record<string, unknown>>(
          `WITH tc AS (
             SELECT skill_id,
                    COUNT(*) FILTER (WHERE tool_name = 'zc_skill_show') AS shows,
                    COUNT(*) FILTER (WHERE tool_name = 'zc_record_skill_outcome') AS outcomes,
                    STRING_AGG(DISTINCT agent_id, ', ' ORDER BY agent_id) AS agents,
                    MAX(ts) AS last_used
               FROM tool_calls_pg
              WHERE project_hash = $1
                AND tool_name IN ('zc_skill_show', 'zc_record_skill_outcome')
                AND skill_id IS NOT NULL
                AND ts > NOW() - INTERVAL '24 hours'
              GROUP BY skill_id
           ),
           sr AS (
             SELECT skill_id,
                    COUNT(*) AS runs_24h,
                    AVG(outcome_score)::numeric(6,3) AS avg_score,
                    (ARRAY_AGG(outcome_score ORDER BY ts DESC))[1] AS latest_score
               FROM skill_runs_pg
              WHERE project_hash = $1
                AND ts > NOW() - INTERVAL '24 hours'
                AND outcome_score IS NOT NULL
              GROUP BY skill_id
           )
           SELECT COALESCE(tc.skill_id, sr.skill_id) AS skill_id,
                  COALESCE(tc.shows, 0)::text AS shows,
                  COALESCE(tc.outcomes, 0)::text AS outcomes,
                  COALESCE(sr.runs_24h, 0)::text AS runs_24h,
                  sr.avg_score::text AS avg_score,
                  sr.latest_score::text AS latest_score,
                  COALESCE(tc.agents, '') AS agents,
                  COALESCE(tc.last_used::text, '') AS last_used
             FROM tc FULL OUTER JOIN sr ON tc.skill_id = sr.skill_id
            ORDER BY tc.last_used DESC NULLS LAST`,
          [projectHash],
        );
        return r.rows;
      });
      reply.type("text/html").send(renderProjectSkillsUsed(projectHash, rows.map((r) => ({
        skill_id:     String(r.skill_id),
        shows:        Number(r.shows),
        outcomes:     Number(r.outcomes),
        runs_24h:     Number(r.runs_24h),
        avg_score:    r.avg_score === null ? null : Number(r.avg_score),
        latest_score: r.latest_score === null ? null : Number(r.latest_score),
        agents:       String(r.agents ?? ""),
        last_used:    String(r.last_used ?? ""),
      }))));
    } catch (e) {
      reply.status(500).type("text/html").send(`<div class="error">Failed to load skills-used: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.24.0 Phase 2 — marketplace pull endpoints
  //
  // POST /dashboard/marketplace/pull — runs a pull, returns HTML summary
  // GET /dashboard/marketplace/pulls — historic pulls table
  // GET /dashboard/marketplace/pulls/:pull_id — per-skill verdicts for one pull
  app.post("/dashboard/marketplace/pull", async (request, reply) => {
    try {
      const { pullFromMarketplace } = await import("./skills/marketplace_pull.js");
      const summary = await pullFromMarketplace({});
      const { renderMarketplacePullSummary } = await import("./dashboard/render.js");
      reply.type("text/html").send(renderMarketplacePullSummary(summary));
    } catch (e) {
      reply.status(500).type("text/html").send(
        `<div class="error">Marketplace pull failed: ${escapeHtml((e as Error).message)}</div>`,
      );
    }
  });

  // v0.27.0 — Marketplace pull WITH bundled scripts (fetcher-to-filesystem
  // + admission gate delegation). Closes the gap where anthropic-docx,
  // anthropic-pptx, etc. shipped without their scripts/ directory ever
  // reaching disk. Optional `skills` query param: comma-separated list of
  // ORIGINAL repo names (without the anthropic- prefix) to filter the pull.
  // Empty/missing = pull all.
  //
  // Example: POST /api/v1/marketplace/pull-filesystem?skills=docx,pptx,xlsx
  app.post("/api/v1/marketplace/pull-filesystem", async (request, reply) => {
    try {
      const { skills, shell_exec_ok } = request.query as Record<string, unknown>;
      const filterList = typeof skills === "string" && skills.trim().length > 0
        ? skills.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
        : null;
      // v0.27.0 — operator must explicitly list which skills are pre-approved
      // for shell_exec. Pass as comma-separated original names (no anthropic- prefix).
      // Example: ?shell_exec_ok=webapp-testing
      const shellExecList = typeof shell_exec_ok === "string" && shell_exec_ok.trim().length > 0
        ? shell_exec_ok.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
        : undefined;
      const { unsupported_scripts_ok } = request.query as Record<string, unknown>;
      const unsupList = typeof unsupported_scripts_ok === "string" && unsupported_scripts_ok.trim().length > 0
        ? unsupported_scripts_ok.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
        : undefined;
      const { pullMarketplaceToFilesystem } = await import("./skills/marketplace_pull.js");
      const summary = await pullMarketplaceToFilesystem({
        skillFilter: filterList ? (name) => filterList.includes(name) : undefined,
        shellExecOkSkills: shellExecList,
        unsupportedScriptsOkSkills: unsupList,
      });
      reply.type("application/json").send(summary);
    } catch (e) {
      reply.status(500).type("application/json").send({ error: (e as Error).message });
    }
  });

  app.get("/dashboard/marketplace/pulls", async (_request, reply) => {
    try {
      const { withClient } = await import("./pg_pool.js");
      const rows = await withClient(async (c) => {
        // Aggregate per pull_id: latest pulled_at, total skills + decision counts
        const r = await c.query(
          `SELECT pull_id::text, source, source_commit,
                  MIN(pulled_at)::text AS pulled_at,
                  pulled_by,
                  COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE decision = 'added') AS added,
                  COUNT(*) FILTER (WHERE decision = 'rejected_lint') AS rejected_lint,
                  COUNT(*) FILTER (WHERE decision = 'rejected_scan') AS rejected_scan,
                  COUNT(*) FILTER (WHERE decision = 'already_exists') AS already_exists,
                  COUNT(*) FILTER (WHERE decision = 'stale_version') AS stale_version,
                  COUNT(*) FILTER (WHERE decision = 'error') AS errors
             FROM skill_marketplace_pulls_pg
             GROUP BY pull_id, source, source_commit, pulled_by
             ORDER BY MIN(pulled_at) DESC
             LIMIT 30`,
        );
        return r.rows;
      });
      const { renderMarketplacePullsList } = await import("./dashboard/render.js");
      reply.type("text/html").send(renderMarketplacePullsList(rows.map((r: Record<string, unknown>) => ({
        pull_id:        String(r.pull_id),
        source:         String(r.source),
        source_commit:  String(r.source_commit ?? ""),
        pulled_at:      String(r.pulled_at),
        pulled_by:      String(r.pulled_by),
        total:          Number(r.total),
        added:          Number(r.added),
        rejected_lint:  Number(r.rejected_lint),
        rejected_scan:  Number(r.rejected_scan),
        already_exists: Number(r.already_exists),
        stale_version:  Number(r.stale_version),
        errors:         Number(r.errors),
      }))));
    } catch (e) {
      reply.status(500).type("text/html").send(
        `<div class="error">Failed to load marketplace pulls: ${escapeHtml((e as Error).message)}</div>`,
      );
    }
  });

  app.get("/dashboard/marketplace/pulls/:pull_id", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const pullId = String(params.pull_id ?? "").trim();
    if (!pullId) {
      reply.status(400).type("text/html").send(`<div class="error">missing pull_id</div>`);
      return;
    }
    try {
      const { withClient } = await import("./pg_pool.js");
      const rows = await withClient(async (c) => {
        const r = await c.query(
          `SELECT id, skill_name, skill_version, skill_scope, candidate_skill_id,
                  source_path, decision, decision_reason,
                  lint_passed, lint_errors, lint_warnings,
                  scan_score, scan_passed, scan_block_failures,
                  pulled_at::text AS pulled_at
             FROM skill_marketplace_pulls_pg
             WHERE pull_id = $1::uuid
             ORDER BY pulled_at`,
          [pullId],
        );
        return r.rows;
      });
      const { renderMarketplacePullDetails } = await import("./dashboard/render.js");
      reply.type("text/html").send(renderMarketplacePullDetails(pullId, rows.map((r: Record<string, unknown>) => ({
        pull_row_id:       Number(r.id),
        skill_name:        String(r.skill_name),
        skill_version:     String(r.skill_version ?? ""),
        skill_scope:       String(r.skill_scope ?? ""),
        candidate_skill_id: String(r.candidate_skill_id ?? ""),
        source_path:       String(r.source_path ?? ""),
        decision:          String(r.decision),
        decision_reason:   String(r.decision_reason ?? ""),
        lint_passed:       r.lint_passed === null ? null : Boolean(r.lint_passed),
        lint_errors:       typeof r.lint_errors === "string" ? JSON.parse(r.lint_errors) : (r.lint_errors as string[] | null),
        lint_warnings:     typeof r.lint_warnings === "string" ? JSON.parse(r.lint_warnings) : (r.lint_warnings as string[] | null),
        scan_score:        r.scan_score === null ? null : Number(r.scan_score),
        scan_passed:       r.scan_passed === null ? null : Boolean(r.scan_passed),
        scan_block_failures: typeof r.scan_block_failures === "string" ? JSON.parse(r.scan_block_failures) : (r.scan_block_failures as Array<{ name: string; severity: string; detail: string | null }> | null),
        pulled_at:         String(r.pulled_at),
      }))));
    } catch (e) {
      reply.status(500).type("text/html").send(
        `<div class="error">Failed to load pull details: ${escapeHtml((e as Error).message)}</div>`,
      );
    }
  });

  // v0.23.0 Phase 1 #2 — Polish a skill's description.
  // Operator-triggered via dashboard button. Returns the suggested polish
  // (does NOT auto-apply); operator reviews and POSTs to /apply if approved.
  app.post("/dashboard/skills/:id/polish", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const skillId = String(params.id ?? "").trim();
    if (!skillId) {
      reply.status(400).type("application/json").send({ ok: false, error: "missing skill_id" });
      return;
    }
    try {
      const { withClient } = await import("./pg_pool.js");
      const skill = await withClient(async (c) => {
        const r = await c.query("SELECT skill_id, frontmatter, body, body_hmac FROM skills_pg WHERE skill_id = $1 AND archived_at IS NULL", [skillId]);
        if (r.rows.length === 0) return null;
        const row = r.rows[0];
        return {
          skill_id: row.skill_id,
          frontmatter: typeof row.frontmatter === "string" ? JSON.parse(row.frontmatter) : row.frontmatter,
          body: row.body,
          body_hmac: row.body_hmac,
          source_path: null,
          promoted_from: null,
          created_at: new Date().toISOString(),
          archived_at: null,
          archive_reason: null,
        };
      });
      if (!skill) {
        reply.status(404).type("application/json").send({ ok: false, error: `skill ${skillId} not found or archived` });
        return;
      }
      const { polishSkillDescription } = await import("./skills/polisher.js");
      const result = await polishSkillDescription(skill);
      reply.type("application/json").send({ ok: true, result });
    } catch (e) {
      reply.status(500).type("application/json").send({ ok: false, error: (e as Error).message });
    }
  });

  // v0.23.0 Phase 1 #2 — Apply a polish suggestion. Operator decides to
  // accept; this writes the new description to skills_pg.
  app.post("/dashboard/skills/:id/apply-polish", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const skillId = String(params.id ?? "").trim();
    const body = request.body as Record<string, unknown>;
    const newDesc = typeof body?.description === "string" ? body.description : "";
    if (!skillId || !newDesc) {
      reply.status(400).type("application/json").send({ ok: false, error: "skill_id + description required" });
      return;
    }
    try {
      const { withClient } = await import("./pg_pool.js");
      // Re-lint with the proposed new description before applying
      const { lintSkillBody } = await import("./skills/lint.js");
      const skill = await withClient(async (c) => {
        const r = await c.query("SELECT frontmatter, body FROM skills_pg WHERE skill_id = $1 AND archived_at IS NULL", [skillId]);
        if (r.rows.length === 0) return null;
        return {
          frontmatter: typeof r.rows[0].frontmatter === "string" ? JSON.parse(r.rows[0].frontmatter) : r.rows[0].frontmatter,
          body: r.rows[0].body,
        };
      });
      if (!skill) {
        reply.status(404).type("application/json").send({ ok: false, error: `skill ${skillId} not found` });
        return;
      }
      const newFm = { ...skill.frontmatter, description: newDesc };
      const lintResult = lintSkillBody(skill.body, newFm);
      if (!lintResult.ok) {
        reply.status(400).type("application/json").send({ ok: false, error: `polished description fails lint`, lint: lintResult });
        return;
      }
      // Update frontmatter in PG (body_hmac stays the same since body unchanged)
      await withClient(async (c) => {
        await c.query(
          "UPDATE skills_pg SET frontmatter = $1::jsonb WHERE skill_id = $2 AND archived_at IS NULL",
          [JSON.stringify(newFm), skillId],
        );
      });
      reply.type("application/json").send({ ok: true, applied: true, lint: lintResult });
    } catch (e) {
      reply.status(500).type("application/json").send({ ok: false, error: (e as Error).message });
    }
  });

  // ─── v0.25.0 — operator create-skill flow ─────────────────────────────
  // GET /dashboard/skills/new-form  → renders the form
  // POST /dashboard/skills/new       → creates skill (gates run via storage_dual)
  app.get("/dashboard/skills/new-form", async (_request, reply) => {
    const { renderNewSkillForm } = await import("./dashboard/render.js");
    const { ROLES_CATALOG } = await import("./skills/roles_catalog.js");
    reply.type("text/html").send(renderNewSkillForm(ROLES_CATALOG.map((r) => r.name)));
  });

  app.post("/dashboard/skills/new", async (request, reply) => {
    // HTMX submits form-encoded body. Fastify parses as Record<string, unknown>.
    const body = request.body as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    const version = String(body.version ?? "1.0.0").trim();
    const scope = String(body.scope ?? "global").trim();
    const description = String(body.description ?? "").trim();
    const skillBody = String(body.body ?? "").trim();
    // intended_roles can be a string (single value), an array, or undefined.
    let intendedRoles: string[] = [];
    const rolesField = body.intended_roles;
    if (Array.isArray(rolesField)) intendedRoles = rolesField.map((s) => String(s));
    else if (typeof rolesField === "string" && rolesField.length > 0) intendedRoles = [rolesField];

    if (!name || !version || !description || !skillBody) {
      reply.type("text/html").send(
        `<div class="error">Missing required fields. Need name, version, description, body.</div>`,
      );
      return;
    }
    try {
      const { buildSkill } = await import("./skills/loader.js");
      const { upsertSkill } = await import("./skills/storage_dual.js");
      const { DatabaseSync } = await import("node:sqlite");
      const skill = await buildSkill(
        {
          name,
          version,
          scope: scope as "global",
          description,
          intended_roles: intendedRoles.length > 0 ? intendedRoles : undefined,
          tags: [],  // empty tags → 👤 custom badge
        },
        skillBody,
        { source_path: "operator-created" },
      );
      const memDb = new DatabaseSync(":memory:");
      try {
        await upsertSkill(memDb, skill, "operator");
      } finally {
        memDb.close();
      }
      reply.type("text/html").send(
        `<div class="ok">✓ Skill <code>${escapeHtml(skill.skill_id)}</code> created. Reload to see it in the Active skills list.</div>`,
      );
    } catch (e) {
      // Lint or scan rejection — surface the message
      reply.type("text/html").send(
        `<div class="error">❌ Could not create skill: ${escapeHtml((e as Error).message)}</div>`,
      );
    }
  });

  // ─── v0.25.0 — Live broadcasts feed (auto-refresh 5s) ─────────────────
  app.get("/dashboard/broadcasts", async (_request, reply) => {
    try {
      const { withClient } = await import("./pg_pool.js");
      const { loadProjectNameMap, renderLiveBroadcasts } = await import("./dashboard/render.js");
      const rows = await withClient(async (c) => {
        const r = await c.query<{
          id: number; agent_id: string; type: string; task: string;
          state: string; created_at: string; project_hash: string;
        }>(
          `SELECT id, agent_id, type, task, state, created_at::text AS created_at, project_hash
             FROM broadcasts
            ORDER BY id DESC
            LIMIT 20`,
        );
        return r.rows;
      });
      const nameMap = await loadProjectNameMap();
      reply.type("text/html").send(renderLiveBroadcasts(rows.map((r) => ({
        id:           Number(r.id),
        agent_id:     String(r.agent_id),
        type:         String(r.type),
        task:         String(r.task ?? ""),
        state:        String(r.state ?? ""),
        created_at:   String(r.created_at),
        project_hash: String(r.project_hash),
        project_name: nameMap.get(String(r.project_hash)) ?? null,
      }))));
    } catch (e) {
      reply.type("text/html").send(`<div class="error">Failed to load broadcasts: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // ─── v0.25.0 — Completed mutations panel ──────────────────────────────
  app.get("/dashboard/mutations/completed", async (_request, reply) => {
    try {
      const { withClient } = await import("./pg_pool.js");
      const { renderCompletedMutations } = await import("./dashboard/render.js");
      const rows = await withClient(async (c) => {
        const r = await c.query<Record<string, unknown>>(
          `SELECT mutation_id, parent_skill_id, promoted_to_skill_id,
                  judge_score::text AS judge_score, replay_score::text AS replay_score,
                  judge_rationale, promoted, resolved_at::text AS resolved_at, proposed_by
             FROM skill_mutations_pg
            WHERE resolved_at IS NOT NULL
            ORDER BY resolved_at DESC
            LIMIT 30`,
        );
        return r.rows;
      });
      reply.type("text/html").send(renderCompletedMutations(rows.map((r) => ({
        mutation_id:     String(r.mutation_id),
        parent_skill_id: String(r.parent_skill_id),
        promoted_to:     r.promoted_to_skill_id === null ? null : String(r.promoted_to_skill_id),
        judge_score:     r.judge_score === null ? null : Number(r.judge_score),
        replay_score:    r.replay_score === null ? null : Number(r.replay_score),
        judge_rationale: r.judge_rationale === null ? null : String(r.judge_rationale),
        promoted:        Boolean(r.promoted),
        resolved_at:     String(r.resolved_at),
        proposed_by:     String(r.proposed_by ?? ""),
      }))));
    } catch (e) {
      reply.type("text/html").send(`<div class="error">Failed to load completed mutations: ${escapeHtml((e as Error).message)}</div>`);
    }
  });

  // v0.19.0 Sprint 2.10 — Skill candidates panel
  app.get("/dashboard/skill-candidates", async (_request, reply) => {
    try {
      // Run the detector first (cooldown-gated internally) so new clusters
      // are queued before render.
      const { detectAndQueueSkillCandidates } = await import("./skill_candidate_detector.js");
      void detectAndQueueSkillCandidates();  // fire-and-forget; render uses what's already in DB

      const { renderSkillCandidatesFragment } = await import("./dashboard/render.js");
      const { withClient: wc } = await import("./pg_pool.js");
      const rows = await wc(async (c) => {
        const r = await c.query<{
          candidate_id: string; target_role: string; rejection_count: number;
          headline: string; status: string; created_at: string; last_rejection_at: string;
          proposed_skill_body: string | null; installed_skill_id: string | null;
        }>(
          `SELECT candidate_id, target_role, rejection_count, headline, status,
                  created_at::text AS created_at,
                  last_rejection_at::text AS last_rejection_at,
                  proposed_skill_body, installed_skill_id
             FROM skill_candidates_pg
            WHERE status IN ('pending','generating','ready','approved')
            ORDER BY rejection_count DESC, created_at DESC
            LIMIT 25`,
        );
        return r.rows;
      });
      reply.type("text/html").send(renderSkillCandidatesFragment(rows));
    } catch (e) {
      reply.type("text/html").send(`<p class="error">Error loading skill candidates: ${escapeHtml((e as Error).message)}</p>`);
    }
  });

  app.post("/dashboard/skills/edit", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const skill_id        = String(body.skill_id ?? "").trim();
    const confirm_id      = String(body.confirm_id ?? "").trim();
    const rationale       = String(body.rationale ?? "").trim();
    if (!skill_id || skill_id !== confirm_id) {
      reply.type("text/html").send(`<div class="error">❌ Confirmation failed: typed skill_id does not match.</div>`);
      return;
    }
    if (!rationale) {
      reply.type("text/html").send(`<div class="error">❌ Rationale required.</div>`);
      return;
    }
    // Build patch from form fields. Each field is optional; absence = no change.
    // Empty string for description/mutation_guidance = clear.
    const changes: Record<string, unknown> = {};
    if (typeof body.description === "string") {
      changes.description = (body.description as string).trim();
    }
    if (typeof body.intended_roles === "string") {
      changes.intended_roles = (body.intended_roles as string).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
    if (typeof body.mutation_guidance === "string") {
      changes.mutation_guidance = (body.mutation_guidance as string).trim();
    }
    if (typeof body.tags === "string") {
      changes.tags = (body.tags as string).split(",").map((s) => s.trim()).filter(Boolean);
    }
    const ac: Record<string, number> = {};
    if (body.min_outcome_score !== undefined && body.min_outcome_score !== "") {
      const n = Number(body.min_outcome_score);
      if (Number.isFinite(n)) ac.min_outcome_score = n;
    }
    if (body.min_pass_rate !== undefined && body.min_pass_rate !== "") {
      const n = Number(body.min_pass_rate);
      if (Number.isFinite(n)) ac.min_pass_rate = n;
    }
    if (Object.keys(ac).length > 0) changes.acceptance_criteria = ac;

    try {
      const { editSkillFrontmatter } = await import("./dashboard/skill_editor.js");
      const result = await editSkillFrontmatter({
        skill_id, changes: changes as Parameters<typeof editSkillFrontmatter>[0]["changes"],
        rationale, decided_by: "operator-dashboard",
      });
      reply.type("text/html").send(
        `<div class="ok">✓ Frontmatter updated<br>` +
        `→ <code>${escapeHtml(result.prior_skill_id)}</code> archived<br>` +
        `→ new active: <code>${escapeHtml(result.new_skill_id)}</code><br>` +
        `→ fields changed: ${result.changed_fields.map((f) => `<code>${escapeHtml(f)}</code>`).join(", ")}<br>` +
        `→ revision: <code>${escapeHtml(result.revision_id)}</code><br>` +
        `(refresh the Skills panel to see the new version.)</div>`,
      );
    } catch (e) {
      reply.type("text/html").send(`<div class="error">❌ ${escapeHtml((e as Error).message)}</div>`);
    }
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
      const { projectPath, agentId = "default", role } = request.query as Record<string, unknown>;
      const pp    = validateProjectPath(projectPath);
      const facts = await store.recall(pp, String(agentId));
      const lims  = await store.getWorkingMemoryLimits(pp, true);

      // v0.21.0 lever #2 — auto-inject applicable skills for this agent's role.
      // The MCP server passes ?role=<role> (defaulting to ZC_AGENT_ROLE env).
      // We query skills_pg for skills with intended_roles containing the role
      // and return them alongside facts. The agent sees their skill inventory
      // every time they call zc_recall_context — making skill awareness
      // automatic at every session start (the SessionStart hook fires
      // zc_recall_context already).
      let skills: Array<{ skill_id: string; name: string; description: string }> = [];
      const targetRole = typeof role === "string" ? role : null;
      if (targetRole && (process.env.ZC_POSTGRES_HOST || process.env.ZC_POSTGRES_PASSWORD)) {
        try {
          const { withClient } = await import("./pg_pool.js");
          const r = await withClient(async (c) => {
            const res = await c.query<{ skill_id: string; name: string; description: string }>(
              `SELECT skill_id, name, description FROM skills_pg
                WHERE archived_at IS NULL
                  AND frontmatter::text ILIKE $1
                  AND frontmatter::text ILIKE '%intended_roles%'
                ORDER BY name`,
              [`%${targetRole}%`],
            );
            return res.rows;
          });
          skills = r;
        } catch { /* best-effort; never fail the recall on skill-injection error */ }
      }

      return { ok: true, facts, max: lims.max, complexity: lims.profile, skills, role: targetRole };
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

  // v0.20.0 — Rolling compaction (Sprint 4 #5 / Tier A #4)
  app.post("/api/v1/compact", async (request, reply) => {
    try {
      const { projectPath, sessionId, turns } = request.body as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      const { compactRecentWindow } = await import("./compaction.js");
      const result = await compactRecentWindow({
        projectPath: pp,
        sessionId:   typeof sessionId === "string" ? sessionId : null,
        turns:       typeof turns     === "number" ? turns     : undefined,
      });
      reply.type("application/json").send(result);
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      reply.status(500).send({ error: (e as Error).message });
    }
  });

  app.post("/api/v1/search", async (request, reply) => {
    try {
      const { projectPath, queries, limit, agentId, depth, mode, rerank, hopDepth } = request.body as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      if (!Array.isArray(queries) || queries.length === 0) throw new ApiError(400, "queries must be a non-empty array");
      const queryStrs = queries.map(String);

      // v0.20.0 — advanced retrieval modes (Sprint 4)
      const useHyde      = mode === "hyde";
      const useMultihop  = mode === "multihop";
      const useRerank    = rerank === true || rerank === "true";

      let effectiveQueries = queryStrs;
      if (useHyde) {
        const { generateHydeQuery } = await import("./retrieval_advanced.js");
        const hyped = await Promise.all(queryStrs.map((q) => generateHydeQuery(q)));
        effectiveQueries = hyped;
      }

      const baseSearch = (qs: string[]) => store.search(pp, qs, {
        limit:   limit !== undefined ? Number(limit) : undefined,
        agentId: agentId !== undefined ? String(agentId) : undefined,
        depth:   depth as "L0" | "L1" | "L2" | undefined,
      });

      let results;
      if (useMultihop) {
        const { multiHopSearch } = await import("./retrieval_advanced.js");
        results = await multiHopSearch(effectiveQueries, {
          depth:           Math.max(1, Math.min(3, Number(hopDepth ?? 2))),
          maxResultsPerHop: 5,
          searchFn:        baseSearch,
        });
      } else {
        results = await baseSearch(effectiveQueries);
      }

      if (useRerank && results.length > 0) {
        const { rerankCandidates } = await import("./retrieval_advanced.js");
        const reranked = await rerankCandidates(queryStrs.join(" "), results, Number(limit ?? 10));
        results = reranked;
      }

      return { ok: true, results, mode: mode ?? "default", reranked: useRerank };
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

      // v0.17.0 §8.2 — file-ownership overlap guard on ASSIGN.
      // Reject if the new exclusive set overlaps with ANY in-flight (unmerged)
      // ASSIGN's exclusive set in the same project. "In-flight" = ASSIGN whose
      // `task` value has no subsequent MERGE in the last 200 broadcasts.
      const newExcl = Array.isArray(body["file_ownership_exclusive"])
        ? (body["file_ownership_exclusive"] as string[]).filter((f) => typeof f === "string")
        : [];
      if (type === "ASSIGN" && newExcl.length > 0) {
        const recent = await store.recallBroadcasts(pp, { limit: 200 });
        const mergedTasks = new Set<string>();
        for (const b of recent) if (b.type === "MERGE" && b.task) mergedTasks.add(b.task);
        for (const b of recent) {
          if (b.type !== "ASSIGN") continue;
          if (b.task && mergedTasks.has(b.task)) continue;  // completed
          const otherExcl = b.file_ownership_exclusive ?? [];
          if (otherExcl.length === 0) continue;
          const overlap = newExcl.filter((f) => otherExcl.includes(f));
          if (overlap.length > 0) {
            return reply.status(409).send({
              error: "File-ownership conflict",
              detail: `File(s) [${overlap.join(", ")}] are already claimed exclusive by in-flight ASSIGN #${b.id} (task=${b.task ?? "?"}, agent=${b.agent_id}). Wait for MERGE or retry with a disjoint file set.`,
              conflicting_broadcast_id: b.id,
              overlapping_files: overlap,
            });
          }
        }
      }

      const broadcastTask    = typeof body["task"]    === "string" ? body["task"]    : undefined;
      const broadcastSummary = typeof body["summary"] === "string" ? body["summary"] : undefined;
      const broadcastReason  = typeof body["reason"]  === "string" ? body["reason"]  : undefined;

      const msg = await store.broadcast(pp, type as never, agentId, {
        task:          broadcastTask,
        summary:       broadcastSummary,
        state:         typeof body["state"]         === "string" ? body["state"]         : undefined,
        reason:        broadcastReason,
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

      // v0.19.0 Step 2 — REJECT outcome resolver. Fire-and-forget: writes
      // outcomes_pg row, learnings/failures.jsonl entry, working memory fact,
      // and flags any matching skill_run with low outcome_score (so the
      // mutator's auto-spawn detector picks it up). Errors logged, never
      // surfaced to the caller — broadcast delivery must always succeed.
      if (type === "REJECT") {
        void (async () => {
          try {
            const { resolveRejectOutcome } = await import("./outcomes_reject_resolver.js");
            await resolveRejectOutcome({
              projectPath:       pp,
              rejectingAgentId:  agentId,
              task:              broadcastTask,
              summary:           broadcastSummary,
              reason:            broadcastReason,
              rejectBroadcastId: msg.id,
            });
          } catch (e) {
            // Defense in depth — resolveRejectOutcome itself should never throw,
            // but if its lazy-imported deps fail to load we still want a log.
            void e;
          }
        })();
      }

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

      // v0.18.9 — capture (project_hash → project_path) so the dashboard can
      // resolve hashes to readable names. Best-effort: failure here must not
      // break the telemetry write that already succeeded.
      void (async () => {
        try {
          const { withClient } = await import("./pg_pool.js");
          const { createHash } = await import("node:crypto");
          const projectHash = createHash("sha256").update(pp).digest("hex").slice(0, 16);
          await withClient(async (c) => {
            await c.query(`
              INSERT INTO project_paths_pg (project_hash, project_path)
              VALUES ($1, $2)
              ON CONFLICT (project_hash) DO UPDATE
                SET project_path  = EXCLUDED.project_path,
                    last_seen_at  = now()
            `, [projectHash, pp]);
          });
        } catch { /* non-fatal */ }
      })();

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

  // ──────────────────────────────────────────────────────────────────────────
  // Task-queue stats (v0.17.1) — used by the dispatcher to wake idle workers
  // when queued tasks exist for their role. Returns counts by role and state.
  // Only meaningful in Postgres backend mode (task_queue_pg).
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/api/v1/queue/stats-by-role", async (request, reply) => {
    try {
      const { projectPath } = request.query as Record<string, unknown>;
      const pp = validateProjectPath(projectPath);
      const { createHash } = await import("node:crypto");
      const { realpathSync } = await import("node:fs");
      let normalized = pp;
      try { normalized = realpathSync(pp); } catch { /* use raw */ }
      const projectHash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
      const { withClient } = await import("./pg_pool.js");
      const rows = await withClient(async (c) => {
        const r = await c.query<{ role: string; state: string; n: string }>(
          "SELECT role, state, COUNT(*)::int::text AS n FROM task_queue_pg WHERE project_hash = $1 GROUP BY role, state",
          [projectHash],
        );
        return r.rows;
      });
      // Shape as { role: { queued, claimed, done, failed } }
      const byRole: Record<string, { queued: number; claimed: number; done: number; failed: number }> = {};
      for (const row of rows) {
        if (!byRole[row.role]) byRole[row.role] = { queued: 0, claimed: 0, done: 0, failed: 0 };
        const slot = byRole[row.role] as Record<string, number>;
        slot[row.state] = Number(row.n);
      }
      return { ok: true, projectHash, byRole };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      // PG unavailable or SQLite-only deploy — return empty shape (not 500)
      return { ok: true, byRole: {} };
    }
  });

  // v0.22.1 — count tasks claimed-but-not-done by a specific agent. Used by
  // dispatcher's auto-retire to skip retire while a long Sonnet generation is
  // in flight (without this, dispatcher kills mutator window mid-generation
  // because byRole.queued only counts state='queued' rows). Discovered live:
  // mut-1f85f351-1f8 was orphaned this way at 13:16:42.
  app.get("/api/v1/queue/in-flight", async (request, reply) => {
    try {
      const { claimed_by } = request.query as Record<string, unknown>;
      if (typeof claimed_by !== "string" || !claimed_by) {
        return reply.status(400).send({ error: "claimed_by query param is required" });
      }
      const { withClient } = await import("./pg_pool.js");
      const count = await withClient(async (c) => {
        const r = await c.query<{ n: string }>(
          "SELECT COUNT(*)::int::text AS n FROM task_queue_pg WHERE state='claimed' AND claimed_by = $1",
          [claimed_by],
        );
        return Number(r.rows[0]?.n ?? 0);
      });
      return { ok: true, claimed_by, count };
    } catch {
      return { ok: true, count: 0 };
    }
  });

  // v0.22.5 — record a PreRead summary intercept event. The hook calls this
  // fire-and-forget after returning an L0/L1 summary instead of a full file.
  // Without this, the savings are real but invisible to the dashboard
  // (hooks don't write to tool_calls_pg). With this: every successful
  // intercept lands in read_redirects_pg and feeds into the savings calc.
  // Body shape: { projectPath, agentId, filePath, fullFileTokens, summaryTokens }
  app.post("/api/v1/telemetry/read-redirect", async (request, reply) => {
    try {
      const b = request.body as Record<string, unknown>;
      const pp        = validateProjectPath(b["projectPath"]);
      const agentId   = typeof b["agentId"]   === "string" ? b["agentId"].slice(0, 64)  : "default";
      const filePath  = typeof b["filePath"]  === "string" ? b["filePath"].slice(0, 1024) : "";
      const fullFile  = Number(b["fullFileTokens"] ?? 0);
      const summary   = Number(b["summaryTokens"]  ?? 0);
      if (!filePath || !Number.isFinite(fullFile) || !Number.isFinite(summary)) {
        return reply.status(400).send({ error: "filePath, fullFileTokens, summaryTokens required" });
      }
      const { createHash } = await import("node:crypto");
      const { realpathSync } = await import("node:fs");
      let normalized = pp;
      try { normalized = realpathSync(pp); } catch { /* use raw */ }
      const projectHash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
      const { withClient } = await import("./pg_pool.js");
      await withClient(async (c) => {
        await c.query(
          `INSERT INTO read_redirects_pg
             (project_hash, agent_id, file_path, full_file_tokens, summary_tokens)
           VALUES ($1, $2, $3, $4, $5)`,
          [projectHash, agentId, filePath, Math.max(0, Math.floor(fullFile)), Math.max(0, Math.floor(summary))]
        );
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return reply.status(e.statusCode).send({ error: e.message });
      // Don't 500 — hook is fire-and-forget, must not break agent flow
      return { ok: false, error: (e as Error).message };
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
  createApiServer().then(async ({ app }) => {
    // v0.22.0 — run PG migrations on API startup. Previously migrations
    // only ran when an agent's MCP server made the first PG-backed telemetry
    // write — meaning new schema (added in a release) wouldn't apply until
    // an agent connected. That created a window where the API container
    // could serve stale-schema requests. Idempotent + safe to call always.
    if (process.env.ZC_POSTGRES_HOST || process.env.ZC_POSTGRES_PASSWORD) {
      try {
        const { runPgMigrations } = await import("./pg_migrations.js");
        const applied = await runPgMigrations();
        if (applied > 0) console.log(`PG migrations applied: ${applied}`);
      } catch (e) {
        console.error("PG migration on startup failed:", (e as Error).message);
      }
    }

    // v0.20.0 — auto-import skills/*.skill.md into skills_pg before listening.
    // Idempotent: skips files whose body_hmac is unchanged. Skip silently if
    // PG isn't configured (the import is best-effort startup work).
    if (process.env.ZC_POSTGRES_HOST || process.env.ZC_POSTGRES_PASSWORD) {
      try {
        const { autoImportSkills, backfillSecurityScans, backfillIntendedRoles } = await import("./skill_auto_import.js");
        const summary = await autoImportSkills();
        console.log(`Skill auto-import: scanned=${summary.scanned} +${summary.inserted} ~${summary.updated} =${summary.skipped_same} ✗${summary.parse_errors + summary.validation_errors}`);
        // v0.23.3 — also backfill security scans for any active skills that
        // have no scan history (pre-v0.23.0 skills imported via the raw-SQL
        // path that bypassed the gate). Idempotent: only scans skills that
        // have zero rows in skill_security_scans_pg.
        const backfill = await backfillSecurityScans();
        if (backfill.scanned > 0) {
          console.log(`Skill scan backfill: scanned=${backfill.scanned} passed=${backfill.passed} failed=${backfill.failed}`);
        }
        // v0.24.2 — classify intended_roles for any skill missing them
        // (the v0.24.0 marketplace skills, mostly). Idempotent: only
        // touches skills with frontmatter.intended_roles missing or empty.
        const roleBack = await backfillIntendedRoles();
        if (roleBack.scanned > 0) {
          console.log(`Skill role backfill: scanned=${roleBack.scanned} updated=${roleBack.updated} skipped=${roleBack.skipped}`);
        }
        // v0.26.0 Step 2 — walk ~/.claude/skills/<name>/ (Anthropic dir layout)
        // and mirror to skills_pg with body_hmac + script_hmacs populated.
        // Runs after the legacy flat-file auto-import so the two coexist.
        try {
          const { importFilesystemSkills } = await import("./skills/filesystem_skill_import.js");
          // v0.27.0 — also walk per-project skill dirs declared via env.
          // Set ZC_PROJECT_SKILL_PATHS to a colon-separated list of absolute
          // project roots (e.g. "/projects/Test_Agent_Coordination:/projects/MyApp").
          // Each must be a project root that contains .claude/skills/<name>/
          // subdirs. The container must be able to read the path (bind-mounted).
          const projectPathsRaw = process.env.ZC_PROJECT_SKILL_PATHS ?? "";
          const projectPaths = projectPathsRaw
            ? projectPathsRaw.split(/[:;,]/).map((p) => p.trim()).filter((p) => p.length > 0)
            : [];
          const fsSummary = await importFilesystemSkills({ projectPaths });
          if (fsSummary.scanned > 0) {
            console.log(`FS skill import: scanned=${fsSummary.scanned} +${fsSummary.inserted} ~${fsSummary.updated} =${fsSummary.skipped_same} ✗${fsSummary.errors}${projectPaths.length > 0 ? ` (projects=${projectPaths.length})` : ""}`);
          }
        } catch (e) {
          console.error("FS skill import failed:", (e as Error).message);
        }
      } catch (e) {
        console.error("Skill auto-import failed:", (e as Error).message);
      }
    }
    app.listen({ port: API_PORT, host: API_HOST }, (err) => {
      if (err) { console.error(err); process.exit(1); }
      console.log(`SecureContext API server listening on ${API_HOST}:${API_PORT}`);
      console.log(`Store backend: ${process.env["ZC_STORE"] ?? "sqlite"}`);
      console.log(`Auth: ${API_KEY ? "enabled (ZC_API_KEY set)" : "⚠️  OPEN — set ZC_API_KEY"}`);
    });
  }).catch(err => { console.error(err); process.exit(1); });
}
