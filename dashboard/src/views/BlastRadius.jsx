import { useEffect, useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { Pill, Stat, Loading, ErrorBanner, Tier } from "../components";

const EMPTY = { operator: "", operator_version: "", ocp_version: "", degraded_only: false,
  olm_operator: "", olm_version: "", image: "" };

export default function BlastRadius({ initialQuery, nav }) {
  const ops = useFetch(() => api.operatorVersions(), []);
  const vers = useFetch(() => api.versions(), []);
  const olm = useFetch(() => api.olmOperators(), []);

  const [q, setQ] = useState({ ...EMPTY, ...(initialQuery || {}) });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setQ((s) => ({ ...s, [k]: v }));
  const canRun = q.operator || q.ocp_version || q.olm_operator || q.image;

  const run = async (query = q) => {
    setBusy(true); setError(null);
    try { setResult(await api.blastRadius(query)); } catch (e) { setError(e); } finally { setBusy(false); }
  };

  // Auto-run when arriving with a preset query.
  useEffect(() => {
    if (initialQuery && Object.values(initialQuery).some(Boolean)) {
      const query = { ...EMPTY, ...initialQuery };
      setQ(query);
      run(query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initialQuery)]);

  const operatorNames = (ops.data?.operators || []).map((o) => o.operator);
  const operatorVersionOpts = q.operator
    ? (ops.data?.operators.find((o) => o.operator === q.operator)?.versions || []).map((v) => v.version)
    : [];
  const ocpVersionOpts = (vers.data?.versions || []).map((v) => v.version);
  const olmPackages = (olm.data?.operators || []).map((o) => o.package);
  const olmVersionOpts = q.olm_operator
    ? (olm.data?.operators.find((o) => o.package === q.olm_operator)?.versions || []).map((v) => v.version)
    : [];

  return (
    <div>
      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Impact query</h3>
        <p className="dim" style={{ marginTop: -6 }}>
          Pick a bad OCP version, cluster operator, OLM operator, or container image. The data layer maps it to the
          clusters carrying it, the applications (namespaces + teams) riding on top, and for images the exact workloads.
        </p>
        <div className="filters" style={{ alignItems: "flex-end", marginBottom: 0 }}>
          <label className="fld">OCP version
            <select value={q.ocp_version} onChange={(e) => set("ocp_version", e.target.value)}>
              <option value="">Any</option>
              {ocpVersionOpts.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="fld">Cluster operator
            <select value={q.operator} onChange={(e) => { set("operator", e.target.value); set("operator_version", ""); }}>
              <option value="">Any</option>
              {operatorNames.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <label className="fld">Operator version
            <select value={q.operator_version} onChange={(e) => set("operator_version", e.target.value)} disabled={!q.operator}>
              <option value="">Any</option>
              {operatorVersionOpts.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="fld" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={q.degraded_only} onChange={(e) => set("degraded_only", e.target.checked)} />
            degraded only
          </label>
          <label className="fld">OLM operator
            <select value={q.olm_operator} onChange={(e) => { set("olm_operator", e.target.value); set("olm_version", ""); }}>
              <option value="">Any</option>
              {olmPackages.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <label className="fld">OLM version
            <select value={q.olm_version} onChange={(e) => set("olm_version", e.target.value)} disabled={!q.olm_operator}>
              <option value="">Any</option>
              {olmVersionOpts.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="fld">Image (substring)
            <input type="text" className="search" placeholder="e.g. pause:3.9 or quay.io/acme" value={q.image}
              onChange={(e) => set("image", e.target.value)} />
          </label>
          <button className="btn primary" onClick={() => run()} disabled={busy || !canRun}>
            {busy ? "Querying…" : "Compute blast radius"}
          </button>
        </div>
      </div>

      <ErrorBanner error={error} />
      {!result ? (
        <div className="empty">Run a query to see the impact.</div>
      ) : (
        <Result result={result} nav={nav} />
      )}
    </div>
  );
}

function Result({ result, nav }) {
  const s = result.summary;
  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="stats">
        <Stat label="Clusters impacted" value={s.clusters_impacted} kind="critical" />
        <Stat label="Applications" value={s.applications_impacted} kind="warning" />
        <Stat label="Critical apps" value={s.critical_applications} kind="critical" />
        <Stat label="Teams" value={s.teams_impacted} kind="accent" />
        {s.workloads_impacted > 0 && <Stat label="Workloads" value={s.workloads_impacted} kind="warning" />}
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card flush">
          <div className="card-head"><h3>Impacted clusters</h3></div>
          <table>
            <thead><tr><th>Cluster</th><th>Hub</th><th>Env</th><th>Match</th><th>Status</th></tr></thead>
            <tbody>
              {result.clusters.map((c) => (
                <tr key={c.name} className="clickable" onClick={() => nav.openCluster(c.name)}>
                  <td className="mono">{c.name}</td>
                  <td className="mono">{c.hub}</td>
                  <td><span className="tag">{c.environment}</span></td>
                  <td className="muted wrap">{c.reason}</td>
                  <td><Pill status={c.status} /></td>
                </tr>
              ))}
              {result.clusters.length === 0 && <tr><td colSpan={5} className="empty">No clusters matched.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card flush">
          <div className="card-head"><h3>Impacted applications</h3></div>
          <table>
            <thead><tr><th>Application</th><th>Team</th><th>Tier</th><th>Clusters</th></tr></thead>
            <tbody>
              {result.applications.map((a) => (
                <tr key={a.app} className="clickable" onClick={() => nav.openApp(a.app)}>
                  <td>{a.app}</td>
                  <td className="muted">{a.team}</td>
                  <td><Tier tier={a.tier} /></td>
                  <td title={a.clusters.map((c) => c.cluster).join(", ")}>{a.cluster_count}</td>
                </tr>
              ))}
              {result.applications.length === 0 && <tr><td colSpan={4} className="empty">No applications on matched clusters.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {result.workloads.length > 0 && (
        <div className="card flush">
          <div className="card-head"><h3>Impacted workloads</h3></div>
          <table>
            <thead><tr><th>Cluster</th><th>Namespace</th><th>Workload</th><th>Container</th><th>Image</th></tr></thead>
            <tbody>
              {result.workloads.map((w, i) => (
                <tr key={i} className="clickable" onClick={() => nav.openCluster(w.cluster)}>
                  <td className="mono">{w.cluster}</td>
                  <td>{w.namespace}</td>
                  <td>{w.kind}/{w.name}</td>
                  <td className="muted">{w.container}</td>
                  <td className="mono">{w.image}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3>Spread</h3>
        <div className="row">
          <div>
            <div className="dim" style={{ marginBottom: 6 }}>By environment</div>
            {Object.entries(s.by_environment).map(([k, v]) => (
              <div key={k}><span className="tag">{k}</span> {v}</div>
            ))}
          </div>
          <div>
            <div className="dim" style={{ marginBottom: 6 }}>By hub</div>
            {Object.entries(s.by_hub || s.by_region).map(([k, v]) => (
              <div key={k}><span className="tag">{k}</span> {v}</div>
            ))}
          </div>
          {s.platform_namespaces_impacted.length > 0 && (
            <div>
              <div className="dim" style={{ marginBottom: 6 }}>Platform namespaces</div>
              {s.platform_namespaces_impacted.map((n) => <div key={n} className="mono">{n}</div>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
