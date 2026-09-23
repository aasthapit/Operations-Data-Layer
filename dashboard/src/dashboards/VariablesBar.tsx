// The bar above the grid: one control per variable, and the URL underneath it.
//
// Changing a control replaces the current history entry, so the back button
// steps off the dashboard rather than back through every hub the user tried -
// and the address bar is always a link to exactly what is on screen.
//
// A select's options come from the run that just finished, because the query
// that lists the hubs is part of the dashboard: the page cannot know them until
// it has run once, and after that they are as fresh as the panels.
import { useEffect, useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Box, Paper, TextField, Typography } from "@mui/material";
import { Muted } from "../components";
import { hasValue, queryValue, variableLabel } from "./model";
import type { Params, Variable, VariableType, VariableValue } from "./model";
import type { VariableOptions } from "./runtime";

// Text and numbers commit when the user leaves the field or presses Enter.
// Re-running nine panels on every keystroke would be both slow and useless.
interface CommittedInputProps {
  id: string;
  /** Already flattened to the text the field shows - a list is joined before it
   * gets here, because only a select edits a list. */
  value: string;
  onCommit: (value: string) => void;
  type?: VariableType;
  placeholder?: string;
}

function CommittedInput({ id, value, onCommit, type, placeholder }: CommittedInputProps) {
  const [local, setLocal] = useState(value ?? "");
  useEffect(() => { setLocal(value ?? ""); }, [value]);
  return (
    <TextField
      id={id}
      type={type === "number" ? "number" : "text"}
      value={local}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      // Both handlers go on the <input> rather than on the field around it:
      // Enter blurs the element it was pressed in, and that is the box.
      slotProps={{
        htmlInput: {
          onBlur: () => { if (String(local) !== String(value ?? "")) onCommit(local); },
          onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter") e.currentTarget.blur();
          },
        },
      }}
      sx={CONTROL_SX}
    />
  );
}

/** Every control on the bar is the same size, whichever kind it is. */
const CONTROL_SX = { minWidth: 180, maxWidth: 280 };

interface ControlProps {
  id: string;
  variable: Variable;
  value: VariableValue;
  /** From the run that just finished; absent until the dashboard has run once. */
  options?: VariableOptions["options"];
  onChange: (value: VariableValue) => void;
}

function Control({ id, variable, value, options, onChange }: ControlProps) {
  if (variable.type === "select") {
    const list = options || [];
    // A value the URL carries that this snapshot no longer offers still shows,
    // rather than silently snapping to something the user did not choose. Before
    // the options query has answered there is nothing to be missing from, so the
    // value is shown plain rather than accused of being stale.
    // A multi-select's value is a list. The cast says that rather than
    // re-deriving it, so a URL carrying something else behaves exactly as it
    // did before this file was typed.
    const chosen: VariableValue[] = variable.multi
      ? ((value || []) as VariableValue[])
      : hasValue(value) ? [value] : [];
    const extra = chosen
      .filter((v) => !list.some((o) => o.value === String(v)))
      .map((v) => ({ value: String(v), label: list.length ? `${v} (not in this snapshot)` : String(v) }));
    const all = [...list, ...extra];

    const optionNodes = all.map((o) => (
      // an option keeps the type its column had; the DOM stringifies it
      <option key={String(o.value)} value={o.value as string}>{o.label}</option>
    ));

    if (variable.multi) {
      const selected = (Array.isArray(value) ? value : []).map(String);
      return (
        <TextField
          id={id}
          select
          value={selected}
          onChange={(e) => onChange(
            [...(e.target as unknown as HTMLSelectElement).selectedOptions].map((o) => o.value))}
          slotProps={{
            select: { native: true, multiple: true },
            // `size` on a native multi-select is how many rows it shows, which
            // is not MUI's own `size` - so it goes to the element itself.
            htmlInput: { size: Math.min(5, Math.max(3, all.length)) },
          }}
          sx={CONTROL_SX}
        >
          {optionNodes}
        </TextField>
      );
    }
    return (
      <TextField
        id={id}
        select
        value={hasValue(value) ? String(value) : ""}
        onChange={(e) => onChange(e.target.value)}
        slotProps={{ select: { native: true } }}
        sx={CONTROL_SX}
      >
        <option value="">{variable.required ? `choose ${variableLabel(variable).toLowerCase()}…` : "all"}</option>
        {optionNodes}
      </TextField>
    );
  }
  return (
    <CommittedInput
      id={id}
      type={variable.type}
      value={queryValue(value)}
      placeholder={variable.required ? "required" : "any"}
      onCommit={onChange}
    />
  );
}

interface VariableFieldProps {
  variable: Variable;
  /** What the last run found for this variable, when it has run. */
  state: Partial<VariableOptions>;
  value: VariableValue;
  onChange: (value: VariableValue) => void;
}

/** One variable on the bar: its name, its control, and whatever the options
 * query had to say. */
function VariableField({ variable, state, value, onChange }: VariableFieldProps) {
  const id = useId();
  const missing = variable.required && !hasValue(value);
  return (
    <Box
      data-missing={missing || undefined}
      sx={{
        display: "flex", flexDirection: "column", gap: 0.5, minWidth: 0,
        // A required variable nobody has chosen yet is why the panels below are
        // empty, so the control says so rather than the panels.
        ...(missing
          ? { "& .MuiOutlinedInput-notchedOutline": { borderColor: "warning.main" } }
          : {}),
      }}
    >
      <Typography component="label" htmlFor={id} variant="subtitle2" color="text.secondary">
        {variableLabel(variable)}
        {variable.required && (
          <Box component="span" title="Required" sx={{ color: "warning.main", ml: "3px" }}>*</Box>
        )}
      </Typography>
      <Control id={id} variable={variable} value={value} options={state.options} onChange={onChange} />
      {/* An options query that failed leaves an empty selector, which on its
          own looks like a fleet with no hubs in it. */}
      {state.error && (
        <Typography variant="caption" color="error.main" sx={{ maxWidth: 280 }}>
          {String(state.error)}
        </Typography>
      )}
    </Box>
  );
}

export interface VariablesBarProps {
  /** Only the variables are read, so a draft being edited fits as well as a
   * saved definition does. */
  definition: { variables?: Variable[] };
  params: Params;
  /** What the last run found for each select variable, keyed by variable name. */
  variables?: Record<string, VariableOptions> | null;
  onChange: (name: string, value: VariableValue) => void;
  /** Whatever the page puts at the end of the bar - the edit controls. */
  right?: ReactNode;
}

export default function VariablesBar({
  definition, params, variables, onChange, right,
}: VariablesBarProps) {
  const list = definition.variables || [];
  if (!list.length && !right) return null;
  return (
    <Paper sx={{
      display: "flex", alignItems: "flex-end", gap: "8px 18px", flexWrap: "wrap", p: "12px 16px",
    }}>
      {list.map((v) => (
        <VariableField
          key={v.name}
          variable={v}
          state={(variables || {})[v.name] || {}}
          value={params[v.name]}
          onChange={(next) => onChange(v.name, next)}
        />
      ))}
      {list.length === 0 && <Muted>This dashboard has no variables.</Muted>}
      <Box sx={{ flex: 1 }} />
      {right}
    </Paper>
  );
}
