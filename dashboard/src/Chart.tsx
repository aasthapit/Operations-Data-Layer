// Inline-SVG charts for a result set: a line (or area) over time, or bars by
// category. Nothing else - a query result either has a time axis, a category
// axis, or no chart at all, and the table underneath is always the full answer.
//
// There is no chart library here on purpose. What a chart of this kind needs is
// two scales, a path builder and a hover layer; a dependency would be larger
// than that and would bring its own colours, which this dashboard already has.
//
// The colours come from CSS variables (--series-1..8 for identity, --chart-line
// for a lone series). Status colours are never used as series colours: green
// here would mean "this series", not "healthy", and that is exactly the
// confusion the status tokens exist to avoid.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject,
} from "react";
import { fmtBytes, fmtCores } from "./components";
import type { QueryRow } from "./api/types";

// --------------------------------------------------------------------------- //
// limits
// --------------------------------------------------------------------------- //
const SERIES_CAP = 8;        // the categorical palette's last honest slot
const GROUPED_CAP = 4;       // grouped bars past four stop being readable
const BAR_CAP = 40;          // more bars than this is a table, not a chart
const SERIES_PICK_CAP = 24;  // a column with more values than this is not a series

// --------------------------------------------------------------------------- //
// what a chart is drawn from
// --------------------------------------------------------------------------- //
/** A result row as the query plane sends it: values positioned by column, read
 * through a `Field`'s index.
 *
 * Re-exported under the name the chart code reads best rather than redeclared:
 * `QueryRow` in `api/types.ts` is the one definition of a result row, and
 * `ResultTable` reads the same one. */
export type Row = QueryRow;

/** The two ways a row is read. Every value leaves here either narrowed to a
 * number or explicitly missing, so nothing downstream guesses. */
const cellAt = (row: Row, index: number): unknown => row[index];
const numberAt = (row: Row, index: number): number | null => {
  const v = row[index];
  return typeof v === "number" ? v : null;
};

/** What a column can be charted as. */
export type FieldKind = "number" | "cat" | "time" | "other";

/** One descriptor per result column. */
export interface Field {
  name: string;
  /** Position in the result's `columns`, which is how a row is indexed. */
  index: number;
  kind: FieldKind;
  /** An id-shaped name (`id`, `uid`, `generation`): a number, never a measure. */
  idLike: boolean;
  /** Distinct non-null values in the column; 0 for a kind that cannot be one. */
  distinct: number;
}

export type ChartType = "auto" | "line" | "bars" | "none";

/**
 * A saved or shared choice, before it has met a result.
 *
 * Every name in here may point at a column the result in hand does not have -
 * a saved query outlives the shape of its result - which is why this is a
 * different type from the `Spec` that actually gets drawn.
 */
export interface ChartChoice {
  type: ChartType;
  x: string;
  /** null means "let the chart decide"; "" means "no series". */
  series: string | null;
  y: string[];
  stack: boolean;
}

/** A drawable chart: `x` and every entry of `y` name a column this result has,
 * and `series` is a column or "" - never the null that means "decide". */
export interface Spec {
  type: "line" | "bars";
  x: string;
  series: string;
  y: string[];
  stack: boolean;
}

export const CHART_TYPES: ReadonlyArray<readonly [ChartType, string]> = [
  ["auto", "Auto"], ["line", "Line"], ["bars", "Bars"], ["none", "Table only"],
];

// --------------------------------------------------------------------------- //
// column kinds
// --------------------------------------------------------------------------- //
// The response carries `column_types` (DuckDB type names) when the API is new
// enough. When it does not, the values say what the column is - which is also
// the answer for a custom-SQL expression the server named no type for.
const NUMBER_TYPES = new Set([
  "INTEGER", "BIGINT", "DOUBLE", "FLOAT", "REAL", "DECIMAL", "SMALLINT", "TINYINT",
  "HUGEINT", "UBIGINT", "UINTEGER", "USMALLINT", "UTINYINT", "NUMERIC",
]);

// 2026-09-14, 2026-09-14T01:30:12.232501, 2026-09-14 01:30:12+00:00
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const ID_LIKE = /(^|_)(id|uid|uuid|generation|key)$/i;

function kindFromType(type: unknown): FieldKind | null {
  const t = String(type || "").toUpperCase().trim();
  if (!t) return null;
  const base = t.replace(/\(.*$/, "").trim();
  if (base === "DATE" || base.startsWith("TIMESTAMP") || base.startsWith("DATETIME")) return "time";
  if (base === "BOOLEAN" || base === "BOOL") return "cat";
  if (NUMBER_TYPES.has(base)) return "number";
  if (base === "JSON" || t.endsWith("[]") || base.startsWith("STRUCT")
    || base.startsWith("MAP") || base.startsWith("LIST") || base.startsWith("BLOB")) return "other";
  return "cat";
}

function kindFromValues(rows: Row[], i: number): FieldKind {
  let seen = 0;
  let numbers = 0;
  let dates = 0;
  let scalars = 0;
  for (const row of rows) {
    const v = row[i];
    if (v == null) continue;
    seen += 1;
    if (typeof v === "number") { numbers += 1; scalars += 1; continue; }
    if (typeof v === "boolean") { scalars += 1; continue; }
    if (typeof v === "string") {
      scalars += 1;
      if (ISO_DATE.test(v)) dates += 1;
      continue;
    }
    return "other";                                  // a JSON object or array
  }
  if (!seen) return "cat";                           // an all-null column charts as nothing
  if (numbers === seen) return "number";
  if (dates === seen) return "time";
  return scalars === seen ? "cat" : "other";
}

function distinctCount(rows: Row[], i: number): number {
  const seen = new Set<string>();
  for (const row of rows) {
    const v = row[i];
    if (v == null) continue;
    seen.add(typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return seen.size;
}

// One descriptor per result column: what it is, and how many values it has.
// Everything downstream (auto-detection, the control row, the chart itself)
// reads these rather than working it out again.
export function inferFields(columns?: readonly string[] | null,
  columnTypes?: readonly string[] | null, rows?: Row[] | null): Field[] {
  const data: Row[] = Array.isArray(rows) ? rows : [];
  return (columns || []).map((name, index): Field => {
    const declared = kindFromType(Array.isArray(columnTypes) ? columnTypes[index] : null);
    let kind = declared || kindFromValues(data, index);
    // A VARCHAR of ISO timestamps (a cast, a string_agg of dates) is still a
    // time axis, so the values get the last word over a declared text type.
    if (kind === "cat" && data.length && kindFromValues(data, index) === "time") kind = "time";
    return {
      name,
      index,
      kind,
      idLike: ID_LIKE.test(name),
      distinct: kind === "other" ? 0 : distinctCount(data, index),
    };
  });
}

const byName = (fields: Field[], name: string): Field | null =>
  fields.find((f) => f.name === name) || null;
const timeFields = (fields: Field[]): Field[] => fields.filter((f) => f.kind === "time");
const numberFields = (fields: Field[]): Field[] => fields.filter((f) => f.kind === "number");
const measureFields = (fields: Field[]): Field[] => numberFields(fields).filter((f) => !f.idLike);
export const categoryFields = (fields: Field[]): Field[] =>
  fields.filter((f) => f.kind === "cat");

// --------------------------------------------------------------------------- //
// shape detection
// --------------------------------------------------------------------------- //
// A time axis and something to measure is a line; one category and something to
// measure is bars; anything else is a table. The rules are deliberately narrow:
// a chart that appears when the data does not support one is worse than none.
function autoSpec(fields: Field[], rows?: Row[] | null): Spec | null {
  const data: Row[] = Array.isArray(rows) ? rows : [];
  const measures = measureFields(fields);
  if (!measures.length || data.length < 2) return null;

  // A column that names a different thing on every row (clusters.name, a
  // namespace, a node) means the result is a list of things, not a history of
  // one - so its `last_synced` is an attribute, not a time axis. An id-shaped
  // column is exempt: a table of collection runs keyed by id is still history.
  const entityList = categoryFields(fields).some(
    (f) => !f.idLike && f.distinct === data.length);

  const time = timeFields(fields)[0];
  if (time && !entityList) {
    if (distinctCount(data, time.index) < 2) return null;
    // A category that repeats down the result is what separates the rows: one
    // line per hub, per cluster, per reason.
    const series = categoryFields(fields).find(
      (f) => f.distinct >= 2 && f.distinct <= SERIES_PICK_CAP && f.distinct < data.length);
    return {
      type: "line",
      x: time.name,
      series: series ? series.name : "",
      // One measure per line when a series column already claims the colour
      // channel; otherwise every measure is a line of its own.
      y: series ? [measures[0].name] : measures.slice(0, SERIES_CAP).map((f) => f.name),
      stack: false,
    };
  }

  const cats = categoryFields(fields);
  if (cats.length === 1 && cats[0].distinct >= 2) {
    return {
      type: "bars",
      x: cats[0].name,
      series: "",
      y: measures.slice(0, GROUPED_CAP).map((f) => f.name),
      stack: false,
    };
  }
  return null;
}

// What the user asked for, when the data can carry it.
function forcedSpec(type: ChartType, fields: Field[], rows?: Row[] | null): Spec | null {
  const measures = measureFields(fields);
  const usable = measures.length ? measures : numberFields(fields);
  if (!usable.length) return null;
  if (type === "line") {
    const time = timeFields(fields)[0];
    if (!time) return null;
    const auto = autoSpec(fields, rows);
    if (auto && auto.type === "line") return auto;
    return { type: "line", x: time.name, series: "", y: [usable[0].name], stack: false };
  }
  const cat = categoryFields(fields)[0] || timeFields(fields)[0];
  if (!cat) return null;
  return {
    type: "bars",
    x: cat.name,
    series: "",
    y: usable.slice(0, GROUPED_CAP).map((f) => f.name),
    stack: false,
  };
}

// The saved / shared choice, with anything unrecognised falling back to Auto.
// `series: null` means "let the chart decide"; `series: ""` means "no series".
export function normalizeChart(raw: unknown): ChartChoice {
  // A choice arrives from localStorage, from a URL or from the API, so nothing
  // about it is known until it has been read field by field.
  const r = (raw ?? {}) as Partial<ChartChoice>;
  return {
    type: CHART_TYPE_IDS.includes(r.type as ChartType) ? (r.type as ChartType) : "auto",
    x: typeof r.x === "string" ? r.x : "",
    series: typeof r.series === "string" ? r.series : null,
    y: Array.isArray(r.y) ? r.y.filter((n): n is string => typeof n === "string") : [],
    stack: !!r.stack,
  };
}

const CHART_TYPE_IDS: ChartType[] = ["auto", "line", "bars", "none"];

export function emptyChart(): ChartChoice {
  return { type: "auto", x: "", series: null, y: [], stack: false };
}

// The spec the chart is actually drawn from: the detected shape with the user's
// picks laid over it, and null when what is left cannot be drawn. A pick naming
// a column this result does not have is ignored rather than fatal - a saved
// query outlives the shape of its result.
export function resolveSpec(fields: Field[], rows: Row[] | null | undefined,
  choice: unknown): Spec | null {
  const want = normalizeChart(choice);
  if (want.type === "none") return null;
  const base = want.type === "auto" ? autoSpec(fields, rows) : forcedSpec(want.type, fields, rows);
  if (!base) return null;

  const spec = { ...base };
  const line = spec.type === "line";

  const x = byName(fields, want.x);
  if (x && (line ? x.kind === "time" : x.kind !== "other")) spec.x = x.name;

  if (want.series !== null) {
    const s = byName(fields, want.series);
    spec.series = s && s.kind !== "other" && s.name !== spec.x ? s.name : "";
  }

  const measures = new Set(numberFields(fields).map((f) => f.name));
  const picked = want.y.filter((n) => measures.has(n) && n !== spec.x);
  if (picked.length) spec.y = picked;
  // A series column already spends the colour channel, so one measure is drawn.
  if (line && spec.series) spec.y = spec.y.slice(0, 1);
  if (!line) spec.y = spec.y.slice(0, GROUPED_CAP);
  spec.stack = line && !!want.stack;

  const xField = byName(fields, spec.x);
  if (!xField || !spec.y.length) return null;
  if (line && (xField.kind !== "time" || xField.distinct < 2)) return null;
  if (!line && (rows || []).length < 2) return null;
  return spec;
}

// --------------------------------------------------------------------------- //
// units and formatting
// --------------------------------------------------------------------------- //
// The unit is read off the column name where the naming is unambiguous. Nothing
// is guessed: a column the convention does not cover is formatted as a number.
/** The units the column-name convention covers. "" is "just a number". */
export type Unit = "" | "ms" | "s" | "bytes" | "percent" | "cores";

function unitOf(name: unknown): Unit {
  const n = String(name || "").toLowerCase();
  if (/_ms$/.test(n)) return "ms";
  if (/_seconds$/.test(n)) return "s";
  if (/_bytes$/.test(n)) return "bytes";
  if (/(_percent|_pct)$/.test(n)) return "percent";
  if (/_cores$/.test(n)) return "cores";
  return "";
}

const group = (n: number, digits = 0): string =>
  n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

function formatNumber(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return group(n);
  const abs = Math.abs(n);
  return group(n, abs >= 100 ? 0 : abs >= 1 ? 2 : 3);
}

function formatValue(v: unknown, unit: Unit): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  switch (unit) {
    case "ms": return n >= 10000 ? `${group(n / 1000, 1)} s` : `${formatNumber(n)} ms`;
    case "s": return n >= 120 ? `${group(n / 60, 1)} min` : `${formatNumber(n)} s`;
    case "bytes": return fmtBytes(n);
    case "percent": return `${group(n, Math.abs(n) >= 10 ? 0 : 1)}%`;
    case "cores": return fmtCores(n);
    default: return formatNumber(n);
  }
}

// Axis ticks are terser than tooltip values - they are read as a scale, not as
// an answer - so large numbers compact and the rest keep their separators.
function formatTick(v: number, unit: Unit): string {
  if (unit === "bytes") return fmtBytes(v);
  if (unit === "percent") return `${group(v, Number.isInteger(v) ? 0 : 1)}%`;
  const abs = Math.abs(v);
  if (abs >= 1000000) return `${group(v / 1000000, abs % 1000000 ? 1 : 0)}M`;
  if (abs >= 10000) return `${group(v / 1000, abs % 1000 ? 1 : 0)}k`;
  return formatNumber(v);
}

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A naive timestamp ("2026-09-14T01:30:12") is read as local time, which is what
// the table cell beside the chart shows too - the axis and the rows agree.
function parseTime(v: unknown): number | null {
  if (v == null) return null;
  const t = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** How wide the gap between two ticks is, which decides how a time is worded. */
type TimeUnit = "minute" | "hour" | "day" | "month";

function formatTimeTick(t: number, unit: TimeUnit): string {
  const d = new Date(t);
  if (unit === "minute" || unit === "hour") {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (unit === "day") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function formatTimeFull(t: number, unit: TimeUnit): string {
  const d = new Date(t);
  if (unit === "month") return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  if (unit === "day") {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// --------------------------------------------------------------------------- //
// scales
// --------------------------------------------------------------------------- //
// minStep is 1 for a count: "0, 0.5, 1, 1.5, 2 clusters" is not a thing, and an
// axis that offers half a cluster is worse than one with fewer gridlines.
/** An axis: the gridline values, and the range they span. */
interface Ticks {
  ticks: number[];
  lo: number;
  hi: number;
}

function niceTicks(min: number, max: number, count: number, minStep = 0): Ticks {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [0, 1], lo: 0, hi: 1 };
  if (min === max) {
    const pad = Math.abs(min) || 1;
    return niceTicks(min - pad / 2, max + pad / 2, count, minStep);
  }
  const raw = (max - min) / Math.max(2, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = Math.max(minStep, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // stepping from `lo` rather than accumulating keeps 0.1 + 0.2 off the axis
  for (let i = 0; lo + i * step <= hi + step / 1000; i += 1) {
    ticks.push(Number((lo + i * step).toPrecision(12)));
  }
  return { ticks, lo, hi };
}

// Tick spacing follows the span: minutes for an hour of sweeps, hours for a
// day, days for a month, months for a year.
function timeTicks(min: number, max: number, count: number): { ticks: number[]; unit: TimeUnit } {
  const span = Math.max(1, max - min);
  const fine = [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
    HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR];
  for (const step of fine) {
    if (span / step <= count) {
      const ticks: number[] = [];
      // aligned to a local boundary, so ticks land on :00 rather than on the
      // odd second the first sample happened to carry
      const offset = new Date(min).getTimezoneOffset() * MINUTE;
      for (let t = Math.ceil((min - offset) / step) * step + offset; t <= max; t += step) {
        ticks.push(t);
      }
      return { ticks, unit: step < HOUR ? "minute" : "hour" };
    }
  }
  for (const days of [1, 2, 3, 7, 14, 28]) {
    if (span / (days * DAY) <= count) {
      const ticks: number[] = [];
      const d = new Date(min);
      d.setHours(0, 0, 0, 0);
      if (d.getTime() < min) d.setDate(d.getDate() + 1);
      // stepping through Date keeps a daylight-saving change from drifting ticks
      while (d.getTime() <= max) { ticks.push(d.getTime()); d.setDate(d.getDate() + days); }
      return { ticks, unit: "day" };
    }
  }
  const ticks: number[] = [];
  const months = span / (365 * DAY) > 2 ? 3 : 1;
  const d = new Date(min);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() < min) d.setMonth(d.getMonth() + 1);
  while (d.getTime() <= max && ticks.length < 24) {
    ticks.push(d.getTime());
    d.setMonth(d.getMonth() + months);
  }
  return { ticks, unit: "month" };
}

// --------------------------------------------------------------------------- //
// text measurement
// --------------------------------------------------------------------------- //
const FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
let measureCtx: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

function textWidth(text: string | number, font: string = FONT): number {
  const key = `${font}|${text}`;
  const hit = widths.get(key);
  if (hit !== undefined) return hit;
  if (measureCtx === undefined) {
    try { measureCtx = document.createElement("canvas").getContext("2d"); } catch { measureCtx = null; }
  }
  let w: number;
  if (measureCtx) {
    measureCtx.font = font;
    w = measureCtx.measureText(String(text)).width;
  } else {
    w = String(text).length * 6.2;                   // no canvas: a usable estimate
  }
  if (widths.size > 4000) widths.clear();
  widths.set(key, w);
  return w;
}

// A label is never clipped: it is shortened until it fits, and the full text
// stays in the tooltip and in the table.
function ellipsize(text: unknown, max: number): string {
  const s = String(text);
  if (max <= 0) return "";
  if (textWidth(s) <= max) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${s.slice(0, mid)}…`) <= max) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? `${s.slice(0, lo)}…` : "";
}

// --------------------------------------------------------------------------- //
// colours
// --------------------------------------------------------------------------- //
// Eight categorical slots in the order they were validated for this surface.
// The colour follows the series, not its rank, so hiding one never repaints
// the others.
const SERIES_COLORS = Array.from({ length: SERIES_CAP }, (_, i) => `var(--series-${i + 1})`);
const colorAt = (i: number, total: number): string => (total <= 1 ? "var(--chart-line)" : SERIES_COLORS[i % SERIES_COLORS.length]);

// --------------------------------------------------------------------------- //
// models
// --------------------------------------------------------------------------- //
const keyOf = (v: unknown): string => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

// Rows in one sweep are written a few milliseconds apart, so two clusters
// never share a timestamp exactly. The crosshair therefore matches the nearest
// sample within a series' own sampling interval rather than on equality.
/** One sample of one line. A null value is a gap, never a zero. */
interface LinePoint {
  t: number;
  v: number | null;
}

/** One sample of one stacked band: where it starts, where it ends, and the
 * value it carried (null when the band is holding the last reading forward). */
interface BandPoint {
  t: number;
  base: number;
  top: number;
  v: number | null;
}

interface LineSeries {
  key: string;
  label: string;
  unit: Unit;
  points: LinePoint[];
  /** How far from a stamp a sample still counts as that stamp's, derived from
   * the series' own sampling interval. */
  tol: number;
  /** The sum of |v|, which is how the series past the palette cap are ranked. */
  total: number;
  /** Assigned once the series that survive the cap are known, so it is not part
   * of what the builder first puts together. */
  color?: string;
  /** Only a stacked model has bands. */
  band?: BandPoint[];
}

export interface LineModel {
  series: LineSeries[];
  stamps: number[];
  stacked: boolean;
  /** What the caption says about anything the chart had to leave out. */
  note: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  integer: boolean;
  unit: Unit;
  xLabel: string;
  measureLabel: string;
  ariaLabel?: string;
}

interface BarItem {
  key: string;
  label: string;
  /** One entry per measure, in the order the series are drawn. */
  values: Array<number | null>;
}

interface BarSeries {
  key: string;
  label: string;
  unit: Unit;
  color: string;
}

export interface BarModel {
  items: BarItem[];
  series: BarSeries[];
  note: string;
  lo: number;
  hi: number;
  integer: boolean;
  unit: Unit;
  xLabel: string;
  ariaLabel?: string;
}

/** One category's samples while they are still being collected by timestamp. */
interface Bucket {
  key: string;
  measure: Field;
  points: Map<number, number | null>;
}

function medianGap(points: readonly LinePoint[]): number {
  if (points.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i += 1) gaps.push(points[i].t - points[i - 1].t);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function nearestPoint(points: readonly LinePoint[], t: number, tol: number): LinePoint | null {
  if (!points.length) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1; else hi = mid;
  }
  let best: LinePoint | null = null;
  for (const p of [points[lo], points[lo - 1]]) {
    if (!p) continue;
    const d = Math.abs(p.t - t);
    if (d <= tol && (!best || d < Math.abs(best.t - t))) best = p;
  }
  return best;
}

function buildLineModel(fields: Field[], rows: Row[], spec: Spec): LineModel | null {
  const x = byName(fields, spec.x);
  const seriesField = spec.series ? byName(fields, spec.series) : null;
  const measures = spec.y.map((n) => byName(fields, n)).filter((f): f is Field => !!f);
  if (!x || !measures.length) return null;

  // One bucket per category (or per measure, when there is no category column).
  // A missing value stays missing: a gap in the line, never a zero.
  const groups = new Map<string, Bucket>();
  const bucket = (key: string, measure: Field): Bucket => {
    let g = groups.get(key);
    if (!g) { g = { key, measure, points: new Map() }; groups.set(key, g); }
    return g;
  };
  for (const row of rows) {
    const t = parseTime(cellAt(row, x.index));
    if (t == null) continue;
    if (seriesField) {
      const g = bucket(keyOf(cellAt(row, seriesField.index)), measures[0]);
      g.points.set(t, numberAt(row, measures[0].index));
    } else {
      for (const m of measures) {
        const g = bucket(m.name, m);
        g.points.set(t, numberAt(row, m.index));
      }
    }
  }

  let series: LineSeries[] = [...groups.values()].map((g) => {
    const points = [...g.points.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
    return {
      key: g.key,
      label: g.key,
      unit: unitOf(g.measure.name),
      points,
      tol: medianGap(points) * 0.75,
      total: points.reduce((sum, p) => sum + (p.v == null ? 0 : Math.abs(p.v)), 0),
    };
  });
  if (!series.length) return null;

  // Past eight lines the palette stops telling them apart. Stacked, the tail is
  // a real part of the whole and is summed into "Other"; unstacked, summing
  // unrelated measurements would invent a number, so the tail is left out and
  // the caption says which.
  let note = "";
  if (series.length > SERIES_CAP) {
    const keep = spec.stack ? SERIES_CAP - 1 : SERIES_CAP;
    const ranked = [...series].sort((a, b) => b.total - a.total);
    const kept = new Set(ranked.slice(0, keep).map((s) => s.key));
    const rest = ranked.slice(keep);
    series = series.filter((s) => kept.has(s.key));
    if (spec.stack) {
      const summed = new Map<number, number>();
      for (const s of rest) {
        for (const p of s.points) {
          if (p.v == null) continue;
          summed.set(p.t, (summed.get(p.t) || 0) + p.v);
        }
      }
      const points = [...summed.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
      series.push({
        key: "__other__",
        label: "Other",
        unit: series[0].unit,
        points,
        tol: medianGap(points) * 0.75,
        total: 0,
      });
      note = `${rest.length} smaller series summed into "Other"`;
    } else {
      note = `the ${SERIES_CAP} largest of ${SERIES_CAP + rest.length} series - the rest are in the table`;
    }
  }

  for (const s of series) {
    if (!(s.tol > 0)) s.tol = Math.max(MINUTE, (s.points[s.points.length - 1]?.t - s.points[0]?.t || 0) / 20);
  }
  series.forEach((s, i) => { s.color = colorAt(i, series.length); });

  const stamps = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
  const stacked = !!spec.stack && series.length > 1;
  let lo = 0;
  let hi = 0;

  if (stacked) {
    // A stack is read as a total, so every band needs a value at every stamp.
    // Each series contributes its nearest sample, or the last one it had -
    // which is what the sweep before this one actually measured.
    const running = new Map<number, number>(stamps.map((t): [number, number] => [t, 0]));
    for (const s of series) {
      let carried = 0;
      s.band = stamps.map((t) => {
        const p = nearestPoint(s.points, t, Math.max(s.tol, MINUTE));
        const v = p && p.v != null ? p.v : carried;
        carried = v;
        // `running` is seeded with every stamp above, so a miss and a zero
        // are the same number - which is what `?? 0` says.
        const base = running.get(t) ?? 0;
        running.set(t, base + v);
        return { t, base, top: base + v, v: p && p.v != null ? p.v : null };
      });
    }
    hi = Math.max(0, ...running.values());
    note = note ? `${note} · stacked on a shared time grid` : "stacked on a shared time grid";
  } else {
    const values = series.flatMap((s) => s.points.map((p) => p.v))
      .filter((v): v is number => v != null);
    if (!values.length) return null;
    lo = Math.min(0, ...values);
    hi = Math.max(...values, 0);
  }
  const plotted = series.flatMap((s) => s.points.map((p) => p.v))
    .filter((v): v is number => v != null);
  const integer = plotted.every(Number.isInteger);

  const units = new Set(series.map((s) => s.unit));
  return {
    series,
    stamps,
    stacked,
    note,
    xMin: stamps[0],
    xMax: stamps[stamps.length - 1],
    yMin: lo,
    yMax: hi,
    integer,
    unit: units.size === 1 ? [...units][0] : "",
    xLabel: x.name,
    measureLabel: seriesField ? measures[0].name : spec.y.join(", "),
  };
}

function buildBarModel(fields: Field[], rows: Row[], spec: Spec): BarModel | null {
  const x = byName(fields, spec.x);
  const measures = spec.y.map((n) => byName(fields, n))
    .filter((f): f is Field => !!f).slice(0, GROUPED_CAP);
  if (!x || !measures.length) return null;

  // Bars keep the order the query returned them in - the ORDER BY is the
  // author's answer to "sorted how", and re-sorting here would overrule it.
  const shown = rows.slice(0, BAR_CAP);
  const items: BarItem[] = shown.map((row, i) => ({
    key: `${i}:${keyOf(cellAt(row, x.index))}`,
    label: keyOf(cellAt(row, x.index)),
    values: measures.map((m) => numberAt(row, m.index)),
  }));
  const flat = items.flatMap((it) => it.values).filter((v): v is number => v != null);
  if (!flat.length) return null;

  const series: BarSeries[] = measures.map((m, i) => ({
    key: m.name, label: m.name, unit: unitOf(m.name), color: colorAt(i, measures.length),
  }));
  const units = new Set(series.map((s) => s.unit));
  return {
    items,
    series,
    note: rows.length > BAR_CAP ? `the first ${BAR_CAP} of ${rows.length} rows` : "",
    lo: Math.min(0, ...flat),
    hi: Math.max(0, ...flat),
    integer: flat.every(Number.isInteger),
    unit: units.size === 1 ? [...units][0] : "",
    xLabel: x.name,
  };
}

// --------------------------------------------------------------------------- //
// shared pieces
// --------------------------------------------------------------------------- //
// The SVG is drawn at the width it actually has, so labels are measured against
// real pixels rather than a guess a media query later breaks.
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setWidth(Math.round(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver !== "function") {
      window.addEventListener("resize", read);
      return () => window.removeEventListener("resize", read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

// A legend is the dependable identity channel and is always there for two or
// more series; direct labels on the marks supplement it, never replace it.
/** All a legend needs of a series, which both models happen to carry. */
interface LegendEntry {
  key: string;
  label: string;
  color?: string;
}

interface LegendProps {
  series: readonly LegendEntry[];
  mark: "line" | "box";
}

function Legend({ series, mark }: LegendProps) {
  if (series.length < 2) return null;
  return (
    <div className="chart-legend">
      {series.map((s) => (
        <span className="chart-key" key={s.key}>
          <span className={mark === "line" ? "chart-key-line" : "chart-key-box"}
            style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

// Values lead, series names follow: the reader already knows which line they
// are looking at and came for the number.
const TIP_WIDTH = 240;                               // matches .chart-tip's max-width

/** One line of the readout: which series, and what it read. */
interface TipRow {
  key: string;
  label: string;
  color?: string;
  value: string;
}

/** The readout itself, positioned in the plot's own pixels. */
interface Tip {
  x: number;
  y: number;
  head: string;
  rows: TipRow[];
}

interface TooltipProps {
  tip: Tip | null;
  width: number;
}

function Tooltip({ tip, width }: TooltipProps) {
  if (!tip) return null;
  // The readout never leaves the card: near the right edge it flips to the
  // other side of what it is describing.
  const flip = tip.x > width - (TIP_WIDTH + 14);
  return (
    <div
      className="chart-tip"
      aria-hidden="true"
      style={{
        left: Math.max(0, Math.min(tip.x, width)),
        top: tip.y,
        transform: `translate(${flip ? "calc(-100% - 12px)" : "12px"}, -50%)`,
      }}
    >
      <div className="chart-tip-head">{tip.head}</div>
      {tip.rows.map((r) => (
        <div className="chart-tip-row" key={r.key}>
          <span className="chart-key-line" style={{ background: r.color }} />
          <span className="chart-tip-name">{r.label}</span>
          <span className="chart-tip-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

// A null is a gap: the pen lifts and the next run starts a new subpath.
/** A point on the plot. A null y is a gap the pen lifts over. */
interface PathPoint {
  x: number;
  y: number | null;
}

function linePath(points: readonly PathPoint[]): string {
  let d = "";
  let pen = false;
  for (const p of points) {
    if (p.y == null) { pen = false; continue; }
    d += `${pen ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

// The area under a single line, one closed shape per run of real values.
/** A point that has a value. The area under a line is made of runs of these,
 * so the gaps are gone by the time a run is built rather than re-checked at
 * every read of `y`. */
type SolidPoint = { x: number; y: number };

function areaPath(points: readonly PathPoint[], baseY: number): string {
  let d = "";
  let run: SolidPoint[] = [];
  const flush = () => {
    if (run.length > 1) {
      d += `M${run[0].x.toFixed(1)},${baseY.toFixed(1)}`;
      for (const p of run) d += `L${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      d += `L${run[run.length - 1].x.toFixed(1)},${baseY.toFixed(1)}Z`;
    }
    run = [];
  };
  for (const p of points) {
    if (p.y == null) flush(); else run.push({ x: p.x, y: p.y });
  }
  flush();
  return d;
}

// A bar with its data end rounded and its baseline end square.
function barPath(x: number, y: number, w: number, h: number, r: number,
  horizontal: boolean): string {
  const radius = Math.max(0, Math.min(r, horizontal ? w : h, (horizontal ? h : w) / 2));
  if (radius <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  if (horizontal) {
    return `M${x},${y}h${w - radius}a${radius},${radius} 0 0 1 ${radius},${radius}`
      + `v${h - 2 * radius}a${radius},${radius} 0 0 1 ${-radius},${radius}h${-(w - radius)}Z`;
  }
  return `M${x},${y + h}v${-(h - radius)}a${radius},${radius} 0 0 1 ${radius},${-radius}`
    + `h${w - 2 * radius}a${radius},${radius} 0 0 1 ${radius},${radius}v${h - radius}Z`;
}

// Enough headroom for the value label a vertical bar chart draws above its
// tallest bar: at 10px the glyphs of a bar that reaches the top gridline were
// clipped by the top of the SVG.
const PAD_TOP = 16;
const AXIS_H = 24;

// --------------------------------------------------------------------------- //
// line
// --------------------------------------------------------------------------- //
interface LineChartProps {
  model: LineModel;
  height: number;
}

function LineChart({ model, height }: LineChartProps) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useWidth(wrap);
  const [hover, setHover] = useState<number | null>(null);   // an index into model.stamps

  const layout = useMemo(() => {
    if (!width) return null;
    const { ticks: yTicks, lo, hi } = niceTicks(model.yMin, model.yMax,
      Math.max(2, Math.floor(height / 48)), model.integer ? 1 : 0);
    const yLabels = yTicks.map((t) => formatTick(t, model.unit));
    const left = Math.min(90, Math.max(...yLabels.map((t) => textWidth(t))) + 10);

    // Direct labels ride the line ends for a handful of series; past four, or
    // when two ends converge, the legend carries identity on its own.
    const labelled = model.series.length <= 4 && !model.stacked;
    const labelWidth = labelled
      ? Math.min(124, Math.max(0, ...model.series.map((s) => textWidth(s.label))) + 10)
      : 0;
    const plotW = Math.max(40, width - left - Math.max(10, labelWidth));
    const plotH = Math.max(40, height - PAD_TOP - AXIS_H);
    const xScale = (t: number) => left + (model.xMax === model.xMin
      ? plotW / 2
      : ((t - model.xMin) / (model.xMax - model.xMin)) * plotW);
    const yScale = (v: number) => PAD_TOP + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
    const time = timeTicks(model.xMin, model.xMax, Math.max(2, Math.floor(plotW / 80)));
    return {
      left, plotW, plotH, xScale, yScale, yTicks, yLabels, labelled, labelWidth,
      xTicks: time.ticks, xUnit: time.unit,
    };
  }, [width, height, model]);

  const onMove = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    if (!layout || !model.stamps.length) return;
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    let best = 0;
    let bestD = Infinity;
    model.stamps.forEach((t, i) => {
      const d = Math.abs(layout.xScale(t) - px);
      if (d < bestD) { bestD = d; best = i; }
    });
    setHover(best);
  }, [layout, model]);

  // Keyboard reads the same values as the pointer: the crosshair steps along
  // the axis, and Escape puts it away.
  const onKey = useCallback((e: ReactKeyboardEvent<SVGSVGElement>) => {
    const last = model.stamps.length - 1;
    if (last < 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setHover((h) => Math.max(0, Math.min(last, h == null ? (step > 0 ? 0 : last) : h + step)));
    } else if (e.key === "Escape") {
      setHover(null);
    }
  }, [model]);

  if (!layout) return <div className="chart-plot" ref={wrap} style={{ height }} />;

  const { left, plotW, plotH, xScale, yScale, yTicks, yLabels, xTicks, xUnit, labelled } = layout;
  const single = model.series.length === 1 && !model.stacked;
  const hoverT = hover != null ? model.stamps[hover] : null;
  const baseY = yScale(0);
  let lastLabelEnd = -Infinity;

  // What each series is showing at the hovered stamp: the sample itself (only
  // when it has a value - a gap is "—" rather than a dot), and the y it is
  // drawn at, which is the band's top when the model is stacked and the value
  // itself when it is not. `top` is null exactly when `point` is, so the dot
  // and the tooltip row agree without either re-deciding.
  const hovered: Array<{ series: LineSeries; point: LinePoint | null; top: number | null }> =
    hoverT == null ? [] : model.series.map((s) => {
      // A stacked model always has bands; `|| []` says so to the compiler
      // rather than adding a case the drawing would have to handle.
      const band = model.stacked ? (s.band || []).find((b) => b.t === hoverT) : null;
      if (model.stacked) {
        return band && band.v != null
          ? { series: s, point: band, top: band.top }
          : { series: s, point: null, top: null };
      }
      const p = nearestPoint(s.points, hoverT, s.tol);
      return p && p.v != null
        ? { series: s, point: p, top: p.v }
        : { series: s, point: null, top: null };
    });

  return (
    <div className="chart-plot" ref={wrap}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={model.ariaLabel}
        tabIndex={0}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={onKey}
      >
        {/* grid: solid hairlines one step off the surface, never dashed */}
        <g className="chart-grid">
          {yTicks.map((t) => (
            <line key={t} x1={left} x2={left + plotW} y1={yScale(t)} y2={yScale(t)}
              strokeWidth="1" shapeRendering="crispEdges" opacity={t === 0 ? 1 : 0.65} />
          ))}
        </g>
        <g className="chart-axis">
          {yTicks.map((t, i) => (
            <text key={t} x={left - 6} y={yScale(t)} textAnchor="end" dominantBaseline="middle">
              {yLabels[i]}
            </text>
          ))}
          {xTicks.map((t) => {
            const label = formatTimeTick(t, xUnit);
            const cx = xScale(t);
            const half = textWidth(label) / 2;
            if (cx - half < left - 6 || cx + half > left + plotW + 6 || cx - half < lastLabelEnd + 10) {
              return null;
            }
            lastLabelEnd = cx + half;
            return (
              <text key={t} x={cx} y={PAD_TOP + plotH + 14} textAnchor="middle"
                dominantBaseline="hanging">{label}</text>
            );
          })}
        </g>

        {model.stacked
          ? model.series.map((s) => {
            // Only a stacked model has bands, and this is the stacked branch -
            // the fallback is what says so to the compiler rather than a
            // second case the drawing has to handle.
            const band = s.band || [];
            return (
              // a 1px inset top and bottom is the surface gap between bands:
              // the separation is air, never a stroke around the fill
              <path
                key={s.key}
                d={`${band.map((b, i) => `${i ? "L" : "M"}${xScale(b.t).toFixed(1)},${(yScale(b.top) + 1).toFixed(1)}`).join("")}`
                  + `${[...band].reverse().map((b) => `L${xScale(b.t).toFixed(1)},${(yScale(b.base) - 1).toFixed(1)}`).join("")}Z`}
                fill={s.color}
                fillOpacity="0.62"
              />
            );
          })
          : model.series.map((s) => {
            const pts = s.points.map((p) => ({ x: xScale(p.t), y: p.v == null ? null : yScale(p.v) }));
            return (
              <g key={s.key}>
                {single && <path d={areaPath(pts, baseY)} fill={s.color} fillOpacity="0.1" />}
                <path d={linePath(pts)} fill="none" stroke={s.color} strokeWidth="2"
                  strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}

        {/* the crosshair finds the X: the reader aims at a time, not at a line */}
        {hoverT != null && (
          <g>
            <line className="chart-crosshair" x1={xScale(hoverT)} x2={xScale(hoverT)}
              y1={PAD_TOP} y2={PAD_TOP + plotH} strokeWidth="1" shapeRendering="crispEdges" />
            {hovered.map((h) => (h.point == null || h.top == null ? null : (
              <circle key={h.series.key} className="chart-dot" cx={xScale(h.point.t)}
                cy={yScale(h.top)} r="4.5" fill={h.series.color} strokeWidth="2" />
            )))}
          </g>
        )}

        {/* end labels ride the lines only where they will not collide */}
        {labelled && model.series.map((s) => {
          // `find` already answered "the last point that has a value", so the
          // two reads below are of a number - the extra null test is what says
          // that where the compiler can see it.
          const last = [...s.points].reverse().find((p) => p.v != null);
          if (!last || last.v == null) return null;
          const y = yScale(last.v);
          const clash = model.series.some((o) => {
            if (o === s) return false;
            const p = [...o.points].reverse().find((q) => q.v != null);
            return p != null && p.v != null && Math.abs(yScale(p.v) - y) < 13;
          });
          if (clash) return null;
          return (
            <text key={s.key} className="chart-end-label" x={left + plotW + 6} y={y}
              dominantBaseline="middle">
              {ellipsize(s.label, layout.labelWidth - 8)}
            </text>
          );
        })}
      </svg>
      {hoverT != null && (
        <Tooltip
          width={width}
          tip={{
            x: xScale(hoverT),
            y: height / 2,
            head: formatTimeFull(hoverT, xUnit),
            rows: hovered.map((h) => ({
              key: h.series.key,
              label: h.series.label,
              color: h.series.color,
              value: h.point ? formatValue(h.point.v, h.series.unit) : "—",
            })),
          }}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// bars
// --------------------------------------------------------------------------- //
interface BarChartProps {
  model: BarModel;
  height: number;
}

function BarChart({ model, height }: BarChartProps) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useWidth(wrap);
  const [hover, setHover] = useState<string | null>(null);   // "item:series"

  const longest = useMemo(
    () => Math.max(0, ...model.items.map((it) => textWidth(it.label))), [model]);
  // Horizontal once labels stop fitting under a column - which is most real
  // category axes here: cluster names, reasons, check titles.
  const horizontal = model.items.length > 12 || longest > 72;
  const count = model.series.length;
  const rowBand = Math.max(22, count * 14 + 12);
  const plotH = horizontal
    ? model.items.length * rowBand
    : Math.max(110, height - PAD_TOP - AXIS_H - 2);
  const svgHeight = horizontal ? PAD_TOP + plotH + AXIS_H : height;

  // The value labels' width decides how much room the bars leave for them.
  const widestValue = useMemo(() => Math.max(0, ...model.items.flatMap(
    (it) => it.values.map((v, j) => (v == null ? 0 : textWidth(formatValue(v, model.series[j].unit)))))), [model]);
  const vertical = useMemo(() => niceTicks(model.lo, model.hi, 4, model.integer ? 1 : 0), [model]);

  const left = horizontal
    ? Math.min(Math.max(56, longest + 12), Math.round((width || 600) * 0.38))
    : Math.min(90, Math.max(...vertical.ticks.map((t) => textWidth(formatTick(t, model.unit)))) + 10);
  const right = horizontal ? Math.min(92, widestValue + 14) : 10;
  const plotW = Math.max(40, (width || 600) - left - right);

  const scale = horizontal
    ? niceTicks(model.lo, model.hi, Math.max(2, Math.floor(plotW / 110)), model.integer ? 1 : 0)
    : vertical;
  const { ticks, lo, hi } = scale;
  const zero = Math.max(lo, Math.min(0, hi));
  const vx = (v: number) => left + ((v - lo) / (hi - lo || 1)) * plotW;
  const vy = (v: number) => PAD_TOP + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  const onKey = useCallback((e: ReactKeyboardEvent<SVGSVGElement>) => {
    const last = model.items.length - 1;
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Escape") return;
    if (e.key === "Escape") { setHover(null); return; }
    e.preventDefault();
    const step = e.key === "ArrowRight" ? 1 : -1;
    setHover((h) => {
      const i = h == null ? (step > 0 ? 0 : last) : Math.max(0, Math.min(last, Number(h.split(":")[0]) + step));
      return `${i}:0`;
    });
  }, [model]);

  if (!width) return <div className="chart-plot" ref={wrap} style={{ height: svgHeight }} />;

  const bars: ReactNode[] = [];
  const labels: ReactNode[] = [];
  // Two columns in a wide card would otherwise sit a quarter of a screen
  // apart. The band is capped and the set is centred, so the bars stay a group
  // and the leftover stays air.
  const usedW = Math.min(plotW, model.items.length * 96);
  const originX = left + (plotW - usedW) / 2;
  const band = horizontal ? rowBand : usedW / model.items.length;
  const thickness = horizontal
    ? Math.min(24, (rowBand - 8 - 2 * (count - 1)) / count)
    : Math.min(24, (Math.max(6, band - 8) - 2 * (count - 1)) / count);

  model.items.forEach((item, i) => {
    const groupSize = thickness * count + 2 * (count - 1);
    item.values.forEach((v, j) => {
      if (v == null) return;
      const key = `${i}:${j}`;
      const color = model.series[j].color;
      const dim = hover && hover !== key && hover.split(":")[0] !== String(i);
      const text = formatValue(v, model.series[j].unit);
      if (horizontal) {
        const y = PAD_TOP + i * rowBand + (rowBand - groupSize) / 2 + j * (thickness + 2);
        const x = Math.min(vx(zero), vx(v));
        const w = Math.abs(vx(v) - vx(zero));
        // zero gets no mark and no label: a one-pixel sliver reads as "a
        // little", which is not what zero means. The table still has it.
        if (w < 0.5) return;
        bars.push(
          <path key={key} className="chart-bar" d={barPath(x, y, w, thickness, 4, true)}
            fill={color} opacity={dim ? 0.68 : 1}
            onPointerEnter={() => setHover(key)} />
        );
        if (thickness >= 11 && x + w + 6 + textWidth(text) <= width - 2) {
          labels.push(
            <text key={`v${key}`} className="chart-value" x={x + w + 6} y={y + thickness / 2}
              dominantBaseline="middle">{text}</text>
          );
        }
      } else {
        const x = originX + i * band + (band - groupSize) / 2 + j * (thickness + 2);
        const y = Math.min(vy(zero), vy(v));
        const h = Math.abs(vy(v) - vy(zero));
        if (h < 0.5) return;
        bars.push(
          <path key={key} className="chart-bar" d={barPath(x, y, thickness, h, 4, false)}
            fill={color} opacity={dim ? 0.68 : 1}
            onPointerEnter={() => setHover(key)} />
        );
        if (count === 1 && textWidth(text) <= band - 4) {
          labels.push(
            <text key={`v${key}`} className="chart-value" x={x + thickness / 2} y={y - 5}
              textAnchor="middle">{text}</text>
          );
        }
      }
    });
    const label = horizontal
      ? ellipsize(item.label, left - 14)
      : ellipsize(item.label, band - 6);
    if (label) {
      labels.push(horizontal ? (
        <text key={`c${i}`} className="chart-axis-text" x={left - 8}
          y={PAD_TOP + i * rowBand + rowBand / 2} textAnchor="end" dominantBaseline="middle">
          {label}
        </text>
      ) : (
        <text key={`c${i}`} className="chart-axis-text" x={originX + i * band + band / 2}
          y={PAD_TOP + plotH + 8} textAnchor="middle" dominantBaseline="hanging">{label}</text>
      ));
    }
  });

  const picked = hover ? Number(hover.split(":")[0]) : null;
  const item = picked == null ? null : model.items[picked];
  const tip: Tip | null = !item || picked == null ? null : {
    x: horizontal
      ? Math.min(vx(Math.max(...item.values.filter((v): v is number => v != null), zero)), width - 4)
      : originX + picked * band + band / 2,
    y: horizontal ? PAD_TOP + picked * rowBand + rowBand / 2 : svgHeight / 2,
    head: item.label,
    rows: model.series.map((s, k) => ({
      key: s.key,
      label: s.label,
      color: s.color,
      value: item.values[k] == null ? "—" : formatValue(item.values[k], s.unit),
    })),
  };

  return (
    <div className="chart-plot" ref={wrap}>
      <svg
        width="100%"
        height={svgHeight}
        viewBox={`0 0 ${width} ${svgHeight}`}
        role="img"
        aria-label={model.ariaLabel}
        tabIndex={0}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={onKey}
      >
        <g className="chart-grid">
          {ticks.map((t) => (horizontal ? (
            <line key={t} x1={vx(t)} x2={vx(t)} y1={PAD_TOP} y2={PAD_TOP + plotH} strokeWidth="1"
              shapeRendering="crispEdges" opacity={t === zero ? 1 : 0.65} />
          ) : (
            <line key={t} x1={left} x2={left + plotW} y1={vy(t)} y2={vy(t)} strokeWidth="1"
              shapeRendering="crispEdges" opacity={t === zero ? 1 : 0.65} />
          )))}
        </g>
        <g className="chart-axis">
          {ticks.map((t) => (horizontal ? (
            <text key={t} x={vx(t)} y={PAD_TOP + plotH + 8} textAnchor="middle"
              dominantBaseline="hanging">{formatTick(t, model.unit)}</text>
          ) : (
            <text key={t} x={left - 6} y={vy(t)} textAnchor="end" dominantBaseline="middle">
              {formatTick(t, model.unit)}
            </text>
          )))}
        </g>
        {bars}
        <g className="chart-axis">{labels}</g>
      </svg>
      {tip && <Tooltip tip={tip} width={width} />}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// the component
// --------------------------------------------------------------------------- //
// The chart is one image to a screen reader; the label says what is in it and
// where the values themselves are. The table under a query result is that
// place - the cluster timeline has no table, so it does not claim one.
const TABLE_NOTE = " The table below has every value.";

function lineAria(model: LineModel, tableBelow: boolean): string {
  const who = model.series.length === 1
    ? model.series[0].label
    : `${model.series.length} series (${model.series.slice(0, 6).map((s) => s.label).join(", ")}${model.series.length > 6 ? ", and more" : ""})`;
  return `Line chart of ${model.measureLabel} over ${model.xLabel}: ${who}, from `
    + `${formatTimeFull(model.xMin, "minute")} to ${formatTimeFull(model.xMax, "minute")}.`
    + (tableBelow ? TABLE_NOTE : "");
}

function barAria(model: BarModel, tableBelow: boolean): string {
  return `Bar chart of ${model.series.map((s) => s.label).join(", ")} by ${model.xLabel}: `
    + `${model.items.length} categories, ${model.items[0].label} to `
    + `${model.items[model.items.length - 1].label}.`
    + (tableBelow ? TABLE_NOTE : "");
}

// columns / columnTypes / rows are the query response as it arrived; spec is
// what resolveSpec worked out from it. A caller that hands in something
// undrawable gets nothing back rather than an empty frame.
export interface ChartProps {
  /** The query response as it arrived. */
  columns?: readonly string[] | null;
  columnTypes?: readonly string[] | null;
  rows?: Row[] | null;
  /** What `resolveSpec` made of the user's choice; null draws nothing. */
  spec?: Spec | null;
  /** The fields, when the caller has already inferred them (a panel infers them
   * once and uses them for both the control row and the chart). */
  fields?: Field[] | null;
  height?: number;
  /** Whether the reader has the table under the chart, which is what the
   * accessible label points at for the values themselves. */
  tableBelow?: boolean;
}

export default function Chart({
  columns, columnTypes, rows, spec, fields: given, height = 260, tableBelow = true,
}: ChartProps) {
  const fields = useMemo(
    () => given || inferFields(columns, columnTypes, rows), [given, columns, columnTypes, rows]);
  // Built one branch at a time rather than as a union, so each aria label is
  // written from the model it is describing.
  const model = useMemo(() => {
    if (!spec) return null;
    if (spec.type === "line") {
      const built = buildLineModel(fields, rows || [], spec);
      if (!built) return null;
      built.ariaLabel = lineAria(built, tableBelow);
      return built;
    }
    const built = buildBarModel(fields, rows || [], spec);
    if (!built) return null;
    built.ariaLabel = barAria(built, tableBelow);
    return built;
  }, [fields, rows, spec, tableBelow]);

  // A model only exists when a spec produced it, so the second test is what
  // says so to the type checker rather than a new way out.
  if (!model || !spec) return null;
  const line = spec.type === "line";
  return (
    <div className="chart">
      <Legend series={model.series}
        mark={line && !(model as LineModel).stacked ? "line" : "box"} />
      {line
        ? <LineChart model={model as LineModel} height={height} />
        : <BarChart model={model as BarModel} height={height} />}
      {model.note && <div className="chart-note">{model.note}</div>}
    </div>
  );
}
