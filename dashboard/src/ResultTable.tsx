// A query result, as a table.
//
// The Query page shows one of these under its chart and every dashboard panel
// that is not a chart is one of these, so the rules about how a value is drawn -
// a cluster name is a link, a status is a chip, a long string is truncated with
// the whole of it in the title - are written once and both pages obey them.
import { useMemo } from "react";
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import type { SxProps, Theme } from "@mui/material/styles";
import { DataTable, Mono, Muted, Pill, StatusChip } from "./components";
import type { Column } from "./components";
import { MONO_FONT } from "./theme";
import type { QueryResult, QueryRow } from "./api/types";

const STATUS_WORD = /^[a-z][a-z-]{1,19}$/;

// What `.q-trunc` in styles.css drew: one line, clipped, the whole value kept
// in `title` for a hover. `noWrap` alone would clip without the ellipsis this
// column has always shown, so the rules that draw both are spelled out here.
const TRUNC_SX: SxProps<Theme> = {
  display: "inline-block", maxWidth: 360, overflow: "hidden",
  textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom",
};

/**
 * What a table can be drawn from: a query result that ran. A batch entry that
 * failed carries `error` and the SQL it tried instead, and never gets here.
 *
 * Everything but `columns` and `rows` is optional because a dashboard panel
 * hands over a `BatchEntry`, which carries only what the batch answered with.
 * The rows are `QueryRow[]` - the same type `QueryResult` and `Chart` use, so
 * a nested DuckDB value is one shape across the app rather than three.
 */
export type TableResult = Omit<Partial<QueryResult>, "columns" | "rows"> & {
  columns: string[];
  rows: QueryRow[];
};

/** The two places a result cell can navigate to. It is spelled out rather than
 * taken from App's whole nav object, because that is all this table uses. */
export interface ResultNav {
  openCluster: (name: string, tab?: string) => void;
  openApp: (name?: string) => void;
}

/** What a column's values are worth linking to, if anything. */
export type LinkKind = "cluster" | "app" | null;

/** One row of a result, as the table holds it: the position it arrived in, and
 * the values by column index. */
interface ResultRow {
  i: number;
  values: TableResult["rows"][number];
}

// A cluster name is always worth a link; a bare `name` only when the builder
// knows the query is over clusters (custom SQL can call anything `name`).
export function linkKindFor(name: string, mode?: string, table?: string): LinkKind {
  if (name === "cluster_name" || name === "cluster") return "cluster";
  if (name === "name" && mode === "builder" && table === "clusters") return "cluster";
  if (name === "app_name" || name === "application") return "app";
  return null;
}

export interface CellProps {
  /** The column's name, which is what the status and overall-status rules read. */
  name: string;
  value: unknown;
  link?: LinkKind;
  nav?: ResultNav | null;
}

export function Cell({ name, value, link, nav }: CellProps) {
  if (value == null) return <Muted>—</Muted>;
  if (typeof value === "boolean") {
    return <Mono sx={value ? undefined : { color: "text.disabled" }}>{String(value)}</Mono>;
  }
  if (typeof value === "number") return <Mono>{value}</Mono>;
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return <Mono title={text} sx={TRUNC_SX}>{text}</Mono>;
  }
  const text = String(value);
  if (link === "cluster" && text && nav) {
    return (
      <Link component="button" type="button" onClick={() => nav.openCluster(text)}
        sx={{ fontFamily: MONO_FONT, fontSize: 12.5 }}>
        {text}
      </Link>
    );
  }
  if (link === "app" && text && nav) {
    return <Link component="button" type="button" onClick={() => nav.openApp(text)}>{text}</Link>;
  }
  if (/(^|_)overall_status$/.test(name)) return <Pill status={text} />;
  if (/(^|_)status$/.test(name) && STATUS_WORD.test(text)) {
    return <StatusChip status={text} />;
  }
  if (text.length > 48) return <Box component="span" title={text} sx={TRUNC_SX}>{text}</Box>;
  return text;
}

export interface ResultTableProps {
  result?: TableResult | null;
  /** The key the sort, filters and search are remembered under. */
  id?: string;
  nav?: ResultNav | null;
  /** How the query was written, which is what decides whether a bare `name`
   * column is a cluster. */
  mode?: string;
  /** The table the builder was pointed at, for the same reason. */
  table?: string;
  dense?: boolean;
  scroll?: boolean;
  pageSize?: number;
  /** Whether the columns carry a per-column filter row. */
  filter?: boolean;
  empty?: ReactNode;
  searchPlaceholder?: string;
  footer?: ReactNode;
}

export default function ResultTable({
  result, id, nav, mode, table,
  dense = true, scroll = false, pageSize, filter = true,
  empty = "The query ran and returned no rows.", searchPlaceholder = "Search results",
  footer,
}: ResultTableProps) {
  const rows = useMemo<ResultRow[]>(
    () => (result ? result.rows.map((values, i) => ({ i, values })) : []), [result]);

  const columns = useMemo<Column<ResultRow>[]>(() => {
    if (!result) return [];
    return result.columns.map((name, i) => {
      // A column whose every present value is a number is a measure: right-align
      // it and sort it as a number rather than as text.
      let numeric = false;
      for (const row of result.rows) {
        const v = row[i];
        if (v == null) continue;
        if (typeof v !== "number") { numeric = false; break; }
        numeric = true;
      }
      const link = linkKindFor(name, mode, table);
      return {
        key: `${i}:${name}`,
        label: name,
        filter: filter ? "text" : undefined,
        // No `nowrap` of its own any more: the grid keeps a cell to one line
        // and clips what does not fit, and `Cell` already carries the whole of
        // a long value in its title, which is what the class was for.
        align: numeric ? ("right" as const) : undefined,
        sortValue: (r) => r.values[i],
        filterValue: (r) => {
          const v = r.values[i];
          if (v == null) return "";
          return typeof v === "object" ? JSON.stringify(v) : String(v);
        },
        render: (r) => <Cell name={name} value={r.values[i]} link={link} nav={nav} />,
      };
    });
  }, [result, mode, table, nav, filter]);

  return (
    <DataTable
      id={id}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.i}
      dense={dense}
      scroll={scroll}
      pageSize={pageSize}
      empty={empty}
      searchPlaceholder={searchPlaceholder}
      footer={footer}
    />
  );
}
