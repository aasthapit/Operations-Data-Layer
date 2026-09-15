// A scripted agent run, for developing the Generate view without the endpoint.
//
// /generate?fixture=1 plays this instead of POSTing to /api/agent/run. It is the
// same wiring the dashboards page uses for its sample definitions: nothing
// reaches this file unless the URL asks for it by name.
//
// What it plays is a real generation, beat for beat - narration, a variable, two
// panels, a panel whose SQL is wrong, the model noticing and fixing it, and a
// follow-up run that edits a panel rather than rebuilding the dashboard. The
// events are the ones the contract lists, in the order it lists them, so the
// client is exercised rather than mocked out.
//
// The SQL is the query plane's own: with a data layer behind the dev server the
// panels fill with real rows, exactly as a generated dashboard would.

const STEP = 26;        // ms between two deltas of the same message
const BEAT = 220;       // ms between two events that are different thoughts

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Word by word, the way a model streams: enough chunks that the view has to
// handle a partial message, few enough that the run does not crawl.
const chunks = (text, size = 4) => {
  const words = String(text).split(" ");
  const out = [];
  for (let i = 0; i < words.length; i += size) {
    out.push((i ? " " : "") + words.slice(i, i + size).join(" "));
  }
  return out;
};

// Arguments arrive as partial JSON, which is the whole reason the view shows a
// streaming title: the cut is deliberately mid-token.
const slices = (text, size = 36) => {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

// --------------------------------------------------------------------------- //
// the dashboard this run builds
// --------------------------------------------------------------------------- //
const HUB_VARIABLE = {
  name: "hub",
  label: "Hub",
  type: "select",
  required: true,
  default: "hub-east",
  sql: "SELECT DISTINCT hub_name AS value FROM clusters WHERE hub_name IS NOT NULL ORDER BY 1",
};

const CLUSTERS_PANEL = {
  id: "clusters-on-hub",
  title: "Clusters on {{hub}}",
  description: "Every cluster this hub manages, worst health first.",
  sql: `SELECT name, overall_status, ocp_version, nodes_ready, nodes_total, health_score
FROM clusters
WHERE hub_name = {{hub}}
ORDER BY health_score`,
  chart: { type: "table" },
  w: 5,
  h: 3,
};

const HEALTH_PANEL = {
  id: "health-trend",
  title: "Health score, last 24 hours",
  description: "Hourly health score per cluster, from the snapshot history.",
  sql: `SELECT date_trunc('hour', s.snapshot_at) AS hour,
       s.cluster_name AS cluster,
       avg(s.health_score) AS health_score
FROM health_snapshots s
JOIN clusters c ON c.name = s.cluster_name
WHERE c.hub_name = {{hub}}
  AND s.resolution = 'hour'
  AND s.snapshot_at >= now() - INTERVAL 1 DAY
GROUP BY 1, 2
ORDER BY 1, 2`,
  chart: { type: "line", x: "hour", y: "health_score", series: "cluster" },
  w: 7,
  h: 3,
};

// The attempt that does not run. The message is the query guard's own, because
// what the model has to recover from is the message it is actually given.
const BAD_PANEL = {
  id: "pod-issues",
  title: "Pods not running, by phase",
  sql: `SELECT phase, count(*) AS pods
FROM pods
WHERE hub_name = {{hub}}
GROUP BY 1
ORDER BY 2 DESC`,
  chart: { type: "bar" },
  w: 12,
  h: 2,
};

const BAD_ERROR = "unknown table 'pods'. Available tables: changes, cluster_operators, "
  + "clusters, collection_runs, health_checks, health_snapshots, hubs, namespaces, nodes, "
  + "pod_issues, resource_status, resources, workload_images, workload_refs, workloads";

const ISSUES_PANEL = {
  id: "pod-issues",
  title: "Pod issues by reason",
  description: "Why pods on this hub are unhealthy.",
  sql: `SELECT p.reason, count(*) AS pods
FROM pod_issues p
JOIN clusters c ON c.name = p.cluster_name
WHERE c.hub_name = {{hub}}
GROUP BY 1
ORDER BY 2 DESC`,
  chart: { type: "bar", x: "reason", y: "pods" },
  w: 12,
  h: 2,
};

// What the follow-up run turns the third panel into.
const BY_NAMESPACE_PANEL = {
  ...ISSUES_PANEL,
  title: "Pod issues by namespace",
  description: "Which namespaces the unhealthy pods are in, and why.",
  sql: `SELECT p.namespace, p.reason, count(*) AS pods
FROM pod_issues p
JOIN clusters c ON c.name = p.cluster_name
WHERE c.hub_name = {{hub}}
GROUP BY 1, 2
ORDER BY 3 DESC`,
  chart: { type: "table" },
  h: 3,
};

const emptyState = () => ({
  dashboard: { id: "generated", title: "", description: "", variables: [], panels: [] },
  params: {},
});

// What add_panel answers with: the shape of the result, never the rows.
const panelResult = (panel, columns, rowCount) => ({
  id: panel.id,
  columns,
  column_types: columns.map(() => "VARCHAR"),
  row_count: rowCount,
  sample_rows: [],
});

// --------------------------------------------------------------------------- //
// event helpers
// --------------------------------------------------------------------------- //
// Each of these is one message in the thread as well as a burst of events, so
// the run collects what it emitted and hands it back in MESSAGES_SNAPSHOT.
async function* narrate(messageId, text, sink) {
  yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant" };
  for (const delta of chunks(text)) {
    await sleep(STEP);
    yield { type: "TEXT_MESSAGE_CONTENT", messageId, delta };
  }
  yield { type: "TEXT_MESSAGE_END", messageId };
  sink.push({ id: messageId, role: "assistant", content: text });
}

async function* callTool(messageId, toolCallId, name, args, sink) {
  const encoded = JSON.stringify(args);
  yield { type: "TOOL_CALL_START", toolCallId, toolCallName: name, parentMessageId: messageId };
  for (const delta of slices(encoded)) {
    await sleep(STEP);
    yield { type: "TOOL_CALL_ARGS", toolCallId, delta };
  }
  yield { type: "TOOL_CALL_END", toolCallId };
  sink.push({
    id: messageId,
    role: "assistant",
    toolCalls: [{ id: toolCallId, type: "function", function: { name, arguments: encoded } }],
  });
}

function toolResult(messageId, toolCallId, content, sink) {
  const encoded = JSON.stringify(content);
  sink.push({ id: messageId, role: "tool", toolCallId, content: encoded });
  return { type: "TOOL_CALL_RESULT", messageId, toolCallId, content: encoded, role: "tool" };
}

// --------------------------------------------------------------------------- //
// the runs
// --------------------------------------------------------------------------- //
// The first question builds the dashboard; anything after it edits what is
// already there, which is the behaviour the ADR asks the experiment to prove.
async function* build(input, emitted) {
  const { threadId, runId } = input;
  const started = Date.now();
  const id = (suffix) => `fix_${runId}_${suffix}`;

  yield { type: "RUN_STARTED", threadId, runId };
  yield { type: "STATE_SNAPSHOT", snapshot: emptyState() };

  yield { type: "STEP_STARTED", stepName: "turn-1" };
  yield* narrate(id("m1"), "I will build this from the hub down: a variable for the hub, "
    + "the clusters it manages, how their health has moved, and what is failing on them.", emitted);

  await sleep(BEAT);
  yield* callTool(id("m2"), id("t1"), "set_dashboard", {
    title: "Hub health - {{hub}}",
    description: "What one hub manages, how healthy it is, and what is failing.",
  }, emitted);
  yield {
    type: "STATE_DELTA",
    delta: [
      { op: "replace", path: "/dashboard/title", value: "Hub health - {{hub}}" },
      {
        op: "replace",
        path: "/dashboard/description",
        value: "What one hub manages, how healthy it is, and what is failing.",
      },
    ],
  };
  yield toolResult(id("r1"), id("t1"), { ok: true }, emitted);

  await sleep(BEAT);
  yield* callTool(id("m3"), id("t2"), "add_variable", HUB_VARIABLE, emitted);
  yield {
    type: "STATE_DELTA",
    delta: [
      { op: "add", path: "/dashboard/variables/-", value: HUB_VARIABLE },
      { op: "add", path: "/params/hub", value: "hub-east" },
    ],
  };
  yield toolResult(id("r2"), id("t2"), { name: "hub", options: 2 }, emitted);
  yield { type: "STEP_FINISHED", stepName: "turn-1" };

  yield { type: "STEP_STARTED", stepName: "turn-2" };
  await sleep(BEAT);
  yield* callTool(id("m4"), id("t3"), "add_panel", CLUSTERS_PANEL, emitted);
  yield { type: "STATE_DELTA", delta: [{ op: "add", path: "/dashboard/panels/-", value: CLUSTERS_PANEL }] };
  yield toolResult(id("r3"), id("t3"), panelResult(
    CLUSTERS_PANEL,
    ["name", "overall_status", "ocp_version", "nodes_ready", "nodes_total", "health_score"], 4,
  ), emitted);

  await sleep(BEAT);
  yield* callTool(id("m5"), id("t4"), "add_panel", HEALTH_PANEL, emitted);
  yield { type: "STATE_DELTA", delta: [{ op: "add", path: "/dashboard/panels/-", value: HEALTH_PANEL }] };
  yield toolResult(id("r4"), id("t4"), panelResult(
    HEALTH_PANEL, ["hour", "cluster", "health_score"], 24,
  ), emitted);
  yield { type: "STEP_FINISHED", stepName: "turn-2" };

  // The panel that does not run. No STATE_DELTA follows it: a refused mutation
  // leaves the dashboard exactly as it was, which is the safety property.
  yield { type: "STEP_STARTED", stepName: "turn-3" };
  await sleep(BEAT);
  yield* callTool(id("m6"), id("t5"), "add_panel", BAD_PANEL, emitted);
  yield toolResult(id("r5"), id("t5"), { error: BAD_ERROR, sql: BAD_PANEL.sql }, emitted);
  yield { type: "STEP_FINISHED", stepName: "turn-3" };

  yield { type: "STEP_STARTED", stepName: "turn-4" };
  await sleep(BEAT);
  yield* narrate(id("m7"), "There is no pods table in this snapshot - pod_issues is the one "
    + "that carries them, so I will group those by reason instead.", emitted);

  await sleep(BEAT);
  yield* callTool(id("m8"), id("t6"), "add_panel", ISSUES_PANEL, emitted);
  yield { type: "STATE_DELTA", delta: [{ op: "add", path: "/dashboard/panels/-", value: ISSUES_PANEL }] };
  yield toolResult(id("r6"), id("t6"), panelResult(ISSUES_PANEL, ["reason", "pods"], 5), emitted);

  await sleep(BEAT);
  yield* narrate(id("m9"), "Three panels, all on the hub you pick at the top. Ask for another "
    + "cut - by namespace, by team, or a different chart - and I will edit this dashboard "
    + "rather than start again.", emitted);
  yield { type: "STEP_FINISHED", stepName: "turn-4" };

  yield { type: "MESSAGES_SNAPSHOT", messages: [...(input.messages || []), ...emitted] };
  yield {
    type: "RUN_FINISHED",
    threadId,
    runId,
    result: {
      turns: 4,
      tool_calls: 6,
      panels: 3,
      elapsed_ms: Date.now() - started,
      usage: { input_tokens: 9120, output_tokens: 1480 },
    },
  };
}

async function* refine(input, emitted) {
  const { threadId, runId } = input;
  const started = Date.now();
  const id = (suffix) => `fix_${runId}_${suffix}`;

  // The follow-up edits the state the client is holding, so it has to find the
  // panel in that state rather than assume where the build left it.
  const panels = input.state?.dashboard?.panels || [];
  const at = Math.max(0, panels.findIndex((p) => p.id === ISSUES_PANEL.id));
  const target = panels.length ? at : 0;

  yield { type: "RUN_STARTED", threadId, runId };
  yield { type: "STATE_SNAPSHOT", snapshot: input.state || emptyState() };

  yield { type: "STEP_STARTED", stepName: "turn-1" };
  yield* narrate(id("m1"), "Same panel, one level down: namespace and reason, as a table so "
    + "the long tail is readable.", emitted);

  await sleep(BEAT);
  yield* callTool(id("m2"), id("t1"), "update_panel", BY_NAMESPACE_PANEL, emitted);
  yield {
    type: "STATE_DELTA",
    delta: [{ op: "replace", path: `/dashboard/panels/${target}`, value: BY_NAMESPACE_PANEL }],
  };
  yield toolResult(id("r1"), id("t1"), panelResult(
    BY_NAMESPACE_PANEL, ["namespace", "reason", "pods"], 6,
  ), emitted);
  yield { type: "STEP_FINISHED", stepName: "turn-1" };

  yield { type: "MESSAGES_SNAPSHOT", messages: [...(input.messages || []), ...emitted] };
  yield {
    type: "RUN_FINISHED",
    threadId,
    runId,
    result: {
      turns: 1,
      tool_calls: 1,
      panels: Math.max(1, panels.length),
      elapsed_ms: Date.now() - started,
      usage: { input_tokens: 11430, output_tokens: 320 },
    },
  };
}

// fixtureRun(input) -> the events of one run, as they would arrive on the wire.
// A signal that aborts ends the generator, the way a closed stream would.
export async function* fixtureRun(input, signal) {
  const emitted = [];
  const asked = (input.messages || []).filter((m) => m.role === "user").length;
  const script = asked > 1 ? refine : build;
  try {
    for await (const event of script(input, emitted)) {
      if (signal?.aborted) return;
      yield event;
    }
  } catch (e) {
    yield { type: "RUN_ERROR", message: String(e?.message || e), code: "fixture_failed" };
  }
}
