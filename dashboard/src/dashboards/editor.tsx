// The two drawers the editor opens: one for a panel, one for the variables.
//
// Both edit a copy and hand it back on Apply, so Escape or Cancel really does
// leave the dashboard as it was - and the grid behind the drawer is not
// re-running a query on every keystroke in the SQL box.
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert, Box, Button, Checkbox, FormControlLabel, IconButton, TextField, Tooltip,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import Chart, { inferFields, normalizeChart, resolveSpec } from "../Chart";
import ChartControls, { chartNoneText } from "../ChartControls";
import { MONO_FONT, Muted } from "../components";
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
    () => (fields.length ? resolveSpec(fields, preview?.rows, draft.chart) : null),
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
      setPreviewError(String((e as Error)?.message || e));
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
          <Button variant="outlined" color="inherit" onClick={onClose}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!draft.title.trim() || !draft.sql.trim()}
            onClick={() => onApply(draft)}
          >
            Apply
          </Button>
        </>
      )}
    >
      <Field label="Title" hint="Variables can appear as {{name}}." error={errorAt(errors, "title")} wide>
        <TextField fullWidth value={draft.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>

      <Field label="Description" hint="Shown on the panel as a tooltip." wide>
        <TextField fullWidth value={draft.description}
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
        <SqlBox
          rows={Math.min(18, Math.max(7, draft.sql.split("\n").length + 1))}
          value={draft.sql}
          onChange={(sql) => set({ sql })}
        />
      </Field>

      <DrawerRow>
        <Button variant="outlined" color="inherit" disabled={busy || !draft.sql.trim()} onClick={runPreview}>
          {busy ? "Running…" : stale || !preview ? "Run preview" : "Run again"}
        </Button>
        {preview && !stale && (
          <Muted>
            {/* a preview that ran has both; a batch entry that did not never
                gets here, because `preview` is only set on success */}
            {(preview.row_count ?? 0).toLocaleString()} rows
            {" · "}{(preview.columns || []).length} columns
            {preview.elapsed_ms != null ? ` · ${preview.elapsed_ms} ms` : ""}
          </Muted>
        )}
        {stale && <Muted>The SQL changed - run the preview again.</Muted>}
      </DrawerRow>
      {previewError && <Alert severity="error" sx={{ mb: 2 }}>{previewError}</Alert>}

      <Section>
        <Subhead>Chart</Subhead>
        {preview ? (
          <>
            <ChartControls fields={fields} spec={spec} chart={draft.chart}
              onChange={(chart) => set({ chart: normalizeChart(chart) })} />
            {spec ? (
              <Chart fields={fields} rows={preview.rows} spec={spec} height={200} tableBelow={false} />
            ) : (
              <Muted sx={{ display: "block", fontSize: 12.5 }}>
                {chartNoneText(draft.chart) || "This panel shows the table only."}
              </Muted>
            )}
          </>
        ) : (
          <Muted sx={{ display: "block", fontSize: 11.5 }}>
            Run the preview to choose what the panel charts.
          </Muted>
        )}
      </Section>

      <Section>
        <DrawerRow align="flex-start">
          <Stepper label="Width" value={draft.w} min={1} max={MAX_W}
            onChange={(w) => set({ w })} suffix="/ 12" />
          <Stepper label="Height" value={draft.h} min={1} max={MAX_H}
            onChange={(h) => set({ h })} suffix={draft.h === 1 ? "row" : "rows"} />
          <Field label="Row limit" hint="Blank uses the server's default." error={errorAt(errors, "limit")}>
            <TextField type="number" value={draft.limit ?? ""}
              slotProps={{ htmlInput: { min: 1 } }}
              onChange={(e) => set({ limit: e.target.value ? Number(e.target.value) : null })} />
          </Field>
        </DrawerRow>
      </Section>
    </Drawer>
  );
}

// --------------------------------------------------------------------------- //
// the drawers' own furniture
// --------------------------------------------------------------------------- //
/** One line of controls inside a drawer. */
function DrawerRow({ children, align = "center" }: { children?: ReactNode; align?: string }) {
  return (
    <Box sx={{ display: "flex", alignItems: align, gap: 1.5, flexWrap: "wrap", mb: 1.75 }}>
      {children}
    </Box>
  );
}

/** A block of the drawer, ruled off from the one above it. */
function Section({ children }: { children?: ReactNode }) {
  return (
    <Box sx={{ borderTop: 1, borderColor: "border.soft", pt: 1.75, mt: 0.5 }}>{children}</Box>
  );
}

function Subhead({ children }: { children?: ReactNode }) {
  return (
    <Muted sx={{
      display: "block", fontSize: 10.5, textTransform: "uppercase",
      letterSpacing: "0.05em", m: "0 0 4px",
    }}>
      {children}
    </Muted>
  );
}

/** A SQL editor: monospace, no spell check, sized to what is in it. */
function SqlBox({ value, rows, onChange }: {
  value: string; rows: number; onChange: (value: string) => void;
}) {
  return (
    <TextField
      multiline
      fullWidth
      minRows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      slotProps={{ htmlInput: { spellCheck: false } }}
      sx={{ "& .MuiInputBase-root": { fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: 1.55 } }}
    />
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
          <Button variant="outlined" color="inherit" onClick={onClose}>Cancel</Button>
          <Button variant="contained" onClick={() => onApply(list)}>Apply</Button>
        </>
      )}
    >
      <Muted sx={{ display: "block", fontSize: 11.5, mb: 1.75 }}>
        A variable is written as {"{{name}}"} in a panel&apos;s SQL and in its title. The server
        substitutes it as an escaped literal, and its value rides in the page&apos;s URL.
      </Muted>

      {list.map((v, i) => (
        <Box
          key={i /* eslint-disable-line react/no-array-index-key */}
          sx={{ borderLeft: 2, borderColor: "divider", pl: 1.5, my: 1.75 }}
        >
          <DrawerRow align="flex-start">
            <Field label="Name" error={errorAt(errors, `variables.${i}.name`)}>
              <TextField value={v.name} onChange={(e) => set(i, { name: e.target.value })}
                slotProps={{ htmlInput: { style: { fontFamily: MONO_FONT } } }} />
            </Field>
            <Field label="Label" hint="Shown above the control.">
              <TextField value={v.label} placeholder={v.name}
                onChange={(e) => set(i, { label: e.target.value })} />
            </Field>
            <Field label="Type">
              {/* the options are exactly VARIABLE_TYPES */}
              <TextField
                select
                value={v.type}
                onChange={(e) => set(i, { type: e.target.value as VariableType })}
                slotProps={{ select: { native: true } }}
              >
                {VARIABLE_TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </TextField>
            </Field>
            <Tooltip title="Remove this variable">
              <IconButton
                aria-label="Remove this variable"
                onClick={() => remove(i)}
                sx={{ mt: 2.5, flex: "none", border: 1, borderColor: "divider", borderRadius: "6px", p: 0.25 }}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </DrawerRow>

          {v.type === "select" && (
            <Field
              label="Options query"
              error={errorAt(errors, `variables.${i}.sql`)}
              hint="Returns a column named value, and optionally one named label. It may not use variables."
              wide
            >
              <SqlBox rows={2} value={v.sql} onChange={(sql) => set(i, { sql })} />
            </Field>
          )}

          <DrawerRow align="flex-start">
            <Field label="Default" error={errorAt(errors, `variables.${i}.default`)}>
              <TextField
                type={v.type === "number" ? "number" : "text"}
                // a default is whatever the column holds; the field edits its text
                value={hasValue(v.default) ? (v.default as string | number) : ""}
                onChange={(e) => set(i, { default: e.target.value })}
              />
            </Field>
            <FormControlLabel
              sx={{ mt: 2.5 }}
              control={(
                <Checkbox checked={v.required} onChange={(e) => set(i, { required: e.target.checked })} />
              )}
              label="Required"
            />
            {v.type === "select" && (
              <FormControlLabel
                sx={{ mt: 2.5 }}
                control={(
                  <Checkbox checked={v.multi} onChange={(e) => set(i, { multi: e.target.checked })} />
                )}
                label="Allow several"
              />
            )}
          </DrawerRow>
        </Box>
      ))}

      <Button
        fullWidth
        onClick={add}
        sx={{
          mt: 0.5, color: "text.secondary", fontSize: 11.5,
          border: 1, borderStyle: "dashed", borderColor: "divider",
          "&:hover": { borderStyle: "dashed", borderColor: "primary.main", color: "text.primary" },
        }}
      >
        + variable
      </Button>
    </Drawer>
  );
}
