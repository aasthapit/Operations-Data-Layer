import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Chart, {
  CHART_TYPES, categoryFields, emptyChart, inferFields, normalizeChart, resolveSpec,
} from "./Chart";
import type { Row, Spec } from "./Chart";

/** A result as these tests write one: the three things a chart is drawn from,
 * in the wire shape /api/query/sql answers with. */
interface Result {
  columns: string[];
  types: string[];
  rows: Row[];
}

/** The chart's own <svg>. The drawing is the subject here, so it is found by
 * tag rather than by role - and a chart that drew nothing is reported here
 * rather than at the first read of an attribute. */
function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("the chart drew no <svg>");
  return svg;
}

const HOURS = ["2026-09-20T18:00:00+00:00", "2026-09-20T19:00:00+00:00",
  "2026-09-20T20:00:00+00:00"];

// One result shape per test, in the wire shape /api/query/sql answers with.
const timeSeries = () => ({
  columns: ["hour", "cluster", "health_score"],
  types: ["TIMESTAMP", "VARCHAR", "DOUBLE"],
  rows: [
    [HOURS[0], "ocp-prod-iad-01", 97], [HOURS[0], "ocp-prod-iad-02", 91],
    [HOURS[1], "ocp-prod-iad-01", 96], [HOURS[1], "ocp-prod-iad-02", 84],
    [HOURS[2], "ocp-prod-iad-01", 95], [HOURS[2], "ocp-prod-iad-02", 74],
  ],
});

const byStatus = () => ({
  columns: ["overall_status", "clusters"],
  types: ["VARCHAR", "BIGINT"],
  rows: [["healthy", 2], ["warning", 1], ["critical", 1]],
});

const fieldsOf = (r: Result) => inferFields(r.columns, r.types, r.rows);

describe("inferFields", () => {
  it("reads the kind off the declared column type", () => {
    const fields = fieldsOf(timeSeries());
    expect(fields.map((f) => f.kind)).toEqual(["time", "cat", "number"]);
    expect(fields[1].distinct).toBe(2);
  });

  it("works the kind out of the values when the API declared no types", () => {
    const r = timeSeries();
    expect(inferFields(r.columns, null, r.rows).map((f) => f.kind))
      .toEqual(["time", "cat", "number"]);
  });

  it("lets the values overrule a VARCHAR that is really a column of timestamps", () => {
    const fields = inferFields(["at"], ["VARCHAR"], [[HOURS[0]], [HOURS[1]]]);
    expect(fields[0].kind).toBe("time");
  });

  it("recognises the DuckDB types the query plane actually returns", () => {
    const fields = inferFields(
      ["d", "ts", "b", "n", "dec", "j", "l", "s", "blob", "txt"],
      ["DATE", "TIMESTAMP WITH TIME ZONE", "BOOLEAN", "HUGEINT", "DECIMAL(18,3)", "JSON",
        "VARCHAR[]", "STRUCT(a INTEGER)", "BLOB", "VARCHAR"],
      []);
    expect(fields.map((f) => f.kind)).toEqual(
      ["time", "time", "cat", "number", "number", "other", "other", "other", "other", "cat"]);
  });

  it("calls a column of JSON objects other, and an all-null column a category", () => {
    const fields = inferFields(["labels", "nothing"], null,
      [[{ team: "payments" }, null], [{ team: "retail" }, null]]);
    expect(fields[0].kind).toBe("other");
    expect(fields[0].distinct).toBe(0);
    expect(fields[1].kind).toBe("cat");
  });

  it("calls a column of mixed text and numbers a category", () => {
    expect(inferFields(["v"], null, [["4.16.7"], [7]])[0].kind).toBe("cat");
  });

  it("flags the id-shaped columns that must not be charted as measures", () => {
    const fields = inferFields(["id", "cluster_uid", "generation", "health_score"], null, []);
    expect(fields.map((f) => f.idLike)).toEqual([true, true, true, false]);
  });

  it("counts distinct values, ignoring nulls and stringifying objects", () => {
    const fields = inferFields(["hub"], ["VARCHAR"],
      [["hub-east"], ["hub-east"], [null], ["hub-west"]]);
    expect(fields[0].distinct).toBe(2);
  });

  it("survives being handed no columns and no rows at all", () => {
    expect(inferFields(null, null, null)).toEqual([]);
  });

  it("categoryFields returns only the category columns", () => {
    expect(categoryFields(fieldsOf(timeSeries())).map((f) => f.name)).toEqual(["cluster"]);
  });
});

describe("normalizeChart", () => {
  it("falls back to auto for a type this build does not know", () => {
    expect(normalizeChart({ type: "sankey", y: "clusters" }))
      .toEqual({ type: "auto", x: "", series: null, y: [], stack: false });
  });

  it("keeps the four types the picker offers", () => {
    CHART_TYPES.forEach(([type]) => expect(normalizeChart({ type }).type).toBe(type));
  });

  it("tells let-the-chart-decide apart from explicitly no series", () => {
    expect(normalizeChart({}).series).toBeNull();
    expect(normalizeChart({ series: "" }).series).toBe("");
  });

  it("empties out to the same thing normalizeChart makes of nothing", () => {
    expect(emptyChart()).toEqual(normalizeChart(null));
  });
});

describe("resolveSpec: what the data can carry", () => {
  it("draws a time axis with a repeating category as one line per category", () => {
    const r = timeSeries();
    expect(resolveSpec(fieldsOf(r), r.rows, { type: "auto" })).toEqual({
      type: "line", x: "hour", series: "cluster", y: ["health_score"], stack: false,
    });
  });

  it("draws every measure as its own line when nothing separates the rows", () => {
    const r = {
      columns: ["hour", "health_score", "cpu_percent"],
      types: ["TIMESTAMP", "INTEGER", "DOUBLE"],
      rows: [[HOURS[0], 97, 41], [HOURS[1], 96, 55], [HOURS[2], 95, 62]],
    };
    const spec = resolveSpec(fieldsOf(r), r.rows, { type: "auto" });
    expect(spec).toMatchObject({ type: "line", x: "hour", series: "",
      y: ["health_score", "cpu_percent"] });
  });

  it("draws one category and one measure as bars", () => {
    const r = byStatus();
    expect(resolveSpec(fieldsOf(r), r.rows, { type: "auto" }))
      .toEqual({ type: "bars", x: "overall_status", series: "", y: ["clusters"], stack: false });
  });

  it("reads a list of things as bars by name, not as a history of one thing", () => {
    // `name` names a different cluster on every row, so its `last_synced` is an
    // attribute of each cluster rather than a time axis to plot along.
    const r = {
      columns: ["name", "last_synced", "health_score"],
      types: ["VARCHAR", "TIMESTAMP", "INTEGER"],
      rows: [["ocp-prod-iad-01", HOURS[0], 97], ["ocp-prod-iad-02", HOURS[1], 74]],
    };
    expect(resolveSpec(fieldsOf(r), r.rows, { type: "auto" }))
      .toMatchObject({ type: "bars", x: "name", y: ["health_score"] });
  });

  it("draws no chart with nothing to measure, with one row, or with one instant", () => {
    const text = { columns: ["name", "hub"], types: ["VARCHAR", "VARCHAR"],
      rows: [["a", "hub-east"], ["b", "hub-west"]] };
    expect(resolveSpec(fieldsOf(text), text.rows, { type: "auto" })).toBeNull();

    const single = byStatus();
    expect(resolveSpec(fieldsOf(single), single.rows.slice(0, 1), { type: "auto" })).toBeNull();

    const oneInstant = { columns: ["hour", "cluster", "health_score"],
      types: ["TIMESTAMP", "VARCHAR", "INTEGER"],
      rows: [[HOURS[0], "a", 90], [HOURS[0], "b", 80], [HOURS[0], "a", 70]] };
    expect(resolveSpec(fieldsOf(oneInstant), oneInstant.rows, { type: "auto" })).toBeNull();
  });

  it("never charts an id-shaped number as a measure", () => {
    const r = { columns: ["overall_status", "generation"], types: ["VARCHAR", "BIGINT"],
      rows: [["healthy", 11], ["warning", 11]] };
    expect(resolveSpec(fieldsOf(r), r.rows, { type: "auto" })).toBeNull();
  });

  it("answers nothing at all when the panel asks for a table", () => {
    const r = byStatus();
    expect(resolveSpec(fieldsOf(r), r.rows, { type: "none" })).toBeNull();
  });
});

describe("resolveSpec: what the user asked for", () => {
  it("forces bars over a result that would have auto-detected as a line", () => {
    const r = timeSeries();
    const spec = resolveSpec(fieldsOf(r), r.rows, { type: "bars" });
    expect(spec).toMatchObject({ type: "bars", x: "cluster", y: ["health_score"] });
  });

  it("refuses a line when the result has no time column", () => {
    const r = byStatus();
    expect(resolveSpec(fieldsOf(r), r.rows, { type: "line" })).toBeNull();
  });

  it("falls back to an id-shaped number when it is the only number there is", () => {
    const r = { columns: ["hub", "generation"], types: ["VARCHAR", "BIGINT"],
      rows: [["hub-east", 11], ["hub-west", 9]] };
    expect(resolveSpec(fieldsOf(r), r.rows, { type: "bars" })?.y).toEqual(["generation"]);
  });

  it("uses a time column as a bar category when there is no category column", () => {
    const r = { columns: ["hour", "clusters"], types: ["TIMESTAMP", "BIGINT"],
      rows: [[HOURS[0], 4], [HOURS[1], 5]] };
    expect(resolveSpec(fieldsOf(r), r.rows, { type: "bars" })?.x).toBe("hour");
  });

  it("honours the picked x, series and measures", () => {
    const r = {
      columns: ["hour", "cluster", "hub", "health_score", "cpu_percent"],
      types: ["TIMESTAMP", "VARCHAR", "VARCHAR", "INTEGER", "DOUBLE"],
      rows: [
        [HOURS[0], "ocp-prod-iad-01", "hub-east", 97, 41],
        [HOURS[1], "ocp-prod-iad-01", "hub-east", 96, 55],
        [HOURS[0], "ocp-prod-sjc-01", "hub-west", 91, 30],
        [HOURS[1], "ocp-prod-sjc-01", "hub-west", 84, 33],
      ],
    };
    const spec = resolveSpec(fieldsOf(r), r.rows,
      { type: "line", x: "hour", series: "hub", y: ["cpu_percent"], stack: true });
    expect(spec).toEqual({ type: "line", x: "hour", series: "hub", y: ["cpu_percent"],
      stack: true });
  });

  it("draws one measure per line once a series column owns the colours", () => {
    const r = {
      columns: ["hour", "cluster", "health_score", "cpu_percent"],
      types: ["TIMESTAMP", "VARCHAR", "INTEGER", "DOUBLE"],
      rows: [
        [HOURS[0], "a", 97, 41], [HOURS[1], "a", 96, 55],
        [HOURS[0], "b", 91, 30], [HOURS[1], "b", 84, 33],
      ],
    };
    const spec = resolveSpec(fieldsOf(r), r.rows,
      { type: "line", series: "cluster", y: ["health_score", "cpu_percent"] });
    expect(spec?.y).toEqual(["health_score"]);
  });

  it("ignores a pick naming a column this result does not have", () => {
    const r = byStatus();
    const spec = resolveSpec(fieldsOf(r), r.rows,
      { type: "bars", x: "region", y: ["namespaces"] });
    expect(spec).toMatchObject({ x: "overall_status", y: ["clusters"] });
  });

  it("refuses a series that is the x axis, and a measure that is", () => {
    const r = timeSeries();
    const spec = resolveSpec(fieldsOf(r), r.rows,
      { type: "line", x: "hour", series: "hour", y: ["hour"] });
    expect(spec?.series).toBe("");
    expect(spec?.y).toEqual(["health_score"]);
  });

  it("only stacks a line, never bars", () => {
    const bars = byStatus();
    expect(resolveSpec(fieldsOf(bars), bars.rows, { type: "bars", stack: true })?.stack).toBe(false);
  });
});

describe("rendering a line chart", () => {
  const r = timeSeries();
  const spec: Spec = { type: "line", x: "hour", series: "cluster", y: ["health_score"], stack: false };

  it("draws one path per series inside a labelled figure", () => {
    const { container } = render(
      <Chart columns={r.columns} columnTypes={r.types} rows={r.rows} spec={spec} />);
    const svg = svgOf(container);
    expect(svg).toHaveAttribute("role", "img");
    expect(svg.getAttribute("aria-label")).toContain("Line chart of health_score over hour");
    expect(svg.getAttribute("aria-label")).toContain("The table below has every value.");
    expect(container.querySelectorAll('path[fill="none"][stroke-width="2"]')).toHaveLength(2);
  });

  it("names each series in the legend", () => {
    render(<Chart columns={r.columns} columnTypes={r.types} rows={r.rows} spec={spec} />);
    // The name is on the key and again on the end label that rides the line.
    expect(screen.getAllByText("ocp-prod-iad-01").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ocp-prod-iad-02").length).toBeGreaterThan(0);
  });

  it("does not promise a table when the caller has none under it", () => {
    const { container } = render(
      <Chart columns={r.columns} columnTypes={r.types} rows={r.rows} spec={spec}
        tableBelow={false} />);
    expect(svgOf(container).getAttribute("aria-label"))
      .not.toContain("The table below");
  });

  it("stacks into filled areas when the spec says to", () => {
    const { container } = render(
      <Chart columns={r.columns} columnTypes={r.types} rows={r.rows}
        spec={{ ...spec, stack: true }} />);
    expect(container.querySelectorAll('path[fill-opacity="0.62"]')).toHaveLength(2);
    expect(container.querySelectorAll('path[fill="none"][stroke-width="2"]')).toHaveLength(0);
  });

  it("draws nothing at all when there is no spec to draw", () => {
    const { container } = render(
      <Chart columns={r.columns} columnTypes={r.types} rows={r.rows} spec={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("rendering a bar chart", () => {
  const r = byStatus();
  const spec: Spec = { type: "bars", x: "overall_status", series: "", y: ["clusters"], stack: false };

  it("draws one bar per category with the category names on the axis", () => {
    const { container } = render(
      <Chart columns={r.columns} columnTypes={r.types} rows={r.rows} spec={spec} />);
    expect(container.querySelectorAll("path.chart-bar")).toHaveLength(3);
    ["healthy", "warning", "critical"].forEach(
      (status) => expect(screen.getAllByText(status).length).toBeGreaterThan(0));
  });

  it("says in the label what is on each axis and where the values are", () => {
    const { container } = render(
      <Chart columns={r.columns} columnTypes={r.types} rows={r.rows} spec={spec} />);
    const label = svgOf(container).getAttribute("aria-label");
    expect(label).toContain("Bar chart of clusters by overall_status");
    expect(label).toContain("3 categories, healthy to critical");
  });

  it("draws a group of bars per category when several measures are picked", () => {
    const grouped = {
      columns: ["hub", "clusters", "namespaces"],
      types: ["VARCHAR", "BIGINT", "BIGINT"],
      rows: [["hub-east", 4, 84], ["hub-west", 1, 22]],
    };
    const { container } = render(
      <Chart columns={grouped.columns} columnTypes={grouped.types} rows={grouped.rows}
        spec={{ type: "bars", x: "hub", series: "", y: ["clusters", "namespaces"],
          stack: false }} />);
    expect(container.querySelectorAll("path.chart-bar")).toHaveLength(4);
    expect(screen.getByText("clusters")).toBeInTheDocument();
    expect(screen.getByText("namespaces")).toBeInTheDocument();
  });

  it("accepts fields worked out once by the caller instead of the raw columns", () => {
    const { container } = render(
      <Chart fields={fieldsOf(r)} rows={r.rows} spec={spec} height={180} />);
    expect(container.querySelectorAll("path.chart-bar")).toHaveLength(3);
  });
});
