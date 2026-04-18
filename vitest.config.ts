/**
 * Vitest config — exclude dist/ (compiled artifacts) from test discovery
 * + isolate test files from each other to prevent shared-state interference
 * across the security/ test suite (which touches ~/.claude/zc-ctx/.machine_secret).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [
      "node_modules/**",
      "dist/**",
      ".harness-planning/**",
    ],
    // Run test FILES sequentially to avoid shared filesystem state
    // (machine_secret + audit_log files are per-machine, not per-test).
    // Within a file, tests still run in declared order.
    fileParallelism: false,
  },
});
