import { spawn, spawnSync } from "node:child_process";
import { Config } from "./config.js";

// Security constants come from Config — single source of truth
const TIMEOUT_MS  = Config.SANDBOX_TIMEOUT_MS;
const STDOUT_CAP  = Config.SANDBOX_STDOUT_CAP;
const STDERR_CAP  = Config.SANDBOX_STDERR_CAP;
const TRUNCATION_MARKER = "\n[OUTPUT TRUNCATED — exceeded size limit]";

export interface SandboxResult {
  stdout:    string;
  stderr:    string;
  exitCode:  number | null;
  timedOut:  boolean;
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
      env:     SAFE_ENV,
      timeout: 5_000,
      stdio:   "ignore",
    });
    if (test.status === 0 && !test.error) return "python";
  }
  return "python3";
})();

// SECURITY: All code is delivered via stdin, not as a command-line argument.
// Prevents: (1) ENAMETOOLONG crash on long code, (2) code leaking into process list.
const INTERPRETERS: Record<string, readonly string[]> = {
  python:     [PYTHON_CMD],
  python3:    [PYTHON_CMD],
  javascript: ["node", "--input-type=module"],
  js:         ["node", "--input-type=module"],
  bash:       ["bash"],
  sh:         ["bash"],
};

function cap(buf: Buffer, limit: number): { text: string; truncated: boolean } {
  if (buf.length <= limit) return { text: buf.toString("utf8"), truncated: false };
  return { text: buf.subarray(0, limit).toString("utf8") + TRUNCATION_MARKER, truncated: true };
}

// SECURITY: Kill the entire process tree, not just the direct child.
function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio:   "ignore",
        timeout: 5_000,
      });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
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

  // SECURITY: sanitize null bytes — Node throws ERR_INVALID_ARG_VALUE on \x00 in args
  const safeCode = code.replace(/\x00/g, "\\x00");

  const cmd       = interp[0]!;
  const fixedArgs = interp.slice(1) as string[];

  return new Promise((resolve) => {
    const chunks: { out: Buffer[]; err: Buffer[] } = { out: [], err: [] };
    let outLen    = 0;
    let errLen    = 0;
    let truncated = false;
    let timedOut  = false;

    const child = spawn(cmd, fixedArgs, {
      env:      SAFE_ENV,
      stdio:    ["pipe", "pipe", "pipe"],
      shell:    false, // SECURITY: never shell:true (prevents shell injection)
      detached: process.platform !== "win32", // create process group for killProcessTree
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

    if (child.stdin) {
      child.stdin.write(safeCode, "utf8");
      child.stdin.end();
    }

    child.unref();

    child.on("close", (code) => {
      clearTimeout(timer);
      const outBuf = Buffer.concat(chunks.out);
      const errBuf = Buffer.concat(chunks.err);
      const out    = cap(outBuf, STDOUT_CAP);
      const err    = cap(errBuf, STDERR_CAP);

      resolve({
        stdout:    out.text,
        stderr:    err.text,
        exitCode:  code,
        timedOut,
        truncated: truncated || out.truncated || err.truncated,
      });
    });
  });
}

/**
 * Run analysis code against a specific file.
 *
 * Gap 8 fix: TARGET_FILE is delivered via stdin as part of the code string,
 * NOT injected as an env variable or command-line argument. This prevents
 * the file path from appearing in the process argument list (ps aux).
 *
 * The analysis code receives TARGET_FILE as a Python variable set before it runs.
 */
export async function runFileInSandbox(
  filePath: string,
  language: string,
  analysisCode: string
): Promise<SandboxResult> {
  // SECURITY: Deliver TARGET_FILE via stdin (part of the code string), not env or args.
  // JSON.stringify safely escapes backslashes, quotes, and special chars in the path.
  const wrappedCode = `TARGET_FILE = ${JSON.stringify(filePath)}\n${analysisCode}`;
  return runInSandbox(language, wrappedCode);
}
