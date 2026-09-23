import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import Generate from "./Generate";
import * as cache from "../cache";
import { answer, fails, notFound } from "../test/apiMock";
import type { ApiMock } from "../test/apiMock";
import type { UserEvent } from "@testing-library/user-event";
import type { AgentEvent } from "../agent/client";
import { currentUrl, renderView } from "../test/harness";

vi.mock("../api", async () => {
  const { createApiMock } = await import("../test/apiMock");
  return { api: createApiMock(), BASE: "" };
});

// The stream is scripted; the panels underneath are run through the real
// runtime against a mocked query plane.
vi.mock("../agent/client", async (importOriginal) => ({
  ...(await importOriginal()),
  runAgent: vi.fn(),
}));

// why: `vi.mock` above replaced the module, so what this hands back is the
// table-backed stand-in rather than the real client.
const { api } = await import("../api") as unknown as { api: ApiMock };
// why: the stream is scripted per test, so what this hands back is the spy
// `vi.mock` put in the module's place rather than the real stream client.
const { runAgent } = await import("../agent/client") as unknown as { runAgent: Mock };

const PANEL = {
  id: "clusters-on-hub",
  title: "Clusters on {{hub}}",
  description: "Every cluster this hub manages.",
  sql: "SELECT name, overall_status FROM clusters WHERE hub_name = {{hub}}",
  chart: { type: "table" },
  w: 6,
  h: 2,
};

const HUB_VARIABLE = {
  name: "hub", label: "Hub", type: "select", required: true, default: "hub-east",
  sql: "SELECT DISTINCT hub_name AS value FROM clusters ORDER BY 1",
};

const RESULTS = {
  "var:hub": { columns: ["value"], column_types: ["VARCHAR"],
    rows: [["hub-east"], ["hub-west"]], row_count: 2 },
  "clusters-on-hub": {
    columns: ["name", "overall_status"], column_types: ["VARCHAR", "VARCHAR"],
    rows: [["ocp-prod-iad-01", "healthy"], ["ocp-prod-iad-02", "warning"]],
    row_count: 2, elapsed_ms: 5,
  },
};

// One scripted run: a sentence, a variable, a panel, and what it cost.
const FULL_RUN = [
  { type: "STATE_SNAPSHOT", snapshot: { dashboard: { id: "generated", title: "", description: "",
    variables: [], panels: [] }, params: { hub: "hub-east" } } },
  { type: "TEXT_MESSAGE_START", messageId: "m1" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Starting with the clusters." },
  { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "add_variable" },
  { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '{"name":"hub"}' },
  { type: "TOOL_CALL_END", toolCallId: "tc1" },
  { type: "STATE_DELTA", delta: [
    { op: "add", path: "/dashboard/variables/-", value: HUB_VARIABLE },
    { op: "replace", path: "/dashboard/title", value: "Hub review" },
  ] },
  { type: "TOOL_CALL_RESULT", toolCallId: "tc1", content: JSON.stringify({ ok: true }) },
  { type: "TOOL_CALL_START", toolCallId: "tc2", toolCallName: "add_panel" },
  { type: "TOOL_CALL_ARGS", toolCallId: "tc2", delta: '{"title":"Clusters on {{hub}}"}' },
  { type: "TOOL_CALL_END", toolCallId: "tc2" },
  { type: "STATE_DELTA", delta: [{ op: "add", path: "/dashboard/panels/-", value: PANEL }] },
  { type: "TOOL_CALL_RESULT", toolCallId: "tc2",
    content: JSON.stringify({ row_count: 2, columns: ["name", "overall_status"] }) },
  { type: "RUN_FINISHED", result: { turns: 2, tool_calls: 2, elapsed_ms: 18400 } },
];

function script(events: AgentEvent[], { hang = false } = {}) {
  runAgent.mockImplementation(async ({ onEvent, signal }) => {
    for (const event of events) {
      if (signal?.aborted) return;
      onEvent(event);
    }
    if (hang) await new Promise((resolve) => { signal?.addEventListener("abort", resolve); });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cache.invalidate();
  runAgent.mockReset();
  answer(api, {
    agent: { available: true, model: "claude-opus-5" },
    queryBatch: { results: RESULTS, generation: 11 },
    saveDashboard: { ok: true },
  });
});

// App unmounts a view when the route leaves it, and this page has an effect
// that reads ?q= - so the harness stops rendering it off /generate too.
const open = (at = "/generate") => renderView(
  ({ route, nav }) => (route.path === "/generate"
    ? <Generate route={route} nav={nav} /> : null), { at });

describe("before anything is asked", () => {
  it("says what the page does and offers questions to start from", async () => {
    open();
    expect(await screen.findByRole("button",
      { name: /What are the apps, namespaces and clusters under hub-east/ })).toBeInTheDocument();
    expect(screen.getByText(/The dashboard appears here, one panel at a time/))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as dashboard…" })).toBeDisabled();
  });

  it("names the model the endpoint reported", async () => {
    open();
    expect(await screen.findByText("claude-opus-5")).toBeInTheDocument();
  });
});

describe("a run", () => {
  it("shows what was said, what was done and what it cost", async () => {
    const user = userEvent.setup();
    script(FULL_RUN);
    open();
    await screen.findByRole("button", { name: "Ask" });
    await user.type(screen.getByLabelText("Ask for a dashboard"), "Review hub-east");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText("Review hub-east")).toBeInTheDocument();
    expect(screen.getByText("Starting with the clusters.")).toBeInTheDocument();
    expect(screen.getByText('Adding variable "hub"')).toBeInTheDocument();
    expect(screen.getByText('Adding panel "Clusters on {{hub}}"')).toBeInTheDocument();
    expect(screen.getByText(/2 rows · name, overall_status/)).toBeInTheDocument();
    expect(screen.getByText("2 turns · 2 tool calls · 18.4 s")).toBeInTheDocument();
  });

  it("runs the panel the agent wrote, against the query plane, as it lands", async () => {
    const user = userEvent.setup();
    script(FULL_RUN);
    open();
    await user.click(await screen.findByRole("button", { name: /Review production/ }));
    expect(await screen.findByRole("region", { name: "Clusters on hub-east" }))
      .toBeInTheDocument();
    expect(await screen.findByText("ocp-prod-iad-01")).toBeInTheDocument();
  });

  it("offers the variable the agent declared, with the options its query returned", async () => {
    const user = userEvent.setup();
    script(FULL_RUN);
    open();
    await user.click(await screen.findByRole("button", { name: /Review production/ }));
    const select = await screen.findByRole<HTMLSelectElement>("combobox");
    await waitFor(() => expect([...select.options].map((o) => o.value))
      .toEqual(["", "hub-east", "hub-west"]));
  });

  it("lets the person retitle what the agent wrote", async () => {
    const user = userEvent.setup();
    script(FULL_RUN);
    open();
    await user.click(await screen.findByRole("button", { name: /Review production/ }));
    const title = await screen.findByLabelText("Dashboard title");
    expect(title).toHaveValue("Hub review");
    await user.type(title, " 2026");
    expect(title).toHaveValue("Hub review 2026");
  });

  it("shows a placeholder card for a panel that is still being written", async () => {
    const user = userEvent.setup();
    script(FULL_RUN.slice(0, 11), { hang: true });      // stops mid add_panel
    open();
    await user.click(await screen.findByRole("button", { name: /Review production/ }));
    expect(await screen.findByRole("region", { name: "Writing Clusters on {{hub}}" }))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
  });

  it("offers Stop while it runs and Start over once it has", async () => {
    const user = userEvent.setup();
    script(FULL_RUN, { hang: true });
    open();
    await user.click(await screen.findByRole("button", { name: /Review production/ }));
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Stopped.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect(await screen.findByText(/The dashboard appears here/)).toBeInTheDocument();
  });

  it("says why the panels could not be run when the query plane is the thing that failed",
    async () => {
      const user = userEvent.setup();
      script(FULL_RUN);
      answer(api, { queryBatch: fails("503 Service Unavailable"),
        runSql: fails("503 Service Unavailable") });
      open();
      await user.click(await screen.findByRole("button", { name: /Review production/ }));
      expect(await screen.findByText("The panels could not be run.")).toBeInTheDocument();
    });
});

describe("saving what was generated", () => {
  const generate = async (user: UserEvent) => {
    script(FULL_RUN);
    open();
    await user.click(await screen.findByRole("button", { name: /Review production/ }));
    await screen.findByRole("region", { name: "Clusters on hub-east" });
  };

  it("writes it as an ordinary dashboard and opens it there", async () => {
    const user = userEvent.setup();
    await generate(user);
    await user.click(screen.getByRole("button", { name: "Save as dashboard…" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as a dashboard" });
    expect(within(dialog).getByRole("textbox")).toHaveValue("hub-review");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.saveDashboard).toHaveBeenCalled());
    const [id, body] = api.saveDashboard.mock.calls[0];
    expect(id).toBe("hub-review");
    expect(body.panels).toHaveLength(1);
    expect(body.variables[0].name).toBe("hub");
    // The variables go with it, so the dashboard opens on the hub on screen.
    expect(currentUrl()).toBe("/dashboards/hub-review?hub=hub-east");
  });

  it("shows the API's refusal in the dialog rather than losing the work", async () => {
    const user = userEvent.setup();
    await generate(user);
    answer(api, { saveDashboard: fails("a dashboard with that id already exists") });
    await user.click(screen.getByRole("button", { name: "Save as dashboard…" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as a dashboard" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("a dashboard with that id already exists"))
      .toBeInTheDocument();
  });

  it("hands a generated panel to the Query page", async () => {
    const user = userEvent.setup();
    await generate(user);
    const panel = screen.getByRole("region", { name: "Clusters on hub-east" });
    await user.click(within(panel).getByRole("button", { name: "⋯" }));
    await user.click(screen.getByRole("menuitem", { name: "Open in Query" }));
    expect(currentUrl()).toMatch(/^\/query\?q=/);
  });
});

describe("a question arriving from the Query page", () => {
  it("runs it once and leaves the URL, so Back does not ask it again", async () => {
    script(FULL_RUN);
    open("/generate?q=Which+namespaces+have+the+most+pod+issues%3F");
    await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    expect(runAgent.mock.calls[0][0].messages.at(-1).content)
      .toBe("Which namespaces have the most pod issues?");
    expect(currentUrl()).toBe("/generate");
  });

  it("leaves the question in the box when the endpoint cannot run it", async () => {
    answer(api, { agent: notFound() });
    open("/generate?q=Review+production");
    expect(await screen.findByDisplayValue("Review production")).toBeInTheDocument();
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe("when generation is not available", () => {
  it("says the build has no such endpoint on a 404, and offers the sample run", async () => {
    const user = userEvent.setup();
    answer(api, { agent: notFound() });
    open();
    expect(await screen.findByText("This data layer build has no generation endpoint"))
      .toBeInTheDocument();
    expect(screen.getByText(/GET \/api\/agent answered 404/)).toBeInTheDocument();
    expect(screen.getByLabelText("Ask for a dashboard")).toBeDisabled();
    await user.click(screen.getByText("Play the sample generation"));
    expect(currentUrl()).toBe("/generate?fixture=1");
  });

  it("says generation is switched off, in the API's own words", async () => {
    answer(api, { agent: { available: false, reason: "no model credentials are configured" } });
    open();
    expect(await screen.findByText("Dashboard generation is switched off")).toBeInTheDocument();
    expect(screen.getByText("no model credentials are configured")).toBeInTheDocument();
  });

  it("says the endpoint could not be reached at all", async () => {
    answer(api, { agent: fails("Failed to fetch") });
    open();
    expect(await screen.findByText("The generation endpoint could not be reached"))
      .toBeInTheDocument();
  });

  it("asks nothing of the API at all in fixture mode", async () => {
    script(FULL_RUN);
    open("/generate?fixture=1");
    expect(await screen.findByText("fixture")).toHaveClass("db-tag");
    expect(api.agent).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Ask for a dashboard")).toBeEnabled();
  });
});
