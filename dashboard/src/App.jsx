import { useState } from "react";
import { api } from "./api";
import Overview from "./views/Overview";
import Clusters from "./views/Clusters";
import ClusterDetail from "./views/ClusterDetail";
import BlastRadius from "./views/BlastRadius";
import Versions from "./views/Versions";

const TABS = [
  ["overview", "Overview"],
  ["clusters", "Clusters"],
  ["versions", "Versions"],
  ["blast", "Blast radius"],
];

export default function App() {
  const [tab, setTab] = useState("overview");
  const [selectedCluster, setSelectedCluster] = useState(null);
  const [clusterFilter, setClusterFilter] = useState(null);
  const [blastVersion, setBlastVersion] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState(null);

  const openCluster = (name) => { setSelectedCluster(name); };
  const goClusters = (key, value) => {
    const map = { region: "region", datacenter: "datacenter", environment: "environment", version: "version" };
    setClusterFilter(map[key] ? { [map[key]]: value } : null);
    setSelectedCluster(null);
    setTab("clusters");
  };
  const goBlast = (ocpVersion) => { setBlastVersion(ocpVersion || null); setSelectedCluster(null); setTab("blast"); };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.refresh();
      // give the background sweep a moment, then nudge views by remounting
      setTimeout(() => { setRefreshedAt(Date.now()); setRefreshing(false); }, 2500);
    } catch { setRefreshing(false); }
  };

  const switchTab = (t) => { setSelectedCluster(null); setTab(t); };

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
          <ClusterDetail
            name={selectedCluster}
            onBack={() => setSelectedCluster(null)}
            onBlast={goBlast}
          />
        ) : tab === "overview" ? (
          <Overview onSelectGroup={goClusters} />
        ) : tab === "clusters" ? (
          <Clusters initialFilter={clusterFilter} onOpen={openCluster} />
        ) : tab === "versions" ? (
          <Versions onOpen={openCluster} onBlast={goBlast} />
        ) : (
          <BlastRadius initialOcpVersion={blastVersion} onOpen={openCluster} />
        )}
      </div>
    </div>
  );
}
