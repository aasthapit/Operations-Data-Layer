// What a view needs around it: the navigation object App builds, and a route
// object read from a URL the test names.
//
// The views take `route` and `nav` as props rather than reaching for a router,
// so a test can hand them the real ones (through useRoute) and then assert on
// window.location - which is what the app itself treats as its state.
import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { useRoute } from "../router";
import type { QueryValues, RouteApi } from "../router";

/** The navigation object App assembles and hands every view. */
export type Nav = ReturnType<typeof makeNav>;

const enc = encodeURIComponent;

// The same object App.jsx assembles, over whatever navigate the test wants.
export function makeNav(navigate: RouteApi["navigate"], back = vi.fn()) {
  return {
    openCluster: vi.fn((name: string, tab?: string) =>
      navigate(`/clusters/${enc(name)}${tab ? `/${tab}` : ""}`)),
    openApp: vi.fn((name?: string) => navigate(name ? `/applications/${enc(name)}` : "/applications")),
    goClusters: vi.fn((k?: string, v?: string) => navigate("/clusters", k ? { [k]: v } : {})),
    goBlast: vi.fn((query?: QueryValues) => navigate("/blast", query || {})),
    goInsights: vi.fn((section?: string) => navigate(`/insights/${section || "certificates"}`)),
    goDashboard: vi.fn((id?: string, query?: QueryValues) =>
      navigate(id ? `/dashboards/${enc(id)}` : "/dashboards", query || {})),
    goPatchJob: vi.fn((id: string) => navigate(`/patching/${enc(id)}`)),
    back,
  };
}

// Render a view with a live route and nav. `at` is the URL the page is opened
// on; `render` is called with { route, nav } every time the route changes, so
// the view sees the new query string the way it does in the app.
export function renderView(build: (props: { route: RouteApi; nav: Nav }) => ReactNode,
  { at = "/" }: { at?: string } = {}) {
  window.history.replaceState({ odl: 0 }, "", at);
  const back = vi.fn();
  let navRef: Nav | null = null;

  function Host() {
    const route = useRoute();
    if (!navRef) navRef = makeNav(route.navigate, back);
    // navigate is stable across renders, so the nav object can be too.
    return build({ route, nav: navRef });
  }

  const view = render(<Host />);
  return { ...view, back, nav: () => navRef };
}

// Where the page ended up, as the app itself would read it.
export const currentUrl = () => window.location.pathname + window.location.search;
