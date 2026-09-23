// Generate: a question on the left, the dashboard it becomes on the right.
//
// The conversation and the grid are two views of one thing - the agent's state,
// which is a dashboard definition. Every panel here is the same component, the
// same chart and the same batch runtime as a saved dashboard, because the agent
// composes from the dashboards vocabulary rather than inventing UI: what is on
// screen can be saved with PUT /api/dashboards/{id} and will run unchanged.
//
// The panels are run here rather than by the agent. The agent validates a
// panel's SQL when it writes it and tells the model the shape of the answer;
// the rows on screen come from the query plane the moment the panel lands, so a
// dashboard being written is already a dashboard being used.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Box, Button, Link, Paper, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { keyframes } from "@mui/material/styles";
import RefreshIcon from "@mui/icons-material/Refresh";
import { api } from "../api";
import type { ApiError } from "../api";
import type { AgentAvailabilityResponse, BatchEntry } from "../api/types";
import { invalidate } from "../cache";
import { useFetch } from "../hooks";
import type { Fetched } from "../hooks";
import type { Nav, QueryValues, RouteApi } from "../router";
import { Card, Empty, MONO_FONT, Muted, Tag, SkeletonTable } from "../components";
import { TOPBAR_HEIGHT } from "../theme";
import Panel from "../dashboards/Panel";
import VariablesBar from "../dashboards/VariablesBar";
import { IdDialog } from "../dashboards/ui";
import { runLocally } from "../dashboards/runtime";
import type { VariableOptions } from "../dashboards/runtime";
import {
  fieldErrors, forSave, interpolateText, normalizeDefinition, queryLinkState, queryValue,
  slugify, substituteSql,
} from "../dashboards/model";
import type { Definition, Panel as PanelModel, Params } from "../dashboards/model";
import useAgentRun from "../agent/useAgentRun";
import type { ActivityItem, RunResult, TranscriptItem } from "../agent/useAgentRun";

interface GenerateProps {
  route: RouteApi;
  nav: Nav;
}

// A dashboard-sized question asks for a view, not a row: several panels that
// belong together. These are the shapes the ADR names - a hub, its apps, its
// namespaces - written the way someone would actually type them.
const EXAMPLES = [
  "What are the apps, namespaces and clusters under hub-east, and how healthy are they?",
  "Review production: cluster status, OpenShift versions, and what is failing.",
  "Which namespaces have the most pod issues, and on which clusters?",
  "How many applications does each team run, and where are they deployed?",
];

const DEBOUNCE_MS = 150;

const stableParams = (params: Params) =>
  JSON.stringify(Object.keys(params || {}).sort().map((k) => [k, params[k]]));

// Which panel an update_panel call is about. The id is written early in the
// arguments, so the panel can start dimming before the arguments parse.
const PARTIAL_ID = /"id"\s*:\s*"([^"]*)"/;
const targetOf = (item: ActivityItem): string =>
  String(item.args?.id || (PARTIAL_ID.exec(item.argsText || "") || [])[1] || "");

// A type predicate, because the transcript is a union: what the caller wants
// out of a filtered list is the tool call, not "one of four kinds of item".
const inFlight = (item: TranscriptItem, name: string): item is ActivityItem =>
  item.kind === "activity" && item.name === name
  && (item.status === "streaming" || item.status === "running");

// --------------------------------------------------------------------------- //
// running what the agent has written so far
// --------------------------------------------------------------------------- //
// Not useFetch: this is not a URL being read, it is a definition that changes
// three times a second while it is being written. What it borrows from the SWR
// cache is the idea - a panel whose query did not change keeps the rows it has
// while the new ones are on the wire, so the grid fills in rather than blinks.
/** What the grid is drawing: a result per panel, the options behind each
 * variable, the values the run settled on, and why there is nothing. */
interface PanelRun {
  results: Record<string, BatchEntry>;
  variables: Record<string, VariableOptions>;
  params: Params;
  error: ApiError | null;
  loading: boolean;
}

function usePanelRun(definition: Definition, params: Params) {
  const [run, setRun] = useState<PanelRun>(
    { results: {}, variables: {}, params: {}, error: null, loading: false });
  const [nonce, setNonce] = useState(0);
  const latest = useRef({ definition, params });
  latest.current = { definition, params };
  const abort = useRef<AbortController | null>(null);
  // panel id -> the query it was last asked
  const asked = useRef<Record<string, string>>({});

  // What changes the rows: a panel's SQL and row cap, the variables' own
  // queries, and the values they are set to. Retitling a panel does not.
  const shape = JSON.stringify({
    p: (definition.panels || []).map((p) => [p.id, p.sql, p.limit]),
    v: (definition.variables || []).map((v) => [v.name, v.sql, v.default, v.multi]),
  }) + stableParams(params);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    const panels = latest.current.definition.panels || [];
    // The variables are part of what a panel was asked, not just how it was
    // written: hub-west's rows under a hub-east title would be a lie, so a
    // different value starts blank while the same question keeps its rows.
    const values = stableParams(latest.current.params);
    const next: Record<string, string> = {};
    panels.forEach((p) => { next[p.id] = `${p.sql} :: ${p.limit || ""} :: ${values}`; });

    // What was asked last time, read now: the updater below runs during the
    // render that follows, by which point asked.current is already `next`.
    const previous = asked.current;
    asked.current = next;
    setRun((r) => {
      const kept: Record<string, BatchEntry> = {};
      for (const [id, result] of Object.entries(r.results)) {
        if (next[id] && next[id] === previous[id]) kept[id] = result;
      }
      return { ...r, results: kept, error: null, loading: panels.length > 0 };
    });
    if (!panels.length) return undefined;

    // The agent writes a panel every second or two and a variable's value can
    // change under a keystroke: one run per settled state, not one per event.
    const timer = setTimeout(() => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      runLocally(latest.current.definition, latest.current.params, controller.signal).then(
        (answer) => {
          if (controller.signal.aborted) return;
          setRun((r) => ({
            results: { ...r.results, ...answer.results },
            variables: answer.variables || {},
            params: answer.params || {},
            error: null,
            loading: false,
          }));
        },
        (e: ApiError) => {
          if (controller.signal.aborted || e?.name === "AbortError") return;
          // The whole run failed (no query plane at all), which is one message
          // above the grid rather than the same message in every panel.
          setRun((r) => ({ ...r, error: e, loading: false }));
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, nonce]);

  return { ...run, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

// --------------------------------------------------------------------------- //
// the page
// --------------------------------------------------------------------------- //
export default function Generate({ route, nav }: GenerateProps) {
  const fixture = route.query.fixture === "1";
  const agent = useAgentRun({ fixture });
  const { state, transcript, running, result, send, stop, reset, setParam, patchDashboard } = agent;

  // The generation endpoint is the newest thing in the API, so a build without
  // it is the likeliest reason this page will not work. Asking once on mount
  // costs nothing and turns a failed run into a sentence.
  const info = useFetch(() => (fixture ? null : api.agent()), [fixture]);
  const settled = fixture || !!info.data || !!info.error;
  const available = fixture || !!info.data?.available;

  const [dialog, setDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const [prefill, setPrefill] = useState("");

  // The state is the wire's shape; the grid needs the normalised one (a chart
  // written as {type: bar} is the component's "bars"). The raw state is what
  // goes back to the agent, so it is normalised for rendering only.
  const definition = useMemo(
    () => normalizeDefinition(state.dashboard, "generated"), [state.dashboard]);
  // normalizeDefinition names an untitled dashboard after its id, which is the
  // right fallback on the grid and the wrong one in a field the user types in:
  // the inputs edit what the agent actually set.
  // The agent's state is an open record on the wire, so what it wrote into the
  // two fields is read as the text they hold; the variables plane is what says
  // a parameter is a scalar or a list.
  const written = {
    title: (state.dashboard?.title || "") as string,
    description: (state.dashboard?.description || "") as string,
  };
  const given = (state.params || {}) as Params;
  const run = usePanelRun(definition, given);
  const params = run.params && Object.keys(run.params).length ? run.params : given;

  const navigate = useRef(route.navigate);
  navigate.current = route.navigate;

  // A question arriving from the Query page runs itself, once, and then leaves
  // the URL - otherwise Back would ask it again.
  const consumed = useRef(false);
  useEffect(() => {
    const question = route.query.q;
    if (!question || consumed.current || !settled) return;
    consumed.current = true;
    const rest = { ...route.query };
    delete rest.q;
    navigate.current(route.path, rest, { replace: true });
    // Nothing can run without the endpoint, so the question waits in the box
    // rather than becoming a failed turn the user did not ask for.
    if (available) send(question);
    else setPrefill(question);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.query.q, settled, available]);

  const pendingPanels = transcript.filter((i): i is ActivityItem => inFlight(i, "add_panel"));
  const updating = new Set(
    transcript.filter((i): i is ActivityItem => inFlight(i, "update_panel")).map(targetOf));

  const openInQuery = (panel: PanelModel) => {
    const encoded = queryLinkState(substituteSql(panel.sql, params), panel.chart);
    if (encoded) navigate.current("/query", { q: encoded });
  };

  // Saving is the whole point of composing from the dashboards vocabulary: what
  // the agent built is a definition, so it is written with the same PUT the
  // editor uses and opens as an ordinary dashboard.
  const save = async (id: string) => {
    setSaving(true);
    setProblem("");
    try {
      await api.saveDashboard(id, forSave({ ...definition, id }));
      invalidate("/api/dashboards");
      setDialog(false);
      // The variables go with it, so the dashboard opens on the hub that is on
      // screen rather than on whatever its defaults say.
      const query: QueryValues = {};
      for (const v of definition.variables) {
        const text = queryValue(params[v.name]);
        if (text) query[v.name] = text;
      }
      navigate.current(`/dashboards/${encodeURIComponent(id)}`, query);
    } catch (e) {
      setProblem(fieldErrors(e)[0]?.message || String((e as Error)?.message || e));
      setSaving(false);
    }
  };

  const title = interpolateText(definition.title, params);
  const hasPanels = definition.panels.length > 0;
  const started = transcript.length > 0;

  return (
    <Stack spacing={2}>
      <Box sx={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 1.5, flexWrap: "wrap",
      }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h2" component="h2"
            sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            Generate
            {fixture && <Tag sx={{ textTransform: "uppercase" }}>fixture</Tag>}
            {info.data?.model && <Tag sx={{ fontFamily: MONO_FONT }}>{info.data.model}</Tag>}
          </Typography>
          <Muted sx={{ display: "block", fontSize: 12.5 }}>
            Ask for a view rather than a row. The agent writes each panel as a guarded SELECT,
            checks it against the snapshot, and builds the dashboard as it goes.
          </Muted>
        </Box>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
          {started && (
            <Button variant="outlined" color="inherit" onClick={() => { reset(); setProblem(""); }}>
              Start over
            </Button>
          )}
          <Button variant="outlined" color="inherit" disabled={!hasPanels || run.loading}
            startIcon={<RefreshIcon />} onClick={run.reload}>
            {run.loading ? "Running…" : "Refresh"}
          </Button>
          <Button variant="contained" disabled={!hasPanels}
            onClick={() => { setProblem(""); setDialog(true); }}>
            Save as dashboard…
          </Button>
        </Stack>
      </Box>

      <Availability info={info} fixture={fixture} route={route} />

      <Box sx={{
        display: "grid", gap: 2, alignItems: "start",
        gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "380px minmax(0, 1fr)" },
      }}>
        <Paper sx={{
          p: 0, display: "flex", flexDirection: "column", overflow: "hidden",
          position: { xs: "static", lg: "sticky" },
          top: { lg: `${TOPBAR_HEIGHT + 24}px` },
          height: { xs: "auto", lg: `calc(100vh - ${TOPBAR_HEIGHT + 48}px)` },
          minHeight: { lg: 420 },
        }}>
          <Box sx={{
            flex: 1, minHeight: 0, maxHeight: { xs: 460, lg: "none" },
            overflow: "auto", overscrollBehavior: "contain",
            p: "14px 16px", display: "flex", flexDirection: "column", gap: 1.25,
          }}>
            {started ? (
              <Transcript items={transcript} running={running} result={result} />
            ) : (
              <Intro onPick={send} disabled={!available && settled} />
            )}
          </Box>
          <Composer
            prefill={prefill}
            running={running}
            disabled={!available && settled}
            onSend={send}
            onStop={stop}
          />
        </Paper>

        <Box sx={{ display: "grid", gap: 2, minWidth: 0 }}>
          {(hasPanels || written.title) && (
            <Box sx={{ minWidth: 0 }}>
              <TextField
                value={written.title}
                placeholder="Untitled dashboard"
                onChange={(e) => patchDashboard({ title: e.target.value })}
                slotProps={{ htmlInput: { "aria-label": "Dashboard title" } }}
                sx={{
                  display: "block", width: "min(560px, 100%)", mb: 0.75,
                  "& .MuiInputBase-input": { fontSize: 18, fontWeight: 600 },
                }}
              />
              <TextField
                value={written.description}
                placeholder="What this dashboard answers"
                onChange={(e) => patchDashboard({ description: e.target.value })}
                slotProps={{ htmlInput: { "aria-label": "Dashboard description" } }}
                sx={{ display: "block", width: "min(560px, 100%)" }}
              />
            </Box>
          )}

          {definition.variables.length > 0 && (
            <VariablesBar
              definition={definition}
              params={params}
              variables={run.variables}
              onChange={setParam}
              right={run.loading ? <Muted>running…</Muted> : null}
            />
          )}

          {run.error && (
            <Notice>
              <strong>The panels could not be run.</strong>{" "}
              {String(run.error.message || run.error)} The dashboard above is what the agent
              wrote; the rows come from the query plane, which did not answer.
            </Notice>
          )}

          {!hasPanels && !pendingPanels.length ? (
            <Card>
              <Empty>
                {running ? "Writing the first panel…"
                  : "The dashboard appears here, one panel at a time, as the agent writes it."}
              </Empty>
            </Card>
          ) : (
            <PanelGrid>
              {definition.panels.map((panel, i) => (
                // The grid here is read-only: the agent writes the panels,
                // the person edits them by asking for a change, and the only
                // thing a panel's menu offers is "Open in Query". Leaving the
                // editing callbacks out is what says so.
                <Panel
                  key={panel.id}
                  panel={panel}
                  definition={definition}
                  result={run.results[panel.id]}
                  params={params}
                  loading={run.loading}
                  busy={updating.has(panel.id)}
                  nav={nav}
                  first={i === 0}
                  last={i === definition.panels.length - 1}
                  onOpenQuery={() => openInQuery(panel)}
                />
              ))}
              {pendingPanels.map((item) => <PendingPanel key={item.id} title={item.title} />)}
            </PanelGrid>
          )}
        </Box>
      </Box>

      {dialog && (
        <IdDialog
          title="Save as a dashboard"
          intro="The panels, the variables and the chart choices are saved as an ordinary dashboard, which you can then edit, share and re-run."
          defaultId={slugify(title) || "generated-dashboard"}
          busy={saving}
          error={problem}
          submitLabel="Save"
          onCancel={() => setDialog(false)}
          onSubmit={save}
        />
      )}
    </Stack>
  );
}

/** A fact about the server, said calmly: not an error, not a warning, just the
 * thing that is true. */
function Notice({ children }: { children?: ReactNode }) {
  return (
    <Paper sx={{ p: "12px 15px", color: "text.secondary", fontSize: 13,
      borderColor: "divider", "& strong": { color: "text.primary" } }}>
      {children}
    </Paper>
  );
}

/**
 * The same twelve-column grid a saved dashboard uses, because a generated
 * dashboard and a saved one are the same thing.
 */
function PanelGrid({ children }: { children?: ReactNode }) {
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

// --------------------------------------------------------------------------- //
// the conversation
// --------------------------------------------------------------------------- //
interface TranscriptProps {
  items: TranscriptItem[];
  running: boolean;
  result: RunResult;
}

function Transcript({ items, running, result }: TranscriptProps) {
  const end = useRef<HTMLDivElement | null>(null);
  // Follow the stream, the way a terminal does - but only to the bottom, so
  // scrolling up to read an earlier panel is not fought over.
  useEffect(() => {
    const anchor = end.current;
    const el = anchor?.parentElement;
    if (!anchor || !el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (near) anchor.scrollIntoView({ block: "end" });
  }, [items, running]);

  return (
    <>
      {items.map((item) => {
        if (item.kind === "user") {
          return (
            <Box
              component="p"
              key={item.id}
              sx={{
                alignSelf: "flex-end", maxWidth: "92%", my: 0.25, p: "7px 11px", fontSize: 13,
                bgcolor: "primary.dark", color: "primary.contrastText",
                borderRadius: "10px 10px 3px 10px",
              }}
            >
              {item.text}
            </Box>
          );
        }
        if (item.kind === "text") {
          return (
            <Box component="p" key={item.id}
              sx={{ my: 0.25, fontSize: 13, whiteSpace: "pre-wrap" }}>
              {item.text}
            </Box>
          );
        }
        if (item.kind === "note") {
          return (
            <Box
              component="p"
              key={item.id}
              sx={{ my: 0.25, fontSize: 12.5, color: item.tone === "error" ? "error.main" : "text.disabled" }}
            >
              {item.text}
            </Box>
          );
        }
        return <Activity key={item.id} item={item} />;
      })}
      {running && (
        <Box sx={{ color: "text.secondary", fontSize: 12.5, animation: `${PULSE} 1.4s ease-in-out infinite` }}>
          Working…
        </Box>
      )}
      {!running && result && <Cost result={result} />}
      <div ref={end} />
    </>
  );
}

// One tool call: what it is doing, and what came back. The arguments are not
// shown - a panel's SQL is on the panel, and the point of the activity line is
// that it reads as an action rather than as a function call.
function Activity({ item }: { item: ActivityItem }) {
  // What a tool call answered with: a query result when it ran one, an error
  // when it did not. It is the agent's own JSON, so it is read as a record.
  const result = (item.result || {}) as { row_count?: number; columns?: string[]; error?: unknown };
  const rows = result.row_count;
  const running = item.status === "streaming" || item.status === "running";
  return (
    <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, minWidth: 0 }}>
      <Box
        component="span"
        aria-hidden="true"
        sx={{
          flex: "none", width: 15, height: 15, mt: "1px", borderRadius: "50%",
          bgcolor: "background.subtle", fontSize: 9.5, fontWeight: 700,
          lineHeight: "13px", textAlign: "center", border: 1,
          borderColor: item.status === "done" ? "success.main"
            : item.status === "error" ? "error.main"
              : running ? "primary.main" : "divider",
          color: item.status === "done" ? "success.main"
            : item.status === "error" ? "error.main" : "text.disabled",
          ...(running ? { animation: `${PULSE} 1.2s ease-in-out infinite` } : {}),
        }}
      >
        {item.status === "done" ? "✓" : item.status === "error" ? "!" : ""}
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Box sx={{ fontSize: 12.5, color: item.status === "done" ? "text.primary" : "text.secondary" }}>
          {item.label}
        </Box>
        {/* `error` is the agent's own JSON, so it is coerced rather than
            trusted to be a string. The guard names every table it knows, which
            is three lines nobody needs until they do: clamped here, whole in
            the tooltip. */}
        {item.status === "error" && !!result.error && (
          <Tooltip title={String(result.error)}>
            <Box sx={{
              color: "error.main", fontSize: 11.5, mt: "2px",
              display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}>
              {String(result.error)}
            </Box>
          </Tooltip>
        )}
        {item.status === "done" && rows != null && (
          <Muted sx={{
            display: "block", fontSize: 11.5, mt: "1px",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {rows.toLocaleString()} {rows === 1 ? "row" : "rows"}
            {result.columns?.length ? ` · ${result.columns.join(", ")}` : ""}
          </Muted>
        )}
      </Box>
    </Box>
  );
}

/** The one animation on this page: something is still happening. MUI's keyframes
 * helper is what makes it a real @keyframes rule rather than an inline style. */
const PULSE = keyframes({ "50%": { opacity: 0.45 } });

function Cost({ result }: { result: NonNullable<RunResult> }) {
  const parts: string[] = [];
  // RUN_FINISHED carries whatever the server measured, so the three counters
  // this line shows are read off it rather than declared as its shape.
  const { turns, tool_calls: toolCalls, elapsed_ms: elapsedMs } =
    result as { turns?: number; tool_calls?: number; elapsed_ms?: number };
  if (turns != null) parts.push(`${turns} ${turns === 1 ? "turn" : "turns"}`);
  if (toolCalls != null) parts.push(`${toolCalls} tool calls`);
  if (elapsedMs != null) parts.push(`${(elapsedMs / 1000).toFixed(1)} s`);
  if (!parts.length) return null;
  return (
    <Muted sx={{
      mt: 0.5, pt: 1, borderTop: 1, borderColor: "border.soft",
      fontSize: 11.5, fontVariantNumeric: "tabular-nums",
    }}>
      {parts.join(" · ")}
    </Muted>
  );
}

function Intro({ onPick, disabled }: { onPick: (question: string) => void; disabled: boolean }) {
  return (
    <Box sx={{ color: "text.secondary", fontSize: 13 }}>
      <Box component="p" sx={{ m: "0 0 12px" }}>
        Describe the view you want. The agent picks the tables, writes one guarded SELECT per
        panel, runs each one against the current snapshot and keeps the ones that answer - so
        what arrives is a dashboard you can save, share and edit like any other.
      </Box>
      <Box component="p" sx={{ m: "0 0 12px" }}>
        Then say what to change: a follow-up edits this dashboard rather than starting again.
      </Box>
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>Try one</Typography>
      {EXAMPLES.map((q) => (
        <Button
          key={q}
          fullWidth
          disabled={disabled}
          onClick={() => onPick(q)}
          sx={{
            display: "block", textAlign: "left", mb: 0.75, p: "7px 10px", fontSize: 12.5,
            color: "text.secondary", border: 1, borderStyle: "dashed", borderColor: "divider",
            "&:hover": { borderStyle: "dashed", borderColor: "primary.main", color: "text.primary" },
          }}
        >
          {q}
        </Button>
      ))}
    </Box>
  );
}

interface ComposerProps {
  /** A question that arrived from the Query page, waiting to be sent. */
  prefill: string;
  running: boolean;
  disabled: boolean;
  onSend: (question: string) => void;
  onStop: () => void;
}

function Composer({ prefill, running, disabled, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { if (prefill) setText(prefill); }, [prefill]);
  // The box grows with what is typed, up to the cap the stylesheet sets.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const submit = () => {
    const question = text.trim();
    if (!question || running || disabled) return;
    setText("");
    onSend(question);
  };

  return (
    <Box
      component="form"
      onSubmit={(e: React.FormEvent) => { e.preventDefault(); submit(); }}
      sx={{
        flex: "none", display: "flex", alignItems: "flex-end", gap: 1,
        p: "10px 12px", borderTop: 1, borderColor: "divider", bgcolor: "background.subtle",
      }}
    >
      <TextField
        multiline
        inputRef={box}
        rows={1}
        value={text}
        disabled={running || disabled}
        placeholder={disabled ? "Not available on this build" : "Ask for a dashboard…"}
        onChange={(e) => setText(e.target.value)}
        slotProps={{
          htmlInput: {
            "aria-label": "Ask for a dashboard",
            // Enter sends, because this is a question and not a document; a
            // newline is still there for someone pasting a list of things.
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            },
          },
        }}
        sx={{ flex: 1, minWidth: 0, "& .MuiInputBase-root": { p: "8px 10px", fontSize: 13 } }}
      />
      {running ? (
        <Button variant="outlined" color="inherit" onClick={onStop} sx={{ flex: "none" }}>Stop</Button>
      ) : (
        <Button type="submit" variant="contained" disabled={disabled || !text.trim()} sx={{ flex: "none" }}>
          Ask
        </Button>
      )}
    </Box>
  );
}

// --------------------------------------------------------------------------- //
// the grid
// --------------------------------------------------------------------------- //
// A panel that is being written, standing in the place it will take. It is a
// .db-panel, so it is the same card in the same grid - only its contents are
// waiting.
function PendingPanel({ title }: { title?: string }) {
  return (
    // The grid reads a panel's size off two custom properties, which are not
    // part of the CSSProperties vocabulary - hence the one assertion.
    <Paper
      component="section"
      style={{ "--w": 6, "--h": 2 } as CSSProperties}
      aria-label={title ? `Writing ${title}` : "Writing a panel"}
      sx={{
        display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, p: 0,
        overflow: "hidden", borderStyle: "dashed",
      }}
    >
      <Box component="header" sx={{
        display: "flex", alignItems: "center", gap: 1, flex: "none",
        p: "9px 8px 9px 14px", borderBottom: 1, borderBottomStyle: "dashed", borderColor: "border.soft",
      }}>
        <Typography variant="h5" component="h4" color="text.secondary" sx={{ flex: 1, fontStyle: "italic" }}>
          {title || "New panel"}
        </Typography>
        <Muted sx={{ fontSize: 11.5, animation: `${PULSE} 1.4s ease-in-out infinite` }}>writing…</Muted>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: "8px 4px 4px" }}>
        <SkeletonTable columns={4} rows={4} dense />
      </Box>
    </Paper>
  );
}

// --------------------------------------------------------------------------- //
// availability
// --------------------------------------------------------------------------- //
// Three ways this page can be unusable, and none of them is a crash: the build
// has no such endpoint, the endpoint has no credentials, or it could not be
// reached at all. Each is a fact about the server, said plainly, with the
// fixture left as the way to see the page working anyway.
interface AvailabilityProps {
  info: Fetched<AgentAvailabilityResponse>;
  fixture: boolean;
  route: RouteApi;
}

function Availability({ info, fixture, route }: AvailabilityProps) {
  if (fixture || (!info.error && info.data?.available !== false)) return null;

  const missing = info.error?.status === 404;
  const headline = missing ? "This data layer build has no generation endpoint"
    : info.error ? "The generation endpoint could not be reached"
      : "Dashboard generation is switched off";
  const detail = missing
    ? "GET /api/agent answered 404. The agent arrives with the next API build; the Dashboards and Query pages work without it."
    : info.error ? String(info.error.message || info.error).replace(/:\s*$/, "")
      : info.data?.reason || "The API did not say why.";

  return (
    <Notice>
      <strong>{headline}</strong>
      <div>{detail}</div>
      <Muted sx={{ display: "block", fontSize: 11.5, mt: 1 }}>
        <Link component="button" type="button"
          onClick={() => route.navigate("/generate", { fixture: "1" })}>
          Play the sample generation
        </Link>
        {" "}to see the page working against the query plane alone.
      </Muted>
    </Notice>
  );
}
