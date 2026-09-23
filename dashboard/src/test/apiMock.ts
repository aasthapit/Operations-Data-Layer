// A stand-in for src/api.ts that answers out of a table the test fills in.
//
// The views do not know the network exists: they ask `api` for a descriptor and
// hand it to useFetch, which keys the SWR cache on the descriptor's url. So the
// mock has to behave like the real module in exactly two ways - a read is a
// descriptor carrying a url, and a url that differs is a different question -
// and nothing else about it matters.
//
// A test writes its answers with `answer(api, { clusters: ..., versions: ... })`.
// A value is used as it is; a function is called with the arguments the view
// passed, so a test can vary the answer by filter or throw a failure. An
// endpoint the test said nothing about rejects by name, which turns "I forgot
// to stub that" into a message rather than into a silent empty page.
import { vi } from "vitest";

/** What a test puts in the table: the answer itself, or a function called with
 * the arguments the view passed (so it can vary by filter, or throw). */
// why: the function arm stands for every endpoint at once - `api.clusters` is
// called with a filter object, `api.summary` with a string, `api.runDashboard`
// with an id and params - so there is no one signature to write here. A test
// annotates its own stub's parameters, which is where the shape is known.
export type Answer = unknown | ((...args: any[]) => unknown);

/** The mock: every endpoint of `api`, plus the table behind them. */
// why: the mock is assembled by name from the READS / CALLS lists below, so
// what hangs off each key is only known at run time. A test that wants the
// spy's call record reaches for it through this and says what it expects.
export type ApiMock = Record<string, any> & { __answers: Map<string, Answer> };

// Everything api.ts hands back as a request descriptor.
const READS = [
  "overview", "summary", "clusters", "cluster", "clusterNodes", "clusterNamespaces",
  "clusterWorkloads", "clusterPodIssues", "clusterResources", "timeline", "versions",
  "operatorVersions", "blastRadius", "applications", "application", "insightsSummary",
  "certificates", "podIssues", "quotas", "olmOperators", "machineConfigPools", "storage",
  "routes", "events", "images", "references", "clusterAdmins", "inventory", "querySchema",
  "dashboards", "dashboard", "runDashboard", "agent", "manifest", "manifestAvailability",
  "collectorTimings", "metricsHealth", "topNamespaces", "topNodes", "capacity",
  "clusterUtilization", "utilizationTimeline", "patchReport", "patchJobs", "patchJob",
];

// Everything that is a plain promise: a write, or a read the cache does not key.
const CALLS = ["refresh", "runSql", "askQuery", "queryBatch", "saveDashboard", "deleteDashboard"];

// The url a read is keyed on. It is spelt the way api.js spells it - under
// /api/<name> - because two views borrow from the cache by prefix
// (cache.search("/api/clusters", ...)), and a key that did not match would
// quietly turn that borrowing off.
const key = (name: string, args: unknown[]): string => {
  try {
    return `/api/${name}?${JSON.stringify(args)}`;
  } catch {
    return `/api/${name}`;
  }
};

export function createApiMock(): ApiMock {
  const answers = new Map<string, Answer>();

  const settle = (name: string, args: unknown[]): Promise<unknown> => {
    if (!answers.has(name)) {
      return Promise.reject(new Error(
        `api.${name}() was called but this test gave it no answer - add it to answer(api, {...})`));
    }
    const value = answers.get(name);
    return Promise.resolve().then(() => (typeof value === "function" ? value(...args) : value));
  };

  const api: ApiMock = { __answers: answers };

  for (const name of READS) {
    api[name] = vi.fn((...args: unknown[]) => {
      let pending: Promise<unknown> | null = null;
      const run = () => (pending || (pending = settle(name, args)));
      return {
        url: key(name, args),
        load: () => settle(name, args),
        // why: the descriptor stands in for `Request<T>` for every endpoint
        // at once, so `T` is not known here - these three just hand the
        // callbacks to the promise, which is what the real one does.
        then: (ok: any, fail: any) => run().then(ok, fail),
        catch: (fail: any) => run().catch(fail),
        finally: (done: any) => run().finally(done),
      };
    });
  }

  for (const name of CALLS) {
    api[name] = vi.fn((...args: unknown[]) => settle(name, args));
  }

  return api;
}

// Put answers on the mock. Call it again to change one; pass undefined to take
// an endpoint away again (which is how a test says "this build has no /agent").
export function answer(api: ApiMock, table: Record<string, Answer>): ApiMock {
  for (const [name, value] of Object.entries(table)) {
    if (value === undefined) api.__answers.delete(name);
    else api.__answers.set(name, value);
  }
  return api;
}

// The shape an endpoint this build does not serve answers with.
export const notFound = (message = "404 Not Found") =>
  () => { throw Object.assign(new Error(message), { status: 404 }); };

export const fails = (message: string, status?: number) =>
  () => { throw Object.assign(new Error(message), status ? { status } : {}); };
