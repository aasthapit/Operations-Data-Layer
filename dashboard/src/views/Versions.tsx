import { Box, Link, Stack } from "@mui/material";
import { api } from "../api";
import type { OperatorVersionsResponse } from "../api/types";
import { useFetch } from "../hooks";
import {
  Card, Dot, Mono, Muted, Pill, Tag, ErrorBanner, DataTable, SkeletonLines, SkeletonTable,
} from "../components";
import type { Column } from "../components";

/** One operator's spread across the fleet, as `/api/versions/operators` sends it. */
type OperatorRow = OperatorVersionsResponse["operators"][number];

interface VersionsProps {
  onOpen: (name: string) => void;
  onBlast: (version: string) => void;
}

// Annotating the list is what types every callback's row below it, and what
// narrows `filter: "text"` to the column vocabulary rather than to `string`.
const OPERATOR_COLUMNS: Column<OperatorRow>[] = [
  { key: "operator", label: "Operator", filter: "text" },
  {
    key: "versions", label: "Versions in fleet", className: "mono", filter: "text",
    sortValue: (o) => o.distinct,
    filterValue: (o) => o.versions.map((v) => v.version).join(", "),
    render: (o) => o.versions.map((v) => `${v.version} (${v.count})`).join(", "),
  },
  { key: "distinct", label: "Drift", sortValue: (o) => o.distinct, render: () => <Pill status="warning" /> },
];

export default function Versions({ onOpen, onBlast }: VersionsProps) {
  const { data, error } = useFetch(() => api.versions(), []);
  const ops = useFetch(() => api.operatorVersions(), []);

  if (error && !data) return <ErrorBanner error={error} />;

  const maxCount = data ? Math.max(...data.versions.map((v) => v.count), 1) : 1;

  return (
    <Stack spacing={2.5}>
      <Card title="OCP version distribution">
        {!data ? <SkeletonLines rows={4} height={44} /> : data.versions.map((v) => (
          <Box key={v.version} sx={{ mb: 1.75 }}>
            <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
              <Mono>{v.version} <Muted>· {v.count} cluster{v.count > 1 ? "s" : ""}</Muted></Mono>
              <Link component="button" type="button" onClick={() => onBlast(v.version)} sx={{ fontSize: 12.5 }}>
                blast radius →
              </Link>
            </Box>
            {/* How much of the fleet sits on this version, against the version
                that has the most: a share, not a percentage of anything. */}
            <Box sx={{
              height: 22, borderRadius: "6px", overflow: "hidden", bgcolor: "background.subtle",
            }}>
              <Box sx={{
                height: "100%", width: `${(v.count / maxCount) * 100}%`, bgcolor: "primary.main",
              }} />
            </Box>
            <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", mt: 0.75 }}>
              {v.clusters.map((c) => (
                <Tag key={c.name} onClick={() => onOpen(c.name)}>
                  <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
                    <Dot status={c.status} />{c.name}
                  </Box>
                </Tag>
              ))}
            </Box>
          </Box>
        ))}
      </Card>

      <Card
        flush
        title="Operator version spread"
        description="Operators reporting more than one version across the fleet are drifting - usually a partial rollout."
      >
        {ops.error && !ops.data ? <ErrorBanner error={ops.error} /> : !ops.data ? <SkeletonTable columns={3} rows={5} /> : (
          <DataTable
            id="versions.operators"
            columns={OPERATOR_COLUMNS}
            rows={ops.data.operators.filter((o) => o.distinct > 1)}
            rowKey="operator"
            initialSort={{ key: "operator", dir: "asc" }}
            empty="All operators are on a single version across the fleet."
          />
        )}
      </Card>
    </Stack>
  );
}
