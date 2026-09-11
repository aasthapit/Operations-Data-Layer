import { useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import {
  Pill, Loading, ErrorBanner, Sparkline, Dot, SubTabs, UsageBar, Tier, Empty, FilterSelect,
  fmtBytes, fmtCores, fmtPct, fmtTime, fmtAge, fmtDays,
} from "../components";

const SECTIONS = [
  ["overview", "Overview"], ["namespaces", "Namespaces"], ["workloads", "Workloads"], ["nodes", "Nodes"],
  ["issues", "Issues"], ["operators", "Operators"], ["resources", "Resources"],
];

export default function ClusterDetail({ name, onBack, nav }) {
  const [section, setSection] = useState("overview");
  const { data: c, error, loading } = useFetch(() => api.cluster(name), [name]);

  if (loading && !c) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const counts = {
    namespaces: c.namespaces.application + c.namespaces.platform,
    workloads: c.workloads,
    nodes: c.nodes.total,
    issues: c.pod_issues,
    operators: c.operators.length,
  };

  return (
    <div>
      <span className="back" onClick={onBack}>← All clusters</span>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <h2 className="mono" style={{ margin: 0 }}>{c.name}</h2>
          <Pill status={c.overall_status} />
          {c.upgrading && <span className="tag">upgrading → {c.desired_version} ({c.upgrade_percent}%)</span>}
          {!c.reachable && <span className="tag critical">unreachable</span>}
        </div>
        <SubTabs tabs={SECTIONS.map(([k, l]) => [k, l, counts[k]])} value={section} onChange={setSection} />
      </div>
      {c.last_error && <div className="banner">{c.last_error}</div>}

      {section === "overview" && <OverviewSection c={c} nav={nav} />}
      {section === "namespaces" && <NamespacesSection c={c} nav={nav} />}
      {section === "workloads" && <WorkloadsSection name={c.name} />}
      {section === "nodes" && <NodesSection c={c} />}
      {section === "issues" && <IssuesSection c={c} />}
      {section === "operators" && <OperatorsSection c={c} nav={nav} />}
      {section === "resources" && <ResourcesSection c={c} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function OverviewSection({ c, nav }) {
  const tl = useFetch(() => api.timeline(c.name), [c.name]);
  const snaps = tl.data?.snapshots || [];
  const scores = snaps.map((s) => s.health_score);
  const cpuPct = snaps.map((s) => (s.cpu_used_cores != null && s.cpu_allocatable_cores ? 100 * s.cpu_used_cores / s.cpu_allocatable_cores : null));
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
          <div className="row" style={{ gap: 24 }}>
            <div>
              <div className="dim" style={{ fontSize: 12 }}>Health score</div>
              <Sparkline points={scores} width={220} height={50} />
            </div>
            <div>
              <div className="dim" style={{ fontSize: 12 }}>CPU % of allocatable</div>
              <Sparkline points={cpuPct} width={220} height={50} color="var(--warning)" />
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{snaps.length} sweeps</div>
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

function CapacityRow({ label, used, req, alloc, pct, reqPct, fmt }) {
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
function NamespacesSection({ c, nav }) {
  const apps = c.namespaces_detail.filter((n) => n.class === "application");
  const platform = c.namespaces_detail.filter((n) => n.class === "platform");
  return (
    <div className="grid" style={{ gap: 16 }}>
      <NamespaceTable title={`Applications (${apps.length})`} rows={apps} showOwner nav={nav}
        desc="Every non-platform namespace is an application. Ownership comes from labels on the namespace, then its workloads." />
      <NamespaceTable title={`OpenShift platform namespaces (${platform.length})`} rows={platform} nav={nav}
        desc="The cluster's own namespaces, grouped separately (openshift-*, kube-*, default…)." />
    </div>
  );
}

function NamespaceTable({ title, rows, showOwner, desc, nav }) {
  return (
    <div className="card flush">
      <div className="card-head"><h3>{title}</h3><div className="desc">{desc}</div></div>
      <table>
        <thead>
          <tr>
            <th>Namespace</th>{showOwner && <><th>App</th><th>Team</th><th>Tier</th></>}<th>Status</th>
            <th>Workloads</th><th>Replicas</th><th>Pods</th><th>Restarts</th><th>Issues</th>
            <th>CPU used / req</th><th>Memory used / req</th><th>Resources</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr key={n.name} className={showOwner ? "clickable" : ""} onClick={() => showOwner && nav.openApp(n.app)}>
              <td className="mono">{n.name}</td>
              {showOwner && <><td>{n.app}</td><td className="muted">{n.team || "—"}</td><td><Tier tier={n.tier} /></td></>}
              <td><Pill status={n.status} /></td>
              <td>{n.workloads}</td>
              <td>{n.replicas_ready}/{n.replicas_desired}</td>
              <td>{n.pods.running}<span className="muted">/{n.pods.total}</span>{n.pods.pending ? <span style={{ color: "var(--warning)" }}> +{n.pods.pending} pending</span> : null}</td>
              <td>{n.pods.restarts || <span className="muted">0</span>}</td>
              <td>{n.pods.issues ? <span style={{ color: "var(--warning)" }}>{n.pods.issues}</span> : <span className="muted">0</span>}</td>
              <td className="nowrap">{fmtCores(n.cpu.used_cores)} <span className="muted">/ {fmtCores(n.cpu.requests_cores)}</span></td>
              <td className="nowrap">{fmtBytes(n.memory.used_bytes)} <span className="muted">/ {fmtBytes(n.memory.requests_bytes)}</span></td>
              <td className="muted" style={{ fontSize: 11.5 }}>{Object.entries(n.resource_counts).map(([k, v]) => `${v} ${k}`).join(" · ") || "—"}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={13} className="empty">None.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
function WorkloadsSection({ name }) {
  const [cls, setCls] = useState("");
  const [ns, setNs] = useState("");
  const [open, setOpen] = useState(null);
  const { data, error, loading } = useFetch(() => api.clusterWorkloads(name, { class: cls, namespace: ns, detail: true }), [name, cls, ns]);
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
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <table>
          <thead><tr><th>Namespace</th><th>Kind</th><th>Name</th><th>Status</th><th>Replicas</th><th>Images</th><th>Config refs</th><th>SA</th><th>Age</th></tr></thead>
          <tbody>
            {data.workloads.map((w) => {
              const key = `${w.namespace}/${w.kind}/${w.name}`;
              return [
                <tr key={key} className="clickable" onClick={() => setOpen(open === key ? null : key)}>
                  <td className="mono">{w.namespace}</td>
                  <td className="muted">{w.kind}</td>
                  <td>{w.name}</td>
                  <td><span className={`chip ${w.status}`}>{w.status}</span></td>
                  <td>{w.replicas.ready}/{w.replicas.desired}{w.replicas.updated < w.replicas.desired && <span className="muted"> · {w.replicas.updated} updated</span>}</td>
                  <td className="mono wrap">{w.images.join(", ")}</td>
                  <td className="muted">{w.config_refs.length}</td>
                  <td className="muted">{w.service_account}</td>
                  <td className="muted">{fmtAge(w.created_at)}</td>
                </tr>,
                open === key && (
                  <tr key={key + "-d"}>
                    <td colSpan={9} style={{ background: "var(--bg)" }}>
                      <WorkloadDetail w={w} />
                    </td>
                  </tr>
                ),
              ];
            })}
            {data.workloads.length === 0 && <tr><td colSpan={9} className="empty">No workloads.</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
}

function WorkloadDetail({ w }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16, padding: "6px 4px" }}>
      {w.containers.map((c) => (
        <div key={c.name} className="card" style={{ padding: 12 }}>
          <h3 style={{ marginBottom: 8 }}>container {c.name}</h3>
          <div className="kv" style={{ fontSize: 12.5 }}>
            <span className="k">Image</span><span className="mono">{c.image}</span>
            <span className="k">Requests</span><span className="mono">{Object.entries(c.requests).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}</span>
            <span className="k">Limits</span><span className="mono">{Object.entries(c.limits).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}</span>
            <span className="k">Env</span>
            <span className="env-list">
              {c.env.length === 0 && <span className="muted">none</span>}
              {c.env.map((e) => (
                <span key={e.name}><span className="mono">{e.name}</span> <span className="src">
                  {e.from?.kind === "literal" ? "= (value scrubbed)"
                    : e.from?.kind === "field" ? `← field ${e.from.path}`
                    : e.from?.kind ? `← ${e.from.kind} ${e.from.name}${e.from.key ? `/${e.from.key}` : ""}` : ""}
                </span></span>
              ))}
              {c.env_from.map((e, i) => <span key={i}><span className="src">envFrom ← {e.kind} {e.name}</span></span>)}
            </span>
          </div>
        </div>
      ))}
      <div className="card" style={{ padding: 12 }}>
        <h3 style={{ marginBottom: 8 }}>References</h3>
        <div className="env-list">
          {w.config_refs.map((r, i) => <span key={i}><span className="muted">{r.kind}</span> <span className="mono">{r.name}</span> <span className="src">via {r.via}</span></span>)}
          {w.config_refs.length === 0 && <span className="muted">none</span>}
        </div>
        <div className="kv" style={{ fontSize: 12.5, marginTop: 10 }}>
          <span className="k">Labels</span><span className="mono wrap">{Object.entries(w.labels).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}</span>
          <span className="k">Strategy</span><span>{w.strategy || "—"}</span>
          <span className="k">Node selector</span><span className="mono">{Object.entries(w.node_selector).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function NodesSection({ c }) {
  return (
    <div className="card flush">
      <div className="card-head"><h3>Nodes ({c.nodes_detail.length})</h3></div>
      <table>
        <thead><tr><th>Node</th><th>Roles</th><th>State</th><th>CPU used / alloc</th><th>Memory used / alloc</th><th>Pods</th><th>Kubelet</th><th>OS</th><th>Runtime</th><th>Zone / type</th><th>Images</th><th>Age</th></tr></thead>
        <tbody>
          {c.nodes_detail.map((n) => {
            const pressure = Object.entries(n.conditions).filter(([, v]) => v).map(([k]) => k);
            return (
              <tr key={n.name}>
                <td className="mono">{n.name}</td>
                <td>{n.roles.map((r) => <span key={r} className="tag" style={{ marginRight: 4 }}>{r}</span>)}</td>
                <td>
                  <Pill status={!n.ready ? "critical" : pressure.length || !n.schedulable ? "warning" : "healthy"} />
                  {!n.schedulable && <span className="muted"> cordoned</span>}
                  {pressure.length > 0 && <span className="muted"> {pressure.join(", ")}</span>}
                </td>
                <td><UsageBar percent={n.cpu.used_percent} width={70} /> <span className="muted">{n.cpu.used_cores != null ? n.cpu.used_cores.toFixed(2) : "—"} / {n.cpu.allocatable_cores}</span></td>
                <td><UsageBar percent={n.memory.used_percent} width={70} /> <span className="muted">{fmtBytes(n.memory.used_bytes)} / {fmtBytes(n.memory.allocatable_bytes)}</span></td>
                <td>{n.pods.running}<span className="muted">/{n.pods.capacity}</span></td>
                <td className="mono">{n.kubelet_version}</td>
                <td className="muted wrap">{n.os_image}</td>
                <td className="mono">{n.container_runtime}</td>
                <td className="muted">{[n.zone, n.instance_type].filter(Boolean).join(" · ") || "—"}</td>
                <td className="muted">{n.images.count} · {fmtBytes(n.images.bytes)}</td>
                <td className="muted">{fmtAge(n.created_at)}</td>
              </tr>
            );
          })}
          {c.nodes_detail.length === 0 && <tr><td colSpan={12} className="empty">No nodes collected.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
function IssuesSection({ c }) {
  const ev = useFetch(() => api.events({ cluster: c.name, limit: 50 }), [c.name]);
  const certs = useFetch(() => api.certificates({ cluster: c.name }), [c.name]);
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card flush">
        <div className="card-head"><h3>Pod issues ({c.pod_issues_detail.length})</h3></div>
        <table>
          <thead><tr><th>Class</th><th>Namespace</th><th>Pod</th><th>Reason</th><th>Owner</th><th>Node</th><th>Restarts</th><th>Ready</th><th>Message</th><th>Since</th></tr></thead>
          <tbody>
            {c.pod_issues_detail.map((i) => (
              <tr key={i.namespace + i.name}>
                <td><span className="tag">{i.class}</span></td>
                <td className="mono">{i.namespace}</td>
                <td>{i.name}</td>
                <td><span className="chip critical">{i.reason}</span></td>
                <td className="muted">{i.owner || "—"}</td>
                <td className="muted">{i.node || "—"}</td>
                <td>{i.restarts}</td>
                <td>{i.containers_ready}</td>
                <td className="muted wrap">{i.message}</td>
                <td className="muted">{fmtAge(i.started_at)}</td>
              </tr>
            ))}
            {c.pod_issues_detail.length === 0 && <tr><td colSpan={10} className="empty">No problem pods.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card flush">
        <div className="card-head"><h3>Certificates expiring ({certs.data?.count ?? "…"})</h3></div>
        {certs.data && (
          <table>
            <thead><tr><th>Namespace</th><th>Kind</th><th>Name</th><th>Status</th><th>Expires</th><th>Subject</th></tr></thead>
            <tbody>
              {certs.data.certificates.map((r) => (
                <tr key={r.namespace + r.name}>
                  <td className="mono">{r.namespace}</td><td className="muted">{r.kind}</td><td>{r.name}</td>
                  <td><span className={`chip ${r.status}`}>{r.status}</span></td>
                  <td>{fmtDays(r.days_left)} <span className="muted">· {fmtTime(r.expires_at)}</span></td>
                  <td className="mono muted">{r.certificates[0]?.subject}</td>
                </tr>
              ))}
              {certs.data.certificates.length === 0 && <tr><td colSpan={6} className="empty">Nothing expiring within the threshold.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <div className="card flush">
        <div className="card-head"><h3>Recent warning events</h3></div>
        {ev.error ? <ErrorBanner error={ev.error} /> : !ev.data ? <Loading /> : (
          <table>
            <thead><tr><th>When</th><th>Namespace</th><th>Object</th><th>Reason</th><th>Count</th><th>Message</th></tr></thead>
            <tbody>
              {ev.data.events.map((e) => (
                <tr key={e.name}>
                  <td className="muted nowrap">{fmtAge(e.last_at)} ago</td>
                  <td className="mono">{e.namespace}</td>
                  <td>{e.involved.kind}/{e.involved.name}</td>
                  <td><span className="chip warning">{e.reason}</span></td>
                  <td>{e.count}</td>
                  <td className="muted wrap">{e.message}</td>
                </tr>
              ))}
              {ev.data.events.length === 0 && <tr><td colSpan={6} className="empty">No warning events.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function OperatorsSection({ c, nav }) {
  return (
    <div className="card flush">
      <div className="card-head"><h3>Cluster operators ({c.operators.length})</h3></div>
      <table>
        <thead><tr><th>Operator</th><th>Version</th><th>State</th><th>Message</th><th></th></tr></thead>
        <tbody>
          {c.operators.map((o) => (
            <tr key={o.name}>
              <td>{o.name} {o.critical && <span className="tag critical">critical</span>}</td>
              <td className="mono">{o.version}</td>
              <td>{opState(o)}</td>
              <td className="muted wrap">{o.message}</td>
              <td><span className="link" onClick={() => nav.goBlast({ operator: o.name, operator_version: o.version })}>blast radius →</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function opState(o) {
  if (o.degraded) return <span style={{ color: "var(--critical)" }}>Degraded</span>;
  if (!o.available) return <span style={{ color: "var(--critical)" }}>Unavailable</span>;
  if (o.progressing) return <span style={{ color: "var(--warning)" }}>Progressing</span>;
  return <span style={{ color: "var(--healthy)" }}>Available</span>;
}

// ---------------------------------------------------------------------------
const RESOURCE_KINDS = ["routes", "services", "configmaps", "secrets", "persistentvolumeclaims", "resourcequotas",
  "networkpolicies", "horizontalpodautoscalers", "cronjobs", "ingresses", "clusterserviceversions", "subscriptions",
  "machineconfigpools", "storageclasses", "persistentvolumes", "clusterrolebindings", "events"];

function ResourcesSection({ c }) {
  const [kind, setKind] = useState("routes");
  const [ns, setNs] = useState("");
  const { data, error, loading } = useFetch(() => api.clusterResources(c.name, { kind, namespace: ns }), [c.name, kind, ns]);
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
        {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Namespace</th><th>Name</th><th>Status</th><th>Summary</th><th>Age</th></tr></thead>
              <tbody>
                {data.resources.map((r) => (
                  <tr key={(r.namespace || "") + r.name}>
                    <td className="mono">{r.namespace || <span className="muted">cluster</span>}</td>
                    <td>{r.name}</td>
                    <td>{r.status ? <span className={`chip ${r.status}`}>{r.status}</span> : <span className="muted">—</span>}</td>
                    <td className="muted wrap" style={{ fontSize: 12 }}>{summarize(r)}</td>
                    <td className="muted">{fmtAge(r.created_at)}</td>
                  </tr>
                ))}
                {data.resources.length === 0 && <tr><td colSpan={5}><Empty>Nothing collected for this kind.</Empty></td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function summarize(r) {
  const s = r.summary || {};
  switch (r.key) {
    case "routes": return `${s.host}${s.path || ""} → ${s.service} · tls ${s.tls_termination || "none"}`;
    case "services": return `${s.type} ${s.cluster_ip || ""} · ${(s.ports || []).map((p) => `${p.port}→${p.target}`).join(", ")}${s.load_balancer?.length ? " · lb " + s.load_balancer.join(",") : ""}`;
    case "configmaps":
    case "secrets": return `${s.type ? s.type + " · " : ""}${s.key_count} keys (${(s.keys || []).map((k) => k.key).join(", ")}) · ${fmtBytes(s.total_bytes)}${s.certificates ? ` · cert ${s.certificates[0].subject} exp ${fmtTime(s.certificates[0].not_after)}` : ""}`;
    case "persistentvolumeclaims": return `${s.storage_class || "(no class)"} · ${fmtBytes(s.requested_bytes)}${s.capacity_bytes ? ` (${fmtBytes(s.capacity_bytes)} bound)` : ""} · ${(s.access_modes || []).join(",")}${s.mounted_by?.length ? ` · mounted by ${s.mounted_by.join(", ")}` : " · not mounted"}`;
    case "persistentvolumes": return `${s.storage_class || ""} · ${fmtBytes(s.capacity_bytes)} · ${s.csi_driver || "in-tree"} · claim ${s.claim || "—"} · ${s.reclaim_policy}`;
    case "resourcequotas": return `${(s.resources || []).map((q) => `${q.resource} ${q.used}/${q.hard} (${q.percent}%)`).join(" · ")}`;
    case "networkpolicies": return `${(s.policy_types || []).join(",")} · ${s.ingress_rules} ingress / ${s.egress_rules} egress rules`;
    case "horizontalpodautoscalers": return `${s.target} · ${s.current_replicas ?? "?"} of ${s.min_replicas}-${s.max_replicas} · ${(s.metrics || []).map((m) => `${m.resource} ${m.target_percent ?? m.target_value}`).join(", ")}`;
    case "cronjobs": return `${s.schedule} · ${s.suspended ? "suspended" : "active"} · last ${s.last_schedule ? fmtTime(s.last_schedule) : "never"} · ${(s.images || []).join(", ")}`;
    case "ingresses": return `${(s.hosts || []).join(", ")} · class ${s.class || "—"}`;
    case "clusterserviceversions": return `${s.package} ${s.version} · ${s.phase}${s.reason ? ` (${s.reason})` : ""} · ${s.provider || ""}`;
    case "subscriptions": return `${s.package} · ${s.channel} · installed ${s.installed_csv}${s.upgrade_pending ? ` → ${s.current_csv}` : ""}`;
    case "machineconfigpools": return `${s.updated}/${s.machine_count} updated · ${s.ready} ready · ${s.degraded} degraded${s.paused ? " · paused" : ""}${s.message ? ` · ${s.message}` : ""}`;
    case "storageclasses": return `${s.provisioner} · ${s.binding_mode} · ${s.reclaim_policy}${s.default ? " · default" : ""}`;
    case "clusterrolebindings": return `${s.role} → ${(s.subjects || []).map((x) => `${x.kind}/${x.name}`).join(", ")}`;
    case "events": return `${s.reason}: ${s.involved?.kind}/${s.involved?.name} ×${s.count} · ${s.message}`;
    default: return JSON.stringify(s);
  }
}
