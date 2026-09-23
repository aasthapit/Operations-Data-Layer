import { Box, Button, Chip, Stack } from "@mui/material";
import CancelIcon from "@mui/icons-material/Cancel";
import { api } from "../api";
import type { ClusterSummary } from "../api/types";
import { useFetch } from "../hooks";
import { useQueryFilters } from "../router";
import type { RouteApi } from "../router";
import {
  Card, Muted, Pill, Tag, ToneText, ErrorBanner, FilterSelect, UsageBar, DataTable, SkeletonTable,
} from "../components";
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
  { key: "environment", label: "Env", render: (c) => <Tag>{c.environment}</Tag> },
  {
    key: "ocp_version", label: "OCP version", className: "mono nowrap",
    render: (c) => (
      <>
        {c.ocp_version}
        {c.upgrading && <Muted> → {c.desired_version} ({c.upgrade_percent}%)</Muted>}
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
    render: (c) => <>{c.applications ?? c.namespaces.application} <Muted>/ {c.namespaces.application} ns</Muted></>,
  },
  {
    key: "pod_issues", label: "Pod issues",
    render: (c) => (c.pod_issues ? <ToneText tone="warning">{c.pod_issues}</ToneText> : <Muted>0</Muted>),
  },
  {
    key: "certs_expiring", label: "Certs",
    render: (c) => (c.certs_expiring ? <ToneText tone="critical">{c.certs_expiring}</ToneText> : <Muted>0</Muted>),
  },
  {
    key: "checks", label: "Checks", className: "nowrap",
    // An unreachable cluster ran no checks, so its counts are null rather than
    // zero; a row with nothing to report sorts below one that failed nothing,
    // which is where it belongs.
    sortValue: (c) => (c.checks.failed || 0) * 1000 + (c.checks.warned || 0),
    filterValue: (c) => `${c.checks.passed} passed ${c.checks.warned} warned ${c.checks.failed} failed`,
    render: (c) => (
      <>
        <ToneText tone="healthy">{c.checks.passed}✓</ToneText>{" "}
        {c.checks.warned ? <ToneText tone="warning">{c.checks.warned}!</ToneText> : null}{" "}
        {c.checks.failed ? <ToneText tone="critical">{c.checks.failed}✕</ToneText> : null}
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
    <Box>
      <Stack direction="row" spacing={1.25} useFlexGap sx={{ mb: 2, flexWrap: "wrap", alignItems: "center" }}>
        <FilterSelect label="Hub" value={filters.hub} options={opts.hub} onChange={(v) => set("hub", v)} />
        <FilterSelect label="Region" value={filters.region} options={opts.region} onChange={(v) => set("region", v)} />
        <FilterSelect label="Data center" value={filters.datacenter} options={opts.datacenter} onChange={(v) => set("datacenter", v)} />
        <FilterSelect label="Environment" value={filters.environment} options={opts.environment} onChange={(v) => set("environment", v)} />
        <FilterSelect label="Status" value={filters.status} options={["healthy", "warning", "critical", "unknown"]} onChange={(v) => set("status", v)} />
        <FilterSelect label="OCP version" value={filters.version} options={opts.version} onChange={(v) => set("version", v)} />
        {filters.team && <FilterChip label="team" value={filters.team} onClear={() => set("team", "")} />}
        {filters.upgrading && <FilterChip label="upgrading" value={filters.upgrading} onClear={() => set("upgrading", "")} />}
        {anyFilter && <Button variant="outlined" color="inherit" onClick={clear}>Clear</Button>}
      </Stack>

      {error && !data ? <ErrorBanner error={error} /> : (
        <Card flush>
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
        </Card>
      )}
    </Box>
  );
}

interface FilterChipProps {
  label: string;
  value: string;
  onClear: () => void;
}

/** A filter that arrived from elsewhere - a click on the overview - and so has
 * no dropdown of its own to clear it from. */
function FilterChip({ label, value, onClear }: FilterChipProps) {
  return (
    <Chip
      variant="outlined"
      label={`${label}: ${value}`}
      onDelete={onClear}
      // The icon names the action rather than the chip: the delete control is
      // what a pointer and a keyboard both land on, and "Clear team" is what it
      // does. `titleAccess` is what puts that name inside the SVG.
      deleteIcon={<CancelIcon titleAccess={`Clear ${label}`} />}
      sx={{ height: 30, borderRadius: "5px", fontWeight: 400 }}
    />
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
