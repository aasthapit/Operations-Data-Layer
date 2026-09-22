import type { ReactNode } from "react";
import { api } from "../api";
import type { PatchJobResponse, PatchJobSummary, PatchReportResponse } from "../api/types";
import { useFetch } from "../hooks";
import { Stat, ErrorBanner, DataTable, SkeletonStats, SkeletonTable, SkeletonLines } from "../components";
import type { Column } from "../components";
import type { Nav } from "../router";

/** One per-cluster result inside a job. */
type TaskRow = PatchJobResponse["tasks"][number];

interface PatchingProps {
  /** A job id when the URL names one: /patching/<id> is the detail page. */
  id?: string;
  nav: Nav;
}

// The job and outcome vocabularies are the patching service's own, so they are
// records rather than unions: a status this build has not heard of still draws,
// as "unknown".
const JOB_TONE: Record<string, string> = {
  completed: "healthy", running: "warning", paused: "warning",
  approved: "unknown", submitted: "unknown", failed: "critical",
  rejected: "critical", cancelled: "unknown",
};
const OUTCOME_TONE: Record<string, string> = { passed: "healthy", skipped: "warning", failed: "critical", pending: "unknown" };

interface TagProps {
  tone?: string;
  children?: ReactNode;
}

function Tag({ tone, children }: TagProps) {
  return <span className={`pill ${tone || "unknown"}`}><span className={`dot-s ${tone || "unknown"}`} />{children}</span>;
}

function fmtTime(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

const JOB_COLUMNS: Column<PatchJobSummary>[] = [
  { key: "id", label: "Job", className: "mono", filter: "text" },
  { key: "change_record", label: "Change", className: "mono", filter: "text" },
  { key: "requested_by", label: "Requested", filter: "select" },
  {
    key: "approved_by", label: "Approved", filter: "select",
    render: (j) => j.approved_by || <span className="muted">pending</span>,
  },
  { key: "target_version", label: "Target", className: "mono", filter: "select" },
  {
    key: "progress", label: "Progress", className: "nowrap",
    sortValue: (j) => j.totals.success_pct,
    filterValue: (j) => `${j.totals.succeeded}/${j.totals.total} ${j.totals.success_pct}%`,
    render: (j) => (
      <>
        <span style={{ color: "var(--healthy)" }}>{j.totals.succeeded}✓</span>{" "}
        {j.totals.skipped ? <span style={{ color: "var(--warning)" }}>{j.totals.skipped}⤼</span> : null}{" "}
        {j.totals.failed ? <span style={{ color: "var(--critical)" }}>{j.totals.failed}✕</span> : null}
        <span className="muted"> / {j.totals.total} · {j.totals.success_pct}%</span>
      </>
    ),
  },
  { key: "status", label: "Status", filter: "select", render: (j) => <Tag tone={JOB_TONE[j.status]}>{j.status}</Tag> },
  { key: "created_at", label: "Created", className: "muted nowrap", render: (j) => fmtTime(j.created_at) },
];

const TASK_COLUMNS: Column<TaskRow>[] = [
  { key: "cluster", label: "Cluster", className: "mono", filter: "text" },
  { key: "phase", label: "Phase", filter: "select" },
  { key: "outcome", label: "Outcome", filter: "select", render: (t) => <Tag tone={OUTCOME_TONE[t.outcome]}>{t.outcome}</Tag> },
  {
    key: "version", label: "Version", className: "mono nowrap",
    sortValue: (t) => t.version_to,
    filterValue: (t) => `${t.version_from || "?"} → ${t.version_to || ""}`,
    render: (t) => `${t.version_from || "?"} → ${t.version_to || "—"}`,
  },
  {
    key: "health", label: "Health",
    sortValue: (t) => t.health_after,
    filterValue: (t) => `${t.health_before ?? ""} ${t.health_after ?? ""}`,
    render: (t) => `${t.health_before ?? "—"} → ${t.health_after ?? "—"}`,
  },
];

export default function Patching({ id, nav }: PatchingProps) {
  const report = useFetch(() => api.patchReport(), []);
  const jobs = useFetch(() => api.patchJobs(), []);

  if (id) return <JobDetail id={id} nav={nav} />;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div>
        <div className="section-title" style={{ margin: "0 0 4px" }}>Patching</div>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>
          Durable system of record - who requested, who approved, the change record, per-cluster outcome, and an immutable audit trail.
        </div>
        {report.error && !report.data ? <ErrorBanner error={report.error} /> : !report.data ? <SkeletonStats count={4} /> : (
          <Report data={report.data} />
        )}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: "18px 18px 0" }}><h3>Jobs</h3></div>
        {jobs.error && !jobs.data ? <ErrorBanner error={jobs.error} /> : !jobs.data ? <SkeletonTable columns={8} rows={6} /> : (
          <DataTable
            id="patching.jobs"
            columns={JOB_COLUMNS}
            rows={jobs.data.jobs}
            rowKey="id"
            onRowClick={(j) => nav.goPatchJob(j.id)}
            initialSort={{ key: "created_at", dir: "desc" }}
            empty="No patching jobs yet. Submit one via the N8N form."
          />
        )}
      </div>
    </div>
  );
}

function Report({ data }: { data: PatchReportResponse }) {
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

function JobDetail({ id, nav }: { id: string; nav: Nav }) {
  const { data: j, error } = useFetch(() => api.patchJob(id), [id]);
  if (error && !j) return <ErrorBanner error={error} />;

  return (
    <div>
      <span className="back" onClick={() => nav.back("/patching")}>← All jobs</span>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <h2 className="mono" style={{ margin: 0 }}>{id}</h2>
        {j && <Tag tone={JOB_TONE[j.status]}>{j.status}</Tag>}
        {j && <span className="muted">{j.totals.success_pct}% success (threshold {j.threshold_pct}%)</span>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        {!j ? <SkeletonLines rows={6} /> : (
        <div className="kv">
          <span className="k">Change record</span><span className="mono">{j.change_record}</span>
          <span className="k">Requested by</span><span>{j.requested_by}</span>
          <span className="k">Approved by</span><span>{j.approved_by || "—"} ({j.approval_status})</span>
          <span className="k">Target version</span><span className="mono">{j.target_version}</span>
          <span className="k">Source</span><span>{j.source}</span>
          <span className="k">Started / finished</span><span className="muted">{fmtTime(j.started_at)} → {fmtTime(j.finished_at)}</span>
        </div>
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: "18px 18px 0" }}><h3>Per-cluster results</h3></div>
          {!j ? <SkeletonTable columns={5} rows={5} /> : (
            <DataTable
              id="patching.job.tasks"
              columns={TASK_COLUMNS}
              rows={j.tasks}
              rowKey="cluster"
              initialSort={{ key: "cluster", dir: "asc" }}
              empty="No per-cluster results yet."
            />
          )}
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: "18px 18px 0" }}><h3>Audit trail{j ? ` (${j.audit.length})` : ""}</h3></div>
          <div style={{ maxHeight: 380, overflowY: "auto", padding: "4px 0" }}>
            {!j ? <SkeletonLines rows={6} /> : j.audit.map((e, i) => (
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
