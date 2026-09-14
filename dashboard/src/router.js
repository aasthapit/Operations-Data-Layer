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

function parse() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const query = Object.fromEntries(new URLSearchParams(window.location.search));
  return { path, query, segments: path.split("/").filter(Boolean).map(decodeURIComponent) };
}

export function buildUrl(path, query = {}) {
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== "" && v != null && v !== false)
  ).toString();
  return path + (qs ? `?${qs}` : "");
}

// How deep into this app's own history we are. It rides in the history entry
// itself, so it survives a reload and follows back/forward: "← All clusters"
// can then step back to the list the user actually came from (filters and all)
// and still do something sensible when the detail page was opened cold.
const depth = () => {
  const s = window.history.state;
  return s && typeof s.odl === "number" ? s.odl : 0;
};

export function useRoute() {
  const [route, setRoute] = useState(parse);

  useEffect(() => {
    const onPop = () => setRoute(parse());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // navigate(path, query, { replace }) - replace is for filter/search changes so
  // the back button steps between pages, not between keystrokes.
  const navigate = useCallback((path, query = {}, { replace = false } = {}) => {
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
  const back = useCallback((fallback = "/", query = {}) => {
    if (depth() > 0) window.history.back();
    else navigate(fallback, query);
  }, [navigate]);

  return { ...route, navigate, back };
}

// Filters stored in the query string. Returns [values, set(key, value), clear()].
export function useQueryFilters(route, keys) {
  const values = {};
  keys.forEach((k) => { values[k] = route.query[k] || ""; });
  const set = (k, v) => route.navigate(route.path, { ...route.query, [k]: v || "" }, { replace: true });
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
export function setQuery(route, next, { replace = false } = {}) {
  route.navigate(route.path, next, { replace });
}
