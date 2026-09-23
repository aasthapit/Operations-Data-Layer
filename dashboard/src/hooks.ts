import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as cache from "./cache";
import type { ApiError, Loadable } from "./api";

/** What `useFetch` holds between renders. `key` is the request URL, which is
 * also the cache key. */
interface FetchState<T> {
  key: string | null;
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  stale: boolean;
}

export interface Fetched<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  stale: boolean;
  reload: () => void;
}

// Stale-while-revalidate data fetching.
//
//   const { data, error, loading, stale, reload } = useFetch(() => api.clusters(f), [key]);
//
//   data    the response, or the last one seen for this URL - so a view the user
//           has already visited paints at once instead of blocking on the wire
//   loading a request is in flight (with `data` set, it is a background refresh)
//   stale   `data` is a cached response and a refresh is running behind it
//   error   the last failure, cleared by the next success
//   reload  drop this URL from the cache and re-read it
//
// The cache key is the request URL, which the api descriptor carries, so two
// views asking for the same thing share one response and one in-flight fetch.
// The fetch is aborted when the last hook waiting on it unmounts or moves to a
// different key, so a burst of clicks cannot paint an old response over a new one.
// `fn` may answer with nothing: half the views ask conditionally ("the detail
// request, but only once there is a name"), and the hook has always read that
// as "no key, no request, no loading state". Saying `| null` here is what makes
// those call sites type-check as what they are rather than as mistakes.
export function useFetch<T = unknown>(fn: () => Loadable<T> | null,
  deps: unknown[] = []): Fetched<T> {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // Building the descriptor is pure (it only assembles a URL), so the key is
  // known during render - which is what lets cached data render immediately.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const req = useMemo(() => fnRef.current(), deps);
  const key = req && req.url ? req.url : null;

  const [state, setState] = useState<FetchState<T>>(() => fromCache<T>(key));
  const [nonce, setNonce] = useState(0);
  if (state.key !== key) setState(fromCache<T>(key));

  const reqRef = useRef(req);
  reqRef.current = req;

  const load = useCallback(() => {
    if (!key) return undefined;
    let live = true;
    setState((s) => (s.loading && s.key === key ? s : { ...s, key, loading: true, stale: s.data != null }));
    // why: `key` is the descriptor's own url, so a key exists only when `fn`
    // returned a descriptor - and the `if (!key)` above has already left when
    // it did not. The ref is read when the fetch starts rather than captured,
    // so a re-render with the same url but a fresh descriptor loads through
    // the current one.
    const { promise, release } = cache.request(key, (signal) => reqRef.current!.load(signal));
    promise.then(
      (data) => { if (live) setState({ key, data: data as T, error: null, loading: false, stale: false }); },
      (error: ApiError) => {
        if (!live || cache.isAbort(error)) return;
        setState((s) => ({ ...s, key, error, loading: false, stale: false }));
      }
    );
    return () => { live = false; release(); };
  }, [key]);

  // deps are part of the effect so a view can ask for the same URL again (the
  // overview re-reads itself while a sweep runs) without changing the key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [key, nonce, load, ...deps]);

  // "Refresh data" (and any manual refresh) drops cache entries and wakes every
  // hook reading under that prefix.
  useEffect(() => cache.subscribe((prefix) => {
    if (key && (!prefix || key.startsWith(prefix))) setNonce((n) => n + 1);
  }), [key]);

  const reload = useCallback(() => {
    cache.drop(key);
    setNonce((n) => n + 1);
  }, [key]);

  return { data: state.data, error: state.error, loading: state.loading, stale: state.stale, reload };
}

function fromCache<T>(key: string | null): FetchState<T> {
  const cached = cache.peek(key);
  return {
    key,
    data: cached === undefined ? null : (cached as T),
    error: null,
    loading: !!key,
    stale: cached !== undefined,
  };
}
