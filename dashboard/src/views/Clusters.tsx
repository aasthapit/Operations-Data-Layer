import { api } from "../api";
import type { ClusterSummary } from "../api/types";
import { useFetch } from "../hooks";
import { useQueryFilters } from "../router";
import type { RouteApi } from "../router";
import { Pill, ErrorBanner, FilterSelect, UsageBar, DataTable, SkeletonTable } from "../components";
import type { Column } from "../components";

interface ClustersProps {
  route: RouteApi;
  onOpen: (name: string) => void;
}

// The dropdowns above the table narrow the API query; the column filters below
// the header narrow what is already on screen, so they do not repeat a field
// that already has a server-side filter.
const COLUMNS: Column<ClusterSummary>[] = [
  { key: "name", label: "Cluster", className: "mono", filter: "text" },
  { key: "overall_status", label: "Status", render: (c) => <Pill status={c.overall_status} /> },
  { key: "hub", label: "Hub", className: "mono" },
  {
    key: "region_dc", label: "Region / DC", className: "muted", filter: "text",
    sortValue: (c) => `${c.region} / ${c.datacenter}`,
    filterValue: (c) => `${c.region} / ${c.datacenter}`,
    render: (c) => `${c.region} / ${c.datacenter}`,
  },
  { key: "environment", label: "Env", render: (c) => <span className="tag">{c.environment}</span> },
  {
    key: "ocp_version", label: "OCP version", className: "mono nowrap",
    render: (c) => (
      <>
        {c.ocp_version}
        {c.upgrading && <span className="muted"> → {c.desired_version} ({c.upgrade_percent}%)</span>}
      </>
    ),
  },
  {
    key: "nodes", label: "Nodes",
    sortValue: (c) => c.nodes.total,
    filterValue: (c) => `${c.nodes.ready}/${c.nodes.total}`,
    render: (c) => `${c.nodes.ready}/${c.nodes.total}`,
  },
  {
    key: "cpu", label: "CPU",
    sortValue: (c) => c.utilization.cpu_percent,
    render: (c) => <UsageBar percent={c.utilization.cpu_percent} width={70} label="CPU used / allocatable" />,
  },
  {
    key: "memory", label: "Memory",
    sortValue: (c) => c.utilization.memory_percent,
    render: (c) => <UsageBar percent={c.utilization.memory_percent} width={70} label="Memory used / allocatable" />,
  },
  {
    key: "apps", label: "Apps",
    sortValue: (c) => c.applications ?? c.namespaces.application,
    filterValue: (c) => `${c.applications ?? c.namespaces.application}`,
    render: (c) => <>{c.applications ?? c.namespaces.application} <span className="muted">/ {c.namespaces.application} ns</span></>,
  },
  {
    key: "pod_issues", label: "Pod issues",
    render: (c) => (c.pod_issues ? <span style={{ color: "var(--warning)" }}>{c.pod_issues}</span> : <span className="muted">0</span>),
  },
  {
    key: "certs_expiring", label: "Certs",
    render: (c) => (c.certs_expiring ? <span style={{ color: "var(--critical)" }}>{c.certs_expiring}</span> : <span className="muted">0</span>),
  },
  {
    key: "checks", label: "Checks", className: "nowrap",
    sortValue: (c) => c.checks.failed * 1000 + c.checks.warned,
    filterValue: (c) => `${c.checks.passed} passed ${c.checks.warned} warned ${c.checks.failed} failed`,
    render: (c) => (
      <>
        <span style={{ color: "var(--healthy)" }}>{c.checks.passed}✓</span>{" "}
        {c.checks.warned ? <span style={{ color: "var(--warning)" }}>{c.checks.warned}!</span> : null}{" "}
        {c.checks.failed ? <span style={{ color: "var(--critical)" }}>{c.checks.failed}✕</span> : null}
      </>
    ),
  },
];

// Every filter lives in the query string, so a narrowed list is a link and the
// back button steps out of it. `team` and `upgrading` have no dropdown of their
// own - they arrive from a click on the overview - so they show as a chip.
const FILTER_KEYS = ["hub", "region", "datacenter", "environment", "status", "version", "team", "upgrading"];

export default function Clusters({ route, onOpen }: ClustersProps) {
  const [filters, set, clear, anyFilter] = useQueryFilters(route, FILTER_KEYS);
  const { data, error } = useFetch(() => api.clusters(filters), [JSON.stringify(filters)]);
  const meta = useFetch(() => api.clusters(), []); // unfiltered, for filter options

  const opts = buildOptions(meta.data?.clusters || []);

  return (
    <div>
      <div className="filters">
        <FilterSelect label="Hub" value={filters.hub} options={opts.hub} onChange={(v) => set("hub", v)} />
        <FilterSelect label="Region" value={filters.region} options={opts.region} onChange={(v) => set("region", v)} />
        <FilterSelect label="Data center" value={filters.datacenter} options={opts.datacenter} onChange={(v) => set("datacenter", v)} />
        <FilterSelect label="Environment" value={filters.environment} options={opts.environment} onChange={(v) => set("environment", v)} />
        <FilterSelect label="Status" value={filters.status} options={["healthy", "warning", "critical", "unknown"]} onChange={(v) => set("status", v)} />
        <FilterSelect label="OCP version" value={filters.version} options={opts.version} onChange={(v) => set("version", v)} />
        {filters.team && <Chip label="team" value={filters.team} onClear={() => set("team", "")} />}
        {filters.upgrading && <Chip label="upgrading" value={filters.upgrading} onClear={() => set("upgrading", "")} />}
        {anyFilter && (
          <button className="btn" style={{ alignSelf: "flex-end" }} onClick={clear}>Clear</button>
        )}
      </div>

      {error && !data ? <ErrorBanner error={error} /> : (
        <div className="card flush">
          {!data ? <SkeletonTable columns={8} rows={10} /> : (
            <DataTable
              id="clusters"
              columns={COLUMNS}
              rows={data.clusters}
              rowKey="name"
              onRowClick={(c) => onOpen(c.name)}
              initialSort={{ key: "name", dir: "asc" }}
              empty="No clusters match these filters."
              footer={`${data.count ?? data.clusters.length} clusters`}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface ChipProps {
  label: string;
  value: string;
  onClear: () => void;
}

function Chip({ label, value, onClear }: ChipProps) {
  return (
    <span className="tag" style={{ alignSelf: "flex-end", padding: "5px 8px" }}>
      {label}: {value}
      <span className="link" style={{ marginLeft: 6 }} onClick={onClear} title={`Clear ${label}`}>×</span>
    </span>
  );
}

// The dropdown options are whatever the unfiltered list actually contains, so
// the keys are the ones whose values are plain strings.
type OptionKey = "region" | "datacenter" | "environment" | "ocp_version" | "hub";

function buildOptions(clusters: ClusterSummary[]): Record<string, string[]> {
  const uniq = (k: OptionKey) =>
    [...new Set(clusters.map((c) => c[k]).filter(Boolean))].sort() as string[];
  return {
    region: uniq("region"),
    datacenter: uniq("datacenter"),
    environment: uniq("environment"),
    version: uniq("ocp_version"),
    hub: uniq("hub"),
  };
}
