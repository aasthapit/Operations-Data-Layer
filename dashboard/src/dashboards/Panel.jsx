// One panel on the grid: a header that says what it is and how much it cost,
// and a body that is the answer.
//
// The body is whichever of three things the result supports, in order: the chart
// the panel asks for when the columns can carry it, the rows as a dense table
// when they cannot, and the reason there is nothing when the query did not run.
// A panel waiting on a variable is not an error - it is an instruction.
import { useMemo } from "react";
import Chart, { inferFields, resolveSpec } from "../Chart";
import ResultTable from "../ResultTable";
import { SkeletonTable } from "../components";
import { Menu } from "./ui";
import {
  interpolateText, panelChartHeight, substituteSql, unsetVariableIn, variableByName,
  variableLabel,
} from "./model";

const article = (word) => (/^[aeiou]/i.test(word) ? "an" : "a");

// A table only carries a filter row when the panel is tall enough that the row
// does not eat the rows it filters.
const FILTER_MIN_H = 3;

export default function Panel({
  panel, definition, result, params, loading, nav, editing, busy,
  onOpenQuery, onEdit, onRemove, onMove, first, last,
}) {
  const title = interpolateText(panel.title, params);
  const fields = useMemo(
    () => (result && result.columns ? inferFields(result.columns, result.column_types, result.rows) : []),
    [result]);
  const spec = useMemo(
    () => (fields.length ? resolveSpec(fields, result.rows, panel.chart) : null),
    [fields, result, panel.chart]);

  const error = result && result.error ? String(result.error) : null;
  const unset = error ? unsetVariableIn(error) : null;
  const rows = result && !error ? result.row_count : null;

  const items = [
    { label: "Open in Query", onSelect: onOpenQuery },
    editing && { label: "Edit", onSelect: onEdit },
    editing && { label: "Remove", onSelect: onRemove, danger: true },
  ];

  return (
    <section
      // `busy` is a panel the agent is in the middle of rewriting: the rows on
      // screen are the old answer, so the panel says so rather than pretending
      // they are the new one.
      className={`db-panel card${spec ? " is-chart" : ""}${busy ? " is-busy" : ""}`}
      style={{ "--w": panel.w, "--h": panel.h }}
      aria-label={title}
      aria-busy={busy || undefined}
    >
      <header className="db-panel-head">
        <h4 className="db-panel-title" title={title}>
          {title}
          {panel.description && (
            <span className="db-info" title={panel.description} aria-label={panel.description}>i</span>
          )}
        </h4>
        <div className="db-panel-tools">
          {rows != null && (
            <span className="db-panel-meta">
              {rows.toLocaleString()} {rows === 1 ? "row" : "rows"}
              {result.elapsed_ms != null ? ` · ${result.elapsed_ms} ms` : ""}
              {result.truncated ? " · truncated" : ""}
            </span>
          )}
          {editing && (
            <span className="db-move">
              <button type="button" className="q-mini" disabled={first}
                title="Move up" aria-label={`Move ${title} up`}
                onClick={() => onMove(-1)}>↑</button>
              <button type="button" className="q-mini" disabled={last}
                title="Move down" aria-label={`Move ${title} down`}
                onClick={() => onMove(1)}>↓</button>
            </span>
          )}
          <Menu items={items} title={`Menu for ${title}`} />
        </div>
      </header>

      <div className="db-panel-body">
        {unset ? (
          <div className="db-panel-msg">
            Choose {article(variableLabel(variableByName(definition, unset) || { name: unset }))}{" "}
            {variableLabel(variableByName(definition, unset) || { name: unset }).toLowerCase()} above.
          </div>
        ) : error ? (
          <div className="db-panel-error">
            <div>{error}</div>
            {result.sql && <pre className="q-sql mono">{substituteSql(result.sql, params)}</pre>}
          </div>
        ) : !result ? (
          loading ? <SkeletonTable columns={4} rows={Math.max(3, panel.h * 2)} dense />
            : <div className="db-panel-msg">Nothing ran for this panel.</div>
        ) : spec ? (
          <Chart fields={fields} rows={result.rows} spec={spec}
            height={panelChartHeight(panel.h)} tableBelow={false} />
        ) : (
          <ResultTable
            id={`dash.${definition.id}.${panel.id}`}
            result={result}
            nav={nav}
            dense
            pageSize={50}
            filter={panel.h >= FILTER_MIN_H}
            empty="No rows."
            searchPlaceholder="Search"
          />
        )}
      </div>
    </section>
  );
}
