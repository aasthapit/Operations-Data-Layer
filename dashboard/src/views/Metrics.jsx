import { useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { Loading, ErrorBanner } from "../components";

const GRAFANA_URL = import.meta.env.VITE_GRAFANA_URL || "http://localhost:3000";

function BarRow({ label, sub, value, max, fmt, color }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 9 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
        <span><span className="mono">{label}</span> {sub && <span className="muted">· {sub}</span>}</span>
        <span className="dim">{fmt(value)}</span>
      </div>
      <div className="hbar" style={{ height: 16, background: "var(--bg-elev-2)" }}>
        <span style={{ width: `${pct}%`, background: color || "var(--accent)" }} />
      </div>
    </div>
  );
}

const fmtCores = (v) => `${v.toFixed(2)} cores`;
const fmtBytes = (v) => `${(v / 1024 ** 3).toFixed(1)} GiB`;
const fmtPct = (v) => `${v.toFixed(1)}%`;

export default function Metrics() {
  const [by, setBy] = useState("cpu");
  const health = useFetch(() => api.metricsHealth(), []);
  const ns = useFetch(() => api.topNamespaces(by, 10), [by]);
  const nodes = useFetch(() => api.topNodes(by, 10), [by]);
  const cap = useFetch(() => api.capacity("cluster"), []);

  const unavailable = health.data && !health.data.reachable;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div className="section-title" style={{ margin: 0 }}>Utilization (metrics plane)</div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Live from Thanos/PromQL - not the inventory API. Actual usage isn't in the Kubernetes API.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div className="toggle-group">
            <button className={by === "cpu" ? "active" : ""} onClick={() => setBy("cpu")}>CPU</button>
            <button className={by === "memory" ? "active" : ""} onClick={() => setBy("memory")}>Memory</button>
          </div>
          <a className="btn" href={GRAFANA_URL} target="_blank" rel="noreferrer">Open Grafana ↗</a>
        </div>
      </div>

      {unavailable && <div className="banner">Metrics plane unreachable at {health.data.thanos_url}. Is Thanos up?</div>}

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card">
          <h3>Top namespaces by {by}</h3>
          {ns.loading && !ns.data ? <Loading /> : ns.error ? <ErrorBanner error={ns.error} /> : (
            <TopList data={ns.data} kind="namespace" />
          )}
        </div>
        <div className="card">
          <h3>Top nodes by {by} (% of allocatable)</h3>
          {nodes.loading && !nodes.data ? <Loading /> : nodes.error ? <ErrorBanner error={nodes.error} /> : (
            <NodeList data={nodes.data} />
          )}
        </div>
      </div>

      <div className="card">
        <h3>CPU capacity headroom by cluster</h3>
        {cap.loading && !cap.data ? <Loading /> : cap.error ? <ErrorBanner error={cap.error} /> : (
          <CapacityList data={cap.data} />
        )}
      </div>
    </div>
  );
}

function TopList({ data, kind }) {
  const results = data.results || [];
  const max = Math.max(...results.map((r) => r.value), 1);
  const fmt = data.unit === "bytes" ? fmtBytes : fmtCores;
  const color = data.unit === "bytes" ? "var(--warning)" : "var(--accent)";
  if (results.length === 0) return <div className="empty">No data.</div>;
  return results.map((r, i) => (
    <BarRow key={i} label={r[kind]} sub={r.cluster} value={r.value} max={max} fmt={fmt} color={color} />
  ));
}

function NodeList({ data }) {
  const results = data.results || [];
  const max = 100;
  if (results.length === 0) return <div className="empty">No data.</div>;
  return results.map((r, i) => (
    <BarRow key={i} label={r.node} sub={r.cluster} value={r.value} max={max} fmt={fmtPct}
      color={r.value > 80 ? "var(--critical)" : r.value > 60 ? "var(--warning)" : "var(--healthy)"} />
  ));
}

function CapacityList({ data }) {
  const results = data.results || [];
  const max = Math.max(...results.map((r) => r.allocatable_cores), 1);
  if (results.length === 0) return <div className="empty">No data.</div>;
  return (
    <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 8 }}>
      {results.map((r) => (
        <div key={r.cluster}>
          <BarRow label={r.cluster} sub={`${r.used_percent}% used`}
            value={r.headroom_cores} max={max} fmt={(v) => `${v.toFixed(1)} free`}
            color={r.used_percent > 80 ? "var(--critical)" : "var(--healthy)"} />
        </div>
      ))}
    </div>
  );
}
