import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api";
import type {
  CertificatesResponse, ClusterDetail as ClusterDocument, ClusterOperator, ClusterSummary,
  ClustersResponse, EventsResponse, NamespaceDetail, NodeDetail, PodIssue, ResourceRow,
  ResourceSummary, Workload,
} from "../api/types";
import * as cache from "../cache";
import { useFetch } from "../hooks";
import type { Nav } from "../router";
import Chart from "../Chart";
import {
  Pill, ErrorBanner, Dot, SubTabs, UsageBar, Tier, FilterSelect, DataTable,
  Skeleton, SkeletonTable, fmtBytes, fmtCores, fmtTime, fmtAge, fmtDays,
} from "../components";
import type { Column } from "../components";

interface ClusterDetailProps {
  name: string;
  /** The sub-tab the URL names; anything else falls back to the overview. */
  tab?: string;
  nav: Nav;
}

type CertificateRow = CertificatesResponse["certificates"][number];

// An event is the router's own fields plus the collector's stored `summary`
// spread over the row, which the API type carries as an open record. This says
// which of those fields the table draws.
type EventRow = EventsResponse["events"][number] & {
  last_at?: string | null;
  reason?: string | null;
  count?: number | null;
  message?: string | null;
  involved: { kind?: string | null; name?: string | null };
};

const SECTIONS: Array<[key: string, label: string]> = [
  ["overview", "Overview"], ["namespaces", "Namespaces"], ["workloads", "Workloads"], ["nodes", "Nodes"],
  ["issues", "Issues"], ["operators", "Operators"], ["resources", "Resources"],
];

export default function ClusterDetail({ name, tab, nav }: ClusterDetailProps) {
  const section = tab && SECTIONS.some(([k]) => k === tab) ? tab : "overview";
  const { data: c, error } = useFetch(() => api.cluster(name), [name]);

  // The cluster list the user came from is still cached, so the header - name,
  // hub, status, version - is on screen before the detail response lands.
  const summary = cache.search<ClustersResponse, ClusterSummary>("/api/clusters",
    (d) => (d.clusters || []).find((x) => x.name === name));
  const head = c || summary;

  if (error && !c) return <ErrorBanner error={error} />;

  // A cluster the collector could not reach reports null rather than zero for
  // most of these, and `SubTab` already draws no badge for a count that is not
  // there - so the nulls are carried through rather than flattened.
  const counts: Record<string, number | null | undefined> = c ? {
    // The two namespace counts are summed, so one of them being absent must
    // not take the other with it: this is the arithmetic the page has always
    // done, now written where a null can be seen.
    namespaces: (c.namespaces.application || 0) + (c.namespaces.platform || 0),
    workloads: c.workloads,
    nodes: c.nodes.total,
    issues: c.pod_issues,
    operators: c.operators.length,
  } : {};

  return (
    <div>
      <span className="back" onClick={() => nav.back("/clusters")}>← All clusters</span>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <h2 className="mono" style={{ margin: 0 }}>{name}</h2>
          {head ? <Pill status={head.overall_status} /> : <Skeleton width={78} height={20} />}
          {head && <span className="muted mono" style={{ fontSize: 12.5 }}>{head.hub} · {head.ocp_version}</span>}
          {head?.upgrading && <span className="tag">upgrading → {head.desired_version} ({head.upgrade_percent}%)</span>}
          {head && !head.reachable && <span className="tag critical">unreachable</span>}
        </div>
        <SubTabs
          tabs={SECTIONS.map(([k, l]) => [k, l, counts[k]])}
          value={section}
          onChange={(s) => nav.openCluster(name, s)}
        />
      </div>
      {c?.last_error && <div className="banner">{c.last_error}</div>}

      {/* Workloads fetch for themselves, so a deep link to that sub-tab does not
          wait on the cluster document; everything else is a slice of it. */}
      {section === "workloads" ? <WorkloadsSection name={name} />
        : !c ? <SectionSkeleton />
          : section === "namespaces" ? <NamespacesSection c={c} nav={nav} />
            : section === "nodes" ? <NodesSection c={c} />
              : section === "issues" ? <IssuesSection c={c} />
                : section === "operators" ? <OperatorsSection c={c} nav={nav} />
                  : section === "resources" ? <ResourcesSection c={c} />
                    : <OverviewSection c={c} nav={nav} />}
    </div>
  );
}

function SectionSkeleton() {
  return (
    <div className="card flush">
      <SkeletonTable columns={7} rows={9} />
    </div>
  );
}

// ---------------------------------------------------------------------------
/** Every section below is a slice of the one cluster document. */
interface SectionProps {
  c: ClusterDocument;
  nav: Nav;
}

function OverviewSection({ c, nav }: SectionProps) {
  const tl = useFetch(() => api.timeline(c.name), [c.name]);
  const snaps = tl.data?.snapshots || [];
  // The timeline drawn by the same chart the Query page uses: two series that
  // share one 0-100 scale, so there is one axis and no invented correlation.
  const history = useMemo(() => ({
    columns: ["at", "health_score", "cpu_percent"],
    types: ["TIMESTAMP", "INTEGER", "DOUBLE"],
    rows: snaps.map((s) => [
      s.at,
      s.health_score,
      s.cpu_used_cores != null && s.cpu_allocatable_cores
        ? (100 * s.cpu_used_cores) / s.cpu_allocatable_cores
        : null,
    ]),
  }), [snaps]);
  const cap = c.capacity;
  const pc = c.platform_config;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card">
          <h3>Cluster</h3>
          <div className="kv">
            <span className="k">Hub</span><span className="mono">{c.hub}</span>
            <span className="k">Region / DC</span><span>{c.region} / {c.datacenter}</span>
            <span className="k">Environment</span><span><span className="tag">{c.environment}</span></span>
            <span className="k">Platform</span><span>{c.platform} · {c.cloud} · {pc.control_plane_topology || "—"}</span>
            <span className="k">API</span><span className="mono">{pc.api_url || "—"}</span>
            <span className="k">Apps domain</span><span className="mono">{pc.apps_domain || "—"}</span>
            <span className="k">Network</span>
            <span className="mono">{pc.network_type || "—"} {pc.cluster_network.length > 0 && <span className="muted">· pods {pc.cluster_network.join(", ")} · services {pc.service_network.join(", ")}</span>}</span>
            <span className="k">OCP version</span><span className="mono">{c.ocp_version} <span className="muted">· {c.channel}</span></span>
            <span className="k">Kubernetes</span><span className="mono">{c.kube_version}</span>
            {c.available_updates?.length > 0 && (
              <><span className="k">Updates</span><span className="mono">{c.available_updates.join(", ")}</span></>
            )}
            <span className="k">Nodes ready</span><span>{c.nodes.ready}/{c.nodes.total}</span>
            <span className="k">Namespaces</span><span>{c.namespaces.application} applications · {c.namespaces.platform} platform</span>
            <span className="k">Workloads</span><span>{c.workloads}</span>
            <span className="k">Health score</span><span>{c.health_score}/100</span>
            <span className="k">Last collected</span><span className="muted">{fmtTime(c.last_synced)} · {c.collect_ms} ms</span>
          </div>
        </div>

        <div className="card">
          <h3>Capacity {cap.metrics_available ? <span className="muted" style={{ textTransform: "none", fontWeight: 400 }}>· live usage from metrics.k8s.io</span> : <span className="chip warning">metrics.k8s.io unavailable</span>}</h3>
          <CapacityRow label="CPU" used={cap.cpu.used_cores} req={cap.cpu.requests_cores} alloc={cap.cpu.allocatable_cores}
            pct={cap.cpu.used_percent} reqPct={cap.cpu.requests_percent} fmt={fmtCores} />
          <CapacityRow label="Memory" used={cap.memory.used_bytes} req={cap.memory.requests_bytes} alloc={cap.memory.allocatable_bytes}
            pct={cap.memory.used_percent} reqPct={cap.memory.requests_percent} fmt={fmtBytes} />
          <CapacityRow label="Pods" used={cap.pods.running} alloc={cap.pods.capacity} pct={cap.pods.used_percent} fmt={(v) => `${v}`} />
          <h3 style={{ marginTop: 18 }}>History</h3>
          {snaps.length > 1 ? (
            <Chart
              columns={history.columns}
              columnTypes={history.types}
              rows={history.rows}
              spec={{ type: "line", x: "at", series: "", y: ["health_score", "cpu_percent"], stack: false }}
              height={170}
              tableBelow={false}
            />
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>
              {tl.error ? "History is unavailable." : "Not enough sweeps yet for a trend."}
            </div>
          )}
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {snaps.length} sweeps · health score and CPU % of allocatable
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Precondition checks</h3>
        <div className="checklist">
          {c.health_checks.map((h) => (
            <div key={h.name} className={`check ${h.status}`}>
              <Dot status={h.status} />
              <span className="ttl">{h.title} <span className="muted" style={{ fontSize: 11 }}>· {h.severity}</span></span>
              {h.message && <span className="msg">{h.message}</span>}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <button className="btn" onClick={() => nav.goBlast({ ocp_version: c.ocp_version })}>
          Blast radius for OCP {c.ocp_version} →
        </button>
      </div>
    </div>
  );
}

interface CapacityRowProps {
  label: string;
  /** Usage is null when the cluster serves no metrics; the bar is then empty
   * rather than zero, which is a different thing to say. */
  used: number | null;
  req?: number | null;
  alloc: number | null;
  pct: number | null;
  reqPct?: number | null;
  fmt: (v: number | null) => string;
}

function CapacityRow({ label, used, req, alloc, pct, reqPct, fmt }: CapacityRowProps) {
  const tone = pct == null ? "unknown" : pct >= 95 ? "critical" : pct >= 85 ? "warning" : "healthy";
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
        <span>{label} {pct != null && <span className="muted">· {pct.toFixed(0)}%</span>}</span>
        <span className="dim">
          {used != null ? <>{fmt(used)} used</> : <span className="muted">usage n/a</span>}
          {req != null && <span className="muted"> · {fmt(req)} requested{reqPct != null && ` (${reqPct.toFixed(0)}%)`}</span>}
          <span className="muted"> · {fmt(alloc)} allocatable</span>
        </span>
      </div>
      <div className="hbar" style={{ height: 10 }} title={pct == null ? "metrics unavailable" : `${pct.toFixed(1)}% of allocatable`}>
        {pct != null && <span className={tone} style={{ width: `${Math.min(100, pct)}%` }} />}
        {reqPct != null && <span className="req-marker" style={{ left: `${Math.min(100, reqPct)}%` }} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function NamespacesSection({ c, nav }: SectionProps) {
  const apps = c.namespaces_detail.filter((n) => n.class === "application");
  const platform = c.namespaces_detail.filter((n) => n.class === "platform");
  return (
    <div className="grid" style={{ gap: 16 }}>
      <NamespaceTable id="cluster.namespaces.application" title={`Applications (${apps.length})`} rows={apps} showOwner nav={nav}
        desc="Every non-platform namespace is an application. Ownership comes from labels on the namespace, then its workloads." />
      <NamespaceTable id="cluster.namespaces.platform" title={`OpenShift platform namespaces (${platform.length})`} rows={platform} nav={nav}
        desc="The cluster's own namespaces, grouped separately (openshift-*, kube-*, default…)." />
    </div>
  );
}

interface NamespaceTableProps {
  id: string;
  title: string;
  rows: NamespaceDetail[];
  /** The platform table has no owner to show, so those columns are left out. */
  showOwner?: boolean;
  desc: string;
  nav: Nav;
}

// Who owns the namespace. Only the application table shows it, so the three
// columns are their own list - a list spread into another one is not
// contextually typed by it, and would widen `filter` back to `string`.
const OWNER_COLUMNS: Column<NamespaceDetail>[] = [
  { key: "app", label: "App", filter: "text" },
  { key: "team", label: "Team", className: "muted", filter: "select", render: (n) => n.team || "—" },
  { key: "tier", label: "Tier", filter: "select", render: (n) => <Tier tier={n.tier} /> },
];

function NamespaceTable({ id, title, rows, showOwner, desc, nav }: NamespaceTableProps) {
  const columns: Column<NamespaceDetail>[] = [
    { key: "name", label: "Namespace", className: "mono", filter: "text" },
    ...(showOwner ? OWNER_COLUMNS : []),
    { key: "status", label: "Status", filter: "select", render: (n) => <Pill status={n.status} /> },
    { key: "workloads", label: "Workloads" },
    {
      key: "replicas_ready", label: "Replicas",
      filterValue: (n) => `${n.replicas_ready}/${n.replicas_desired}`,
      render: (n) => `${n.replicas_ready}/${n.replicas_desired}`,
    },
    {
      key: "pods", label: "Pods",
      sortValue: (n) => n.pods.running,
      filterValue: (n) => `${n.pods.running}/${n.pods.total}`,
      render: (n) => (
        <>
          {n.pods.running}<span className="muted">/{n.pods.total}</span>
          {n.pods.pending ? <span style={{ color: "var(--warning)" }}> +{n.pods.pending} pending</span> : null}
        </>
      ),
    },
    {
      key: "restarts", label: "Restarts",
      sortValue: (n) => n.pods.restarts,
      render: (n) => n.pods.restarts || <span className="muted">0</span>,
    },
    {
      key: "issues", label: "Issues",
      sortValue: (n) => n.pods.issues,
      render: (n) => (n.pods.issues ? <span style={{ color: "var(--warning)" }}>{n.pods.issues}</span> : <span className="muted">0</span>),
    },
    {
      key: "cpu", label: "CPU used / req", className: "nowrap",
      sortValue: (n) => n.cpu.used_cores,
      filterValue: (n) => `${fmtCores(n.cpu.used_cores)} / ${fmtCores(n.cpu.requests_cores)}`,
      render: (n) => <>{fmtCores(n.cpu.used_cores)} <span className="muted">/ {fmtCores(n.cpu.requests_cores)}</span></>,
    },
    {
      key: "memory", label: "Memory used / req", className: "nowrap",
      sortValue: (n) => n.memory.used_bytes,
      filterValue: (n) => `${fmtBytes(n.memory.used_bytes)} / ${fmtBytes(n.memory.requests_bytes)}`,
      render: (n) => <>{fmtBytes(n.memory.used_bytes)} <span className="muted">/ {fmtBytes(n.memory.requests_bytes)}</span></>,
    },
    {
      key: "resource_counts", label: "Resources", className: "muted",
      sortValue: (n) => Object.values(n.resource_counts).reduce((a, b) => a + b, 0),
      filterValue: (n) => Object.keys(n.resource_counts).join(" "),
      render: (n) => <span style={{ fontSize: 11.5 }}>{Object.entries(n.resource_counts).map(([k, v]) => `${v} ${k}`).join(" · ") || "—"}</span>,
    },
  ];
  return (
    <div className="card flush">
      <div className="card-head"><h3>{title}</h3><div className="desc">{desc}</div></div>
      <DataTable
        id={id}
        columns={columns}
        rows={rows}
        rowKey="name"
        onRowClick={showOwner ? (n) => nav.openApp(n.app) : undefined}
        initialSort={{ key: "name", dir: "asc" }}
        empty="None."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
const workloadKey = (w: Workload) => `${w.namespace}/${w.kind}/${w.name}`;

const WORKLOAD_COLUMNS: Column<Workload>[] = [
  { key: "namespace", label: "Namespace", className: "mono", filter: "text", sortValue: (w) => `${w.namespace}/${w.name}` },
  { key: "kind", label: "Kind", className: "muted", filter: "select" },
  { key: "name", label: "Name", filter: "text" },
  { key: "status", label: "Status", filter: "select", render: (w) => <span className={`chip ${w.status}`}>{w.status}</span> },
  {
    key: "replicas", label: "Replicas", className: "nowrap",
    sortValue: (w) => w.replicas.ready,
    filterValue: (w) => `${w.replicas.ready}/${w.replicas.desired}`,
    render: (w) => (
      <>
        {w.replicas.ready}/{w.replicas.desired}
        {(w.replicas.updated ?? 0) < (w.replicas.desired ?? 0)
          && <span className="muted"> · {w.replicas.updated} updated</span>}
      </>
    ),
  },
  {
    key: "images", label: "Images", className: "mono wrap", filter: "text",
    sortValue: (w) => w.images.join(", "),
    render: (w) => w.images.join(", "),
  },
  {
    key: "config_refs", label: "Config refs", className: "muted",
    // `config_refs`, `containers`, `labels` and `node_selector` only arrive
    // with detail=true (which this table always asks for), so the type has
    // them optional and every read here says what an absent one counts as.
    sortValue: (w) => w.config_refs?.length ?? 0,
    render: (w) => w.config_refs?.length ?? 0,
  },
  { key: "service_account", label: "SA", className: "muted", filter: "select" },
  { key: "created_at", label: "Age", className: "muted", render: (w) => fmtAge(w.created_at) },
];

function WorkloadsSection({ name }: { name: string }) {
  const [cls, setCls] = useState("");
  const [ns, setNs] = useState("");
  // Which workload's containers are open, if any.
  const [open, setOpen] = useState<string | null>(null);
  const { data, error } = useFetch(() => api.clusterWorkloads(name, { class: cls, namespace: ns, detail: true }), [name, cls, ns]);
  const namespaces = [...new Set((data?.workloads || []).map((w) => w.namespace))].sort();
  return (
    <div className="card flush">
      <div className="card-head">
        <div className="section-head">
          <h3 style={{ margin: 0 }}>Workloads</h3>
          <div className="filters" style={{ margin: 0 }}>
            <SubTabs tabs={[["", "All"], ["application", "Apps"], ["platform", "Platform"]]} value={cls} onChange={(v) => { setCls(v); setNs(""); }} />
            <FilterSelect label="Namespace" value={ns} options={namespaces} onChange={setNs} />
          </div>
        </div>
        <div className="desc">Env var names and their Secret / ConfigMap sources are collected; values never are. Click a row for containers.</div>
      </div>
      {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={9} rows={8} /> : (
        <DataTable
          id="cluster.workloads"
          columns={WORKLOAD_COLUMNS}
          rows={data.workloads}
          rowKey={workloadKey}
          onRowClick={(w) => setOpen(open === workloadKey(w) ? null : workloadKey(w))}
          expanded={(w) => (open === workloadKey(w) ? <WorkloadDetail w={w} /> : null)}
          initialSort={{ key: "namespace", dir: "asc" }}
          empty="No workloads."
        />
      )}
    </div>
  );
}

function WorkloadDetail({ w }: { w: Workload }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16, padding: "6px 4px" }}>
      {(w.containers || []).map((c) => (
        <div key={c.name} className="card" style={{ padding: 12 }}>
          <h3 style={{ marginBottom: 8 }}>container {c.name}</h3>
          <div className="kv" style={{ fontSize: 12.5 }}>
            <span className="k">Image</span><span className="mono">{c.image}</span>
            <span className="k">Requests</span><span className="mono">{Object.entries(c.requests || {}).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}</span>
            <span className="k">Limits</span><span className="mono">{Object.entries(c.limits || {}).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}</span>
            <span className="k">Env</span>
            <span className="env-list">
              {(c.env || []).length === 0 && <span className="muted">none</span>}
              {(c.env || []).map((e) => (
                <span key={e.name}><span className="mono">{e.name}</span> <span className="src">
                  {e.from?.kind === "literal" ? "= (value scrubbed)"
                    : e.from?.kind === "field" ? `← field ${e.from.path}`
                    : e.from?.kind ? `← ${e.from.kind} ${e.from.name}${e.from.key ? `/${e.from.key}` : ""}` : ""}
                </span></span>
              ))}
              {(c.env_from || []).map((e, i) => <span key={i}><span className="src">envFrom ← {e.kind} {e.name}</span></span>)}
            </span>
          </div>
        </div>
      ))}
      <div className="card" style={{ padding: 12 }}>
        <h3 style={{ marginBottom: 8 }}>References</h3>
        <div className="env-list">
          {(w.config_refs || []).map((r, i) => <span key={i}><span className="muted">{r.kind}</span> <span className="mono">{r.name}</span> <span className="src">via {r.via}</span></span>)}
          {(w.config_refs || []).length === 0 && <span className="muted">none</span>}
        </div>
        <div className="kv" style={{ fontSize: 12.5, marginTop: 10 }}>
          <span className="k">Labels</span><span className="mono wrap">{Object.entries(w.labels || {}).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}</span>
          <span className="k">Strategy</span><span>{w.strategy || "—"}</span>
          <span className="k">Node selector</span><span className="mono">{Object.entries(w.node_selector || {}).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
const nodePressure = (n: NodeDetail) =>
  Object.entries(n.conditions).filter(([, v]) => v).map(([k]) => k);
const nodeState = (n: NodeDetail) =>
  (!n.ready ? "critical" : nodePressure(n).length || !n.schedulable ? "warning" : "healthy");

const NODE_COLUMNS: Column<NodeDetail>[] = [
  { key: "name", label: "Node", className: "mono", filter: "text" },
  {
    key: "roles", label: "Roles", filter: "select",
    filterValue: (n) => n.roles.join(", "),
    render: (n) => n.roles.map((r) => <span key={r} className="tag" style={{ marginRight: 4 }}>{r}</span>),
  },
  {
    key: "state", label: "State", filter: "select",
    sortValue: (n) => ({ critical: 0, warning: 1, healthy: 2 } as Record<string, number>)[nodeState(n)],
    filterValue: (n) => nodeState(n),
    render: (n) => {
      const pressure = nodePressure(n);
      return (
        <>
          <Pill status={nodeState(n)} />
          {!n.schedulable && <span className="muted"> cordoned</span>}
          {pressure.length > 0 && <span className="muted"> {pressure.join(", ")}</span>}
        </>
      );
    },
  },
  {
    key: "cpu", label: "CPU used / alloc", className: "nowrap",
    sortValue: (n) => n.cpu.used_percent,
    filterValue: (n) => `${n.cpu.used_cores != null ? n.cpu.used_cores.toFixed(2) : ""} / ${n.cpu.allocatable_cores}`,
    render: (n) => (
      <>
        <UsageBar percent={n.cpu.used_percent} width={70} />{" "}
        <span className="muted">{n.cpu.used_cores != null ? n.cpu.used_cores.toFixed(2) : "—"} / {n.cpu.allocatable_cores}</span>
      </>
    ),
  },
  {
    key: "memory", label: "Memory used / alloc", className: "nowrap",
    sortValue: (n) => n.memory.used_percent,
    filterValue: (n) => `${fmtBytes(n.memory.used_bytes)} / ${fmtBytes(n.memory.allocatable_bytes)}`,
    render: (n) => (
      <>
        <UsageBar percent={n.memory.used_percent} width={70} />{" "}
        <span className="muted">{fmtBytes(n.memory.used_bytes)} / {fmtBytes(n.memory.allocatable_bytes)}</span>
      </>
    ),
  },
  {
    key: "pods", label: "Pods",
    sortValue: (n) => n.pods.running,
    filterValue: (n) => `${n.pods.running}/${n.pods.capacity}`,
    render: (n) => <>{n.pods.running}<span className="muted">/{n.pods.capacity}</span></>,
  },
  { key: "kubelet_version", label: "Kubelet", className: "mono", filter: "select" },
  { key: "os_image", label: "OS", className: "muted wrap", filter: "text" },
  { key: "container_runtime", label: "Runtime", className: "mono", filter: "select" },
  {
    key: "zone", label: "Zone / type", className: "muted", filter: "select",
    filterValue: (n) => [n.zone, n.instance_type].filter(Boolean).join(" · "),
    render: (n) => [n.zone, n.instance_type].filter(Boolean).join(" · ") || "—",
  },
  {
    key: "images", label: "Images", className: "muted nowrap",
    sortValue: (n) => n.images.bytes,
    filterValue: (n) => `${n.images.count}`,
    render: (n) => `${n.images.count} · ${fmtBytes(n.images.bytes)}`,
  },
  { key: "created_at", label: "Age", className: "muted", render: (n) => fmtAge(n.created_at) },
];

function NodesSection({ c }: { c: ClusterDocument }) {
  return (
    <div className="card flush">
      <div className="card-head"><h3>Nodes ({c.nodes_detail.length})</h3></div>
      <DataTable
        id="cluster.nodes"
        columns={NODE_COLUMNS}
        rows={c.nodes_detail}
        rowKey="name"
        initialSort={{ key: "name", dir: "asc" }}
        empty="No nodes collected."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
const POD_ISSUE_COLUMNS: Column<PodIssue>[] = [
  { key: "class", label: "Class", filter: "select", render: (i) => <span className="tag">{i.class}</span> },
  { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
  { key: "name", label: "Pod", filter: "text" },
  { key: "reason", label: "Reason", filter: "select", render: (i) => <span className="chip critical">{i.reason}</span> },
  { key: "owner", label: "Owner", className: "muted", filter: "text", render: (i) => i.owner || "—" },
  { key: "node", label: "Node", className: "muted", filter: "select", render: (i) => i.node || "—" },
  { key: "restarts", label: "Restarts" },
  { key: "containers_ready", label: "Ready" },
  { key: "message", label: "Message", className: "muted wrap", filter: "text" },
  { key: "started_at", label: "Since", className: "muted", render: (i) => fmtAge(i.started_at) },
];

const CLUSTER_CERT_COLUMNS: Column<CertificateRow>[] = [
  { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
  { key: "kind", label: "Kind", className: "muted", filter: "select" },
  { key: "name", label: "Name", filter: "text" },
  { key: "status", label: "Status", filter: "select", render: (r) => <span className={`chip ${r.status}`}>{r.status}</span> },
  {
    key: "days_left", label: "Expires", className: "nowrap",
    filterValue: (r) => fmtDays(r.days_left),
    render: (r) => <>{fmtDays(r.days_left)} <span className="muted">· {fmtTime(r.expires_at)}</span></>,
  },
  {
    key: "subject", label: "Subject", className: "mono muted", filter: "text",
    filterValue: (r) => r.certificates[0]?.subject || "",
    render: (r) => r.certificates[0]?.subject,
  },
];

const CLUSTER_EVENT_COLUMNS: Column<EventRow>[] = [
  {
    key: "last_at", label: "When", className: "muted nowrap",
    filterValue: (e) => fmtAge(e.last_at),
    render: (e) => `${fmtAge(e.last_at)} ago`,
  },
  { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
  {
    key: "object", label: "Object", filter: "text",
    sortValue: (e) => `${e.involved.kind}/${e.involved.name}`,
    filterValue: (e) => `${e.involved.kind}/${e.involved.name}`,
    render: (e) => `${e.involved.kind}/${e.involved.name}`,
  },
  { key: "reason", label: "Reason", filter: "select", render: (e) => <span className="chip warning">{e.reason}</span> },
  { key: "count", label: "Count" },
  { key: "message", label: "Message", className: "muted wrap", filter: "text" },
];

function IssuesSection({ c }: { c: ClusterDocument }) {
  const ev = useFetch(() => api.events({ cluster: c.name, limit: 50 }), [c.name]);
  const certs = useFetch(() => api.certificates({ cluster: c.name }), [c.name]);
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card flush">
        <div className="card-head"><h3>Pod issues ({c.pod_issues_detail.length})</h3></div>
        <DataTable
          id="cluster.podIssues"
          columns={POD_ISSUE_COLUMNS}
          rows={c.pod_issues_detail}
          rowKey={(i) => i.namespace + "/" + i.name}
          initialSort={{ key: "namespace", dir: "asc" }}
          empty="No problem pods."
        />
      </div>
      <div className="card flush">
        <div className="card-head"><h3>Certificates expiring ({certs.data?.count ?? "…"})</h3></div>
        {certs.error && !certs.data ? <ErrorBanner error={certs.error} /> : !certs.data ? <SkeletonTable columns={6} rows={4} /> : (
          <DataTable
            id="cluster.certificates"
            columns={CLUSTER_CERT_COLUMNS}
            rows={certs.data.certificates}
            rowKey={(r) => r.namespace + "/" + r.name}
            initialSort={{ key: "days_left", dir: "asc" }}
            empty="Nothing expiring within the threshold."
          />
        )}
      </div>
      <div className="card flush">
        <div className="card-head"><h3>Recent warning events</h3></div>
        {ev.error && !ev.data ? <ErrorBanner error={ev.error} /> : !ev.data ? <SkeletonTable columns={6} rows={5} /> : (
          <DataTable
            id="cluster.events"
            columns={CLUSTER_EVENT_COLUMNS}
            rows={ev.data.events as EventRow[]}
            rowKey={(e, i) => `${e.namespace}/${e.name}/${i}`}
            initialSort={{ key: "last_at", dir: "desc" }}
            empty="No warning events."
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function OperatorsSection({ c, nav }: SectionProps) {
  const columns: Column<ClusterOperator>[] = [
    {
      key: "name", label: "Operator", filter: "text",
      render: (o) => <>{o.name} {o.critical && <span className="tag critical">critical</span>}</>,
    },
    { key: "version", label: "Version", className: "mono", filter: "select" },
    {
      key: "state", label: "State", filter: "select",
      sortValue: (o) => ["Degraded", "Unavailable", "Progressing", "Available"].indexOf(opStateLabel(o)),
      filterValue: (o) => opStateLabel(o),
      render: (o) => opState(o),
    },
    { key: "message", label: "Message", className: "muted wrap", filter: "text" },
    {
      key: "blast", label: "",
      render: (o) => (
        <span className="link" onClick={() => nav.goBlast({ operator: o.name, operator_version: o.version })}>blast radius →</span>
      ),
    },
  ];
  return (
    <div className="card flush">
      <div className="card-head"><h3>Cluster operators ({c.operators.length})</h3></div>
      <DataTable
        id="cluster.operators"
        columns={columns}
        rows={c.operators}
        rowKey="name"
        initialSort={{ key: "name", dir: "asc" }}
        empty="No cluster operators collected."
      />
    </div>
  );
}

function opStateLabel(o: ClusterOperator) {
  if (o.degraded) return "Degraded";
  if (!o.available) return "Unavailable";
  if (o.progressing) return "Progressing";
  return "Available";
}

function opState(o: ClusterOperator) {
  const label = opStateLabel(o);
  const color = label === "Progressing" ? "var(--warning)" : label === "Available" ? "var(--healthy)" : "var(--critical)";
  return <span style={{ color }}>{label}</span>;
}

// ---------------------------------------------------------------------------
const RESOURCE_KINDS = ["routes", "services", "configmaps", "secrets", "persistentvolumeclaims", "resourcequotas",
  "networkpolicies", "horizontalpodautoscalers", "cronjobs", "ingresses", "clusterserviceversions", "subscriptions",
  "machineconfigpools", "storageclasses", "persistentvolumes", "clusterrolebindings", "events"];

const INVENTORY_COLUMNS: Column<ResourceRow>[] = [
  {
    key: "namespace", label: "Namespace", className: "mono", filter: "text",
    sortValue: (r) => `${r.namespace || ""}/${r.name}`,
    render: (r) => r.namespace || <span className="muted">cluster</span>,
  },
  { key: "name", label: "Name", filter: "text" },
  {
    key: "status", label: "Status", filter: "select",
    render: (r) => (r.status ? <span className={`chip ${r.status}`}>{r.status}</span> : <span className="muted">—</span>),
  },
  {
    key: "summary", label: "Summary", className: "muted wrap", filter: "text",
    sortValue: (r) => summarize(r),
    filterValue: (r) => summarize(r),
    render: (r) => <span style={{ fontSize: 12 }}>{summarize(r)}</span>,
  },
  { key: "created_at", label: "Age", className: "muted", render: (r) => fmtAge(r.created_at) },
];

function ResourcesSection({ c }: { c: ClusterDocument }) {
  const [kind, setKind] = useState("routes");
  const [ns, setNs] = useState("");
  const { data, error } = useFetch(() => api.clusterResources(c.name, { kind, namespace: ns }), [c.name, kind, ns]);
  const status = Object.fromEntries(c.resource_status.map((s) => [s.key, s]));
  const namespaces = c.namespaces_detail.map((n) => n.name);
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h3>What this cluster served</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {c.resource_status.map((s) => (
            <span key={s.key} className={`chip ${s.status}`} title={s.error || `${s.count} objects in ${s.duration_ms} ms`}>
              {s.key} {s.status === "collected" ? <b>{s.count}</b> : <i>{s.status}</i>}
            </span>
          ))}
        </div>
      </div>
      <div className="card flush">
        <div className="card-head">
          <div className="section-head">
            <h3 style={{ margin: 0 }}>Inventory</h3>
            <div className="filters" style={{ margin: 0 }}>
              <FilterSelect label="Kind" value={kind} options={RESOURCE_KINDS} onChange={(v) => setKind(v || "routes")} allLabel="routes" />
              <FilterSelect label="Namespace" value={ns} options={namespaces} onChange={setNs} />
            </div>
          </div>
          <div className="desc">
            {status[kind]?.status === "collected" ? `${status[kind].count} collected` : `not collected: ${status[kind]?.status || "disabled"}`}
            {" · "}ConfigMaps / Secrets show key names, sizes and certificate facts only.
          </div>
        </div>
        {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={5} rows={8} /> : (
          <DataTable
            id="cluster.resources"
            columns={INVENTORY_COLUMNS}
            rows={data.resources}
            rowKey={(r, i) => `${r.namespace || ""}/${r.name}/${i}`}
            initialSort={{ key: "namespace", dir: "asc" }}
            empty="Nothing collected for this kind."
            scroll
          />
        )}
      </div>
    </div>
  );
}

/** One inventory row as a sentence. The summary is per-kind and open by
 * design (`serialize.resource_dict`), so `r.key` is what says which shape
 * applies - there are seventeen of them, and the API declares none. */
export function summarize(r: { key: string; summary?: ResourceSummary | null }): string {
  // why: `any` rather than `unknown` here because each branch below already
  // knows its own kind's fields, and the alternative is seventeen interfaces
  // that only this function would ever read. Adding `response_model` to the
  // handler (ADR-0005's follow-up) is what would make them generated instead.
  // The same goes for the `any` on the callbacks over the nested lists: those
  // items are as undeclared as the summary that carries them.
  const s = (r.summary || {}) as Record<string, any>;
  switch (r.key) {
    case "routes": return `${s.host}${s.path || ""} → ${s.service} · tls ${s.tls_termination || "none"}`;
    case "services": return `${s.type} ${s.cluster_ip || ""} · ${(s.ports || []).map((p: any) => `${p.port}→${p.target}`).join(", ")}${s.load_balancer?.length ? " · lb " + s.load_balancer.join(",") : ""}`;
    case "configmaps":
    case "secrets": return `${s.type ? s.type + " · " : ""}${s.key_count} keys (${(s.keys || []).map((k: any) => k.key).join(", ")}) · ${fmtBytes(s.total_bytes)}${s.certificates ? ` · cert ${s.certificates[0].subject} exp ${fmtTime(s.certificates[0].not_after)}` : ""}`;
    case "persistentvolumeclaims": return `${s.storage_class || "(no class)"} · ${fmtBytes(s.requested_bytes)}${s.capacity_bytes ? ` (${fmtBytes(s.capacity_bytes)} bound)` : ""} · ${(s.access_modes || []).join(",")}${s.mounted_by?.length ? ` · mounted by ${s.mounted_by.join(", ")}` : " · not mounted"}`;
    case "persistentvolumes": return `${s.storage_class || ""} · ${fmtBytes(s.capacity_bytes)} · ${s.csi_driver || "in-tree"} · claim ${s.claim || "—"} · ${s.reclaim_policy}`;
    case "resourcequotas": return `${(s.resources || []).map((q: any) => `${q.resource} ${q.used}/${q.hard} (${q.percent}%)`).join(" · ")}`;
    case "networkpolicies": return `${(s.policy_types || []).join(",")} · ${s.ingress_rules} ingress / ${s.egress_rules} egress rules`;
    case "horizontalpodautoscalers": return `${s.target} · ${s.current_replicas ?? "?"} of ${s.min_replicas}-${s.max_replicas} · ${(s.metrics || []).map((m: any) => `${m.resource} ${m.target_percent ?? m.target_value}`).join(", ")}`;
    case "cronjobs": return `${s.schedule} · ${s.suspended ? "suspended" : "active"} · last ${s.last_schedule ? fmtTime(s.last_schedule) : "never"} · ${(s.images || []).join(", ")}`;
    case "ingresses": return `${(s.hosts || []).join(", ")} · class ${s.class || "—"}`;
    case "clusterserviceversions": return `${s.package} ${s.version} · ${s.phase}${s.reason ? ` (${s.reason})` : ""} · ${s.provider || ""}`;
    case "subscriptions": return `${s.package} · ${s.channel} · installed ${s.installed_csv}${s.upgrade_pending ? ` → ${s.current_csv}` : ""}`;
    case "machineconfigpools": return `${s.updated}/${s.machine_count} updated · ${s.ready} ready · ${s.degraded} degraded${s.paused ? " · paused" : ""}${s.message ? ` · ${s.message}` : ""}`;
    case "storageclasses": return `${s.provisioner} · ${s.binding_mode} · ${s.reclaim_policy}${s.default ? " · default" : ""}`;
    case "clusterrolebindings": return `${s.role} → ${(s.subjects || []).map((x: any) => `${x.kind}/${x.name}`).join(", ")}`;
    case "events": return `${s.reason}: ${s.involved?.kind}/${s.involved?.name} ×${s.count} · ${s.message}`;
    default: return JSON.stringify(s);
  }
}
