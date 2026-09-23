import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import DataTable from "./DataTable";
import type { Column, DataTableProps } from "./DataTable";
import { Pill } from "./components";
import { closestElement } from "./test/harness";

/** One realistic row: what the clusters endpoint sends, narrowed to the fields
 * these tables draw. */
interface Cluster {
  name: string;
  hub: string;
  status: string;
  nodes: number;
  synced: string;
  note: string | null;
}

// One realistic table: cluster names, statuses from the API's vocabulary, and a
// column whose value is rendered rather than stored, so filtering has to read
// what is on screen.
const ROWS: Cluster[] = [
  { name: "ocp-prod-iad-02", hub: "hub-east", status: "warning", nodes: 6,
    synced: "2026-09-20T20:58:02+00:00", note: null },
  { name: "ocp-prod-iad-01", hub: "hub-east", status: "healthy", nodes: 6,
    synced: "2026-09-20T20:59:11+00:00", note: "clean" },
  { name: "ocp-prod-sjc-01", hub: "hub-west", status: "healthy", nodes: 4,
    synced: "2026-09-20T20:41:11+00:00", note: "clean" },
];

const COLUMNS: Column<Cluster>[] = [
  { key: "name", label: "Cluster", filter: "text" },
  { key: "hub", label: "Hub", filter: "select" },
  { key: "status", label: "Status", filter: "select", render: (r) => <Pill status={r.status} /> },
  { key: "nodes", label: "Nodes", align: "right" },
  { key: "synced", label: "Last synced" },
  { key: "note", label: "Note" },
];

const setup = (props: Partial<DataTableProps<Cluster>> = {}) => {
  const user = userEvent.setup();
  const view = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey="name" {...props} />);
  return { user, ...view };
};

// The first cell of every body row, in the order they are drawn.
const names = () => screen.getAllByRole("row").slice(1)
  .map((row) => within(row).getAllByRole("cell")[0].textContent)
  .filter((text) => text.startsWith("ocp-"));

// The header cell's own button: its arrow is aria-hidden, so its accessible
// name is just the column label.
const sortBy = (label: string) => screen.getByRole("button", { name: label });

// The column filters and the search box are debounced, so what is on screen
// settles a moment after the last keystroke.
const settlesTo = (expected: string[]) => waitFor(() => expect(names()).toEqual(expected));

describe("rendering", () => {
  it("draws a row per record and a header per column", () => {
    setup();
    expect(screen.getByRole("columnheader", { name: /Cluster/ })).toBeInTheDocument();
    expect(names()).toEqual(["ocp-prod-iad-02", "ocp-prod-iad-01", "ocp-prod-sjc-01"]);
  });

  it("renders a cell through its render function and a missing value as nothing", () => {
    setup();
    const healthyRow = closestElement(screen.getByText("ocp-prod-iad-01"), "tr");
    expect(within(healthyRow).getByText("healthy")).toHaveClass("pill", "healthy");
    const warningRow = closestElement(screen.getByText("ocp-prod-iad-02"), "tr");
    expect(within(warningRow).getAllByRole("cell").at(-1)).toBeEmptyDOMElement();
  });

  it("says the table is empty in the caller's own words", () => {
    render(<DataTable columns={COLUMNS} rows={[]} empty="No clusters match these filters." />);
    expect(screen.getByText("No clusters match these filters.")).toBeInTheDocument();
  });

  it("shows the footer the view supplied", () => {
    setup({ footer: "3 clusters" });
    expect(screen.getByText("3 clusters")).toBeInTheDocument();
  });

  it("opens a row when the view asked for that", async () => {
    const onRowClick = vi.fn();
    const { user } = setup({ onRowClick });
    await user.click(screen.getByText("ocp-prod-sjc-01"));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[2]);
  });

  it("draws the extra row a view hangs under one of its rows", () => {
    setup({ expanded: (r) => (r.name === "ocp-prod-iad-01" ? <div>container api</div> : null) });
    expect(screen.getByText("container api")).toBeInTheDocument();
  });

  it("falls back to the row index when the key does not resolve", () => {
    // deliberately a row the key does not resolve on, so it is not a whole one
    render(<DataTable columns={COLUMNS} rows={[{ name: "", hub: "hub-east" } as Cluster]}
      rowKey="name" />);
    expect(screen.getAllByRole("row")).toHaveLength(3);     // header, filters, the one row
    expect(screen.getByRole("cell", { name: "hub-east" })).toBeInTheDocument();
  });
});

describe("sorting", () => {
  it("sorts ascending, then descending, then back to the query's own order", async () => {
    const { user } = setup();
    const header = sortBy("Cluster");
    await user.click(header);
    expect(names()).toEqual(["ocp-prod-iad-01", "ocp-prod-iad-02", "ocp-prod-sjc-01"]);
    expect(screen.getByRole("columnheader", { name: /Cluster/ })).toHaveAttribute("aria-sort", "ascending");

    await user.click(header);
    expect(names()).toEqual(["ocp-prod-sjc-01", "ocp-prod-iad-02", "ocp-prod-iad-01"]);
    expect(screen.getByRole("columnheader", { name: /Cluster/ })).toHaveAttribute("aria-sort", "descending");

    await user.click(header);
    expect(names()).toEqual(["ocp-prod-iad-02", "ocp-prod-iad-01", "ocp-prod-sjc-01"]);
  });

  it("starts on the sort the view asked for", () => {
    setup({ initialSort: { key: "name", dir: "asc" } });
    expect(names()).toEqual(["ocp-prod-iad-01", "ocp-prod-iad-02", "ocp-prod-sjc-01"]);
  });

  it("sorts numbers as numbers rather than as text", async () => {
    const rows = [{ name: "a", nodes: 9 }, { name: "b", nodes: 10 }, { name: "c", nodes: 2 }];
    const user = userEvent.setup();
    render(<DataTable columns={[{ key: "name", label: "Name" }, { key: "nodes", label: "Nodes" }]}
      rows={rows} rowKey="name" />);
    await user.click(sortBy("Nodes"));
    expect(screen.getAllByRole("row").slice(1)
      .map((r) => within(r).getAllByRole("cell")[1].textContent)).toEqual(["2", "9", "10"]);
  });

  it("sorts timestamps by their instant, not by their spelling", async () => {
    const { user } = setup();
    await user.click(sortBy("Last synced"));
    expect(names()).toEqual(["ocp-prod-sjc-01", "ocp-prod-iad-02", "ocp-prod-iad-01"]);
  });

  it("sorts on the value a column declares rather than on what it shows", async () => {
    // The order a status sorts in, which is not the order it reads in.
    const RANK: Record<string, number> = { critical: 0, warning: 1, healthy: 2 };
    const columns: Column<Cluster>[] = [
      { key: "name", label: "Cluster" },
      { key: "state", label: "State", sortValue: (r) => RANK[r.status],
        render: (r) => <Pill status={r.status} /> },
    ];
    const user = userEvent.setup();
    render(<DataTable columns={columns} rows={ROWS} rowKey="name" />);
    await user.click(sortBy("State"));
    expect(names()[0]).toBe("ocp-prod-iad-02");
  });

  it("puts the blanks last whichever way the column is sorted", async () => {
    const { user } = setup();
    const header = sortBy("Note");
    await user.click(header);
    expect(names().at(-1)).toBe("ocp-prod-iad-02");
    await user.click(header);
    expect(names().at(-1)).toBe("ocp-prod-iad-02");
  });

  it("does not offer a sort on a column the view marked unsortable or unlabelled", () => {
    render(<DataTable rowKey="name" rows={ROWS}
      columns={[{ key: "name", label: "Cluster", sortable: false }, { key: "hub", label: "" }]} />);
    expect(screen.queryByRole("button", { name: "Cluster" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hub" })).toBeNull();
  });
});

describe("filtering", () => {
  it("narrows on a column's own text filter", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Filter by Cluster"), "sjc");
    await settlesTo(["ocp-prod-sjc-01"]);
  });

  it("offers a select filter built from the values actually in the column", async () => {
    const { user } = setup();
    const select = screen.getByLabelText("Filter by Hub") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "hub-east", "hub-west"]);
    await user.selectOptions(select, "hub-west");
    expect(names()).toEqual(["ocp-prod-sjc-01"]);
  });

  it("matches a select filter on the text a rendered cell shows", async () => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText("Filter by Status"), "warning");
    expect(names()).toEqual(["ocp-prod-iad-02"]);
  });

  it("searches every column at once", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Search this table"), "hub-east");
    await settlesTo(["ocp-prod-iad-02", "ocp-prod-iad-01"]);
  });

  it("says the rows are there but filtered out rather than that there are none", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Search this table"), "ocp-dev");
    expect(await screen.findByText("No rows match the filters.")).toBeInTheDocument();
  });

  it("counts what is on screen against what there is", async () => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText("Filter by Hub"), "hub-east");
    expect(await screen.findByText("2 of 3")).toBeInTheDocument();
  });

  it("clears the filters, the search and the sort back to the view's default", async () => {
    const { user } = setup({ initialSort: { key: "name", dir: "asc" } });
    await user.selectOptions(screen.getByLabelText("Filter by Hub"), "hub-west");
    await user.click(sortBy("Nodes"));
    await user.click(await screen.findByRole("button", { name: "Clear" }));
    expect(names()).toEqual(["ocp-prod-iad-01", "ocp-prod-iad-02", "ocp-prod-sjc-01"]);
    expect(screen.getByLabelText("Filter by Hub")).toHaveValue("");
  });

  it("draws no filter row at all when no column asked for one", () => {
    render(<DataTable rowKey="name" rows={ROWS}
      columns={[{ key: "name", label: "Cluster" }, { key: "hub", label: "Hub" }]} />);
    expect(screen.queryByLabelText("Filter by Cluster")).toBeNull();
  });

  it("filters on a column's declared filter text rather than on what it renders", async () => {
    const columns: Column<Cluster>[] = [
      { key: "name", label: "Cluster" },
      { key: "nodes", label: "Nodes", filter: "text",
        filterValue: (r) => `${r.nodes} nodes`, render: () => <span>-</span> },
    ];
    const user = userEvent.setup();
    render(<DataTable columns={columns} rows={ROWS} rowKey="name" />);
    await user.type(screen.getByLabelText("Filter by Nodes"), "4 nodes");
    await settlesTo(["ocp-prod-sjc-01"]);
  });

  it("reads a list cell as its joined values when it filters", async () => {
    const rows = [{ name: "checkout", envs: ["prod", "stage"] },
      { name: "catalog", envs: ["prod"] }];
    const user = userEvent.setup();
    render(<DataTable rowKey="name" rows={rows}
      columns={[{ key: "name", label: "App" }, { key: "envs", label: "Envs", filter: "text" }]} />);
    await user.type(screen.getByLabelText("Filter by Envs"), "stage");
    await waitFor(() => expect(screen.queryByRole("cell", { name: "catalog" })).toBeNull());
    expect(screen.getByRole("cell", { name: "checkout" })).toBeInTheDocument();
  });
});

describe("paging", () => {
  // Paging is about how many rows reach the DOM, so a row here is only as much
  // of a cluster as the two columns draw.
  type PageRow = Pick<Cluster, "name" | "hub">;
  const many: PageRow[] =
    Array.from({ length: 12 }, (_, i) => ({ name: `ocp-prod-iad-${i}`, hub: "hub-east" }));
  const pageColumns: Column<PageRow>[] =
    [{ key: "name", label: "Cluster" }, { key: "hub", label: "Hub" }];

  it("renders only a page of rows and says how many there are", () => {
    render(<DataTable columns={pageColumns} rows={many} rowKey="name" pageSize={5} />);
    expect(screen.getAllByRole("row")).toHaveLength(6);      // header plus five
    expect(screen.getByText("5 of 12 shown")).toBeInTheDocument();
  });

  it("shows another page, and then all of them", async () => {
    const user = userEvent.setup();
    render(<DataTable columns={pageColumns} rows={many} rowKey="name" pageSize={5} />);
    await user.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(screen.getAllByRole("row")).toHaveLength(11);
    await user.click(screen.getByRole("button", { name: "Show all 12" }));
    expect(screen.getAllByRole("row")).toHaveLength(13);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("starts over at one page when what is being asked for changes", async () => {
    const user = userEvent.setup();
    render(<DataTable columns={pageColumns} rows={many} rowKey="name" pageSize={5}
      id="paging.test" />);
    await user.click(screen.getByRole("button", { name: "Show 5 more" }));
    await user.type(screen.getByLabelText("Search this table"), "ocp");
    expect(await screen.findByText("5 of 12 shown")).toBeInTheDocument();
  });
});

describe("persistence", () => {
  it("remembers the sort, the filters and the search under the table's id", async () => {
    const { user, unmount } = setup({ id: "clusters" });
    await user.click(sortBy("Cluster"));
    await user.selectOptions(screen.getByLabelText("Filter by Hub"), "hub-east");
    await screen.findByText("2 of 3");
    unmount();

    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey="name" id="clusters" />);
    expect(names()).toEqual(["ocp-prod-iad-01", "ocp-prod-iad-02"]);
  });

  it("keeps a cleared sort cleared rather than falling back to the default", async () => {
    const { user, unmount } = setup({ id: "clusters", initialSort: { key: "name", dir: "asc" } });
    const header = sortBy("Cluster");
    await user.click(header);      // desc
    await user.click(header);      // cleared
    unmount();

    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey="name" id="clusters"
      initialSort={{ key: "name", dir: "asc" }} />);
    expect(names()).toEqual(["ocp-prod-iad-02", "ocp-prod-iad-01", "ocp-prod-sjc-01"]);
  });

  it("drops a remembered sort on a column the table no longer has", () => {
    window.localStorage.setItem("odl.table.clusters",
      JSON.stringify({ sort: { key: "gone", dir: "asc" }, filters: { gone: "x" }, q: "" }));
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey="name" id="clusters"
      initialSort={{ key: "name", dir: "asc" }} />);
    expect(names()).toEqual(["ocp-prod-iad-01", "ocp-prod-iad-02", "ocp-prod-sjc-01"]);
  });

  it("reads a remembered sort that was stored as a bare column name", () => {
    window.localStorage.setItem("odl.table.clusters", JSON.stringify({ sort: "name" }));
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey="name" id="clusters" />);
    expect(names()).toEqual(["ocp-prod-iad-01", "ocp-prod-iad-02", "ocp-prod-sjc-01"]);
  });

  it("falls back to the defaults when what was stored is not a table state", () => {
    window.localStorage.setItem("odl.table.clusters", "{ not json");
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey="name" id="clusters" />);
    expect(names()).toEqual(["ocp-prod-iad-02", "ocp-prod-iad-01", "ocp-prod-sjc-01"]);
  });

  it("remembers nothing at all for a table with no id", async () => {
    const { user, unmount } = setup();
    await user.click(sortBy("Cluster"));
    unmount();
    setup();
    expect(names()).toEqual(["ocp-prod-iad-02", "ocp-prod-iad-01", "ocp-prod-sjc-01"]);
  });

  it("picks up the other table's remembered state when the view swaps tables", async () => {
    window.localStorage.setItem("odl.table.metrics.capacity.hub",
      JSON.stringify({ sort: { key: "name", dir: "asc" }, filters: {}, q: "" }));
    const { rerender } = render(
      <DataTable columns={COLUMNS} rows={ROWS} rowKey="name" id="metrics.capacity.cluster" />);
    expect(names()[0]).toBe("ocp-prod-iad-02");
    rerender(<DataTable columns={COLUMNS} rows={ROWS} rowKey="name" id="metrics.capacity.hub" />);
    expect(names()[0]).toBe("ocp-prod-iad-01");
  });
});
