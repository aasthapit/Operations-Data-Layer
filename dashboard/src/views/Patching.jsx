import { useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { Stat, Loading, ErrorBanner } from "../components";

const JOB_TONE = {
  completed: "healthy", running: "warning", paused: "warning",
  approved: "unknown", submitted: "unknown", failed: "critical",
  rejected: "critical", cancelled: "unknown",
};
const OUTCOME_TONE = { passed: "healthy", skipped: "warning", failed: "critical", pending: "unknown" };

function Tag({ tone, children }) {
  return <span className={`pill ${tone || "unknown"}`}><span className={`dot-s ${tone || "unknown"}`} />{children}</span>;
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export default function Patching() {
  const [selected, setSelected] = useState(null);
  const report = useFetch(() => api.patchReport(), []);
  const jobs = useFetch(() => api.patchJobs(), []);

  if (selected) return <JobDetail id={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div>
        <div className="section-title" style={{ margin: "0 0 4px" }}>Patching</div>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>
          Durable system of record - who requested, who approved, the change record, per-cluster outcome, and an immutable audit trail.
        </div>
        {report.error ? <ErrorBanner error={report.error} /> : report.loading && !report.data ? <Loading /> : (
          <Report data={report.data} />
        )}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: "18px 18px 0" }}><h3>Jobs</h3></div>
        {jobs.error ? <ErrorBanner error={jobs.error} /> : jobs.loading && !jobs.data ? <Loading /> : (
          <table>
            <thead>
              <tr><th>Job</th><th>Change</th><th>Requested</th><th>Approved</th>
                <th>Target</th><th>Progress</th><th>Status</th><th>Created</th></tr>
            </thead>
            <tbody>
              {jobs.data.jobs.map((j) => (
                <tr key={j.id} className="clickable" onClick={() => setSelected(j.id)}>
                  <td className="mono">{j.id}</td>
                  <td className="mono">{j.change_record}</td>
                  <td>{j.requested_by}</td>
                  <td>{j.approved_by || <span className="muted">pending</span>}</td>
                  <td className="mono">{j.target_version}</td>
                  <td>
                    <span style={{ color: "var(--healthy)" }}>{j.totals.succeeded}✓</span>{" "}
                    {j.totals.skipped ? <span style={{ color: "var(--warning)" }}>{j.totals.skipped}⤼</span> : null}{" "}
                    {j.totals.failed ? <span style={{ color: "var(--critical)" }}>{j.totals.failed}✕</span> : null}
                    <span className="muted"> / {j.totals.total} · {j.totals.success_pct}%</span>
                  </td>
                  <td><Tag tone={JOB_TONE[j.status]}>{j.status}</Tag></td>
                  <td className="muted">{fmtTime(j.created_at)}</td>
                </tr>
              ))}
              {jobs.data.jobs.length === 0 && (
                <tr><td colSpan={8} className="empty">No patching jobs yet. Submit one via the N8N form.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Report({ data }) {
  const s = data.jobs_by_status || {};
  const attention = (s.paused || 0) + (s.failed || 0);
  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="stats">
        <Stat label="Jobs" value={data.jobs_total} kind="accent" />
        <Stat label="Completed" value={s.completed || 0} kind="healthy" />
        <Stat label="Need attention" value={attention} kind={attention ? "warning" : "healthy"} />
        <Stat label="Avg success" value={data.avg_success_pct == null ? "—" : `${data.avg_success_pct}%`} kind="accent" />
      </div>
      <div className="card">
        <h3>Clusters across all jobs</h3>
        <div className="row" style={{ gap: 28 }}>
          <div><span style={{ color: "var(--healthy)" }}>●</span> {data.clusters.succeeded} patched</div>
          <div><span style={{ color: "var(--critical)" }}>●</span> {data.clusters.failed} failed</div>
          <div><span style={{ color: "var(--text-faint)" }}>●</span> {data.clusters.pending} pending</div>
        </div>
      </div>
    </div>
  );
}

function JobDetail({ id, onBack }) {
  const { data: j, error, loading } = useFetch(() => api.patchJob(id), [id]);
  if (loading && !j) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  return (
    <div>
      <span className="back" onClick={onBack}>← All jobs</span>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <h2 className="mono" style={{ margin: 0 }}>{j.id}</h2>
        <Tag tone={JOB_TONE[j.status]}>{j.status}</Tag>
        <span className="muted">{j.totals.success_pct}% success (threshold {j.threshold_pct}%)</span>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="kv">
          <span className="k">Change record</span><span className="mono">{j.change_record}</span>
          <span className="k">Requested by</span><span>{j.requested_by}</span>
          <span className="k">Approved by</span><span>{j.approved_by || "—"} ({j.approval_status})</span>
          <span className="k">Target version</span><span className="mono">{j.target_version}</span>
          <span className="k">Source</span><span>{j.source}</span>
          <span className="k">Started / finished</span><span className="muted">{fmtTime(j.started_at)} → {fmtTime(j.finished_at)}</span>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: "18px 18px 0" }}><h3>Per-cluster results</h3></div>
          <table>
            <thead><tr><th>Cluster</th><th>Phase</th><th>Outcome</th><th>Version</th><th>Health</th></tr></thead>
            <tbody>
              {j.tasks.map((t) => (
                <tr key={t.cluster}>
                  <td className="mono">{t.cluster}</td>
                  <td>{t.phase}</td>
                  <td><Tag tone={OUTCOME_TONE[t.outcome]}>{t.outcome}</Tag></td>
                  <td className="mono">{t.version_from || "?"} → {t.version_to || "—"}</td>
                  <td>{t.health_before ?? "—"} → {t.health_after ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: "18px 18px 0" }}><h3>Audit trail ({j.audit.length})</h3></div>
          <div style={{ maxHeight: 380, overflowY: "auto", padding: "4px 0" }}>
            {j.audit.map((e, i) => (
              <div key={i} className="check" style={{ alignItems: "flex-start" }}>
                <span className="muted mono" style={{ fontSize: 11.5, minWidth: 64 }}>
                  {e.ts ? new Date(e.ts).toLocaleTimeString() : ""}
                </span>
                <div className="ttl" style={{ flex: 1 }}>
                  <span className="tag" style={{ marginRight: 6 }}>{e.actor}</span>
                  <span className="mono" style={{ fontSize: 12.5 }}>{e.action}</span>
                  {e.cluster && <span className="muted"> · {e.cluster}</span>}
                  {e.message && <div className="muted" style={{ fontSize: 12 }}>{e.message}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
