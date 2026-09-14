import { useEffect, useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { Pill, Loading, ErrorBanner, FilterSelect, Tier, DataTable, fmtBytes, fmtCores } from "../components";

export default function Applications({ initialApp, nav, onClearApp }) {
  const [filters, setFilters] = useState({});
  const [selected, setSelected] = useState(initialApp || null);
  useEffect(() => { setSelected(initialApp || null); }, [initialApp]);
  const { data, error, loading } = useFetch(() => api.applications(filters), [JSON.stringify(filters)]);
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v || undefined }));

  if (selected) {
    return <ApplicationDetail app={selected} nav={nav} onBack={() => { setSelected(null); onClearApp && onClearApp(); }} />;
  }

  const apps = data?.applications || [];
  const envs = [...new Set(apps.flatMap((a) => a.environments))].sort();
  const tiers = [...new Set(apps.map((a) => a.tier).filter(Boolean))].sort();
  // With a mapping file the owner is a line of business, tier is not known,
  // and each namespace carries its own environment.
  const mapped = data?.source === "mapping";
  const ownerLabel = mapped ? "LOB" : "Team";
  const unassigned = apps.find((a) => !a.assigned);

  // Team / tier / environment / status already have server-side dropdowns above
  // the table, so they are not repeated as column filters.
  const columns = [
    {
      key: "app", label: "Application", filter: "text",
      render: (a) => (a.assigned === false
        ? <span className="muted">{a.app} <span style={{ fontSize: 11 }}>not under a business application</span></span>
        : a.app),
    },
    { key: "team", label: ownerLabel, className: "muted", render: (a) => a.team || "-" },
    mapped
      ? {
        key: "namespace_environments", label: "Namespace envs",
        filterValue: (a) => (a.namespace_environments || []).join(", "),
        render: (a) => (a.namespace_environments || []).map((e) => <span key={e} className="tag" style={{ marginRight: 4 }}>{e}</span>),
      }
      : { key: "tier", label: "Tier", render: (a) => <Tier tier={a.tier} /> },
    { key: "status", label: "Status", render: (a) => <Pill status={a.status} /> },
    {
      key: "cluster_count", label: "Clusters",
      filterValue: (a) => `${a.cluster_count} ${(a.placements || []).map((p) => p.cluster).join(" ")}`,
      render: (a) => {
        const names = [...new Set((a.placements || []).map((p) => p.cluster))];
        const shown = names.slice(0, 3).join(", ");
        const more = names.length > 3 ? ` +${names.length - 3}` : "";
        return <>{a.cluster_count} <span className="muted mono" style={{ fontSize: 12 }}>· {shown}{more}</span></>;
      },
    },
    {
      key: "hubs", label: "Hubs", filter: "select",
      filterValue: (a) => (a.hubs || []).join(" "),
      sortValue: (a) => (a.hubs || []).join(","),
      render: (a) => (a.hubs || []).map((h) => <span key={h} className="tag" style={{ marginRight: 4 }}>{h}</span>),
    },
    {
      key: "environments", label: "Environments",
      sortValue: (a) => a.environments.join(", "),
      render: (a) => a.environments.map((e) => <span key={e} className="tag" style={{ marginRight: 4 }}>{e}</span>),
    },
    { key: "workloads", label: "Workloads" },
    {
      key: "replicas_ready", label: "Replicas",
      filterValue: (a) => `${a.replicas_ready}/${a.replicas_desired}`,
      render: (a) => `${a.replicas_ready}/${a.replicas_desired}`,
    },
    {
      key: "pod_issues", label: "Pod issues",
      render: (a) => (a.pod_issues ? <span style={{ color: "var(--warning)" }}>{a.pod_issues}</span> : <span className="muted">0</span>),
    },
    {
      key: "cpu_used_cores", label: "CPU used",
      render: (a) => (a.cpu_used_cores != null ? fmtCores(a.cpu_used_cores) : <span className="muted">n/a</span>),
    },
    {
      key: "memory_used_bytes", label: "Memory used",
      render: (a) => (a.memory_used_bytes != null ? fmtBytes(a.memory_used_bytes) : <span className="muted">n/a</span>),
    },
  ];

  return (
    <div>
      <div className="section-head">
        <div>
          <div className="section-title" style={{ margin: 0 }}>Applications</div>
          <div className="desc">
            {mapped
              ? <>Ownership comes from the application mapping file: every resource in a namespace belongs to that namespace's application, and namespaces the file does not list are grouped as <span className="mono">(unassigned)</span>{unassigned ? ` (${unassigned.cluster_count} namespaces)` : ""}. Labels are not used.</>
              : <>Every non-platform namespace is an application. Identity, team and tier come from namespace labels (falling back to the workloads' labels); OpenShift's own namespaces are grouped separately per cluster.</>}
          </div>
        </div>
      </div>
      <div className="filters">
        <FilterSelect label={ownerLabel} value={filters.team} options={data?.teams || []} onChange={(v) => set("team", v)} />
        {!mapped && <FilterSelect label="Tier" value={filters.tier} options={tiers} onChange={(v) => set("tier", v)} />}
        {mapped && <FilterSelect label="Assigned" value={filters.assigned} options={["true", "false"]} onChange={(v) => set("assigned", v)} />}
        <FilterSelect label="Environment" value={filters.environment} options={envs} onChange={(v) => set("environment", v)} />
        <FilterSelect label="Status" value={filters.status} options={["healthy", "warning", "critical"]} onChange={(v) => set("status", v)} />
        {Object.values(filters).some(Boolean) && (
          <button className="btn" style={{ alignSelf: "flex-end" }} onClick={() => setFilters({})}>Clear</button>
        )}
      </div>
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <div className="card flush">
          <DataTable
            id="applications"
            columns={columns}
            rows={apps}
            rowKey="app"
            onRowClick={(a) => setSelected(a.app)}
            initialSort={{ key: "app", dir: "asc" }}
            empty="No applications match."
            footer={`${data.count ?? apps.length} applications`}
          />
        </div>
      )}
    </div>
  );
}

const PLACEMENT_COLUMNS = [
  { key: "cluster", label: "Cluster", className: "mono", filter: "text" },
  { key: "hub", label: "Hub", className: "mono", filter: "select" },
  { key: "environment", label: "Env", filter: "select", render: (p) => <span className="tag">{p.environment}</span> },
  { key: "ocp_version", label: "OCP", className: "mono", filter: "select" },
  { key: "cluster_status", label: "Cluster status", filter: "select", render: (p) => <Pill status={p.cluster_status} /> },
  { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
  {
    key: "namespace_environment", label: "Namespace env", filter: "select",
    render: (p) => (p.namespace_environment ? <span className="tag">{p.namespace_environment}</span> : <span className="muted">-</span>),
  },
  { key: "status", label: "App status", filter: "select", render: (p) => <Pill status={p.status} /> },
  { key: "workloads", label: "Workloads" },
  {
    key: "replicas_ready", label: "Replicas",
    filterValue: (p) => `${p.replicas_ready}/${p.replicas_desired}`,
    render: (p) => `${p.replicas_ready}/${p.replicas_desired}`,
  },
  { key: "pod_issues", label: "Pod issues", render: (p) => p.pod_issues || <span className="muted">0</span> },
  { key: "cpu_used_cores", label: "CPU", render: (p) => fmtCores(p.cpu_used_cores) },
  { key: "memory_used_bytes", label: "Memory", render: (p) => fmtBytes(p.memory_used_bytes) },
];

const WORKLOAD_COLUMNS = [
  { key: "cluster", label: "Cluster", className: "mono", filter: "text" },
  { key: "kind", label: "Kind", className: "muted", filter: "select" },
  { key: "name", label: "Name", filter: "text" },
  { key: "status", label: "Status", filter: "select", render: (w) => <span className={`chip ${w.status}`}>{w.status}</span> },
  {
    key: "replicas", label: "Replicas",
    sortValue: (w) => w.replicas.ready,
    filterValue: (w) => `${w.replicas.ready}/${w.replicas.desired}`,
    render: (w) => `${w.replicas.ready}/${w.replicas.desired}`,
  },
  {
    key: "images", label: "Image", className: "mono wrap", filter: "text",
    sortValue: (w) => w.images.join(", "),
    render: (w) => w.images.join(", "),
  },
  {
    key: "env", label: "Env (name ← source)",
    sortValue: (w) => w.containers.flatMap((c) => c.env).length,
    filterValue: (w) => w.containers.flatMap((c) => c.env).map((e) => e.name).join(" "),
    render: (w) => (
      <div className="env-list">
        {w.containers.flatMap((c) => c.env).map((e) => (
          <span key={e.name}><span className="mono">{e.name}</span> <span className="src">
            {e.from?.kind === "literal" ? "(literal, scrubbed)" : e.from?.kind === "field" ? `← ${e.from.path}` : e.from ? `← ${e.from.kind} ${e.from.name}/${e.from.key}` : ""}
          </span></span>
        ))}
      </div>
    ),
  },
  {
    key: "config_refs", label: "References", className: "muted wrap",
    sortValue: (w) => w.config_refs.length,
    filterValue: (w) => w.config_refs.map((r) => `${r.kind} ${r.name}`).join(", "),
    render: (w) => <span style={{ fontSize: 12 }}>{w.config_refs.map((r) => `${r.kind} ${r.name} (${r.via})`).join(", ")}</span>,
  },
];

function ApplicationDetail({ app, nav, onBack }) {
  const { data: a, error, loading } = useFetch(() => api.application(app), [app]);
  if (loading && !a) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  return (
    <div>
      <span className="back" onClick={onBack}>← All applications</span>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>{a.app}</h2>
        <Pill status={a.status} />
        {a.tier && <Tier tier={a.tier} />}
        {a.team && <span className="muted">{a.namespace_environments?.length ? "LOB" : "team"} {a.team}</span>}
        {a.assigned === false && <span className="muted">namespaces not under a business application</span>}
      </div>
      <div className="grid" style={{ gap: 16 }}>
        <div className="card flush">
          <div className="card-head"><h3>Placements ({a.cluster_count} clusters)</h3></div>
          <DataTable
            id="application.placements"
            columns={PLACEMENT_COLUMNS}
            rows={a.placements}
            rowKey={(p) => `${p.cluster}/${p.namespace}`}
            onRowClick={(p) => nav.openCluster(p.cluster)}
            initialSort={{ key: "cluster", dir: "asc" }}
            empty="No placements."
          />
        </div>
        <div className="card flush">
          <div className="card-head">
            <h3>Workloads ({a.workloads_detail.length})</h3>
            <div className="desc">Container env shows names and sources only - values are never collected.</div>
          </div>
          <DataTable
            id="application.workloads"
            columns={WORKLOAD_COLUMNS}
            rows={a.workloads_detail}
            rowKey={(w) => w.cluster + w.kind + w.name}
            initialSort={{ key: "cluster", dir: "asc" }}
            empty="No workloads."
          />
        </div>
      </div>
    </div>
  );
}
