import { Box, Button, Chip, Link, Stack, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { api } from "../api";
import type {
  Application, ApplicationPlacement, ApplicationsResponse, Workload,
} from "../api/types";
import * as cache from "../cache";
import { useFetch } from "../hooks";
import { useQueryFilters } from "../router";
import type { Nav, RouteApi } from "../router";
import {
  Card, Mono, Muted, SectionHead, Tag, ToneText,
  Pill, ErrorBanner, FilterSelect, Tier, DataTable, SkeletonTable, fmtBytes, fmtCores,
} from "../components";
import type { ColumnDef, Column } from "../components";

interface ApplicationsProps {
  /** The application the URL names, when it names one. */
  app?: string;
  nav: Nav;
  route: RouteApi;
}

const FILTER_KEYS = ["team", "tier", "assigned", "environment", "status"];

// The list rows carry cluster names directly (`clusters`); the full placement
// objects only come back when they are asked for, and only the detail page
// needs them. Older responses that still carry placements keep working.
const clusterNames = (a: Application): string[] =>
  a.clusters ?? (a.placements || []).map((p) => p.cluster);

export default function Applications({ app, nav, route }: ApplicationsProps) {
  const [filters, set, clear, anyFilter] = useQueryFilters(route, FILTER_KEYS);
  const { data, error } = useFetch(() => api.applications(filters), [JSON.stringify(filters)]);

  if (app) return <ApplicationDetail app={app} nav={nav} />;

  const apps = data?.applications || [];
  const envs = [...new Set(apps.flatMap((a) => a.environments))].sort();
  // An application with no tier drops out of the filter rather than offering a
  // blank option: `filter(Boolean)` is what the page has always done, written
  // as the narrowing it is.
  const tiers = [...new Set(apps.map((a) => a.tier).filter((t): t is string => !!t))].sort();
  // With a mapping file the owner is a line of business, tier is not known,
  // and each namespace carries its own environment.
  const mapped = data?.source === "mapping";
  const ownerLabel = mapped ? "LOB" : "Team";
  const unassigned = apps.find((a) => !a.assigned);

  // Team / tier / environment / status already have server-side dropdowns above
  // the table, so they are not repeated as column filters.
  const columns: ColumnDef<Application>[] = [
    {
      key: "app", label: "Application", filter: "text",
      render: (a) => (a.assigned
        ? <>{a.app}{mapped && a.tier ? <> <Tier tier={a.tier} /></> : null}</>
        : <Muted>{a.app} <Box component="span" sx={{ fontSize: 11 }}>not under a business application</Box></Muted>),
    },
    { key: "team", label: ownerLabel, className: "muted", render: (a) => a.team || "-" },
    mapped
      ? {
        key: "namespace_environments", label: "Namespace envs",
        filterValue: (a) => (a.namespace_environments || []).join(", "),
        render: (a) => (a.namespace_environments || []).map((e) => <Tag key={e} sx={{ mr: 0.5 }}>{e}</Tag>),
      }
      : { key: "tier", label: "Tier", render: (a) => <Tier tier={a.tier} /> },
    { key: "status", label: "Status", render: (a) => <Pill status={a.status} /> },
    {
      key: "cluster_count", label: "Clusters",
      filterValue: (a) => `${a.cluster_count} ${clusterNames(a).join(" ")}`,
      render: (a) => {
        const names = [...new Set(clusterNames(a))];
        const shown = names.slice(0, 3).join(", ");
        const more = names.length > 3 ? ` +${names.length - 3}` : "";
        return <>{a.cluster_count}{shown && <Mono sx={{ color: "text.disabled", fontSize: 12 }}> · {shown}{more}</Mono>}</>;
      },
    },
    {
      key: "hubs", label: "Hubs", filter: "select",
      filterValue: (a) => (a.hubs || []).join(" "),
      sortValue: (a) => (a.hubs || []).join(","),
      render: (a) => (a.hubs || []).map((h) => <Tag key={h} sx={{ mr: 0.5 }}>{h}</Tag>),
    },
    {
      key: "environments", label: "Environments",
      sortValue: (a) => a.environments.join(", "),
      render: (a) => a.environments.map((e) => <Tag key={e} sx={{ mr: 0.5 }}>{e}</Tag>),
    },
    { key: "workloads", label: "Workloads" },
    {
      key: "replicas_ready", label: "Replicas",
      filterValue: (a) => `${a.replicas_ready}/${a.replicas_desired}`,
      render: (a) => `${a.replicas_ready}/${a.replicas_desired}`,
    },
    {
      key: "pod_issues", label: "Pod issues",
      render: (a) => (a.pod_issues ? <ToneText tone="warning">{a.pod_issues}</ToneText> : <Muted>0</Muted>),
    },
    {
      key: "cpu_used_cores", label: "CPU used",
      render: (a) => (a.cpu_used_cores != null ? fmtCores(a.cpu_used_cores) : <Muted>n/a</Muted>),
    },
    {
      key: "memory_used_bytes", label: "Memory used",
      render: (a) => (a.memory_used_bytes != null ? fmtBytes(a.memory_used_bytes) : <Muted>n/a</Muted>),
    },
  ];

  return (
    <Box>
      <SectionHead
        title="Applications"
        description={mapped
          ? <>Ownership comes from the application mapping file: every resource in a namespace belongs to that namespace&apos;s application, and namespaces the file does not list are grouped as <Mono>(unassigned)</Mono>{unassigned ? ` (${unassigned.cluster_count} namespaces)` : ""}. Labels are not used.</>
          : <>Every non-platform namespace is an application. Identity, team and tier come from namespace labels (falling back to the workloads&apos; labels); OpenShift&apos;s own namespaces are grouped separately per cluster.</>}
      />
      <Stack direction="row" spacing={1.25} useFlexGap sx={{ mb: 2, flexWrap: "wrap", alignItems: "center" }}>
        <FilterSelect label={ownerLabel} value={filters.team} options={data?.teams || []} onChange={(v) => set("team", v)} />
        {!mapped && <FilterSelect label="Tier" value={filters.tier} options={tiers} onChange={(v) => set("tier", v)} />}
        {mapped && <FilterSelect label="Assigned" value={filters.assigned} options={["true", "false"]} onChange={(v) => set("assigned", v)} />}
        <FilterSelect label="Environment" value={filters.environment} options={envs} onChange={(v) => set("environment", v)} />
        <FilterSelect label="Status" value={filters.status} options={["healthy", "warning", "critical"]} onChange={(v) => set("status", v)} />
        {anyFilter && <Button variant="outlined" color="inherit" onClick={clear}>Clear</Button>}
      </Stack>
      {error && !data ? <ErrorBanner error={error} /> : (
        <Card flush>
          {!data ? <SkeletonTable columns={9} rows={10} /> : (
            <DataTable
              id="applications"
              columns={columns}
              rows={apps}
              rowKey="app"
              onRowClick={(a) => nav.openApp(a.app)}
              initialSort={{ key: "app", dir: "asc" }}
              empty="No applications match."
              footer={`${data.count ?? apps.length} applications`}
            />
          )}
        </Card>
      )}
    </Box>
  );
}

const PLACEMENT_COLUMNS: Column<ApplicationPlacement>[] = [
  { key: "cluster", label: "Cluster", className: "mono", filter: "text" },
  { key: "hub", label: "Hub", className: "mono", filter: "select" },
  { key: "environment", label: "Env", filter: "select", render: (p) => <Tag>{p.environment}</Tag> },
  { key: "ocp_version", label: "OCP", className: "mono", filter: "select" },
  { key: "cluster_status", label: "Cluster status", filter: "select", render: (p) => <Pill status={p.cluster_status} /> },
  { key: "namespace", label: "Namespace", className: "mono", filter: "text" },
  {
    key: "namespace_environment", label: "Namespace env", filter: "select",
    render: (p) => (p.namespace_environment ? <Tag>{p.namespace_environment}</Tag> : <Muted>-</Muted>),
  },
  { key: "status", label: "App status", filter: "select", render: (p) => <Pill status={p.status} /> },
  { key: "workloads", label: "Workloads" },
  {
    key: "replicas_ready", label: "Replicas",
    filterValue: (p) => `${p.replicas_ready}/${p.replicas_desired}`,
    render: (p) => `${p.replicas_ready}/${p.replicas_desired}`,
  },
  { key: "pod_issues", label: "Pod issues", render: (p) => p.pod_issues || <Muted>0</Muted> },
  { key: "cpu_used_cores", label: "CPU", render: (p) => fmtCores(p.cpu_used_cores) },
  { key: "memory_used_bytes", label: "Memory", render: (p) => fmtBytes(p.memory_used_bytes) },
];

// `containers` and `config_refs` only arrive with detail=true, which this page
// always asks for - so the type has them optional and these two are where that
// is read once instead of at six call sites.
const envOf = (w: Workload) => (w.containers || []).flatMap((c) => c.env || []);
const refsOf = (w: Workload) => w.config_refs || [];

const WORKLOAD_COLUMNS: Column<Workload>[] = [
  { key: "cluster", label: "Cluster", className: "mono", filter: "text" },
  { key: "kind", label: "Kind", className: "muted", filter: "select" },
  { key: "name", label: "Name", filter: "text" },
  {
    key: "status", label: "Status", filter: "select",
    render: (w) => <Chip variant="outlined" label={w.status} data-status={w.status} sx={{ borderRadius: "5px", fontWeight: 400 }} />,
  },
  {
    key: "replicas", label: "Replicas",
    sortValue: (w) => w.replicas.ready,
    filterValue: (w) => `${w.replicas.ready}/${w.replicas.desired}`,
    render: (w) => `${w.replicas.ready}/${w.replicas.desired}`,
  },
  {
    key: "images", label: "Image", className: "mono wrap", filter: "text",
    sortValue: (w) => w.images.join(", "),
    render: (w) => w.images.join(", "),
  },
  {
    key: "env", label: "Env (name ← source)",
    sortValue: (w) => envOf(w).length,
    filterValue: (w) => envOf(w).map((e) => e.name).join(" "),
    render: (w) => (
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.375, fontSize: 12 }}>
        {envOf(w).map((e) => (
          <span key={e.name}><Mono>{e.name}</Mono> <Muted>
            {e.from?.kind === "literal" ? "(literal, scrubbed)" : e.from?.kind === "field" ? `← ${e.from.path}` : e.from ? `← ${e.from.kind} ${e.from.name}/${e.from.key}` : ""}
          </Muted></span>
        ))}
      </Box>
    ),
  },
  {
    key: "config_refs", label: "References", className: "muted wrap",
    sortValue: (w) => refsOf(w).length,
    filterValue: (w) => refsOf(w).map((r) => `${r.kind} ${r.name}`).join(", "),
    render: (w) => (
      <Box component="span" sx={{ fontSize: 12 }}>
        {refsOf(w).map((r) => `${r.kind} ${r.name} (${r.via})`).join(", ")}
      </Box>
    ),
  },
];

function ApplicationDetail({ app, nav }: { app: string; nav: Nav }) {
  const { data, error } = useFetch(() => api.application(app), [app]);
  // The row the user clicked is already in hand: the header renders from it
  // while the detail request is still out, so only the tables are pending.
  const summary = cache.search<ApplicationsResponse, Application>("/api/applications",
    (d) => (d.applications || []).find((x) => x.app === app));
  const a = data || summary;
  if (error && !data) return <ErrorBanner error={error} />;

  return (
    <Box>
      <Link
        component="button"
        type="button"
        color="text.secondary"
        onClick={() => nav.back("/applications")}
        sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, mb: 1.25, fontSize: 13 }}
      >
        <ArrowBackIcon fontSize="inherit" /> All applications
      </Link>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.75, mb: 2, flexWrap: "wrap" }}>
        <Typography variant="h1" component="h2">{a ? a.app : app}</Typography>
        {a && <Pill status={a.status} />}
        {a?.tier && <Tier tier={a.tier} />}
        {a?.team && <Muted>{a.namespace_environments?.length ? "LOB" : "team"} {a.team}</Muted>}
        {a?.assigned === false && <Muted>namespaces not under a business application</Muted>}
      </Box>
      <Stack spacing={2}>
        <Card flush title={`Placements${a ? ` (${a.cluster_count} clusters)` : ""}`}>
          {!data ? <SkeletonTable columns={8} rows={5} /> : (
            <DataTable
              id="application.placements"
              columns={PLACEMENT_COLUMNS}
              rows={data.placements}
              rowKey={(p) => `${p.cluster}/${p.namespace}`}
              onRowClick={(p) => nav.openCluster(p.cluster)}
              initialSort={{ key: "cluster", dir: "asc" }}
              empty="No placements."
            />
          )}
        </Card>
        <Card
          flush
          title={`Workloads${data ? ` (${data.workloads_detail.length})` : ""}`}
          description="Container env shows names and sources only - values are never collected."
        >
          {!data ? <SkeletonTable columns={7} rows={6} /> : (
            <DataTable
              id="application.workloads"
              columns={WORKLOAD_COLUMNS}
              rows={data.workloads_detail}
              rowKey={(w) => w.cluster + w.kind + w.name}
              initialSort={{ key: "cluster", dir: "asc" }}
              empty="No workloads."
            />
          )}
        </Card>
      </Stack>
    </Box>
  );
}
