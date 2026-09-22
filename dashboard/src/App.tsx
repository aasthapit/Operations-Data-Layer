import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { ApiError } from "./api";
import { invalidate } from "./cache";
import { useRoute } from "./router";
import type { Nav } from "./router";
import Overview from "./views/Overview";
import Dashboards from "./views/Dashboards";
import DashboardView from "./views/DashboardView";
import Generate from "./views/Generate";
import Clusters from "./views/Clusters";
import ClusterDetail from "./views/ClusterDetail";
import Applications from "./views/Applications";
import BlastRadius from "./views/BlastRadius";
import Versions from "./views/Versions";
import Metrics from "./views/Metrics";
import Insights from "./views/Insights";
import Query from "./views/Query";
import Manifest from "./views/Manifest";
import Patching from "./views/Patching";
import { ErrorBoundary } from "./components";

/** [root segment, label, where the tab button goes] */
type Tab = [key: string, label: string, href: string];

const TABS: Tab[] = [
  ["", "Overview", "/"],
  ["dashboards", "Dashboards", "/dashboards"],
  ["generate", "Generate", "/generate"],
  ["clusters", "Clusters", "/clusters"],
  ["applications", "Applications", "/applications"],
  ["versions", "Versions", "/versions"],
  ["utilization", "Utilization", "/utilization"],
  ["insights", "Insights", "/insights/certificates"],
  ["query", "Query", "/query"],
  ["blast", "Blast radius", "/blast"],
  ["patching", "Patching", "/patching"],
  ["collected", "Collected", "/collected"],
];

const DEFAULT_INSIGHT = "certificates";
const enc = encodeURIComponent;

// The document title says where you are, so a tab in the browser's own history
// and a bookmark both name the page rather than the whole dashboard.
//
// The segments are typed as possibly absent because the root path has none:
// `/` is an empty array, which is what the `undefined` case answers.
function titleFor([root, second, third]: Array<string | undefined>): string {
  switch (root) {
    case undefined: return "Overview";
    case "dashboards": return second ? `Dashboards · ${second}` : "Dashboards";
    case "generate": return "Generate";
    case "clusters": return second ? `${second}${third ? ` · ${third}` : ""}` : "Clusters";
    case "applications": return second || "Applications";
    case "versions": return "Versions";
    case "utilization": return "Utilization";
    case "insights": return `Insights · ${second || DEFAULT_INSIGHT}`;
    case "query": return "Query";
    case "blast": return "Blast radius";
    case "patching": return second ? `Patching · ${second}` : "Patching";
    case "collected": return "Collected";
    default: return "Overview";
  }
}

export default function App() {
  const route = useRoute();
  const { navigate, back, segments } = route;
  const [root, second, third] = segments;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState("");
  // An unknown path falls back to the overview, so the tab strip does too.
  const known = TABS.some(([key]) => key === (root || ""));
  const activeTab = known ? root || "" : "";

  useEffect(() => {
    document.title = `${titleFor(segments)} · Operations Data Layer`;
  }, [segments.join("/")]); // eslint-disable-line react-hooks/exhaustive-deps

  // The navigation object the views already speak, now writing to the URL.
  // Opening something is a push (the back button undoes it); narrowing a list
  // is a replace, which each view does through useQueryFilters.
  const nav = useMemo<Nav>(() => ({
    openCluster: (name, tab) => navigate(`/clusters/${enc(name)}${tab ? `/${tab}` : ""}`),
    openApp: (name) => navigate(name ? `/applications/${enc(name)}` : "/applications"),
    goClusters: (key, value) => {
      const keys = ["hub", "region", "datacenter", "environment", "version", "status", "team", "upgrading"];
      navigate("/clusters", key && keys.includes(key) ? { [key]: value } : {});
    },
    goBlast: (query) => navigate("/blast", query || {}),
    goInsights: (section) => navigate(`/insights/${section || DEFAULT_INSIGHT}`),
    goDashboard: (id, query) => navigate(id ? `/dashboards/${enc(id)}` : "/dashboards", query || {}),
    goPatchJob: (id) => navigate(`/patching/${enc(id)}`),
    back,
  }), [navigate, back]);

  // Ask for a sweep, then drop the cache so every mounted view re-reads in
  // place - no remount, so tables keep their sort and the page does not blink.
  //
  // Where the API and the collectors are separate pods the answer is "queued":
  // this process cannot sweep, so it handed the request to a collector, which
  // picks it up within a tick. That is worth saying, because the numbers then
  // move a moment after the button stops spinning - and it is worth saying
  // plainly when nobody is collecting at all, which is the 409.
  const refresh = async () => {
    setRefreshing(true);
    setRefreshNote("");
    try {
      const answer = await api.refresh();
      if (answer?.mode === "queued") setRefreshNote("Refresh requested");
      setTimeout(() => { invalidate(); setRefreshing(false); setRefreshNote(""); }, 4000);
    } catch (e) {
      // The status is the whole point of catching this one: 409 is "nothing is
      // collecting", which is a different sentence to "that did not work".
      const error = e as ApiError;
      setRefreshNote(error?.status === 409 ? "No collector is running" : "Refresh failed");
      setRefreshing(false);
    }
  };

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="dot" />
          Operations Data Layer
          <small>· OpenShift fleet</small>
        </div>
        <div className="nav">
          {TABS.map(([key, label, href]) => (
            <button key={label} className={activeTab === key ? "active" : ""} onClick={() => navigate(href)}>
              {label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        {refreshNote && <span className="refresh-note">{refreshNote}</span>}
        <button className="btn" onClick={refresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "↻ Refresh data"}
        </button>
      </div>

      <div className="content">
        <ErrorBoundary key={route.path}>
        {root === "dashboards" && second ? (
          <DashboardView id={second} route={route} nav={nav} />
        ) : root === "dashboards" ? (
          <Dashboards route={route} />
        ) : root === "generate" ? (
          <Generate route={route} nav={nav} />
        ) : root === "clusters" && second ? (
          <ClusterDetail name={second} tab={third} nav={nav} />
        ) : root === "clusters" ? (
          <Clusters route={route} onOpen={nav.openCluster} />
        ) : root === "applications" ? (
          <Applications app={second} route={route} nav={nav} />
        ) : root === "versions" ? (
          <Versions onOpen={nav.openCluster} onBlast={(v) => nav.goBlast({ ocp_version: v })} />
        ) : root === "utilization" ? (
          <Metrics route={route} onOpen={nav.openCluster} />
        ) : root === "insights" ? (
          <Insights section={second || DEFAULT_INSIGHT} route={route} nav={nav} />
        ) : root === "query" ? (
          <Query route={route} nav={nav} />
        ) : root === "patching" ? (
          <Patching id={second} nav={nav} />
        ) : root === "collected" ? (
          <Manifest onOpen={nav.openCluster} />
        ) : root === "blast" ? (
          <BlastRadius route={route} nav={nav} />
        ) : (
          <Overview route={route} nav={nav} />
        )}
        </ErrorBoundary>
      </div>
    </div>
  );
}
