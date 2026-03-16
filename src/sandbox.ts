import { spawn, spawnSync } from "node:child_process";
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
const SAFE_ENV: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };

// On Windows, python3 is often a Microsoft Store redirect stub that fails silently.
// Detect the correct Python binary once at startup.
const PYTHON_CMD: string = (() => {
  if (process.platform === "win32") {
    const test = spawnSync("python", ["--version"], {
      env: SAFE_ENV,
      timeout: 5_000,
      stdio: "ignore",
    });
    if (test.status === 0 && !test.error) return "python";
    // Fall through to python3 if python not found
  }
  return "python3";
})();

// SECURITY: All code is delivered via stdin, not as a command-line argument.
// This prevents two threats:
//   1. ENAMETOOLONG crash on Windows/Linux when code exceeds arg limits (~32KB)
//   2. Code leaking into process argument lists (visible via `ps aux` on shared systems)
// Each entry is [executable, ...fixed_args] — code is piped to stdin, never appended.
const INTERPRETERS: Record<string, readonly string[]> = {
  python:     [PYTHON_CMD],                    // python reads from stdin when no script arg
  python3:    [PYTHON_CMD],
  javascript: ["node", "--input-type=module"], // node --input-type=module reads from stdin
  js:         ["node", "--input-type=module"],
  bash:       ["bash"],                        // bash reads from stdin when no -c arg
  sh:         ["bash"],
};

function cap(buf: Buffer, limit: number): { text: string; truncated: boolean } {
  if (buf.length <= limit) return { text: buf.toString("utf8"), truncated: false };
  return { text: buf.subarray(0, limit).toString("utf8") + TRUNCATION_MARKER, truncated: true };
}

// SECURITY: Kill the entire process tree, not just the direct child.
// Without this, code that spawns background subprocesses can escape the timeout.
// Windows: use taskkill /T /F to kill the process tree.
// Unix: spawn with detached:true (process group leader), kill -PID to kill group.
function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5_000,
      });
    } else {
      // Kill the entire process group (negative PID on Unix)
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // Best-effort: fall back to single-process kill
    try { child.kill("SIGKILL"); } catch {}
  }
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

  // SECURITY: Node's child_process.spawn throws ERR_INVALID_ARG_VALUE if any
  // arg contains a null byte. Sanitize the code string defensively.
  // We replace \x00 with a visible marker so the user sees it was stripped.
  const safeCode = code.replace(/\x00/g, "\\x00");

  // All languages use stdin — interp is just [cmd, ...fixed_args], code piped via stdin
  const cmd = interp[0]!;
  const fixedArgs = interp.slice(1) as string[];

  return new Promise((resolve) => {
    const chunks: { out: Buffer[]; err: Buffer[] } = { out: [], err: [] };
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;

    const child = spawn(cmd, fixedArgs, {
      env: SAFE_ENV,
      stdio: ["pipe", "pipe", "pipe"],  // always stdin for code delivery
      shell: false,   // SECURITY: never use shell:true (prevents shell injection)
      // SECURITY: detached:true on Unix creates a process group so we can kill all descendants.
      // On Windows we use taskkill /T instead.
      detached: process.platform !== "win32",
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
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

    // Deliver code via stdin — same for all languages
    if (child.stdin) {
      child.stdin.write(safeCode, "utf8");
      child.stdin.end();
    }

    // Unreference the child so Node's event loop doesn't wait for it when killed
    child.unref();

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
  const tmpFile = join(tmpdir(), `zc-ctx-${randomBytes(8).toString("hex")}.py`);
  try {
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
