import { Fragment } from "react";
import { Box, Link, Paper } from "@mui/material";
import { api } from "../api";
import type {
  CollectorClusterTiming, CollectorTimingsResponse, ManifestAvailabilityResponse, ManifestResponse,
} from "../api/types";
import { useFetch } from "../hooks";
import {
  Card, KeyLabel, KeyValues, Mono, Muted, SectionHead, StatGrid, StatusChip,
  ErrorBanner, DataTable, SkeletonLines, SkeletonTable, fmtBytes,
} from "../components";
import type { Column } from "../components";

/** One declared resource, as `/api/manifest` sends it. */
type ResourceRow = ManifestResponse["resources"][number];
/** One row of the availability matrix: a manifest key, per cluster. */
interface MatrixRow {
  resource: string;
}

interface ManifestProps {
  onOpen: (name: string) => void;
}

// Durations here span three orders of magnitude (a 40 ms health check, a 12 s
// fetch), so the unit follows the value rather than the column.
const fmtMs = (v: number | null | undefined) =>
  (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const fmtNum = (v: number | null | undefined) => (v == null ? "—" : Number(v).toLocaleString());
const fmtPercent = (v: number | null | undefined) => (v == null ? "—" : `${v}%`);

const RESOURCE_COLUMNS: Column<ResourceRow>[] = [
  {
    key: "domain", label: "Domain", className: "muted nowrap", filter: "select",
    sortValue: (r) => `${r.domain}/${r.key}`,
    filterValue: (r) => r.domain,
  },
  { key: "key", label: "Key", className: "mono nowrap", filter: "text" },
  { key: "kind", label: "Kind", className: "nowrap", filter: "select" },
  {
    key: "api_group", label: "API group", className: "mono muted nowrap", filter: "select",
    filterValue: (r) => `${r.api_group}/${r.version}`,
    render: (r) => `${r.api_group}/${r.version}`,
  },
  {
    key: "scope", label: "Scope", className: "muted nowrap", filter: "select",
    filterValue: (r) => r.scope,
    render: (r) => `${r.scope}${r.namespace_class && r.namespace_class !== "all" ? ` · ${r.namespace_class} only` : ""}${r.limit ? ` · limit ${r.limit}` : ""}`,
  },
  {
    key: "enabled", label: "Enabled", filter: "select",
    filterValue: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => <StatusChip status={r.enabled ? "enabled" : "disabled"} />,
  },
  {
    key: "description", label: "What it gives", className: "muted", filter: "text", width: "40%",
    render: (r) => <Box component="span" sx={{ fontSize: 12 }}>{r.description}</Box>,
  },
];

const TIMING_COLUMNS = (onOpen: (name: string) => void): Column<CollectorClusterTiming>[] => [
  {
    key: "cluster", label: "Cluster", className: "mono nowrap", filter: "text",
    render: (r) => <Link component="button" type="button" onClick={() => onOpen(r.cluster)}>{r.cluster}</Link>,
  },
  { key: "hub", label: "Hub", className: "muted nowrap", filter: "select" },
  {
    key: "total_ms", label: "Total", align: "right", className: "nowrap",
    render: (r) => fmtMs(r.total_ms),
  },
  {
    key: "cpu_ms", label: "CPU", align: "right", className: "nowrap",
    render: (r) => fmtMs(r.cpu_ms),
  },
  {
    key: "fetch_ms", label: "Fetch", align: "right", className: "nowrap muted",
    render: (r) => fmtMs(r.fetch_ms),
  },
  {
    key: "parse_ms", label: "Parse", align: "right", className: "nowrap muted",
    render: (r) => fmtMs(r.parse_ms),
  },
  {
    key: "assemble_ms", label: "Assemble", align: "right", className: "nowrap muted",
    render: (r) => fmtMs(r.assemble_ms),
  },
  {
    key: "health_ms", label: "Health", align: "right", className: "nowrap muted",
    render: (r) => fmtMs(r.health_ms),
  },
  {
    key: "persist_ms", label: "Persist", align: "right", className: "nowrap muted",
    render: (r) => fmtMs(r.persist_ms),
  },
  {
    key: "bytes", label: "Pulled", align: "right", className: "nowrap",
    render: (r) => fmtBytes(r.bytes),
  },
  {
    key: "objects", label: "Objects", align: "right", className: "nowrap",
    render: (r) => fmtNum(r.objects),
  },
  {
    key: "kinds_fetched", label: "Kinds fetched / cached", align: "right", className: "nowrap muted",
    sortValue: (r) => r.kinds_fetched,
    filterValue: (r) => `${r.kinds_fetched ?? "—"} / ${r.kinds_cached ?? "—"}`,
    render: (r) => `${r.kinds_fetched ?? "—"} / ${r.kinds_cached ?? "—"}`,
  },
];

interface TimingStatProps {
  label: string;
  value: string;
  sub: string;
  /** "accent" for the figure this card exists to draw attention to. */
  kind?: string;
}

/** A stat tile with a smaller number than the fleet counters: these are
 * durations and percentages, which need more room than a two-digit count. */
function TimingStat({ label, value, sub, kind }: TimingStatProps) {
  return (
    <Paper sx={{ p: "16px 18px" }}>
      <Box sx={{ color: "text.secondary", fontSize: 12.5 }}>{label}</Box>
      <Box sx={{ fontSize: 24, fontWeight: 700, mt: 0.5, color: kind === "accent" ? "primary.main" : undefined }}>
        {value}
      </Box>
      <Muted sx={{ display: "block", fontSize: 11.5, mt: 0.25 }}>{sub}</Muted>
    </Paper>
  );
}

interface TimingsProps {
  data: CollectorTimingsResponse;
  onOpen: (name: string) => void;
}

function Timings({ data, onOpen }: TimingsProps) {
  // Every read here has its own fallback: a build that collected nothing yet
  // answers with the keys missing rather than with zeroes, and the block says
  // "not measured" instead of "0 ms". The annotations are what keep that
  // defensiveness from turning every lookup into a union of {} and the rollup.
  const fleet: Partial<CollectorTimingsResponse["fleet"]> = data.fleet || {};
  const totals: Record<string, number> = fleet.totals || {};
  const share: Record<string, number | null> = fleet.share_percent || {};
  const p50: Record<string, number | null> = fleet.p50 || {};
  const p95: Record<string, number | null> = fleet.p95 || {};
  const last = data.last_run;
  const stages: string[] = data.stages || [];
  const measured = fleet.clusters || 0;

  return (
    <>
      {measured === 0 ? (
        <Muted sx={{ display: "block", p: "0 18px 14px", fontSize: 12.5 }}>
          No cluster has reported collection timings yet - they appear after the next sweep.
        </Muted>
      ) : (
        <Box sx={{ p: "0 18px 14px" }}>
          <StatGrid sx={{ gap: 1.5 }}>
            <TimingStat
              label="Collection time"
              value={fmtMs(totals.total_ms)}
              sub={`${measured} of ${fleet.clusters_total} clusters measured`}
            />
            <TimingStat
              label="Network (fetch)"
              value={fmtPercent(share.fetch_ms)}
              sub={fmtMs(totals.fetch_ms) + (fleet.bytes_per_fetch_second ? ` · ${fmtBytes(fleet.bytes_per_fetch_second)}/s` : "")}
            />
            <TimingStat
              label="Python CPU"
              kind="accent"
              value={fmtPercent(fleet.cpu_percent)}
              sub={fmtMs(totals.cpu_ms)
                + (fleet.parse_percent_of_fetch != null
                  ? ` · parsing is ${fleet.parse_percent_of_fetch}% of the fetch window` : "")}
            />
            <TimingStat
              label="Last sweep"
              value={fmtMs(last && last.duration_ms)}
              sub={last
                ? `${last.trigger} · ${last.clusters_total ?? "?"} clusters · ${fmtBytes(totals.bytes)} pulled`
                : "no completed sweep yet"}
            />
          </StatGrid>
          <Muted sx={{ display: "block", fontSize: 12.5, mt: 1.25 }}>
            Per cluster, p50 / p95:{" "}
            {stages.map((s, i) => (
              <Fragment key={s}>
                {i > 0 ? " · " : ""}
                <b>{s.replace("_ms", "")}</b> {fmtMs(p50[s])} / {fmtMs(p95[s])}
              </Fragment>
            ))}
            {" · "}<b>total</b> {fmtMs(p50.total_ms)} / {fmtMs(p95.total_ms)}
          </Muted>
        </Box>
      )}
      <DataTable
        id="collector.timings"
        columns={TIMING_COLUMNS(onOpen)}
        rows={data.clusters || []}
        rowKey="cluster"
        initialSort={{ key: "total_ms", dir: "desc" }}
        empty="No cluster has reported collection timings yet."
        searchPlaceholder="Search clusters"
        scroll
        dense
      />
    </>
  );
}

export default function Manifest({ onOpen }: ManifestProps) {
  const m = useFetch(() => api.manifest(), []);
  const av = useFetch(() => api.manifestAvailability(), []);
  const tm = useFetch(() => api.collectorTimings(), []);
  if (m.error && !m.data) return <ErrorBanner error={m.error} />;
  const d = m.data;
  const enabled = d ? d.resources.filter((r) => r.enabled).length : 0;
  const domains = d ? [...new Set(d.resources.map((r) => r.domain))] : [];

  return (
    // minmax(0, 1fr) rather than the default 1fr: a grid item's automatic
    // minimum is its content, so without this the widest table on the tab
    // stretches the column and the whole page scrolls sideways instead of the
    // table scrolling inside its own card.
    <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: "minmax(0, 1fr)" }}>
      <SectionHead
        title="What is collected"
        description={(
          <>
            The OCP API manifest declares everything the collector reads from a cluster - {d ? enabled : "…"} of {d ? d.resources.length : "…"} resources
            enabled from <Mono sx={{ overflowWrap: "anywhere" }}>{d ? d.source : "…"}</Mono>. Nothing outside
            it is ever requested, and the read-only RBAC is generated from it.
          </>
        )}
      />

      <Box sx={{
        display: "grid", gap: 2, alignItems: "start",
        gridTemplateColumns: { xs: "1fr", md: "1fr 1fr 1fr" },
      }}>
        <Card title="Never collected (scrub policy)">
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.375, fontSize: 12.5 }}>
            {!d ? <SkeletonLines rows={4} /> : d.scrub_policy.map((p) => (
              <span key={p.what}><b>{p.what}</b> <Muted>kept: {p.kept}</Muted></span>
            ))}
          </Box>
          <Muted sx={{ display: "block", fontSize: 12, mt: 1.25 }}>Enforced in the collector, not configurable.</Muted>
        </Card>
        <Card title="Namespace classification">
          {!d ? <SkeletonLines rows={6} /> : (
            <KeyValues>
              <KeyLabel>Platform names</KeyLabel><Mono sx={{ whiteSpace: "normal" }}>{d.namespaces.platform_names.join(", ")}</Mono>
              <KeyLabel>Platform prefixes</KeyLabel><Mono sx={{ whiteSpace: "normal" }}>{d.namespaces.platform_prefixes.join(", ")}</Mono>
              <KeyLabel>Platform labels</KeyLabel><Mono sx={{ whiteSpace: "normal" }}>{d.namespaces.platform_label_keys.join(", ") || "—"}</Mono>
              <KeyLabel>App label</KeyLabel><Mono sx={{ whiteSpace: "normal" }}>{d.namespaces.ownership.app.join(", ")}</Mono>
              <KeyLabel>Team label</KeyLabel><Mono sx={{ whiteSpace: "normal" }}>{d.namespaces.ownership.team.join(", ")}</Mono>
              <KeyLabel>Tier label</KeyLabel><Mono sx={{ whiteSpace: "normal" }}>{d.namespaces.ownership.tier.join(", ")}</Mono>
            </KeyValues>
          )}
          <Muted sx={{ display: "block", fontSize: 12, mt: 1.25 }}>Everything else is an application.</Muted>
        </Card>
        <Card title="Thresholds">
          {!d ? <SkeletonLines rows={4} /> : (
            <KeyValues>
              {Object.entries(d.thresholds).map(([k, v]) => (
                <Fragment key={k}>
                  <Mono sx={{ color: "text.secondary" }}>{k}</Mono>
                  <span>{Array.isArray(v) ? v.join(", ") : String(v)}</span>
                </Fragment>
              ))}
            </KeyValues>
          )}
        </Card>
      </Box>

      <Card
        flush
        title="Resources"
        description={d ? `${d.resources.length} declared across ${domains.length} domains.` : "…"}
      >
        {/* Twelve columns of prose do not fit a narrow window; the table scrolls
            inside the card rather than making the whole page scroll sideways. */}
        <Box sx={{ overflowX: "auto" }}>
          {!d ? <SkeletonTable columns={7} rows={10} /> : (
            <DataTable
              id="manifest.resources"
              columns={RESOURCE_COLUMNS}
              rows={d.resources}
              rowKey="key"
              initialSort={{ key: "domain", dir: "asc" }}
              empty="The manifest declares no resources."
            />
          )}
        </Box>
      </Card>

      <Card
        flush
        title="Availability per cluster"
        description="What each cluster actually served on the last sweep: object count when collected; n/a when the API is not served (e.g. no OLM); 403 when RBAC denies it."
      >
        {av.error && !av.data ? <ErrorBanner error={av.error} /> : !av.data ? <SkeletonTable columns={8} rows={8} /> : <Matrix data={av.data} onOpen={onOpen} />}
      </Card>

      <Card
        flush
        title="Collector timing"
        description={(
          <>
            What collecting each cluster cost on its last collection. <b>Fetch</b> is the network and the
            cluster&apos;s API server - it shrinks by asking for less, less often (tiered intervals, watches,
            metadata-only lists), not by writing the collector in another language. <b>Parse</b>, <b>assemble</b>,
            <b> health</b> and <b>persist</b> are CPU in Python, and are what a Go collector would shrink; the CPU
            column adds them up. Parsing is measured inside the fetch window, so a cluster&apos;s total is
            fetch + assemble + health + persist.
          </>
        )}
      >
        {tm.error && !tm.data ? <ErrorBanner error={tm.error} /> : !tm.data ? <SkeletonTable columns={11} rows={6} /> : <Timings data={tm.data} onOpen={onOpen} />}
      </Card>
    </Box>
  );
}

interface MatrixProps {
  data: ManifestAvailabilityResponse;
  onOpen: (name: string) => void;
}

/** What one cluster did with one manifest key, as a tinted box: the count when
 * it was collected, a word when it was not. */
const CELL_TONE: Record<string, string> = {
  collected: "healthy", forbidden: "critical", error: "critical",
};

function Matrix({ data, onOpen }: MatrixProps) {
  const label = (s: ManifestAvailabilityResponse["clusters"][number]["resources"][string] | undefined) => !s ? "—" : s.status === "collected" ? s.count : s.status === "unavailable" ? "n/a" : s.status === "forbidden" ? "403" : s.status === "error" ? "err" : "off";
  // One column per cluster, so only the resource column is sortable - a cluster
  // header stays the link that opens it.
  const columns: Column<MatrixRow>[] = [
    { key: "resource", label: "Resource", className: "mono", filter: "text" },
    // The return annotation is what contextually types `row` in the two
    // callbacks below - inside a `map` there is nothing else to take it from.
    ...data.clusters.map((c): Column<MatrixRow> => ({
      key: `cluster:${c.name}`,
      label: <Link component="button" type="button" onClick={() => onOpen(c.name)}>{c.name}</Link>,
      sortable: false,
      headerClassName: "rot",
      className: "cell",
      filterValue: (row) => c.resources[row.resource]?.status || "disabled",
      render: (row) => {
        const s = c.resources[row.resource];
        const status = s?.status || "disabled";
        const tone = CELL_TONE[status];
        return (
          <Box
            component="span"
            data-status={status}
            title={s?.error || (s ? `${s.status} · ${s.duration_ms} ms` : "")}
            sx={{
              display: "inline-block", minWidth: 26, px: 0.5, borderRadius: "4px",
              fontFamily: "inherit", fontSize: 11,
              color: (t) => (tone ? t.palette.status[tone as "healthy"].main : t.palette.text.disabled),
              bgcolor: (t) => (tone ? t.palette.status[tone as "healthy"].surface
                : status === "unavailable" ? t.palette.status.unknown.surface : "transparent"),
            }}
          >
            {label(s)}
          </Box>
        );
      },
    })),
  ];
  return (
    <Box sx={{ overflowX: "auto" }}>
      <DataTable
        id="manifest.availability"
        columns={columns}
        rows={data.resources.map((key) => ({ resource: key }))}
        rowKey="resource"
        initialSort={{ key: "resource", dir: "asc" }}
        empty="Nothing collected on the last sweep."
      />
    </Box>
  );
}
