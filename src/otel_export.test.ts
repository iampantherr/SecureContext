/**
 * S5 (v0.46.0) — Gen-AI semantic-conventions conformance tests for the OTLP
 * span mapper. Proves the span shape deterministically; the live E2E covers
 * the wire path (cursor, batch, collector 2xx).
 */
import { describe, it, expect } from "vitest";
import { toSpan, providerFromModel, type ToolCallRow } from "./otel_export.js";

const ROW: ToolCallRow = {
  id: "42", call_id: "call-abc-123", session_id: "mcp-sess-1", agent_id: "developer",
  project_hash: "36608e2913b5dc42", task_id: "t-1", skill_id: null,
  tool_name: "zc_search", model: "claude-sonnet-4-6",
  input_tokens: 12, output_tokens: 340, cost_usd: "0.00123400", latency_ms: 250,
  status: "ok", error_class: null, ts: new Date("2026-07-17T00:00:01.000Z"),
  prev_hash: "prevhash", row_hash: "rowhash",
};

type Attr = { key: string; value: Record<string, unknown> };
const attrsOf = (span: object): Map<string, Record<string, unknown>> => {
  const m = new Map<string, Record<string, unknown>>();
  for (const a of (span as { attributes: Attr[] }).attributes) m.set(a.key, a.value);
  return m;
};

describe("providerFromModel", () => {
  it("maps model families to semconv provider names", () => {
    expect(providerFromModel("claude-opus-4-8[1m]")).toBe("anthropic");
    expect(providerFromModel("gpt-4o")).toBe("openai");
    expect(providerFromModel("gemini-2.5-pro")).toBe("gcp.gemini");
    expect(providerFromModel("qwen2.5-coder:14b")).toBe("self_hosted");
    expect(providerFromModel("")).toBe("unknown");
  });
});

describe("toSpan — Gen-AI semconv v1.41 execute_tool shape", () => {
  const span = toSpan(ROW) as { name: string; kind: number; status: { code: number };
    startTimeUnixNano: string; endTimeUnixNano: string };
  const attrs = attrsOf(span);

  it('names the span "execute_tool {tool}" with INTERNAL kind', () => {
    expect(span.name).toBe("execute_tool zc_search");
    expect(span.kind).toBe(1);
  });

  it("carries the required gen_ai.* attributes", () => {
    expect(attrs.get("gen_ai.operation.name")).toEqual({ stringValue: "execute_tool" });
    expect(attrs.get("gen_ai.provider.name")).toEqual({ stringValue: "anthropic" });
    expect(attrs.get("gen_ai.tool.name")).toEqual({ stringValue: "zc_search" });
    expect(attrs.get("gen_ai.tool.call.id")).toEqual({ stringValue: "call-abc-123" });
    expect(attrs.get("gen_ai.tool.type")).toEqual({ stringValue: "function" });
    expect(attrs.get("gen_ai.agent.id")).toEqual({ stringValue: "developer" });
    expect(attrs.get("gen_ai.conversation.id")).toEqual({ stringValue: "mcp-sess-1" });
    expect(attrs.get("gen_ai.request.model")).toEqual({ stringValue: "claude-sonnet-4-6" });
    expect(attrs.get("gen_ai.usage.input_tokens")).toEqual({ intValue: "12" });
    expect(attrs.get("gen_ai.usage.output_tokens")).toEqual({ intValue: "340" });
  });

  it("keeps the tamper-evidence + namespaced extensions", () => {
    expect(attrs.get("audit.row_hash")).toEqual({ stringValue: "rowhash" });
    expect(attrs.get("audit.prev_hash")).toEqual({ stringValue: "prevhash" });
    expect(attrs.get("securecontext.project_hash")).toEqual({ stringValue: "36608e2913b5dc42" });
    expect(attrs.get("securecontext.cost_usd")).toEqual({ doubleValue: 0.001234 });
  });

  it("ok status → OTel STATUS_OK, no error.type", () => {
    expect(span.status.code).toBe(1);
    expect(attrs.has("error.type")).toBe(false);
  });

  it("start/end derive from ts - latency", () => {
    const end = BigInt(span.endTimeUnixNano);
    const start = BigInt(span.startTimeUnixNano);
    expect(end - start).toBe(250n * 1_000_000n);
  });

  it("failure rows set STATUS_ERROR + error.type", () => {
    const bad = toSpan({ ...ROW, status: "error", error_class: "timeout" }) as { status: { code: number; message?: string } };
    const badAttrs = attrsOf(bad);
    expect(bad.status.code).toBe(2);
    expect(badAttrs.get("error.type")).toEqual({ stringValue: "timeout" });
  });

  it("failure without error_class falls back to the status string", () => {
    const bad = attrsOf(toSpan({ ...ROW, status: "timeout", error_class: null }));
    expect(bad.get("error.type")).toEqual({ stringValue: "timeout" });
  });
});
