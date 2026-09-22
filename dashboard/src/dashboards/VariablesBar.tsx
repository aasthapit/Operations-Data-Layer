// The bar above the grid: one control per variable, and the URL underneath it.
//
// Changing a control replaces the current history entry, so the back button
// steps off the dashboard rather than back through every hub the user tried -
// and the address bar is always a link to exactly what is on screen.
//
// A select's options come from the run that just finished, because the query
// that lists the hubs is part of the dashboard: the page cannot know them until
// it has run once, and after that they are as fresh as the panels.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { hasValue, queryValue, variableLabel } from "./model";
import type { Params, Variable, VariableType, VariableValue } from "./model";
import type { VariableOptions } from "./runtime";

// Text and numbers commit when the user leaves the field or presses Enter.
// Re-running nine panels on every keystroke would be both slow and useless.
interface CommittedInputProps {
  /** Already flattened to the text the field shows - a list is joined before it
   * gets here, because only a select edits a list. */
  value: string;
  onCommit: (value: string) => void;
  type?: VariableType;
  placeholder?: string;
}

function CommittedInput({ value, onCommit, type, placeholder }: CommittedInputProps) {
  const [local, setLocal] = useState(value ?? "");
  useEffect(() => { setLocal(value ?? ""); }, [value]);
  return (
    <input
      type={type === "number" ? "number" : "text"}
      value={local}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => { if (String(local) !== String(value ?? "")) onCommit(local); }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
    />
  );
}

interface ControlProps {
  variable: Variable;
  value: VariableValue;
  /** From the run that just finished; absent until the dashboard has run once. */
  options?: VariableOptions["options"];
  onChange: (value: VariableValue) => void;
}

function Control({ variable, value, options, onChange }: ControlProps) {
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

    if (variable.multi) {
      const selected = (Array.isArray(value) ? value : []).map(String);
      return (
        <select
          multiple
          size={Math.min(5, Math.max(3, all.length))}
          value={selected}
          onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}
        >
          {/* an option keeps the type its column had; the DOM stringifies it */}
          {all.map((o) => (
            <option key={String(o.value)} value={o.value as string}>{o.label}</option>
          ))}
        </select>
      );
    }
    return (
      <select value={hasValue(value) ? String(value) : ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">{variable.required ? `choose ${variableLabel(variable).toLowerCase()}…` : "all"}</option>
        {all.map((o) => (
          <option key={String(o.value)} value={o.value as string}>{o.label}</option>
        ))}
      </select>
    );
  }
  return (
    <CommittedInput
      type={variable.type}
      value={queryValue(value)}
      placeholder={variable.required ? "required" : "any"}
      onCommit={onChange}
    />
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
    <div className="db-vars card">
      {list.map((v) => {
        const state: Partial<VariableOptions> = (variables || {})[v.name] || {};
        const missing = v.required && !hasValue(params[v.name]);
        return (
          <label key={v.name} className={`db-var${missing ? " missing" : ""}`}>
            <span className="db-var-label">
              {variableLabel(v)}
              {v.required && <span className="db-req" title="Required">*</span>}
            </span>
            <Control
              variable={v}
              value={params[v.name]}
              options={state.options}
              onChange={(next) => onChange(v.name, next)}
            />
            {/* An options query that failed leaves an empty selector, which on
                its own looks like a fleet with no hubs in it. */}
            {state.error && <span className="db-var-error">{String(state.error)}</span>}
          </label>
        );
      })}
      {list.length === 0 && <span className="muted">This dashboard has no variables.</span>}
      <span className="db-vars-spacer" />
      {right}
    </div>
  );
}
