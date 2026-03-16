/**
 * zc-ctx PreToolUse Hook
 *
 * SECURITY INVARIANTS (never violate):
 * 1. This file NEVER writes to any file (no writeFileSync, no copyFileSync)
 * 2. This file NEVER modifies itself or other hook files
 * 3. This file NEVER makes network requests
 * 4. This file NEVER reads credentials from environment
 * 5. This file only reads stdin and writes to stdout/stderr
 *
 * Purpose: Advise on routing large-output commands through zc_execute sandbox
 * to keep the context window clean.
 */

import { createInterface } from "node:readline";

// Tools that commonly produce large outputs and benefit from sandboxing
const LARGE_OUTPUT_TOOLS = new Set(["Bash"]);

// Commands that produce very large outputs — suggest sandboxing
const NOISY_COMMAND_PATTERNS = [
  /npm\s+(install|i\b|ci)/,
  /pip\s+install/,
  /yarn\s+(install|add)/,
  /find\s+\S+\s+-/,
  /docker\s+(build|run|logs)/,
  /git\s+(log|diff|blame)\s/,
  /cat\s+\S+\.(log|txt|json|csv)\b/,
  /curl\s+/,
  /wget\s+/,
];

const LARGE_COMMAND_THRESHOLD = 400; // chars — above this, suggest sandbox

async function main() {
  const lines = [];
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    lines.push(line);
  }

  let event;
  try {
    event = JSON.parse(lines.join("\n"));
  } catch {
    // Not valid JSON — pass through without action
    process.exit(0);
  }

  const toolName = event?.tool_name ?? "";
  const toolInput = event?.tool_input ?? {};

  // Only advise on Bash tool
  if (!LARGE_OUTPUT_TOOLS.has(toolName)) {
    process.exit(0);
  }

  const command = toolInput?.command ?? "";

  const isNoisy = NOISY_COMMAND_PATTERNS.some((p) => p.test(command));
  const isLong = command.length > LARGE_COMMAND_THRESHOLD;

  if (isNoisy || isLong) {
    // Output advisory as a stderr message (visible to Claude, not blocking)
    process.stderr.write(
      `[zc-ctx] Advisory: This command may produce large output. ` +
      `Consider using zc_batch or zc_execute to run it in the sandbox ` +
      `and keep the context window clean.\n`
    );
  }

  // Always exit 0 — we never block tool execution
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[zc-ctx pretooluse error] ${err.message}\n`);
  process.exit(0); // Never block on hook error
});
