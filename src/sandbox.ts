import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Security constants — never increase these without explicit user approval
const TIMEOUT_MS = 30_000;
const STDOUT_CAP = 512 * 1024;  // 512 KB
const STDERR_CAP = 64 * 1024;   // 64 KB
const TRUNCATION_MARKER = "\n[OUTPUT TRUNCATED — exceeded size limit]";

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

// SECURITY: Only PATH is passed — zero credential variables.
// This prevents any code run in the sandbox from reading GH_TOKEN,
// AWS_ACCESS_KEY_ID, ANTHROPIC_API_KEY, or any other env credentials.
const SAFE_ENV = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };

const INTERPRETERS: Record<string, string[]> = {
  python:     ["python3", "-c"],
  python3:    ["python3", "-c"],
  javascript: ["node", "--input-type=module"],
  js:         ["node", "--input-type=module"],
  bash:       ["bash", "-c"],
  sh:         ["bash", "-c"],
};

function cap(buf: Buffer, limit: number): { text: string; truncated: boolean } {
  if (buf.length <= limit) return { text: buf.toString("utf8"), truncated: false };
  return { text: buf.subarray(0, limit).toString("utf8") + TRUNCATION_MARKER, truncated: true };
}

export async function runInSandbox(
  language: string,
  code: string
): Promise<SandboxResult> {
  const interp = INTERPRETERS[language.toLowerCase()];
  if (!interp) {
    return {
      stdout: "",
      stderr: `Unsupported language: ${language}. Supported: ${Object.keys(INTERPRETERS).join(", ")}`,
      exitCode: 1,
      timedOut: false,
      truncated: false,
    };
  }

  // For node ESM we need stdin, for others we pass code as -c argument.
  // Python and bash: spawn([interp, "-c", code]) with no stdin needed.
  // Node: spawn([node, --input-type=module]) and write code to stdin.
  const useStdin = interp[0] === "node";
  const args = useStdin ? [interp[1]!] : [interp[1]!, code];
  const cmd = interp[0]!;

  return new Promise((resolve) => {
    const chunks: { out: Buffer[]; err: Buffer[] } = { out: [], err: [] };
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;

    const child = spawn(cmd, args, {
      env: SAFE_ENV,
      stdio: useStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      shell: false, // SECURITY: never use shell:true (prevents shell injection)
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (outLen < STDOUT_CAP) {
        chunks.out.push(chunk);
        outLen += chunk.length;
      } else {
        truncated = true;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (errLen < STDERR_CAP) {
        chunks.err.push(chunk);
        errLen += chunk.length;
      }
    });

    if (useStdin && child.stdin) {
      child.stdin.write(code, "utf8");
      child.stdin.end();
    }

    child.on("close", (code) => {
      clearTimeout(timer);
      const outBuf = Buffer.concat(chunks.out);
      const errBuf = Buffer.concat(chunks.err);
      const out = cap(outBuf, STDOUT_CAP);
      const err = cap(errBuf, STDERR_CAP);

      resolve({
        stdout: out.text,
        stderr: err.text,
        exitCode: code,
        timedOut,
        truncated: truncated || out.truncated || err.truncated,
      });
    });
  });
}

export async function runFileInSandbox(
  filePath: string,
  language: string,
  analysisCode: string
): Promise<SandboxResult> {
  // Write analysis code to a temp file to avoid argument-injection
  const tmpFile = join(tmpdir(), `zc-ctx-${randomBytes(8).toString("hex")}.py`);
  try {
    // Inject the file path as an env var inside the code (not via shell)
    const wrappedCode = `
import os
TARGET_FILE = ${JSON.stringify(filePath)}
${analysisCode}
`.trim();
    await writeFile(tmpFile, wrappedCode, "utf8");
    return await runInSandbox("python", `exec(open(${JSON.stringify(tmpFile)}).read())`);
  } finally {
    await unlink(tmpFile).catch(() => undefined);
  }
}
