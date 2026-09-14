import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { Pill, Stat, ErrorBanner, Tier, DataTable, SkeletonStats, SkeletonTable } from "../components";

const CLUSTER_COLUMNS = [
  { key: "name", label: "Cluster", className: "mono", filter: "text" },
  { key: "hub", label: "Hub", className: "mono", filter: "select" },
  { key: "environment", label: "Env", filter: "select", render: (c) => <span className="tag">{c.environment}</span> },
  { key: "reason", label: "Match", className: "muted wrap", filter: "text" },
  { key: "status", label: "Status", filter: "select", render: (c) => <Pill status={c.status} /> },
];

const APP_COLUMNS = [
  { key: "app", label: "Application", filter: "text" },
  { key: "team", label: "Team", className: "muted", filter: "select" },
  { key: "tier", label: "Tier", filter: "select", render: (a) => <Tier tier={a.tier} /> },
  {
    key: "cluster_count", label: "Clusters",
    filterValue: (a) => a.clusters.map((c) => c.cluster).join(", "),
    render: (a) => <span title={a.clusters.map((c) => c.cluster).join(", ")}>{a.cluster_count}</span>,
  },
];

const WORKLOAD_COLUMNS = [
  { key: "cluster", label: "Cluster", className: "mono", filter: "text" },
  { key: "namespace", label: "Namespace", filter: "text" },
  {
    key: "workload", label: "Workload", filter: "text",
    sortValue: (w) => `${w.kind}/${w.name}`,
    filterValue: (w) => `${w.kind}/${w.name}`,
    render: (w) => `${w.kind}/${w.name}`,
  },
  { key: "container", label: "Container", className: "muted", filter: "select" },
  { key: "image", label: "Image", className: "mono", filter: "text" },
];

const EMPTY = { operator: "", operator_version: "", ocp_version: "", degraded_only: false,
  olm_operator: "", olm_version: "", image: "" };

// The query is the URL: /blast?ocp_version=4.16.7 is a shareable impact report,
// and the back button walks back through the queries that were run.
function fromRoute(route) {
  const q = { ...EMPTY };
  Object.keys(EMPTY).forEach((k) => { q[k] = route.query[k] || ""; });
  q.degraded_only = route.query.degraded_only === "true";
  return q;
}

export default function BlastRadius({ route, nav }) {
  const ops = useFetch(() => api.operatorVersions(), []);
  const vers = useFetch(() => api.versions(), []);
  const olm = useFetch(() => api.olmOperators(), []);

  const urlQuery = fromRoute(route);
  const urlKey = JSON.stringify(urlQuery);

  const [q, setQ] = useState(urlQuery);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const ran = useRef(null);
  const set = (k, v) => setQ((s) => ({ ...s, [k]: v }));
  const canRun = q.operator || q.ocp_version || q.olm_operator || q.image;

  const execute = async (query, key) => {
    ran.current = key;
    setBusy(true); setError(null);
    try { setResult(await api.blastRadius(query)); } catch (e) { setError(e); } finally { setBusy(false); }
  };

  // Landing on a query - a blast-radius link, a reload, or the back button -
  // restores the form and runs it.
  useEffect(() => {
    setQ(urlQuery);
    if (!Object.values(urlQuery).some(Boolean)) {
      ran.current = null;
      setResult(null);
      return;
    }
    if (ran.current !== urlKey) execute(urlQuery, urlKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey]);

  // Running is a push: the previous query stays one back button away. Asking
  // for the query already in the URL just re-runs it.
  const run = () => {
    const key = JSON.stringify(q);
    nav.goBlast(q);
    if (key === urlKey) execute(q, key);
  };

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
          <button className="btn primary" onClick={run} disabled={busy || !canRun}>
            {busy ? "Querying…" : "Compute blast radius"}
          </button>
        </div>
      </div>

      <ErrorBanner error={error} />
      {result ? (
        <Result result={result} nav={nav} />
      ) : busy ? (
        <div className="grid" style={{ gap: 20 }}>
          <SkeletonStats count={4} />
          <div className="card flush"><SkeletonTable columns={5} rows={6} /></div>
        </div>
      ) : (
        <div className="empty">Run a query to see the impact.</div>
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
          <DataTable
            id="blast.clusters"
            columns={CLUSTER_COLUMNS}
            rows={result.clusters}
            rowKey="name"
            onRowClick={(c) => nav.openCluster(c.name)}
            initialSort={{ key: "name", dir: "asc" }}
            empty="No clusters matched."
          />
        </div>

        <div className="card flush">
          <div className="card-head"><h3>Impacted applications</h3></div>
          <DataTable
            id="blast.applications"
            columns={APP_COLUMNS}
            rows={result.applications}
            rowKey="app"
            onRowClick={(a) => nav.openApp(a.app)}
            initialSort={{ key: "app", dir: "asc" }}
            empty="No applications on matched clusters."
          />
        </div>
      </div>

      {result.workloads.length > 0 && (
        <div className="card flush">
          <div className="card-head"><h3>Impacted workloads</h3></div>
          <DataTable
            id="blast.workloads"
            columns={WORKLOAD_COLUMNS}
            rows={result.workloads}
            rowKey={(w, i) => `${w.cluster}/${w.namespace}/${w.kind}/${w.name}/${w.container}/${i}`}
            onRowClick={(w) => nav.openCluster(w.cluster)}
            initialSort={{ key: "cluster", dir: "asc" }}
            empty="No workloads matched."
          />
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
