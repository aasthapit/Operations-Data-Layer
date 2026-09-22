import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildUrl, setQuery, useQueryFilters, useRoute } from "./router";

const at = (path) => window.history.replaceState({ odl: 0 }, "", path);

describe("buildUrl", () => {
  it("leaves a path with no query untouched", () => {
    expect(buildUrl("/clusters")).toBe("/clusters");
  });

  it("drops empty, null and false values so a cleared filter leaves no key behind", () => {
    expect(buildUrl("/clusters", { hub: "hub-east", region: "", team: null, upgrading: false }))
      .toBe("/clusters?hub=hub-east");
  });

  it("keeps a zero, which is a value a filter can legitimately hold", () => {
    expect(buildUrl("/blast", { restarts: 0 })).toBe("/blast?restarts=0");
  });

  it("percent-encodes a value that would otherwise change the query string", () => {
    expect(buildUrl("/clusters", { hub: "hub east&prod" }))
      .toBe("/clusters?hub=hub+east%26prod");
  });
});

describe("useRoute", () => {
  it("reads the path, the query and the decoded segments off the location", () => {
    at("/clusters/ocp-prod-iad-01/nodes?region=us-east-1");
    const { result } = renderHook(() => useRoute());
    expect(result.current.path).toBe("/clusters/ocp-prod-iad-01/nodes");
    expect(result.current.query).toEqual({ region: "us-east-1" });
    expect(result.current.segments).toEqual(["clusters", "ocp-prod-iad-01", "nodes"]);
  });

  it("decodes a segment, so a cluster name with a slash in it is one segment", () => {
    at(`/applications/${encodeURIComponent("checkout/prod")}`);
    const { result } = renderHook(() => useRoute());
    expect(result.current.segments).toEqual(["applications", "checkout/prod"]);
  });

  it("normalises a trailing slash to the root path", () => {
    at("/");
    expect(renderHook(() => useRoute()).result.current.path).toBe("/");
    at("/clusters/");
    expect(renderHook(() => useRoute()).result.current.path).toBe("/clusters");
  });

  it("navigate pushes a history entry and deepens this app's own depth", () => {
    at("/");
    const { result } = renderHook(() => useRoute());
    act(() => result.current.navigate("/clusters", { hub: "hub-east" }));
    expect(window.location.pathname + window.location.search).toBe("/clusters?hub=hub-east");
    expect(window.history.state.odl).toBe(1);
    expect(result.current.path).toBe("/clusters");
  });

  it("navigate with replace keeps the depth, so filter changes do not stack up", () => {
    at("/clusters");
    const { result } = renderHook(() => useRoute());
    act(() => result.current.navigate("/clusters", { hub: "hub-east" }));
    const depth = window.history.state.odl;
    act(() => result.current.navigate("/clusters", { hub: "hub-west" }, { replace: true }));
    expect(window.history.state.odl).toBe(depth);
    expect(result.current.query).toEqual({ hub: "hub-west" });
  });

  it("navigate to the URL already showing does nothing", () => {
    at("/clusters?hub=hub-east");
    const { result } = renderHook(() => useRoute());
    act(() => result.current.navigate("/clusters", { hub: "hub-east" }));
    expect(window.history.state.odl).toBe(0);
  });

  it("re-reads the location when the browser fires popstate", () => {
    at("/");
    const { result } = renderHook(() => useRoute());
    act(() => {
      window.history.replaceState({ odl: 0 }, "", "/versions");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.path).toBe("/versions");
  });

  it("back navigates to the fallback when this app has no history of its own", () => {
    at("/clusters/ocp-prod-iad-01");
    const { result } = renderHook(() => useRoute());
    act(() => result.current.back("/clusters", { hub: "hub-east" }));
    expect(window.location.pathname + window.location.search).toBe("/clusters?hub=hub-east");
  });

  it("back steps through this app's own history when there is any", () => {
    at("/clusters");
    const { result } = renderHook(() => useRoute());
    act(() => result.current.navigate("/clusters/ocp-prod-iad-01"));
    expect(window.history.state.odl).toBe(1);
    act(() => result.current.back("/clusters"));
    // jsdom's history.back is asynchronous, so what is asserted here is that
    // the fallback was not taken: the URL is still the detail page.
    expect(window.location.pathname).toBe("/clusters/ocp-prod-iad-01");
  });
});

describe("useQueryFilters", () => {
  const filters = (keys) => renderHook(() => {
    const route = useRoute();
    return useQueryFilters(route, keys);
  });

  it("reads the declared keys out of the query string and ignores the rest", () => {
    at("/clusters?hub=hub-east&sneaky=1");
    const { result } = filters(["hub", "region"]);
    expect(result.current[0]).toEqual({ hub: "hub-east", region: "" });
  });

  it("reports active only while at least one declared filter has a value", () => {
    at("/clusters?sneaky=1");
    expect(filters(["hub"]).result.current[3]).toBe(false);
    at("/clusters?hub=hub-east");
    expect(filters(["hub"]).result.current[3]).toBe(true);
  });

  it("set replaces the entry so typing a filter does not fill the back button", () => {
    at("/clusters");
    const { result } = filters(["hub", "region"]);
    const depth = window.history.state.odl;
    act(() => result.current[1]("hub", "hub-west"));
    expect(window.location.search).toBe("?hub=hub-west");
    expect(window.history.state.odl).toBe(depth);
  });

  it("clear drops only the declared keys and keeps everything else in the URL", () => {
    at("/clusters?hub=hub-east&region=us-east-1&q=checkout");
    const { result } = filters(["hub", "region"]);
    act(() => result.current[2]());
    expect(window.location.search).toBe("?q=checkout");
  });
});

describe("setQuery", () => {
  it("replaces the whole query in one navigation", () => {
    at("/blast?ocp_version=4.15.22");
    const { result } = renderHook(() => useRoute());
    act(() => setQuery(result.current, { image: "quay.io/acme/checkout" }));
    expect(window.location.pathname + window.location.search)
      .toBe("/blast?image=quay.io%2Facme%2Fcheckout");
  });
});
