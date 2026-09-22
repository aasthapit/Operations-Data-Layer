import { api } from "../api";
import type { OperatorVersionsResponse } from "../api/types";
import { useFetch } from "../hooks";
import { Pill, ErrorBanner, DataTable, SkeletonLines, SkeletonTable } from "../components";
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
    <div className="grid" style={{ gap: 20 }}>
      <div className="card">
        <h3>OCP version distribution</h3>
        {!data ? <SkeletonLines rows={4} height={44} /> : data.versions.map((v) => (
          <div key={v.version} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span className="mono">{v.version} <span className="muted">· {v.count} cluster{v.count > 1 ? "s" : ""}</span></span>
              <a onClick={() => onBlast(v.version)} style={{ cursor: "pointer", fontSize: 12.5 }}>blast radius →</a>
            </div>
            <div className="hbar" style={{ height: 22, background: "var(--bg-elev-2)" }}>
              <span className="healthy" style={{ width: `${(v.count / maxCount) * 100}%`, background: "var(--accent)" }} />
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              {v.clusters.map((c) => (
                <span key={c.name} className="tag clickable" style={{ cursor: "pointer" }} onClick={() => onOpen(c.name)}>
                  <span className={`dot-s ${c.status}`} style={{ marginRight: 4 }} />{c.name}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: "18px 18px 0" }}>
          <h3>Operator version spread</h3>
          <p className="dim" style={{ marginTop: -6 }}>Operators reporting more than one version across the fleet are drifting - usually a partial rollout.</p>
        </div>
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
      </div>
    </div>
  );
}
