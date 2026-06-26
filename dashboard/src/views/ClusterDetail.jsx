import { api } from "../api";
import { useFetch } from "../hooks";
import { Pill, Loading, ErrorBanner, Sparkline, Dot } from "../components";

export default function ClusterDetail({ name, onBack, onBlast }) {
  const { data: c, error, loading } = useFetch(() => api.cluster(name), [name]);
  const tl = useFetch(() => api.timeline(name), [name]);

  if (loading && !c) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const scores = (tl.data?.snapshots || []).map((s) => s.health_score);

  return (
    <div>
      <span className="back" onClick={onBack}>← All clusters</span>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6 }}>
        <h2 className="mono" style={{ margin: 0 }}>{c.name}</h2>
        <Pill status={c.overall_status} />
        {c.upgrading && <span className="tag">upgrading → {c.desired_version} ({c.upgrade_percent}%)</span>}
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <div className="card">
          <h3>Overview</h3>
          <div className="kv">
            <span className="k">Hub</span><span className="mono">{c.hub}</span>
            <span className="k">Region / DC</span><span>{c.region} / {c.datacenter}</span>
            <span className="k">Environment</span><span><span className="tag">{c.environment}</span></span>
            <span className="k">Platform</span><span>{c.platform} · {c.cloud}</span>
            <span className="k">OCP version</span><span className="mono">{c.ocp_version}</span>
            <span className="k">Channel</span><span className="mono">{c.channel}</span>
            <span className="k">Kubernetes</span><span className="mono">{c.kube_version}</span>
            <span className="k">Nodes ready</span><span>{c.nodes.ready}/{c.nodes.total}</span>
            <span className="k">Health score</span><span>{c.health_score}/100</span>
            {c.available_updates?.length > 0 && (
              <>
                <span className="k">Updates</span>
                <span className="mono">{c.available_updates.join(", ")}</span>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <h3>Health score (history)</h3>
          <Sparkline points={scores} width={300} height={70} />
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {scores.length} snapshots · latest {scores[scores.length - 1] ?? "—"}/100
          </div>
          <h3 style={{ marginTop: 20 }}>Precondition checks</h3>
          <div className="checklist">
            {c.health_checks.map((h) => (
              <div key={h.name} className={`check ${h.status}`}>
                <Dot status={h.status} />
                <span className="ttl">{h.title}</span>
                {h.message && <span className="msg">{h.message}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1.3fr 1fr", gap: 16, marginTop: 16 }}>
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: "18px 18px 0" }}><h3>Cluster operators ({c.operators.length})</h3></div>
          <table>
            <thead><tr><th>Operator</th><th>Version</th><th>State</th></tr></thead>
            <tbody>
              {c.operators.map((o) => (
                <tr key={o.name}>
                  <td>{o.name} {o.critical && <span className="tag critical">critical</span>}</td>
                  <td className="mono">{o.version}</td>
                  <td>{opState(o)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: "18px 18px 0" }}><h3>Applications ({c.applications.length})</h3></div>
          <table>
            <thead><tr><th>App</th><th>Team</th><th>Tier</th><th>Pods</th></tr></thead>
            <tbody>
              {c.applications.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td className="muted">{a.team}</td>
                  <td>{a.tier === "critical" ? <span className="tag critical">critical</span> : <span className="tag">{a.tier}</span>}</td>
                  <td>{a.replicas_ready}/{a.replicas_desired}</td>
                </tr>
              ))}
              {c.applications.length === 0 && <tr><td colSpan={4} className="empty">No tracked applications.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <button className="btn" onClick={() => onBlast(c.ocp_version)}>
          See blast radius for OCP {c.ocp_version} →
        </button>
      </div>
    </div>
  );
}

function opState(o) {
  if (o.degraded) return <span style={{ color: "var(--critical)" }}>Degraded</span>;
  if (!o.available) return <span style={{ color: "var(--critical)" }}>Unavailable</span>;
  if (o.progressing) return <span style={{ color: "var(--warning)" }}>Progressing</span>;
  return <span style={{ color: "var(--healthy)" }}>Available</span>;
}
