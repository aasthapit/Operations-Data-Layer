import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cache from "./cache";

// The cache is module state, so every test starts from empty.
beforeEach(() => cache.invalidate());
afterEach(() => { vi.useRealTimers(); cache.invalidate(); });

const later = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe("peek and put", () => {
  it("returns undefined for a url nothing has been stored under", () => {
    expect(cache.peek("/api/clusters")).toBeUndefined();
  });

  it("returns what was put, and a null response is a hit rather than a miss", () => {
    cache.put("/api/clusters", { count: 5 });
    cache.put("/api/agent", null);
    expect(cache.peek("/api/clusters")).toEqual({ count: 5 });
    expect(cache.peek("/api/agent")).toBeNull();
  });

  it("ignores a put or a peek with no url", () => {
    cache.put("", { count: 1 });
    expect(cache.size()).toBe(0);
    expect(cache.peek(null)).toBeUndefined();
  });

  it("evicts the least recently used entry once it is full", () => {
    for (let i = 0; i < 100; i += 1) cache.put(`/api/clusters/c${i}`, i);
    // Touching the oldest makes it the newest, so the next insert evicts c1.
    expect(cache.peek("/api/clusters/c0")).toBe(0);
    cache.put("/api/clusters/c100", 100);
    expect(cache.size()).toBe(100);
    expect(cache.peek("/api/clusters/c1")).toBeUndefined();
    expect(cache.peek("/api/clusters/c0")).toBe(0);
  });

  it("drop removes one url and leaves the rest", () => {
    cache.put("/api/clusters", 1);
    cache.put("/api/versions", 2);
    cache.drop("/api/clusters");
    expect(cache.peek("/api/clusters")).toBeUndefined();
    expect(cache.peek("/api/versions")).toBe(2);
  });
});

describe("search", () => {
  it("hands the newest matching response to the picker first", () => {
    cache.put("/api/clusters?hub=hub-east", { clusters: [{ name: "ocp-prod-iad-01" }] });
    cache.put("/api/clusters?hub=hub-west", { clusters: [{ name: "ocp-prod-sjc-01" }] });
    const seen = [];
    cache.search("/api/clusters", (data) => { seen.push(data.clusters[0].name); return null; });
    expect(seen).toEqual(["ocp-prod-sjc-01", "ocp-prod-iad-01"]);
  });

  it("returns the first hit the picker names", () => {
    cache.put("/api/clusters", { clusters: [{ name: "ocp-prod-iad-02" }] });
    const hit = cache.search("/api/clusters",
      (data) => data.clusters.find((c) => c.name === "ocp-prod-iad-02"));
    expect(hit).toEqual({ name: "ocp-prod-iad-02" });
  });

  it("skips urls outside the prefix and answers null when nothing matches", () => {
    cache.put("/api/versions", { versions: [] });
    expect(cache.search("/api/clusters", () => "anything")).toBeNull();
  });
});

describe("invalidate and subscribe", () => {
  it("clears only the given prefix and tells subscribers which one", () => {
    cache.put("/api/clusters", 1);
    cache.put("/api/versions", 2);
    const seen = vi.fn();
    const unsubscribe = cache.subscribe(seen);
    cache.invalidate("/api/clusters");
    expect(cache.peek("/api/clusters")).toBeUndefined();
    expect(cache.peek("/api/versions")).toBe(2);
    expect(seen).toHaveBeenCalledWith("/api/clusters");
    unsubscribe();
  });

  it("clears everything when no prefix is given", () => {
    cache.put("/api/clusters", 1);
    cache.put("/api/versions", 2);
    cache.invalidate();
    expect(cache.size()).toBe(0);
  });

  it("stops calling a subscriber once it has unsubscribed", () => {
    const seen = vi.fn();
    cache.subscribe(seen)();
    cache.invalidate();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("request", () => {
  it("stores the response under the url and hands it to the caller", async () => {
    const { promise, release } = cache.request("/api/clusters", async () => ({ count: 5 }));
    await expect(promise).resolves.toEqual({ count: 5 });
    release();
    expect(cache.peek("/api/clusters")).toEqual({ count: 5 });
  });

  it("shares one fetch between concurrent callers for the same url", async () => {
    const fetcher = vi.fn(async () => ({ count: 5 }));
    const first = cache.request("/api/clusters", fetcher);
    const second = cache.request("/api/clusters", fetcher);
    await Promise.all([first.promise, second.promise]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.promise).toBe(second.promise);
    first.release();
    second.release();
  });

  it("does not cache a response that was already on the wire when a refresh landed", async () => {
    let settle;
    const { promise, release } = cache.request("/api/clusters",
      () => new Promise((resolve) => { settle = resolve; }));
    cache.invalidate();                 // the refresh happens mid-flight
    settle({ count: 5 });
    await expect(promise).resolves.toEqual({ count: 5 });
    release();
    expect(cache.peek("/api/clusters")).toBeUndefined();
  });

  it("starts a new request rather than reusing one a refresh made stale", async () => {
    const fetcher = vi.fn(async () => ({ count: 5 }));
    const first = cache.request("/api/clusters", fetcher);
    cache.invalidate();
    const second = cache.request("/api/clusters", fetcher);
    expect(second.promise).not.toBe(first.promise);
    await Promise.all([first.promise, second.promise]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    first.release();
    second.release();
  });

  it("rejects the caller and forgets the request when the fetch fails", async () => {
    const { promise, release } = cache.request("/api/clusters",
      async () => { throw new Error("502 Bad Gateway"); });
    await expect(promise).rejects.toThrow("502 Bad Gateway");
    release();
    expect(cache.peek("/api/clusters")).toBeUndefined();
  });

  it("aborts the fetch once the last caller has released it", async () => {
    let signal;
    const { promise, release } = cache.request("/api/clusters", (s) => {
      signal = s;
      return new Promise(() => {});
    });
    expect(signal.aborted).toBe(false);
    release();
    await later(90);
    expect(signal.aborted).toBe(true);
    expect(promise).toBeInstanceOf(Promise);
  });

  it("keeps the fetch alive across the remount React does in strict mode", async () => {
    let signal;
    const fetcher = (s) => { signal = s; return new Promise(() => {}); };
    const first = cache.request("/api/clusters", fetcher);
    first.release();                                  // unmount
    const second = cache.request("/api/clusters", fetcher);   // and straight back
    await later(90);
    expect(signal.aborted).toBe(false);
    second.release();
  });
});

describe("isAbort", () => {
  it("recognises the two shapes an aborted fetch rejects with", () => {
    expect(cache.isAbort(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(cache.isAbort({ code: 20 })).toBe(true);
  });

  it("does not mistake an ordinary failure for an abort", () => {
    expect(cache.isAbort(new Error("500 Internal Server Error"))).toBe(false);
    expect(cache.isAbort(null)).toBe(false);
  });
});
