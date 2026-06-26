import { api } from "../api";
import { useFetch } from "../hooks";
import { Pill, Loading, ErrorBanner } from "../components";

export default function Versions({ onOpen, onBlast }) {
  const { data, error, loading } = useFetch(() => api.versions(), []);
  const ops = useFetch(() => api.operatorVersions(), []);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const maxCount = Math.max(...data.versions.map((v) => v.count), 1);

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="card">
        <h3>OCP version distribution</h3>
        {data.versions.map((v) => (
          <div key={v.version} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span className="mono">{v.version} <span className="muted">· {v.count} cluster{v.count > 1 ? "s" : ""}</span></span>
              <a onClick={() => onBlast(v.version)} style={{ cursor: "pointer", fontSize: 12.5 }}>blast radius →</a>
            </div>
            <div className="hbar" style={{ height: 22, background: "var(--bg-elev-2)" }}>
              <span className="healthy" style={{ width: `${(v.count / maxCount) * 100}%`, background: "var(--accent)" }} />
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              {v.clusters.map((c) => (
                <span key={c.name} className="tag clickable" style={{ cursor: "pointer" }} onClick={() => onOpen(c.name)}>
                  <span className={`dot-s ${c.status}`} style={{ marginRight: 4 }} />{c.name}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: "18px 18px 0" }}>
          <h3>Operator version spread</h3>
          <p className="dim" style={{ marginTop: -6 }}>Operators reporting more than one version across the fleet are drifting - usually a partial rollout.</p>
        </div>
        <table>
          <thead><tr><th>Operator</th><th>Versions in fleet</th><th>Drift</th></tr></thead>
          <tbody>
            {ops.data?.operators
              .filter((o) => o.distinct > 1)
              .map((o) => (
                <tr key={o.operator}>
                  <td>{o.operator}</td>
                  <td className="mono">
                    {o.versions.map((v) => `${v.version} (${v.count})`).join(", ")}
                  </td>
                  <td><Pill status="warning" /></td>
                </tr>
              ))}
            {ops.data && ops.data.operators.filter((o) => o.distinct > 1).length === 0 && (
              <tr><td colSpan={3} className="empty">All operators are on a single version across the fleet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
