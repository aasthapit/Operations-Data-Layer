// Minimal History-API router: the URL is the navigation state, so the browser
// back/forward buttons work and every page, sub-tab and filter is shareable.
//
//   /                       overview
//   /clusters?region=..     cluster list (filters in the query string)
//   /clusters/:name/:tab    cluster detail + sub-tab
//   /applications/:app      application detail
//   /insights/:section      insights sub-tab
//   ...
import { useCallback, useEffect, useState } from "react";

/** The URL, parsed. `segments` is the path split and decoded, which is how
 * every view reads its own parameters. */
export interface Route {
  path: string;
  query: Record<string, string>;
  segments: string[];
}

export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
}

/** What `useRoute` hands a view: the parsed URL plus the two ways to change it. */
export interface RouteApi extends Route {
  navigate: (path: string, query?: QueryValues, options?: NavigateOptions) => void;
  back: (fallback?: string, query?: QueryValues) => void;
}

/** Query-string values as a view supplies them. `false` and empty drop out, so
 * a filter that is off leaves no trace in the URL. */
export type QueryValues = Record<string, string | number | boolean | null | undefined>;

/** The navigation object `App` assembles over `useRoute` and hands to every
 * view: the places a view can send the user, named for what they mean rather
 * than for the URLs they happen to produce today.
 *
 * It lives here rather than in `App.tsx` for two reasons: the views would
 * otherwise import a type from the module that imports them, and this is
 * already the module that owns what navigation means to a view (`RouteApi`,
 * `QueryValues`). The methods are written in method shorthand on purpose -
 * that keeps their parameters bivariant, so the test harness's `makeNav`, whose
 * signatures are inferred from `vi.fn` wrappers, still satisfies this type when
 * `strictFunctionTypes` arrives. */
export interface Nav {
  /** Open a cluster, optionally on one of its sub-tabs. */
  openCluster(name: string, tab?: string): void;
  /** Open an application, or the list when there is no name. */
  openApp(name?: string | null): void;
  /** The cluster list, narrowed by one filter the list understands. */
  goClusters(key?: string, value?: string): void;
  goBlast(query?: QueryValues): void;
  goInsights(section?: string): void;
  goDashboard(id?: string, query?: QueryValues): void;
  goPatchJob(id: string): void;
  /** Step back through this app's own history, or to `fallback` when there is
   * none - the "← All clusters" affordance. */
  back(fallback?: string, query?: QueryValues): void;
}

function parse(): Route {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const query = Object.fromEntries(new URLSearchParams(window.location.search));
  return { path, query, segments: path.split("/").filter(Boolean).map(decodeURIComponent) };
}

export function buildUrl(path: string, query: QueryValues = {}): string {
  const qs = new URLSearchParams(
    Object.entries(query)
      .filter(([, v]) => v !== "" && v != null && v !== false)
      .map(([k, v]) => [k, String(v)])
  ).toString();
  return path + (qs ? `?${qs}` : "");
}

// How deep into this app's own history we are. It rides in the history entry
// itself, so it survives a reload and follows back/forward: "← All clusters"
// can then step back to the list the user actually came from (filters and all)
// and still do something sensible when the detail page was opened cold.
const depth = (): number => {
  const s = window.history.state as { odl?: unknown } | null;
  return s && typeof s.odl === "number" ? s.odl : 0;
};

export function useRoute(): RouteApi {
  const [route, setRoute] = useState(parse);

  useEffect(() => {
    const onPop = () => setRoute(parse());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // navigate(path, query, { replace }) - replace is for filter/search changes so
  // the back button steps between pages, not between keystrokes.
  const navigate = useCallback((path: string, query: QueryValues = {},
    { replace = false }: NavigateOptions = {}) => {
    const url = buildUrl(path, query);
    if (url === window.location.pathname + window.location.search) return;
    const next = { odl: replace ? depth() : depth() + 1 };
    window.history[replace ? "replaceState" : "pushState"](next, "", url);
    // A new page starts at the top; a filter change stays where the user is.
    // Back and forward keep the browser's own scroll restoration.
    if (!replace) window.scrollTo(0, 0);
    setRoute(parse());
  }, []);

  // A "← back to the list" affordance: step back through our own history when
  // there is any, otherwise go to the page that link stands for.
  const back = useCallback((fallback = "/", query: QueryValues = {}) => {
    if (depth() > 0) window.history.back();
    else navigate(fallback, query);
  }, [navigate]);

  return { ...route, navigate, back };
}

/** Filters stored in the query string: the values, a setter, a reset, and
 * whether any of them is on. */
export type QueryFilters = [
  values: Record<string, string>,
  set: (key: string, value: string) => void,
  clear: () => void,
  active: boolean,
];

export function useQueryFilters(route: RouteApi, keys: string[]): QueryFilters {
  const values: Record<string, string> = {};
  keys.forEach((k) => { values[k] = route.query[k] || ""; });
  const set = (k: string, v: string) =>
    route.navigate(route.path, { ...route.query, [k]: v || "" }, { replace: true });
  const clear = () => {
    const rest = { ...route.query };
    keys.forEach((k) => delete rest[k]);
    route.navigate(route.path, rest, { replace: true });
  };
  const active = keys.some((k) => values[k]);
  return [values, set, clear, active];
}

// The same, for the handful of places that set several keys at once (running a
// blast-radius query replaces the whole form).
export function setQuery(route: RouteApi, next: QueryValues,
  { replace = false }: NavigateOptions = {}) {
  route.navigate(route.path, next, { replace });
}
