import { useState } from "react";
import { api } from "./api";
import Overview from "./views/Overview";
import Clusters from "./views/Clusters";
import ClusterDetail from "./views/ClusterDetail";
import Applications from "./views/Applications";
import BlastRadius from "./views/BlastRadius";
import Versions from "./views/Versions";
import Metrics from "./views/Metrics";
import Insights from "./views/Insights";
import Manifest from "./views/Manifest";
import Patching from "./views/Patching";

const TABS = [
  ["overview", "Overview"],
  ["clusters", "Clusters"],
  ["applications", "Applications"],
  ["versions", "Versions"],
  ["metrics", "Utilization"],
  ["insights", "Insights"],
  ["blast", "Blast radius"],
  ["patching", "Patching"],
  ["manifest", "Collected"],
];

export default function App() {
  const [tab, setTab] = useState("overview");
  const [selectedCluster, setSelectedCluster] = useState(null);
  const [selectedApp, setSelectedApp] = useState(null);
  const [clusterFilter, setClusterFilter] = useState(null);
  const [blastQuery, setBlastQuery] = useState(null);
  const [insightSection, setInsightSection] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState(null);

  const clearSelection = () => { setSelectedCluster(null); setSelectedApp(null); };
  const openCluster = (name) => { setSelectedApp(null); setSelectedCluster(name); };
  const openApp = (name) => { setSelectedCluster(null); setSelectedApp(name); setTab("applications"); };
  const goClusters = (key, value) => {
    const map = { hub: "hub", region: "region", datacenter: "datacenter", environment: "environment", version: "version" };
    setClusterFilter(map[key] ? { [map[key]]: value } : null);
    clearSelection();
    setTab("clusters");
  };
  const goBlast = (query) => { setBlastQuery(query || null); clearSelection(); setTab("blast"); };
  const goInsights = (section) => { setInsightSection(section || null); clearSelection(); setTab("insights"); };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.refresh();
      // give the background sweep a moment, then nudge views by remounting
      setTimeout(() => { setRefreshedAt(Date.now()); setRefreshing(false); }, 4000);
    } catch { setRefreshing(false); }
  };

  const switchTab = (t) => { clearSelection(); setTab(t); };
  const nav = { openCluster, openApp, goClusters, goBlast, goInsights };

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="dot" />
          Operations Data Layer
          <small>· OpenShift fleet</small>
        </div>
        <div className="nav">
          {TABS.map(([k, label]) => (
            <button key={k} className={tab === k && !selectedCluster ? "active" : ""} onClick={() => switchTab(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button className="btn" onClick={refresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "↻ Refresh data"}
        </button>
      </div>

      <div className="content" key={refreshedAt}>
        {selectedCluster ? (
          <ClusterDetail name={selectedCluster} onBack={() => setSelectedCluster(null)} nav={nav} />
        ) : tab === "overview" ? (
          <Overview nav={nav} />
        ) : tab === "clusters" ? (
          <Clusters initialFilter={clusterFilter} onOpen={openCluster} />
        ) : tab === "applications" ? (
          <Applications initialApp={selectedApp} nav={nav} onClearApp={() => setSelectedApp(null)} />
        ) : tab === "versions" ? (
          <Versions onOpen={openCluster} onBlast={(v) => goBlast({ ocp_version: v })} />
        ) : tab === "metrics" ? (
          <Metrics onOpen={openCluster} />
        ) : tab === "insights" ? (
          <Insights initialSection={insightSection} nav={nav} />
        ) : tab === "patching" ? (
          <Patching />
        ) : tab === "manifest" ? (
          <Manifest onOpen={openCluster} />
        ) : (
          <BlastRadius initialQuery={blastQuery} nav={nav} />
        )}
      </div>
    </div>
  );
}
