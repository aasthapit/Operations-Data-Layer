// One dashboard: the variables bar, the grid of panels, and the editor.
//
// Everything that changes what is on screen is in the URL - which dashboard,
// and what every variable is set to - so the page is a link. Variable changes
// replace the history entry rather than push one, so Back leaves the dashboard
// instead of walking through every hub the user looked at.
//
// One run feeds every panel. It goes through the same stale-while-revalidate
// cache as the rest of the app, keyed on the dashboard and its parameters, so
// coming back to a dashboard paints from the last answer at once and refreshes
// behind it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { invalidate } from "../cache";
import { useFetch } from "../hooks";
import { ErrorBanner, SkeletonLines, fmtAge } from "../components";
import Panel from "../dashboards/Panel";
import VariablesBar from "../dashboards/VariablesBar";
import { PanelDrawer, VariablesDrawer } from "../dashboards/editor";
import { IdDialog, Modal } from "../dashboards/ui";
import { definitionDescriptor, draftRunDescriptor, runDescriptor } from "../dashboards/runtime";
import {
  emptyDefinition, emptyPanel, errorAt, fieldErrors, forSave, interpolateText,
  normalizeDefinition, paramsFromQuery, queryLinkState, queryValue, substituteSql,
  validateDefinition,
} from "../dashboards/model";

const stableParams = (params) => JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]));

export default function DashboardView({ id, route, nav }) {
  const fixture = route.query.fixture === "1";
  const isNew = route.query.new === "1";

  // A brand new dashboard has nothing to fetch: it starts as a draft.
  const stored = useFetch(() => (isNew ? null : definitionDescriptor(id, { fixture })), [id, fixture, isNew]);
  const [draft, setDraft] = useState(() => (isNew ? emptyDefinition(id, "") : null));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState([]);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(null);   // {index, panel} for the panel drawer
  const [varsOpen, setVarsOpen] = useState(false);
  const [dialog, setDialog] = useState(null);     // "clone" | "save-as" | "delete"

  const definition = useMemo(() => {
    if (draft) return draft;
    return stored.data ? normalizeDefinition(stored.data, id) : null;
  }, [draft, stored.data, id]);

  const editMode = draft !== null;

  // The URL is the source of truth for the variables; a variable the URL is
  // silent about falls back to its declared default inside the run.
  const given = useMemo(
    () => (definition ? paramsFromQuery(definition, route.query) : {}),
    [definition, route.query]);
  const givenKey = stableParams(given);

  // What the run depends on: which dashboard, or - while a draft is being edited
  // - the parts of the draft that change the rows. Retitling a panel does not
  // re-query; changing its SQL does.
  const runKey = useMemo(() => {
    if (!definition) return "";
    if (!editMode) return `api:${id}:${fixture ? "fixture" : "live"}`;
    return `draft:${JSON.stringify({
      p: definition.panels.map((p) => [p.id, p.sql, p.limit]),
      v: definition.variables,
    })}`;
  }, [definition, editMode, id, fixture]);

  const run = useFetch(
    () => {
      if (!definition) return null;
      return editMode ? draftRunDescriptor(definition, given) : runDescriptor(id, given, { fixture });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runKey, givenKey],
  );

  // Toggling edit mode, editing a panel's SQL and pressing Refresh all change
  // what is being asked for without changing what is being asked about, so the
  // panels keep the rows they have while the new answer is on the wire. A
  // different variable is a different question: that one does start blank,
  // because hub-west's rows under a hub-east title would be a lie.
  const lastRun = useRef({ key: "", data: null });
  if (run.data) lastRun.current = { key: givenKey, data: run.data };
  const answer = run.data || (lastRun.current.key === givenKey ? lastRun.current.data : null);

  // The run is authoritative about what the parameters ended up being (it fills
  // in the defaults), which is what the bar and the titles should show.
  const params = answer?.params || given;
  const results = answer?.results || {};
  const variables = answer?.variables || {};

  const navigate = useRef(route.navigate);
  navigate.current = route.navigate;
  const routeRef = useRef(route);
  routeRef.current = route;

  const setVariable = useCallback((name, value) => {
    const next = { ...routeRef.current.query };
    const text = queryValue(value);
    if (text) next[name] = text;
    else delete next[name];
    navigate.current(routeRef.current.path, next, { replace: true });
  }, []);

  const flash = useCallback((text) => {
    setNote(text);
    setTimeout(() => setNote((n) => (n === text ? "" : n)), 2200);
  }, []);

  useEffect(() => { setErrors([]); }, [id]);

  // --- editing -------------------------------------------------------------
  const startEdit = () => setDraft(normalizeDefinition(definition, id));
  // Leaving edit mode closes everything that was editing something: a drawer or
  // a "save as" left standing over a draft that no longer exists would be
  // acting on nothing.
  const cancelEdit = () => {
    setDraft(null);
    setErrors([]);
    setEditing(null);
    setVarsOpen(false);
    setDialog(null);
    if (isNew) navigate.current("/dashboards", fixture ? { fixture: "1" } : {});
  };
  const patchDraft = (fields) => setDraft((d) => ({ ...d, ...fields }));

  const applyPanel = (panel) => {
    setDraft((d) => {
      const panels = [...d.panels];
      if (editing.index < 0) panels.push(panel);
      else panels[editing.index] = panel;
      return { ...d, panels };
    });
    setEditing(null);
  };

  const removePanel = (index) =>
    setDraft((d) => ({ ...d, panels: d.panels.filter((_, i) => i !== index) }));

  const movePanel = (index, delta) => setDraft((d) => {
    const to = index + delta;
    if (to < 0 || to >= d.panels.length) return d;
    const panels = [...d.panels];
    const [moved] = panels.splice(index, 1);
    panels.splice(to, 0, moved);
    return { ...d, panels };
  });

  const save = async (targetId) => {
    if (!draft) return;
    const body = { ...draft, id: targetId || draft.id };
    const local = validateDefinition(normalizeDefinition(body, body.id));
    if (local.length) { setErrors(local); return; }
    setSaving(true);
    setErrors([]);
    try {
      await api.saveDashboard(body.id, forSave(body));
      invalidate("/api/dashboards");
      setDraft(null);
      setDialog(null);
      if (body.id !== id || isNew) {
        navigate.current(`/dashboards/${encodeURIComponent(body.id)}`, variablesInUrl(route.query));
      } else {
        flash("Saved");
      }
    } catch (e) {
      setErrors(fieldErrors(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await api.deleteDashboard(id);
      invalidate("/api/dashboards");
      navigate.current("/dashboards", fixture ? { fixture: "1" } : {});
    } catch (e) {
      setErrors(fieldErrors(e));
      setDialog(null);
    } finally {
      setSaving(false);
    }
  };

  // Cloning writes the copy before it opens it. The id is in the path, so the
  // route change remounts this view - a draft held in state would not survive
  // the trip, and a clone that exists only in one tab is not a clone.
  const cloneTo = async (newId) => {
    setSaving(true);
    setErrors([]);
    try {
      const copy = { ...normalizeDefinition(definition, id), id: newId, builtin: false,
        title: `${definition.title} (copy)` };
      await api.saveDashboard(newId, forSave(copy));
      invalidate("/api/dashboards");
      setDialog(null);
      navigate.current(`/dashboards/${encodeURIComponent(newId)}`, variablesInUrl(route.query));
    } catch (e) {
      setErrors(fieldErrors(e));
    } finally {
      setSaving(false);
    }
  };

  const openInQuery = (panel) => {
    const encoded = queryLinkState(substituteSql(panel.sql, params), panel.chart);
    if (encoded) navigate.current("/query", { q: encoded });
  };

  // --- render --------------------------------------------------------------
  if (!definition) {
    if (stored.error) return <MissingDashboard id={id} error={stored.error} route={route} fixture={fixture} />;
    return <SkeletonLines rows={8} />;
  }

  const title = interpolateText(definition.title, params);
  const snapshot = answer?.snapshot;
  const generation = answer?.generation;
  // A dialog is modal, so an error from what it submitted belongs inside it
  // rather than on the page behind it.
  const unkeyed = errorAt(errors, "");
  const dialogError = dialog ? errorAt(errors, "id") || unkeyed : "";

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="section-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <span className="back" onClick={() => route.back("/dashboards")}>← All dashboards</span>
          {editMode ? (
            <>
              <input
                className="db-title-input"
                type="text"
                value={definition.title}
                placeholder="Dashboard title"
                aria-label="Dashboard title"
                onChange={(e) => patchDraft({ title: e.target.value })}
              />
              <input
                className="db-desc-input"
                type="text"
                value={definition.description}
                placeholder="What this dashboard answers"
                aria-label="Dashboard description"
                onChange={(e) => patchDraft({ description: e.target.value })}
              />
            </>
          ) : (
            <>
              <div className="section-title" style={{ margin: 0 }}>
                {title}
                {definition.builtin && <span className="tag db-tag">built in</span>}
                {fixture && <span className="tag db-tag">fixture</span>}
              </div>
              {definition.description && <div className="desc">{definition.description}</div>}
            </>
          )}
        </div>
        <div className="db-head-actions">
          {generation != null && (
            <span className="muted db-snap">
              snapshot {generation}
              {snapshot?.built_at ? ` · built ${fmtAge(snapshot.built_at)} ago` : ""}
              {answer?.local ? " · run locally" : ""}
            </span>
          )}
          {note && <span className="tag">{note}</span>}
          {editMode ? (
            <>
              <button type="button" className="btn" onClick={() => setVarsOpen(true)}>Variables</button>
              <button type="button" className="btn"
                onClick={() => setEditing({ index: -1, panel: emptyPanel("") })}>
                Add panel
              </button>
              <button type="button" className="btn" onClick={() => setDialog("save-as")}>Save as…</button>
              {!isNew && !definition.builtin && (
                <button type="button" className="btn" onClick={() => setDialog("delete")}>Delete</button>
              )}
              <button type="button" className="btn" onClick={cancelEdit}>Cancel</button>
              <button type="button" className="btn primary" disabled={saving} onClick={() => save()}>
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" disabled={run.loading}
                onClick={() => { stored.reload(); run.reload(); }}>
                {run.loading ? "Running…" : "↻ Refresh"}
              </button>
              {definition.builtin ? (
                <button type="button" className="btn" onClick={() => setDialog("clone")}>Clone to edit</button>
              ) : (
                <button type="button" className="btn" onClick={startEdit}>Edit</button>
              )}
            </>
          )}
        </div>
      </div>

      {!dialog && unkeyed && <div className="banner">{unkeyed}</div>}
      {!dialog && errors.length > 0 && !unkeyed && (
        <div className="banner">
          {errors.length === 1 ? errors[0].message : `${errors.length} problems - see the fields below.`}
        </div>
      )}
      {run.error && !answer && <ErrorBanner error={run.error} />}

      <VariablesBar
        definition={definition}
        params={params}
        variables={variables}
        onChange={setVariable}
        right={run.stale ? <span className="muted">refreshing…</span> : null}
      />

      {definition.panels.length === 0 ? (
        <div className="card">
          <div className="empty">
            {editMode ? "No panels yet. \"Add panel\" writes the first one."
              : "This dashboard has no panels."}
          </div>
        </div>
      ) : (
        <div className="db-grid">
          {definition.panels.map((panel, i) => (
            <Panel
              key={panel.id}
              panel={panel}
              definition={definition}
              result={results[panel.id]}
              params={params}
              loading={run.loading}
              nav={nav}
              editing={editMode}
              first={i === 0}
              last={i === definition.panels.length - 1}
              onOpenQuery={() => openInQuery(panel)}
              onEdit={() => setEditing({ index: i, panel })}
              onRemove={() => removePanel(i)}
              onMove={(delta) => movePanel(i, delta)}
            />
          ))}
        </div>
      )}

      {editing && (
        <PanelDrawer
          panel={editing.panel}
          definition={definition}
          params={params}
          result={results[editing.panel.id]}
          errors={errors
            .filter((e) => e.path.startsWith(`panels.${editing.index}.`))
            .map((e) => ({ ...e, path: e.path.slice(`panels.${editing.index}.`.length) }))}
          onApply={applyPanel}
          onClose={() => setEditing(null)}
        />
      )}

      {varsOpen && (
        <VariablesDrawer
          definition={definition}
          errors={errors}
          onApply={(list) => { patchDraft({ variables: list }); setVarsOpen(false); }}
          onClose={() => setVarsOpen(false)}
        />
      )}

      {dialog === "clone" && (
        <IdDialog
          title="Clone this dashboard"
          intro="Built-in dashboards cannot be changed. This saves a copy, which is yours to edit."
          defaultId={`${definition.id}-copy`}
          busy={saving}
          error={dialogError}
          onCancel={() => setDialog(null)}
          onSubmit={cloneTo}
        />
      )}

      {dialog === "save-as" && (
        <IdDialog
          title="Save as a new dashboard"
          intro="The panels and variables are copied under a new id."
          defaultId={`${definition.id}-copy`}
          busy={saving}
          error={dialogError}
          onCancel={() => setDialog(null)}
          onSubmit={(newId) => save(newId)}
        />
      )}

      {dialog === "delete" && (
        <Modal
          title="Delete this dashboard"
          onClose={() => setDialog(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setDialog(null)}>Cancel</button>
              <button type="button" className="btn primary" disabled={saving} onClick={remove}>
                {saving ? "Deleting…" : "Delete"}
              </button>
            </>
          )}
        >
          <p style={{ marginTop: 0 }}>
            "{definition.title}" and its {definition.panels.length} panels are removed for
            everyone. This cannot be undone.
          </p>
        </Modal>
      )}
    </div>
  );
}

// Keep the variable values when the id changes; drop the page's own keys.
function variablesInUrl(query) {
  const out = { ...query };
  delete out.new;
  return out;
}

// --------------------------------------------------------------------------- //
// pieces
// --------------------------------------------------------------------------- //
// The dashboards API is the newest thing in the data layer, so a build without
// it is the likeliest reason a dashboard will not load. Say which it is.
function MissingDashboard({ id, error, route, fixture }) {
  const missing = error?.status === 404;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <span className="back" onClick={() => route.back("/dashboards")}>← All dashboards</span>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>
          {missing ? "No dashboard called that" : "This dashboard could not be loaded"}
        </h3>
        <p className="desc" style={{ marginTop: 0 }}>
          {missing
            ? `The data layer has no dashboard with the id "${id}". It may have been deleted, or this build of the API may not serve dashboards yet.`
            : String(error?.message || error)}
        </p>
        {!fixture && (
          <p className="q-desc">
            Developing against an API without the dashboard plane? Add <code>?fixture=1</code> to
            the URL to load a sample dashboard that runs on the query plane alone.
          </p>
        )}
      </div>
    </div>
  );
}
