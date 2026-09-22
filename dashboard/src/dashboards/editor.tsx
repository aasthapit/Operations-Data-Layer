// The two drawers the editor opens: one for a panel, one for the variables.
//
// Both edit a copy and hand it back on Apply, so Escape or Cancel really does
// leave the dashboard as it was - and the grid behind the drawer is not
// re-running a query on every keystroke in the SQL box.
import { useMemo, useState } from "react";
import Chart, { inferFields, normalizeChart, resolveSpec } from "../Chart";
import ChartControls, { chartNoneText } from "../ChartControls";
import { Drawer, Field, Stepper } from "./ui";
import { runQueries } from "./runtime";
import {
  MAX_H, MAX_W, VARIABLE_TYPES, errorAt, hasValue, normalizeVariable, variablesIn,
} from "./model";
import type {
  FieldError, Panel as PanelDefinition, Params, Variable, VariableType,
} from "./model";
import type { BatchEntry } from "../api/types";

// --------------------------------------------------------------------------- //
// a panel
// --------------------------------------------------------------------------- //
export interface PanelDrawerProps {
  /** The panel being edited, or a blank one when a panel is being added. */
  panel: PanelDefinition;
  /** Only the variables are read, so a draft fits as well as a saved one. */
  definition: { variables?: Variable[] };
  params: Params;
  /** What the panel last answered, which seeds the preview so the drawer opens
   * on the chart the user is looking at. */
  result?: BatchEntry | null;
  /** Paths relative to this panel ("sql", "title"), as `errorAt` reads them. */
  errors?: FieldError[] | null;
  onApply: (panel: PanelDefinition) => void;
  onClose: () => void;
}

export function PanelDrawer({
  panel, definition, params, result, errors, onApply, onClose,
}: PanelDrawerProps) {
  const [draft, setDraft] = useState<PanelDefinition>(panel);
  const [preview, setPreview] = useState<BatchEntry | null>(
    result && !result.error ? result : null);
  const [previewError, setPreviewError] = useState(result && result.error ? String(result.error) : "");
  const [previewSql, setPreviewSql] = useState(result && !result.error ? panel.sql : "");
  const [busy, setBusy] = useState(false);

  const set = (fields: Partial<PanelDefinition>) => setDraft((d) => ({ ...d, ...fields }));
  const stale = preview != null && previewSql !== draft.sql;

  const fields = useMemo(
    () => (preview?.columns ? inferFields(preview.columns, preview.column_types, preview.rows) : []),
    [preview]);
  const spec = useMemo(
    () => (fields.length ? resolveSpec(fields, preview.rows, draft.chart) : null),
    [fields, preview, draft.chart]);

  const known = new Set((definition.variables || []).map((v) => v.name));
  const unknown = variablesIn(draft.sql).filter((n) => !known.has(n));

  const runPreview = async () => {
    if (!draft.sql.trim()) return;
    // A placeholder with no value cannot be substituted, and sending the query
    // with {{envs}} still in it would come back as a SQL syntax error about a
    // column nobody wrote. Say what it actually needs.
    const waiting = variablesIn(draft.sql).filter((n) => known.has(n) && !hasValue(params[n]));
    if (waiting.length) {
      setPreview(null);
      setPreviewError(`Choose a value for ${waiting.map((n) => `{{${n}}}`).join(", ")} in the bar `
        + "behind this drawer, then run the preview.");
      return;
    }
    setBusy(true);
    setPreviewError("");
    try {
      const run = await runQueries(
        [{ id: "preview", sql: draft.sql, limit: draft.limit || undefined }], params);
      const r = run.results.preview;
      if (!r || r.error) {
        setPreview(null);
        setPreviewError(r ? String(r.error) : "No result.");
      } else {
        setPreview(r);
        setPreviewSql(draft.sql);
      }
    } catch (e) {
      setPreview(null);
      setPreviewError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title={panel.title ? `Edit "${panel.title}"` : "Add a panel"}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary"
            disabled={!draft.title.trim() || !draft.sql.trim()}
            onClick={() => onApply(draft)}>
            Apply
          </button>
        </>
      )}
    >
      <Field label="Title" hint="Variables can appear as {{name}}." error={errorAt(errors, "title")} wide>
        <input type="text" value={draft.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>

      <Field label="Description" hint="Shown on the panel as a tooltip." wide>
        <input type="text" value={draft.description}
          onChange={(e) => set({ description: e.target.value })} />
      </Field>

      <Field
        label="SQL"
        error={errorAt(errors, "sql")}
        hint={unknown.length
          ? `${unknown.map((n) => `{{${n}}}`).join(", ")} is not a variable of this dashboard yet.`
          : "A single SELECT. Variables are substituted as escaped literals."}
        wide
      >
        <textarea
          className="q-sql q-sql-edit mono"
          spellCheck="false"
          rows={Math.min(18, Math.max(7, draft.sql.split("\n").length + 1))}
          value={draft.sql}
          onChange={(e) => set({ sql: e.target.value })}
        />
      </Field>

      <div className="db-drawer-row">
        <button type="button" className="btn" disabled={busy || !draft.sql.trim()} onClick={runPreview}>
          {busy ? "Running…" : stale || !preview ? "Run preview" : "Run again"}
        </button>
        {preview && !stale && (
          <span className="muted">
            {preview.row_count.toLocaleString()} rows · {preview.columns.length} columns
            {preview.elapsed_ms != null ? ` · ${preview.elapsed_ms} ms` : ""}
          </span>
        )}
        {stale && <span className="muted">The SQL changed - run the preview again.</span>}
      </div>
      {previewError && <div className="banner">{previewError}</div>}

      <div className="db-drawer-sec">
        <div className="q-subhead">Chart</div>
        {preview ? (
          <>
            <ChartControls fields={fields} spec={spec} chart={draft.chart}
              onChange={(chart) => set({ chart: normalizeChart(chart) })} />
            {spec ? (
              <Chart fields={fields} rows={preview.rows} spec={spec} height={200} tableBelow={false} />
            ) : (
              <div className="chart-none">{chartNoneText(draft.chart) || "This panel shows the table only."}</div>
            )}
          </>
        ) : (
          <div className="q-desc">Run the preview to choose what the panel charts.</div>
        )}
      </div>

      <div className="db-drawer-sec db-drawer-row">
        <Stepper label="Width" value={draft.w} min={1} max={MAX_W}
          onChange={(w) => set({ w })} suffix="/ 12" />
        <Stepper label="Height" value={draft.h} min={1} max={MAX_H}
          onChange={(h) => set({ h })} suffix={draft.h === 1 ? "row" : "rows"} />
        <Field label="Row limit" hint="Blank uses the server's default." error={errorAt(errors, "limit")}>
          <input type="number" min="1" value={draft.limit ?? ""}
            onChange={(e) => set({ limit: e.target.value ? Number(e.target.value) : null })} />
        </Field>
      </div>
    </Drawer>
  );
}

// --------------------------------------------------------------------------- //
// the variables
// --------------------------------------------------------------------------- //
export interface VariablesDrawerProps {
  definition: { variables?: Variable[] };
  /** Paths as the API writes them ("variables.0.name"). */
  errors?: FieldError[] | null;
  onApply: (variables: Variable[]) => void;
  onClose: () => void;
}

export function VariablesDrawer({ definition, errors, onApply, onClose }: VariablesDrawerProps) {
  const [list, setList] = useState<Variable[]>(definition.variables || []);

  const set = (i: number, fields: Partial<Variable>) =>
    setList((l) => l.map((v, j) => (j === i ? normalizeVariable({ ...v, ...fields }, j) : v)));
  const remove = (i: number) => setList((l) => l.filter((_, j) => j !== i));
  const add = () => setList((l) => [...l, normalizeVariable({
    name: `var${l.length + 1}`, label: "", type: "select", sql: "",
  }, l.length)]);

  return (
    <Drawer
      title="Variables"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => onApply(list)}>Apply</button>
        </>
      )}
    >
      <div className="q-desc">
        A variable is written as {"{{name}}"} in a panel's SQL and in its title. The server
        substitutes it as an escaped literal, and its value rides in the page's URL.
      </div>

      {list.map((v, i) => (
        <div className="db-var-edit" key={i /* eslint-disable-line react/no-array-index-key */}>
          <div className="db-drawer-row">
            <Field label="Name" error={errorAt(errors, `variables.${i}.name`)}>
              <input type="text" className="mono" value={v.name}
                onChange={(e) => set(i, { name: e.target.value })} />
            </Field>
            <Field label="Label" hint="Shown above the control.">
              <input type="text" value={v.label} placeholder={v.name}
                onChange={(e) => set(i, { label: e.target.value })} />
            </Field>
            <Field label="Type">
              {/* the options are exactly VARIABLE_TYPES */}
              <select value={v.type}
                onChange={(e) => set(i, { type: e.target.value as VariableType })}>
                {VARIABLE_TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </Field>
            <button type="button" className="q-x" title="Remove this variable"
              onClick={() => remove(i)}>×</button>
          </div>

          {v.type === "select" && (
            <Field
              label="Options query"
              error={errorAt(errors, `variables.${i}.sql`)}
              hint="Returns a column named value, and optionally one named label. It may not use variables."
              wide
            >
              <textarea className="q-sql q-sql-edit mono" spellCheck="false" rows={2} value={v.sql}
                onChange={(e) => set(i, { sql: e.target.value })} />
            </Field>
          )}

          <div className="db-drawer-row">
            <Field label="Default" error={errorAt(errors, `variables.${i}.default`)}>
              <input type={v.type === "number" ? "number" : "text"}
                // a default is whatever the column holds; the field edits its text
                value={hasValue(v.default) ? (v.default as string | number) : ""}
                onChange={(e) => set(i, { default: e.target.value })} />
            </Field>
            <label className="q-check">
              <input type="checkbox" checked={v.required}
                onChange={(e) => set(i, { required: e.target.checked })} />
              <span>Required</span>
            </label>
            {v.type === "select" && (
              <label className="q-check">
                <input type="checkbox" checked={v.multi}
                  onChange={(e) => set(i, { multi: e.target.checked })} />
                <span>Allow several</span>
              </label>
            )}
          </div>
        </div>
      ))}

      <button type="button" className="q-add" onClick={add}>+ variable</button>
    </Drawer>
  );
}
