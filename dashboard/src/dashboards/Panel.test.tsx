import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Panel from "./Panel";
import type { PanelProps } from "./Panel";
import { normalizeDefinition } from "./model";
import { renderThemed } from "../test/harness";

const DEFINITION = normalizeDefinition({
  id: "hub-review",
  title: "Hub review",
  variables: [{ name: "hub", label: "Hub", type: "select", sql: "SELECT 1" }],
  panels: [{ id: "status", title: "Clusters on {{hub}}", sql: "SELECT 1" }],
});

const PANEL = DEFINITION.panels[0];

const TABLE_RESULT = {
  columns: ["name", "overall_status"],
  column_types: ["VARCHAR", "VARCHAR"],
  rows: [["ocp-prod-iad-01", "healthy"], ["ocp-prod-iad-02", "warning"]],
  row_count: 2,
  elapsed_ms: 4,
};

const CHART_RESULT = {
  columns: ["overall_status", "clusters"],
  column_types: ["VARCHAR", "BIGINT"],
  rows: [["healthy", 2], ["warning", 1], ["critical", 1]],
  row_count: 3,
  elapsed_ms: 6,
};

// The four callbacks the grid always hands a panel. A test that cares about
// one passes its own over the top.
const handlers = () => ({
  onOpenQuery: vi.fn(), onEdit: vi.fn(), onRemove: vi.fn(), onMove: vi.fn(),
});

const draw = (props: Partial<PanelProps> = {}) => renderThemed(
  <Panel panel={PANEL} definition={DEFINITION} params={{ hub: "hub-east" }}
    {...handlers()} {...props} />);

describe("the header", () => {
  it("fills the panel's title in from the variables that ran", () => {
    draw({ result: TABLE_RESULT });
    expect(screen.getByRole("region", { name: "Clusters on hub-east" })).toBeInTheDocument();
  });

  it("says how many rows came back and what they cost", () => {
    draw({ result: TABLE_RESULT });
    expect(screen.getByText(/2 rows · 4 ms/)).toBeInTheDocument();
  });

  it("says row rather than rows for one, and flags a truncated answer", () => {
    draw({ result: { ...TABLE_RESULT, rows: [TABLE_RESULT.rows[0]], row_count: 1,
      truncated: true } });
    expect(screen.getByText(/1 row · 4 ms · truncated/)).toBeInTheDocument();
  });

  it("carries the panel's description as a tooltip rather than as more text", () => {
    const described = { ...PANEL, description: "Overall status of every cluster on this hub." };
    renderThemed(<Panel panel={described} definition={DEFINITION} params={{ hub: "hub-east" }}
      result={TABLE_RESULT} {...handlers()} />);
    expect(screen.getByLabelText("Overall status of every cluster on this hub."))
      .toBeInTheDocument();
  });

  it("offers Open in Query always, and Edit and Remove only while editing", async () => {
    const user = userEvent.setup();
    const onOpenQuery = vi.fn();
    const { rerender } = draw({ result: TABLE_RESULT, onOpenQuery });
    await user.click(screen.getByRole("button", { name: "⋯" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open in Query"]);
    await user.click(screen.getByRole("menuitem", { name: "Open in Query" }));
    expect(onOpenQuery).toHaveBeenCalled();

    rerender(<Panel panel={PANEL} definition={DEFINITION} params={{ hub: "hub-east" }}
      result={TABLE_RESULT} editing {...handlers()} />);
    await user.click(screen.getByRole("button", { name: "⋯" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent))
      .toEqual(["Open in Query", "Edit", "Remove"]);
  });

  it("offers the move buttons while editing, with the ends disabled", async () => {
    const onMove = vi.fn();
    const user = userEvent.setup();
    draw({ result: TABLE_RESULT, editing: true, first: true, onMove });
    expect(screen.getByRole("button", { name: "Move Clusters on hub-east up" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move Clusters on hub-east down" }));
    expect(onMove).toHaveBeenCalledWith(1);
  });

  it("says the panel is being rewritten rather than passing the old rows off as new", () => {
    const { container } = draw({ result: TABLE_RESULT, busy: true });
    expect(container.querySelector("section")).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector("section")).toHaveAttribute("aria-busy", "true");
  });
});

describe("the body", () => {
  it("draws the rows as a table when the result cannot be charted", () => {
    draw({ result: TABLE_RESULT });
    expect(screen.getByRole("columnheader", { name: /name/ })).toBeInTheDocument();
    expect(screen.getByText("ocp-prod-iad-01")).toBeInTheDocument();
  });

  it("draws a chart when the columns can carry the one the panel asked for", () => {
    const charted = { ...PANEL, chart: { type: "bars" as const, x: "overall_status", series: "",
      y: ["clusters"], stack: false } };
    const { container } = renderThemed(<Panel panel={charted} definition={DEFINITION} params={{}}
      result={CHART_RESULT} {...handlers()} />);
    expect(container.querySelectorAll("rect.MuiBarChart-element")).toHaveLength(3);
    expect(container.querySelector("section")).toHaveAttribute("data-body", "chart");
    expect(screen.queryByRole("grid")).toBeNull();
  });

  it("turns a panel waiting on a variable into an instruction, in the variable's own words", () => {
    const { container } = draw({ result: { error: "variable hub is not set", sql: "SELECT 1" },
      params: {} });
    expect(container.querySelector("section")).toHaveTextContent("Choose a hub above.");
    expect(screen.queryByText(/variable hub is not set/)).toBeNull();
  });

  it("says an for a variable whose label starts with a vowel", () => {
    const definition = normalizeDefinition({ id: "d",
      variables: [{ name: "env", label: "Environment", type: "text" }],
      panels: [{ id: "p", title: "t", sql: "SELECT 1" }] });
    const { container } = renderThemed(<Panel panel={definition.panels[0]} definition={definition}
      params={{}} result={{ error: "variable env is not set", sql: "SELECT 1" }}
      {...handlers()} />);
    expect(container.querySelector("section"))
      .toHaveTextContent("Choose an environment above.");
  });

  it("falls back to the variable's name when the dashboard does not declare it", () => {
    const { container } = draw({ result: { error: "variable region is not set" }, params: {} });
    expect(container.querySelector("section")).toHaveTextContent("Choose a region above.");
  });

  it("shows a query error with the SQL that was actually sent", () => {
    draw({ result: { error: "unknown table 'pods'",
      sql: "SELECT * FROM pods WHERE hub_name = {{hub}}" } });
    expect(screen.getByText("unknown table 'pods'")).toBeInTheDocument();
    expect(screen.getByText(/WHERE hub_name = 'hub-east'/)).toBeInTheDocument();
  });

  it("stands in for rows that are still on the wire", () => {
    const { container } = draw({ result: undefined, loading: true });
    expect(container.querySelector("[data-placeholder]")).toBeInTheDocument();
  });

  it("says nothing ran rather than leaving the panel blank", () => {
    draw({ result: undefined, loading: false });
    expect(screen.getByText("Nothing ran for this panel.")).toBeInTheDocument();
  });

  it("gives a tall panel a filter row and a short one none", () => {
    const { rerender } = renderThemed(<Panel panel={{ ...PANEL, h: 3 }} definition={DEFINITION}
      params={{ hub: "hub-east" }} result={TABLE_RESULT} {...handlers()} />);
    expect(screen.getByLabelText("Filter by name")).toBeInTheDocument();
    rerender(<Panel panel={{ ...PANEL, h: 2 }} definition={DEFINITION}
      params={{ hub: "hub-east" }} result={TABLE_RESULT} {...handlers()} />);
    expect(screen.queryByLabelText("Filter by name")).toBeNull();
  });

  it("links a cluster in a panel's table through to the cluster page", async () => {
    const nav = { openCluster: vi.fn(), openApp: vi.fn() };
    const user = userEvent.setup();
    const result = { ...TABLE_RESULT, columns: ["cluster_name", "overall_status"] };
    renderThemed(<Panel panel={PANEL} definition={DEFINITION} params={{ hub: "hub-east" }}
      result={result} nav={nav} {...handlers()} />);
    await user.click(within(screen.getByRole("grid")).getByText("ocp-prod-iad-01"));
    expect(nav.openCluster).toHaveBeenCalledWith("ocp-prod-iad-01");
  });
});
