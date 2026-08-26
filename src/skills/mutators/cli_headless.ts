/**
 * CliHeadlessMutator (v0.60.0 — mutation engine M1)
 * ==================================================
 *
 * The pragmatic subscription-billed backend: shells `claude -p` directly with
 * the proposer prompt on stdin. Same Pro/Max login the agents use — zero API
 * calls, zero marginal cost, and NO moving parts: unlike `cli-claude` (which
 * enqueues a task for a mutator agent and polls broadcasts — five minutes of
 * dispatcher/pool/broadcast machinery that historically never completed once),
 * this is a synchronous child process that works wherever the CLI works,
 * including the nightly cron with no agents running.
 *
 * The MCP server that runs mutation cycles executes agent-side (Windows host
 * or WSL), where `claude` is on PATH and already authenticated.
 *
 * SECURITY: same rails as every backend — the prompt passes the
 * pre-submission secret scan upstream, and candidate bodies are HMAC'd at
 * receive time (RT-S2-09).
 */
import type { Mutator } from "../mutator.js";
import type { MutationContext, MutationResult } from "../types.js";
import { buildProposerPrompt, parseProposerResponse } from "../mutator.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Generating 5 full candidate bodies is ~8k output tokens — 180s timed out
// live on the very first real cycle. 10 minutes covers Sonnet worst-cases.
const DEFAULT_TIMEOUT_MS = parseInt(process.env["ZC_MUTATOR_TIMEOUT_MS"] ?? "", 10) || 600_000;
const DEFAULT_CLI_MODEL  = process.env["ZC_MUTATOR_CLI_MODEL"] || "claude-sonnet-4-6";

/**
 * Run `claude -p` headless with a prompt on stdin and return stdout.
 * Shared by the proposer (this file) and the independent judge (judge.ts).
 *
 * The child env is scrubbed of the parent Claude session's markers —
 * a nested CLI inheriting CLAUDECODE/CLAUDE_CODE_* can misdetect its
 * execution context (observed with the dispatcher's own launcher, which
 * clears CLAUDECODE for the same reason).
 */
/**
 * Resolve the actual claude executable, bypassing the npm .cmd shim on
 * Windows: spawnSync with shell:true wraps the shim in cmd.exe, which
 * swallows the stdin pipe — the child hangs until timeout (observed live:
 * ETIMEDOUT while the same command runs fine from a real shell). The npm
 * package ships bin/claude.exe (a native binary) — invoke it directly.
 */
function resolveClaudeBin(): { cmd: string; useShell: boolean } {
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    if (appData) {
      const native = `${appData}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
      if (existsSync(native)) return { cmd: native, useShell: false };
    }
    return { cmd: "claude", useShell: true };   // last resort — may hang on stdin
  }
  return { cmd: "claude", useShell: false };
}

export function runClaudeHeadless(prompt: string, opts: { model?: string; timeoutMs?: number } = {}): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    env[k] = v;
  }
  const bin = resolveClaudeBin();
  const r = spawnSync(bin.cmd, [
    "-p",
    "--model", opts.model ?? DEFAULT_CLI_MODEL,
    "--output-format", "text",
    // `claude -p` is the full CLI, not a completion endpoint — without this it
    // happily prefixes prose ("I have enough context…") or reaches for tools.
    // Observed live on the first real proposer call.
    "--append-system-prompt",
    "You are a non-interactive generation endpoint. Output ONLY what the prompt's format specification asks for — no preamble, no commentary, no tool use, no questions.",
  ], {
    input: prompt,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env,
    shell: bin.useShell,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw new Error(`claude -p failed to start: ${r.error.message}`);
  if (r.status !== 0) {
    const err = (r.stderr ?? "").trim().slice(0, 400);
    throw new Error(`claude -p exited ${r.status}: ${err || "(no stderr)"}`);
  }
  const out = (r.stdout ?? "").trim();
  if (!out) throw new Error("claude -p returned empty output");
  return out;
}

/**
 * Tolerant JSON extraction: full-CLI models sometimes wrap the payload in
 * prose or fences despite instructions. Try direct parse, then the outermost
 * bracketed span. Exported for the judge, which has the same problem.
 */
export function extractJsonPayload(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    const end = text.lastIndexOf("```");
    text = text.slice(text.indexOf("\n") + 1, end > 0 ? end : undefined).trim();
  }
  try { JSON.parse(text); return text; } catch { /* fall through */ }
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error(`no JSON found in model output: ${text.slice(0, 120)}…`);
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  if (end <= start) throw new Error(`unterminated JSON in model output: ${text.slice(0, 120)}…`);
  return text.slice(start, end + 1);
}

export class CliHeadlessMutator implements Mutator {
  readonly id = "cli-headless";

  async mutate(ctx: MutationContext): Promise<MutationResult> {
    const prompt = buildProposerPrompt(ctx);
    const raw = runClaudeHeadless(prompt);
    const candidates = parseProposerResponse(extractJsonPayload(raw));
    return {
      candidates,
      proposer_model:    this.id,
      proposer_cost_usd: 0,           // subscription-billed, no per-call charge
      judge_pick_index:  null,        // judging is a SEPARATE stage (judge.ts)
      judge_model:       null,
      judge_rationale:   null,
      total_cost_usd:    0,
    };
  }
}
