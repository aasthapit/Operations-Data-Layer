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

// Map keeps insertion order, so "oldest" is simply the first key: re-inserting
// on every read makes it a least-recently-used cache.
const entries = new Map();      // url -> data
const inflight = new Map();     // url -> record
const listeners = new Set();    // invalidation subscribers

export function peek(url) {
  if (!url || !entries.has(url)) return undefined;
  const value = entries.get(url);
  entries.delete(url);
  entries.set(url, value);
  return value;
}

export function put(url, data) {
  if (!url) return;
  entries.delete(url);
  entries.set(url, data);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
}

export function drop(url) {
  entries.delete(url);
}

// Newest cached response first, so a view can borrow a summary it has not
// fetched itself (the cluster header comes from whatever cluster list is
// already in hand while the detail request is still in flight).
export function search(prefix, pick) {
  const keys = [...entries.keys()].reverse();
  for (const key of keys) {
    if (prefix && !key.startsWith(prefix)) continue;
    const hit = pick(entries.get(key), key);
    if (hit) return hit;
  }
  return null;
}

// invalidate() with no prefix clears everything.
export function invalidate(prefix = "") {
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

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// request(url, fetcher) -> { promise, release }
//
// fetcher(signal) does the actual GET. Callers must call release() when they
// stop caring (unmount, or the key changed); the fetch is aborted once nobody
// is left waiting for it, so rapid clicking cannot land an old response on top
// of a newer one.
export function request(url, fetcher) {
  let rec = inflight.get(url);
  if (!rec || rec.stale) {
    const controller = typeof AbortController === "undefined" ? null : new AbortController();
    const fresh = { controller, refs: 0, timer: null, stale: false };
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
  return { promise: rec.promise, release: () => release(url, rec) };
}

function release(url, rec) {
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

export const isAbort = (e) => !!e && (e.name === "AbortError" || e.code === 20);

// Test / debug aid: how much is held.
export const size = () => entries.size;
