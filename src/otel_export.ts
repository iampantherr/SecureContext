/**
 * OpenTelemetry export of the HMAC-chained audit trail (v0.38.0 — Tier-2 #9;
 * S5 v0.46.0 — Gen-AI semantic-conventions conformance)
 * ===========================================================================
 *
 * Streams `tool_calls_pg` rows as OTLP/HTTP JSON spans so SC agents appear in any
 * existing observability stack (Grafana Tempo, Langfuse, Jaeger, …) — and, uniquely,
 * each span carries the row's chain hashes (`audit.row_hash`/`audit.prev_hash`), making
 * this the only tamper-evident trace data in that stack.
 *
 * S5 (v0.46.0): spans follow the OTel **Gen-AI semantic conventions** (semconv
 * v1.41 "execute_tool" shape) so Gen-AI-aware backends (Langfuse, Grafana Gen-AI
 * dashboards, Arize/Phoenix) light up without custom mapping:
 *   - span name          "execute_tool {tool_name}"
 *   - gen_ai.operation.name = "execute_tool"
 *   - gen_ai.provider.name  derived from the model id (claude→anthropic, …)
 *   - gen_ai.tool.name / gen_ai.tool.call.id / gen_ai.tool.type = "function"
 *   - gen_ai.agent.id, gen_ai.conversation.id (session), gen_ai.request.model
 *   - gen_ai.usage.input_tokens / output_tokens; error.type on failures
 * SecureContext-specific fields ride in the securecontext.* / audit.* namespaces.
 *
 * Zero-dependency by design: OTLP/HTTP JSON is just a schema — no OTel SDK needed.
 * OFF unless ZC_OTLP_ENDPOINT is set (there is no sensible default target). The
 * enrichment cron ships new rows each cycle; a cursor table makes it exactly-once
 * per row (batch ≤ 200/cycle).
 *
 *   ZC_OTLP_ENDPOINT  e.g. http://localhost:4318   (/v1/traces appended if absent)
 *   ZC_OTLP_HEADERS   optional "k1=v1,k2=v2" extra headers (auth for hosted collectors)
 */

import { createHash } from "node:crypto";
import { withClient } from "./pg_pool.js";

const BATCH = 200;

function endpoint(): string | null {
  const raw = process.env["ZC_OTLP_ENDPOINT"]?.trim();
  if (!raw) return null;
  const base = raw.replace(/\/$/, "");
  return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
}

function extraHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of (process.env["ZC_OTLP_HEADERS"] ?? "").split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return out;
}

export interface ToolCallRow {
  id: string; call_id: string; session_id: string; agent_id: string; project_hash: string;
  task_id: string | null; skill_id: string | null; tool_name: string; model: string;
  input_tokens: number; output_tokens: number; cost_usd: string; latency_ms: number;
  status: string; error_class: string | null; ts: Date; prev_hash: string; row_hash: string;
}

/** Gen-AI semconv well-known provider from a model id (best-effort, "unknown" fallback). */
export function providerFromModel(model: string): string {
  const m = (model || "").toLowerCase();
  if (m.includes("claude")) return "anthropic";
  if (/gpt|^o[0-9]|davinci|openai/.test(m)) return "openai";
  if (m.includes("gemini")) return "gcp.gemini";
  if (m.includes("mistral")) return "mistral_ai";
  if (m.includes("llama") || m.includes("qwen") || m.includes("deepseek")) return "self_hosted";
  return "unknown";
}

const attr = (key: string, value: string | number | null | undefined): object | null =>
  value === null || value === undefined || value === "" ? null
    : typeof value === "number"
      ? { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } }
      : { key, value: { stringValue: String(value).slice(0, 256) } };

export function toSpan(r: ToolCallRow): object {
  const endNs   = BigInt(new Date(r.ts).getTime()) * 1_000_000n;
  const startNs = endNs - BigInt(Math.max(0, r.latency_ms)) * 1_000_000n;
  return {
    traceId: createHash("sha256").update(r.session_id).digest("hex").slice(0, 32),
    spanId:  createHash("sha256").update(r.call_id).digest("hex").slice(0, 16),
    // Gen-AI semconv span-name convention for tool execution: "execute_tool {tool}".
    name:    `execute_tool ${r.tool_name}`.slice(0, 128),
    kind:    1, // SPAN_KIND_INTERNAL (per semconv for execute_tool)
    startTimeUnixNano: startNs.toString(),
    endTimeUnixNano:   endNs.toString(),
    status: { code: r.status === "ok" ? 1 : 2, ...(r.error_class ? { message: r.error_class.slice(0, 128) } : {}) },
    attributes: [
      // ── Gen-AI semantic conventions (v1.41) ──
      attr("gen_ai.operation.name", "execute_tool"),
      attr("gen_ai.provider.name", providerFromModel(r.model)),
      attr("gen_ai.tool.name", r.tool_name),
      attr("gen_ai.tool.call.id", r.call_id),
      attr("gen_ai.tool.type", "function"),
      attr("gen_ai.agent.id", r.agent_id),
      attr("gen_ai.conversation.id", r.session_id),
      attr("gen_ai.request.model", r.model),
      attr("gen_ai.usage.input_tokens", r.input_tokens),
      attr("gen_ai.usage.output_tokens", r.output_tokens),
      ...(r.status !== "ok" ? [attr("error.type", r.error_class ?? r.status)] : []),
      // ── SecureContext extensions (properly namespaced) ──
      attr("securecontext.project_hash", r.project_hash),
      attr("securecontext.task_id", r.task_id), attr("securecontext.skill_id", r.skill_id),
      attr("securecontext.cost_usd", Number(r.cost_usd) || 0), attr("securecontext.status", r.status),
      // The moat, exported: chained hashes make each span independently verifiable.
      attr("audit.row_hash", r.row_hash), attr("audit.prev_hash", r.prev_hash),
    ].filter(Boolean),
  };
}

/**
 * Ship un-exported audit rows as OTLP spans. Returns null when disabled (no endpoint),
 * else {exported}. Cursor only advances on a 2xx from the collector.
 */
export async function exportAuditSpans(): Promise<{ exported: number } | null> {
  const url = endpoint();
  if (!url) return null;
  return withClient(async (c) => {
    await c.query(`CREATE TABLE IF NOT EXISTS otel_export_state (id INT PRIMARY KEY, last_tool_call_id BIGINT NOT NULL DEFAULT 0)`);
    await c.query(`INSERT INTO otel_export_state(id, last_tool_call_id) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`);
    const cursor = (await c.query<{ last_tool_call_id: string }>(`SELECT last_tool_call_id FROM otel_export_state WHERE id = 1`)).rows[0]!;
    const rows = (await c.query<ToolCallRow>(
      `SELECT id, call_id, session_id, agent_id, project_hash, task_id, skill_id, tool_name, model,
              input_tokens, output_tokens, cost_usd, latency_ms, status, error_class, ts, prev_hash, row_hash
         FROM tool_calls_pg WHERE id > $1 ORDER BY id ASC LIMIT ${BATCH}`, [cursor.last_tool_call_id])).rows;
    if (rows.length === 0) return { exported: 0 };
    const payload = {
      resourceSpans: [{
        resource: { attributes: [attr("service.name", "securecontext"), attr("service.version", process.env["npm_package_version"] ?? "")] .filter(Boolean) },
        scopeSpans: [{ scope: { name: "zc-ctx.audit" }, spans: rows.map(toSpan) }],
      }],
    };
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders() },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`OTLP collector responded ${resp.status}`);
    await c.query(`UPDATE otel_export_state SET last_tool_call_id = $1 WHERE id = 1`, [rows[rows.length - 1]!.id]);
    return { exported: rows.length };
  });
}
