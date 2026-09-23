import { Alert, Box, ButtonBase, Stack } from "@mui/material";
import { api } from "../api";
import type { CapacityResponse, TopNamespacesResponse, TopNodesResponse } from "../api/types";
import { useFetch } from "../hooks";
import { useQueryFilters } from "../router";
import type { RouteApi } from "../router";
import {
  Card, Empty, Mono, Muted, SectionHead, ToneText,
  ErrorBanner, SubTabs, DataTable, SkeletonLines, SkeletonTable, fmtBytes, fmtCores, fmtPct,
} from "../components";
import type { Column } from "../components";

/** One group of the capacity rollup. The group's own name is keyed by
 * `group_by`, which is why the row carries an index signature. */
type CapacityRow = CapacityResponse["results"][number];

interface MetricsProps {
  onOpen: (name: string) => void;
  route: RouteApi;
}

interface BarRowProps {
  label: string;
  sub?: string;
  /** null when the cluster serves no metrics: the bar is then empty rather
   * than zero-length, which is a different thing to say. */
  value: number | null;
  max: number;
  fmt: (v: number | null) => string;
  /** A palette tone - "accent" unless the reading itself is the verdict. */
  tone?: string;
  onClick?: () => void;
}

function BarRow({ label, sub, value, max, fmt, tone = "accent", onClick }: BarRowProps) {
  // A namespace with no metrics has no bar rather than an empty one: null is
  // "not measured", and the row still says so through `fmt`.
  const pct = max && value != null ? Math.min(100, (value / max) * 100) : 0;
  const body = (
    <>
      <Box sx={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, mb: 0.375 }}>
        <span><Mono>{label}</Mono> {sub && <Muted>· {sub}</Muted>}</span>
        <Box component="span" sx={{ color: "text.secondary" }}>{fmt(value)}</Box>
      </Box>
      <Box sx={{ height: 14, borderRadius: "6px", overflow: "hidden", bgcolor: "background.subtle" }}>
        <ToneText tone={tone} sx={{ display: "block", height: "100%", width: `${pct}%`, bgcolor: "currentColor" }} />
      </Box>
    </>
  );
  if (!onClick) return <Box sx={{ mb: 1.125 }}>{body}</Box>;
  return (
    <ButtonBase
      onClick={onClick}
      sx={{ display: "block", width: "100%", textAlign: "left", mb: 1.125 }}
    >
      {body}
    </ButtonBase>
  );
}

/** How a utilization reading reads: comfortable, tight, or out of room. */
const tone = (p: number) => (p > 90 ? "critical" : p > 75 ? "warning" : "healthy");

const GROUPS = ["cluster", "hub", "region", "environment", "datacenter"];

export default function Metrics({ onOpen, route }: MetricsProps) {
  // by / class / group ride in the query string: /utilization?group=region is
  // the page someone can send to the next person.
  const [f, set] = useQueryFilters(route, ["by", "class", "group"]);
  const by = f.by === "memory" ? "memory" : "cpu";
  const cls = f.class === "application" || f.class === "platform" ? f.class : "";
  const groupBy = GROUPS.includes(f.group) ? f.group : "cluster";
  const health = useFetch(() => api.metricsHealth(), []);
  const ns = useFetch(() => api.topNamespaces(by, 10, cls), [by, cls]);
  const nodes = useFetch(() => api.topNodes(by, 10), [by]);
  const cap = useFetch(() => api.capacity(groupBy), [groupBy]);

  const h = health.data;

  return (
    <Stack spacing={2.5}>
      <SectionHead
        title="Utilization"
        description={"Live CPU / memory from each cluster's Kubernetes metrics API (metrics.k8s.io), collected with the inventory"
          + " on every sweep. No Prometheus, no external source."}
      >
        <SubTabs tabs={[["cpu", "CPU"], ["memory", "Memory"]]} value={by} onChange={(v) => set("by", v)} />
      </SectionHead>

      {h && !h.reachable && (
        <Alert severity="warning">
          No cluster is serving metrics.k8s.io yet - usage is unknown. Capacity (allocatable) is still known from nodes.
        </Alert>
      )}
      {h && h.reachable && h.without_metrics.length > 0 && (
        <Muted sx={{ fontSize: 12.5 }}>
          Metrics available on {h.clusters_with_metrics}/{h.clusters_total} clusters · missing on: {h.without_metrics.join(", ")}
        </Muted>
      )}

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, gap: 2 }}>
        <Card
          title={`Top namespaces by ${by}`}
          action={(
            <SubTabs tabs={[["", "All"], ["application", "Apps"], ["platform", "Platform"]]} value={cls} onChange={(v) => set("class", v)} />
          )}
        >
          {ns.error && !ns.data ? <ErrorBanner error={ns.error} /> : !ns.data ? <SkeletonLines rows={6} height={22} /> : (
            <TopList data={ns.data} onOpen={onOpen} />
          )}
        </Card>
        <Card title={`Top nodes by ${by} (% of allocatable)`}>
          {nodes.error && !nodes.data ? <ErrorBanner error={nodes.error} /> : !nodes.data ? <SkeletonLines rows={6} height={22} /> : (
            <NodeList data={nodes.data} onOpen={onOpen} />
          )}
        </Card>
      </Box>

      <Card
        flush
        title="Capacity headroom"
        action={(
          <SubTabs
            tabs={[["cluster", "Cluster"], ["hub", "Hub"], ["region", "Region"], ["environment", "Environment"], ["datacenter", "Data center"]]}
            value={groupBy}
            onChange={(v) => set("group", v)}
          />
        )}
      >
        {cap.error && !cap.data ? <ErrorBanner error={cap.error} /> : !cap.data ? <SkeletonTable columns={7} rows={6} /> : (
          <CapacityTable data={cap.data} onOpen={onOpen} />
        )}
      </Card>
    </Stack>
  );
}

interface TopListProps {
  data: TopNamespacesResponse;
  onOpen: (name: string) => void;
}

function TopList({ data, onOpen }: TopListProps) {
  const results = data.results || [];
  // The scale is set by what was measured; a namespace that reported nothing
  // cannot widen it.
  const max = Math.max(...results.map((r) => r.value ?? 0), 1);
  const fmt = data.unit === "bytes" ? fmtBytes : fmtCores;
  // Memory and CPU are two different readings on one page, so they are not the
  // same colour - neither is a verdict about the namespace.
  const barTone = data.unit === "bytes" ? "warning" : "accent";
  if (results.length === 0) return <Empty>No usage data yet.</Empty>;
  return results.map((r, i) => (
    <BarRow key={i} label={r.namespace} sub={`${r.cluster}${r.class === "platform" ? " · platform" : r.team ? ` · ${r.team}` : ""}`}
      value={r.value} max={max} fmt={fmt} tone={barTone} onClick={() => onOpen(r.cluster)} />
  ));
}

interface NodeListProps {
  data: TopNodesResponse;
  onOpen: (name: string) => void;
}

function NodeList({ data, onOpen }: NodeListProps) {
  const results = data.results || [];
  if (results.length === 0) return <Empty>No usage data yet.</Empty>;
  return results.map((r, i) => (
    <BarRow key={i} label={r.node} sub={r.cluster} value={r.value} max={100} fmt={fmtPct}
      tone={tone(r.value)} onClick={() => onOpen(r.cluster)} />
  ));
}

interface CapacityTableProps {
  data: CapacityResponse;
  onOpen: (name: string) => void;
}

function CapacityTable({ data, onOpen }: CapacityTableProps) {
  // The group's own name is stored under whatever `group_by` was asked for, so
  // it reaches the row through the index signature: `as string` is what says
  // that column holds the group's name, and adds nothing at runtime.
  const key = data.group_by;
  const rows = data.results || [];
  const columns: Column<CapacityRow>[] = [
    { key, label: key, className: "mono", filter: "text" },
    {
      key: "clusters", label: "Clusters",
      render: (r) => <>{r.clusters}{r.with_metrics < r.clusters && <Muted> ({r.with_metrics} w/ metrics)</Muted>}</>,
    },
    {
      key: "used_percent", label: "CPU used / allocatable", className: "nowrap",
      filterValue: (r) => `${r.used_cores.toFixed(1)} / ${r.allocatable_cores.toFixed(1)}`,
      render: (r) => (
        <>
          <ToneText tone={tone(r.used_percent || 0)}>{r.used_cores.toFixed(1)}</ToneText>
          <Muted> / {r.allocatable_cores.toFixed(1)} · {fmtPct(r.used_percent)}</Muted>
        </>
      ),
    },
    { key: "requests_cores", label: "CPU requested", render: (r) => <>{r.requests_cores.toFixed(1)} <Muted>cores</Muted></> },
    { key: "headroom_cores", label: "CPU headroom", render: (r) => <>{r.headroom_cores.toFixed(1)} <Muted>cores</Muted></> },
    {
      key: "memory_used_percent", label: "Memory used / allocatable", className: "nowrap",
      filterValue: (r) => `${fmtBytes(r.used_bytes)} / ${fmtBytes(r.allocatable_bytes)}`,
      render: (r) => (
        <>
          <ToneText tone={tone(r.memory_used_percent || 0)}>{fmtBytes(r.used_bytes)}</ToneText>
          <Muted> / {fmtBytes(r.allocatable_bytes)} · {fmtPct(r.memory_used_percent)}</Muted>
        </>
      ),
    },
    { key: "headroom_bytes", label: "Memory headroom", render: (r) => fmtBytes(r.headroom_bytes) },
  ];
  return (
    <DataTable
      id={`metrics.capacity.${key}`}
      columns={columns}
      rows={rows}
      rowKey={(r) => r[key] as string}
      onRowClick={key === "cluster" ? (r) => onOpen(r[key] as string) : undefined}
      initialSort={{ key: "used_percent", dir: "desc" }}
      empty="No capacity data."
    />
  );
}
