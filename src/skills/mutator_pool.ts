/**
 * v0.18.4 Sprint 2.7 — Mutator pool resolver.
 *
 * Maps a worker role (e.g. "developer", "marketer", "legal-counsel") to the
 * mutator pool that handles it (e.g. "mutator-engineering", "mutator-marketing",
 * "mutator-legal"). The mapping lives in `A2A_dispatcher/roles.json` under
 * the `mutator_pools` key — operator-editable, no code changes needed to add
 * new roles or pools.
 *
 * The L1 trigger reads `skill.intended_roles[0]`, calls `resolveMutatorPool`,
 * and routes the mutator task to that pool's queue (role='mutator-<pool>').
 *
 * Falls back to "mutator-general" when:
 *   - skill.intended_roles is empty/missing
 *   - the role isn't found in any pool
 *   - the registry file isn't accessible
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface MutatorPoolConfig {
  intended_roles:    string[];
  domain_summary:    string;
  style_rules:       string[];
}

export interface MutatorPoolsRegistry {
  [poolName: string]: MutatorPoolConfig;
}

/**
 * Module-level cache. Refreshed on TTL or manual reset (for tests).
 * Keep TTL short — operators may edit roles.json without restarting servers.
 */
let _cached: { registry: MutatorPoolsRegistry; loadedAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

export function _resetCache(): void { _cached = null; }

export function loadMutatorPoolsRegistry(): MutatorPoolsRegistry {
  if (_cached && (Date.now() - _cached.loadedAt) < CACHE_TTL_MS) {
    return _cached.registry;
  }
  const candidates = [
    process.env.ZC_A2A_REGISTRY_DIR
      ? join(process.env.ZC_A2A_REGISTRY_DIR, "roles.json")
      : null,
    join(homedir(), "AI_projects", "A2A_dispatcher", "roles.json"),
    join(process.cwd(), "..", "A2A_dispatcher", "roles.json"),
  ].filter((p): p is string => Boolean(p));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as { mutator_pools?: MutatorPoolsRegistry };
      const registry = data.mutator_pools ?? {};
      _cached = { registry, loadedAt: Date.now() };
      return registry;
    } catch { /* try next */ }
  }
  // No registry available — return empty so callers fall back to general
  _cached = { registry: {}, loadedAt: Date.now() };
  return {};
}

/**
 * Resolve a worker role to its mutator pool name.
 *
 *   "developer"      → "mutator-engineering"
 *   "marketer"       → "mutator-marketing"
 *   "legal-counsel"  → "mutator-legal"
 *   "unknown-role"   → "mutator-general"
 *   undefined / null → "mutator-general"
 */
export function resolveMutatorPool(role: string | null | undefined): string {
  if (!role) return "mutator-general";
  const normalized = role.toLowerCase().trim();
  const registry = loadMutatorPoolsRegistry();
  for (const [poolName, config] of Object.entries(registry)) {
    if (config.intended_roles.some((r) => r.toLowerCase() === normalized)) {
      return poolName;
    }
  }
  return "mutator-general";
}

/**
 * Get the full pool config for a pool name (for prompt composition).
 * Returns null if the pool doesn't exist in the registry.
 */
export function getMutatorPoolConfig(poolName: string): MutatorPoolConfig | null {
  const registry = loadMutatorPoolsRegistry();
  return registry[poolName] ?? null;
}

/**
 * Resolve a list of intended_roles → pool name. Uses the FIRST role as the
 * primary classifier (matches the design contract).
 */
export function resolveMutatorPoolFromIntendedRoles(intendedRoles: string[] | undefined | null): string {
  if (!intendedRoles || intendedRoles.length === 0) return "mutator-general";
  return resolveMutatorPool(intendedRoles[0]);
}
