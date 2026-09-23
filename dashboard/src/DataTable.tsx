// Reusable sortable / filterable table used by every table in the dashboard.
//
// Phase 4 of ADR-0005: the drawing is MUI X DataGrid (community) and the props
// are exactly what they were, so none of the 57 call sites changed. The split
// of work is the interesting part:
//
//   the grid does   sorting (with this file's comparator), paging, row
//                   virtualisation, density, column sizing and the DOM;
//   the wrapper does the free-text search and the per-column filter row, both
//                   of which narrow the rows BEFORE they reach the grid -
//                   filtering on more than one column at a time is a Pro
//                   feature and quick filter is a single box, not a row of
//                   them - plus the state that is remembered per table.
//
// Everything is still client-side over the rows the view already fetched: the
// server-side FilterSelects in the views still narrow the API query, this only
// narrows what is on screen. Sort + filter state is kept per table `id` in
// localStorage, under the same key and the same JSON as before the swap, so a
// reload keeps the user's view and an upgrade keeps what they had.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import Box from "@mui/material/Box";
import InputBase from "@mui/material/InputBase";
import Select from "@mui/material/Select";
import { DataGrid, useGridApiRef } from "@mui/x-data-grid";
import type {
  GridColDef, GridPaginationModel, GridRenderCellParams, GridSortModel,
} from "@mui/x-data-grid";
import { download, toCsv } from "./files";

const PREFIX = "odl.table.";
// 2026-09-13, 2026-09-13T04:13:54+00:00, 2026-09-13 04:13:54
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// --------------------------------------------------------------------------- //
// the column definition
// --------------------------------------------------------------------------- //
export type SortDir = "asc" | "desc";

/** Which column a table is sorted by, and which way. */
export interface SortState {
  key: string;
  dir: SortDir;
}

/** What a view remembers as its default sort: a column key on its own means
 * ascending, and null means "no sort". */
export type InitialSort = string | SortState | null;

/**
 * One column of a table.
 *
 * `key` is both the row property the column reads and the identity the saved
 * sort and filter state is stored under, so renaming a key retires whatever the
 * user had remembered for it. It is also the grid's `field`.
 *
 * `Row` defaults to `any` because a table is drawn over whatever JSON the view
 * fetched: the call sites pin it by passing their own rows, and a column list
 * written on its own (the common case - a module-level const beside the view)
 * still type-checks while its view is untyped.
 */
// why: see the paragraph above - the default is what keeps a standalone column
// list usable before its view has a row type.
export interface Column<Row = any> {
  key: string;
  /** What the header says. A column with no label is never sortable. */
  label?: ReactNode;
  render?: (row: Row) => ReactNode;
  /** The value the column sorts on, when `row[key]` is not it. */
  sortValue?: (row: Row) => unknown;
  /** The text the column filters and searches on, when `row[key]` is not it. */
  filterValue?: (row: Row) => unknown;
  /** A per-column control in the filter row: free text, or the values present. */
  filter?: "text" | "select";
  /** Off for a column that is an action or a drawing rather than a value. */
  sortable?: boolean;
  align?: "left" | "right" | "center";
  width?: number | string;
  className?: string;
  headerClassName?: string;
}

/** A column list is written inline beside its view, so a column that only
 * applies in one mode is left in as `cond && {...}` and filtered out here. */
// why: `Column`'s own default; see above.
export type ColumnDef<Row = any> = Column<Row> | false | null | undefined;

// why: a table row is whatever shape the view fetched; `rows` pins it at the
// call site, and a table drawn with no rows at all falls back to this.
export interface DataTableProps<Row = any> {
  /** `NoInfer` keeps the row type coming from `rows` alone: a column list with
   * its own annotation must fit the rows, not redefine them. */
  columns: ReadonlyArray<ColumnDef<NoInfer<Row>>>;
  rows?: readonly Row[] | null;
  /** A row property to key on, or a function. Anything empty falls back to the
   * row's index. */
  rowKey?: string | ((row: Row, index: number) => string | number | null | undefined);
  onRowClick?: (row: Row) => void;
  rowClassName?: (row: Row) => string | null | undefined;
  /** What to say when the view fetched nothing at all. */
  empty?: ReactNode;
  initialSort?: InitialSort;
  /** The key the sort, the filters and the search are remembered under. A table
   * with no id remembers nothing. */
  id?: string;
  dense?: boolean;
  footer?: ReactNode;
  /** An extra full-width row drawn under a row. */
  expanded?: (row: Row) => ReactNode;
  /** Render inside the standard capped scroll container. */
  scroll?: boolean;
  searchPlaceholder?: string;
  /** Rows handed to React at once; sort and filter still see them all. */
  pageSize?: number;
}

/** What a table remembers, per `id`. */
interface TableState {
  id: string | undefined;
  sort: SortState | null;
  filters: Record<string, string>;
  q: string;
}

/**
 * One row as the grid holds it. The view's own row is carried rather than
 * spread, so a view whose rows already have an `id`, a `field` or any other
 * name the grid reserves is still drawn from its own values.
 *
 * `extra` is set on the synthetic row that carries what `expanded` drew: the
 * community grid has no detail panel (that is Pro), so an expansion is a row of
 * its own whose first cell spans the whole width.
 */
interface GridRow<Row> {
  id: string | number;
  data: Row;
  extra: ReactNode | null;
}

// A row is read by key, which is a string the column carries rather than
// something TypeScript can follow into the view's own row type.
type AnyRow = Record<string, unknown>;
const field = (row: unknown, key: string): unknown => (row as AnyRow | null)?.[key];

// ---- persistence ----------------------------------------------------------
function normalizeSort(s: unknown): SortState | null {
  if (!s) return null;
  if (typeof s === "string") return { key: s, dir: "asc" };
  if (typeof s === "object") {
    const raw = s as { key?: unknown; dir?: unknown };
    if (raw.key) return { key: String(raw.key), dir: raw.dir === "desc" ? "desc" : "asc" };
  }
  return null;
}

function loadState(id: string | undefined, columns: ReadonlyArray<Column>,
  initialSort: InitialSort | undefined): TableState {
  const base: TableState = { id, sort: normalizeSort(initialSort), filters: {}, q: "" };
  if (!id) return base;
  let saved: { sort?: unknown; filters?: unknown; q?: unknown } | null = null;
  try {
    const raw = window.localStorage.getItem(PREFIX + id);
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null; // storage disabled or corrupt - fall back to the defaults
  }
  if (!saved || typeof saved !== "object") return base;

  const keys = new Set(columns.map((c) => c.key));
  const out: TableState = { ...base, filters: {} };
  // A sort on a column that no longer exists falls back to the view's default;
  // an explicit null means the user cleared the sort and we keep it cleared.
  if ("sort" in saved) {
    const s = normalizeSort(saved.sort);
    if (saved.sort === null) out.sort = null;
    else if (s && keys.has(s.key)) out.sort = s;
  }
  if (saved.filters && typeof saved.filters === "object") {
    for (const [k, v] of Object.entries(saved.filters as Record<string, unknown>)) {
      if (keys.has(k) && typeof v === "string" && v !== "") out.filters[k] = v;
    }
  }
  if (typeof saved.q === "string") out.q = saved.q;
  return out;
}

function saveState(id: string | undefined, state: TableState) {
  if (!id) return;
  try {
    window.localStorage.setItem(PREFIX + id, JSON.stringify({ sort: state.sort, filters: state.filters, q: state.q }));
  } catch {
    /* quota or private mode - the table works, it just will not remember */
  }
}

// ---- value extraction -----------------------------------------------------
// Text of a React node, so a column with a render function can still be
// filtered on what the user actually reads.
function nodeText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(" ");
  const props = (node as { props?: { children?: unknown } }).props;
  if (props && props.children !== undefined) return nodeText(props.children);
  return "";
}

function cellText(col: Column, row: unknown): string {
  if (col.filterValue) {
    const v = col.filterValue(row);
    return v == null ? "" : String(v);
  }
  const raw = row ? field(row, col.key) : undefined;
  if (Array.isArray(raw)) return raw.filter((x) => x != null && typeof x !== "object").join(", ");
  if (raw != null && typeof raw !== "object") return String(raw);
  if (col.render) return nodeText(col.render(row));
  if (col.sortValue) {
    const v = col.sortValue(row);
    if (v != null && typeof v !== "object") return String(v);
  }
  return "";
}

const isEmptyValue = (v: unknown): boolean =>
  v == null || (typeof v === "number" && Number.isNaN(v));

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" || typeof b === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
  const as = String(a);
  const bs = String(b);
  if (ISO_DATE.test(as) && ISO_DATE.test(bs)) {
    const d = Date.parse(as) - Date.parse(bs);
    if (!Number.isNaN(d)) return d;
  }
  return as.localeCompare(bs, undefined, { sensitivity: "base", numeric: true });
}

// ---- export ---------------------------------------------------------------
/**
 * The whole table, as a file, because the page cap means the whole table is no
 * longer on screen at once.
 *
 * The grid can write a CSV of its own (`exportDataAsCsv`) and it would see every
 * row the filters left, since the wrapper narrows the rows before the grid ever
 * holds them - but it writes each cell from `valueGetter`, which here answers
 * the value a column SORTS on. A status column that sorts by a rank would
 * export 0, 1 and 2. So the rows are written here, through the same `cellText`
 * the search and the filters read, and the only thing asked of the grid is the
 * order it put them in.
 */
function exportRows(columns: ReadonlyArray<Column>, rows: readonly unknown[],
  filename: string): boolean {
  // A column with no label is an action or a drawing rather than a value; it
  // has no heading to write and nothing worth a column in a spreadsheet.
  const cols = columns.filter((c) => !!c.label);
  const head = cols.map((c) => (typeof c.label === "string" ? c.label : c.key));
  const body = rows.map((row) => cols.map((c) => cellText(c, row)));
  return download(filename, toCsv(head, body), "text/csv;charset=utf-8");
}

// ---- sizing ---------------------------------------------------------------
// The heights the stylesheet gave the table before the swap, so a table that
// was dense still is. The grid multiplies both `rowHeight` and
// `columnHeaderHeight` by its density factor, so the wrapper divides that back
// out: the height a table wants is the one its `dense` prop asks for, not the
// one the grid's default row happens to be.
const DENSITY_FACTOR = { standard: 1, compact: 0.7 } as const;
const ROW_HEIGHT = { standard: 38, compact: 30 } as const;
const LABEL_HEIGHT = { standard: 36, compact: 30 } as const;
const FILTER_ROW_HEIGHT = 34;
/** How tall a table may grow before it scrolls inside itself, which is what
 * turns row virtualisation on. `scroll` keeps the old capped container's 520px;
 * everything else gets most of the window. */
const VIEWPORT_CAP = { scroll: "520px", page: "70vh" } as const;
const FOOTER_HEIGHT = 53;
/** Rows worth of height to keep for the "nothing to show" overlay. */
const EMPTY_ROWS = 3;
// why: the community grid does not warn about a page larger than this, it
// throws - so a caller that asks for more is paged at the limit rather than
// taking the table down. Nothing asks for more today; this is what keeps the
// next view that does from being a blank page.
const PAGE_LIMIT = 100;
// A <table> asked the browser to size every column to its widest cell; the grid
// gives them all the same width unless it is told otherwise, which cut a
// timestamp column in half. The width is estimated from the text the column
// actually holds instead of measured, because an estimate is the same on every
// render: the grid's own autosizing reads the DOM once and is lost the next
// time the column definitions change, so the columns would jump back to even
// the first time a filter was typed.
const CHAR_PX = 7.2;         // 13px in the UI face, averaged over the alphabet
const HEADER_CHAR_PX = 6.8;  // the header is 12px, semibold
const SORT_ARROW_PX = 16;
const CELL_PADDING_PX = 22;
const FILTER_CONTROL_PX = 86;
const MIN_COLUMN_PX = 64;
const MAX_COLUMN_PX = 360;
/** How many rows are read to guess how wide a column has to be. The old table
 * only ever sized itself on the page it was drawing, so this is the same
 * bargain struck over fewer rows. */
const WIDTH_SAMPLE = 60;
// why: the grid windows columns as well as rows, and a column that is not drawn
// takes its filter control with it. Columns are few and bounded (the widest
// table in the app has twenty); rows are not. Buffering the whole width keeps
// every filter control and every header in the DOM and leaves the win - row
// windowing over 900 clusters - exactly where it is.
const ALL_COLUMNS_PX = 10000;

// A control inside a column header is inside the grid's own click target, so
// every event it handles has to stop there: a click would otherwise toggle the
// sort and a keystroke would be read as grid navigation.
const swallow = {
  onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onMouseDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onKeyDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
};

// ---- debounced text input -------------------------------------------------
interface DebouncedInputProps {
  value?: string | null;
  onChange: (value: string) => void;
  delay?: number;
  placeholder?: string;
  ariaLabel: string;
  /** The search box above the table, rather than a control inside a header. */
  search?: boolean;
}

function DebouncedInput({ value, onChange, delay = 150, placeholder, ariaLabel, search }:
DebouncedInputProps) {
  const [local, setLocal] = useState(value || "");
  const committed = useRef(value || "");
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    const next = value || "";
    if (next !== committed.current) {
      committed.current = next;
      setLocal(next);
    }
  }, [value]);

  useEffect(() => {
    if (local === committed.current) return undefined;
    const t = setTimeout(() => {
      committed.current = local;
      cb.current(local);
    }, delay);
    return () => clearTimeout(t);
  }, [local, delay]);

  return (
    <InputBase
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      placeholder={placeholder}
      inputProps={{ "aria-label": ariaLabel }}
      sx={search ? SEARCH_SX : FILTER_SX}
      {...(search ? {} : swallow)}
    />
  );
}

// ---- the parts of a header ------------------------------------------------
const CONTROL_SX = {
  border: 1,
  borderColor: "divider",
  borderRadius: 1,
  bgcolor: "background.default",
  color: "text.primary",
  "&.Mui-focused": { borderColor: "primary.main" },
};

const SEARCH_SX = {
  ...CONTROL_SX,
  minWidth: 200,
  px: 1.1,
  py: 0.3,
  fontSize: 12.5,
};

const FILTER_SX = {
  ...CONTROL_SX,
  width: "100%",
  height: 24,
  px: 0.75,
  fontSize: 11.5,
};

const BAR_BUTTON_SX = {
  border: 1,
  borderColor: "divider",
  borderRadius: 1,
  px: 1.25,
  py: 0.5,
  bgcolor: "transparent",
  color: "text.secondary",
  cursor: "pointer",
  fontSize: 12,
  font: "inherit",
  "&:hover": { borderColor: "primary.main", color: "text.primary" },
};

/**
 * What a header needs that changes while the table is being used.
 *
 * It travels by context rather than in the column definition because the grid
 * rebuilds every column's width and position when the definitions change
 * identity: a sort click or a keystroke in a filter would otherwise put the
 * columns back to their default sizes in front of the user.
 */
interface TableRuntime {
  sorted: SortState | null;
  filters: Record<string, string>;
  options: Record<string, string[]>;
  /** Whether ANY column carries a control, which is what decides whether every
   * header keeps a row's worth of space for one. */
  hasFilters: boolean;
  toggleSort: (key: string) => void;
  setFilter: (key: string, value: string) => void;
}

const RuntimeContext = createContext<TableRuntime | null>(null);

const EMPTY_RUNTIME: TableRuntime = {
  sorted: null, filters: {}, options: {}, hasFilters: false,
  toggleSort: () => {}, setFilter: () => {},
};

interface ColumnHeaderProps {
  column: Column;
  align: "left" | "right" | "center";
  sortable: boolean;
}

function ColumnHeader({ column, align, sortable }: ColumnHeaderProps) {
  // why: a header is only ever drawn inside the grid this file renders, so the
  // fallback is unreachable - it is there so the type is not nullable.
  const runtime = useContext(RuntimeContext) || EMPTY_RUNTIME;
  const { label, filter } = column;
  const { hasFilters } = runtime;
  const dir = runtime.sorted && runtime.sorted.key === column.key ? runtime.sorted.dir : null;
  const value = runtime.filters[column.key] || "";
  const options = runtime.options[column.key] || [];
  const onSort = () => runtime.toggleSort(column.key);
  const onFilter = (v: string) => runtime.setFilter(column.key, v);
  const justify = align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start";
  const arrow = dir === "asc" ? "↑" : dir === "desc" ? "↓" : "↕";
  return (
    <Box sx={{ display: "flex", flexDirection: "column", justifyContent: "center",
      gap: 0.5, width: "100%", height: "100%", py: 0.5 }}>
      {sortable ? (
        <Box
          component="button"
          type="button"
          onClick={(e: MouseEvent) => { e.stopPropagation(); onSort(); }}
          title={`Sort by ${label}`}
          sx={{ display: "flex", alignItems: "center", justifyContent: justify, gap: 0.5,
            background: "none", border: 0, p: 0, m: 0, cursor: "pointer", font: "inherit",
            color: dir ? "text.primary" : "inherit",
            "&:hover": { color: "text.primary" } }}
        >
          <span>{label}</span>
          <Box component="span" aria-hidden="true"
            sx={{ fontSize: 9, lineHeight: 1, flex: "none", opacity: dir ? 1 : 0.7,
              color: dir ? "primary.main" : "text.disabled" }}>
            {arrow}
          </Box>
        </Box>
      ) : (
        <Box component="span" sx={{ display: "block", textAlign: align }}>{label}</Box>
      )}
      {hasFilters && (
        <Box sx={{ height: 24 }}>
          {filter === "text" ? (
            <DebouncedInput
              value={value}
              onChange={onFilter}
              placeholder="filter"
              ariaLabel={`Filter by ${label}`}
            />
          ) : filter === "select" && options.length > 0 ? (
            <Select
              native
              value={value}
              onChange={(e) => onFilter(e.target.value)}
              inputProps={{ "aria-label": `Filter by ${label}` }}
              sx={{ ...FILTER_SX, py: 0, "& .MuiSelect-select": { p: "2px 4px", height: "100%" },
                "& fieldset": { border: 0 } }}
              {...swallow}
            >
              <option value="">all</option>
              {options.map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          ) : null}
        </Box>
      )}
    </Box>
  );
}

// ---- component ------------------------------------------------------------
export default function DataTable<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowClassName,
  empty = "Nothing to show.",
  initialSort,
  id,
  dense = false,
  footer,
  expanded,          // (row) => node | null: extra full-width row under a row
  scroll = false,    // render inside the standard capped scroll container
  searchPlaceholder = "Search",
  pageSize = 100,    // rows on a page; sort and filter still see them all
}: DataTableProps<Row>) {
  const cols = useMemo(
    () => (columns || []).filter(Boolean) as Column<Row>[], [columns]);
  const all = useMemo(() => rows || [], [rows]);

  const [state, setState] = useState<TableState>(() => loadState(id, cols, initialSort));
  const latest = useRef({ cols, initialSort });
  latest.current = { cols, initialSort };

  // A view can swap the table under one component (e.g. grouping changes the
  // key column): pick up the new table's remembered state.
  useEffect(() => {
    setState((s) => (s.id === id ? s : loadState(id, latest.current.cols, latest.current.initialSort)));
  }, [id]);

  useEffect(() => {
    if (state.id === id) saveState(id, state);
  }, [id, state]);

  const byKey = useMemo(() => new Map(cols.map((c) => [c.key, c])), [cols]);

  const selectOptions = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const c of cols) {
      if (c.filter !== "select") continue;
      const seen = new Set<string>();
      for (const row of all) {
        const t = cellText(c, row);
        if (t !== "") seen.add(t);
      }
      out[c.key] = [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
    }
    return out;
  }, [cols, all]);

  // The filters that are on, each already carrying the column it names rather
  // than the key. Resolving here rather than in the row loop means the lookup
  // happens once per filter instead of once per filter per row, and it is what
  // lets the loop below read `col` without asking whether it is there: a filter
  // whose column this table no longer has is not an active filter.
  const activeFilters = useMemo(
    () => Object.entries(state.filters).flatMap(([k, v]) => {
      const col = byKey.get(k);
      return v && col ? [[col, v] as const] : [];
    }),
    [state.filters, byKey]
  );
  const query = state.q.trim().toLowerCase();

  // What the grid is given: the rows that survived the search and the filter
  // row. The order is still the order they arrived in - sorting is the grid's.
  const view = useMemo(() => {
    if (!query && !activeFilters.length) return all;
    return all.filter((row) => {
      for (const [col, v] of activeFilters) {
        const text = cellText(col, row);
        if (col.filter === "select") {
          if (text !== v) return false;
        } else if (!text.toLowerCase().includes(v.toLowerCase())) {
          return false;
        }
      }
      if (query && !cols.some((c) => cellText(c, row).toLowerCase().includes(query))) return false;
      return true;
    });
  }, [all, cols, activeFilters, query]);

  const gridRows = useMemo<GridRow<Row>[]>(() => {
    const out: GridRow<Row>[] = [];
    const seen = new Set<string | number>();
    view.forEach((row, i) => {
      // A view can hand us rows from the previous query for a render (e.g. the
      // grouping changed but the refetch has not landed), so a row key that
      // does not resolve falls back to the index - and a key two rows share
      // falls back with it, because the grid needs the id to be unique where
      // React only wanted it to be stable.
      const raw = typeof rowKey === "function" ? rowKey(row, i) : rowKey ? field(row, rowKey) : i;
      const resolved = raw == null || raw === "" ? i : (raw as string | number);
      const key = seen.has(resolved) ? `${resolved}#${i}` : resolved;
      seen.add(key);
      out.push({ id: key, data: row, extra: null });
      const extra = expanded ? expanded(row) : null;
      // The expansion sorts on its parent's own value, so a stable sort leaves
      // it where it belongs: directly under the row it belongs to.
      if (extra) out.push({ id: `${key}--expanded`, data: row, extra });
    });
    return out;
  }, [view, rowKey, expanded]);

  const total = view.length;
  const sorted = state.sort && byKey.get(state.sort.key) ? state.sort : null;
  // The comparator below reads the direction when the grid runs it rather than
  // when the column was built: a click changes the sort model and the columns
  // in the same render, and which of the two the grid picks up first is its
  // business, not this file's.
  const sortRef = useRef(sorted);
  sortRef.current = sorted;

  const toggleSort = useCallback((key: string) =>
    setState((s) => {
      const cur = s.sort;
      if (!cur || cur.key !== key) return { ...s, sort: { key, dir: "asc" } };
      if (cur.dir === "asc") return { ...s, sort: { key, dir: "desc" } };
      return { ...s, sort: null };
    }), []);

  const setFilter = useCallback((key: string, value: string) =>
    setState((s) => {
      const filters = { ...s.filters };
      if (value) filters[key] = value;
      else delete filters[key];
      return { ...s, filters };
    }), []);

  const hasColumnFilters = cols.some((c) => c.filter === "text" || c.filter === "select");

  const widths = useMemo(() => {
    const sample = all.slice(0, WIDTH_SAMPLE);
    return cols.map((c) => {
      const label = typeof c.label === "string" ? c.label : "";
      let widest = label.length * HEADER_CHAR_PX + (c.sortable !== false && c.label ? SORT_ARROW_PX : 0);
      if (c.filter) widest = Math.max(widest, FILTER_CONTROL_PX);
      for (const row of sample) {
        widest = Math.max(widest, cellText(c, row).length * CHAR_PX);
      }
      return Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, Math.ceil(widest + CELL_PADDING_PX)));
    });
  }, [cols, all]);

  // ---- what the grid is handed -------------------------------------------
  const gridColumns = useMemo<GridColDef<GridRow<Row>>[]>(() => {
    // A percentage width is what the old table's `width: 40%` meant, and the
    // grid has no percentages - it has flex. Reading them as flex weights over
    // the width the fixed columns leave keeps the same proportions: a 40%
    // column is 40 parts of the hundred, and the columns with no width of their
    // own share what is left.
    const percents = cols.map((c) =>
      (typeof c.width === "string" && c.width.endsWith("%") ? parseFloat(c.width) : 0));
    const claimed = percents.reduce((a, b) => a + b, 0);
    const unsized = cols.filter((c, i) => percents[i] === 0 && typeof c.width !== "number").length;
    const share = unsized > 0 ? Math.max(100 - claimed, unsized) / unsized : 1;

    return cols.map((c, index) => {
      const sortable = c.sortable !== false && !!c.label;
      const align = c.align === "right" ? "right" : c.align === "center" ? "center" : "left";
      // A column keeps at least the room its own text needs and grows into
      // whatever is left over, so a narrow table fills its card and a wide one
      // scrolls sideways rather than cutting its values in half.
      const width = typeof c.width === "number" ? { width: c.width }
        : { flex: percents[index] || share, minWidth: widths[index] };
      return {
        field: c.key,
        headerName: typeof c.label === "string" ? c.label : c.key,
        sortable,
        filterable: false,
        hideable: false,
        resizable: false,
        disableColumnMenu: true,
        align,
        headerAlign: align,
        // The grid's own `text` display clips and ellipsises a string; a cell
        // that draws elements needs to lay them out instead.
        display: c.render ? "flex" : "text",
        cellClassName: c.className,
        headerClassName: c.headerClassName,
        ...width,
        // Only the first column of an expansion row is drawn, and it is drawn
        // across the whole table: the community grid has no detail panel.
        ...(index === 0
          ? { colSpan: (_v: unknown, row: GridRow<Row>) => (row.extra ? cols.length : 1) }
          : {}),
        valueGetter: (_v: unknown, row: GridRow<Row>) =>
          (c.sortValue ? c.sortValue(row.data) : field(row.data, c.key)),
        sortComparator: (a: unknown, b: unknown) => {
          const ea = isEmptyValue(a);
          const eb = isEmptyValue(b);
          if (ea || eb) {
            if (ea && eb) return 0;
            // Blanks last whichever way the column is sorted: the grid negates
            // the comparator for a descending sort, so the empties are told
            // apart the other way round and come back the right way up.
            const cur = sortRef.current;
            const flip = cur && cur.key === c.key && cur.dir === "desc" ? -1 : 1;
            return flip * (ea ? 1 : -1);
          }
          return compareValues(a, b);
        },
        renderCell: (params: GridRenderCellParams<GridRow<Row>>) => {
          const row = params.row;
          if (row.extra) return index === 0 ? row.extra : null;
          if (c.render) return c.render(row.data);
          const raw = field(row.data, c.key);
          return raw == null ? null : String(raw);
        },
        // Everything that changes while the table is being used - which way it
        // is sorted, what is typed in the filters - reaches the header through
        // the context below rather than through here, so that these definitions
        // keep their identity and the grid keeps the columns where they are.
        renderHeader: () => <ColumnHeader column={c} align={align} sortable={sortable} />,
      };
    });
  }, [cols, widths]);

  // ---- sorting and paging, both the grid's ---------------------------------
  const sortModel = useMemo<GridSortModel>(
    () => (sorted ? [{ field: sorted.key, sort: sorted.dir }] : []), [sorted]);

  const onSortModelChange = useCallback((model: GridSortModel) => {
    const item = model[0];
    setState((s) => ({ ...s, sort: item && item.sort ? { key: item.field, dir: item.sort } : null }));
  }, []);

  // The one thing the export asks of the grid: which order it put the rows in,
  // so the file reads the way the screen does.
  const apiRef = useGridApiRef();

  const size = Math.min(pageSize, PAGE_LIMIT);
  const [paginationModel, setPaginationModel] = useState<GridPaginationModel>(
    () => ({ page: 0, pageSize: size }));
  // Narrowing what is asked for starts over at the first page; a refreshed
  // response for the same question keeps the page the user was reading.
  const filterKey = `${id || ""}|${state.q}|${JSON.stringify(state.filters)}`;
  useEffect(() => { setPaginationModel({ page: 0, pageSize: size }); }, [filterKey, size]);

  // ---- the bar above the table --------------------------------------------
  const defaultSort = normalizeSort(initialSort);
  const sortChanged = JSON.stringify(state.sort) !== JSON.stringify(defaultSort);
  const anyActive = activeFilters.length > 0 || query !== "" || sortChanged;
  const filtered = total !== all.length;

  const clear = () => setState((s) => ({ ...s, sort: defaultSort, filters: {}, q: "" }));

  const exportCsv = () => {
    const byId = new Map(gridRows.map((r) => [r.id, r]));
    let ordered: readonly Row[] = view;
    try {
      const ids = apiRef.current?.getSortedRowIds();
      // Every row the filters left, in the order the grid sorted them, minus
      // the synthetic rows an expansion put between them.
      if (ids && ids.length) {
        ordered = ids.flatMap((rowId) => {
          const row = byId.get(rowId as string | number);
          return row && !row.extra ? [row.data] : [];
        });
      }
    } catch {
      /* the grid is not mounted yet - the rows in the order they arrived */
    }
    exportRows(cols, ordered, `${id || "table"}.csv`);
  };

  // ---- the grid's own empty state -----------------------------------------
  const message = all.length === 0 ? empty : "No rows match the filters.";
  const noRowsOverlay = useCallback(() => (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center",
      height: "100%", color: "text.secondary", fontSize: 13 }}>
      {message}
    </Box>
  ), [message]);
  const slots = useMemo(() => ({ noRowsOverlay }), [noRowsOverlay]);

  const runtime = useMemo<TableRuntime>(() => ({
    sorted, filters: state.filters, options: selectOptions,
    hasFilters: hasColumnFilters, toggleSort, setFilter,
  }), [sorted, state.filters, selectOptions, hasColumnFilters, toggleSort, setFilter]);

  // ---- how tall the table is ----------------------------------------------
  const densityKey = dense ? "compact" : "standard";
  const factor = DENSITY_FACTOR[densityKey];
  // The grid scales both of these by the density factor, so ask for the height
  // divided by it and get the height back.
  const scaled = (want: number) => Math.ceil(want / factor);
  const rowHeight = ROW_HEIGHT[densityKey];
  const headerHeight = LABEL_HEIGHT[densityKey] + (hasColumnFilters ? FILTER_ROW_HEIGHT : 0);
  const showFooter = gridRows.length > paginationModel.pageSize;
  // An expansion is as tall as whatever the view drew inside it, which is not
  // something this side can measure - so a table with one open grows to its
  // content and gives up windowing until it is closed again. That is the same
  // number of rows in the DOM as before the swap, since the page size caps it.
  const hasExpansion = gridRows.some((r) => r.extra);
  const onPage = Math.min(gridRows.length, paginationModel.pageSize) || EMPTY_ROWS;
  const contentHeight = headerHeight + onPage * rowHeight + (showFooter ? FOOTER_HEIGHT : 0) + 2;
  const cap = VIEWPORT_CAP[scroll ? "scroll" : "page"];

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, px: 1.5, pb: 1.25 }}>
        <DebouncedInput
          search
          value={state.q}
          onChange={(v) => setState((s) => ({ ...s, q: v }))}
          placeholder={searchPlaceholder}
          ariaLabel="Search this table"
        />
        {filtered && (
          <Box component="span" sx={{ color: "text.secondary", fontSize: 12 }}>
            {`${total} of ${all.length}`}
          </Box>
        )}
        {anyActive && (
          <Box component="button" type="button" onClick={clear} sx={BAR_BUTTON_SX}>
            Clear
          </Box>
        )}
        {all.length > 0 && (
          <Box
            component="button"
            type="button"
            onClick={exportCsv}
            title="Every row the filters left, not only the page on screen"
            sx={{ ...BAR_BUTTON_SX, ml: "auto" }}
          >
            Export CSV
          </Box>
        )}
      </Box>
      <Box sx={{ height: hasExpansion ? undefined : `min(${contentHeight}px, ${cap})` }}>
        <RuntimeContext.Provider value={runtime}>
          <DataGrid
            apiRef={apiRef}
            rows={gridRows}
            columns={gridColumns}
            autoHeight={hasExpansion}
            density={densityKey}
            rowHeight={scaled(rowHeight)}
            columnHeaderHeight={scaled(headerHeight)}
            getRowHeight={(params) => ((params.model as GridRow<Row>).extra ? "auto" : null)}
            columnBufferPx={ALL_COLUMNS_PX}
            sortModel={sortModel}
            onSortModelChange={onSortModelChange}
            paginationModel={paginationModel}
            onPaginationModelChange={setPaginationModel}
            pageSizeOptions={[paginationModel.pageSize]}
            hideFooter={!showFooter}
            rowSelection={false}
            disableColumnFilter
            disableColumnMenu
            disableColumnSelector
            disableColumnResize
            slots={slots}
            getRowClassName={(params) => {
              const row = params.row as GridRow<Row>;
              if (row.extra) return "odl-expanded";
              return (rowClassName && rowClassName(row.data)) || "";
            }}
            onRowClick={onRowClick
              ? (params) => {
                const row = params.row as GridRow<Row>;
                if (!row.extra) onRowClick(row.data);
              }
              : undefined}
            sx={{
              border: 0,
              fontSize: 13,
              "--DataGrid-overlayHeight": `${EMPTY_ROWS * rowHeight}px`,
              "& .MuiDataGrid-columnHeader": { fontSize: 12, fontWeight: 600 },
              // A filter control inside a header takes the focus, and the ring
              // the grid draws round the whole header when it does is noise.
              "& .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within":
                { outline: "none" },
              "& .MuiDataGrid-columnHeaderTitleContainerContent": { width: "100%", overflow: "visible" },
              // The header draws its own arrow, on the button that carries the
              // column's name; the grid's own icon would be a second arrow beside
              // it, and a second control that says only "Sort".
              "& .MuiDataGrid-iconButtonContainer": { display: "none" },
              "& .MuiDataGrid-row.odl-expanded:hover": { backgroundColor: "transparent" },
              ...(onRowClick ? { "& .MuiDataGrid-row": { cursor: "pointer" } } : {}),
            }}
          />
        </RuntimeContext.Provider>
      </Box>
      {footer != null && (
        <Box sx={{ color: "text.secondary", fontSize: 12.5, px: 1.5, pt: 1.25, pb: 1.5 }}>
          {footer}
        </Box>
      )}
    </Box>
  );
}
