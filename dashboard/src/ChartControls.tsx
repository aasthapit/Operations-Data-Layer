// The one row of controls that sits above a chart: what kind, what is on the x
// axis, what separates the series, which measures are drawn, and whether they
// stack. The Query page puts it above its results and the dashboard panel editor
// puts it beside the SQL, so there is one implementation of "what can this
// result be charted as" rather than two that drift.
//
// It is driven entirely by the fields of a result: an option that the data
// cannot carry is never offered, and `spec` is what resolveSpec made of the
// user's choice - null when nothing can be drawn, which leaves only the type.
import { CHART_TYPES, categoryFields, emptyChart, normalizeChart } from "./Chart";
import type { ChartChoice, ChartType, Field, Spec } from "./Chart";

export interface ChartControlsProps {
  /** Every column of the result, which is what decides what can be offered. */
  fields: Field[];
  /** The resolved chart, or null when nothing can be drawn - which leaves only
   * the type selector. */
  spec: Spec | null;
  /** The user's choice as it is stored, which is not the same thing as `spec`. */
  chart?: ChartChoice | null;
  onChange: (choice: ChartChoice) => void;
}

export default function ChartControls({ fields, spec, chart, onChange }: ChartControlsProps) {
  const choice = normalizeChart(chart);
  const line = spec?.type === "line";

  const numbers = fields.filter((f) => f.kind === "number");
  const cats = categoryFields(fields);
  const times = fields.filter((f) => f.kind === "time");
  const xOptions = line ? times : [...cats, ...times];
  const yOptions = numbers.filter((f) => f.name !== spec?.x);
  const seriesOptions = cats.filter((f) => f.name !== spec?.x);

  const set = (fragment: Partial<ChartChoice>) => onChange({ ...choice, ...fragment });
  // Switching the type starts the picks over, which is also the way back to
  // "let the chart decide".
  const setType = (type: ChartType) => onChange({ ...emptyChart(), type });
  const toggleY = (name: string) => {
    if (!spec) return;
    // one measure per line when a series column already owns the colours
    if (line && spec.series) { set({ y: [name] }); return; }
    const on = spec.y.includes(name);
    const next = on ? spec.y.filter((n) => n !== name) : [...spec.y, name];
    if (next.length) set({ y: next });
  };

  return (
    <div className="chart-controls">
      <label className="chart-ctl">
        <span>Chart</span>
        {/* the options are exactly CHART_TYPES, so the value is one of them */}
        <select value={choice.type} onChange={(e) => setType(e.target.value as ChartType)}>
          {CHART_TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>

      {spec && (
        <>
          <label className="chart-ctl">
            <span>{line ? "Time" : "Category"}</span>
            <select value={spec.x} onChange={(e) => set({ x: e.target.value })}>
              {xOptions.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </select>
          </label>

          {line && (
            <label className="chart-ctl">
              <span>Series</span>
              <select
                value={spec.series}
                onChange={(e) => set({ series: e.target.value, y: spec.y.slice(0, 1) })}
              >
                <option value="">none</option>
                {seriesOptions.map((f) => (
                  <option key={f.name} value={f.name}>{f.name} ({f.distinct})</option>
                ))}
              </select>
            </label>
          )}

          <div className="chart-ctl">
            <span>{line && spec.series ? "Measure" : "Measures"}</span>
            <div className="chart-ys">
              {yOptions.map((f) => (
                <button
                  key={f.name}
                  type="button"
                  className={`q-mini${spec.y.includes(f.name) ? " active" : ""}`}
                  aria-pressed={spec.y.includes(f.name)}
                  onClick={() => toggleY(f.name)}
                >
                  {f.name}
                </button>
              ))}
            </div>
          </div>

          {line && (
            <label className="q-check chart-ctl-check"
              title="Stack the series into a running total - for counts, not for scores">
              <input type="checkbox" checked={spec.stack}
                onChange={(e) => set({ stack: e.target.checked })} />
              <span>Stack</span>
            </label>
          )}
        </>
      )}
    </div>
  );
}

// What the control row says when there is nothing to draw, in the same words
// both callers used.
export function chartNoneText(choice: Partial<ChartChoice> | null | undefined): string {
  const type = normalizeChart(choice).type;
  if (type === "none") return "";
  return type === "auto"
    ? "No chart for this result - it has no time axis and no single category to group by."
    : `A ${type === "line" ? "line needs a time column and a number" : "bar chart needs a category and a number"}; this result has neither.`;
}
