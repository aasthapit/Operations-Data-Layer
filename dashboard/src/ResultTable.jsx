// A query result, as a table.
//
// The Query page shows one of these under its chart and every dashboard panel
// that is not a chart is one of these, so the rules about how a value is drawn -
// a cluster name is a link, a status is a chip, a long string is truncated with
// the whole of it in the title - are written once and both pages obey them.
import { useMemo } from "react";
import { DataTable, Pill } from "./components";

const STATUS_WORD = /^[a-z][a-z-]{1,19}$/;

// A cluster name is always worth a link; a bare `name` only when the builder
// knows the query is over clusters (custom SQL can call anything `name`).
export function linkKindFor(name, mode, table) {
  if (name === "cluster_name" || name === "cluster") return "cluster";
  if (name === "name" && mode === "builder" && table === "clusters") return "cluster";
  if (name === "app_name" || name === "application") return "app";
  return null;
}

export function Cell({ name, value, link, nav }) {
  if (value == null) return <span className="muted">—</span>;
  if (typeof value === "boolean") {
    return <span className={`mono${value ? "" : " muted"}`}>{String(value)}</span>;
  }
  if (typeof value === "number") return <span className="mono">{value}</span>;
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return <span className="mono q-trunc" title={text}>{text}</span>;
  }
  const text = String(value);
  if (link === "cluster" && text && nav) {
    return <span className="link mono" onClick={() => nav.openCluster(text)}>{text}</span>;
  }
  if (link === "app" && text && nav) {
    return <span className="link" onClick={() => nav.openApp(text)}>{text}</span>;
  }
  if (/(^|_)overall_status$/.test(name)) return <Pill status={text} />;
  if (/(^|_)status$/.test(name) && STATUS_WORD.test(text)) {
    return <span className={`chip ${text}`}>{text}</span>;
  }
  if (text.length > 48) return <span className="q-trunc" title={text}>{text}</span>;
  return text;
}

export default function ResultTable({
  result, id, nav, mode, table,
  dense = true, scroll = false, pageSize, filter = true,
  empty = "The query ran and returned no rows.", searchPlaceholder = "Search results",
  footer,
}) {
  const rows = useMemo(
    () => (result ? result.rows.map((values, i) => ({ i, values })) : []), [result]);

  const columns = useMemo(() => {
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
        // A result cell never wraps: short values stay on one line and long
        // ones are truncated with the full text in the title, so the table
        // scrolls sideways instead of growing rows three lines tall.
        className: "nowrap",
        align: numeric ? "right" : undefined,
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
