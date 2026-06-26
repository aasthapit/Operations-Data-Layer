import { useEffect, useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { Pill, Stat, Loading, ErrorBanner } from "../components";

export default function BlastRadius({ initialOcpVersion, onOpen }) {
  const ops = useFetch(() => api.operatorVersions(), []);
  const vers = useFetch(() => api.versions(), []);

  const [operator, setOperator] = useState("");
  const [operatorVersion, setOperatorVersion] = useState("");
  const [ocpVersion, setOcpVersion] = useState(initialOcpVersion || "");
  const [degradedOnly, setDegradedOnly] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.blastRadius({
        operator, operator_version: operatorVersion,
        ocp_version: ocpVersion, degraded_only: degradedOnly,
      });
      setResult(r);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  // Auto-run when arriving with a preset OCP version.
  useEffect(() => {
    if (initialOcpVersion) {
      setOcpVersion(initialOcpVersion);
      api.blastRadius({ ocp_version: initialOcpVersion })
        .then(setResult).catch(setError);
    }
  }, [initialOcpVersion]);

  const operatorNames = (ops.data?.operators || []).map((o) => o.operator);
  const operatorVersionOpts = operator
    ? (ops.data?.operators.find((o) => o.operator === operator)?.versions || []).map((v) => v.version)
    : [];
  const ocpVersionOpts = (vers.data?.versions || []).map((v) => v.version);

  return (
    <div>
      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Impact query</h3>
        <p className="dim" style={{ marginTop: -6 }}>
          Pick a bad OCP version and/or a cluster operator. The data layer maps it to the clusters
          carrying it and the applications riding on top.
        </p>
        <div className="filters" style={{ alignItems: "flex-end", marginBottom: 0 }}>
          <label className="fld">OCP version
            <select value={ocpVersion} onChange={(e) => setOcpVersion(e.target.value)}>
              <option value="">Any</option>
              {ocpVersionOpts.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="fld">Operator
            <select value={operator} onChange={(e) => { setOperator(e.target.value); setOperatorVersion(""); }}>
              <option value="">Any</option>
              {operatorNames.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <label className="fld">Operator version
            <select value={operatorVersion} onChange={(e) => setOperatorVersion(e.target.value)} disabled={!operator}>
              <option value="">Any</option>
              {operatorVersionOpts.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="fld" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={degradedOnly} onChange={(e) => setDegradedOnly(e.target.checked)} />
            degraded only
          </label>
          <button className="btn primary" onClick={run} disabled={busy || (!operator && !ocpVersion)}>
            {busy ? "Querying…" : "Compute blast radius"}
          </button>
        </div>
      </div>

      <ErrorBanner error={error} />
      {!result ? (
        <div className="empty">Run a query to see the impact.</div>
      ) : (
        <Result result={result} onOpen={onOpen} />
      )}
    </div>
  );
}

function Result({ result, onOpen }) {
  const s = result.summary;
  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="stats">
        <Stat label="Clusters impacted" value={s.clusters_impacted} kind="critical" />
        <Stat label="Applications" value={s.applications_impacted} kind="warning" />
        <Stat label="Critical apps" value={s.critical_applications} kind="critical" />
        <Stat label="Teams" value={s.teams_impacted} kind="accent" />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: "18px 18px 0" }}><h3>Impacted clusters</h3></div>
          <table>
            <thead><tr><th>Cluster</th><th>Region</th><th>Env</th><th>Match</th><th>Status</th></tr></thead>
            <tbody>
              {result.clusters.map((c) => (
                <tr key={c.name} className="clickable" onClick={() => onOpen(c.name)}>
                  <td className="mono">{c.name}</td>
                  <td>{c.region}</td>
                  <td><span className="tag">{c.environment}</span></td>
                  <td className="muted">{c.reason}</td>
                  <td><Pill status={c.status} /></td>
                </tr>
              ))}
              {result.clusters.length === 0 && <tr><td colSpan={5} className="empty">No clusters matched.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: "18px 18px 0" }}><h3>Impacted applications</h3></div>
          <table>
            <thead><tr><th>Application</th><th>Team</th><th>Tier</th><th>Clusters</th></tr></thead>
            <tbody>
              {result.applications.map((a) => (
                <tr key={a.app}>
                  <td>{a.app}</td>
                  <td className="muted">{a.team}</td>
                  <td>{a.tier === "critical" ? <span className="tag critical">critical</span> : <span className="tag">{a.tier}</span>}</td>
                  <td title={a.clusters.map((c) => c.cluster).join(", ")}>{a.cluster_count}</td>
                </tr>
              ))}
              {result.applications.length === 0 && <tr><td colSpan={4} className="empty">No applications on matched clusters.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

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
            <div className="dim" style={{ marginBottom: 6 }}>By region</div>
            {Object.entries(s.by_region).map(([k, v]) => (
              <div key={k}><span className="tag">{k}</span> {v}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
