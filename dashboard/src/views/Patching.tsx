import { Box, Link, Stack, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { api } from "../api";
import type { PatchJobResponse, PatchJobSummary, PatchReportResponse } from "../api/types";
import { useFetch } from "../hooks";
import {
  Card, KeyLabel, KeyValues, MONO_FONT, Mono, Muted, Pill, SectionHead, StatGrid, Tag, ToneText,
  Stat, ErrorBanner, DataTable, SkeletonStats, SkeletonTable, SkeletonLines,
} from "../components";
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

function fmtTime(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

const JOB_COLUMNS: Column<PatchJobSummary>[] = [
  { key: "id", label: "Job", className: "mono", filter: "text" },
  { key: "change_record", label: "Change", className: "mono", filter: "text" },
  { key: "requested_by", label: "Requested", filter: "select" },
  {
    key: "approved_by", label: "Approved", filter: "select",
    render: (j) => j.approved_by || <Muted>pending</Muted>,
  },
  { key: "target_version", label: "Target", className: "mono", filter: "select" },
  {
    key: "progress", label: "Progress", className: "nowrap",
    sortValue: (j) => j.totals.success_pct,
    filterValue: (j) => `${j.totals.succeeded}/${j.totals.total} ${j.totals.success_pct}%`,
    render: (j) => (
      <>
        <ToneText tone="healthy">{j.totals.succeeded}✓</ToneText>{" "}
        {j.totals.skipped ? <ToneText tone="warning">{j.totals.skipped}⤼</ToneText> : null}{" "}
        {j.totals.failed ? <ToneText tone="critical">{j.totals.failed}✕</ToneText> : null}
        <Muted> / {j.totals.total} · {j.totals.success_pct}%</Muted>
      </>
    ),
  },
  {
    key: "status", label: "Status", filter: "select",
    render: (j) => <Pill status={JOB_TONE[j.status]}>{j.status}</Pill>,
  },
  { key: "created_at", label: "Created", className: "muted nowrap", render: (j) => fmtTime(j.created_at) },
];

const TASK_COLUMNS: Column<TaskRow>[] = [
  { key: "cluster", label: "Cluster", className: "mono", filter: "text" },
  { key: "phase", label: "Phase", filter: "select" },
  {
    key: "outcome", label: "Outcome", filter: "select",
    render: (t) => <Pill status={OUTCOME_TONE[t.outcome]}>{t.outcome}</Pill>,
  },
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
    <Stack spacing={2.5}>
      <Box>
        <SectionHead
          title="Patching"
          description="Durable system of record - who requested, who approved, the change record, per-cluster outcome, and an immutable audit trail."
        />
        {report.error && !report.data ? <ErrorBanner error={report.error} /> : !report.data ? <SkeletonStats count={4} /> : (
          <Report data={report.data} />
        )}
      </Box>

      <Card flush title="Jobs">
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
      </Card>
    </Stack>
  );
}

function Report({ data }: { data: PatchReportResponse }) {
  const s = data.jobs_by_status || {};
  const attention = (s.paused || 0) + (s.failed || 0);
  return (
    <Stack spacing={1.5}>
      <StatGrid>
        <Stat label="Jobs" value={data.jobs_total} kind="accent" />
        <Stat label="Completed" value={s.completed || 0} kind="healthy" />
        <Stat label="Need attention" value={attention} kind={attention ? "warning" : "healthy"} />
        <Stat label="Avg success" value={data.avg_success_pct == null ? "—" : `${data.avg_success_pct}%`} kind="accent" />
      </StatGrid>
      <Card title="Clusters across all jobs">
        <Box sx={{ display: "flex", gap: 3.5, flexWrap: "wrap" }}>
          <div><ToneText tone="healthy">●</ToneText> {data.clusters.succeeded} patched</div>
          <div><ToneText tone="critical">●</ToneText> {data.clusters.failed} failed</div>
          <div><Muted>●</Muted> {data.clusters.pending} pending</div>
        </Box>
      </Card>
    </Stack>
  );
}

function JobDetail({ id, nav }: { id: string; nav: Nav }) {
  const { data: j, error } = useFetch(() => api.patchJob(id), [id]);
  if (error && !j) return <ErrorBanner error={error} />;

  return (
    <Box>
      <Link
        component="button"
        type="button"
        color="text.secondary"
        onClick={() => nav.back("/patching")}
        sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, mb: 1.25, fontSize: 13 }}
      >
        <ArrowBackIcon fontSize="inherit" /> All jobs
      </Link>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 1, flexWrap: "wrap" }}>
        <Typography variant="h1" component="h2" sx={{ fontFamily: MONO_FONT }}>{id}</Typography>
        {j && <Pill status={JOB_TONE[j.status]}>{j.status}</Pill>}
        {j && <Muted>{j.totals.success_pct}% success (threshold {j.threshold_pct}%)</Muted>}
      </Box>

      <Card sx={{ mb: 2 }}>
        {!j ? <SkeletonLines rows={6} /> : (
          <KeyValues>
            <KeyLabel>Change record</KeyLabel><Mono>{j.change_record}</Mono>
            <KeyLabel>Requested by</KeyLabel><span>{j.requested_by}</span>
            <KeyLabel>Approved by</KeyLabel><span>{j.approved_by || "—"} ({j.approval_status})</span>
            <KeyLabel>Target version</KeyLabel><Mono>{j.target_version}</Mono>
            <KeyLabel>Source</KeyLabel><span>{j.source}</span>
            <KeyLabel>Started / finished</KeyLabel><Muted>{fmtTime(j.started_at)} → {fmtTime(j.finished_at)}</Muted>
          </KeyValues>
        )}
      </Card>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, gap: 2 }}>
        <Card flush title="Per-cluster results">
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
        </Card>

        <Card flush title={`Audit trail${j ? ` (${j.audit.length})` : ""}`}>
          <Box sx={{ maxHeight: 380, overflowY: "auto", p: "4px 0" }}>
            {!j ? <SkeletonLines rows={6} /> : j.audit.map((e, i) => (
              <Box
                key={i}
                sx={{
                  display: "flex", alignItems: "flex-start", gap: 1.25, p: "9px 18px",
                  borderBottom: 1, borderColor: "border.soft",
                }}
              >
                <Mono sx={{ color: "text.disabled", fontSize: 11.5, minWidth: 64 }}>
                  {e.ts ? new Date(e.ts).toLocaleTimeString() : ""}
                </Mono>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Tag sx={{ mr: 0.75 }}>{e.actor}</Tag>
                  <Mono>{e.action}</Mono>
                  {e.cluster && <Muted> · {e.cluster}</Muted>}
                  {e.message && <Muted sx={{ display: "block", fontSize: 12 }}>{e.message}</Muted>}
                </Box>
              </Box>
            ))}
          </Box>
        </Card>
      </Box>
    </Box>
  );
}
