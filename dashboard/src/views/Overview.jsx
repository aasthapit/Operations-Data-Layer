import { useEffect, useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { HealthBar, Stat, Loading, ErrorBanner, Pill, DataTable, fmtTime } from "../components";

const HUB_COLUMNS = [
  { key: "name", label: "Hub", className: "mono", filter: "text" },
  { key: "region", label: "Region", filter: "select" },
  { key: "datacenter", label: "Data center", filter: "select" },
  { key: "managed_count", label: "Managed" },
  {
    key: "reachable", label: "Status", filter: "select",
    filterValue: (h) => (h.reachable ? "healthy" : "critical"),
    render: (h) => <Pill status={h.reachable ? "healthy" : "critical"} />,
  },
  { key: "last_synced", label: "Last synced", className: "muted", render: (h) => fmtTime(h.last_synced) },
  {
    key: "last_error", label: "Error", className: "muted", filter: "text",
    render: (h) => <span style={{ fontSize: 12, maxWidth: 420, wordBreak: "break-word", display: "inline-block" }}>{h.last_error || ""}</span>,
  },
];

const GROUPS = [
  ["hub", "Hub"],
  ["region", "Region"],
  ["datacenter", "Data center"],
  ["environment", "Environment"],
  ["version", "OCP version"],
];

export default function Overview({ nav }) {
  const [groupBy, setGroupBy] = useState("hub");
  // While a sweep is running the picture fills in cluster by cluster, so the
  // overview re-reads itself every few seconds until it is done.
  const [tick, setTick] = useState(0);
  const ov = useFetch(() => api.overview(), [tick]);
  const sweeping = !!ov.data?.sweep?.running;
  useEffect(() => {
    if (!sweeping) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, [sweeping]);
  const sum = useFetch(() => api.summary(groupBy), [groupBy]);
  const ins = useFetch(() => api.insightsSummary(), []);

  if (ov.loading && !ov.data) return <Loading />;
  if (ov.error) return <ErrorBanner error={ov.error} />;
  const d = ov.data;
  const i = ins.data;

  const sw = d.sweep;
  return (
    <div className="grid" style={{ gap: 24 }}>
      {sw?.running && (
        <div className="card" style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 12 }}>
          <span className="tag">sweep in progress</span>
          <span>{sw.done} of {sw.total} clusters collected{sw.failed ? `, ${sw.failed} failed` : ""}</span>
          <div style={{ flex: 1, height: 6, background: "var(--line, #333)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${sw.total ? Math.round((100 * sw.done) / sw.total) : 0}%`, height: "100%", background: "var(--accent, #4f8cff)" }} />
          </div>
          <span className="muted" style={{ fontSize: 12 }}>started {fmtTime(sw.started_at)}</span>
          {(sw.collectors || []).length > 1 && (
            <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
              {sw.collectors.map((c) => `${(c.hubs || []).join(",") || "all"}${c.shard ? " " + c.shard : ""} ${c.done}/${c.total}${c.running ? "" : " done"}`).join(" · ")}
            </span>
          )}
        </div>
      )}
      <div>
        <div className="stats">
          <Stat label="Clusters" value={d.clusters_total} kind="accent" onClick={() => nav.goClusters()} />
          <Stat label="Healthy" value={d.counts.healthy} kind="healthy" onClick={() => nav.goClusters("status", "healthy")} />
          <Stat label="Warning" value={d.counts.warning} kind="warning" onClick={() => nav.goClusters("status", "warning")} />
          <Stat label="Critical" value={d.counts.critical} kind="critical" onClick={() => nav.goClusters("status", "critical")} />
          <Stat label="Upgrading" value={d.upgrading} kind="accent" onClick={() => nav.goClusters("upgrading", "true")} />
          <Stat label="Applications" value={i ? i.applications : "…"} kind="accent" onClick={() => nav.openApp(null)} />
        </div>
      </div>

      <div>
        <div className="section-head">
          <div className="section-title" style={{ margin: 0 }}>Needs attention</div>
          <div className="desc">Everything below is read from the clusters' own API servers - nothing external.</div>
        </div>
        {ins.error ? <ErrorBanner error={ins.error} /> : !i ? <Loading /> : (
          <div className="stats">
            <Stat label="Expired certificates" value={i.certificates.expired}
              kind={i.certificates.expired ? "critical" : "healthy"} onClick={() => nav.goInsights("certificates")} />
            <Stat label="Certificates expiring" value={i.certificates.expiring}
              kind={i.certificates.expiring ? "warning" : "healthy"} onClick={() => nav.goInsights("certificates")} />
            <Stat label="Platform pod issues" value={i.pod_issues.platform}
              kind={i.pod_issues.platform ? "warning" : "healthy"} onClick={() => nav.goInsights("pods")} />
            <Stat label="App pod issues" value={i.pod_issues.application}
              kind={i.pod_issues.application ? "warning" : "healthy"} onClick={() => nav.goInsights("pods")} />
            <Stat label="Quotas near limit" value={i.quotas_near_limit}
              kind={i.quotas_near_limit ? "warning" : "healthy"} onClick={() => nav.goInsights("quotas")} />
            <Stat label="MCPs degraded" value={i.machine_config_pools.degraded} sub={`${i.machine_config_pools.updating} updating`}
              kind={i.machine_config_pools.degraded ? "critical" : "healthy"} onClick={() => nav.goInsights("mcp")} />
            <Stat label="OLM operators unhealthy" value={i.olm_operators_unhealthy} sub={`${i.olm_upgrades_pending} upgrades pending`}
              kind={i.olm_operators_unhealthy ? "warning" : "healthy"} onClick={() => nav.goInsights("olm")} />
            <Stat label="PVCs pending" value={i.pvcs_pending}
              kind={i.pvcs_pending ? "warning" : "healthy"} onClick={() => nav.goInsights("storage")} />
            <Stat label="Warning events" value={i.warning_events} kind="unknown" onClick={() => nav.goInsights("events")} />
            <Stat label="Clusters without metrics" value={i.clusters_without_metrics}
              kind={i.clusters_without_metrics ? "warning" : "healthy"} />
          </div>
        )}
      </div>

      <div className="card">
        <h3>Hubs (ACM)</h3>
        <DataTable
          id="overview.hubs"
          columns={HUB_COLUMNS}
          rows={d.hubs}
          rowKey="name"
          initialSort={{ key: "name", dir: "asc" }}
          empty="No hubs configured."
        />
        {d.last_collection && (
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            Last sweep: {d.last_collection.clusters_ok} ok / {d.last_collection.clusters_failed} failed in {d.last_collection.duration_ms} ms
          </div>
        )}
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
              <div key={g.key} className="group-card" style={{ cursor: "pointer" }}
                onClick={() => nav.goClusters(groupBy, g.key)}>
                <div className="gc-head">
                  <span className="gc-name">{g.key}</span>
                  <Pill status={g.rollup_status} />
                </div>
                <HealthBar counts={g.counts} />
                <div className="gc-counts">
                  <span><b>{g.total}</b> {g.total === 1 ? "cluster" : "clusters"}</span>
                  {g.applications != null && <span><b>{g.applications}</b> {g.applications === 1 ? "application" : "applications"}{g.unassigned_namespaces ? <span className="muted"> (+{g.unassigned_namespaces} ns unassigned)</span> : null}</span>}
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
