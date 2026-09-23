import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ChartControls, { chartNoneText } from "./ChartControls";
import { inferFields, normalizeChart, resolveSpec } from "./Chart";
import type { ChartChoice, Row } from "./Chart";

/** A result as these tests write one, in the wire shape /api/query/sql
 * answers with. */
interface Result {
  columns: string[];
  types: string[];
  rows: Row[];
}

const HOURS = ["2026-09-20T18:00:00+00:00", "2026-09-20T19:00:00+00:00"];

const TREND = {
  columns: ["hour", "cluster", "health_score", "cpu_percent"],
  types: ["TIMESTAMP", "VARCHAR", "INTEGER", "DOUBLE"],
  rows: [
    [HOURS[0], "ocp-prod-iad-01", 97, 41], [HOURS[1], "ocp-prod-iad-01", 96, 55],
    [HOURS[0], "ocp-prod-iad-02", 91, 30], [HOURS[1], "ocp-prod-iad-02", 84, 33],
  ],
};

const BY_STATUS = {
  columns: ["overall_status", "clusters"],
  types: ["VARCHAR", "BIGINT"],
  rows: [["healthy", 2], ["warning", 1], ["critical", 1]],
};

// A test names only the fields its case is about; the app always hands the
// controls a whole choice (the Query page's state is normalised on the way in),
// so the same normaliser fills in the rest here.
function setup(source: Result, chart: Partial<ChartChoice>) {
  const choice = normalizeChart(chart);
  const fields = inferFields(source.columns, source.types, source.rows);
  const spec = resolveSpec(fields, source.rows, choice);
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<ChartControls fields={fields} spec={spec} chart={choice} onChange={onChange} />);
  return { onChange, user, spec };
}

describe("the type picker", () => {
  // A MUI `Select` is a button that opens a listbox, not a native <select> -
  // its options exist only once it is open, and there is no `.options` to read
  // off the closed control. Every picker in this file is opened the same way.
  it("offers every chart type this build can draw", async () => {
    const { user } = setup(BY_STATUS, { type: "auto" });
    await user.click(screen.getByLabelText("Chart"));
    expect(screen.getAllByRole("option").map((o) => o.textContent))
      .toEqual(["Auto", "Line", "Bars", "Table only"]);
  });

  it("starts the picks over when the type changes, which is also the way back to auto", async () => {
    const { onChange, user } = setup(TREND, { type: "line", x: "hour", series: "cluster" });
    await user.click(screen.getByLabelText("Chart"));
    await user.click(screen.getByRole("option", { name: "Bars" }));
    expect(onChange).toHaveBeenCalledWith({ type: "bars", x: "", series: null, y: [],
      stack: false });
  });

  it("offers nothing but the type when the result cannot be drawn", () => {
    setup({ columns: ["name"], types: ["VARCHAR"], rows: [["a"], ["b"]] }, { type: "auto" });
    expect(screen.getByLabelText("Chart")).toBeInTheDocument();
    expect(screen.queryByText("Category")).toBeNull();
    expect(screen.queryByText("Measures")).toBeNull();
  });
});

describe("the axis and series pickers", () => {
  // `getByText("Category")` would find it twice - MUI's outlined variant
  // repeats a select's label into the notch cut into its border - so presence
  // is asked of the label the way an assistive technology would, through the
  // control it names.
  it("offers only time columns for a line's x axis, and a series list beside it", async () => {
    const { user } = setup(TREND, { type: "line" });
    // Checked before the menu opens: an open listbox picks up the trigger's
    // own label too, so the label is unambiguous only while it is closed.
    expect(screen.getByLabelText("Time")).toBeInTheDocument();
    expect(screen.getByLabelText("Series")).toBeInTheDocument();
    await user.click(screen.getAllByRole("combobox")[1]);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["hour"]);
  });

  it("offers categories and times for a bar chart's x axis, and no series at all", () => {
    setup(BY_STATUS, { type: "bars" });
    expect(screen.getByLabelText("Category")).toBeInTheDocument();
    expect(screen.queryByLabelText("Series")).toBeNull();
  });

  it("names how many values each series column has, so a bad pick is visible first", async () => {
    const { user } = setup(TREND, { type: "line" });
    await user.click(screen.getAllByRole("combobox")[2]);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["none", "cluster (2)"]);
  });

  it("drops back to one measure when a series is chosen", async () => {
    const { onChange, user } = setup(TREND, { type: "line", series: "", y: ["health_score", "cpu_percent"] });
    await user.click(screen.getAllByRole("combobox")[2]);
    await user.click(screen.getByRole("option", { name: "cluster (2)" }));
    expect(onChange.mock.calls[0][0]).toMatchObject({ series: "cluster", y: ["health_score"] });
  });

  it("reports a change of x axis without touching the rest of the choice", async () => {
    // Two category columns, so there is a genuinely different one to switch
    // to - MUI's Select, unlike userEvent's synthetic dispatch on a native
    // <select>, does not report a click on the option already selected.
    const r = { columns: ["overall_status", "hub", "clusters"],
      types: ["VARCHAR", "VARCHAR", "BIGINT"],
      rows: [["healthy", "hub-east", 2], ["warning", "hub-west", 1], ["critical", "hub-east", 1]] };
    const { onChange, user } = setup(r, { type: "bars" });
    await user.click(screen.getAllByRole("combobox")[1]);
    await user.click(screen.getByRole("option", { name: "hub" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ x: "hub" }));
  });
});

describe("the measure toggles", () => {
  it("marks the measures that are drawn and offers the ones that are not", () => {
    setup(TREND, { type: "line", series: "" });
    expect(screen.getByRole("button", { name: "health_score" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "cpu_percent" }))
      .toHaveAttribute("aria-pressed", "false");
  });

  it("adds a measure to the ones already drawn", async () => {
    const { onChange, user } = setup(TREND, { type: "line", series: "", y: ["health_score"] });
    await user.click(screen.getByRole("button", { name: "cpu_percent" }));
    expect(onChange.mock.calls[0][0].y).toEqual(["health_score", "cpu_percent"]);
  });

  it("removes a measure, but never the last one", async () => {
    const { onChange, user } = setup(TREND,
      { type: "line", series: "", y: ["health_score", "cpu_percent"] });
    await user.click(screen.getByRole("button", { name: "cpu_percent" }));
    expect(onChange.mock.calls[0][0].y).toEqual(["health_score"]);

    const single = setup(BY_STATUS, { type: "bars", y: ["clusters"] });
    await single.user.click(screen.getAllByRole("button", { name: "clusters" })[0]);
    expect(single.onChange).not.toHaveBeenCalled();
  });

  it("swaps the measure rather than adding one once a series owns the colours", async () => {
    const { onChange, user } = setup(TREND,
      { type: "line", series: "cluster", y: ["health_score"] });
    await user.click(screen.getByRole("button", { name: "cpu_percent" }));
    expect(onChange.mock.calls[0][0].y).toEqual(["cpu_percent"]);
  });

  it("never offers the x axis as a measure", () => {
    const counts = { columns: ["hour", "pods"], types: ["TIMESTAMP", "BIGINT"],
      rows: [[HOURS[0], 4], [HOURS[1], 5]] };
    setup(counts, { type: "line" });
    expect(screen.queryByRole("button", { name: "hour" })).toBeNull();
  });
});

describe("stacking", () => {
  it("is offered for a line and reports the change", async () => {
    const { onChange, user } = setup(TREND, { type: "line", series: "cluster" });
    const stack = screen.getByRole("checkbox");
    expect(stack).not.toBeChecked();
    await user.click(stack);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ stack: true }));
  });

  it("is not offered for bars, which have nothing to stack into", () => {
    setup(BY_STATUS, { type: "bars" });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("chartNoneText", () => {
  it("says nothing at all when the panel asked for a table", () => {
    expect(chartNoneText({ type: "none" })).toBe("");
  });

  it("says what the result is missing for the chart that was asked for", () => {
    expect(chartNoneText({ type: "auto" }))
      .toBe("No chart for this result - it has no time axis and no single category to group by.");
    expect(chartNoneText({ type: "line" }))
      .toBe("A line needs a time column and a number; this result has neither.");
    expect(chartNoneText({ type: "bars" }))
      .toBe("A bar chart needs a category and a number; this result has neither.");
  });
});
