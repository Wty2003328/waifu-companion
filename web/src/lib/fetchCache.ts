/**
 * SWR-style fetch cache with React hook.
 *
 * Why this exists: every page used to do `useEffect(() => fetch(...))`
 * cold on mount, so re-visiting Home → Pulse → Home re-fetched the
 * same /api/status three times and showed a "loading" flash each time
 * even though the data hadn't changed. For a desktop app this kills
 * the "instant native" feel.
 *
 * The cache:
 *   - Returns the previously-fetched value SYNCHRONOUSLY on revisit
 *     (no loading state for cached URLs).
 *   - Fires a background revalidation if the entry is older than ttlMs.
 *   - Dedupes inflight requests to the same URL so two components
 *     mounting simultaneously share one network call.
 *   - Notifies subscribers when revalidation completes so the UI
 *     refreshes without re-mounting.
 *   - Supports prefix-based invalidation for mutations (after a POST
 *     that changes characters, call `invalidateCache('/api/characters')`).
 *
 * Tauri-specific note: companion-server is local (loopback), so a
 * "cold" fetch is still ~10–50ms. The cache mostly buys us instant
 * navigation + no flicker, not raw bandwidth savings.
 */
import { useEffect, useRef, useState } from 'react';

type Subscriber = () => void;

interface Entry<T = unknown> {
  data: T | undefined;
  ts: number;
  /** Promise of in-progress refetch; undefined if no fetch is pending. */
  inflight?: Promise<T>;
  /** Last error, if any (cleared on next success). */
  error?: string;
  subs: Set<Subscriber>;
}

// One global cache for the whole app. Module-level: shared across
// every consumer, persists for the lifetime of the React tree.
const cache = new Map<string, Entry>();

function getEntry<T>(url: string): Entry<T> {
  let e = cache.get(url) as Entry<T> | undefined;
  if (!e) {
    e = { data: undefined, ts: 0, subs: new Set() };
    cache.set(url, e as Entry);
  }
  return e;
}

function notify(e: Entry): void {
  for (const fn of e.subs) {
    try { fn(); } catch { /* a single bad subscriber shouldn't break others */ }
  }
}

/** Fetch + parse JSON, caching the result. Returns the cached value
 *  if fresh; otherwise fetches and updates the cache. Background
 *  refetch fires automatically if stale-but-present. */
export async function cachedJson<T>(
  url: string,
  opts: { ttlMs?: number; force?: boolean; init?: RequestInit } = {},
): Promise<T> {
  const ttl = opts.ttlMs ?? 15_000;
  const e = getEntry<T>(url);
  const now = Date.now();
  const fresh = e.data !== undefined && now - e.ts < ttl && !opts.force;
  if (fresh) return e.data!;
  if (e.inflight && !opts.force) return e.inflight;

  const p = fetch(url, opts.init)
    .then(async (r) => {
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`${r.status} ${r.statusText}${txt ? `: ${txt}` : ''}`);
      }
      return (await r.json()) as T;
    })
    .then((data) => {
      e.data = data;
      e.ts = Date.now();
      e.error = undefined;
      e.inflight = undefined;
      notify(e);
      return data;
    })
    .catch((err: Error) => {
      e.error = err.message;
      e.inflight = undefined;
      notify(e);
      throw err;
    });
  e.inflight = p;
  return p;
}

/** Mark cached entries whose key starts with `prefix` as stale and
 *  force a refetch on next read. Keeps the existing `data` so
 *  subscribers don't flash a loading state during the refetch
 *  (stale-while-revalidate). Call after any mutation that
 *  invalidates a server resource (e.g. after `POST /api/characters`,
 *  call `invalidateCache('/api/characters')`).
 *
 *  Subscribers re-render once when invalidated (so optimistic UI
 *  patches in their useState pick up the cache too if they read from
 *  it), then re-render again when the refetch completes with fresh
 *  data. */
export function invalidateCache(prefix: string): void {
  for (const [k, e] of cache.entries()) {
    if (k.startsWith(prefix)) {
      e.ts = 0; // force refetch on next access
      e.error = undefined;
      // Kick off a background refetch immediately so subscribers see
      // fresh data without waiting for someone to read the URL.
      if (!e.inflight) {
        void cachedJson(k).catch(() => { /* surfaced via e.error */ });
      }
      notify(e);
    }
  }
}

/** Fire-and-forget GETs to populate the cache before the user
 *  navigates. Retries with exponential backoff to ride out
 *  companion-server's startup window — without retry, the first
 *  prewarm typically races the sidecar boot and leaves a cached
 *  "TypeError: Failed to fetch" that flashes briefly when the user
 *  lands on a page. Each failed attempt also clears the cached
 *  error so consumers see "loading…" rather than the prewarm's
 *  transient failure. */
export function prewarm(urls: string[]): void {
  for (const url of urls) {
    prewarmOne(url, 0);
  }
}

const PREWARM_MAX_RETRIES = 6; // ~6 attempts over ~6s — covers sidecar startup
const PREWARM_BASE_DELAY_MS = 200;
const PREWARM_MAX_DELAY_MS = 2000;

function prewarmOne(url: string, attempt: number): void {
  cachedJson(url).catch(() => {
    // Suppress the failure on the cache entry so any concurrently-
    // mounting component doesn't render an error from a transient
    // boot-time race. The retry below will eventually populate
    // it (or genuinely give up after PREWARM_MAX_RETRIES).
    const e = cache.get(url);
    if (e) {
      e.error = undefined;
      notify(e);
    }
    if (attempt >= PREWARM_MAX_RETRIES) return;
    const delay = Math.min(
      PREWARM_BASE_DELAY_MS * Math.pow(2, attempt),
      PREWARM_MAX_DELAY_MS,
    );
    setTimeout(() => prewarmOne(url, attempt + 1), delay);
  });
}

/** React hook: returns the cached value (if any) instantly, then
 *  keeps it fresh via background revalidation. The component
 *  re-renders when the cache for `url` updates (whether by this
 *  component, another component, or `invalidateCache`).
 *
 *  Pass `null` for `url` to disable (useful for conditional fetches). */
export function useCachedJson<T>(
  url: string | null,
  ttlMs: number = 15_000,
): {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  /** Force a refetch ignoring the cache TTL. */
  refetch: () => Promise<void>;
} {
  // Tick state forces re-render when the cache notifies us.
  const [, setTick] = useState(0);
  const tickRef = useRef(0);
  const bump = () => { tickRef.current++; setTick(tickRef.current); };

  // Subscribe to this URL's cache entry for the lifetime of the hook.
  useEffect(() => {
    if (!url) return;
    const e = getEntry<T>(url);
    e.subs.add(bump);
    // Kick off a revalidation if we're stale or empty.
    void cachedJson<T>(url, { ttlMs }).catch(() => { /* surfaced via e.error */ });
    return () => { e.subs.delete(bump); };
    // We deliberately re-subscribe whenever url or ttlMs changes.
  }, [url, ttlMs]);

  if (!url) {
    return { data: undefined, error: null, loading: false, refetch: async () => {} };
  }
  const e = getEntry<T>(url);
  // When we have no cached data yet, mask any pending error: the hook's
  // useEffect kicks off a fresh fetch on mount, so a stale prewarm
  // failure (e.g. "TypeError: Failed to fetch" from companion-server
  // still booting) shouldn't flash on screen before that fetch lands.
  // Once we've successfully fetched at least once, errors from later
  // refetches DO surface so the user notices when the server stops.
  const hasData = e.data !== undefined;
  return {
    data: e.data,
    error: hasData ? (e.error ?? null) : null,
    loading: !hasData,
    refetch: async () => {
      try { await cachedJson<T>(url, { ttlMs, force: true }); }
      catch { /* surfaced via e.error */ }
    },
  };
}

/** Inspect the cache (debug helper). Returns shallow copies. */
export function cacheStats(): Array<{ url: string; ageMs: number; subs: number; hasError: boolean }> {
  const now = Date.now();
  return Array.from(cache.entries()).map(([k, e]) => ({
    url: k,
    ageMs: e.ts ? now - e.ts : -1,
    subs: e.subs.size,
    hasError: !!e.error,
  }));
}
