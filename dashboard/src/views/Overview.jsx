import { useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { HealthBar, Stat, Loading, ErrorBanner, Pill } from "../components";

const GROUPS = [
  ["region", "Region"],
  ["datacenter", "Data center"],
  ["environment", "Environment"],
  ["version", "OCP version"],
];

export default function Overview({ onSelectGroup }) {
  const [groupBy, setGroupBy] = useState("region");
  const ov = useFetch(() => api.overview(), []);
  const sum = useFetch(() => api.summary(groupBy), [groupBy]);

  if (ov.loading && !ov.data) return <Loading />;
  if (ov.error) return <ErrorBanner error={ov.error} />;
  const d = ov.data;

  return (
    <div className="grid" style={{ gap: 24 }}>
      <div>
        <div className="stats">
          <Stat label="Clusters" value={d.clusters_total} kind="accent" />
          <Stat label="Healthy" value={d.counts.healthy} kind="healthy" />
          <Stat label="Warning" value={d.counts.warning} kind="warning" />
          <Stat label="Critical" value={d.counts.critical} kind="critical" />
          <Stat label="Upgrading" value={d.upgrading} kind="accent" />
        </div>
      </div>

      <div className="card">
        <h3>Hubs (ACM)</h3>
        <table>
          <thead>
            <tr><th>Hub</th><th>Region</th><th>Data center</th><th>Managed</th><th>Status</th><th>Last synced</th></tr>
          </thead>
          <tbody>
            {d.hubs.map((h) => (
              <tr key={h.name}>
                <td className="mono">{h.name}</td>
                <td>{h.region}</td>
                <td>{h.datacenter}</td>
                <td>{h.managed_count}</td>
                <td><Pill status={h.reachable ? "healthy" : "critical"} /></td>
                <td className="muted">{fmt(h.last_synced)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div className="section-title" style={{ margin: 0 }}>Fleet health</div>
          <div className="toggle-group">
            {GROUPS.map(([key, label]) => (
              <button key={key} className={groupBy === key ? "active" : ""} onClick={() => setGroupBy(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {sum.loading && !sum.data ? <Loading /> : sum.error ? <ErrorBanner error={sum.error} /> : (
          <div className="group-grid">
            {sum.data.groups.map((g) => (
              <div
                key={g.key}
                className="group-card"
                style={{ cursor: onSelectGroup ? "pointer" : "default" }}
                onClick={() => onSelectGroup && onSelectGroup(groupBy, g.key)}
              >
                <div className="gc-head">
                  <span className="gc-name">{g.key}</span>
                  <Pill status={g.rollup_status} />
                </div>
                <HealthBar counts={g.counts} />
                <div className="gc-counts">
                  <span><b>{g.total}</b> total</span>
                  {g.counts.healthy ? <span style={{ color: "var(--healthy)" }}>{g.counts.healthy} healthy</span> : null}
                  {g.counts.warning ? <span style={{ color: "var(--warning)" }}>{g.counts.warning} warning</span> : null}
                  {g.counts.critical ? <span style={{ color: "var(--critical)" }}>{g.counts.critical} critical</span> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function fmt(iso) {
  if (!iso) return "—";
  const dt = new Date(iso);
  return dt.toLocaleTimeString();
}
