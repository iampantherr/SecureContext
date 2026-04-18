/**
 * Telemetry HTTP client (v0.12.1 Tier 2)
 * =======================================
 *
 * When `ZC_TELEMETRY_MODE=api`, recordToolCall + recordOutcome route through
 * the SecureContext HTTP API instead of writing to the local SQLite DB
 * directly. This implements the Reference Monitor pattern (Chin & Older
 * 2011, Ch12): a single bypass-proof enforcement point that:
 *   (a) is tamper-proof — only the API process holds DB write authority
 *   (b) is always invoked — no client bypass path
 *   (c) is verifiable — the validation in api-server.ts is small + reviewable
 *
 * Combined with v0.12.1's session_token binding, telemetry rows become
 * authenticated: the API verifies that the row's claimed agent_id matches
 * the session_token's bound agent_id. Cross-agent forgery is blocked at
 * the Reference Monitor (RT-S2-02 in tests).
 *
 * Backward compat: when ZC_TELEMETRY_MODE is unset or "local", the
 * existing direct-SQLite path is used. New deployments should set "api"
 * for production multi-agent scenarios.
 *
 * Token lifecycle:
 *   - At MCP startup, the client tries to obtain a session_token via
 *     POST /api/v1/issue-token using ZC_AGENT_ID + ZC_AGENT_ROLE.
 *   - The token is cached in-process. Re-fetched on 401 from the API.
 *   - If issue-token fails (e.g. RBAC not configured on the API), the
 *     client falls back to local mode with a single warning log.
 *
 * Failure handling:
 *   - The API call should be loud-fail (logger.error) but never throw.
 *     Calling tool's success must not depend on telemetry working.
 *   - On HTTP 401: clear cached token, retry once, then give up.
 *   - On network error: log + return null (same as local-mode failure).
 */

import { logger } from "./logger.js";
import type { ToolCallInput, ToolCallRecord } from "./telemetry.js";
import type { RecordOutcomeInput, OutcomeRecord } from "./outcomes.js";

// ─── Mode + config ─────────────────────────────────────────────────────────

export type TelemetryMode = "local" | "api" | "dual";

export function getTelemetryMode(): TelemetryMode {
  const mode = (process.env.ZC_TELEMETRY_MODE || "local").toLowerCase();
  if (mode === "api" || mode === "dual") return mode;
  return "local";
}

export function getApiUrl(): string {
  return process.env.ZC_API_URL || "http://localhost:3099";
}

export function getApiKey(): string | undefined {
  return process.env.ZC_API_KEY || undefined;
}

// ─── Token cache ───────────────────────────────────────────────────────────

interface CachedToken {
  token:   string;
  agentId: string;
  role:    string;
  fetchedAt: number;
}

let _cachedToken: CachedToken | null = null;

/**
 * Obtain (and cache) a session_token for this MCP server's agent identity.
 * Returns null if RBAC is unconfigured or the issue-token endpoint fails.
 */
export async function getOrFetchSessionToken(
  projectPath: string,
  agentId: string,
  role:    string,
): Promise<string | null> {
  // Reuse cache if still for the same agent + within reasonable window
  if (_cachedToken &&
      _cachedToken.agentId === agentId &&
      _cachedToken.role    === role    &&
      (Date.now() - _cachedToken.fetchedAt) < 60 * 60 * 1000) {  // 1 hour
    return _cachedToken.token;
  }

  const apiUrl = getApiUrl();
  const apiKey = getApiKey();

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(`${apiUrl}/api/v1/issue-token`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectPath, agentId, role }),
    });

    if (!res.ok) {
      // Most common: 401 (no API key) or 503 (RBAC not configured).
      const text = await res.text().catch(() => "");
      logger.warn("telemetry", "session_token_fetch_failed", {
        status: res.status, body: text.slice(0, 200),
      });
      return null;
    }

    const json = await res.json() as { ok?: boolean; token?: string };
    if (!json.ok || !json.token) {
      logger.warn("telemetry", "session_token_response_malformed", { body: JSON.stringify(json).slice(0, 200) });
      return null;
    }

    _cachedToken = { token: json.token, agentId, role, fetchedAt: Date.now() };
    logger.info("telemetry", "session_token_obtained", { agent_id: agentId, role });
    return json.token;
  } catch (e) {
    logger.warn("telemetry", "session_token_fetch_error", { error: (e as Error).message });
    return null;
  }
}

/** Test/diagnostic: clear the cached session_token. */
export function _resetSessionTokenCacheForTesting(): void {
  _cachedToken = null;
}

// ─── HTTP client for telemetry writes ──────────────────────────────────────

/**
 * Send a tool_call to the SC API's Reference Monitor endpoint.
 * Returns the recorded ToolCallRecord, or null on failure (logged loudly).
 *
 * SECURITY: The session_token's agent_id MUST match input.agentId, or the
 * server rejects with 403 (cross-agent forgery blocked).
 */
export async function recordToolCallViaApi(
  input:        ToolCallInput,
  sessionToken: string,
): Promise<ToolCallRecord | null> {
  const apiUrl = getApiUrl();
  try {
    const res = await fetch(`${apiUrl}/api/v1/telemetry/tool_call`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error("telemetry", "tool_call_api_error", {
        status: res.status, body: text.slice(0, 200),
        call_id: input.callId,
      });
      // 401 = stale token; clear cache so next call re-fetches.
      if (res.status === 401) _resetSessionTokenCacheForTesting();
      return null;
    }

    const json = await res.json() as { ok?: boolean; record?: ToolCallRecord };
    return json.record ?? null;
  } catch (e) {
    logger.error("telemetry", "tool_call_api_network_error", {
      error: (e as Error).message, call_id: input.callId,
    });
    return null;
  }
}

/**
 * Send an outcome to the SC API's Reference Monitor endpoint.
 * Returns the recorded OutcomeRecord, or null on failure.
 */
export async function recordOutcomeViaApi(
  input:        RecordOutcomeInput,
  sessionToken: string,
): Promise<OutcomeRecord | null> {
  const apiUrl = getApiUrl();
  try {
    const res = await fetch(`${apiUrl}/api/v1/telemetry/outcome`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error("outcomes", "outcome_api_error", {
        status: res.status, body: text.slice(0, 200), ref_id: input.refId,
      });
      if (res.status === 401) _resetSessionTokenCacheForTesting();
      return null;
    }

    const json = await res.json() as { ok?: boolean; record?: OutcomeRecord };
    return json.record ?? null;
  } catch (e) {
    logger.error("outcomes", "outcome_api_network_error", {
      error: (e as Error).message, ref_id: input.refId,
    });
    return null;
  }
}
