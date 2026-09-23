import { useEffect, useRef, useState } from "react";
import { Box, Button, Checkbox, FormControlLabel, Stack, TextField, Tooltip } from "@mui/material";
import { api } from "../api";
import type { ApiError } from "../api";
import type { BlastRadiusResponse } from "../api/types";
import { useFetch } from "../hooks";
import type { Nav, RouteApi } from "../router";
import {
  Card, Empty, KeyLabel, Mono, Stat, StatGrid, Tag,
  Pill, ErrorBanner, Tier, DataTable, SkeletonStats, SkeletonTable,
} from "../components";
import type { Column } from "../components";

type ClusterRow = BlastRadiusResponse["clusters"][number];
type AppRow = BlastRadiusResponse["applications"][number];
type WorkloadRow = BlastRadiusResponse["workloads"][number];

/** The impact query as the form holds it: every text field is "" rather than
 * null when it is unset, because these are the values of <select>s and
 * <input>s. `api.blastRadius` checks it against the parameters the generated
 * document declares, so a renamed handler parameter fails here.
 *
 * It is a type alias rather than an interface on purpose: only an alias carries
 * the implicit index signature `nav.goBlast`'s `QueryValues` needs. */
type BlastQuery = {
  operator: string;
  operator_version: string;
  ocp_version: string;
  degraded_only: boolean;
  olm_operator: string;
  olm_version: string;
  image: string;
};

interface BlastRadiusProps {
  route: RouteApi;
  nav: Nav;
}

const CLUSTER_COLUMNS: Column<ClusterRow>[] = [
  { key: "name", label: "Cluster", className: "mono", filter: "text" },
  { key: "hub", label: "Hub", className: "mono", filter: "select" },
  { key: "environment", label: "Env", filter: "select", render: (c) => <Tag>{c.environment}</Tag> },
  { key: "reason", label: "Match", className: "muted wrap", filter: "text" },
  { key: "status", label: "Status", filter: "select", render: (c) => <Pill status={c.status} /> },
];

const APP_COLUMNS: Column<AppRow>[] = [
  { key: "app", label: "Application", filter: "text" },
  { key: "team", label: "Team", className: "muted", filter: "select" },
  { key: "tier", label: "Tier", filter: "select", render: (a) => <Tier tier={a.tier} /> },
  {
    key: "cluster_count", label: "Clusters",
    filterValue: (a) => a.clusters.map((c) => c.cluster).join(", "),
    render: (a) => (
      <Tooltip title={a.clusters.map((c) => c.cluster).join(", ")}>
        <span>{a.cluster_count}</span>
      </Tooltip>
    ),
  },
];

const WORKLOAD_COLUMNS: Column<WorkloadRow>[] = [
  { key: "cluster", label: "Cluster", className: "mono", filter: "text" },
  { key: "namespace", label: "Namespace", filter: "text" },
  {
    key: "workload", label: "Workload", filter: "text",
    sortValue: (w) => `${w.kind}/${w.name}`,
    filterValue: (w) => `${w.kind}/${w.name}`,
    render: (w) => `${w.kind}/${w.name}`,
  },
  { key: "container", label: "Container", className: "muted", filter: "select" },
  { key: "image", label: "Image", className: "mono", filter: "text" },
];

// The query is the URL: /blast?ocp_version=4.16.7 is a shareable impact report,
// and the back button walks back through the queries that were run.
//
// Written out field by field rather than looped over an empty template: the
// checkbox is a boolean and the rest are strings, so one loop cannot fill them
// both without lying about the type of what it assigns.
function fromRoute(route: RouteApi): BlastQuery {
  return {
    operator: route.query.operator || "",
    operator_version: route.query.operator_version || "",
    ocp_version: route.query.ocp_version || "",
    degraded_only: route.query.degraded_only === "true",
    olm_operator: route.query.olm_operator || "",
    olm_version: route.query.olm_version || "",
    image: route.query.image || "",
  };
}

interface PickerProps {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

/** One dropdown of the impact form. Native, like the filter bars: a short list
 * of versions, six controls on one row. */
function Picker({ label, value, options, onChange, disabled }: PickerProps) {
  return (
    <TextField
      select
      label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
      sx={{ minWidth: 150 }}
    >
      <option value="">Any</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </TextField>
  );
}

export default function BlastRadius({ route, nav }: BlastRadiusProps) {
  const ops = useFetch(() => api.operatorVersions(), []);
  const vers = useFetch(() => api.versions(), []);
  const olm = useFetch(() => api.olmOperators(), []);

  const urlQuery = fromRoute(route);
  const urlKey = JSON.stringify(urlQuery);

  const [q, setQ] = useState<BlastQuery>(urlQuery);
  const [result, setResult] = useState<BlastRadiusResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  // The query that was last run, as its JSON: what says whether landing on a
  // URL still has to run it.
  const ran = useRef<string | null>(null);
  const set = <K extends keyof BlastQuery>(k: K, v: BlastQuery[K]) =>
    setQ((s) => ({ ...s, [k]: v }));
  const canRun = q.operator || q.ocp_version || q.olm_operator || q.image;

  const execute = async (query: BlastQuery, key: string) => {
    ran.current = key;
    setBusy(true); setError(null);
    try { setResult(await api.blastRadius(query)); } catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  };

  // Landing on a query - a blast-radius link, a reload, or the back button -
  // restores the form and runs it.
  useEffect(() => {
    setQ(urlQuery);
    if (!Object.values(urlQuery).some(Boolean)) {
      ran.current = null;
      setResult(null);
      return;
    }
    if (ran.current !== urlKey) execute(urlQuery, urlKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey]);

  // Running is a push: the previous query stays one back button away. Asking
  // for the query already in the URL just re-runs it.
  const run = () => {
    const key = JSON.stringify(q);
    nav.goBlast(q);
    if (key === urlKey) execute(q, key);
  };

  const operatorNames = (ops.data?.operators || []).map((o) => o.operator);
  const operatorVersionOpts = q.operator
    ? (ops.data?.operators.find((o) => o.operator === q.operator)?.versions || []).map((v) => v.version)
    : [];
  const ocpVersionOpts = (vers.data?.versions || []).map((v) => v.version);
  const olmPackages = (olm.data?.operators || []).map((o) => o.package);
  const olmVersionOpts = q.olm_operator
    ? (olm.data?.operators.find((o) => o.package === q.olm_operator)?.versions || []).map((v) => v.version)
    : [];

  return (
    <Box>
      <Card
        title="Impact query"
        description={"Pick a bad OCP version, cluster operator, OLM operator, or container image. The data layer maps it to the"
          + " clusters carrying it, the applications (namespaces + teams) riding on top, and for images the exact workloads."}
        sx={{ mb: 2.5 }}
      >
        <Stack direction="row" spacing={1.25} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
          <Picker label="OCP version" value={q.ocp_version} options={ocpVersionOpts}
            onChange={(v) => set("ocp_version", v)} />
          <Picker label="Cluster operator" value={q.operator} options={operatorNames}
            onChange={(v) => { set("operator", v); set("operator_version", ""); }} />
          <Picker label="Operator version" value={q.operator_version} options={operatorVersionOpts}
            onChange={(v) => set("operator_version", v)} disabled={!q.operator} />
          <FormControlLabel
            control={(
              <Checkbox
                checked={q.degraded_only}
                onChange={(e) => set("degraded_only", e.target.checked)}
              />
            )}
            label="degraded only"
          />
          <Picker label="OLM operator" value={q.olm_operator} options={olmPackages}
            onChange={(v) => { set("olm_operator", v); set("olm_version", ""); }} />
          <Picker label="OLM version" value={q.olm_version} options={olmVersionOpts}
            onChange={(v) => set("olm_version", v)} disabled={!q.olm_operator} />
          <TextField
            label="Image (substring)"
            placeholder="e.g. pause:3.9 or quay.io/acme"
            value={q.image}
            onChange={(e) => set("image", e.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ minWidth: 240 }}
          />
          <Button variant="contained" onClick={run} disabled={busy || !canRun}>
            {busy ? "Querying…" : "Compute blast radius"}
          </Button>
        </Stack>
      </Card>

      <ErrorBanner error={error} />
      {result ? (
        <Result result={result} nav={nav} />
      ) : busy ? (
        <Stack spacing={2.5}>
          <SkeletonStats count={4} />
          <Card flush><SkeletonTable columns={5} rows={6} /></Card>
        </Stack>
      ) : (
        <Empty>Run a query to see the impact.</Empty>
      )}
    </Box>
  );
}

/** One column of the spread: a caption and the tallies under it. A list, so a
 * screen reader announces how many entries there are before reading them. */
function SpreadList({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Box>
      <KeyLabel sx={{ display: "block", mb: 0.75 }}>{label}</KeyLabel>
      <Box component="ul" aria-label={label} sx={{ listStyle: "none", m: 0, p: 0 }}>{children}</Box>
    </Box>
  );
}

function Result({ result, nav }: { result: BlastRadiusResponse; nav: Nav }) {
  const s = result.summary;
  return (
    <Stack spacing={2.5}>
      <StatGrid>
        <Stat label="Clusters impacted" value={s.clusters_impacted} kind="critical" />
        <Stat label="Applications" value={s.applications_impacted} kind="warning" />
        <Stat label="Critical apps" value={s.critical_applications} kind="critical" />
        <Stat label="Teams" value={s.teams_impacted} kind="accent" />
        {s.workloads_impacted > 0 && <Stat label="Workloads" value={s.workloads_impacted} kind="warning" />}
      </StatGrid>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, gap: 2 }}>
        <Card flush title="Impacted clusters">
          <DataTable
            id="blast.clusters"
            columns={CLUSTER_COLUMNS}
            rows={result.clusters}
            rowKey="name"
            onRowClick={(c) => nav.openCluster(c.name)}
            initialSort={{ key: "name", dir: "asc" }}
            empty="No clusters matched."
          />
        </Card>

        <Card flush title="Impacted applications">
          <DataTable
            id="blast.applications"
            columns={APP_COLUMNS}
            rows={result.applications}
            rowKey="app"
            onRowClick={(a) => nav.openApp(a.app)}
            initialSort={{ key: "app", dir: "asc" }}
            empty="No applications on matched clusters."
          />
        </Card>
      </Box>

      {result.workloads.length > 0 && (
        <Card flush title="Impacted workloads">
          <DataTable
            id="blast.workloads"
            columns={WORKLOAD_COLUMNS}
            rows={result.workloads}
            rowKey={(w, i) => `${w.cluster}/${w.namespace}/${w.kind}/${w.name}/${w.container}/${i}`}
            onRowClick={(w) => nav.openCluster(w.cluster)}
            initialSort={{ key: "cluster", dir: "asc" }}
            empty="No workloads matched."
          />
        </Card>
      )}

      <Card title="Spread">
        <Box sx={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <SpreadList label="By environment">
            {Object.entries(s.by_environment).map(([k, v]) => (
              <Box component="li" key={k}><Tag>{k}</Tag> {v}</Box>
            ))}
          </SpreadList>
          <SpreadList label="By hub">
            {Object.entries(s.by_hub || s.by_region).map(([k, v]) => (
              <Box component="li" key={k}><Tag>{k}</Tag> {v}</Box>
            ))}
          </SpreadList>
          {s.platform_namespaces_impacted.length > 0 && (
            <SpreadList label="Platform namespaces">
              {s.platform_namespaces_impacted.map((n) => (
                <Box component="li" key={n}><Mono>{n}</Mono></Box>
              ))}
            </SpreadList>
          )}
        </Box>
      </Card>
    </Stack>
  );
}
