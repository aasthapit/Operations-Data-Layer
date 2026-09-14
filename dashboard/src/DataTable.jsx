// Reusable sortable / filterable table used by every table in the dashboard.
//
// Everything is client-side over the rows the view already fetched: the
// server-side FilterSelects in the views still narrow the API query, this only
// narrows what is on screen. Sort + filter state is kept per table `id` in
// localStorage so a reload keeps the user's view.
import { useEffect, useMemo, useRef, useState } from "react";

const PREFIX = "odl.table.";
// 2026-09-13, 2026-09-13T04:13:54+00:00, 2026-09-13 04:13:54
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// ---- persistence ----------------------------------------------------------
function normalizeSort(s) {
  if (!s) return null;
  if (typeof s === "string") return { key: s, dir: "asc" };
  if (typeof s === "object" && s.key) return { key: String(s.key), dir: s.dir === "desc" ? "desc" : "asc" };
  return null;
}

function loadState(id, columns, initialSort) {
  const base = { id, sort: normalizeSort(initialSort), filters: {}, q: "" };
  if (!id) return base;
  let saved = null;
  try {
    const raw = window.localStorage.getItem(PREFIX + id);
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null; // storage disabled or corrupt - fall back to the defaults
  }
  if (!saved || typeof saved !== "object") return base;

  const keys = new Set(columns.map((c) => c.key));
  const out = { ...base, filters: {} };
  // A sort on a column that no longer exists falls back to the view's default;
  // an explicit null means the user cleared the sort and we keep it cleared.
  if ("sort" in saved) {
    const s = normalizeSort(saved.sort);
    if (saved.sort === null) out.sort = null;
    else if (s && keys.has(s.key)) out.sort = s;
  }
  if (saved.filters && typeof saved.filters === "object") {
    for (const [k, v] of Object.entries(saved.filters)) {
      if (keys.has(k) && typeof v === "string" && v !== "") out.filters[k] = v;
    }
  }
  if (typeof saved.q === "string") out.q = saved.q;
  return out;
}

function saveState(id, state) {
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
function nodeText(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(" ");
  if (node.props && node.props.children !== undefined) return nodeText(node.props.children);
  return "";
}

function cellText(col, row) {
  if (col.filterValue) {
    const v = col.filterValue(row);
    return v == null ? "" : String(v);
  }
  const raw = row ? row[col.key] : undefined;
  if (Array.isArray(raw)) return raw.filter((x) => x != null && typeof x !== "object").join(", ");
  if (raw != null && typeof raw !== "object") return String(raw);
  if (col.render) return nodeText(col.render(row));
  if (col.sortValue) {
    const v = col.sortValue(row);
    if (v != null && typeof v !== "object") return String(v);
  }
  return "";
}

const isEmptyValue = (v) => v == null || (typeof v === "number" && Number.isNaN(v));

function compareValues(a, b) {
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
function DebouncedInput({ value, onChange, delay = 150, ...rest }) {
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
export default function DataTable({
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
}) {
  const cols = useMemo(() => (columns || []).filter(Boolean), [columns]);
  const all = useMemo(() => rows || [], [rows]);

  const [state, setState] = useState(() => loadState(id, cols, initialSort));
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
    const out = {};
    for (const c of cols) {
      if (c.filter !== "select") continue;
      const seen = new Set();
      for (const row of all) {
        const t = cellText(c, row);
        if (t !== "") seen.add(t);
      }
      out[c.key] = [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
    }
    return out;
  }, [cols, all]);

  const activeFilters = useMemo(
    () => Object.entries(state.filters).filter(([k, v]) => v && byKey.has(k)),
    [state.filters, byKey]
  );
  const query = state.q.trim().toLowerCase();

  const view = useMemo(() => {
    let out = all;
    if (query || activeFilters.length) {
      out = out.filter((row) => {
        for (const [k, v] of activeFilters) {
          const col = byKey.get(k);
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
    const sort = state.sort && byKey.get(state.sort.key) ? state.sort : null;
    if (sort) {
      const col = byKey.get(sort.key);
      const dir = sort.dir === "desc" ? -1 : 1;
      const valueOf = (row) => (col.sortValue ? col.sortValue(row) : row[col.key]);
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

  const defaultSort = normalizeSort(initialSort);
  const sortChanged = JSON.stringify(state.sort) !== JSON.stringify(defaultSort);
  const anyActive = activeFilters.length > 0 || query !== "" || sortChanged;
  const filtered = view.length !== all.length;

  const toggleSort = (key) =>
    setState((s) => {
      const cur = s.sort;
      if (!cur || cur.key !== key) return { ...s, sort: { key, dir: "asc" } };
      if (cur.dir === "asc") return { ...s, sort: { key, dir: "desc" } };
      return { ...s, sort: null };
    });

  const setFilter = (key, value) =>
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
  const headRef = useRef(null);
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
        {view.map((row, i) => {
          // A view can hand us rows from the previous query for a render (e.g.
          // the grouping changed but the refetch has not landed), so a row key
          // that does not resolve falls back to the index.
          const raw = typeof rowKey === "function" ? rowKey(row, i) : rowKey ? row[rowKey] : i;
          const key = raw == null || raw === "" ? i : raw;
          const extra = expanded ? expanded(row) : null;
          const cls = [rowClassName ? rowClassName(row) : "", onRowClick ? "clickable" : ""].filter(Boolean).join(" ");
          return [
            <tr key={key} className={cls || undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {cols.map((c) => (
                <td
                  key={c.key}
                  className={`${c.className || ""}${c.align === "right" ? " dt-right" : c.align === "center" ? " dt-center" : ""}`.trim() || undefined}
                >
                  {c.render ? c.render(row) : row[c.key] == null ? null : String(row[c.key])}
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
        {view.length === 0 && (
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
        {filtered && <span className="dt-count">{view.length} of {all.length}</span>}
        {anyActive && (
          <button type="button" className="dt-clear" onClick={clear}>Clear</button>
        )}
      </div>
      {scroll ? <div className="scroll">{table}</div> : table}
      {footer != null && <div className="dt-foot">{footer}</div>}
    </div>
  );
}
