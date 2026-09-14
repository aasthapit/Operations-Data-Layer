import { api } from "../api";
import { useFetch } from "../hooks";
import { useQueryFilters } from "../router";
import {
  ErrorBanner, SubTabs, DataTable, SkeletonLines, SkeletonTable, fmtBytes, fmtCores, fmtPct,
} from "../components";

function BarRow({ label, sub, value, max, fmt, color, onClick }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 9, cursor: onClick ? "pointer" : "default" }} onClick={onClick}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
        <span><span className="mono">{label}</span> {sub && <span className="muted">· {sub}</span>}</span>
        <span className="dim">{fmt(value)}</span>
      </div>
      <div className="hbar" style={{ height: 14, background: "var(--bg-elev-2)" }}>
        <span style={{ width: `${pct}%`, background: color || "var(--accent)" }} />
      </div>
    </div>
  );
}

const tone = (p) => (p > 90 ? "var(--critical)" : p > 75 ? "var(--warning)" : "var(--healthy)");

const GROUPS = ["cluster", "hub", "region", "environment", "datacenter"];

export default function Metrics({ onOpen, route }) {
  // by / class / group ride in the query string: /utilization?group=region is
  // the page someone can send to the next person.
  const [f, set] = useQueryFilters(route, ["by", "class", "group"]);
  const by = f.by === "memory" ? "memory" : "cpu";
  const cls = f.class === "application" || f.class === "platform" ? f.class : "";
  const groupBy = GROUPS.includes(f.group) ? f.group : "cluster";
  const health = useFetch(() => api.metricsHealth(), []);
  const ns = useFetch(() => api.topNamespaces(by, 10, cls), [by, cls]);
  const nodes = useFetch(() => api.topNodes(by, 10), [by]);
  const cap = useFetch(() => api.capacity(groupBy), [groupBy]);

  const h = health.data;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="section-head">
        <div>
          <div className="section-title" style={{ margin: 0 }}>Utilization</div>
          <div className="desc">
            Live CPU / memory from each cluster's Kubernetes metrics API (metrics.k8s.io), collected with the inventory
            on every sweep. No Prometheus, no external source.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <SubTabs tabs={[["cpu", "CPU"], ["memory", "Memory"]]} value={by} onChange={(v) => set("by", v)} />
        </div>
      </div>

      {h && !h.reachable && (
        <div className="banner">No cluster is serving metrics.k8s.io yet - usage is unknown. Capacity (allocatable) is still known from nodes.</div>
      )}
      {h && h.reachable && h.without_metrics.length > 0 && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          Metrics available on {h.clusters_with_metrics}/{h.clusters_total} clusters · missing on: {h.without_metrics.join(", ")}
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card">
          <div className="section-head" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Top namespaces by {by}</h3>
            <SubTabs tabs={[["", "All"], ["application", "Apps"], ["platform", "Platform"]]} value={cls} onChange={(v) => set("class", v)} />
          </div>
          {ns.error && !ns.data ? <ErrorBanner error={ns.error} /> : !ns.data ? <SkeletonLines rows={6} height={22} /> : (
            <TopList data={ns.data} onOpen={onOpen} />
          )}
        </div>
        <div className="card">
          <h3>Top nodes by {by} (% of allocatable)</h3>
          {nodes.error && !nodes.data ? <ErrorBanner error={nodes.error} /> : !nodes.data ? <SkeletonLines rows={6} height={22} /> : (
            <NodeList data={nodes.data} onOpen={onOpen} />
          )}
        </div>
      </div>

      <div className="card flush">
        <div className="card-head">
          <div className="section-head">
            <h3 style={{ margin: 0 }}>Capacity headroom</h3>
            <SubTabs tabs={[["cluster", "Cluster"], ["hub", "Hub"], ["region", "Region"], ["environment", "Environment"], ["datacenter", "Data center"]]}
              value={groupBy} onChange={(v) => set("group", v)} />
          </div>
        </div>
        {cap.error && !cap.data ? <ErrorBanner error={cap.error} /> : !cap.data ? <SkeletonTable columns={7} rows={6} /> : (
          <CapacityTable data={cap.data} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}

function TopList({ data, onOpen }) {
  const results = data.results || [];
  const max = Math.max(...results.map((r) => r.value), 1);
  const fmt = data.unit === "bytes" ? fmtBytes : fmtCores;
  const color = data.unit === "bytes" ? "var(--warning)" : "var(--accent)";
  if (results.length === 0) return <div className="empty">No usage data yet.</div>;
  return results.map((r, i) => (
    <BarRow key={i} label={r.namespace} sub={`${r.cluster}${r.class === "platform" ? " · platform" : r.team ? ` · ${r.team}` : ""}`}
      value={r.value} max={max} fmt={fmt} color={color} onClick={() => onOpen(r.cluster)} />
  ));
}

function NodeList({ data, onOpen }) {
  const results = data.results || [];
  if (results.length === 0) return <div className="empty">No usage data yet.</div>;
  return results.map((r, i) => (
    <BarRow key={i} label={r.node} sub={r.cluster} value={r.value} max={100} fmt={fmtPct}
      color={tone(r.value)} onClick={() => onOpen(r.cluster)} />
  ));
}

function CapacityTable({ data, onOpen }) {
  const key = data.group_by;
  const rows = data.results || [];
  const columns = [
    { key, label: key, className: "mono", filter: "text" },
    {
      key: "clusters", label: "Clusters",
      render: (r) => <>{r.clusters}{r.with_metrics < r.clusters && <span className="muted"> ({r.with_metrics} w/ metrics)</span>}</>,
    },
    {
      key: "used_percent", label: "CPU used / allocatable", className: "nowrap",
      filterValue: (r) => `${r.used_cores.toFixed(1)} / ${r.allocatable_cores.toFixed(1)}`,
      render: (r) => (
        <>
          <span style={{ color: tone(r.used_percent || 0) }}>{r.used_cores.toFixed(1)}</span>
          <span className="muted"> / {r.allocatable_cores.toFixed(1)} · {fmtPct(r.used_percent)}</span>
        </>
      ),
    },
    { key: "requests_cores", label: "CPU requested", render: (r) => <>{r.requests_cores.toFixed(1)} <span className="muted">cores</span></> },
    { key: "headroom_cores", label: "CPU headroom", render: (r) => <>{r.headroom_cores.toFixed(1)} <span className="muted">cores</span></> },
    {
      key: "memory_used_percent", label: "Memory used / allocatable", className: "nowrap",
      filterValue: (r) => `${fmtBytes(r.used_bytes)} / ${fmtBytes(r.allocatable_bytes)}`,
      render: (r) => (
        <>
          <span style={{ color: tone(r.memory_used_percent || 0) }}>{fmtBytes(r.used_bytes)}</span>
          <span className="muted"> / {fmtBytes(r.allocatable_bytes)} · {fmtPct(r.memory_used_percent)}</span>
        </>
      ),
    },
    { key: "headroom_bytes", label: "Memory headroom", render: (r) => fmtBytes(r.headroom_bytes) },
  ];
  return (
    <DataTable
      id={`metrics.capacity.${key}`}
      columns={columns}
      rows={rows}
      rowKey={(r) => r[key]}
      onRowClick={key === "cluster" ? (r) => onOpen(r[key]) : undefined}
      initialSort={{ key: "used_percent", dir: "desc" }}
      empty="No capacity data."
    />
  );
}
