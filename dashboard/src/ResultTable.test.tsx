import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ResultTable, { Cell, linkKindFor } from "./ResultTable";
import type { CellProps } from "./ResultTable";

const nav = () => ({ openCluster: vi.fn(), openApp: vi.fn() });

const result = (over = {}) => ({
  columns: ["cluster_name", "overall_status", "health_score"],
  column_types: ["VARCHAR", "VARCHAR", "INTEGER"],
  rows: [
    ["ocp-prod-iad-01", "healthy", 97],
    ["ocp-prod-iad-02", "warning", 74],
  ],
  row_count: 2,
  ...over,
});

describe("linkKindFor", () => {
  it("always links a column that names a cluster", () => {
    expect(linkKindFor("cluster_name")).toBe("cluster");
    expect(linkKindFor("cluster")).toBe("cluster");
  });

  it("links a bare name only where the builder knows the query is over clusters", () => {
    expect(linkKindFor("name", "builder", "clusters")).toBe("cluster");
    expect(linkKindFor("name", "builder", "namespaces")).toBeNull();
    expect(linkKindFor("name", "sql", "clusters")).toBeNull();
  });

  it("links the columns that name an application", () => {
    expect(linkKindFor("app_name")).toBe("app");
    expect(linkKindFor("application")).toBe("app");
    expect(linkKindFor("reason")).toBeNull();
  });
});

describe("Cell", () => {
  const draw = (props: CellProps) => render(<Cell {...props} />);

  it("draws a missing value as a dash rather than as nothing", () => {
    const { container } = draw({ name: "reason", value: null });
    expect(container.firstChild).toHaveTextContent("—");
  });

  it("draws numbers and booleans in the monospace column", () => {
    expect(draw({ name: "health_score", value: 97 }).container.firstChild)
      .toHaveClass("mono");
    expect(draw({ name: "upgrading", value: false }).container.firstChild)
      .toHaveClass("mono", "muted");
    expect(screen.getByText("false")).toBeInTheDocument();
  });

  it("draws an object as its JSON, with the whole of it in the title", () => {
    const { container } = draw({ name: "labels", value: { team: "payments" } });
    expect(container.firstChild).toHaveAttribute("title", '{"team":"payments"}');
  });

  it("opens a cluster from a cluster-shaped column", async () => {
    const navigation = nav();
    const user = userEvent.setup();
    draw({ name: "cluster_name", value: "ocp-prod-iad-01", link: "cluster", nav: navigation });
    await user.click(screen.getByText("ocp-prod-iad-01"));
    expect(navigation.openCluster).toHaveBeenCalledWith("ocp-prod-iad-01");
  });

  it("opens an application from an application-shaped column", async () => {
    const navigation = nav();
    const user = userEvent.setup();
    draw({ name: "app_name", value: "checkout", link: "app", nav: navigation });
    await user.click(screen.getByText("checkout"));
    expect(navigation.openApp).toHaveBeenCalledWith("checkout");
  });

  it("draws the fleet's own status vocabulary as a pill and a chip", () => {
    expect(draw({ name: "overall_status", value: "critical" }).container.firstChild)
      .toHaveClass("pill", "critical");
    expect(draw({ name: "pvc_status", value: "pending" }).container.firstChild)
      .toHaveClass("chip", "pending");
  });

  it("leaves a status-named column that holds a sentence as plain text", () => {
    const { container } = draw({ name: "status", value: "Waiting for the next sweep" });
    expect(container).toHaveTextContent("Waiting for the next sweep");
    expect(container.querySelector(".chip")).toBeNull();
  });

  it("truncates a long value with the whole of it in the title", () => {
    const long = "back-off 5m0s restarting failed container=api pod=checkout-api-7d9f8b6c4-2xk9p";
    const { container } = draw({ name: "message", value: long });
    expect(container.firstChild).toHaveClass("q-trunc");
    expect(container.firstChild).toHaveAttribute("title", long);
  });
});

describe("ResultTable", () => {
  it("draws a column per result column and a row per result row", () => {
    render(<ResultTable result={result()} id="query.results" />);
    expect(screen.getByRole("columnheader", { name: /cluster_name/ })).toBeInTheDocument();
    expect(screen.getAllByRole("row").slice(2)).toHaveLength(2);
  });

  it("right-aligns a column whose every present value is a number", () => {
    const { container } = render(<ResultTable result={result()} id="query.results" />);
    const headers = container.querySelectorAll("thead .dt-head th");
    expect(headers[2]).toHaveClass("dt-right");
    expect(headers[0]).not.toHaveClass("dt-right");
  });

  it("does not call a column of mixed types numeric", () => {
    const mixed = result({ rows: [["a", "healthy", 97], ["b", "warning", "n/a"]] });
    const { container } = render(<ResultTable result={mixed} id="query.results" />);
    expect(container.querySelectorAll("thead .dt-head th")[2]).not.toHaveClass("dt-right");
  });

  it("sorts on the value rather than on what the cell drew", async () => {
    const user = userEvent.setup();
    render(<ResultTable result={result()} id="query.results" />);
    await user.click(screen.getByRole("button", { name: "health_score" }));
    const first = screen.getAllByRole("row").slice(2)[0];
    expect(within(first).getAllByRole("cell")[0]).toHaveTextContent("ocp-prod-iad-02");
  });

  it("links a cluster column through to the cluster the row is about", async () => {
    const navigation = nav();
    const user = userEvent.setup();
    render(<ResultTable result={result()} id="query.results" nav={navigation} />);
    await user.click(screen.getByText("ocp-prod-iad-01"));
    expect(navigation.openCluster).toHaveBeenCalledWith("ocp-prod-iad-01");
  });

  it("says a query ran and returned nothing, in the page's own words", () => {
    render(<ResultTable result={result({ rows: [], row_count: 0 })} id="query.results" />);
    expect(screen.getByText("The query ran and returned no rows.")).toBeInTheDocument();
  });

  it("leaves the filter row off where the panel is too short for it", () => {
    render(<ResultTable result={result()} id="panel" filter={false} />);
    expect(screen.queryByLabelText("Filter by cluster_name")).toBeNull();
  });

  it("filters on a value that is an object by its JSON", async () => {
    const withJson = {
      columns: ["labels"], column_types: ["JSON"],
      rows: [[{ team: "payments" }], [{ team: "retail" }], [null]], row_count: 3,
    };
    const user = userEvent.setup();
    render(<ResultTable result={withJson} id="query.results" />);
    await user.type(screen.getByLabelText("Filter by labels"), "payments");
    await waitFor(() => expect(screen.getAllByRole("row").slice(2)).toHaveLength(1));
    expect(screen.getByText('{"team":"payments"}')).toBeInTheDocument();
  });
});
