// What every test file gets before it runs.
//
// Two jobs. The first is to give jsdom the browser APIs the dashboard uses and
// jsdom does not implement - a chart measures its card with ResizeObserver, the
// Query page hands a CSV to URL.createObjectURL, a view scrolls to the top on
// navigation. The second is to make the network loud: an unmocked fetch throws
// with the URL it was about to call, so a test that forgot to mock an endpoint
// fails saying which one rather than hanging or silently rendering a spinner.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// --------------------------------------------------------------------------- //
// browser APIs jsdom does not have
// --------------------------------------------------------------------------- //
class TestResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; }
  observe() {}
  unobserve() {}
  disconnect() {}
}

class TestIntersectionObserver {
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) { this.callback = callback; }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

globalThis.ResizeObserver = TestResizeObserver;
// why: the stub answers the three calls the app makes and nothing else, so it
// deliberately does not carry IntersectionObserver's root / rootMargin /
// thresholds. Naming the global's own type is what says that is on purpose.
globalThis.IntersectionObserver =
  TestIntersectionObserver as unknown as typeof globalThis.IntersectionObserver;

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
}

window.scrollTo = () => {};
Element.prototype.scrollIntoView = function scrollIntoView() {};

// jsdom has no object URLs, and the Query page's CSV download goes through them.
if (!URL.createObjectURL) URL.createObjectURL = () => "blob:odl-test";
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};

// jsdom measures nothing, so a chart asked for its card's width gets zero and
// draws at its fallback. A fixed width makes the SVG assertions stable.
// The marker is read back off the function itself so a second import of this
// module does not wrap the stub in another stub.
type PatchedRect = (() => DOMRect) & { __odlPatched?: true };

if (!(Element.prototype.getBoundingClientRect as PatchedRect).__odlPatched) {
  const rect: PatchedRect = () => ({
    width: 640, height: 320, top: 0, left: 0, right: 640, bottom: 320, x: 0, y: 0,
    toJSON() { return this; },
  }) as DOMRect;
  rect.__odlPatched = true;
  Element.prototype.getBoundingClientRect = rect;
}

// The bar chart measures its labels with a 2d canvas context when it has one;
// jsdom has no canvas, so the component's own text-width estimate is used. Say
// so explicitly rather than leaving it to a thrown error inside a render.
HTMLCanvasElement.prototype.getContext = () => null;

// --------------------------------------------------------------------------- //
// Web Storage
// --------------------------------------------------------------------------- //
// jsdom has Storage, but this Node build also ships an experimental global
// `localStorage` that is undefined unless the process was started with
// --localstorage-file, and that global is the one that ends up on the test
// window. The dashboard uses Storage for real - DataTable remembers its sort,
// the Query page its saved queries, the agent its thread - so the tests get a
// working implementation rather than a disabled one.
//
// Stored keys are ordinary enumerable own properties, because that is what the
// real thing does and what `Object.keys(sessionStorage)` in useAgentRun relies
// on; the methods are defined non-enumerable so they do not look like entries.
function createStorage(): Storage {
  const storage: Record<string, string> = {};
  const hidden = (name: string, value: unknown) =>
    Object.defineProperty(storage, name, { value, writable: true, configurable: true });
  const entry = (key: string, value: string) =>
    Object.defineProperty(storage, key, { value, enumerable: true, writable: true, configurable: true });

  hidden("getItem", (key: string) => {
    const k = String(key);
    return Object.prototype.propertyIsEnumerable.call(storage, k) ? storage[k] : null;
  });
  hidden("setItem", (key: string, value: string) => entry(String(key), String(value)));
  hidden("removeItem", (key: string) => { delete storage[String(key)]; });
  hidden("clear", () => { Object.keys(storage).forEach((k) => { delete storage[k]; }); });
  hidden("key", (index: number) => Object.keys(storage)[index] ?? null);
  Object.defineProperty(storage, "length", {
    get: () => Object.keys(storage).length, configurable: true,
  });
  // why: the object IS the store - the keys are the entries and the methods are
  // hidden behind defineProperty, so nothing here can be seen as `Storage` until
  // it is finished being built.
  return storage as unknown as Storage;
}

const localStorageStub = createStorage();
const sessionStorageStub = createStorage();
const stubs: Array<[string, Storage]> = [
  ["localStorage", localStorageStub],
  ["sessionStorage", sessionStorageStub],
];
for (const [name, value] of stubs) {
  Object.defineProperty(window, name, { value, writable: true, configurable: true });
  if (globalThis !== window) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
}

// --------------------------------------------------------------------------- //
// the network
// --------------------------------------------------------------------------- //
// Nothing in this suite talks to a real API. A test that needs a response
// stubs `global.fetch` itself (or mocks `../api`); anything else lands here.
function unmockedFetch(input) {
  const url = typeof input === "string" ? input : input?.url || String(input);
  return Promise.reject(new Error(
    `unmocked fetch: ${url} - stub global.fetch or vi.mock the api module in this test`));
}

// --------------------------------------------------------------------------- //
// isolation between tests
// --------------------------------------------------------------------------- //
// DataTable remembers its sort in localStorage and the agent thread lives in
// sessionStorage, so a test that leaves either behind would change the next
// test's starting state.
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(unmockedFetch));
  // Every test starts at the root with a clean history depth.
  window.history.replaceState({ odl: 0 }, "", "/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
