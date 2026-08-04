/**
 * Per-key trailing debounce for fire-and-forget background rebuilds (v0.56.0).
 * Extracted because backlinks.ts and call_edges.ts each carried their own copy
 * of the same Map + timer logic — the second copy written while its author was
 * enforcing a no-duplication ladder on everyone else.
 */
export function makeDebounced(fn: (key: string) => void, ms: number): { run: (key: string) => void; cancel: (key: string) => boolean } {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    run(key: string): void {
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => { timers.delete(key); fn(key); }, ms);
      if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
      timers.set(key, t);
    },
    cancel(key: string): boolean {
      const t = timers.get(key);
      if (t) { clearTimeout(t); timers.delete(key); return true; }
      return false;
    },
  };
}
