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
import { hasValue, queryValue, variableLabel } from "./model";

// Text and numbers commit when the user leaves the field or presses Enter.
// Re-running nine panels on every keystroke would be both slow and useless.
function CommittedInput({ value, onCommit, type, placeholder }) {
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

function Control({ variable, value, options, onChange }) {
  if (variable.type === "select") {
    const list = options || [];
    // A value the URL carries that this snapshot no longer offers still shows,
    // rather than silently snapping to something the user did not choose. Before
    // the options query has answered there is nothing to be missing from, so the
    // value is shown plain rather than accused of being stale.
    const extra = (variable.multi ? (value || []) : hasValue(value) ? [value] : [])
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
          {all.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    return (
      <select value={hasValue(value) ? String(value) : ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">{variable.required ? `choose ${variableLabel(variable).toLowerCase()}…` : "all"}</option>
        {all.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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

export default function VariablesBar({ definition, params, variables, onChange, right }) {
  const list = definition.variables || [];
  if (!list.length && !right) return null;
  return (
    <div className="db-vars card">
      {list.map((v) => {
        const state = (variables || {})[v.name] || {};
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
