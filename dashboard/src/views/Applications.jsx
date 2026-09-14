import { api } from "../api";
import * as cache from "../cache";
import { useFetch } from "../hooks";
import { useQueryFilters } from "../router";
import { Pill, ErrorBanner, FilterSelect, Tier, DataTable, SkeletonTable, fmtBytes, fmtCores } from "../components";

const FILTER_KEYS = ["team", "tier", "assigned", "environment", "status"];

// The list rows carry cluster names directly (`clusters`); the full placement
// objects only come back when they are asked for, and only the detail page
// needs them. Older responses that still carry placements keep working.
const clusterNames = (a) => a.clusters ?? (a.placements || []).map((p) => p.cluster);

export default function Applications({ app, nav, route }) {
  const [filters, set, clear, anyFilter] = useQueryFilters(route, FILTER_KEYS);
  const { data, error } = useFetch(() => api.applications(filters), [JSON.stringify(filters)]);

  if (app) return <ApplicationDetail app={app} nav={nav} />;

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
      filterValue: (a) => `${a.cluster_count} ${clusterNames(a).join(" ")}`,
      render: (a) => {
        const names = [...new Set(clusterNames(a))];
        const shown = names.slice(0, 3).join(", ");
        const more = names.length > 3 ? ` +${names.length - 3}` : "";
        return <>{a.cluster_count}{shown && <span className="muted mono" style={{ fontSize: 12 }}> · {shown}{more}</span>}</>;
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
        {anyFilter && (
          <button className="btn" style={{ alignSelf: "flex-end" }} onClick={clear}>Clear</button>
        )}
      </div>
      {error && !data ? <ErrorBanner error={error} /> : (
        <div className="card flush">
          {!data ? <SkeletonTable columns={9} rows={10} /> : (
            <DataTable
              id="applications"
              columns={columns}
              rows={apps}
              rowKey="app"
              onRowClick={(a) => nav.openApp(a.app)}
              initialSort={{ key: "app", dir: "asc" }}
              empty="No applications match."
              footer={`${data.count ?? apps.length} applications`}
            />
          )}
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

function ApplicationDetail({ app, nav }) {
  const { data, error } = useFetch(() => api.application(app), [app]);
  // The row the user clicked is already in hand: the header renders from it
  // while the detail request is still out, so only the tables are pending.
  const summary = cache.search("/api/applications", (d) => (d.applications || []).find((x) => x.app === app));
  const a = data || summary;
  if (error && !data) return <ErrorBanner error={error} />;

  return (
    <div>
      <span className="back" onClick={() => nav.back("/applications")}>← All applications</span>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>{a ? a.app : app}</h2>
        {a && <Pill status={a.status} />}
        {a?.tier && <Tier tier={a.tier} />}
        {a?.team && <span className="muted">{a.namespace_environments?.length ? "LOB" : "team"} {a.team}</span>}
        {a?.assigned === false && <span className="muted">namespaces not under a business application</span>}
      </div>
      <div className="grid" style={{ gap: 16 }}>
        <div className="card flush">
          <div className="card-head"><h3>Placements{a ? ` (${a.cluster_count} clusters)` : ""}</h3></div>
          {!data ? <SkeletonTable columns={8} rows={5} /> : (
            <DataTable
              id="application.placements"
              columns={PLACEMENT_COLUMNS}
              rows={data.placements}
              rowKey={(p) => `${p.cluster}/${p.namespace}`}
              onRowClick={(p) => nav.openCluster(p.cluster)}
              initialSort={{ key: "cluster", dir: "asc" }}
              empty="No placements."
            />
          )}
        </div>
        <div className="card flush">
          <div className="card-head">
            <h3>Workloads{data ? ` (${data.workloads_detail.length})` : ""}</h3>
            <div className="desc">Container env shows names and sources only - values are never collected.</div>
          </div>
          {!data ? <SkeletonTable columns={7} rows={6} /> : (
            <DataTable
              id="application.workloads"
              columns={WORKLOAD_COLUMNS}
              rows={data.workloads_detail}
              rowKey={(w) => w.cluster + w.kind + w.name}
              initialSort={{ key: "cluster", dir: "asc" }}
              empty="No workloads."
            />
          )}
        </div>
      </div>
    </div>
  );
}
