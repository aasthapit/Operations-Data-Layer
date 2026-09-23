// Reading a table from a test, now that a table is a MUI X DataGrid.
//
// The grid draws divs rather than a `<table>`, so the roles a test asks for
// moved with it: a body cell is a `gridcell` and not a `cell`, the whole thing
// is a `grid` and not a `table`, and a row of headers sits in its own rowgroup
// above the rows. Every test that reads a table goes through here instead of
// learning that, so the next time the rendering changes one file changes.
//
// Nothing in here asserts; these are queries. They throw with the column they
// were looking for when it is not there, which is the failure a test wants to
// read.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";

/** Where to look, when a page draws more than one table. Defaults to the
 * document, which is what a test with a single table wants. */
export interface GridScope {
  scope?: HTMLElement;
  /** The session a test already set up, so one test uses one pointer. */
  user?: UserEvent;
}

/** A column is named by the label its header shows. */
export type ColumnName = string | RegExp;

// The sort indicator is aria-hidden, so it is not part of any accessible name -
// but it IS part of `textContent`, which is how a header's label is read below.
const ARROWS = /[↑↓↕]/g;

const at = (scope?: HTMLElement) => (scope ? within(scope) : screen);

/** The grid itself. */
export const gridOf = (o: GridScope = {}): HTMLElement => at(o.scope).getByRole("grid");

/** Every column header, left to right. */
export const gridHeaders = (o: GridScope = {}): HTMLElement[] =>
  within(gridOf(o)).getAllByRole("columnheader");

/**
 * Every row that holds data, top to bottom.
 *
 * The header row is a `row` too, so the rows are told apart by what they hold:
 * a data row has cells. A row a view expanded holds one cell spanning the whole
 * width, and is a row like any other.
 */
export const gridRows = (o: GridScope = {}): HTMLElement[] =>
  within(gridOf(o)).getAllByRole("row")
    .filter((row) => within(row).queryAllByRole("gridcell").length > 0);

/** The cells of one row, left to right. */
export const rowCells = (row: HTMLElement): HTMLElement[] =>
  within(row).getAllByRole("gridcell");

/** What the header says, without the sort arrow. The label is the first thing
 * in the header, so a select filter's own options - which are in `textContent`
 * as well - come after it and a prefix is enough to tell columns apart. */
function labelOf(header: HTMLElement): string {
  return (header.textContent || "").replace(ARROWS, "").trim();
}

function indexOfColumn(column: ColumnName, o: GridScope = {}): number {
  const labels = gridHeaders(o).map(labelOf);
  const exact = labels.findIndex((l) => (typeof column === "string" ? l === column : column.test(l)));
  if (exact >= 0) return exact;
  const prefixed = typeof column === "string" ? labels.findIndex((l) => l.startsWith(column)) : -1;
  if (prefixed >= 0) return prefixed;
  throw new Error(`no column header matching ${column} - the table has: ${labels.join(", ")}`);
}

/** One column's header, by the label it shows. */
export const columnHeader = (column: ColumnName, o: GridScope = {}): HTMLElement =>
  gridHeaders(o)[indexOfColumn(column, o)];

/**
 * The text of one column, row by row, in the order the table draws them.
 *
 * A row that spans the whole width - what `expanded` draws - has no cell in
 * this column and is left out, so the answer lines up with the records.
 */
export function cellTexts(column: ColumnName, o: GridScope = {}): string[] {
  const index = indexOfColumn(column, o);
  const width = gridHeaders(o).length;
  return gridRows(o)
    .map(rowCells)
    .filter((cells) => cells.length === width)
    .map((cells) => cells[index].textContent || "");
}

/** Sort by a column, the way a user does: the header's own button, which
 * cycles ascending, descending, and back to the order the rows arrived in. */
export async function sortBy(column: ColumnName, o: GridScope = {}): Promise<void> {
  const user = o.user || userEvent.setup();
  await user.click(within(columnHeader(column, o)).getByRole("button"));
}

/** Which way a column is sorted, as the header says it: "ascending",
 * "descending" or "none". */
export const sortDirection = (column: ColumnName, o: GridScope = {}): string | null =>
  columnHeader(column, o).getAttribute("aria-sort");

/**
 * Narrow a column with its own control in the filter row.
 *
 * A text filter is typed into and a select filter is chosen from, which is the
 * difference between `filter: "text"` and `filter: "select"` on the column. A
 * text filter is debounced, so what is on screen settles a moment after this
 * resolves - `await waitFor(...)` on the rows, as before the swap.
 */
export async function filterColumn(column: ColumnName, text: string,
  o: GridScope = {}): Promise<void> {
  const user = o.user || userEvent.setup();
  const header = columnHeader(column, o);
  const select = within(header).queryByRole("combobox");
  if (select) {
    await user.selectOptions(select, text);
    return;
  }
  const box = within(header).getByRole("textbox");
  await user.clear(box);
  if (text) await user.type(box, text);
}

/** The search box above the table, which reads every column at once. */
export const searchBox = (o: GridScope = {}): HTMLElement =>
  at(o.scope).getByLabelText("Search this table");
