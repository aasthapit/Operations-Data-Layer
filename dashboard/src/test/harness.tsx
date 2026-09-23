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
import type { Nav, QueryValues, RouteApi } from "../router";

const enc = encodeURIComponent;

// The same object App.tsx assembles, over whatever navigate the test wants.
//
// The return type is the app's own `Nav` rather than whatever `vi.fn` infers:
// a harness that drifted from the interface the views are written against
// would hand them a stand-in the app would never build, and the tests would
// still pass. The vi.fn wrappers survive the annotation - a test that wants
// the call record reaches for it through the object it passed in, not through
// this type.
export function makeNav(navigate: RouteApi["navigate"], back = vi.fn()): Nav {
  return {
    openCluster: vi.fn((name: string, tab?: string) =>
      navigate(`/clusters/${enc(name)}${tab ? `/${tab}` : ""}`)),
    openApp: vi.fn((name?: string | null) =>
      navigate(name ? `/applications/${enc(name)}` : "/applications")),
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
    // navigate is stable across renders, so the nav object can be too.
    const nav = navRef || (navRef = makeNav(route.navigate, back));
    return build({ route, nav });
  }

  const view = render(<Host />);
  return { ...view, back, nav: () => navRef };
}

// Where the page ended up, as the app itself would read it.
export const currentUrl = () => window.location.pathname + window.location.search;

// --------------------------------------------------------------------------- //
// walking out of an element the queries found
// --------------------------------------------------------------------------- //
// `closest` and `parentElement` both answer `null` when there is nothing there,
// which is right for the DOM and wrong for a test: in a test the absence is
// already a failure, and it should be reported where it happened rather than as
// "Cannot read properties of null" three lines later - or silenced with a `!`
// at all 197 call sites.
//
// These two throw with the selector and the element they started from, so an
// assertion that walks out of a cell into its row says so when the row is not
// there. They are the only sanctioned way out of an element in the suite.

/** The nearest ancestor (or self) matching `selector`. Throws when there is
 * none, naming the selector and where the walk started. */
export function closestElement(from: Element, selector: string): HTMLElement {
  const found = from.closest<HTMLElement>(selector);
  if (!found) {
    throw new Error(
      `no ancestor matching "${selector}" above <${from.tagName.toLowerCase()}>`
      + `${from.textContent ? ` ("${from.textContent.slice(0, 60)}")` : ""}`);
  }
  return found;
}

/** The parent element. Throws when there is none, which in practice means the
 * element was detached or is the document root. */
export function parentOf(from: Element): HTMLElement {
  const parent = from.parentElement;
  if (!parent) {
    throw new Error(
      `<${from.tagName.toLowerCase()}> has no parent element`
      + `${from.textContent ? ` ("${from.textContent.slice(0, 60)}")` : ""}`);
  }
  return parent;
}
