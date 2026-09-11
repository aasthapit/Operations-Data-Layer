import { useEffect, useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { Loading, ErrorBanner, SubTabs, Pill, FilterSelect, fmtBytes, fmtTime, fmtAge, fmtDays } from "../components";

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

const ClusterCell = ({ c, nav }) => <td className="mono link" onClick={() => nav.openCluster(c)}>{c}</td>;

// ---------------------------------------------------------------------------
function Certificates({ nav, clusterNames }) {
  const [includeValid, setIncludeValid] = useState(false);
  const [cluster, setCluster] = useState("");
  const { data, error, loading } = useFetch(() => api.certificates({ include_valid: includeValid, cluster }), [includeValid, cluster]);
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
        <table>
          <thead><tr><th>Status</th><th>Expires in</th><th>Cluster</th><th>Env</th><th>Namespace</th><th>Kind</th><th>Name</th><th>Subject</th><th>Issuer</th><th>Not after</th></tr></thead>
          <tbody>
            {data.certificates.map((r, i) => (
              <tr key={i}>
                <td><span className={`chip ${r.status}`}>{r.status}</span></td>
                <td style={{ color: r.days_left < 0 ? "var(--critical)" : r.days_left < 30 ? "var(--warning)" : undefined }}>{fmtDays(r.days_left)}</td>
                <ClusterCell c={r.cluster} nav={nav} />
                <td><span className="tag">{r.environment}</span></td>
                <td className="mono">{r.namespace} {r.class === "platform" && <span className="muted">(platform)</span>}</td>
                <td className="muted">{r.kind}{r.secret_type ? ` · ${r.secret_type}` : ""}</td>
                <td>{r.name}</td>
                <td className="mono muted wrap">{r.certificates[0]?.subject}</td>
                <td className="mono muted wrap">{r.certificates[0]?.issuer}</td>
                <td className="muted nowrap">{fmtTime(r.expires_at)}</td>
              </tr>
            ))}
            {data.certificates.length === 0 && <tr><td colSpan={10} className="empty">No certificates expiring within the window.</td></tr>}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function PodIssues({ nav, clusterNames }) {
  const [cls, setCls] = useState("");
  const [cluster, setCluster] = useState("");
  const { data, error, loading } = useFetch(() => api.podIssues({ class: cls, cluster }), [cls, cluster]);
  return (
    <Card title={`Pod issues${data ? ` (${data.count})` : ""}`}
      desc={data ? Object.entries(data.by_reason).map(([k, v]) => `${v} ${k}`).join(" · ") || "Nothing wrong." : ""}
      right={<div className="filters" style={{ margin: 0 }}>
        <SubTabs tabs={[["", "All"], ["platform", "Platform"], ["application", "Apps"]]} value={cls} onChange={setCls} />
        <FilterSelect label="Cluster" value={cluster} options={clusterNames} onChange={setCluster} />
      </div>}>
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <table>
          <thead><tr><th>Class</th><th>Cluster</th><th>Namespace</th><th>Pod</th><th>Reason</th><th>Owner</th><th>Restarts</th><th>Ready</th><th>Message</th><th>Since</th></tr></thead>
          <tbody>
            {data.pod_issues.map((i, k) => (
              <tr key={k}>
                <td><span className="tag">{i.class}</span></td>
                <ClusterCell c={i.cluster} nav={nav} />
                <td className="mono">{i.namespace}</td>
                <td>{i.name}</td>
                <td><span className="chip critical">{i.reason}</span></td>
                <td className="muted">{i.owner || "—"}</td>
                <td>{i.restarts}</td>
                <td>{i.containers_ready}</td>
                <td className="muted wrap">{i.message}</td>
                <td className="muted">{fmtAge(i.started_at)}</td>
              </tr>
            ))}
            {data.pod_issues.length === 0 && <tr><td colSpan={10} className="empty">No problem pods anywhere.</td></tr>}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Quotas({ nav }) {
  const { data, error, loading } = useFetch(() => api.quotas(), []);
  return (
    <Card title={`Resource quotas${data ? ` (${data.count})` : ""}`} desc="Hard vs used per resource, worst first.">
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <table>
          <thead><tr><th>Status</th><th>Peak</th><th>Cluster</th><th>Namespace</th><th>Quota</th><th>Usage</th></tr></thead>
          <tbody>
            {data.quotas.map((q, i) => (
              <tr key={i}>
                <td><span className={`chip ${q.status}`}>{q.status}</span></td>
                <td>{q.max_percent?.toFixed(0)}%</td>
                <ClusterCell c={q.cluster} nav={nav} />
                <td className="mono">{q.namespace}</td>
                <td>{q.name}</td>
                <td className="wrap">
                  <div className="env-list">
                    {q.resources.map((r) => (
                      <span key={r.resource}><span className="mono">{r.resource}</span> <span className={r.percent >= 90 ? "" : "src"} style={r.percent >= 90 ? { color: "var(--warning)" } : {}}>{r.used} / {r.hard} ({r.percent}%)</span></span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
            {data.quotas.length === 0 && <tr><td colSpan={6} className="empty">No quotas collected.</td></tr>}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Olm({ nav }) {
  const { data, error, loading } = useFetch(() => api.olmOperators(), []);
  const [open, setOpen] = useState(null);
  return (
    <Card title={`OLM operators${data ? ` (${data.operators.length} packages)` : ""}`}
      desc="ClusterServiceVersions across the fleet: version drift per package, install phase, pending upgrades from Subscriptions. Click a package for per-cluster detail.">
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <table>
          <thead><tr><th>Package</th><th>Provider</th><th>Clusters</th><th>Versions in fleet</th><th>Drift</th><th>Unhealthy</th><th>Upgrades pending</th><th></th></tr></thead>
          <tbody>
            {data.operators.map((o) => [
              <tr key={o.package} className="clickable" onClick={() => setOpen(open === o.package ? null : o.package)}>
                <td>{o.display_name} <span className="muted mono">{o.package}</span></td>
                <td className="muted">{o.provider}</td>
                <td>{o.clusters}</td>
                <td className="mono">{o.versions.map((v) => `${v.version} (${v.count})`).join(", ")}</td>
                <td>{o.distinct > 1 ? <Pill status="warning" /> : <Pill status="healthy" />}</td>
                <td>{o.unhealthy ? <span style={{ color: "var(--critical)" }}>{o.unhealthy}</span> : <span className="muted">0</span>}</td>
                <td>{o.upgrades_pending ? <span style={{ color: "var(--warning)" }}>{o.upgrades_pending}</span> : <span className="muted">0</span>}</td>
                <td><span className="link" onClick={(e) => { e.stopPropagation(); nav.goBlast({ olm_operator: o.package }); }}>blast radius →</span></td>
              </tr>,
              open === o.package && (
                <tr key={o.package + "-d"}><td colSpan={8} style={{ background: "var(--bg)" }}>
                  <table className="mini-table">
                    <thead><tr><th>Cluster</th><th>Namespace</th><th>CSV</th><th>Version</th><th>Phase</th><th>Upgrade to</th></tr></thead>
                    <tbody>
                      {o.installs.map((i) => (
                        <tr key={i.cluster + i.csv}>
                          <ClusterCell c={i.cluster} nav={nav} />
                          <td className="mono">{i.namespace}</td><td className="mono">{i.csv}</td><td className="mono">{i.version}</td>
                          <td><span className={`chip ${(i.phase || "unknown").toLowerCase()}`}>{i.phase}{i.reason && i.unhealthy ? ` · ${i.reason}` : ""}</span></td>
                          <td className="mono">{i.upgrade_to || <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </td></tr>
              ),
            ])}
            {data.operators.length === 0 && <tr><td colSpan={8} className="empty">No OLM operators collected (no OLM on any cluster?).</td></tr>}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Mcp({ nav }) {
  const { data, error, loading } = useFetch(() => api.machineConfigPools(), []);
  return (
    <Card title={`Machine config pools${data ? ` (${data.count})` : ""}`} desc="Node-level config rollout state per pool, degraded and updating first. The patching signal for OS / kubelet changes.">
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <table>
          <thead><tr><th>Status</th><th>Cluster</th><th>Env</th><th>Pool</th><th>Machines</th><th>Updated</th><th>Ready</th><th>Unavailable</th><th>Degraded</th><th>Config</th><th>Message</th></tr></thead>
          <tbody>
            {data.pools.map((p, i) => (
              <tr key={i}>
                <td><span className={`chip ${p.status}`}>{p.status}</span></td>
                <ClusterCell c={p.cluster} nav={nav} />
                <td><span className="tag">{p.environment}</span></td>
                <td>{p.pool}</td>
                <td>{p.machine_count}</td><td>{p.updated}</td><td>{p.ready}</td><td>{p.unavailable}</td><td>{p.degraded}</td>
                <td className="mono muted">{p.current_config}</td>
                <td className="muted wrap">{p.message}</td>
              </tr>
            ))}
            {data.pools.length === 0 && <tr><td colSpan={11} className="empty">No machine config pools collected.</td></tr>}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Storage({ nav }) {
  const { data, error, loading } = useFetch(() => api.storage(), []);
  if (error) return <ErrorBanner error={error} />;
  if (loading && !data) return <Loading />;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <Card title="Storage classes" desc="Provisioner per class, and the claims riding on it - the storage blast radius.">
        <table>
          <thead><tr><th>Class</th><th>Provisioner</th><th>Clusters</th><th>PVCs</th><th>Bound</th><th>Pending</th><th>Requested</th></tr></thead>
          <tbody>
            {data.storage_classes.map((s) => (
              <tr key={s.name}>
                <td className="mono">{s.name} {s.default && <span className="tag">default</span>}</td>
                <td className="mono muted">{s.provisioners.join(", ") || "—"}</td>
                <td>{s.clusters.length}</td><td>{s.pvcs}</td><td>{s.bound}</td>
                <td>{s.pending ? <span style={{ color: "var(--warning)" }}>{s.pending}</span> : 0}</td>
                <td>{fmtBytes(s.requested_bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title={`Persistent volume claims (${data.pvcs.length})`} desc="Pending first. Mounted-by comes from pod volumes.">
        <div className="scroll">
          <table>
            <thead><tr><th>Status</th><th>Cluster</th><th>Namespace</th><th>Claim</th><th>Class</th><th>Requested</th><th>Bound</th><th>Volume</th><th>Mounted by</th></tr></thead>
            <tbody>
              {data.pvcs.map((p, i) => (
                <tr key={i}>
                  <td><span className={`chip ${p.status}`}>{p.status}</span></td>
                  <ClusterCell c={p.cluster} nav={nav} />
                  <td className="mono">{p.namespace}</td><td>{p.name}</td>
                  <td className="mono muted">{p.storage_class}</td>
                  <td>{fmtBytes(p.requested_bytes)}</td><td>{fmtBytes(p.capacity_bytes)}</td>
                  <td className="mono muted">{p.volume || "—"}</td>
                  <td className="muted wrap">{p.mounted_by.join(", ") || <i>not mounted</i>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Routes({ nav }) {
  const [host, setHost] = useState("");
  const { data, error, loading } = useFetch(() => api.routes({ host }), [host]);
  return (
    <Card title={`Routes${data ? ` (${data.count})` : ""}`} desc="Which cluster and namespace serves a hostname."
      right={<input type="text" className="search" placeholder="filter by host…" value={host} onChange={(e) => setHost(e.target.value)} />}>
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <div className="scroll">
          <table>
            <thead><tr><th>Host</th><th>Cluster</th><th>Namespace</th><th>Route</th><th>Service</th><th>TLS</th><th>Status</th><th>Router</th></tr></thead>
            <tbody>
              {data.routes.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{r.host}{r.path || ""}</td>
                  <ClusterCell c={r.cluster} nav={nav} />
                  <td className="mono">{r.namespace}</td><td>{r.name}</td><td>{r.service}{r.port ? `:${r.port}` : ""}</td>
                  <td className="muted">{r.tls_termination || "none"}{r.insecure_policy ? ` · ${r.insecure_policy}` : ""}</td>
                  <td><span className={`chip ${r.status}`}>{r.status}</span></td>
                  <td className="muted">{(r.routers || []).join(", ")}</td>
                </tr>
              ))}
              {data.routes.length === 0 && <tr><td colSpan={8} className="empty">No routes match.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Events({ nav, clusterNames }) {
  const [cluster, setCluster] = useState("");
  const [cls, setCls] = useState("");
  const { data, error, loading } = useFetch(() => api.events({ cluster, class: cls, limit: 300 }), [cluster, cls]);
  return (
    <Card title={`Warning events${data ? ` (${data.count})` : ""}`}
      desc={data ? Object.entries(data.by_reason).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${v} ${k}`).join(" · ") : ""}
      right={<div className="filters" style={{ margin: 0 }}>
        <SubTabs tabs={[["", "All"], ["platform", "Platform"], ["application", "Apps"]]} value={cls} onChange={setCls} />
        <FilterSelect label="Cluster" value={cluster} options={clusterNames} onChange={setCluster} />
      </div>}>
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <div className="scroll">
          <table>
            <thead><tr><th>When</th><th>Cluster</th><th>Namespace</th><th>Object</th><th>Reason</th><th>Count</th><th>Source</th><th>Message</th></tr></thead>
            <tbody>
              {data.events.map((e, i) => (
                <tr key={i}>
                  <td className="muted nowrap">{fmtAge(e.last_at)} ago</td>
                  <ClusterCell c={e.cluster} nav={nav} />
                  <td className="mono">{e.namespace}</td>
                  <td>{e.involved.kind}/{e.involved.name}</td>
                  <td><span className="chip warning">{e.reason}</span></td>
                  <td>{e.count}</td>
                  <td className="muted">{e.source}</td>
                  <td className="muted wrap">{e.message}</td>
                </tr>
              ))}
              {data.events.length === 0 && <tr><td colSpan={8} className="empty">No warning events.</td></tr>}
            </tbody>
          </table>
        </div>
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
  return (
    <Card title={`Images${data ? ` (${data.count})` : ""}`} desc="Which workloads run which images - the input to a CVE blast radius."
      right={<div className="filters" style={{ margin: 0 }}>
        <SubTabs tabs={[["image", "Image"], ["repository", "Repository"], ["registry", "Registry"]]} value={groupBy} onChange={setGroupBy} />
        <input type="text" className="search" placeholder="filter images…" value={image} onChange={(e) => setImage(e.target.value)} />
      </div>}>
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <table>
          <thead><tr><th>{groupBy}</th><th>Clusters</th><th>Workloads</th><th></th></tr></thead>
          <tbody>
            {data.images.map((g) => [
              <tr key={g[groupBy]} className="clickable" onClick={() => setOpen(open === g[groupBy] ? null : g[groupBy])}>
                <td className="mono">{g[groupBy]}</td><td>{g.cluster_count}</td><td>{g.workload_count}</td>
                <td>{groupBy === "image" && <span className="link" onClick={(e) => { e.stopPropagation(); nav.goBlast({ image: g.image }); }}>blast radius →</span>}</td>
              </tr>,
              open === g[groupBy] && (
                <tr key={g[groupBy] + "-d"}><td colSpan={4} style={{ background: "var(--bg)" }}>
                  <table className="mini-table">
                    <thead><tr><th>Cluster</th><th>Namespace</th><th>Workload</th><th>Container</th><th>Image</th></tr></thead>
                    <tbody>{g.workloads.map((w, i) => (
                      <tr key={i}><ClusterCell c={w.cluster} nav={nav} /><td className="mono">{w.namespace}</td><td>{w.kind}/{w.name}</td><td className="muted">{w.container}</td><td className="mono">{w.image}</td></tr>
                    ))}</tbody>
                  </table>
                </td></tr>
              ),
            ])}
            {data.images.length === 0 && <tr><td colSpan={4} className="empty">No images match.</td></tr>}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function References({ nav }) {
  const [kind, setKind] = useState("Secret");
  const [name, setName] = useState("");
  const { data, error, loading } = useFetch(() => api.references({ kind, name }), [kind, name]);
  return (
    <Card title={`Config references${data ? ` (${data.count})` : ""}`}
      desc="Which workloads reference a Secret / ConfigMap / PVC / ServiceAccount - the blast radius of rotating a secret or changing a config map."
      right={<div className="filters" style={{ margin: 0 }}>
        <SubTabs tabs={[["Secret", "Secrets"], ["ConfigMap", "ConfigMaps"], ["PersistentVolumeClaim", "PVCs"], ["ServiceAccount", "Service accounts"]]} value={kind} onChange={setKind} />
        <input type="text" className="search" placeholder="exact name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
      </div>}>
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <div className="scroll">
          <table>
            <thead><tr><th>Cluster</th><th>Namespace</th><th>{kind}</th><th>Referenced by</th></tr></thead>
            <tbody>
              {data.references.map((r, i) => (
                <tr key={i}>
                  <ClusterCell c={r.cluster} nav={nav} />
                  <td className="mono">{r.namespace}</td>
                  <td>{r.name}</td>
                  <td className="wrap"><div className="env-list">{r.workloads.map((w, k) => <span key={k}>{w.kind}/{w.name} <span className="src">via {w.via}</span></span>)}</div></td>
                </tr>
              ))}
              {data.references.length === 0 && <tr><td colSpan={4} className="empty">No references.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Access({ nav }) {
  const { data, error, loading } = useFetch(() => api.clusterAdmins(), []);
  return (
    <Card title={`Cluster admins${data ? ` (${data.count} subjects)` : ""}`} desc="Subjects of ClusterRoleBindings to cluster-admin, with the clusters each holds it on.">
      {error ? <ErrorBanner error={error} /> : loading && !data ? <Loading /> : (
        <table>
          <thead><tr><th>Kind</th><th>Subject</th><th>Role</th><th>Clusters</th><th>Bindings</th></tr></thead>
          <tbody>
            {data.subjects.map((s, i) => (
              <tr key={i}>
                <td className="muted">{s.kind}</td>
                <td className="mono">{s.name}{s.namespace ? <span className="muted"> ({s.namespace})</span> : ""}</td>
                <td className="mono">{s.role}</td>
                <td>{s.cluster_count} <span className="muted">· {s.clusters.map((c) => <span key={c} className="link" style={{ marginRight: 6 }} onClick={() => nav.openCluster(c)}>{c}</span>)}</span></td>
                <td className="muted">{s.bindings.join(", ")}</td>
              </tr>
            ))}
            {data.subjects.length === 0 && <tr><td colSpan={5} className="empty">No cluster-admin bindings collected.</td></tr>}
          </tbody>
        </table>
      )}
    </Card>
  );
}
