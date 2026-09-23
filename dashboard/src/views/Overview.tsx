import { useEffect, useState } from "react";
import { Box, ButtonBase, LinearProgress, Paper, Stack, Typography } from "@mui/material";
import { api } from "../api";
import type { OverviewResponse } from "../api/types";
import { useFetch } from "../hooks";
import { useQueryFilters } from "../router";
import type { Nav, RouteApi } from "../router";
import {
  Card, HealthBar, Muted, SectionHead, Stat, StatGrid, SubTabs, Tag, ToneText,
  ErrorBanner, Pill, DataTable, Skeleton, SkeletonStats, SkeletonTable, fmtTime,
} from "../components";
import type { Column } from "../components";

/** One ACM hub, as `/api/health/overview` sends it. */
type HubRow = OverviewResponse["hubs"][number];

interface OverviewProps {
  nav: Nav;
  route: RouteApi;
}

const HUB_COLUMNS: Column<HubRow>[] = [
  { key: "name", label: "Hub", className: "mono", filter: "text" },
  { key: "region", label: "Region", filter: "select" },
  { key: "datacenter", label: "Data center", filter: "select" },
  { key: "managed_count", label: "Managed" },
  {
    key: "reachable", label: "Status", filter: "select",
    filterValue: (h) => (h.reachable ? "healthy" : "critical"),
    render: (h) => <Pill status={h.reachable ? "healthy" : "critical"} />,
  },
  { key: "last_synced", label: "Last synced", className: "muted", render: (h) => fmtTime(h.last_synced) },
  {
    key: "last_error", label: "Error", className: "muted", filter: "text",
    render: (h) => (
      <Box component="span" sx={{ fontSize: 12, maxWidth: 420, wordBreak: "break-word", display: "inline-block" }}>
        {h.last_error || ""}
      </Box>
    ),
  },
];

/** [grouping key, what the button says]; the key is what `/api/health/summary`
 * is asked to group by. */
const GROUPS: Array<[key: string, label: string]> = [
  ["hub", "Hub"],
  ["region", "Region"],
  ["datacenter", "Data center"],
  ["environment", "Environment"],
  ["version", "OCP version"],
];

export default function Overview({ nav, route }: OverviewProps) {
  // The grouping is in the URL (/?group=region), so the view someone shares is
  // the view they were looking at.
  const [q, setQ] = useQueryFilters(route, ["group"]);
  const groupBy = GROUPS.some(([k]) => k === q.group) ? q.group : "hub";

  // While a sweep is running the picture fills in cluster by cluster, so the
  // overview re-reads itself every few seconds until it is done. The URL does
  // not change, so this is a cache refresh in place - the numbers move, the
  // page does not blink.
  const [tick, setTick] = useState(0);
  const ov = useFetch(() => api.overview(), [tick]);
  const sweeping = !!ov.data?.sweep?.running;
  useEffect(() => {
    if (!sweeping) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, [sweeping]);
  const sum = useFetch(() => api.summary(groupBy), [groupBy]);
  const ins = useFetch(() => api.insightsSummary(), []);

  if (ov.error && !ov.data) return <ErrorBanner error={ov.error} />;
  const d = ov.data;
  const i = ins.data;
  const sw = d?.sweep;

  return (
    <Stack spacing={3}>
      {sw?.running && (
        <Paper sx={{ p: "10px 14px", display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
          <Tag>sweep in progress</Tag>
          <Typography variant="body1">
            {sw.done ?? 0} of {sw.total} clusters collected{sw.failed ? `, ${sw.failed} failed` : ""}
          </Typography>
          <LinearProgress
            variant="determinate"
            value={sw.total ? Math.round((100 * (sw.done ?? 0)) / sw.total) : 0}
            sx={{ flex: 1, minWidth: 120, height: 6, borderRadius: "3px" }}
          />
          <Muted sx={{ fontSize: 12 }}>started {fmtTime(sw.started_at)}</Muted>
          {(sw.collectors || []).length > 1 && (
            <Muted sx={{ fontSize: 12, whiteSpace: "nowrap" }}>
              {(sw.collectors || []).map((c) => `${(c.hubs || []).join(",") || "all"}${c.shard ? " " + c.shard : ""} ${c.done}/${c.total}${c.running ? "" : " done"}`).join(" · ")}
            </Muted>
          )}
        </Paper>
      )}

      {!d ? <SkeletonStats count={6} /> : (
        <StatGrid>
          <Stat label="Clusters" value={d.clusters_total} kind="accent" onClick={() => nav.goClusters()} />
          <Stat label="Healthy" value={d.counts.healthy} kind="healthy" onClick={() => nav.goClusters("status", "healthy")} />
          <Stat label="Warning" value={d.counts.warning} kind="warning" onClick={() => nav.goClusters("status", "warning")} />
          <Stat label="Critical" value={d.counts.critical} kind="critical" onClick={() => nav.goClusters("status", "critical")} />
          <Stat label="Upgrading" value={d.upgrading} kind="accent" onClick={() => nav.goClusters("upgrading", "true")} />
          <Stat label="Applications" value={i ? i.applications : "…"} kind="accent" onClick={() => nav.openApp(null)} />
        </StatGrid>
      )}

      <Box>
        <SectionHead
          title="Needs attention"
          description="Everything below is read from the clusters' own API servers - nothing external."
        />
        {ins.error && !i ? <ErrorBanner error={ins.error} /> : !i ? <SkeletonStats count={10} /> : (
          <StatGrid>
            <Stat label="Expired certificates" value={i.certificates.expired}
              kind={i.certificates.expired ? "critical" : "healthy"} onClick={() => nav.goInsights("certificates")} />
            <Stat label="Certificates expiring" value={i.certificates.expiring}
              kind={i.certificates.expiring ? "warning" : "healthy"} onClick={() => nav.goInsights("certificates")} />
            <Stat label="Platform pod issues" value={i.pod_issues.platform}
              kind={i.pod_issues.platform ? "warning" : "healthy"} onClick={() => nav.goInsights("pods")} />
            <Stat label="App pod issues" value={i.pod_issues.application}
              kind={i.pod_issues.application ? "warning" : "healthy"} onClick={() => nav.goInsights("pods")} />
            <Stat label="Quotas near limit" value={i.quotas_near_limit}
              kind={i.quotas_near_limit ? "warning" : "healthy"} onClick={() => nav.goInsights("quotas")} />
            <Stat label="MCPs degraded" value={i.machine_config_pools.degraded} sub={`${i.machine_config_pools.updating} updating`}
              kind={i.machine_config_pools.degraded ? "critical" : "healthy"} onClick={() => nav.goInsights("mcp")} />
            <Stat label="OLM operators unhealthy" value={i.olm_operators_unhealthy} sub={`${i.olm_upgrades_pending} upgrades pending`}
              kind={i.olm_operators_unhealthy ? "warning" : "healthy"} onClick={() => nav.goInsights("olm")} />
            <Stat label="PVCs pending" value={i.pvcs_pending}
              kind={i.pvcs_pending ? "warning" : "healthy"} onClick={() => nav.goInsights("storage")} />
            <Stat label="Warning events" value={i.warning_events} kind="unknown" onClick={() => nav.goInsights("events")} />
            <Stat label="Clusters without metrics" value={i.clusters_without_metrics}
              kind={i.clusters_without_metrics ? "warning" : "healthy"} />
          </StatGrid>
        )}
      </Box>

      <Card title="Hubs (ACM)">
        {!d ? <SkeletonTable columns={7} rows={3} /> : (
          <DataTable
            id="overview.hubs"
            columns={HUB_COLUMNS}
            rows={d.hubs}
            rowKey="name"
            initialSort={{ key: "name", dir: "asc" }}
            empty="No hubs configured."
          />
        )}
        {d?.last_collection && (
          <Muted sx={{ display: "block", fontSize: 12, mt: 1.25 }}>
            Last sweep: {d.last_collection.clusters_ok} ok / {d.last_collection.clusters_failed} failed in {d.last_collection.duration_ms} ms
          </Muted>
        )}
      </Card>

      <Box>
        <SectionHead title="Fleet health">
          <SubTabs tabs={GROUPS} value={groupBy} onChange={(key) => setQ("group", key)} />
        </SectionHead>
        {sum.error && !sum.data ? <ErrorBanner error={sum.error} /> : !sum.data ? <GroupSkeleton /> : (
          <GroupGrid>
            {sum.data.groups.map((g) => (
              <Paper key={g.key} sx={{ "&:hover": { borderColor: "primary.main" } }}>
                <ButtonBase
                  onClick={() => nav.goClusters(groupBy, g.key)}
                  sx={{ display: "block", width: "100%", textAlign: "left", p: 2, borderRadius: "inherit" }}
                >
                  <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 1.5 }}>
                    <Typography variant="h3" component="span">{g.key}</Typography>
                    <Pill status={g.rollup_status} />
                  </Box>
                  <HealthBar counts={g.counts} />
                  <Box sx={{ display: "flex", gap: 1.75, mt: 1.5, fontSize: 12.5, color: "text.secondary", flexWrap: "wrap" }}>
                    <span><b>{g.total}</b> {g.total === 1 ? "cluster" : "clusters"}</span>
                    {g.applications != null && (
                      <span>
                        <b>{g.applications}</b> {g.applications === 1 ? "application" : "applications"}
                        {g.unassigned_namespaces ? <Muted> (+{g.unassigned_namespaces} ns unassigned)</Muted> : null}
                      </span>
                    )}
                    {g.counts.healthy ? <ToneText tone="healthy">{g.counts.healthy} healthy</ToneText> : null}
                    {g.counts.warning ? <ToneText tone="warning">{g.counts.warning} warning</ToneText> : null}
                    {g.counts.critical ? <ToneText tone="critical">{g.counts.critical} critical</ToneText> : null}
                  </Box>
                </ButtonBase>
              </Paper>
            ))}
          </GroupGrid>
        )}
      </Box>
    </Stack>
  );
}

/** The fleet-health cards: as many columns of at least 280px as fit. */
function GroupGrid({ children, hidden }: { children?: React.ReactNode; hidden?: boolean }) {
  return (
    <Box
      aria-hidden={hidden || undefined}
      sx={{ display: "grid", gap: 2, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
    >
      {children}
    </Box>
  );
}

function GroupSkeleton() {
  return (
    <GroupGrid hidden>
      {Array.from({ length: 4 }, (_, i) => (
        <Paper key={i} sx={{ p: 2 }}>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 1.5 }}>
            <Skeleton width="45%" height={15} />
            <Skeleton width={62} height={18} />
          </Box>
          <Skeleton width="100%" height={10} />
          <Box sx={{ display: "flex", gap: 1.75, mt: 1.5 }}>
            <Skeleton width="30%" height={12} />
            <Skeleton width="38%" height={12} />
          </Box>
        </Paper>
      ))}
    </GroupGrid>
  );
}
