// A result set drawn as a chart: a line (or area) over time, or bars by
// category. Nothing else - a query result either has a time axis, a category
// axis, or no chart at all, and the table underneath is always the full answer.
//
// The drawing itself is MUI X Charts' `LineChart` and `BarChart`: two scales, a
// legend, tooltips and axis highlighting that used to be hand-rolled SVG here
// are now a dependency's job. What stays is everything the library cannot know
// on its own - which column is a time axis, which is a series, how many lines
// is too many, how a category label is shortened instead of dropped, and how a
// column named `_bytes` or `_percent` is read. That is inference and shape
// detection, not rendering, and it does not change because the renderer did.
//
// The colours come from `theme.palette.chart` (`useTheme()`), never a hex
// literal - the same eight validated categorical slots and lone-series accent
// this file used to read off `--series-1..8` / `--chart-line` in styles.css,
// now read through the theme instead. Status colours (success / warning /
// error) are never used as series colours: green here would mean "this
// series", not "healthy", and that is exactly the confusion the status tokens
// exist to avoid.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import type { Theme } from "@mui/material/styles";
import { LineChart } from "@mui/x-charts/LineChart";
import { BarChart } from "@mui/x-charts/BarChart";
import type { BarItem } from "@mui/x-charts/BarChart";
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

/** How wide the gap between two ticks is, which decides how a time is worded.
 * "hour" covers both clock-time buckets (a chart never needs to tell "the
 * minute" and "the hour" apart in words - both read as `18:42`). */
type TimeUnit = "hour" | "day" | "month";

// Which bucket a span of time reads in - the same "largest step that still
// gives a handful of ticks" rule the axis used to compute for itself, kept
// only for wording now that MUI places the ticks: a sweep-sized window reads
// as a clock time, a month-sized one as a date, a year-sized one as a month.
function pickTimeUnit(min: number, max: number, count: number): TimeUnit {
  const span = Math.max(1, max - min);
  const fine = [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
    HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR];
  if (fine.some((step) => span / step <= count)) return "hour";
  if ([1, 2, 3, 7, 14, 28].some((days) => span / (days * DAY) <= count)) return "day";
  return "month";
}

function formatTimeTick(t: number, unit: TimeUnit): string {
  const d = new Date(t);
  if (unit === "hour") return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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
// text measurement
// --------------------------------------------------------------------------- //
// MUI hides overlapping axis ticks entirely rather than shortening them; this
// dashboard's rule is that a category label is never dropped, only shortened,
// with the full name staying in the tooltip and in the table. That rule is not
// something the library does, so the measuring it takes stays here.
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
// The eight categorical slots and the lone-series colour are `theme.palette
// .chart` (see `theme.ts`): the same validated palette this file used to read
// off `--series-1..8` and `--chart-line` as CSS variables, now read through
// the theme instead. Never `.success` / `.warning` / `.error` - those carry
// meaning (healthy / warning / critical), and a series borrowing one of them
// would say "this series" when the colour actually means "this is bad".
const colorAt = (theme: Theme, i: number, total: number): string => (total <= 1
  ? theme.palette.chart.line
  : theme.palette.chart.series[i % theme.palette.chart.series.length]);

// --------------------------------------------------------------------------- //
// grouping rows into series
// --------------------------------------------------------------------------- //
const keyOf = (v: unknown): string => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

// Rows in one sweep are written a few milliseconds apart, so two clusters
// never share a timestamp exactly. Each series is therefore matched to a
// shared time grid by nearest sample within its own sampling interval, rather
// than by exact equality.
/** One sample of one line, before it is aligned to the shared time grid. A
 * null value is a gap, never a zero. */
interface LinePoint {
  t: number;
  v: number | null;
}

/** One series while it is still being grouped, before the palette cap and the
 * shared time grid are applied. */
interface RawSeries {
  key: string;
  label: string;
  unit: Unit;
  points: LinePoint[];
  /** How far from a stamp a sample still counts as that stamp's, derived from
   * the series' own sampling interval. */
  tol: number;
  /** The sum of |v|, which is how the series past the palette cap are ranked. */
  total: number;
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

// --------------------------------------------------------------------------- //
// the data a line chart is drawn from
// --------------------------------------------------------------------------- //
/** One series as MUI X Charts draws it: a value per stamp in `LineChartData`,
 * aligned by index rather than re-matched at render time. */
interface LineSeriesData {
  key: string;
  label: string;
  unit: Unit;
  data: Array<number | null>;
  color: string;
  /** A lone series (or any series in a stack) is filled under the line. */
  area: boolean;
}

export interface LineChartData {
  stamps: number[];
  series: LineSeriesData[];
  stacked: boolean;
  /** What the caption says about anything the chart had to leave out. */
  note: string;
  unit: Unit;
  integer: boolean;
  xLabel: string;
  measureLabel: string;
}

function buildLineData(fields: Field[], rows: Row[], spec: Spec, theme: Theme): LineChartData | null {
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

  let raw: RawSeries[] = [...groups.values()].map((g) => {
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
  if (!raw.length) return null;

  // Past eight lines the palette stops telling them apart. Stacked, the tail is
  // a real part of the whole and is summed into "Other"; unstacked, summing
  // unrelated measurements would invent a number, so the tail is left out and
  // the caption says which.
  let note = "";
  if (raw.length > SERIES_CAP) {
    const keep = spec.stack ? SERIES_CAP - 1 : SERIES_CAP;
    const ranked = [...raw].sort((a, b) => b.total - a.total);
    const kept = new Set(ranked.slice(0, keep).map((s) => s.key));
    const rest = ranked.slice(keep);
    raw = raw.filter((s) => kept.has(s.key));
    if (spec.stack) {
      const summed = new Map<number, number>();
      for (const s of rest) {
        for (const p of s.points) {
          if (p.v == null) continue;
          summed.set(p.t, (summed.get(p.t) || 0) + p.v);
        }
      }
      const points = [...summed.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
      raw.push({
        key: "__other__",
        label: "Other",
        unit: raw[0].unit,
        points,
        tol: medianGap(points) * 0.75,
        total: 0,
      });
      note = `${rest.length} smaller series summed into "Other"`;
    } else {
      note = `the ${SERIES_CAP} largest of ${SERIES_CAP + rest.length} series - the rest are in the table`;
    }
  }

  for (const s of raw) {
    if (!(s.tol > 0)) s.tol = Math.max(MINUTE, (s.points[s.points.length - 1]?.t - s.points[0]?.t || 0) / 20);
  }

  const stamps = [...new Set(raw.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
  const stacked = !!spec.stack && raw.length > 1;

  const series: LineSeriesData[] = raw.map((s, i) => {
    let data: Array<number | null>;
    if (stacked) {
      // Each series contributes its nearest sample, or the last one it had -
      // which is what the sweep before this one actually measured. A stack is
      // read as a total, so every band needs a value at every stamp.
      let carried = 0;
      data = stamps.map((t) => {
        const p = nearestPoint(s.points, t, Math.max(s.tol, MINUTE));
        const v = p && p.v != null ? p.v : carried;
        carried = v;
        return v;
      });
    } else {
      data = stamps.map((t) => {
        const p = nearestPoint(s.points, t, s.tol);
        return p && p.v != null ? p.v : null;
      });
    }
    return {
      key: s.key,
      label: s.label,
      unit: s.unit,
      data,
      color: colorAt(theme, i, raw.length),
      area: stacked || raw.length === 1,
    };
  });

  if (stacked) note = note ? `${note} · stacked on a shared time grid` : "stacked on a shared time grid";

  const plotted = series.flatMap((s) => s.data).filter((v): v is number => v != null);
  if (!stacked && !plotted.length) return null;

  const units = new Set(series.map((s) => s.unit));
  return {
    stamps,
    series,
    stacked,
    note,
    unit: units.size === 1 ? [...units][0] : "",
    integer: plotted.every(Number.isInteger),
    xLabel: x.name,
    measureLabel: seriesField ? measures[0].name : spec.y.join(", "),
  };
}

// --------------------------------------------------------------------------- //
// the data a bar chart is drawn from
// --------------------------------------------------------------------------- //
interface BarSeriesData {
  key: string;
  label: string;
  unit: Unit;
  data: Array<number | null>;
  color: string;
}

export interface BarChartData {
  /** Category labels, index-aligned with each series' `data`. Two rows may
   * share a label - the chart keeps the query's own order, never groups by it. */
  items: string[];
  series: BarSeriesData[];
  note: string;
  unit: Unit;
  integer: boolean;
  /** Horizontal once labels stop fitting under a column - most real category
   * axes here: cluster names, reasons, check titles. */
  horizontal: boolean;
  xLabel: string;
}

function buildBarData(fields: Field[], rows: Row[], spec: Spec, theme: Theme): BarChartData | null {
  const x = byName(fields, spec.x);
  const measures = spec.y.map((n) => byName(fields, n))
    .filter((f): f is Field => !!f).slice(0, GROUPED_CAP);
  if (!x || !measures.length) return null;

  // Bars keep the order the query returned them in - the ORDER BY is the
  // author's answer to "sorted how", and re-sorting here would overrule it.
  const shown = rows.slice(0, BAR_CAP);
  const items = shown.map((row) => keyOf(cellAt(row, x.index)));
  const values = shown.map((row) => measures.map((m) => numberAt(row, m.index)));
  const flat = values.flat().filter((v): v is number => v != null);
  if (!flat.length) return null;

  const series: BarSeriesData[] = measures.map((m, i) => ({
    key: m.name,
    label: m.name,
    unit: unitOf(m.name),
    data: values.map((row) => row[i]),
    color: colorAt(theme, i, measures.length),
  }));
  const units = new Set(series.map((s) => s.unit));
  const longest = Math.max(0, ...items.map((label) => textWidth(label)));
  return {
    items,
    series,
    note: rows.length > BAR_CAP ? `the first ${BAR_CAP} of ${rows.length} rows` : "",
    unit: units.size === 1 ? [...units][0] : "",
    integer: flat.every(Number.isInteger),
    horizontal: items.length > 12 || longest > 72,
    xLabel: x.name,
  };
}

// --------------------------------------------------------------------------- //
// one of the two, resolved
// --------------------------------------------------------------------------- //
type ChartData =
  | { kind: "line"; value: LineChartData }
  | { kind: "bars"; value: BarChartData };

function buildChartData(fields: Field[], rows: Row[], spec: Spec, theme: Theme): ChartData | null {
  if (spec.type === "line") {
    const value = buildLineData(fields, rows, spec, theme);
    return value && { kind: "line", value };
  }
  const value = buildBarData(fields, rows, spec, theme);
  return value && { kind: "bars", value };
}

// --------------------------------------------------------------------------- //
// sizing a chart to the card it is drawn in
// --------------------------------------------------------------------------- //
// Measured for the category-label ellipsis and the time-bucket wording only -
// MUI sizes the chart itself. A fallback width is used until the first
// measurement lands, so the first paint still gets a sensible guess.
const FALLBACK_WIDTH = 600;

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

// --------------------------------------------------------------------------- //
// axis and series adapters
// --------------------------------------------------------------------------- //
// A structural stand-in for MUI's own `AxisValueFormatterContext`: only the
// field this file reads. MUI's real context always carries at least this, so
// a callback typed against it is accepted wherever the fuller type is asked
// for, without coupling this file to an internal generic.
interface AxisFormatContext {
  location: "tick" | "tooltip" | "legend" | "zoom-slider-tooltip";
}

type LineSeriesItem = ComponentProps<typeof LineChart>["series"][number];
type BarSeriesItem = ComponentProps<typeof BarChart>["series"][number];
type BarXAxis = NonNullable<ComponentProps<typeof BarChart>["xAxis"]>[number];
type BarYAxis = NonNullable<ComponentProps<typeof BarChart>["yAxis"]>[number];

// --------------------------------------------------------------------------- //
// line
// --------------------------------------------------------------------------- //
interface LineViewProps {
  data: LineChartData;
  height: number;
}

function LineView({ data, height }: LineViewProps) {
  const theme = useTheme();
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useWidth(wrap);

  const xAxis = useMemo(() => {
    const unit = pickTimeUnit(data.stamps[0], data.stamps[data.stamps.length - 1],
      Math.max(2, Math.floor((width || FALLBACK_WIDTH) / 80)));
    return [{
      scaleType: "time" as const,
      data: data.stamps.map((t) => new Date(t)),
      valueFormatter: (value: Date, ctx: AxisFormatContext) => (ctx.location === "tick"
        ? formatTimeTick(value.getTime(), unit)
        : formatTimeFull(value.getTime(), unit)),
    }];
  }, [data.stamps, width]);

  const series = useMemo((): LineSeriesItem[] => data.series.map((s) => ({
    id: s.key,
    label: s.label,
    data: s.data,
    color: s.color,
    area: s.area,
    stack: data.stacked ? "total" : undefined,
    valueFormatter: (value: number | null) => (value == null ? "—" : formatValue(value, s.unit)),
  })), [data]);

  return (
    <Box ref={wrap} sx={{ width: "100%" }}>
      <LineChart
        height={height}
        series={series}
        xAxis={xAxis}
        yAxis={[{ valueFormatter: (v: number) => formatTick(v, data.unit) }]}
        hideLegend={data.series.length < 2}
        grid={{ horizontal: true }}
        sx={{
          "& .MuiChartsGrid-line": { stroke: theme.palette.chart.grid },
          // A stacked band is read as a surface, not a line: the separation
          // between bands is air, never a stroke, which is why the old SVG
          // stacked areas never drew a stroke either.
          ...(data.stacked ? { "& .MuiLineChart-line": { display: "none" } } : null),
        }}
      />
    </Box>
  );
}

// --------------------------------------------------------------------------- //
// bars
// --------------------------------------------------------------------------- //
interface BarViewProps {
  data: BarChartData;
  height: number;
}

// Enough vertical room per row that a horizontal bar chart does not squeeze
// twenty categories into the same box a five-category one gets.
const BAR_ROW = 28;

function BarView({ data, height }: BarViewProps) {
  const theme = useTheme();
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useWidth(wrap);
  const w = width || FALLBACK_WIDTH;
  const singleMeasure = data.series.length === 1;

  // The budget a category label is ellipsized against: a share of the card's
  // width for a horizontal chart's left margin, an even split of it for a
  // vertical chart's columns. Only a rough match for MUI's own margins, which
  // are not known until it has laid itself out - close enough that a label is
  // shortened rather than left to collide.
  const budget = data.horizontal
    ? Math.max(40, Math.round(w * 0.35))
    : Math.max(20, w / data.items.length - 6);

  const categoryAxis: BarXAxis & BarYAxis = useMemo(() => ({
    scaleType: "band",
    data: data.items,
    valueFormatter: (value: string, ctx: AxisFormatContext) => (ctx.location === "tick"
      ? ellipsize(value, budget)
      : value),
  }), [data.items, budget]);

  const valueAxis: BarXAxis & BarYAxis = useMemo(() => ({
    valueFormatter: (value: number) => formatTick(value, data.unit),
  }), [data.unit]);

  const series = useMemo((): BarSeriesItem[] => data.series.map((s) => ({
    id: s.key,
    label: s.label,
    data: s.data,
    color: s.color,
    layout: data.horizontal ? "horizontal" : "vertical",
    valueFormatter: (value: number | null) => (value == null ? "—" : formatValue(value, s.unit)),
    // Grouped, multi-measure bars keep no value labels - the old chart only
    // drew them for a vertical single measure or a horizontal chart that had
    // room, and matching that pixel-fit check through MUI's own layout is not
    // cheap, so the simpler single-measure rule stands in for both layouts.
    barLabel: singleMeasure
      ? (item: BarItem) => (item.value == null ? undefined : formatValue(item.value, s.unit))
      : undefined,
  })), [data, singleMeasure]);

  const chartHeight = data.horizontal ? Math.max(height, data.items.length * BAR_ROW + 48) : height;

  return (
    <Box ref={wrap} sx={{ width: "100%" }}>
      <BarChart
        height={chartHeight}
        layout={data.horizontal ? "horizontal" : "vertical"}
        series={series}
        xAxis={[data.horizontal ? valueAxis : categoryAxis]}
        yAxis={[data.horizontal ? categoryAxis : valueAxis]}
        hideLegend={data.series.length < 2}
        grid={data.horizontal ? { vertical: true } : { horizontal: true }}
        sx={{ "& .MuiChartsGrid-line": { stroke: theme.palette.chart.grid } }}
      />
    </Box>
  );
}

// --------------------------------------------------------------------------- //
// accessible labels
// --------------------------------------------------------------------------- //
// The chart is one image to a screen reader; the label says what is in it and
// where the values themselves are. The table under a query result is that
// place - the cluster timeline has no table, so it does not claim one.
const TABLE_NOTE = " The table below has every value.";

function lineAria(data: LineChartData, tableBelow: boolean): string {
  const who = data.series.length === 1
    ? data.series[0].label
    : `${data.series.length} series (${data.series.slice(0, 6).map((s) => s.label).join(", ")}${data.series.length > 6 ? ", and more" : ""})`;
  const first = data.stamps[0];
  const last = data.stamps[data.stamps.length - 1];
  return `Line chart of ${data.measureLabel} over ${data.xLabel}: ${who}, from `
    + `${formatTimeFull(first, "hour")} to ${formatTimeFull(last, "hour")}.`
    + (tableBelow ? TABLE_NOTE : "");
}

function barAria(data: BarChartData, tableBelow: boolean): string {
  return `Bar chart of ${data.series.map((s) => s.label).join(", ")} by ${data.xLabel}: `
    + `${data.items.length} categories, ${data.items[0]} to `
    + `${data.items[data.items.length - 1]}.`
    + (tableBelow ? TABLE_NOTE : "");
}

// --------------------------------------------------------------------------- //
// the component
// --------------------------------------------------------------------------- //
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
}: ChartProps): ReactNode {
  const theme = useTheme();
  const fields = useMemo(
    () => given || inferFields(columns, columnTypes, rows), [given, columns, columnTypes, rows]);

  const data = useMemo(
    () => (spec ? buildChartData(fields, rows || [], spec, theme) : null),
    [fields, rows, spec, theme]);

  if (!spec || !data) return null;
  const ariaLabel = data.kind === "line" ? lineAria(data.value, tableBelow) : barAria(data.value, tableBelow);

  return (
    <Box>
      <Box role="img" aria-label={ariaLabel}>
        {data.kind === "line"
          ? <LineView data={data.value} height={height} />
          : <BarView data={data.value} height={height} />}
      </Box>
      {data.value.note && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
          {data.value.note}
        </Typography>
      )}
    </Box>
  );
}
