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
import { Alert, Box, Button, Link, Stack, TextField, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import RefreshIcon from "@mui/icons-material/Refresh";
import { api } from "../api";
import type { ApiError } from "../api";
import { invalidate } from "../cache";
import { useFetch } from "../hooks";
import type { Nav, RouteApi } from "../router";
import { Card, Empty, Muted, Tag, ErrorBanner, SkeletonLines, fmtAge } from "../components";
import Panel from "../dashboards/Panel";
import VariablesBar from "../dashboards/VariablesBar";
import { PanelDrawer, VariablesDrawer } from "../dashboards/editor";
import { IdDialog, Modal } from "../dashboards/ui";
import { definitionDescriptor, draftRunDescriptor, runDescriptor } from "../dashboards/runtime";
import type { DashboardRun } from "../dashboards/runtime";
import {
  emptyDefinition, emptyPanel, errorAt, fieldErrors, forSave, interpolateText,
  normalizeDefinition, paramsFromQuery, queryLinkState, queryValue, substituteSql,
  validateDefinition,
} from "../dashboards/model";
import type { Definition, FieldError, Panel as PanelModel, Params, VariableValue } from "../dashboards/model";

interface DashboardViewProps {
  id: string;
  route: RouteApi;
  nav: Nav;
}

/** Which panel the drawer is editing; -1 is a panel that does not exist yet. */
interface EditingPanel {
  index: number;
  panel: PanelModel;
}

type DialogKind = "clone" | "save-as" | "delete";

const stableParams = (params: Params) =>
  JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]));

export default function DashboardView({ id, route, nav }: DashboardViewProps) {
  const fixture = route.query.fixture === "1";
  const isNew = route.query.new === "1";

  // A brand new dashboard has nothing to fetch: it starts as a draft.
  const stored = useFetch(() => (isNew ? null : definitionDescriptor(id, { fixture })), [id, fixture, isNew]);
  const [draft, setDraft] = useState<Definition | null>(() => (isNew ? emptyDefinition(id, "") : null));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<EditingPanel | null>(null);
  const [varsOpen, setVarsOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind | null>(null);

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
  const lastRun = useRef<{ key: string; data: DashboardRun | null }>({ key: "", data: null });
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

  const setVariable = useCallback((name: string, value: VariableValue) => {
    const next = { ...routeRef.current.query };
    const text = queryValue(value);
    if (text) next[name] = text;
    else delete next[name];
    navigate.current(routeRef.current.path, next, { replace: true });
  }, []);

  const flash = useCallback((text: string) => {
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
  // The draft only exists while the dashboard is being edited, and every
  // updater below hangs off a control that is only drawn then - so "no draft"
  // is nothing to update rather than a draft to invent.
  const patchDraft = (fields: Partial<Definition>) =>
    setDraft((d) => (d ? { ...d, ...fields } : d));

  const applyPanel = (panel: PanelModel) => {
    const at = editing?.index;
    setDraft((d) => {
      if (!d || at == null) return d;
      const panels = [...d.panels];
      if (at < 0) panels.push(panel);
      else panels[at] = panel;
      return { ...d, panels };
    });
    setEditing(null);
  };

  const removePanel = (index: number) =>
    setDraft((d) => (d ? { ...d, panels: d.panels.filter((_, i) => i !== index) } : d));

  const movePanel = (index: number, delta: number) => setDraft((d) => {
    if (!d) return d;
    const to = index + delta;
    if (to < 0 || to >= d.panels.length) return d;
    const panels = [...d.panels];
    const [moved] = panels.splice(index, 1);
    panels.splice(to, 0, moved);
    return { ...d, panels };
  });

  const save = async (targetId?: string) => {
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
  const cloneTo = async (newId: string) => {
    // The clone dialog is drawn below the "nothing loaded yet" return, so this
    // says out loud what that already guarantees.
    if (!definition) return;
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

  const openInQuery = (panel: PanelModel) => {
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
    <Stack spacing={2}>
      <Box sx={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 1.5, flexWrap: "wrap",
      }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <BackLink onClick={() => route.back("/dashboards")} />
          {editMode ? (
            <>
              <TextField
                value={definition.title}
                placeholder="Dashboard title"
                onChange={(e) => patchDraft({ title: e.target.value })}
                slotProps={{ htmlInput: { "aria-label": "Dashboard title" } }}
                sx={{
                  display: "block", width: "min(560px, 100%)", mb: 0.75,
                  "& .MuiInputBase-input": { fontSize: 18, fontWeight: 600 },
                }}
              />
              <TextField
                value={definition.description}
                placeholder="What this dashboard answers"
                onChange={(e) => patchDraft({ description: e.target.value })}
                slotProps={{ htmlInput: { "aria-label": "Dashboard description" } }}
                sx={{ display: "block", width: "min(560px, 100%)" }}
              />
            </>
          ) : (
            <>
              <Typography variant="h2" component="h2"
                sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                {title}
                {definition.builtin && <Tag sx={{ textTransform: "uppercase" }}>built in</Tag>}
                {fixture && <Tag sx={{ textTransform: "uppercase" }}>fixture</Tag>}
              </Typography>
              {definition.description && (
                <Muted sx={{ display: "block", fontSize: 12.5 }}>{definition.description}</Muted>
              )}
            </>
          )}
        </Box>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
          {generation != null && (
            <Muted sx={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
              snapshot {generation}
              {snapshot?.built_at ? ` · built ${fmtAge(snapshot.built_at)} ago` : ""}
              {answer?.local ? " · run locally" : ""}
            </Muted>
          )}
          {note && <Tag>{note}</Tag>}
          {editMode ? (
            <>
              <Button variant="outlined" color="inherit" onClick={() => setVarsOpen(true)}>Variables</Button>
              <Button variant="outlined" color="inherit"
                onClick={() => setEditing({ index: -1, panel: emptyPanel("") })}>
                Add panel
              </Button>
              <Button variant="outlined" color="inherit" onClick={() => setDialog("save-as")}>Save as…</Button>
              {!isNew && !definition.builtin && (
                <Button variant="outlined" color="inherit" onClick={() => setDialog("delete")}>Delete</Button>
              )}
              <Button variant="outlined" color="inherit" onClick={cancelEdit}>Cancel</Button>
              <Button variant="contained" disabled={saving} onClick={() => save()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outlined" color="inherit" disabled={run.loading}
                startIcon={<RefreshIcon />}
                onClick={() => { stored.reload(); run.reload(); }}>
                {run.loading ? "Running…" : "Refresh"}
              </Button>
              {definition.builtin ? (
                <Button variant="outlined" color="inherit" onClick={() => setDialog("clone")}>Clone to edit</Button>
              ) : (
                <Button variant="outlined" color="inherit" onClick={startEdit}>Edit</Button>
              )}
            </>
          )}
        </Stack>
      </Box>

      {!dialog && unkeyed && <Alert severity="error">{unkeyed}</Alert>}
      {!dialog && errors.length > 0 && !unkeyed && (
        <Alert severity="error">
          {errors.length === 1 ? errors[0].message : `${errors.length} problems - see the fields below.`}
        </Alert>
      )}
      {run.error && !answer && <ErrorBanner error={run.error} />}

      <VariablesBar
        definition={definition}
        params={params}
        variables={variables}
        onChange={setVariable}
        right={run.stale ? <Muted>refreshing…</Muted> : null}
      />

      {definition.panels.length === 0 ? (
        <Card>
          <Empty>
            {editMode ? "No panels yet. \"Add panel\" writes the first one."
              : "This dashboard has no panels."}
          </Empty>
        </Card>
      ) : (
        <PanelGrid>
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
        </PanelGrid>
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
              <Button variant="outlined" color="inherit" onClick={() => setDialog(null)}>Cancel</Button>
              <Button variant="contained" disabled={saving} onClick={remove}>
                {saving ? "Deleting…" : "Delete"}
              </Button>
            </>
          )}
        >
          <Typography variant="body1">
            &quot;{definition.title}&quot; and its {definition.panels.length} panels are removed for
            everyone. This cannot be undone.
          </Typography>
        </Modal>
      )}
    </Stack>
  );
}

/** The way back to the list, at the top of every dashboard page. */
function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <Link
      component="button"
      type="button"
      color="text.secondary"
      onClick={onClick}
      sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, mb: 1.25, fontSize: 13 }}
    >
      <ArrowBackIcon fontSize="inherit" /> All dashboards
    </Link>
  );
}

/**
 * A twelve-column grid of cards over fixed rows, so a panel's size is two small
 * integers and its height is known before anything is measured - which is what
 * lets a chart inside one be sized without a layout pass. Below the breakpoint
 * the columns collapse to one and each panel keeps the height it asked for, so
 * charts do not flatten on a phone.
 */
function PanelGrid({ children }: { children?: React.ReactNode }) {
  return (
    <Box sx={{
      display: "grid", gap: 2,
      gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(12, minmax(0, 1fr))" },
      gridAutoRows: { xs: "auto", md: "150px" },
      "& > section": {
        gridColumn: { xs: "1 / -1", md: "span var(--w, 6)" },
        gridRow: { xs: "auto", md: "span var(--h, 2)" },
        height: { xs: "calc(var(--h, 2) * 150px + (var(--h, 2) - 1) * 16px)", md: "auto" },
      },
    }}>
      {children}
    </Box>
  );
}

// Keep the variable values when the id changes; drop the page's own keys.
function variablesInUrl(query: Record<string, string>) {
  const out = { ...query };
  delete out.new;
  return out;
}

// --------------------------------------------------------------------------- //
// pieces
// --------------------------------------------------------------------------- //
// The dashboards API is the newest thing in the data layer, so a build without
// it is the likeliest reason a dashboard will not load. Say which it is.
interface MissingDashboardProps {
  id: string;
  error: ApiError;
  route: RouteApi;
  fixture: boolean;
}

function MissingDashboard({ id, error, route, fixture }: MissingDashboardProps) {
  const missing = error?.status === 404;
  return (
    <Stack spacing={2}>
      <Box><BackLink onClick={() => route.back("/dashboards")} /></Box>
      <Card title={missing ? "No dashboard called that" : "This dashboard could not be loaded"}>
        <Typography variant="body1" color="text.secondary">
          {missing
            ? `The data layer has no dashboard with the id "${id}". It may have been deleted, or this build of the API may not serve dashboards yet.`
            : String(error?.message || error)}
        </Typography>
        {!fixture && (
          <Muted sx={{ display: "block", fontSize: 11.5, mt: 1.5 }}>
            Developing against an API without the dashboard plane? Add <code>?fixture=1</code> to
            the URL to load a sample dashboard that runs on the query plane alone.
          </Muted>
        )}
      </Card>
    </Stack>
  );
}
