import { useEffect, useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { Loading, ErrorBanner, SubTabs, Pill, FilterSelect, DataTable, fmtBytes, fmtTime, fmtAge, fmtDays } from "../components";

const SECTIONS = [
  ["certificates", "Certificates"], ["pods", "Pod issues"], ["quotas", "Quotas"], ["olm", "OLM operators"],
  ["mcp", "Machine config pools"], ["storage", "Storage"], ["routes", "Routes"], ["events", "Events"],
  ["images", "Images"], ["references", "Config references"], ["access", "Cluster admins"],
];

export default function Insights({ initialSection, nav }) {
  const [section, setSection] = useState(initialSection || "certificates");
  useEffect(() => { if (initialSection) setSection(initialSection); }, [initialSection]);
  const clusters = useFetch(() => api.clusters(), []);
  const names = (clusters.data?.clusters || []).map((c) => c.name);
  const props = { nav, clusterNames: names };
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="section-head">
        <div>
          <div className="section-title" style={{ margin: 0 }}>Insights</div>
          <div className="desc">Fleet-wide views computed over what every cluster's API server reported on the last sweep.</div>
        </div>
      </div>
      <SubTabs tabs={SECTIONS} value={section} onChange={setSection} />
      {section === "certificates" && <Certificates {...props} />}
      {section === "pods" && <PodIssues {...props} />}
      {section === "quotas" && <Quotas {...props} />}
      {section === "olm" && <Olm {...props} />}
      {section === "mcp" && <Mcp {...props} />}
      {section === "storage" && <Storage {...props} />}
      {section === "routes" && <Routes {...props} />}
      {section === "events" && <Events {...props} />}
      {section === "images" && <Images {...props} />}
      {section === "references" && <References {...props} />}
      {section === "access" && <Access {...props} />}
    </div>
  );
}

function Card({ title, desc, children, right }) {
  return (
    <div className="card flush">
      <div className="card-head">
        <div className="section-head" style={{ marginBottom: 4 }}><h3 style={{ margin: 0 }}>{title}</h3>{right}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

// A cluster column that opens the cluster. The dropdowns above a table filter
// the API query, so the cluster column only takes a column filter where there
// is no server-side cluster select.
function clusterColumn(nav, opts = {}) {
  return {
    key: "cluster",
    label: "Cluster",
    className: "mono",
    render: (r) => <span className="link" onClick={() => nav.openCluster(r.cluster)}>{r.cluster}</span>,
    ...opts,
  };
}

// Worst first when a status column is sorted ascending.
const STATUS_RANK = {
  expired: 0, critical: 0, degraded: 0, failed: 0, error: 0, lost: 0, exhausted: 0, rejected: 0,
  expiring: 1, warning: 1, pending: 1, updating: 1, progressing: 1, unavailable: 1,
  paused: 2, suspended: 2,
};
const statusRank = (s) => (s in STATUS_RANK ? STATUS_RANK[s] : 5);

// ---------------------------------------------------------------------------
function Certificates({ nav, clusterNames }) {
  const [includeValid, setIncludeValid] = useState(false);
  const [cluster, setCluster] = useState("");
  const { data, error, loading } = useFetch(() => api.certificates({ include_valid: includeValid, cluster }), [includeValid, cluster]);

  const columns = [
    {
      key: "status", label: "Status", filter: "select",
      sortValue: (r) => statusRank(r.status),
      render: (r) => <span className={`chip ${r.status}`}>{r.status}</span>,
    },
    {
      key: "days_left", label: "Expires in", className: "nowrap",
      filterValue: (r) => fmtDays(r.days_left),
      render: (r) => (
        <span style={{ color: r.days_left < 0 ? "var(--critical)" : r.days_left < 30 ? "var(--warning)" : undefined }}>
          {fmtDays(r.days_left)}
        </span>
      ),
    },
    clusterColumn(nav),
    { key: "environment", label: "Env", filter: "select", render: (r) => <span className="tag">{r.environment}</span> },
    {
      key: "namespace", label: "Namespace", className: "mono", filter: "text",
      render: (r) => <>{r.namespace} {r.class === "platform" && <span className="muted">(platform)</span>}</>,
    },
    {
      key: "kind", label: "Kind", className: "muted", filter: "select",
      filterValue: (r) => r.kind,
      render: (r) => `${r.kind}${r.secret_type ? ` · ${r.secret_type}` : ""}`,
    },
    { key: "name", label: "Name", filter: "text" },
    {
      key: "subject", label: "Subject", className: "mono muted wrap", filter: "text",
      filterValue: (r) => r.certificates[0]?.subject || "",
      render: (r) => r.certificates[0]?.subject,
    },
    {
      key: "issuer", label: "Issuer", className: "mono muted wrap", filter: "text",
      filterValue: (r) => r.certificates[0]?.issuer || "",
      render: (r) => r.certificates[0]?.issuer,
    },
    { key: "expires_at", label: "Not after", className: "muted nowrap", render: (r) => fmtTime(r.expires_at) },
  ];

  return (
    <Card title={`Certificates${data ? ` (${data.count})` : ""}`}
      desc={`Parsed from TLS Secrets and PEM keys in ConfigMaps. Only subject / issuer / validity are kept - the certificate material is never collected. Window: ${data?.within_days ?? "…"} days.`}
      right={<div className="filters" style={{ margin: 0 }}>
        <FilterSelect label="Cluster" value={cluster} options={clusterNames} onChange={setCluster} />
        <label className="fld" style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-end" }}>
          <input type="checkbox" checked={includeValid} onChange={(e) => setIncludeValid(e.target.checked)} /> include valid
        </label>
      </div>}>
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <DataTable
          id="insights.certificates"
          columns={columns}
          rows={data.certificates}
          rowKey={(r, i) => `${r.cluster}/${r.namespace}/${r.name}/${i}`}
          initialSort={{ key: "days_left", dir: "asc" }}
          empty="No certificates expiring within the window."
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function PodIssues({ nav, clusterNames }) {
  const [cls, setCls] = useState("");
  const [cluster, setCluster] = useState("");
  const { data, error, loading } = useFetch(() => api.podIssues({ class: cls, cluster }), [cls, cluster]);

  const columns = [
    { key: "class", label: "Class", render: (i) => <span className="tag">{i.class}</span> },
    clusterColumn(nav, { sortValue: (i) => `${i.cluster}/${i.namespace}` }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    { key: "name", label: "Pod", filter: "text" },
    { key: "reason", label: "Reason", filter: "select", render: (i) => <span className="chip critical">{i.reason}</span> },
    { key: "owner", label: "Owner", className: "muted", filter: "text", render: (i) => i.owner || "—" },
    { key: "restarts", label: "Restarts" },
    { key: "containers_ready", label: "Ready" },
    { key: "message", label: "Message", className: "muted wrap", filter: "text" },
    { key: "started_at", label: "Since", className: "muted", render: (i) => fmtAge(i.started_at) },
  ];

  return (
    <Card title={`Pod issues${data ? ` (${data.count})` : ""}`}
      desc={data ? Object.entries(data.by_reason).map(([k, v]) => `${v} ${k}`).join(" · ") || "Nothing wrong." : ""}
      right={<div className="filters" style={{ margin: 0 }}>
        <SubTabs tabs={[["", "All"], ["platform", "Platform"], ["application", "Apps"]]} value={cls} onChange={setCls} />
        <FilterSelect label="Cluster" value={cluster} options={clusterNames} onChange={setCluster} />
      </div>}>
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <DataTable
          id="insights.podIssues"
          columns={columns}
          rows={data.pod_issues}
          rowKey={(i, k) => `${i.cluster}/${i.namespace}/${i.name}/${k}`}
          initialSort={{ key: "cluster", dir: "asc" }}
          empty="No problem pods anywhere."
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Quotas({ nav }) {
  const { data, error, loading } = useFetch(() => api.quotas(), []);

  const columns = [
    {
      key: "status", label: "Status", filter: "select",
      sortValue: (q) => statusRank(q.status),
      render: (q) => <span className={`chip ${q.status}`}>{q.status}</span>,
    },
    { key: "max_percent", label: "Peak", render: (q) => `${q.max_percent?.toFixed(0)}%` },
    clusterColumn(nav, { filter: "text" }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    { key: "name", label: "Quota", filter: "text" },
    {
      key: "resources", label: "Usage", className: "wrap",
      sortValue: (q) => q.resources.length,
      filterValue: (q) => q.resources.map((r) => r.resource).join(" "),
      render: (q) => (
        <div className="env-list">
          {q.resources.map((r) => (
            <span key={r.resource}>
              <span className="mono">{r.resource}</span>{" "}
              <span className={r.percent >= 90 ? "" : "src"} style={r.percent >= 90 ? { color: "var(--warning)" } : {}}>
                {r.used} / {r.hard} ({r.percent}%)
              </span>
            </span>
          ))}
        </div>
      ),
    },
  ];

  return (
    <Card title={`Resource quotas${data ? ` (${data.count})` : ""}`} desc="Hard vs used per resource, worst first.">
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <DataTable
          id="insights.quotas"
          columns={columns}
          rows={data.quotas}
          rowKey={(q, i) => `${q.cluster}/${q.namespace}/${q.name}/${i}`}
          initialSort={{ key: "max_percent", dir: "desc" }}
          empty="No quotas collected."
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Olm({ nav }) {
  const { data, error, loading } = useFetch(() => api.olmOperators(), []);
  const [open, setOpen] = useState(null);

  const installColumns = [
    clusterColumn(nav, { filter: "text" }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    { key: "csv", label: "CSV", className: "mono", filter: "text" },
    { key: "version", label: "Version", className: "mono", filter: "select" },
    {
      key: "phase", label: "Phase", filter: "select",
      filterValue: (i) => i.phase || "unknown",
      render: (i) => (
        <span className={`chip ${(i.phase || "unknown").toLowerCase()}`}>
          {i.phase}{i.reason && i.unhealthy ? ` · ${i.reason}` : ""}
        </span>
      ),
    },
    { key: "upgrade_to", label: "Upgrade to", className: "mono", render: (i) => i.upgrade_to || <span className="muted">—</span> },
  ];

  const columns = [
    {
      key: "package", label: "Package", filter: "text",
      filterValue: (o) => `${o.display_name} ${o.package}`,
      render: (o) => <>{o.display_name} <span className="muted mono">{o.package}</span></>,
    },
    { key: "provider", label: "Provider", className: "muted", filter: "select" },
    { key: "clusters", label: "Clusters" },
    {
      key: "versions", label: "Versions in fleet", className: "mono", filter: "text",
      sortValue: (o) => o.distinct,
      filterValue: (o) => o.versions.map((v) => v.version).join(", "),
      render: (o) => o.versions.map((v) => `${v.version} (${v.count})`).join(", "),
    },
    {
      key: "distinct", label: "Drift",
      render: (o) => (o.distinct > 1 ? <Pill status="warning" /> : <Pill status="healthy" />),
    },
    {
      key: "unhealthy", label: "Unhealthy",
      render: (o) => (o.unhealthy ? <span style={{ color: "var(--critical)" }}>{o.unhealthy}</span> : <span className="muted">0</span>),
    },
    {
      key: "upgrades_pending", label: "Upgrades pending",
      render: (o) => (o.upgrades_pending ? <span style={{ color: "var(--warning)" }}>{o.upgrades_pending}</span> : <span className="muted">0</span>),
    },
    {
      key: "blast", label: "",
      render: (o) => (
        <span className="link" onClick={(e) => { e.stopPropagation(); nav.goBlast({ olm_operator: o.package }); }}>blast radius →</span>
      ),
    },
  ];

  return (
    <Card title={`OLM operators${data ? ` (${data.operators.length} packages)` : ""}`}
      desc="ClusterServiceVersions across the fleet: version drift per package, install phase, pending upgrades from Subscriptions. Click a package for per-cluster detail.">
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <DataTable
          id="insights.olm"
          columns={columns}
          rows={data.operators}
          rowKey="package"
          onRowClick={(o) => setOpen(open === o.package ? null : o.package)}
          expanded={(o) => (open === o.package ? (
            <DataTable
              id="insights.olm.installs"
              columns={installColumns}
              rows={o.installs}
              rowKey={(i) => i.cluster + i.csv}
              initialSort={{ key: "cluster", dir: "asc" }}
              empty="No installs."
              dense
            />
          ) : null)}
          initialSort={{ key: "package", dir: "asc" }}
          empty="No OLM operators collected (no OLM on any cluster?)."
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Mcp({ nav }) {
  const { data, error, loading } = useFetch(() => api.machineConfigPools(), []);

  const columns = [
    {
      key: "status", label: "Status", filter: "select",
      sortValue: (p) => statusRank(p.status),
      render: (p) => <span className={`chip ${p.status}`}>{p.status}</span>,
    },
    clusterColumn(nav, { filter: "text", sortValue: (p) => `${p.cluster}/${p.pool}` }),
    { key: "environment", label: "Env", filter: "select", render: (p) => <span className="tag">{p.environment}</span> },
    { key: "pool", label: "Pool", filter: "select" },
    { key: "machine_count", label: "Machines" },
    { key: "updated", label: "Updated" },
    { key: "ready", label: "Ready" },
    { key: "unavailable", label: "Unavailable" },
    { key: "degraded", label: "Degraded" },
    { key: "current_config", label: "Config", className: "mono muted", filter: "text" },
    { key: "message", label: "Message", className: "muted wrap", filter: "text" },
  ];

  return (
    <Card title={`Machine config pools${data ? ` (${data.count})` : ""}`}
      desc="Node-level config rollout state per pool, degraded and updating first. The patching signal for OS / kubelet changes.">
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <DataTable
          id="insights.mcp"
          columns={columns}
          rows={data.pools}
          rowKey={(p, i) => `${p.cluster}/${p.pool}/${i}`}
          initialSort={{ key: "status", dir: "asc" }}
          empty="No machine config pools collected."
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Storage({ nav }) {
  const { data, error, loading } = useFetch(() => api.storage(), []);
  if (error) return <ErrorBanner error={error} />;
  if (loading && !data) return <Loading />;

  const classColumns = [
    {
      key: "name", label: "Class", className: "mono", filter: "text",
      render: (s) => <>{s.name} {s.default && <span className="tag">default</span>}</>,
    },
    {
      key: "provisioners", label: "Provisioner", className: "mono muted", filter: "select",
      filterValue: (s) => s.provisioners.join(", "),
      render: (s) => s.provisioners.join(", ") || "—",
    },
    { key: "clusters", label: "Clusters", sortValue: (s) => s.clusters.length, filterValue: (s) => s.clusters.join(", "), render: (s) => s.clusters.length },
    { key: "pvcs", label: "PVCs" },
    { key: "bound", label: "Bound" },
    { key: "pending", label: "Pending", render: (s) => (s.pending ? <span style={{ color: "var(--warning)" }}>{s.pending}</span> : 0) },
    { key: "requested_bytes", label: "Requested", render: (s) => fmtBytes(s.requested_bytes) },
  ];

  const pvcColumns = [
    {
      key: "status", label: "Status", filter: "select",
      sortValue: (p) => statusRank(p.status),
      render: (p) => <span className={`chip ${p.status}`}>{p.status}</span>,
    },
    clusterColumn(nav, { filter: "text" }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    { key: "name", label: "Claim", filter: "text" },
    { key: "storage_class", label: "Class", className: "mono muted", filter: "select" },
    { key: "requested_bytes", label: "Requested", render: (p) => fmtBytes(p.requested_bytes) },
    { key: "capacity_bytes", label: "Bound", render: (p) => fmtBytes(p.capacity_bytes) },
    { key: "volume", label: "Volume", className: "mono muted", filter: "text", render: (p) => p.volume || "—" },
    {
      key: "mounted_by", label: "Mounted by", className: "muted wrap", filter: "text",
      sortValue: (p) => p.mounted_by.length,
      filterValue: (p) => p.mounted_by.join(", "),
      render: (p) => p.mounted_by.join(", ") || <i>not mounted</i>,
    },
  ];

  return (
    <div className="grid" style={{ gap: 16 }}>
      <Card title="Storage classes" desc="Provisioner per class, and the claims riding on it - the storage blast radius.">
        <DataTable
          id="insights.storageClasses"
          columns={classColumns}
          rows={data.storage_classes}
          rowKey="name"
          initialSort={{ key: "name", dir: "asc" }}
          empty="No storage classes collected."
        />
      </Card>
      <Card title={`Persistent volume claims (${data.pvcs.length})`} desc="Pending first. Mounted-by comes from pod volumes.">
        <DataTable
          id="insights.pvcs"
          columns={pvcColumns}
          rows={data.pvcs}
          rowKey={(p, i) => `${p.cluster}/${p.namespace}/${p.name}/${i}`}
          initialSort={{ key: "status", dir: "asc" }}
          empty="No persistent volume claims collected."
          scroll
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Routes({ nav }) {
  const [host, setHost] = useState("");
  const { data, error, loading } = useFetch(() => api.routes({ host }), [host]);

  const columns = [
    { key: "host", label: "Host", className: "mono", sortValue: (r) => `${r.host}${r.path || ""}`, render: (r) => `${r.host}${r.path || ""}` },
    clusterColumn(nav, { filter: "text" }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    { key: "name", label: "Route", filter: "text" },
    {
      key: "service", label: "Service", filter: "text",
      filterValue: (r) => `${r.service}${r.port ? `:${r.port}` : ""}`,
      render: (r) => `${r.service}${r.port ? `:${r.port}` : ""}`,
    },
    {
      key: "tls_termination", label: "TLS", className: "muted", filter: "select",
      filterValue: (r) => r.tls_termination || "none",
      render: (r) => `${r.tls_termination || "none"}${r.insecure_policy ? ` · ${r.insecure_policy}` : ""}`,
    },
    {
      key: "status", label: "Status", filter: "select",
      sortValue: (r) => statusRank(r.status),
      render: (r) => <span className={`chip ${r.status}`}>{r.status}</span>,
    },
    {
      key: "routers", label: "Router", className: "muted", filter: "select",
      filterValue: (r) => (r.routers || []).join(", "),
      render: (r) => (r.routers || []).join(", "),
    },
  ];

  return (
    <Card title={`Routes${data ? ` (${data.count})` : ""}`} desc="Which cluster and namespace serves a hostname."
      right={<input type="text" className="search" placeholder="filter by host…" value={host} onChange={(e) => setHost(e.target.value)} />}>
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <DataTable
          id="insights.routes"
          columns={columns}
          rows={data.routes}
          rowKey={(r, i) => `${r.cluster}/${r.namespace}/${r.name}/${i}`}
          initialSort={{ key: "host", dir: "asc" }}
          empty="No routes match."
          scroll
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Events({ nav, clusterNames }) {
  const [cluster, setCluster] = useState("");
  const [cls, setCls] = useState("");
  const { data, error, loading } = useFetch(() => api.events({ cluster, class: cls, limit: 300 }), [cluster, cls]);

  const columns = [
    {
      key: "last_at", label: "When", className: "muted nowrap",
      filterValue: (e) => fmtAge(e.last_at),
      render: (e) => `${fmtAge(e.last_at)} ago`,
    },
    clusterColumn(nav),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    {
      key: "object", label: "Object", filter: "text",
      sortValue: (e) => `${e.involved.kind}/${e.involved.name}`,
      filterValue: (e) => `${e.involved.kind}/${e.involved.name}`,
      render: (e) => `${e.involved.kind}/${e.involved.name}`,
    },
    { key: "reason", label: "Reason", filter: "select", render: (e) => <span className="chip warning">{e.reason}</span> },
    { key: "count", label: "Count" },
    { key: "source", label: "Source", className: "muted", filter: "select" },
    { key: "message", label: "Message", className: "muted wrap", filter: "text" },
  ];

  return (
    <Card title={`Warning events${data ? ` (${data.count})` : ""}`}
      desc={data ? Object.entries(data.by_reason).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${v} ${k}`).join(" · ") : ""}
      right={<div className="filters" style={{ margin: 0 }}>
        <SubTabs tabs={[["", "All"], ["platform", "Platform"], ["application", "Apps"]]} value={cls} onChange={setCls} />
        <FilterSelect label="Cluster" value={cluster} options={clusterNames} onChange={setCluster} />
      </div>}>
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <DataTable
          id="insights.events"
          columns={columns}
          rows={data.events}
          rowKey={(e, i) => `${e.cluster}/${e.namespace}/${e.name}/${i}`}
          initialSort={{ key: "last_at", dir: "desc" }}
          empty="No warning events."
          scroll
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Images({ nav }) {
  const [image, setImage] = useState("");
  const [groupBy, setGroupBy] = useState("image");
  const { data, error, loading } = useFetch(() => api.images({ image, group_by: groupBy }), [image, groupBy]);
  const [open, setOpen] = useState(null);

  const workloadColumns = [
    clusterColumn(nav, { filter: "text" }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    {
      key: "workload", label: "Workload", filter: "text",
      sortValue: (w) => `${w.kind}/${w.name}`,
      filterValue: (w) => `${w.kind}/${w.name}`,
      render: (w) => `${w.kind}/${w.name}`,
    },
    { key: "container", label: "Container", className: "muted", filter: "select" },
    { key: "image", label: "Image", className: "mono", filter: "text" },
  ];

  const columns = [
    { key: groupBy, label: groupBy, className: "mono" },
    { key: "cluster_count", label: "Clusters" },
    { key: "workload_count", label: "Workloads" },
    {
      key: "blast", label: "",
      render: (g) => (groupBy === "image"
        ? <span className="link" onClick={(e) => { e.stopPropagation(); nav.goBlast({ image: g.image }); }}>blast radius →</span>
        : null),
    },
  ];

  return (
    <Card title={`Images${data ? ` (${data.count})` : ""}`} desc="Which workloads run which images - the input to a CVE blast radius."
      right={<div className="filters" style={{ margin: 0 }}>
        <SubTabs tabs={[["image", "Image"], ["repository", "Repository"], ["registry", "Registry"]]} value={groupBy} onChange={setGroupBy} />
        <input type="text" className="search" placeholder="filter images…" value={image} onChange={(e) => setImage(e.target.value)} />
      </div>}>
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <DataTable
          id={`insights.images.${groupBy}`}
          columns={columns}
          rows={data.images}
          rowKey={(g) => g[groupBy]}
          onRowClick={(g) => setOpen(open === g[groupBy] ? null : g[groupBy])}
          expanded={(g) => (open === g[groupBy] ? (
            <DataTable
              id="insights.images.workloads"
              columns={workloadColumns}
              rows={g.workloads}
              rowKey={(w, i) => `${w.cluster}/${w.namespace}/${w.kind}/${w.name}/${i}`}
              initialSort={{ key: "cluster", dir: "asc" }}
              empty="No workloads."
              dense
            />
          ) : null)}
          initialSort={{ key: "workload_count", dir: "desc" }}
          empty="No images match."
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function References({ nav }) {
  const [kind, setKind] = useState("Secret");
  const [name, setName] = useState("");
  const { data, error, loading } = useFetch(() => api.references({ kind, name }), [kind, name]);

  const columns = [
    clusterColumn(nav, { filter: "text" }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    { key: "name", label: kind },
    {
      key: "workloads", label: "Referenced by", className: "wrap",
      sortValue: (r) => r.workloads.length,
      filterValue: (r) => r.workloads.map((w) => `${w.kind}/${w.name}`).join(", "),
      render: (r) => (
        <div className="env-list">
          {r.workloads.map((w, k) => <span key={k}>{w.kind}/{w.name} <span className="src">via {w.via}</span></span>)}
        </div>
      ),
    },
  ];

  return (
    <Card title={`Config references${data ? ` (${data.count})` : ""}`}
      desc="Which workloads reference a Secret / ConfigMap / PVC / ServiceAccount - the blast radius of rotating a secret or changing a config map."
      right={<div className="filters" style={{ margin: 0 }}>
        <SubTabs tabs={[["Secret", "Secrets"], ["ConfigMap", "ConfigMaps"], ["PersistentVolumeClaim", "PVCs"], ["ServiceAccount", "Service accounts"]]} value={kind} onChange={setKind} />
        <input type="text" className="search" placeholder="exact name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
      </div>}>
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <DataTable
          id="insights.references"
          columns={columns}
          rows={data.references}
          rowKey={(r, i) => `${r.cluster}/${r.namespace}/${r.name}/${i}`}
          initialSort={{ key: "cluster", dir: "asc" }}
          empty="No references."
          scroll
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Access({ nav }) {
  const { data, error, loading } = useFetch(() => api.clusterAdmins(), []);

  const columns = [
    { key: "kind", label: "Kind", className: "muted", filter: "select" },
    {
      key: "name", label: "Subject", className: "mono", filter: "text",
      render: (s) => <>{s.name}{s.namespace ? <span className="muted"> ({s.namespace})</span> : ""}</>,
    },
    { key: "role", label: "Role", className: "mono", filter: "select" },
    {
      key: "cluster_count", label: "Clusters",
      filterValue: (s) => s.clusters.join(", "),
      render: (s) => (
        <>
          {s.cluster_count}{" "}
          <span className="muted">· {s.clusters.map((c) => (
            <span key={c} className="link" style={{ marginRight: 6 }} onClick={() => nav.openCluster(c)}>{c}</span>
          ))}</span>
        </>
      ),
    },
    {
      key: "bindings", label: "Bindings", className: "muted", filter: "text",
      filterValue: (s) => s.bindings.join(", "),
      render: (s) => s.bindings.join(", "),
    },
  ];

  return (
    <Card title={`Cluster admins${data ? ` (${data.count} subjects)` : ""}`}
      desc="Subjects of ClusterRoleBindings to cluster-admin, with the clusters each holds it on.">
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <DataTable
          id="insights.access"
          columns={columns}
          rows={data.subjects}
          rowKey={(s, i) => `${s.kind}/${s.name}/${i}`}
          initialSort={{ key: "name", dir: "asc" }}
          empty="No cluster-admin bindings collected."
        />
      )}
    </Card>
  );
}
