import { useEffect, useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { Pill, Loading, ErrorBanner, FilterSelect, Tier, fmtBytes, fmtCores } from "../components";

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
          <table>
            <thead>
              <tr><th>Application</th><th>{ownerLabel}</th>{mapped ? <th>Namespace envs</th> : <th>Tier</th>}<th>Status</th><th>Clusters</th><th>Environments</th>
                <th>Workloads</th><th>Replicas</th><th>Pod issues</th><th>CPU used</th><th>Memory used</th></tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.app} className="clickable" onClick={() => setSelected(a.app)}>
                  <td>{a.assigned ? a.app : <span className="muted">{a.app} <span style={{ fontSize: 11 }}>not under a business application</span></span>}</td>
                  <td className="muted">{a.team || "-"}</td>
                  {mapped
                    ? <td>{(a.namespace_environments || []).map((e) => <span key={e} className="tag" style={{ marginRight: 4 }}>{e}</span>)}</td>
                    : <td><Tier tier={a.tier} /></td>}
                  <td><Pill status={a.status} /></td>
                  <td>{a.cluster_count} <span className="muted">· {(a.hubs || a.regions).join(", ")}</span></td>
                  <td>{a.environments.map((e) => <span key={e} className="tag" style={{ marginRight: 4 }}>{e}</span>)}</td>
                  <td>{a.workloads}</td>
                  <td>{a.replicas_ready}/{a.replicas_desired}</td>
                  <td>{a.pod_issues ? <span style={{ color: "var(--warning)" }}>{a.pod_issues}</span> : <span className="muted">0</span>}</td>
                  <td>{a.cpu_used_cores != null ? fmtCores(a.cpu_used_cores) : <span className="muted">n/a</span>}</td>
                  <td>{a.memory_used_bytes != null ? fmtBytes(a.memory_used_bytes) : <span className="muted">n/a</span>}</td>
                </tr>
              ))}
              {apps.length === 0 && <tr><td colSpan={11} className="empty">No applications match.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>{data?.count ?? 0} applications</div>
    </div>
  );
}

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
          <table>
            <thead><tr><th>Cluster</th><th>Hub</th><th>Env</th><th>OCP</th><th>Cluster status</th><th>Namespace</th><th>Namespace env</th><th>App status</th><th>Workloads</th><th>Replicas</th><th>Pod issues</th><th>CPU</th><th>Memory</th></tr></thead>
            <tbody>
              {a.placements.map((p) => (
                <tr key={p.cluster + "/" + p.namespace} className="clickable" onClick={() => nav.openCluster(p.cluster)}>
                  <td className="mono">{p.cluster}</td>
                  <td className="mono">{p.hub}</td>
                  <td><span className="tag">{p.environment}</span></td>
                  <td className="mono">{p.ocp_version}</td>
                  <td><Pill status={p.cluster_status} /></td>
                  <td className="mono">{p.namespace}</td>
                  <td>{p.namespace_environment ? <span className="tag">{p.namespace_environment}</span> : <span className="muted">-</span>}</td>
                  <td><Pill status={p.status} /></td>
                  <td>{p.workloads}</td>
                  <td>{p.replicas_ready}/{p.replicas_desired}</td>
                  <td>{p.pod_issues || <span className="muted">0</span>}</td>
                  <td>{fmtCores(p.cpu_used_cores)}</td>
                  <td>{fmtBytes(p.memory_used_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card flush">
          <div className="card-head">
            <h3>Workloads ({a.workloads_detail.length})</h3>
            <div className="desc">Container env shows names and sources only - values are never collected.</div>
          </div>
          <table>
            <thead><tr><th>Cluster</th><th>Kind</th><th>Name</th><th>Status</th><th>Replicas</th><th>Image</th><th>Env (name ← source)</th><th>References</th></tr></thead>
            <tbody>
              {a.workloads_detail.map((w) => (
                <tr key={w.cluster + w.kind + w.name}>
                  <td className="mono">{w.cluster}</td>
                  <td className="muted">{w.kind}</td>
                  <td>{w.name}</td>
                  <td><span className={`chip ${w.status}`}>{w.status}</span></td>
                  <td>{w.replicas.ready}/{w.replicas.desired}</td>
                  <td className="mono wrap">{w.images.join(", ")}</td>
                  <td>
                    <div className="env-list">
                      {w.containers.flatMap((c) => c.env).map((e) => (
                        <span key={e.name}><span className="mono">{e.name}</span> <span className="src">
                          {e.from?.kind === "literal" ? "(literal, scrubbed)" : e.from?.kind === "field" ? `← ${e.from.path}` : e.from ? `← ${e.from.kind} ${e.from.name}/${e.from.key}` : ""}
                        </span></span>
                      ))}
                    </div>
                  </td>
                  <td className="muted wrap" style={{ fontSize: 12 }}>{w.config_refs.map((r) => `${r.kind} ${r.name} (${r.via})`).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
