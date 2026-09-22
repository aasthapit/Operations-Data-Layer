// "Add to dashboard", from the Query page's results.
//
// A query someone has just got right is worth keeping next to the others that
// answer the same question. This takes the SQL that ran and the chart that was
// chosen and appends them to a dashboard as a panel - a read of the definition,
// the panel pushed onto the end, and a write back, because the API's unit of
// change is the whole definition.
//
// A built-in cannot be written to, so choosing one clones it first: the panel
// lands on the copy, which is then the user's.
import { useMemo, useState } from "react";
import { api } from "../api";
import { invalidate } from "../cache";
import { useFetch } from "../hooks";
import { Field, Modal, Stepper } from "./ui";
import {
  MAX_H, MAX_W, forSave, isSlug, newPanelId, normalizeDefinition, slugify, variablesIn,
} from "./model";
import { normalizeChart } from "../Chart";
import type { ChartChoice } from "../Chart";
import type { Definition } from "./model";

export interface AddToDashboardProps {
  /** The SQL that just ran, stored on the panel as it is. */
  sql: string;
  /** The chart the user chose for it; anything unrecognised normalises to Auto. */
  chart?: Partial<ChartChoice> | null;
  defaultTitle?: string;
  onClose: () => void;
  /** The dashboard the panel landed on - the copy's id, when one was cloned. */
  onAdded: (id: string) => void;
}

export default function AddToDashboard({
  sql, chart, defaultTitle, onClose, onAdded,
}: AddToDashboardProps) {
  const list = useFetch(() => api.dashboards(), []);
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState(defaultTitle || "");
  const [cloneId, setCloneId] = useState("");
  const [size, setSize] = useState({ w: 6, h: 2 });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const all = useMemo(() => (list.data?.dashboards || []).map((d) => ({
    id: d.id, title: d.title || d.id, builtin: !!d.builtin,
  })), [list.data]);
  const saved = all.filter((d) => !d.builtin);
  const builtin = all.filter((d) => d.builtin);

  const chosen = all.find((d) => d.id === target) || null;
  const cloning = !!chosen?.builtin;
  const newId = slugify(cloneId || (chosen ? `${chosen.id}-copy` : ""));
  // A panel carrying a variable the target does not declare would come back as
  // "variable hub is not set" on every run, so say so before it is added.
  const needs = variablesIn(sql);
  const ready = !!chosen && title.trim() && (!cloning || isSlug(newId));

  const add = async () => {
    setBusy(true);
    setProblem("");
    try {
      const source = normalizeDefinition(await api.dashboard(chosen.id), chosen.id);
      const id = cloning ? newId : chosen.id;
      const next: Definition = {
        ...source,
        id,
        title: cloning ? `${source.title} (copy)` : source.title,
        panels: [...source.panels, {
          id: newPanelId(),
          title: title.trim(),
          description: "",
          sql,
          chart: normalizeChart(chart),
          w: size.w,
          h: size.h,
          limit: null,
        }],
      };
      await api.saveDashboard(id, forSave(next));
      invalidate("/api/dashboards");
      onAdded(id);
    } catch (e) {
      setProblem(String((e as Error)?.message || e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add to dashboard"
      width={520}
      onClose={onClose}
      footer={list.error ? (
        <button type="button" className="btn" onClick={onClose}>Close</button>
      ) : (
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!ready || busy} onClick={add}>
            {busy ? "Adding…" : cloning ? "Clone and add" : "Add panel"}
          </button>
        </>
      )}
    >
      {list.error ? (
        <p className="desc" style={{ marginTop: 0 }}>
          {list.error.status === 404
            ? "This data layer does not serve dashboards yet, so there is nowhere to add this panel. The dashboard plane arrives with the next API build."
            : String(list.error.message || list.error)}
        </p>
      ) : !list.data ? (
        <p className="q-desc" style={{ marginTop: 0 }}>Loading dashboards…</p>
      ) : (
        <>
          <Field label="Dashboard" wide
            hint={cloning ? "Built-in dashboards cannot be changed, so this one is cloned first." : undefined}>
            <select value={target} onChange={(e) => { setTarget(e.target.value); setCloneId(""); }}>
              <option value="">choose a dashboard…</option>
              {saved.length > 0 && (
                <optgroup label="Saved">
                  {saved.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                </optgroup>
              )}
              {builtin.length > 0 && (
                <optgroup label="Built in - clones">
                  {builtin.map((d) => (
                    <option key={d.id} value={d.id}>Clone {d.title}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>

          {cloning && (
            <Field label="New id" wide hint={`The copy will live at /dashboards/${newId || "…"}`}>
              <input type="text" className="mono" value={cloneId || `${chosen.id}-copy`}
                onChange={(e) => setCloneId(e.target.value)} />
            </Field>
          )}

          <Field label="Panel title" wide>
            <input type="text" value={title} autoFocus placeholder="What this panel answers"
              onChange={(e) => setTitle(e.target.value)} />
          </Field>

          <div className="db-drawer-row">
            <Stepper label="Width" value={size.w} min={1} max={MAX_W}
              onChange={(w) => setSize((s) => ({ ...s, w }))} suffix="/ 12" />
            <Stepper label="Height" value={size.h} min={1} max={MAX_H}
              onChange={(h) => setSize((s) => ({ ...s, h }))} suffix={size.h === 1 ? "row" : "rows"} />
          </div>

          {needs.length > 0 && (
            <p className="q-desc">
              This query uses {needs.map((n) => `{{${n}}}`).join(", ")}. The dashboard has to
              declare {needs.length === 1 ? "that variable" : "those variables"} or the panel will
              ask for {needs.length === 1 ? "it" : "them"} on every run.
            </p>
          )}

          <details className="q-ran">
            <summary>The SQL this panel will store</summary>
            <pre className="q-sql mono">{sql}</pre>
          </details>
        </>
      )}

      {problem && <div className="banner" style={{ marginBottom: 0 }}>{problem}</div>}
    </Modal>
  );
}
