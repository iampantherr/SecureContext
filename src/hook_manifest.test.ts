/**
 * Issue #5 tripwire — hooks/manifest.json is the single source of truth.
 *
 * The failure this guards: the two install paths drifted to DISJOINT hook sets
 * (plugin.json registered auto-extract; init.mjs's hardcoded list did not), so
 * behaviour depended on how the user installed and nobody documented the
 * difference. Auto-extract was silently inert on CLI installs — the
 * fabricated-value family at the packaging layer.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "hooks", "manifest.json"), "utf8"));

describe("hook manifest is the single source of truth", () => {
  it("every manifest script exists in hooks/", () => {
    for (const w of manifest.cliHooks) {
      expect(existsSync(join(ROOT, "hooks", w.script)), `${w.script} missing`).toBe(true);
    }
    for (const scripts of Object.values(manifest.pluginHooks).filter(Array.isArray) as string[][]) {
      for (const s of scripts) expect(existsSync(join(ROOT, s)), `${s} missing`).toBe(true);
    }
  });

  it("init.mjs carries NO hardcoded hook list — it must read the manifest", () => {
    const init = readFileSync(join(ROOT, "init.mjs"), "utf8");
    expect(init).toContain('manifest.json');
    // The old drift vector: an inline array of {event, matcher, script} literals.
    expect(/const wanted = \[\s*\{/.test(init), "hardcoded wanted list returned").toBe(false);
  });

  it("plugin.json matches manifest.pluginHooks exactly (legacy generation, tracked)", () => {
    const plugin = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    const want: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(manifest.pluginHooks)) {
      if (Array.isArray(v)) want[k] = v as string[];
    }
    expect(plugin.hooks).toEqual(want);
  });

  it("the CLI set covers the four capabilities issue #5 found missing", () => {
    const scripts = manifest.cliHooks.map((w: { script: string }) => w.script);
    for (const must of ["stop-autoextract.mjs", "userprompt-autoextract.mjs", "prewrite-impact.mjs", "learnings-indexer.mjs"]) {
      expect(scripts, `${must} absent from cliHooks`).toContain(must);
    }
  });

  it("non-win32 platforms skip platform-gated hooks cleanly", () => {
    const posix = manifest.cliHooks.filter((w: { platform?: string }) => !w.platform || w.platform === "linux");
    // ps1 hooks must all be platform-gated so a linux install never registers them
    for (const w of manifest.cliHooks) {
      if (w.script.endsWith(".ps1")) expect(w.platform, `${w.script} lacks platform gate`).toBe("win32");
    }
    expect(posix.length).toBeGreaterThanOrEqual(11);
  });

  it("no duplicate (event, matcher, script) registrations", () => {
    const seen = new Set<string>();
    for (const w of manifest.cliHooks) {
      const k = `${w.event}|${w.matcher}|${w.script}`;
      expect(seen.has(k), `duplicate: ${k}`).toBe(false);
      seen.add(k);
    }
  });
});
