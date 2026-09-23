// Reusable sortable / filterable table used by every table in the dashboard.
//
// Everything is client-side over the rows the view already fetched: the
// server-side FilterSelects in the views still narrow the API query, this only
// narrows what is on screen. Sort + filter state is kept per table `id` in
// localStorage so a reload keeps the user's view.
import { useEffect, useMemo, useRef, useState } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";

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
 * user had remembered for it.
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

// ---- debounced text input -------------------------------------------------
interface DebouncedInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  value?: string | null;
  onChange: (value: string) => void;
  delay?: number;
}

function DebouncedInput({ value, onChange, delay = 150, ...rest }: DebouncedInputProps) {
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

  return <input type="text" value={local} onChange={(e) => setLocal(e.target.value)} {...rest} />;
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
  pageSize = 100,    // rows rendered before "Show more"; sort and filter still see them all
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

  const view = useMemo(() => {
    let out = all;
    if (query || activeFilters.length) {
      out = out.filter((row) => {
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
    }
    // Same resolution as the filters: a sort naming a column this table does
    // not have is not a sort, and carrying the column rather than the key is
    // what says so once instead of at every comparison.
    const sortCol = state.sort ? byKey.get(state.sort.key) : undefined;
    if (state.sort && sortCol) {
      const dir = state.sort.dir === "desc" ? -1 : 1;
      const valueOf = (row: Row) =>
        (sortCol.sortValue ? sortCol.sortValue(row) : field(row, sortCol.key));
      out = [...out].sort((ra, rb) => {
        const a = valueOf(ra);
        const b = valueOf(rb);
        const ea = isEmptyValue(a);
        const eb = isEmptyValue(b);
        if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1; // blanks last, both ways
        return dir * compareValues(a, b);
      });
    }
    return out;
  }, [all, cols, byKey, activeFilters, query, state.sort]);

  // Only a page of rows is handed to React at a time: sorting and filtering run
  // over the whole set above, so the table is still the whole table - it is the
  // DOM that is capped. A refreshed response keeps whatever page the user
  // expanded to; changing what is being asked for starts over at one page.
  const [shown, setShown] = useState(pageSize);
  const filterKey = `${id || ""}|${state.q}|${JSON.stringify(state.filters)}`;
  useEffect(() => { setShown(pageSize); }, [filterKey, pageSize]);
  const total = view.length;
  const page = total > shown ? view.slice(0, shown) : view;
  const paged = page.length < total;

  const defaultSort = normalizeSort(initialSort);
  const sortChanged = JSON.stringify(state.sort) !== JSON.stringify(defaultSort);
  const anyActive = activeFilters.length > 0 || query !== "" || sortChanged;
  const filtered = view.length !== all.length;

  const toggleSort = (key: string) =>
    setState((s) => {
      const cur = s.sort;
      if (!cur || cur.key !== key) return { ...s, sort: { key, dir: "asc" } };
      if (cur.dir === "asc") return { ...s, sort: { key, dir: "desc" } };
      return { ...s, sort: null };
    });

  const setFilter = (key: string, value: string) =>
    setState((s) => {
      const filters = { ...s.filters };
      if (value) filters[key] = value;
      else delete filters[key];
      return { ...s, filters };
    });

  const clear = () => setState((s) => ({ ...s, sort: defaultSort, filters: {}, q: "" }));

  const hasColumnFilters = cols.some((c) => c.filter === "text" || c.filter === "select");
  const sorted = state.sort && byKey.get(state.sort.key) ? state.sort : null;

  // The filter row sticks directly under the header row, whose height depends
  // on whether a label wrapped - so measure it rather than assume.
  const headRef = useRef<HTMLTableRowElement | null>(null);
  const [headHeight, setHeadHeight] = useState(36);
  useEffect(() => {
    const el = headRef.current;
    if (!el) return undefined;
    const measure = () => setHeadHeight(el.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cols]);
  const filterTop = { top: `calc(var(--dt-top, 0px) + ${headHeight}px)` };

  const table = (
    <table className={`dt${dense ? " dt-dense" : ""}`}>
      <thead>
        <tr className="dt-head" ref={headRef}>
          {cols.map((c) => {
            const sortable = c.sortable !== false && !!c.label;
            const active = sorted && sorted.key === c.key;
            return (
              <th
                key={c.key}
                scope="col"
                className={`${c.align === "right" ? "dt-right" : c.align === "center" ? "dt-center" : ""}${c.headerClassName ? ` ${c.headerClassName}` : ""}`}
                style={c.width ? { width: c.width } : undefined}
                aria-sort={active ? (sorted.dir === "asc" ? "ascending" : "descending") : "none"}
              >
                {sortable ? (
                  <button
                    type="button"
                    className={`dt-sort${active ? " active" : ""}`}
                    onClick={() => toggleSort(c.key)}
                    title={`Sort by ${c.label}`}
                  >
                    <span className="dt-label">{c.label}</span>
                    <span className={`dt-arrow${active ? " active" : ""}`} aria-hidden="true">
                      {active ? (sorted.dir === "asc" ? "↑" : "↓") : "↕"}
                    </span>
                  </button>
                ) : (
                  <span className="dt-label dt-static">{c.label}</span>
                )}
              </th>
            );
          })}
        </tr>
        {hasColumnFilters && (
          <tr className="dt-filters">
            {cols.map((c) => (
              <td key={c.key} style={filterTop}>
                {c.filter === "text" ? (
                  <DebouncedInput
                    className="dt-filter"
                    value={state.filters[c.key] || ""}
                    onChange={(v) => setFilter(c.key, v)}
                    placeholder="filter"
                    aria-label={`Filter by ${c.label}`}
                  />
                ) : c.filter === "select" && (selectOptions[c.key] || []).length > 0 ? (
                  <select
                    className="dt-filter"
                    value={state.filters[c.key] || ""}
                    onChange={(e) => setFilter(c.key, e.target.value)}
                    aria-label={`Filter by ${c.label}`}
                  >
                    <option value="">all</option>
                    {(selectOptions[c.key] || []).map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : null}
              </td>
            ))}
          </tr>
        )}
      </thead>
      <tbody>
        {page.map((row, i) => {
          // A view can hand us rows from the previous query for a render (e.g.
          // the grouping changed but the refetch has not landed), so a row key
          // that does not resolve falls back to the index.
          const raw = typeof rowKey === "function" ? rowKey(row, i) : rowKey ? field(row, rowKey) : i;
          const key = raw == null || raw === "" ? i : (raw as string | number);
          const extra = expanded ? expanded(row) : null;
          const cls = [rowClassName ? rowClassName(row) : "", onRowClick ? "clickable" : ""].filter(Boolean).join(" ");
          return [
            <tr key={key} className={cls || undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {cols.map((c) => (
                <td
                  key={c.key}
                  className={`${c.className || ""}${c.align === "right" ? " dt-right" : c.align === "center" ? " dt-center" : ""}`.trim() || undefined}
                >
                  {c.render ? c.render(row) : field(row, c.key) == null ? null : String(field(row, c.key))}
                </td>
              ))}
            </tr>,
            extra ? (
              <tr key={`${key}--expanded`} className="dt-expanded">
                <td colSpan={cols.length}>{extra}</td>
              </tr>
            ) : null,
          ];
        })}
        {total === 0 && (
          <tr>
            <td colSpan={cols.length} className="empty">
              {all.length === 0 ? empty : "No rows match the filters."}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );

  return (
    <div className="dt-wrap">
      <div className="dt-bar">
        <DebouncedInput
          className="dt-search"
          value={state.q}
          onChange={(v) => setState((s) => ({ ...s, q: v }))}
          placeholder={searchPlaceholder}
          aria-label="Search this table"
        />
        {(paged || filtered) && (
          <span className="dt-count">
            {paged
              ? `${page.length} of ${total} shown${filtered ? ` · filtered from ${all.length}` : ""}`
              : `${total} of ${all.length}`}
          </span>
        )}
        {anyActive && (
          <button type="button" className="dt-clear" onClick={clear}>Clear</button>
        )}
      </div>
      {scroll ? <div className="scroll">{table}</div> : table}
      {paged && (
        <div className="dt-more">
          <button type="button" className="dt-clear" onClick={() => setShown((s) => s + pageSize)}>
            Show {Math.min(pageSize, total - page.length)} more
          </button>
          <button type="button" className="dt-clear" onClick={() => setShown(total)}>
            Show all {total}
          </button>
        </div>
      )}
      {footer != null && <div className="dt-foot">{footer}</div>}
    </div>
  );
}
