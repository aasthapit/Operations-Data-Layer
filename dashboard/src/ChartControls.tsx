// The one row of controls that sits above a chart: what kind, what is on the x
// axis, what separates the series, which measures are drawn, and whether they
// stack. The Query page puts it above its results and the dashboard panel editor
// puts it beside the SQL, so there is one implementation of "what can this
// result be charted as" rather than two that drift.
//
// It is driven entirely by the fields of a result: an option that the data
// cannot carry is never offered, and `spec` is what resolveSpec made of the
// user's choice - null when nothing can be drawn, which leaves only the type.
//
// MUI primitives throughout, sized small to match the Query page and the
// dashboards editor: styles.css is being retired, so nothing here reaches for
// a class name, and any colour this file needed would come from `useTheme()`
// rather than a hex literal - it turns out to need none, since a `Select`, a
// `ToggleButton` and a `Checkbox` already carry the theme's own control
// styling (see `theme.ts`'s `MuiSelect` / `MuiToggleButton` / `MuiCheckbox`
// overrides) without this file repeating any of it.
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
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
    <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-end" }}>
      <TextField select label="Chart" size="small" value={choice.type}
        onChange={(e) => setType(e.target.value as ChartType)} sx={{ minWidth: 108 }}>
        {/* the options are exactly CHART_TYPES, so the value is one of them */}
        {CHART_TYPES.map(([id, label]) => <MenuItem key={id} value={id}>{label}</MenuItem>)}
      </TextField>

      {spec && (
        <>
          <TextField select label={line ? "Time" : "Category"} size="small" value={spec.x}
            onChange={(e) => set({ x: e.target.value })} sx={{ minWidth: 140 }}>
            {xOptions.map((f) => <MenuItem key={f.name} value={f.name}>{f.name}</MenuItem>)}
          </TextField>

          {line && (
            <TextField select label="Series" size="small" value={spec.series}
              onChange={(e) => set({ series: e.target.value, y: spec.y.slice(0, 1) })}
              sx={{ minWidth: 160 }}>
              <MenuItem value="">none</MenuItem>
              {seriesOptions.map((f) => (
                <MenuItem key={f.name} value={f.name}>{f.name} ({f.distinct})</MenuItem>
              ))}
            </TextField>
          )}

          <Box>
            <Typography variant="subtitle2" component="div" sx={{ mb: 0.5 }}>
              {line && spec.series ? "Measure" : "Measures"}
            </Typography>
            {/* Each button carries its own selected / onChange rather than the
                group its own `value`: a measure toggles on or off on its own,
                it is never exclusive with its neighbours, and `toggleY` is the
                one place that already knows the series-column and
                last-measure-standing rules. */}
            <ToggleButtonGroup size="small">
              {yOptions.map((f) => (
                <ToggleButton key={f.name} value={f.name} selected={spec.y.includes(f.name)}
                  onChange={() => toggleY(f.name)}>
                  {f.name}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>

          {line && (
            <Tooltip title="Stack the series into a running total - for counts, not for scores">
              <FormControlLabel label="Stack" control={<Checkbox size="small" checked={spec.stack}
                onChange={(e) => set({ stack: e.target.checked })} />} />
            </Tooltip>
          )}
        </>
      )}
    </Stack>
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
