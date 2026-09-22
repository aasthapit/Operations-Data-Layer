// A stand-in for src/api.js that answers out of a table the test fills in.
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

// Everything api.js hands back as a request descriptor.
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
const key = (name, args) => {
  try {
    return `/api/${name}?${JSON.stringify(args)}`;
  } catch {
    return `/api/${name}`;
  }
};

export function createApiMock() {
  const answers = new Map();

  const settle = (name, args) => {
    if (!answers.has(name)) {
      return Promise.reject(new Error(
        `api.${name}() was called but this test gave it no answer - add it to answer(api, {...})`));
    }
    const value = answers.get(name);
    return Promise.resolve().then(() => (typeof value === "function" ? value(...args) : value));
  };

  const api = { __answers: answers };

  for (const name of READS) {
    api[name] = vi.fn((...args) => {
      let pending = null;
      const run = () => (pending || (pending = settle(name, args)));
      return {
        url: key(name, args),
        load: () => settle(name, args),
        then: (ok, fail) => run().then(ok, fail),
        catch: (fail) => run().catch(fail),
        finally: (done) => run().finally(done),
      };
    });
  }

  for (const name of CALLS) {
    api[name] = vi.fn((...args) => settle(name, args));
  }

  return api;
}

// Put answers on the mock. Call it again to change one; pass undefined to take
// an endpoint away again (which is how a test says "this build has no /agent").
export function answer(api, table) {
  for (const [name, value] of Object.entries(table)) {
    if (value === undefined) api.__answers.delete(name);
    else api.__answers.set(name, value);
  }
  return api;
}

// The shape an endpoint this build does not serve answers with.
export const notFound = (message = "404 Not Found") =>
  () => { throw Object.assign(new Error(message), { status: 404 }); };

export const fails = (message, status) =>
  () => { throw Object.assign(new Error(message), status ? { status } : {}); };
