import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cache from "./cache";
import { useFetch } from "./hooks";

// A descriptor in the shape api.js hands out: a url the cache keys on, and a
// load() that takes the abort signal.
const descriptor = (url, load) => ({ url, load });

beforeEach(() => cache.invalidate());
afterEach(() => cache.invalidate());

describe("useFetch", () => {
  it("starts loading and lands on the response", async () => {
    const { result } = renderHook(() => useFetch(
      () => descriptor("/api/clusters", async () => ({ count: 5 })), []));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.data).toEqual({ count: 5 }));
    expect(result.current.loading).toBe(false);
    expect(result.current.stale).toBe(false);
  });

  it("paints the cached response at once and refreshes behind it", async () => {
    cache.put("/api/clusters", { count: 4 });
    const load = vi.fn(async () => ({ count: 5 }));
    const { result } = renderHook(() => useFetch(() => descriptor("/api/clusters", load), []));
    expect(result.current.data).toEqual({ count: 4 });
    expect(result.current.stale).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ count: 5 }));
    expect(result.current.stale).toBe(false);
  });

  it("keeps the failure and the status it came with", async () => {
    const failure = Object.assign(new Error("404 Not Found"), { status: 404 });
    const { result } = renderHook(() => useFetch(
      () => descriptor("/api/agent", async () => { throw failure; }), []));
    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.error.status).toBe(404);
    expect(result.current.loading).toBe(false);
  });

  it("does not report a request that was aborted as a failure", async () => {
    const { result, unmount } = renderHook(() => useFetch(
      () => descriptor("/api/clusters",
        (signal) => new Promise((_, reject) => {
          signal.addEventListener("abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })), []));
    unmount();
    await new Promise((resolve) => { setTimeout(resolve, 90); });
    expect(result.current.error).toBeNull();
  });

  it("shares one request between two hooks reading the same url", async () => {
    const load = vi.fn(async () => ({ count: 5 }));
    const both = renderHook(() => [
      useFetch(() => descriptor("/api/clusters", load), []),
      useFetch(() => descriptor("/api/clusters", load), []),
    ]);
    await waitFor(() => expect(both.result.current[1].data).toEqual({ count: 5 }));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("re-reads when the key changes and reports the new answer", async () => {
    const { result, rerender } = renderHook(({ hub }) => useFetch(
      () => descriptor(`/api/clusters?hub=${hub}`, async () => ({ hub })), [hub]),
    { initialProps: { hub: "hub-east" } });
    await waitFor(() => expect(result.current.data).toEqual({ hub: "hub-east" }));
    rerender({ hub: "hub-west" });
    await waitFor(() => expect(result.current.data).toEqual({ hub: "hub-west" }));
  });

  it("re-reads the same url when a dependency changes, which is how a sweep is followed", async () => {
    const load = vi.fn(async () => ({ done: 2 }));
    const { result, rerender } = renderHook(({ tick }) => useFetch(
      () => descriptor("/api/health/overview", load), [tick]), { initialProps: { tick: 0 } });
    await waitFor(() => expect(result.current.data).toEqual({ done: 2 }));
    rerender({ tick: 1 });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("reload drops the cached response and reads again", async () => {
    let count = 4;
    const { result } = renderHook(() => useFetch(
      () => descriptor("/api/clusters", async () => ({ count: (count += 1) })), []));
    await waitFor(() => expect(result.current.data).toEqual({ count: 5 }));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toEqual({ count: 6 }));
  });

  it("re-reads when a refresh invalidates the prefix it reads under", async () => {
    const load = vi.fn(async () => ({ count: 5 }));
    const { result } = renderHook(() => useFetch(() => descriptor("/api/clusters", load), []));
    await waitFor(() => expect(result.current.data).toEqual({ count: 5 }));
    act(() => cache.invalidate("/api/clusters"));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("ignores an invalidation of a prefix it does not read under", async () => {
    const load = vi.fn(async () => ({ count: 5 }));
    const { result } = renderHook(() => useFetch(() => descriptor("/api/clusters", load), []));
    await waitFor(() => expect(result.current.data).toEqual({ count: 5 }));
    act(() => cache.invalidate("/api/versions"));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all when the view has nothing to ask for", () => {
    const { result } = renderHook(() => useFetch(() => null, []));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
  });
});
