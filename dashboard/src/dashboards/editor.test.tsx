import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { PanelDrawer, VariablesDrawer } from "./editor";
import { normalizeDefinition, normalizePanel } from "./model";
import { renderThemed } from "../test/harness";

// The drawer previews a panel through the query runtime, which is the only
// thing here that is not pure.
vi.mock("./runtime", () => ({ runQueries: vi.fn() }));
// Replaced wholesale above, so this is the spy rather than the real runtime.
const { runQueries } = await import("./runtime") as unknown as { runQueries: Mock };

const DEFINITION = normalizeDefinition({
  id: "hub-review",
  title: "Hub review",
  variables: [{ name: "hub", label: "Hub", type: "select", sql: "SELECT 1" }],
});

const PANEL = normalizePanel({
  id: "status",
  title: "Clusters on {{hub}}",
  description: "Overall status of every cluster.",
  sql: "SELECT overall_status, count(*) AS clusters FROM clusters WHERE hub_name = {{hub}} GROUP BY 1",
  chart: { type: "bar" },
  w: 4,
  h: 2,
});

const PREVIEW = {
  columns: ["overall_status", "clusters"],
  column_types: ["VARCHAR", "BIGINT"],
  rows: [["healthy", 2], ["warning", 1], ["critical", 1]],
  row_count: 3,
  elapsed_ms: 6,
};

// A block body on purpose: an arrow that returns the mock would hand vitest
// the mock itself as a teardown function, and it would be called after the test.
beforeEach(() => { runQueries.mockReset(); });

function openPanel(props = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  renderThemed(<PanelDrawer panel={PANEL} definition={DEFINITION} params={{ hub: "hub-east" }}
    errors={[]} onApply={onApply} onClose={onClose} {...props} />);
  return { onApply, onClose, user };
}

describe("PanelDrawer", () => {
  it("opens on the panel it was given, naming it in the title", () => {
    openPanel();
    expect(screen.getByRole("dialog", { name: 'Edit "Clusters on {{hub}}"' })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Clusters on {{hub}}")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Overall status of every cluster.")).toBeInTheDocument();
  });

  it("is an add rather than an edit for a panel with no title yet", () => {
    openPanel({ panel: normalizePanel({ id: "p1", title: "", sql: "" }) });
    expect(screen.getByRole("dialog", { name: "Add a panel" })).toBeInTheDocument();
  });

  it("hands the edited copy back only when it has a title and a query", async () => {
    const { onApply, user } = openPanel();
    const title = screen.getByDisplayValue("Clusters on {{hub}}");
    await user.clear(title);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    await user.type(title, "Clusters by status");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      id: "status", title: "Clusters by status", w: 4, h: 2,
    }));
  });

  it("leaves the dashboard as it was when it is cancelled", async () => {
    const { onApply, onClose, user } = openPanel();
    await user.type(screen.getByDisplayValue("Clusters on {{hub}}"), " and version");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("says which placeholder the dashboard does not declare yet", async () => {
    const { user } = openPanel();
    // Typed through the clipboard: user-event reads braces as key descriptors.
    await user.click(screen.getByDisplayValue(/SELECT overall_status/));
    await user.paste(" AND region = {{region}}");
    expect(await screen.findByText("{{region}} is not a variable of this dashboard yet."))
      .toBeInTheDocument();
  });

  it("runs a preview and reports what came back", async () => {
    runQueries.mockResolvedValue({ results: { preview: PREVIEW } });
    const { user } = openPanel();
    await user.click(screen.getByRole("button", { name: "Run preview" }));
    expect(await screen.findByText(/3 rows · 2 columns · 6 ms/)).toBeInTheDocument();
    expect(runQueries).toHaveBeenCalledWith(
      [{ id: "preview", sql: PANEL.sql, limit: undefined }], { hub: "hub-east" });
  });

  it("offers the chart controls once there is a result to chart", async () => {
    runQueries.mockResolvedValue({ results: { preview: PREVIEW } });
    const { container, user } = { container: document.body, ...openPanel() };
    expect(screen.getByText("Run the preview to choose what the panel charts.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run preview" }));
    expect(await screen.findByLabelText("Chart")).toBeInTheDocument();
    expect(container.querySelectorAll("rect.MuiBarChart-element")).toHaveLength(3);
  });

  it("asks for the variable's value rather than sending a query with a placeholder in it", async () => {
    const { user } = openPanel({ params: {} });
    await user.click(screen.getByRole("button", { name: "Run preview" }));
    expect(await screen.findByText(/Choose a value for \{\{hub\}\}/)).toBeInTheDocument();
    expect(runQueries).not.toHaveBeenCalled();
  });

  it("shows the query plane's own refusal", async () => {
    runQueries.mockResolvedValue({ results: { preview: { error: "unknown table 'pods'" } } });
    const { user } = openPanel();
    await user.click(screen.getByRole("button", { name: "Run preview" }));
    expect(await screen.findByText("unknown table 'pods'")).toBeInTheDocument();
  });

  it("shows a run that failed outright", async () => {
    runQueries.mockImplementation(() => { throw new Error("503 Service Unavailable"); });
    const { user } = openPanel();
    await user.click(screen.getByRole("button", { name: "Run preview" }));
    expect(await screen.findByText("503 Service Unavailable")).toBeInTheDocument();
  });

  it("says a result is stale once the SQL under it has changed", async () => {
    const { user } = openPanel({ result: PREVIEW });
    expect(screen.getByRole("button", { name: "Run again" })).toBeInTheDocument();
    await user.type(screen.getByDisplayValue(/SELECT overall_status/), " ORDER BY 2");
    expect(await screen.findByText("The SQL changed - run the preview again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run preview" })).toBeInTheDocument();
  });

  it("opens on the panel's last error when that is what it was given", () => {
    openPanel({ result: { error: "unknown table 'pods'" } });
    expect(screen.getByText("unknown table 'pods'")).toBeInTheDocument();
  });

  it("puts the API's field errors on the fields they are about", () => {
    openPanel({ errors: [{ path: "sql", message: "only SELECT queries are allowed" },
      { path: "title", message: "a panel needs a title" }] });
    expect(screen.getByText("only SELECT queries are allowed")).toBeInTheDocument();
    expect(screen.getByText("a panel needs a title")).toBeInTheDocument();
  });

  it("nudges the panel's size within the grid's limits", async () => {
    const { onApply, user } = openPanel();
    await user.click(screen.getByRole("button", { name: "Increase Width" }));
    await user.click(screen.getByRole("button", { name: "Decrease Height" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ w: 5, h: 1 }));
  });

  it("takes a row limit, and treats an emptied one as the server's default", async () => {
    const { onApply, user } = openPanel();
    const limit = screen.getByRole("spinbutton");
    await user.type(limit, "50");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));

    await user.clear(limit);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ limit: null }));
  });

  it("does not run a preview for an empty query", () => {
    openPanel({ panel: normalizePanel({ id: "p", title: "t", sql: "" }) });
    // A disabled MUI button takes no pointer events at all, so there is nothing
    // to click: being disabled IS the behaviour, and nothing ran.
    expect(screen.getByRole("button", { name: "Run preview" })).toBeDisabled();
    expect(runQueries).not.toHaveBeenCalled();
  });
});

describe("VariablesDrawer", () => {
  const openVariables = (props = {}) => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderThemed(<VariablesDrawer definition={DEFINITION} errors={[]} onApply={onApply}
      onClose={onClose} {...props} />);
    return { onApply, onClose, user };
  };

  it("opens on the dashboard's variables as they are", () => {
    openVariables();
    expect(screen.getByDisplayValue("hub")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Hub")).toBeInTheDocument();
    expect(screen.getByDisplayValue("SELECT 1")).toBeInTheDocument();
  });

  it("adds a variable already named and typed so it is savable", async () => {
    const { onApply, user } = openVariables();
    await user.click(screen.getByRole("button", { name: "+ variable" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([
      expect.objectContaining({ name: "hub" }),
      expect.objectContaining({ name: "var2", type: "select" }),
    ]);
  });

  it("removes a variable", async () => {
    const { onApply, user } = openVariables();
    await user.click(screen.getByRole("button", { name: "Remove this variable" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([]);
  });

  it("drops the options query when the type stops being a select", async () => {
    const { onApply, user } = openVariables();
    await user.selectOptions(screen.getByRole("combobox"), "number");
    expect(screen.queryByDisplayValue("SELECT 1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([
      expect.objectContaining({ name: "hub", type: "number", sql: "", multi: false }),
    ]);
  });

  it("offers allow-several only for a select", async () => {
    const { user } = openVariables();
    expect(screen.getByLabelText("Allow several")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox"), "text");
    expect(screen.queryByLabelText("Allow several")).toBeNull();
  });

  it("takes a default and a required flag", async () => {
    const { onApply, user } = openVariables();
    await user.type(screen.getByLabelText("Default"), "hub-east");
    await user.click(screen.getByLabelText("Required"));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([
      expect.objectContaining({ default: "hub-east", required: true }),
    ]);
  });

  it("puts the API's field errors on the variable they are about", () => {
    openVariables({ errors: [
      { path: "variables.0.name", message: '"fixture" is reserved by the page itself.' },
      { path: "variables.0.sql", message: "A select variable needs a query for its options." },
    ] });
    expect(screen.getByText('"fixture" is reserved by the page itself.')).toBeInTheDocument();
    expect(screen.getByText("A select variable needs a query for its options."))
      .toBeInTheDocument();
  });

  it("leaves the dashboard as it was when it is cancelled", async () => {
    const { onApply, onClose, user } = openVariables();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });
});

// A last check that the drawer does not fight the grid behind it: nothing here
// re-queries while the SQL box is being typed into.
describe("previewing is explicit", () => {
  it("does not run anything until the button is pressed", async () => {
    const { user } = openPanel();
    await user.type(screen.getByDisplayValue(/SELECT overall_status/), " ORDER BY 2");
    await waitFor(() => expect(runQueries).not.toHaveBeenCalled());
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Run preview" }))
      .toBeEnabled();
  });
});
