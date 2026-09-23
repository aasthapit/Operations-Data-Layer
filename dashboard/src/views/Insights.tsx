import { useState } from "react";
import { Box, Checkbox, FormControlLabel, Link, Stack } from "@mui/material";
import { api } from "../api";
import type {
  CertificatesResponse, ClusterAdminsResponse, EventsResponse, ImageUsage, ImagesResponse,
  MachineConfigPoolsResponse, OlmOperatorsResponse, PodIssue, QuotasResponse, ReferencesResponse,
  RoutesResponse, StorageResponse,
} from "../api/types";
import { useFetch } from "../hooks";
import { useQueryFilters } from "../router";
import type { Nav, RouteApi } from "../router";
import {
  Card, Mono, Muted, SectionHead, StatusChip, Tag, ToneText,
  ErrorBanner, SubTabs, Pill, FilterSelect, DataTable, SearchInput, SkeletonTable,
  fmtBytes, fmtTime, fmtAge, fmtDays,
} from "../components";
import type { Column } from "../components";

/** What every section on this page is handed: the fleet's cluster names for its
 * dropdown, and the two ways out of the page. */
interface SectionProps {
  nav: Nav;
  route: RouteApi;
  clusterNames: string[];
}

/** The page itself reads the cluster names for its sections, so it takes only
 * what the shell hands every view plus which section the URL names. */
interface InsightsProps {
  section: string;
  nav: Nav;
  route: RouteApi;
}

type CertificateRow = CertificatesResponse["certificates"][number];
type QuotaRow = QuotasResponse["quotas"][number];
type OlmRow = OlmOperatorsResponse["operators"][number];
type OlmInstallRow = OlmRow["installs"][number];
type McpRow = MachineConfigPoolsResponse["pools"][number];
type StorageClassRow = StorageResponse["storage_classes"][number];
type PvcRow = StorageResponse["pvcs"][number];
type ReferenceRow = ReferencesResponse["references"][number];
type SubjectRow = ClusterAdminsResponse["subjects"][number];

// A route and an event are the router's own fields plus the collector's stored
// `summary` spread over the row, which the API types carry as an open record.
// These say which of those fields this page draws; intersecting narrows them
// from `unknown`, and the `rows` are asserted to them at the one place they
// enter the table.
type RouteRow = RoutesResponse["routes"][number] & {
  host?: string;
  path?: string | null;
  service?: string | null;
  port?: string | number | null;
  tls_termination?: string | null;
  insecure_policy?: string | null;
  routers?: string[];
};

type EventRow = EventsResponse["events"][number] & {
  last_at?: string | null;
  reason?: string | null;
  count?: number | null;
  source?: string | null;
  message?: string | null;
  involved: { kind?: string | null; name?: string | null };
};

/** One image grouping. Its own name lives under whatever `group_by` asked for,
 * which is why the API type keys it through an index signature. */
type ImageGroup = ImagesResponse["images"][number];

const SECTIONS: Array<[key: string, label: string]> = [
  ["certificates", "Certificates"], ["pods", "Pod issues"], ["quotas", "Quotas"], ["olm", "OLM operators"],
  ["mcp", "Machine config pools"], ["storage", "Storage"], ["routes", "Routes"], ["events", "Events"],
  ["images", "Images"], ["references", "Config references"], ["access", "Cluster admins"],
];

export default function Insights({ section, nav, route }: InsightsProps) {
  const clusters = useFetch(() => api.clusters(), []);
  const names = (clusters.data?.clusters || []).map((c) => c.name);
  // Each section is its own path (/insights/certificates) and keeps its filters
  // in that path's query string, so a section is a link and the back button
  // steps between sections rather than out of Insights.
  const props: SectionProps = { nav, route, clusterNames: names };
  return (
    <Stack spacing={2}>
      <SectionHead
        title="Insights"
        description="Fleet-wide views computed over what every cluster's API server reported on the last sweep."
      />
      <SubTabs tabs={SECTIONS} value={section} onChange={(s) => nav.goInsights(s)} />
      {section === "certificates" && <Certificates {...props} />}
      {section === "pods" && <PodIssues {...props} />}
      {section === "quotas" && <Quotas {...props} />}
      {section === "olm" && <Olm {...props} />}
      {section === "mcp" && <Mcp {...props} />}
      {section === "storage" && <Storage {...props} />}
      {section === "routes" && <Routes {...props} />}
      {section === "events" && <Events {...props} />}
      {section === "images" && <Images {...props} />}
      {section === "references" && <References {...props} />}
      {section === "access" && <Access {...props} />}
    </Stack>
  );
}

/** A column of small facts inside one table cell. */
function StackedList({ children }: { children?: React.ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.375, fontSize: 12 }}>{children}</Box>
  );
}

/** A row of controls belonging to one card, sitting on its title's line. */
function Filters({ children }: { children?: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={1.25} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
      {children}
    </Stack>
  );
}

// A cluster column that opens the cluster. The dropdowns above a table filter
// the API query, so the cluster column only takes a column filter where there
// is no server-side cluster select.
// `Row` is pinned by the caller's own column list, so the cluster column is
// the same column everywhere and still reads the row it is used with.
function clusterColumn<Row extends { cluster: string }>(nav: Nav,
  opts: Partial<Column<Row>> = {}): Column<Row> {
  return {
    key: "cluster",
    label: "Cluster",
    className: "mono",
    render: (r: Row) => (
      <Link component="button" type="button" onClick={() => nav.openCluster(r.cluster)}>{r.cluster}</Link>
    ),
    ...opts,
  };
}

// Worst first when a status column is sorted ascending.
const STATUS_RANK: Record<string, number> = {
  expired: 0, critical: 0, degraded: 0, failed: 0, error: 0, lost: 0, exhausted: 0, rejected: 0,
  expiring: 1, warning: 1, pending: 1, updating: 1, progressing: 1, unavailable: 1,
  paused: 2, suspended: 2,
};
const statusRank = (s: string | null | undefined) =>
  (s && s in STATUS_RANK ? STATUS_RANK[s] : 5);

// ---------------------------------------------------------------------------
function Certificates({ nav, route, clusterNames }: SectionProps) {
  const [f, set] = useQueryFilters(route, ["cluster", "class", "valid"]);
  const includeValid = f.valid === "1";
  const { data, error } = useFetch(
    () => api.certificates({ include_valid: includeValid, cluster: f.cluster, class: f.class }),
    [includeValid, f.cluster, f.class]);

  const columns: Column<CertificateRow>[] = [
    {
      key: "status", label: "Status", filter: "select",
      sortValue: (r) => statusRank(r.status),
      render: (r) => <StatusChip status={r.status} />,
    },
    {
      key: "days_left", label: "Expires in", className: "nowrap",
      filterValue: (r) => fmtDays(r.days_left),
      render: (r) => (
        <ToneText tone={r.days_left < 0 ? "critical" : r.days_left < 30 ? "warning" : undefined}>
          {fmtDays(r.days_left)}
        </ToneText>
      ),
    },
    clusterColumn(nav),
    { key: "environment", label: "Env", filter: "select", render: (r) => <Tag>{r.environment}</Tag> },
    {
      key: "namespace", label: "Namespace", className: "mono", filter: "text",
      render: (r) => <>{r.namespace} {r.class === "platform" && <Muted>(platform)</Muted>}</>,
    },
    {
      key: "kind", label: "Kind", className: "muted", filter: "select",
      filterValue: (r) => r.kind,
      render: (r) => `${r.kind}${r.secret_type ? ` · ${r.secret_type}` : ""}`,
    },
    { key: "name", label: "Name", filter: "text" },
    {
      key: "subject", label: "Subject", className: "mono muted wrap", filter: "text",
      filterValue: (r) => r.certificates[0]?.subject || "",
      render: (r) => r.certificates[0]?.subject,
    },
    {
      key: "issuer", label: "Issuer", className: "mono muted wrap", filter: "text",
      filterValue: (r) => r.certificates[0]?.issuer || "",
      render: (r) => r.certificates[0]?.issuer,
    },
    { key: "expires_at", label: "Not after", className: "muted nowrap", render: (r) => fmtTime(r.expires_at) },
  ];

  return (
    <Card flush title={`Certificates${data ? ` (${data.count})` : ""}`}
      description={`Parsed from TLS Secrets and PEM keys in ConfigMaps. Only subject / issuer / validity are kept - the certificate material is never collected. Window: ${data?.within_days ?? "…"} days.`}
      action={<Filters>
        <FilterSelect label="Cluster" value={f.cluster} options={clusterNames} onChange={(v) => set("cluster", v)} />
        <FilterSelect label="Class" value={f.class} options={["application", "platform"]} onChange={(v) => set("class", v)} />
        <FormControlLabel
          control={(
            <Checkbox checked={includeValid} onChange={(e) => set("valid", e.target.checked ? "1" : "")} />
          )}
          label="include valid"
        />
      </Filters>}>
      {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={9} rows={8} /> : (
        <DataTable
          id="insights.certificates"
          columns={columns}
          rows={data.certificates}
          rowKey={(r, i) => `${r.cluster}/${r.namespace}/${r.name}/${i}`}
          initialSort={{ key: "days_left", dir: "asc" }}
          empty="No certificates expiring within the window."
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function PodIssues({ nav, route, clusterNames }: SectionProps) {
  const [f, set] = useQueryFilters(route, ["class", "cluster"]);
  const { data, error } = useFetch(() => api.podIssues({ class: f.class, cluster: f.cluster }), [f.class, f.cluster]);

  const columns: Column<PodIssue>[] = [
    { key: "class", label: "Class", render: (i) => <Tag>{i.class}</Tag> },
    clusterColumn(nav, { sortValue: (i) => `${i.cluster}/${i.namespace}` }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    { key: "name", label: "Pod", filter: "text" },
    { key: "reason", label: "Reason", filter: "select", render: (i) => <Tag tone="critical">{i.reason}</Tag> },
    { key: "owner", label: "Owner", className: "muted", filter: "text", render: (i) => i.owner || "—" },
    { key: "restarts", label: "Restarts" },
    { key: "containers_ready", label: "Ready" },
    { key: "message", label: "Message", className: "muted wrap", filter: "text" },
    { key: "started_at", label: "Since", className: "muted", render: (i) => fmtAge(i.started_at) },
  ];

  return (
    <Card flush title={`Pod issues${data ? ` (${data.count})` : ""}`}
      description={data ? Object.entries(data.by_reason).map(([k, v]) => `${v} ${k}`).join(" · ") || "Nothing wrong." : ""}
      action={<Filters>
        <SubTabs tabs={[["", "All"], ["platform", "Platform"], ["application", "Apps"]]} value={f.class} onChange={(v) => set("class", v)} />
        <FilterSelect label="Cluster" value={f.cluster} options={clusterNames} onChange={(v) => set("cluster", v)} />
      </Filters>}>
      {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={9} rows={8} /> : (
        <DataTable
          id="insights.podIssues"
          columns={columns}
          rows={data.pod_issues}
          rowKey={(i, k) => `${i.cluster}/${i.namespace}/${i.name}/${k}`}
          initialSort={{ key: "cluster", dir: "asc" }}
          empty="No problem pods anywhere."
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Quotas({ nav }: SectionProps) {
  const { data, error } = useFetch(() => api.quotas(), []);

  const columns: Column<QuotaRow>[] = [
    {
      key: "status", label: "Status", filter: "select",
      sortValue: (q) => statusRank(q.status),
      render: (q) => <StatusChip status={q.status} />,
    },
    { key: "max_percent", label: "Peak", render: (q) => `${q.max_percent?.toFixed(0)}%` },
    clusterColumn(nav, { filter: "text" }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    { key: "name", label: "Quota", filter: "text" },
    {
      key: "resources", label: "Usage", className: "wrap",
      sortValue: (q) => q.resources.length,
      filterValue: (q) => q.resources.map((r) => r.resource).join(" "),
      render: (q) => (
        <StackedList>
          {q.resources.map((r) => (
            <span key={r.resource}>
              <Mono>{r.resource}</Mono>{" "}
              {/* a quota the collector could not read has no percentage, and
                  no percentage is not a breach */}
              <ToneText tone={(r.percent ?? 0) >= 90 ? "warning" : undefined}
                sx={(r.percent ?? 0) >= 90 ? undefined : { color: "text.disabled" }}>
                {r.used} / {r.hard} ({r.percent}%)
              </ToneText>
            </span>
          ))}
        </StackedList>
      ),
    },
  ];

  return (
    <Card flush title={`Resource quotas${data ? ` (${data.count})` : ""}`} description="Hard vs used per resource, worst first.">
      {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={6} rows={8} /> : (
        <DataTable
          id="insights.quotas"
          columns={columns}
          rows={data.quotas}
          rowKey={(q, i) => `${q.cluster}/${q.namespace}/${q.name}/${i}`}
          initialSort={{ key: "max_percent", dir: "desc" }}
          empty="No quotas collected."
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Olm({ nav }: SectionProps) {
  const { data, error } = useFetch(() => api.olmOperators(), []);
  // Which package's per-cluster installs are open, if any.
  const [open, setOpen] = useState<string | null>(null);

  const installColumns: Column<OlmInstallRow>[] = [
    clusterColumn(nav, { filter: "text" }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    { key: "csv", label: "CSV", className: "mono", filter: "text" },
    { key: "version", label: "Version", className: "mono", filter: "select" },
    {
      key: "phase", label: "Phase", filter: "select",
      filterValue: (i) => i.phase || "unknown",
      render: (i) => (
        <StatusChip status={i.phase || "unknown"}>
          {i.phase}{i.reason && i.unhealthy ? ` · ${i.reason}` : ""}
        </StatusChip>
      ),
    },
    { key: "upgrade_to", label: "Upgrade to", className: "mono", render: (i) => i.upgrade_to || <Muted>—</Muted> },
  ];

  const columns: Column<OlmRow>[] = [
    {
      key: "package", label: "Package", filter: "text",
      filterValue: (o) => `${o.display_name} ${o.package}`,
      render: (o) => <>{o.display_name} <Mono sx={{ color: "text.disabled" }}>{o.package}</Mono></>,
    },
    { key: "provider", label: "Provider", className: "muted", filter: "select" },
    { key: "clusters", label: "Clusters" },
    {
      key: "versions", label: "Versions in fleet", className: "mono", filter: "text",
      sortValue: (o) => o.distinct,
      filterValue: (o) => o.versions.map((v) => v.version).join(", "),
      render: (o) => o.versions.map((v) => `${v.version} (${v.count})`).join(", "),
    },
    {
      key: "distinct", label: "Drift",
      render: (o) => (o.distinct > 1 ? <Pill status="warning" /> : <Pill status="healthy" />),
    },
    {
      key: "unhealthy", label: "Unhealthy",
      render: (o) => (o.unhealthy ? <ToneText tone="critical">{o.unhealthy}</ToneText> : <Muted>0</Muted>),
    },
    {
      key: "upgrades_pending", label: "Upgrades pending",
      render: (o) => (o.upgrades_pending ? <ToneText tone="warning">{o.upgrades_pending}</ToneText> : <Muted>0</Muted>),
    },
    {
      key: "blast", label: "",
      render: (o) => (
        <Link component="button" type="button"
          onClick={(e) => { e.stopPropagation(); nav.goBlast({ olm_operator: o.package }); }}>blast radius →</Link>
      ),
    },
  ];

  return (
    <Card flush title={`OLM operators${data ? ` (${data.operators.length} packages)` : ""}`}
      description="ClusterServiceVersions across the fleet: version drift per package, install phase, pending upgrades from Subscriptions. Click a package for per-cluster detail.">
      {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={8} rows={8} /> : (
        <DataTable
          id="insights.olm"
          columns={columns}
          rows={data.operators}
          rowKey="package"
          onRowClick={(o) => setOpen(open === o.package ? null : o.package)}
          expanded={(o) => (open === o.package ? (
            <DataTable
              id="insights.olm.installs"
              columns={installColumns}
              rows={o.installs}
              rowKey={(i) => i.cluster + i.csv}
              initialSort={{ key: "cluster", dir: "asc" }}
              empty="No installs."
              dense
            />
          ) : null)}
          initialSort={{ key: "package", dir: "asc" }}
          empty="No OLM operators collected (no OLM on any cluster?)."
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Mcp({ nav }: SectionProps) {
  const { data, error } = useFetch(() => api.machineConfigPools(), []);

  const columns: Column<McpRow>[] = [
    {
      key: "status", label: "Status", filter: "select",
      sortValue: (p) => statusRank(p.status),
      render: (p) => <StatusChip status={p.status} />,
    },
    clusterColumn(nav, { filter: "text", sortValue: (p) => `${p.cluster}/${p.pool}` }),
    { key: "environment", label: "Env", filter: "select", render: (p) => <Tag>{p.environment}</Tag> },
    { key: "pool", label: "Pool", filter: "select" },
    { key: "machine_count", label: "Machines" },
    { key: "updated", label: "Updated" },
    { key: "ready", label: "Ready" },
    { key: "unavailable", label: "Unavailable" },
    { key: "degraded", label: "Degraded" },
    { key: "current_config", label: "Config", className: "mono muted", filter: "text" },
    { key: "message", label: "Message", className: "muted wrap", filter: "text" },
  ];

  return (
    <Card flush title={`Machine config pools${data ? ` (${data.count})` : ""}`}
      description="Node-level config rollout state per pool, degraded and updating first. The patching signal for OS / kubelet changes.">
      {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={10} rows={6} /> : (
        <DataTable
          id="insights.mcp"
          columns={columns}
          rows={data.pools}
          rowKey={(p, i) => `${p.cluster}/${p.pool}/${i}`}
          initialSort={{ key: "status", dir: "asc" }}
          empty="No machine config pools collected."
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Storage({ nav }: SectionProps) {
  const { data, error } = useFetch(() => api.storage(), []);
  if (error && !data) return <ErrorBanner error={error} />;

  const classColumns: Column<StorageClassRow>[] = [
    {
      key: "name", label: "Class", className: "mono", filter: "text",
      render: (s) => <>{s.name} {s.default && <Tag>default</Tag>}</>,
    },
    {
      key: "provisioners", label: "Provisioner", className: "mono muted", filter: "select",
      filterValue: (s) => s.provisioners.join(", "),
      render: (s) => s.provisioners.join(", ") || "—",
    },
    { key: "clusters", label: "Clusters", sortValue: (s) => s.clusters.length, filterValue: (s) => s.clusters.join(", "), render: (s) => s.clusters.length },
    { key: "pvcs", label: "PVCs" },
    { key: "bound", label: "Bound" },
    { key: "pending", label: "Pending", render: (s) => (s.pending ? <ToneText tone="warning">{s.pending}</ToneText> : 0) },
    { key: "requested_bytes", label: "Requested", render: (s) => fmtBytes(s.requested_bytes) },
  ];

  const pvcColumns: Column<PvcRow>[] = [
    {
      key: "status", label: "Status", filter: "select",
      sortValue: (p) => statusRank(p.status),
      render: (p) => <StatusChip status={p.status} />,
    },
    clusterColumn(nav, { filter: "text" }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    { key: "name", label: "Claim", filter: "text" },
    { key: "storage_class", label: "Class", className: "mono muted", filter: "select" },
    { key: "requested_bytes", label: "Requested", render: (p) => fmtBytes(p.requested_bytes) },
    { key: "capacity_bytes", label: "Bound", render: (p) => fmtBytes(p.capacity_bytes) },
    { key: "volume", label: "Volume", className: "mono muted", filter: "text", render: (p) => p.volume || "—" },
    {
      key: "mounted_by", label: "Mounted by", className: "muted wrap", filter: "text",
      sortValue: (p) => p.mounted_by.length,
      filterValue: (p) => p.mounted_by.join(", "),
      render: (p) => p.mounted_by.join(", ") || <i>not mounted</i>,
    },
  ];

  return (
    <Stack spacing={2}>
      <Card flush title="Storage classes" description="Provisioner per class, and the claims riding on it - the storage blast radius.">
        {!data ? <SkeletonTable columns={7} rows={5} /> : <DataTable
          id="insights.storageClasses"
          columns={classColumns}
          rows={data.storage_classes}
          rowKey="name"
          initialSort={{ key: "name", dir: "asc" }}
          empty="No storage classes collected."
        />}
      </Card>
      <Card flush title={`Persistent volume claims${data ? ` (${data.pvcs.length})` : ""}`} description="Pending first. Mounted-by comes from pod volumes.">
        {!data ? <SkeletonTable columns={9} rows={8} /> : <DataTable
          id="insights.pvcs"
          columns={pvcColumns}
          rows={data.pvcs}
          rowKey={(p, i) => `${p.cluster}/${p.namespace}/${p.name}/${i}`}
          initialSort={{ key: "status", dir: "asc" }}
          empty="No persistent volume claims collected."
          scroll
        />}
      </Card>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
function Routes({ nav, route }: SectionProps) {
  const [f, set] = useQueryFilters(route, ["host"]);
  const { data, error } = useFetch(() => api.routes({ host: f.host }), [f.host]);

  const columns: Column<RouteRow>[] = [
    { key: "host", label: "Host", className: "mono", sortValue: (r) => `${r.host}${r.path || ""}`, render: (r) => `${r.host}${r.path || ""}` },
    clusterColumn(nav, { filter: "text" }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    { key: "name", label: "Route", filter: "text" },
    {
      key: "service", label: "Service", filter: "text",
      filterValue: (r) => `${r.service}${r.port ? `:${r.port}` : ""}`,
      render: (r) => `${r.service}${r.port ? `:${r.port}` : ""}`,
    },
    {
      key: "tls_termination", label: "TLS", className: "muted", filter: "select",
      filterValue: (r) => r.tls_termination || "none",
      render: (r) => `${r.tls_termination || "none"}${r.insecure_policy ? ` · ${r.insecure_policy}` : ""}`,
    },
    {
      key: "status", label: "Status", filter: "select",
      sortValue: (r) => statusRank(r.status),
      render: (r) => <StatusChip status={r.status} />,
    },
    {
      key: "routers", label: "Router", className: "muted", filter: "select",
      filterValue: (r) => (r.routers || []).join(", "),
      render: (r) => (r.routers || []).join(", "),
    },
  ];

  return (
    <Card flush title={`Routes${data ? ` (${data.count})` : ""}`} description="Which cluster and namespace serves a hostname."
      action={<SearchInput placeholder="filter by host…" value={f.host} onChange={(v) => set("host", v)} />}>
      {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={8} rows={8} /> : (
        <DataTable
          id="insights.routes"
          columns={columns}
          rows={data.routes as RouteRow[]}
          rowKey={(r, i) => `${r.cluster}/${r.namespace}/${r.name}/${i}`}
          initialSort={{ key: "host", dir: "asc" }}
          empty="No routes match."
          scroll
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Events({ nav, route, clusterNames }: SectionProps) {
  const [f, set] = useQueryFilters(route, ["cluster", "class"]);
  const { data, error } = useFetch(() => api.events({ cluster: f.cluster, class: f.class, limit: 300 }), [f.cluster, f.class]);

  const columns: Column<EventRow>[] = [
    {
      key: "last_at", label: "When", className: "muted nowrap",
      filterValue: (e) => fmtAge(e.last_at),
      render: (e) => `${fmtAge(e.last_at)} ago`,
    },
    clusterColumn(nav),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    {
      key: "object", label: "Object", filter: "text",
      sortValue: (e) => `${e.involved.kind}/${e.involved.name}`,
      filterValue: (e) => `${e.involved.kind}/${e.involved.name}`,
      render: (e) => `${e.involved.kind}/${e.involved.name}`,
    },
    { key: "reason", label: "Reason", filter: "select", render: (e) => <Tag tone="warning">{e.reason}</Tag> },
    { key: "count", label: "Count" },
    { key: "source", label: "Source", className: "muted", filter: "select" },
    { key: "message", label: "Message", className: "muted wrap", filter: "text" },
  ];

  return (
    <Card flush title={`Warning events${data ? ` (${data.count})` : ""}`}
      description={data ? Object.entries(data.by_reason).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${v} ${k}`).join(" · ") : ""}
      action={<Filters>
        <SubTabs tabs={[["", "All"], ["platform", "Platform"], ["application", "Apps"]]} value={f.class} onChange={(v) => set("class", v)} />
        <FilterSelect label="Cluster" value={f.cluster} options={clusterNames} onChange={(v) => set("cluster", v)} />
      </Filters>}>
      {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={7} rows={9} /> : (
        <DataTable
          id="insights.events"
          columns={columns}
          rows={data.events as EventRow[]}
          rowKey={(e, i) => `${e.cluster}/${e.namespace}/${e.name}/${i}`}
          initialSort={{ key: "last_at", dir: "desc" }}
          empty="No warning events."
          scroll
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Images({ nav, route }: SectionProps) {
  const [f, set] = useQueryFilters(route, ["image", "group"]);
  const groupBy = ["image", "repository", "registry"].includes(f.group) ? f.group : "image";
  const { data, error } = useFetch(() => api.images({ image: f.image, group_by: groupBy }), [f.image, groupBy]);
  // Which group's workloads are open, if any.
  const [open, setOpen] = useState<string | null>(null);
  // The group's own name: it arrives under the key that was grouped by, so it
  // reaches the row through the index signature.
  const nameOf = (g: ImageGroup) => g[groupBy] as string;

  const workloadColumns: Column<ImageUsage>[] = [
    clusterColumn(nav, { filter: "text" }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    {
      key: "workload", label: "Workload", filter: "text",
      sortValue: (w) => `${w.kind}/${w.name}`,
      filterValue: (w) => `${w.kind}/${w.name}`,
      render: (w) => `${w.kind}/${w.name}`,
    },
    { key: "container", label: "Container", className: "muted", filter: "select" },
    { key: "image", label: "Image", className: "mono", filter: "text" },
  ];

  const columns: Column<ImageGroup>[] = [
    { key: groupBy, label: groupBy, className: "mono" },
    { key: "cluster_count", label: "Clusters" },
    { key: "workload_count", label: "Workloads" },
    {
      key: "blast", label: "",
      render: (g) => (groupBy === "image"
        ? (
          <Link component="button" type="button"
            onClick={(e) => { e.stopPropagation(); nav.goBlast({ image: nameOf(g) }); }}>blast radius →</Link>
        )
        : null),
    },
  ];

  return (
    <Card flush title={`Images${data ? ` (${data.count})` : ""}`} description="Which workloads run which images - the input to a CVE blast radius."
      action={<Filters>
        <SubTabs tabs={[["image", "Image"], ["repository", "Repository"], ["registry", "Registry"]]} value={groupBy} onChange={(v) => set("group", v)} />
        <SearchInput placeholder="filter images…" value={f.image} onChange={(v) => set("image", v)} />
      </Filters>}>
      {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={4} rows={8} /> : (
        <DataTable
          id={`insights.images.${groupBy}`}
          columns={columns}
          rows={data.images}
          rowKey={(g) => nameOf(g)}
          onRowClick={(g) => setOpen(open === nameOf(g) ? null : nameOf(g))}
          expanded={(g) => (open === nameOf(g) ? (
            <DataTable
              id="insights.images.workloads"
              columns={workloadColumns}
              rows={g.workloads}
              rowKey={(w, i) => `${w.cluster}/${w.namespace}/${w.kind}/${w.name}/${i}`}
              initialSort={{ key: "cluster", dir: "asc" }}
              empty="No workloads."
              dense
            />
          ) : null)}
          initialSort={{ key: "workload_count", dir: "desc" }}
          empty="No images match."
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function References({ nav, route }: SectionProps) {
  const KINDS = ["Secret", "ConfigMap", "PersistentVolumeClaim", "ServiceAccount"];
  const [f, set] = useQueryFilters(route, ["kind", "name"]);
  const kind = KINDS.includes(f.kind) ? f.kind : "Secret";
  const { data, error } = useFetch(() => api.references({ kind, name: f.name }), [kind, f.name]);

  const columns: Column<ReferenceRow>[] = [
    clusterColumn(nav, { filter: "text" }),
    { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
    { key: "name", label: kind },
    {
      key: "workloads", label: "Referenced by", className: "wrap",
      sortValue: (r) => r.workloads.length,
      filterValue: (r) => r.workloads.map((w) => `${w.kind}/${w.name}`).join(", "),
      render: (r) => (
        <StackedList>
          {r.workloads.map((w, k) => <span key={k}>{w.kind}/{w.name} <Muted>via {w.via}</Muted></span>)}
        </StackedList>
      ),
    },
  ];

  return (
    <Card flush title={`Config references${data ? ` (${data.count})` : ""}`}
      description="Which workloads reference a Secret / ConfigMap / PVC / ServiceAccount - the blast radius of rotating a secret or changing a config map."
      action={<Filters>
        <SubTabs tabs={[["Secret", "Secrets"], ["ConfigMap", "ConfigMaps"], ["PersistentVolumeClaim", "PVCs"], ["ServiceAccount", "Service accounts"]]} value={kind} onChange={(v) => set("kind", v)} />
        <SearchInput placeholder="exact name (optional)" value={f.name} onChange={(v) => set("name", v)} />
      </Filters>}>
      {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={4} rows={8} /> : (
        <DataTable
          id="insights.references"
          columns={columns}
          rows={data.references}
          rowKey={(r, i) => `${r.cluster}/${r.namespace}/${r.name}/${i}`}
          initialSort={{ key: "cluster", dir: "asc" }}
          empty="No references."
          scroll
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Access({ nav }: SectionProps) {
  const { data, error } = useFetch(() => api.clusterAdmins(), []);

  const columns: Column<SubjectRow>[] = [
    { key: "kind", label: "Kind", className: "muted", filter: "select" },
    {
      key: "name", label: "Subject", className: "mono", filter: "text",
      render: (s) => <>{s.name}{s.namespace ? <Muted> ({s.namespace})</Muted> : ""}</>,
    },
    { key: "role", label: "Role", className: "mono", filter: "select" },
    {
      key: "cluster_count", label: "Clusters",
      filterValue: (s) => s.clusters.join(", "),
      render: (s) => (
        <>
          {s.cluster_count}{" "}
          <Muted>· {s.clusters.map((c) => (
            <Link key={c} component="button" type="button" sx={{ mr: 0.75 }}
              onClick={() => nav.openCluster(c)}>{c}</Link>
          ))}</Muted>
        </>
      ),
    },
    {
      key: "bindings", label: "Bindings", className: "muted", filter: "text",
      filterValue: (s) => s.bindings.join(", "),
      render: (s) => s.bindings.join(", "),
    },
  ];

  return (
    <Card flush title={`Cluster admins${data ? ` (${data.count} subjects)` : ""}`}
      description="Subjects of ClusterRoleBindings to cluster-admin, with the clusters each holds it on.">
      {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={5} rows={6} /> : (
        <DataTable
          id="insights.access"
          columns={columns}
          rows={data.subjects}
          rowKey={(s, i) => `${s.kind}/${s.name}/${i}`}
          initialSort={{ key: "name", dir: "asc" }}
          empty="No cluster-admin bindings collected."
        />
      )}
    </Card>
  );
}
