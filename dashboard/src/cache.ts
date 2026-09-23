// In-memory response cache, keyed by request URL.
//
// Every GET the dashboard makes is stored here so a view the user comes back to
// paints from the last response immediately and refreshes behind it, instead of
// blocking on the network again. Three jobs:
//
//   - remember  : an LRU of at most MAX_ENTRIES responses (nothing persists to
//                 disk; a reload starts cold, which is what people expect).
//   - dedupe    : concurrent requests for the same URL share one fetch, and the
//                 fetch is aborted when the last view waiting for it goes away.
//   - invalidate: "Refresh data" drops what is cached under a prefix and tells
//                 every mounted hook to re-read.

const MAX_ENTRIES = 100;

/** A response in flight, and who is still waiting for it. */
interface InflightRecord {
  controller: AbortController | null;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set by `invalidate`: a response already on the wire predates the refresh,
   * so it must not land in the cache as if it were fresh. */
  stale: boolean;
  promise?: Promise<unknown>;
}

/** What a view hands `request`: it does the GET and resolves with the body. */
export type Fetcher = (signal?: AbortSignal) => Promise<unknown>;

/** Called with the invalidated prefix (empty string = everything). */
export type InvalidationListener = (prefix: string) => void;

// Map keeps insertion order, so "oldest" is simply the first key: re-inserting
// on every read makes it a least-recently-used cache.
const entries = new Map<string, unknown>();            // url -> data
const inflight = new Map<string, InflightRecord>();    // url -> record
const listeners = new Set<InvalidationListener>();     // invalidation subscribers

export function peek(url: string | null | undefined): unknown {
  if (!url || !entries.has(url)) return undefined;
  const value = entries.get(url);
  entries.delete(url);
  entries.set(url, value);
  return value;
}

export function put(url: string | null | undefined, data: unknown): void {
  if (!url) return;
  entries.delete(url);
  entries.set(url, data);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
}

export function drop(url: string | null | undefined): void {
  // A hook with no key calls this on "reload" like any other, so "drop
  // nothing" is a real case rather than a caller mistake.
  if (url) entries.delete(url);
}

// Newest cached response first, so a view can borrow a summary it has not
// fetched itself (the cluster header comes from whatever cluster list is
// already in hand while the detail request is still in flight).
// why: the cache holds every response the app has seen, so what is under a key
// is only knowable from the prefix the caller searched. `Data` defaults to
// `any` so an existing caller reads as it did; naming it (`search<ClustersResponse, _>`)
// is what a converted caller does instead.
export function search<Data = any, Hit = unknown>(
  prefix: string,
  pick: (data: Data, key: string) => Hit | null | undefined | false,
): Hit | null {
  const keys = [...entries.keys()].reverse();
  for (const key of keys) {
    if (prefix && !key.startsWith(prefix)) continue;
    const hit = pick(entries.get(key) as Data, key);
    if (hit) return hit;
  }
  return null;
}

// invalidate() with no prefix clears everything.
export function invalidate(prefix = ""): void {
  for (const key of [...entries.keys()]) {
    if (!prefix || key.startsWith(prefix)) entries.delete(key);
  }
  // A response that is already on the wire predates the refresh, so it must not
  // land in the cache as if it were fresh.
  for (const [key, rec] of inflight) {
    if (!prefix || key.startsWith(prefix)) rec.stale = true;
  }
  listeners.forEach((fn) => fn(prefix));
}

export function subscribe(fn: InvalidationListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// request(url, fetcher) -> { promise, release }
//
// fetcher(signal) does the actual GET. Callers must call release() when they
// stop caring (unmount, or the key changed); the fetch is aborted once nobody
// is left waiting for it, so rapid clicking cannot land an old response on top
// of a newer one.
export function request(url: string, fetcher: Fetcher):
{ promise: Promise<unknown>; release: () => void } {
  let rec = inflight.get(url);
  if (!rec || rec.stale) {
    const controller = typeof AbortController === "undefined" ? null : new AbortController();
    const fresh: InflightRecord = { controller, refs: 0, timer: null, stale: false };
    fresh.promise = fetcher(controller ? controller.signal : undefined).then(
      (data) => {
        if (!fresh.stale) put(url, data);
        if (inflight.get(url) === fresh) inflight.delete(url);
        return data;
      },
      (error) => {
        if (inflight.get(url) === fresh) inflight.delete(url);
        throw error;
      }
    );
    inflight.set(url, fresh);
    rec = fresh;
  }
  rec.refs += 1;
  if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
  const record = rec;
  return { promise: record.promise as Promise<unknown>, release: () => release(url, record) };
}

function release(url: string, rec: InflightRecord): void {
  rec.refs -= 1;
  if (rec.refs > 0 || rec.timer) return;
  // React remounts effects immediately in StrictMode, and a user can click away
  // and straight back: a short grace period keeps that from cancelling a
  // request that is about to be wanted again.
  rec.timer = setTimeout(() => {
    rec.timer = null;
    if (rec.refs > 0) return;
    if (inflight.get(url) === rec) inflight.delete(url);
    if (rec.controller) rec.controller.abort();
  }, 60);
}

export const isAbort = (e: unknown): boolean => {
  const error = e as { name?: string; code?: number } | null;
  return !!error && (error.name === "AbortError" || error.code === 20);
};

// Test / debug aid: how much is held.
export const size = (): number => entries.size;
