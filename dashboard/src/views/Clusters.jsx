import { useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { Pill, Loading, ErrorBanner, FilterSelect, UsageBar } from "../components";

export default function Clusters({ initialFilter, onOpen }) {
  const [filters, setFilters] = useState(initialFilter || {});
  const { data, error, loading } = useFetch(() => api.clusters(filters), [JSON.stringify(filters)]);
  const meta = useFetch(() => api.clusters(), []); // unfiltered, for filter options

  const opts = buildOptions(meta.data?.clusters || []);
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v || undefined }));

  return (
    <div>
      <div className="filters">
        <FilterSelect label="Region" value={filters.region} options={opts.region} onChange={(v) => set("region", v)} />
        <FilterSelect label="Data center" value={filters.datacenter} options={opts.datacenter} onChange={(v) => set("datacenter", v)} />
        <FilterSelect label="Environment" value={filters.environment} options={opts.environment} onChange={(v) => set("environment", v)} />
        <FilterSelect label="Status" value={filters.status} options={["healthy", "warning", "critical", "unknown"]} onChange={(v) => set("status", v)} />
        <FilterSelect label="OCP version" value={filters.version} options={opts.version} onChange={(v) => set("version", v)} />
        <FilterSelect label="Hub" value={filters.hub} options={opts.hub} onChange={(v) => set("hub", v)} />
        {Object.values(filters).some(Boolean) && (
          <button className="btn" style={{ alignSelf: "flex-end" }} onClick={() => setFilters({})}>Clear</button>
        )}
      </div>

      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <div className="card flush">
          <table>
            <thead>
              <tr>
                <th>Cluster</th><th>Status</th><th>Region / DC</th><th>Env</th>
                <th>OCP version</th><th>Nodes</th><th>CPU</th><th>Memory</th>
                <th>Apps</th><th>Pod issues</th><th>Certs</th><th>Checks</th>
              </tr>
            </thead>
            <tbody>
              {data.clusters.map((c) => (
                <tr key={c.name} className="clickable" onClick={() => onOpen(c.name)}>
                  <td className="mono">{c.name}</td>
                  <td><Pill status={c.overall_status} /></td>
                  <td>{c.region} <span className="muted">/ {c.datacenter}</span></td>
                  <td><span className="tag">{c.environment}</span></td>
                  <td className="mono">
                    {c.ocp_version}
                    {c.upgrading && (
                      <span className="muted"> → {c.desired_version} ({c.upgrade_percent}%)</span>
                    )}
                  </td>
                  <td>{c.nodes.ready}/{c.nodes.total}</td>
                  <td><UsageBar percent={c.utilization.cpu_percent} width={70} label="CPU used / allocatable" /></td>
                  <td><UsageBar percent={c.utilization.memory_percent} width={70} label="Memory used / allocatable" /></td>
                  <td>{c.namespaces.application} <span className="muted">/ {c.namespaces.platform} platform</span></td>
                  <td>{c.pod_issues ? <span style={{ color: "var(--warning)" }}>{c.pod_issues}</span> : <span className="muted">0</span>}</td>
                  <td>{c.certs_expiring ? <span style={{ color: "var(--critical)" }}>{c.certs_expiring}</span> : <span className="muted">0</span>}</td>
                  <td className="nowrap">
                    <span style={{ color: "var(--healthy)" }}>{c.checks.passed}✓</span>{" "}
                    {c.checks.warned ? <span style={{ color: "var(--warning)" }}>{c.checks.warned}!</span> : null}{" "}
                    {c.checks.failed ? <span style={{ color: "var(--critical)" }}>{c.checks.failed}✕</span> : null}
                  </td>
                </tr>
              ))}
              {data.clusters.length === 0 && (
                <tr><td colSpan={12} className="empty">No clusters match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>{data?.count ?? 0} clusters</div>
    </div>
  );
}

function buildOptions(clusters) {
  const uniq = (k) => [...new Set(clusters.map((c) => c[k]).filter(Boolean))].sort();
  return {
    region: uniq("region"),
    datacenter: uniq("datacenter"),
    environment: uniq("environment"),
    version: uniq("ocp_version"),
    hub: uniq("hub"),
  };
}
