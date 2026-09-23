import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Box, Button, Link, Stack, Tooltip, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { api } from "../api";
import type {
  CertificatesResponse, ClusterDetail as ClusterDocument, ClusterOperator, ClusterSummary,
  ClustersResponse, EventsResponse, NamespaceDetail, NodeDetail, PodIssue, ResourceRow,
  ResourceSummary, Workload,
} from "../api/types";
import * as cache from "../cache";
import { useFetch } from "../hooks";
import type { Nav } from "../router";
import Chart from "../Chart";
import {
  Card, KeyLabel, KeyValues, MONO_FONT, Mono, Muted, StatusChip, Tag, ToneText,
  Pill, ErrorBanner, Dot, SubTabs, UsageBar, Tier, FilterSelect, DataTable,
  Skeleton, SkeletonTable, fmtBytes, fmtCores, fmtTime, fmtAge, fmtDays,
} from "../components";
import type { Column } from "../components";

interface ClusterDetailProps {
  name: string;
  /** The sub-tab the URL names; anything else falls back to the overview. */
  tab?: string;
  nav: Nav;
}

type CertificateRow = CertificatesResponse["certificates"][number];

// An event is the router's own fields plus the collector's stored `summary`
// spread over the row, which the API type carries as an open record. This says
// which of those fields the table draws.
type EventRow = EventsResponse["events"][number] & {
  last_at?: string | null;
  reason?: string | null;
  count?: number | null;
  message?: string | null;
  involved: { kind?: string | null; name?: string | null };
};

const SECTIONS: Array<[key: string, label: string]> = [
  ["overview", "Overview"], ["namespaces", "Namespaces"], ["workloads", "Workloads"], ["nodes", "Nodes"],
  ["issues", "Issues"], ["operators", "Operators"], ["resources", "Resources"],
];

export default function ClusterDetail({ name, tab, nav }: ClusterDetailProps) {
  const section = tab && SECTIONS.some(([k]) => k === tab) ? tab : "overview";
  const { data: c, error } = useFetch(() => api.cluster(name), [name]);

  // The cluster list the user came from is still cached, so the header - name,
  // hub, status, version - is on screen before the detail response lands.
  const summary = cache.search<ClustersResponse, ClusterSummary>("/api/clusters",
    (d) => (d.clusters || []).find((x) => x.name === name));
  const head = c || summary;

  if (error && !c) return <ErrorBanner error={error} />;

  // A cluster the collector could not reach reports null rather than zero for
  // most of these, and `SubTab` already draws no badge for a count that is not
  // there - so the nulls are carried through rather than flattened.
  const counts: Record<string, number | null | undefined> = c ? {
    // The two namespace counts are summed, so one of them being absent must
    // not take the other with it: this is the arithmetic the page has always
    // done, now written where a null can be seen.
    namespaces: (c.namespaces.application || 0) + (c.namespaces.platform || 0),
    workloads: c.workloads,
    nodes: c.nodes.total,
    issues: c.pod_issues,
    operators: c.operators.length,
  } : {};

  return (
    <Box>
      <Link
        component="button"
        type="button"
        color="text.secondary"
        onClick={() => nav.back("/clusters")}
        sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, mb: 1.25, fontSize: 13 }}
      >
        <ArrowBackIcon fontSize="inherit" /> All clusters
      </Link>
      <Box sx={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 1.5, flexWrap: "wrap", mb: 1.5,
      }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.75, flexWrap: "wrap" }}>
          <Typography variant="h1" component="h2" sx={{ fontFamily: MONO_FONT }}>{name}</Typography>
          {head ? <Pill status={head.overall_status} /> : <Skeleton width={78} height={20} />}
          {head && <Mono sx={{ color: "text.disabled" }}>{head.hub} · {head.ocp_version}</Mono>}
          {head?.upgrading && <Tag>upgrading → {head.desired_version} ({head.upgrade_percent}%)</Tag>}
          {head && !head.reachable && <Tag tone="critical">unreachable</Tag>}
        </Box>
        <SubTabs
          tabs={SECTIONS.map(([k, l]) => [k, l, counts[k]])}
          value={section}
          onChange={(s) => nav.openCluster(name, s)}
        />
      </Box>
      {c?.last_error && <Alert severity="error" sx={{ mb: 2 }}>{c.last_error}</Alert>}

      {/* Workloads fetch for themselves, so a deep link to that sub-tab does not
          wait on the cluster document; everything else is a slice of it. */}
      {section === "workloads" ? <WorkloadsSection name={name} />
        : !c ? <SectionSkeleton />
          : section === "namespaces" ? <NamespacesSection c={c} nav={nav} />
            : section === "nodes" ? <NodesSection c={c} />
              : section === "issues" ? <IssuesSection c={c} />
                : section === "operators" ? <OperatorsSection c={c} nav={nav} />
                  : section === "resources" ? <ResourcesSection c={c} />
                    : <OverviewSection c={c} nav={nav} />}
    </Box>
  );
}

function SectionSkeleton() {
  return <Card flush><SkeletonTable columns={7} rows={9} /></Card>;
}

// ---------------------------------------------------------------------------
/** Every section below is a slice of the one cluster document. */
interface SectionProps {
  c: ClusterDocument;
  nav: Nav;
}

function OverviewSection({ c, nav }: SectionProps) {
  const tl = useFetch(() => api.timeline(c.name), [c.name]);
  const snaps = tl.data?.snapshots || [];
  // The timeline drawn by the same chart the Query page uses: two series that
  // share one 0-100 scale, so there is one axis and no invented correlation.
  const history = useMemo(() => ({
    columns: ["at", "health_score", "cpu_percent"],
    types: ["TIMESTAMP", "INTEGER", "DOUBLE"],
    rows: snaps.map((s) => [
      s.at,
      s.health_score,
      s.cpu_used_cores != null && s.cpu_allocatable_cores
        ? (100 * s.cpu_used_cores) / s.cpu_allocatable_cores
        : null,
    ]),
  }), [snaps]);
  const cap = c.capacity;
  const pc = c.platform_config;
  return (
    <Stack spacing={2}>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, gap: 2 }}>
        <Card title="Cluster">
          <KeyValues>
            <KeyLabel>Hub</KeyLabel><Mono>{c.hub}</Mono>
            <KeyLabel>Region / DC</KeyLabel><span>{c.region} / {c.datacenter}</span>
            <KeyLabel>Environment</KeyLabel><span><Tag>{c.environment}</Tag></span>
            <KeyLabel>Platform</KeyLabel><span>{c.platform} · {c.cloud} · {pc.control_plane_topology || "—"}</span>
            <KeyLabel>API</KeyLabel><Mono>{pc.api_url || "—"}</Mono>
            <KeyLabel>Apps domain</KeyLabel><Mono>{pc.apps_domain || "—"}</Mono>
            <KeyLabel>Network</KeyLabel>
            <Mono>{pc.network_type || "—"} {pc.cluster_network.length > 0 && <Muted>· pods {pc.cluster_network.join(", ")} · services {pc.service_network.join(", ")}</Muted>}</Mono>
            <KeyLabel>OCP version</KeyLabel><Mono>{c.ocp_version} <Muted>· {c.channel}</Muted></Mono>
            <KeyLabel>Kubernetes</KeyLabel><Mono>{c.kube_version}</Mono>
            {c.available_updates?.length > 0 && (
              <><KeyLabel>Updates</KeyLabel><Mono>{c.available_updates.join(", ")}</Mono></>
            )}
            <KeyLabel>Nodes ready</KeyLabel><span>{c.nodes.ready}/{c.nodes.total}</span>
            <KeyLabel>Namespaces</KeyLabel><span>{c.namespaces.application} applications · {c.namespaces.platform} platform</span>
            <KeyLabel>Workloads</KeyLabel><span>{c.workloads}</span>
            <KeyLabel>Health score</KeyLabel><span>{c.health_score}/100</span>
            <KeyLabel>Last collected</KeyLabel><Muted>{fmtTime(c.last_synced)} · {c.collect_ms} ms</Muted>
          </KeyValues>
        </Card>

        <Card label="Capacity" title={(
          <>
            Capacity {cap.metrics_available
              ? <Muted sx={{ textTransform: "none", fontWeight: 400 }}>· live usage from metrics.k8s.io</Muted>
              : <StatusChip status="warning">metrics.k8s.io unavailable</StatusChip>}
          </>
        )}>
          <CapacityRow label="CPU" used={cap.cpu.used_cores} req={cap.cpu.requests_cores} alloc={cap.cpu.allocatable_cores}
            pct={cap.cpu.used_percent} reqPct={cap.cpu.requests_percent} fmt={fmtCores} />
          <CapacityRow label="Memory" used={cap.memory.used_bytes} req={cap.memory.requests_bytes} alloc={cap.memory.allocatable_bytes}
            pct={cap.memory.used_percent} reqPct={cap.memory.requests_percent} fmt={fmtBytes} />
          <CapacityRow label="Pods" used={cap.pods.running} alloc={cap.pods.capacity} pct={cap.pods.used_percent} fmt={(v) => `${v}`} />
          <Typography variant="h4" color="text.secondary" sx={{ mt: 2.25, mb: 1.75 }}>History</Typography>
          {snaps.length > 1 ? (
            <Chart
              columns={history.columns}
              columnTypes={history.types}
              rows={history.rows}
              spec={{ type: "line", x: "at", series: "", y: ["health_score", "cpu_percent"], stack: false }}
              height={170}
              tableBelow={false}
            />
          ) : (
            <Muted sx={{ display: "block", fontSize: 12 }}>
              {tl.error ? "History is unavailable." : "Not enough sweeps yet for a trend."}
            </Muted>
          )}
          <Muted sx={{ display: "block", fontSize: 12, mt: 0.5 }}>
            {snaps.length} sweeps · health score and CPU % of allocatable
          </Muted>
        </Card>
      </Box>

      <Card title="Precondition checks">
        <Box component="ul" aria-label="Precondition checks" sx={{ listStyle: "none", m: 0, p: 0 }}>
          {c.health_checks.map((h) => (
            <Box
              component="li"
              key={h.name}
              sx={{
                display: "flex", alignItems: "center", gap: 1.25, p: "9px 6px",
                borderBottom: 1, borderColor: "border.soft",
              }}
            >
              <Dot status={h.status} />
              {/* a failed check names itself in its own colour; the severity
                  beside it stays quiet either way */}
              <ToneText tone={CHECK_TONE[h.status]} sx={{ flex: 1 }}>
                {h.title} <Muted sx={{ fontSize: 11 }}>· {h.severity}</Muted>
              </ToneText>
              {h.message && <Muted sx={{ fontSize: 12.5 }}>{h.message}</Muted>}
            </Box>
          ))}
        </Box>
      </Card>

      <Box sx={{ display: "flex", gap: 1.25 }}>
        <Button variant="outlined" color="inherit" onClick={() => nav.goBlast({ ocp_version: c.ocp_version })}>
          Blast radius for OCP {c.ocp_version} →
        </Button>
      </Box>
    </Stack>
  );
}

/** What a precondition check's own verdict means. `pass` wears no colour: a
 * list where every line is green is a list nobody reads. */
const CHECK_TONE: Record<string, string | undefined> = {
  fail: "critical", warn: "warning", pass: undefined,
};

interface CapacityRowProps {
  label: string;
  /** Usage is null when the cluster serves no metrics; the bar is then empty
   * rather than zero, which is a different thing to say. */
  used: number | null;
  req?: number | null;
  alloc: number | null;
  pct: number | null;
  reqPct?: number | null;
  fmt: (v: number | null) => string;
}

function CapacityRow({ label, used, req, alloc, pct, reqPct, fmt }: CapacityRowProps) {
  const tone = pct == null ? "unknown" : pct >= 95 ? "critical" : pct >= 85 ? "warning" : "healthy";
  const caption = pct == null ? "metrics unavailable" : `${pct.toFixed(1)}% of allocatable`;
  return (
    <Box sx={{ mb: 1.25 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, mb: 0.375 }}>
        <span>{label} {pct != null && <Muted>· {pct.toFixed(0)}%</Muted>}</span>
        <Box component="span" sx={{ color: "text.secondary" }}>
          {used != null ? <>{fmt(used)} used</> : <Muted>usage n/a</Muted>}
          {req != null && <Muted> · {fmt(req)} requested{reqPct != null && ` (${reqPct.toFixed(0)}%)`}</Muted>}
          <Muted> · {fmt(alloc)} allocatable</Muted>
        </Box>
      </Box>
      <Tooltip title={caption}>
        <Box sx={{
          display: "flex", position: "relative", height: 10, borderRadius: "6px",
          overflow: "hidden", bgcolor: "background.subtle",
        }}>
          {pct != null && (
            <Box component="span" sx={{
              height: "100%", width: `${Math.min(100, pct)}%`,
              bgcolor: (t) => t.palette.status[tone as "healthy"].main,
            }} />
          )}
          {/* where the requests sit, against what is actually being used */}
          {reqPct != null && (
            <Box component="span" sx={{
              position: "absolute", top: -2, bottom: -2, width: 2, opacity: 0.8,
              left: `${Math.min(100, reqPct)}%`, bgcolor: "text.secondary",
            }} />
          )}
        </Box>
      </Tooltip>
    </Box>
  );
}

// ---------------------------------------------------------------------------
function NamespacesSection({ c, nav }: SectionProps) {
  const apps = c.namespaces_detail.filter((n) => n.class === "application");
  const platform = c.namespaces_detail.filter((n) => n.class === "platform");
  return (
    <Stack spacing={2}>
      <NamespaceTable id="cluster.namespaces.application" title={`Applications (${apps.length})`} rows={apps} showOwner nav={nav}
        desc="Every non-platform namespace is an application. Ownership comes from labels on the namespace, then its workloads." />
      <NamespaceTable id="cluster.namespaces.platform" title={`OpenShift platform namespaces (${platform.length})`} rows={platform} nav={nav}
        desc="The cluster's own namespaces, grouped separately (openshift-*, kube-*, default…)." />
    </Stack>
  );
}

interface NamespaceTableProps {
  id: string;
  title: string;
  rows: NamespaceDetail[];
  /** The platform table has no owner to show, so those columns are left out. */
  showOwner?: boolean;
  desc: string;
  nav: Nav;
}

// Who owns the namespace. Only the application table shows it, so the three
// columns are their own list - a list spread into another one is not
// contextually typed by it, and would widen `filter` back to `string`.
const OWNER_COLUMNS: Column<NamespaceDetail>[] = [
  { key: "app", label: "App", filter: "text" },
  { key: "team", label: "Team", className: "muted", filter: "select", render: (n) => n.team || "—" },
  { key: "tier", label: "Tier", filter: "select", render: (n) => <Tier tier={n.tier} /> },
];

function NamespaceTable({ id, title, rows, showOwner, desc, nav }: NamespaceTableProps) {
  const columns: Column<NamespaceDetail>[] = [
    { key: "name", label: "Namespace", className: "mono", filter: "text" },
    ...(showOwner ? OWNER_COLUMNS : []),
    { key: "status", label: "Status", filter: "select", render: (n) => <Pill status={n.status} /> },
    { key: "workloads", label: "Workloads" },
    {
      key: "replicas_ready", label: "Replicas",
      filterValue: (n) => `${n.replicas_ready}/${n.replicas_desired}`,
      render: (n) => `${n.replicas_ready}/${n.replicas_desired}`,
    },
    {
      key: "pods", label: "Pods",
      sortValue: (n) => n.pods.running,
      filterValue: (n) => `${n.pods.running}/${n.pods.total}`,
      render: (n) => (
        <>
          {n.pods.running}<Muted>/{n.pods.total}</Muted>
          {n.pods.pending ? <ToneText tone="warning"> +{n.pods.pending} pending</ToneText> : null}
        </>
      ),
    },
    {
      key: "restarts", label: "Restarts",
      sortValue: (n) => n.pods.restarts,
      render: (n) => n.pods.restarts || <Muted>0</Muted>,
    },
    {
      key: "issues", label: "Issues",
      sortValue: (n) => n.pods.issues,
      render: (n) => (n.pods.issues ? <ToneText tone="warning">{n.pods.issues}</ToneText> : <Muted>0</Muted>),
    },
    {
      key: "cpu", label: "CPU used / req", className: "nowrap",
      sortValue: (n) => n.cpu.used_cores,
      filterValue: (n) => `${fmtCores(n.cpu.used_cores)} / ${fmtCores(n.cpu.requests_cores)}`,
      render: (n) => <>{fmtCores(n.cpu.used_cores)} <Muted>/ {fmtCores(n.cpu.requests_cores)}</Muted></>,
    },
    {
      key: "memory", label: "Memory used / req", className: "nowrap",
      sortValue: (n) => n.memory.used_bytes,
      filterValue: (n) => `${fmtBytes(n.memory.used_bytes)} / ${fmtBytes(n.memory.requests_bytes)}`,
      render: (n) => <>{fmtBytes(n.memory.used_bytes)} <Muted>/ {fmtBytes(n.memory.requests_bytes)}</Muted></>,
    },
    {
      key: "resource_counts", label: "Resources", className: "muted",
      sortValue: (n) => Object.values(n.resource_counts).reduce((a, b) => a + b, 0),
      filterValue: (n) => Object.keys(n.resource_counts).join(" "),
      render: (n) => <Box component="span" sx={{ fontSize: 11.5 }}>{Object.entries(n.resource_counts).map(([k, v]) => `${v} ${k}`).join(" · ") || "—"}</Box>,
    },
  ];
  return (
    <Card flush title={title} description={desc}>
      <DataTable
        id={id}
        columns={columns}
        rows={rows}
        rowKey="name"
        onRowClick={showOwner ? (n) => nav.openApp(n.app) : undefined}
        initialSort={{ key: "name", dir: "asc" }}
        empty="None."
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
const workloadKey = (w: Workload) => `${w.namespace}/${w.kind}/${w.name}`;

const WORKLOAD_COLUMNS: Column<Workload>[] = [
  { key: "namespace", label: "Namespace", className: "mono", filter: "text", sortValue: (w) => `${w.namespace}/${w.name}` },
  { key: "kind", label: "Kind", className: "muted", filter: "select" },
  { key: "name", label: "Name", filter: "text" },
  { key: "status", label: "Status", filter: "select", render: (w) => <StatusChip status={w.status} /> },
  {
    key: "replicas", label: "Replicas", className: "nowrap",
    sortValue: (w) => w.replicas.ready,
    filterValue: (w) => `${w.replicas.ready}/${w.replicas.desired}`,
    render: (w) => (
      <>
        {w.replicas.ready}/{w.replicas.desired}
        {(w.replicas.updated ?? 0) < (w.replicas.desired ?? 0)
          && <Muted> · {w.replicas.updated} updated</Muted>}
      </>
    ),
  },
  {
    key: "images", label: "Images", className: "mono wrap", filter: "text",
    sortValue: (w) => w.images.join(", "),
    render: (w) => w.images.join(", "),
  },
  {
    key: "config_refs", label: "Config refs", className: "muted",
    // `config_refs`, `containers`, `labels` and `node_selector` only arrive
    // with detail=true (which this table always asks for), so the type has
    // them optional and every read here says what an absent one counts as.
    sortValue: (w) => w.config_refs?.length ?? 0,
    render: (w) => w.config_refs?.length ?? 0,
  },
  { key: "service_account", label: "SA", className: "muted", filter: "select" },
  { key: "created_at", label: "Age", className: "muted", render: (w) => fmtAge(w.created_at) },
];

function WorkloadsSection({ name }: { name: string }) {
  const [cls, setCls] = useState("");
  const [ns, setNs] = useState("");
  // Which workload's containers are open, if any.
  const [open, setOpen] = useState<string | null>(null);
  const { data, error } = useFetch(() => api.clusterWorkloads(name, { class: cls, namespace: ns, detail: true }), [name, cls, ns]);
  const namespaces = [...new Set((data?.workloads || []).map((w) => w.namespace))].sort();
  return (
    <Card
      flush
      title="Workloads"
      description="Env var names and their Secret / ConfigMap sources are collected; values never are. Click a row for containers."
      action={(
        <Filters>
          <SubTabs tabs={[["", "All"], ["application", "Apps"], ["platform", "Platform"]]} value={cls} onChange={(v) => { setCls(v); setNs(""); }} />
          <FilterSelect label="Namespace" value={ns} options={namespaces} onChange={setNs} />
        </Filters>
      )}
    >
      {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={9} rows={8} /> : (
        <DataTable
          id="cluster.workloads"
          columns={WORKLOAD_COLUMNS}
          rows={data.workloads}
          rowKey={workloadKey}
          onRowClick={(w) => setOpen(open === workloadKey(w) ? null : workloadKey(w))}
          expanded={(w) => (open === workloadKey(w) ? <WorkloadDetail w={w} /> : null)}
          initialSort={{ key: "namespace", dir: "asc" }}
          empty="No workloads."
        />
      )}
    </Card>
  );
}

/** A row of controls belonging to one card, sitting on its title's line. */
function Filters({ children }: { children?: ReactNode }) {
  return (
    <Stack direction="row" spacing={1.25} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
      {children}
    </Stack>
  );
}

/** A column of small facts inside one cell or field. */
function StackedList({ children, sx }: { children?: ReactNode; sx?: object }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.375, fontSize: 12, ...sx }}>
      {children}
    </Box>
  );
}

function WorkloadDetail({ w }: { w: Workload }) {
  return (
    <Box sx={{
      display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, gap: 2, p: "6px 4px",
    }}>
      {(w.containers || []).map((c) => (
        <Card key={c.name} title={`container ${c.name}`} sx={{ p: 1.5 }}>
          <KeyValues>
            <KeyLabel>Image</KeyLabel><Mono>{c.image}</Mono>
            <KeyLabel>Requests</KeyLabel><Mono>{Object.entries(c.requests || {}).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}</Mono>
            <KeyLabel>Limits</KeyLabel><Mono>{Object.entries(c.limits || {}).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}</Mono>
            <KeyLabel>Env</KeyLabel>
            <StackedList>
              {(c.env || []).length === 0 && <Muted>none</Muted>}
              {(c.env || []).map((e) => (
                <span key={e.name}><Mono>{e.name}</Mono> <Muted>
                  {e.from?.kind === "literal" ? "= (value scrubbed)"
                    : e.from?.kind === "field" ? `← field ${e.from.path}`
                    : e.from?.kind ? `← ${e.from.kind} ${e.from.name}${e.from.key ? `/${e.from.key}` : ""}` : ""}
                </Muted></span>
              ))}
              {(c.env_from || []).map((e, i) => <Muted key={i}>envFrom ← {e.kind} {e.name}</Muted>)}
            </StackedList>
          </KeyValues>
        </Card>
      ))}
      <Card title="References" sx={{ p: 1.5 }}>
        <StackedList>
          {(w.config_refs || []).map((r, i) => (
            <span key={i}><Muted>{r.kind}</Muted> <Mono>{r.name}</Mono> <Muted>via {r.via}</Muted></span>
          ))}
          {(w.config_refs || []).length === 0 && <Muted>none</Muted>}
        </StackedList>
        <KeyValues sx={{ mt: 1.25 }}>
          <KeyLabel>Labels</KeyLabel><Mono sx={{ whiteSpace: "normal" }}>{Object.entries(w.labels || {}).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}</Mono>
          <KeyLabel>Strategy</KeyLabel><span>{w.strategy || "—"}</span>
          <KeyLabel>Node selector</KeyLabel><Mono>{Object.entries(w.node_selector || {}).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}</Mono>
        </KeyValues>
      </Card>
    </Box>
  );
}

// ---------------------------------------------------------------------------
const nodePressure = (n: NodeDetail) =>
  Object.entries(n.conditions).filter(([, v]) => v).map(([k]) => k);
const nodeState = (n: NodeDetail) =>
  (!n.ready ? "critical" : nodePressure(n).length || !n.schedulable ? "warning" : "healthy");

const NODE_COLUMNS: Column<NodeDetail>[] = [
  { key: "name", label: "Node", className: "mono", filter: "text" },
  {
    key: "roles", label: "Roles", filter: "select",
    filterValue: (n) => n.roles.join(", "),
    render: (n) => n.roles.map((r) => <Tag key={r} sx={{ mr: 0.5 }}>{r}</Tag>),
  },
  {
    key: "state", label: "State", filter: "select",
    sortValue: (n) => ({ critical: 0, warning: 1, healthy: 2 } as Record<string, number>)[nodeState(n)],
    filterValue: (n) => nodeState(n),
    render: (n) => {
      const pressure = nodePressure(n);
      return (
        <>
          <Pill status={nodeState(n)} />
          {!n.schedulable && <Muted> cordoned</Muted>}
          {pressure.length > 0 && <Muted> {pressure.join(", ")}</Muted>}
        </>
      );
    },
  },
  {
    key: "cpu", label: "CPU used / alloc", className: "nowrap",
    sortValue: (n) => n.cpu.used_percent,
    filterValue: (n) => `${n.cpu.used_cores != null ? n.cpu.used_cores.toFixed(2) : ""} / ${n.cpu.allocatable_cores}`,
    render: (n) => (
      <>
        <UsageBar percent={n.cpu.used_percent} width={70} />{" "}
        <Muted>{n.cpu.used_cores != null ? n.cpu.used_cores.toFixed(2) : "—"} / {n.cpu.allocatable_cores}</Muted>
      </>
    ),
  },
  {
    key: "memory", label: "Memory used / alloc", className: "nowrap",
    sortValue: (n) => n.memory.used_percent,
    filterValue: (n) => `${fmtBytes(n.memory.used_bytes)} / ${fmtBytes(n.memory.allocatable_bytes)}`,
    render: (n) => (
      <>
        <UsageBar percent={n.memory.used_percent} width={70} />{" "}
        <Muted>{fmtBytes(n.memory.used_bytes)} / {fmtBytes(n.memory.allocatable_bytes)}</Muted>
      </>
    ),
  },
  {
    key: "pods", label: "Pods",
    sortValue: (n) => n.pods.running,
    filterValue: (n) => `${n.pods.running}/${n.pods.capacity}`,
    render: (n) => <>{n.pods.running}<Muted>/{n.pods.capacity}</Muted></>,
  },
  { key: "kubelet_version", label: "Kubelet", className: "mono", filter: "select" },
  { key: "os_image", label: "OS", className: "muted wrap", filter: "text" },
  { key: "container_runtime", label: "Runtime", className: "mono", filter: "select" },
  {
    key: "zone", label: "Zone / type", className: "muted", filter: "select",
    filterValue: (n) => [n.zone, n.instance_type].filter(Boolean).join(" · "),
    render: (n) => [n.zone, n.instance_type].filter(Boolean).join(" · ") || "—",
  },
  {
    key: "images", label: "Images", className: "muted nowrap",
    sortValue: (n) => n.images.bytes,
    filterValue: (n) => `${n.images.count}`,
    render: (n) => `${n.images.count} · ${fmtBytes(n.images.bytes)}`,
  },
  { key: "created_at", label: "Age", className: "muted", render: (n) => fmtAge(n.created_at) },
];

function NodesSection({ c }: { c: ClusterDocument }) {
  return (
    <Card flush title={`Nodes (${c.nodes_detail.length})`}>
      <DataTable
        id="cluster.nodes"
        columns={NODE_COLUMNS}
        rows={c.nodes_detail}
        rowKey="name"
        initialSort={{ key: "name", dir: "asc" }}
        empty="No nodes collected."
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
const POD_ISSUE_COLUMNS: Column<PodIssue>[] = [
  { key: "class", label: "Class", filter: "select", render: (i) => <Tag>{i.class}</Tag> },
  { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
  { key: "name", label: "Pod", filter: "text" },
  { key: "reason", label: "Reason", filter: "select", render: (i) => <Tag tone="critical">{i.reason}</Tag> },
  { key: "owner", label: "Owner", className: "muted", filter: "text", render: (i) => i.owner || "—" },
  { key: "node", label: "Node", className: "muted", filter: "select", render: (i) => i.node || "—" },
  { key: "restarts", label: "Restarts" },
  { key: "containers_ready", label: "Ready" },
  { key: "message", label: "Message", className: "muted wrap", filter: "text" },
  { key: "started_at", label: "Since", className: "muted", render: (i) => fmtAge(i.started_at) },
];

const CLUSTER_CERT_COLUMNS: Column<CertificateRow>[] = [
  { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
  { key: "kind", label: "Kind", className: "muted", filter: "select" },
  { key: "name", label: "Name", filter: "text" },
  { key: "status", label: "Status", filter: "select", render: (r) => <StatusChip status={r.status} /> },
  {
    key: "days_left", label: "Expires", className: "nowrap",
    filterValue: (r) => fmtDays(r.days_left),
    render: (r) => <>{fmtDays(r.days_left)} <Muted>· {fmtTime(r.expires_at)}</Muted></>,
  },
  {
    key: "subject", label: "Subject", className: "mono muted", filter: "text",
    filterValue: (r) => r.certificates[0]?.subject || "",
    render: (r) => r.certificates[0]?.subject,
  },
];

const CLUSTER_EVENT_COLUMNS: Column<EventRow>[] = [
  {
    key: "last_at", label: "When", className: "muted nowrap",
    filterValue: (e) => fmtAge(e.last_at),
    render: (e) => `${fmtAge(e.last_at)} ago`,
  },
  { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
  {
    key: "object", label: "Object", filter: "text",
    sortValue: (e) => `${e.involved.kind}/${e.involved.name}`,
    filterValue: (e) => `${e.involved.kind}/${e.involved.name}`,
    render: (e) => `${e.involved.kind}/${e.involved.name}`,
  },
  { key: "reason", label: "Reason", filter: "select", render: (e) => <Tag tone="warning">{e.reason}</Tag> },
  { key: "count", label: "Count" },
  { key: "message", label: "Message", className: "muted wrap", filter: "text" },
];

function IssuesSection({ c }: { c: ClusterDocument }) {
  const ev = useFetch(() => api.events({ cluster: c.name, limit: 50 }), [c.name]);
  const certs = useFetch(() => api.certificates({ cluster: c.name }), [c.name]);
  return (
    <Stack spacing={2}>
      <Card flush title={`Pod issues (${c.pod_issues_detail.length})`}>
        <DataTable
          id="cluster.podIssues"
          columns={POD_ISSUE_COLUMNS}
          rows={c.pod_issues_detail}
          rowKey={(i) => i.namespace + "/" + i.name}
          initialSort={{ key: "namespace", dir: "asc" }}
          empty="No problem pods."
        />
      </Card>
      <Card flush title={`Certificates expiring (${certs.data?.count ?? "…"})`}>
        {certs.error && !certs.data ? <ErrorBanner error={certs.error} /> : !certs.data ? <SkeletonTable columns={6} rows={4} /> : (
          <DataTable
            id="cluster.certificates"
            columns={CLUSTER_CERT_COLUMNS}
            rows={certs.data.certificates}
            rowKey={(r) => r.namespace + "/" + r.name}
            initialSort={{ key: "days_left", dir: "asc" }}
            empty="Nothing expiring within the threshold."
          />
        )}
      </Card>
      <Card flush title="Recent warning events">
        {ev.error && !ev.data ? <ErrorBanner error={ev.error} /> : !ev.data ? <SkeletonTable columns={6} rows={5} /> : (
          <DataTable
            id="cluster.events"
            columns={CLUSTER_EVENT_COLUMNS}
            rows={ev.data.events as EventRow[]}
            rowKey={(e, i) => `${e.namespace}/${e.name}/${i}`}
            initialSort={{ key: "last_at", dir: "desc" }}
            empty="No warning events."
          />
        )}
      </Card>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
function OperatorsSection({ c, nav }: SectionProps) {
  const columns: Column<ClusterOperator>[] = [
    {
      key: "name", label: "Operator", filter: "text",
      render: (o) => <>{o.name} {o.critical && <Tag tone="critical">critical</Tag>}</>,
    },
    { key: "version", label: "Version", className: "mono", filter: "select" },
    {
      key: "state", label: "State", filter: "select",
      sortValue: (o) => ["Degraded", "Unavailable", "Progressing", "Available"].indexOf(opStateLabel(o)),
      filterValue: (o) => opStateLabel(o),
      render: (o) => opState(o),
    },
    { key: "message", label: "Message", className: "muted wrap", filter: "text" },
    {
      key: "blast", label: "",
      render: (o) => (
        <Link component="button" type="button"
          onClick={() => nav.goBlast({ operator: o.name, operator_version: o.version })}>blast radius →</Link>
      ),
    },
  ];
  return (
    <Card flush title={`Cluster operators (${c.operators.length})`}>
      <DataTable
        id="cluster.operators"
        columns={columns}
        rows={c.operators}
        rowKey="name"
        initialSort={{ key: "name", dir: "asc" }}
        empty="No cluster operators collected."
      />
    </Card>
  );
}

function opStateLabel(o: ClusterOperator) {
  if (o.degraded) return "Degraded";
  if (!o.available) return "Unavailable";
  if (o.progressing) return "Progressing";
  return "Available";
}

function opState(o: ClusterOperator) {
  const label = opStateLabel(o);
  const tone = label === "Progressing" ? "warning" : label === "Available" ? "healthy" : "critical";
  return <ToneText tone={tone}>{label}</ToneText>;
}

// ---------------------------------------------------------------------------
const RESOURCE_KINDS = ["routes", "services", "configmaps", "secrets", "persistentvolumeclaims", "resourcequotas",
  "networkpolicies", "horizontalpodautoscalers", "cronjobs", "ingresses", "clusterserviceversions", "subscriptions",
  "machineconfigpools", "storageclasses", "persistentvolumes", "clusterrolebindings", "events"];

const INVENTORY_COLUMNS: Column<ResourceRow>[] = [
  {
    key: "namespace", label: "Namespace", className: "mono", filter: "text",
    sortValue: (r) => `${r.namespace || ""}/${r.name}`,
    render: (r) => r.namespace || <Muted>cluster</Muted>,
  },
  { key: "name", label: "Name", filter: "text" },
  {
    key: "status", label: "Status", filter: "select",
    render: (r) => (r.status ? <StatusChip status={r.status} /> : <Muted>—</Muted>),
  },
  {
    key: "summary", label: "Summary", className: "muted wrap", filter: "text",
    sortValue: (r) => summarize(r),
    filterValue: (r) => summarize(r),
    render: (r) => <Box component="span" sx={{ fontSize: 12 }}>{summarize(r)}</Box>,
  },
  { key: "created_at", label: "Age", className: "muted", render: (r) => fmtAge(r.created_at) },
];

function ResourcesSection({ c }: { c: ClusterDocument }) {
  const [kind, setKind] = useState("routes");
  const [ns, setNs] = useState("");
  const { data, error } = useFetch(() => api.clusterResources(c.name, { kind, namespace: ns }), [c.name, kind, ns]);
  const status = Object.fromEntries(c.resource_status.map((s) => [s.key, s]));
  const namespaces = c.namespaces_detail.map((n) => n.name);
  return (
    <Stack spacing={2}>
      <Card title="What this cluster served">
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
          {c.resource_status.map((s) => (
            <Tooltip key={s.key} title={s.error || `${s.count} objects in ${s.duration_ms} ms`}>
              <span>
                <StatusChip status={s.status}>
                  {s.key} {s.status === "collected" ? <b>{s.count}</b> : <i>{s.status}</i>}
                </StatusChip>
              </span>
            </Tooltip>
          ))}
        </Box>
      </Card>
      <Card
        flush
        title="Inventory"
        action={(
          <Filters>
            <FilterSelect label="Kind" value={kind} options={RESOURCE_KINDS} onChange={(v) => setKind(v || "routes")} allLabel="routes" />
            <FilterSelect label="Namespace" value={ns} options={namespaces} onChange={setNs} />
          </Filters>
        )}
        description={(
          <>
            {status[kind]?.status === "collected" ? `${status[kind].count} collected` : `not collected: ${status[kind]?.status || "disabled"}`}
            {" · "}ConfigMaps / Secrets show key names, sizes and certificate facts only.
          </>
        )}
      >
        {error && !data ? <ErrorBanner error={error} /> : !data ? <SkeletonTable columns={5} rows={8} /> : (
          <DataTable
            id="cluster.resources"
            columns={INVENTORY_COLUMNS}
            rows={data.resources}
            rowKey={(r, i) => `${r.namespace || ""}/${r.name}/${i}`}
            initialSort={{ key: "namespace", dir: "asc" }}
            empty="Nothing collected for this kind."
            scroll
          />
        )}
      </Card>
    </Stack>
  );
}

/** One inventory row as a sentence. The summary is per-kind and open by
 * design (`serialize.resource_dict`), so `r.key` is what says which shape
 * applies - there are seventeen of them, and the API declares none. */
export function summarize(r: { key: string; summary?: ResourceSummary | null }): string {
  // why: `any` rather than `unknown` here because each branch below already
  // knows its own kind's fields, and the alternative is seventeen interfaces
  // that only this function would ever read. Adding `response_model` to the
  // handler (ADR-0005's follow-up) is what would make them generated instead.
  // The same goes for the `any` on the callbacks over the nested lists: those
  // items are as undeclared as the summary that carries them.
  const s = (r.summary || {}) as Record<string, any>;
  switch (r.key) {
    case "routes": return `${s.host}${s.path || ""} → ${s.service} · tls ${s.tls_termination || "none"}`;
    case "services": return `${s.type} ${s.cluster_ip || ""} · ${(s.ports || []).map((p: any) => `${p.port}→${p.target}`).join(", ")}${s.load_balancer?.length ? " · lb " + s.load_balancer.join(",") : ""}`;
    case "configmaps":
    case "secrets": return `${s.type ? s.type + " · " : ""}${s.key_count} keys (${(s.keys || []).map((k: any) => k.key).join(", ")}) · ${fmtBytes(s.total_bytes)}${s.certificates ? ` · cert ${s.certificates[0].subject} exp ${fmtTime(s.certificates[0].not_after)}` : ""}`;
    case "persistentvolumeclaims": return `${s.storage_class || "(no class)"} · ${fmtBytes(s.requested_bytes)}${s.capacity_bytes ? ` (${fmtBytes(s.capacity_bytes)} bound)` : ""} · ${(s.access_modes || []).join(",")}${s.mounted_by?.length ? ` · mounted by ${s.mounted_by.join(", ")}` : " · not mounted"}`;
    case "persistentvolumes": return `${s.storage_class || ""} · ${fmtBytes(s.capacity_bytes)} · ${s.csi_driver || "in-tree"} · claim ${s.claim || "—"} · ${s.reclaim_policy}`;
    case "resourcequotas": return `${(s.resources || []).map((q: any) => `${q.resource} ${q.used}/${q.hard} (${q.percent}%)`).join(" · ")}`;
    case "networkpolicies": return `${(s.policy_types || []).join(",")} · ${s.ingress_rules} ingress / ${s.egress_rules} egress rules`;
    case "horizontalpodautoscalers": return `${s.target} · ${s.current_replicas ?? "?"} of ${s.min_replicas}-${s.max_replicas} · ${(s.metrics || []).map((m: any) => `${m.resource} ${m.target_percent ?? m.target_value}`).join(", ")}`;
    case "cronjobs": return `${s.schedule} · ${s.suspended ? "suspended" : "active"} · last ${s.last_schedule ? fmtTime(s.last_schedule) : "never"} · ${(s.images || []).join(", ")}`;
    case "ingresses": return `${(s.hosts || []).join(", ")} · class ${s.class || "—"}`;
    case "clusterserviceversions": return `${s.package} ${s.version} · ${s.phase}${s.reason ? ` (${s.reason})` : ""} · ${s.provider || ""}`;
    case "subscriptions": return `${s.package} · ${s.channel} · installed ${s.installed_csv}${s.upgrade_pending ? ` → ${s.current_csv}` : ""}`;
    case "machineconfigpools": return `${s.updated}/${s.machine_count} updated · ${s.ready} ready · ${s.degraded} degraded${s.paused ? " · paused" : ""}${s.message ? ` · ${s.message}` : ""}`;
    case "storageclasses": return `${s.provisioner} · ${s.binding_mode} · ${s.reclaim_policy}${s.default ? " · default" : ""}`;
    case "clusterrolebindings": return `${s.role} → ${(s.subjects || []).map((x: any) => `${x.kind}/${x.name}`).join(", ")}`;
    case "events": return `${s.reason}: ${s.involved?.kind}/${s.involved?.name} ×${s.count} · ${s.message}`;
    default: return JSON.stringify(s);
  }
}
