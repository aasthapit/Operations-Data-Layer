// Small shared presentational components + formatters.
import React, { useEffect, useRef, useState } from "react";
import type {
  CSSProperties, ErrorInfo, InputHTMLAttributes, MouseEventHandler, ReactNode,
} from "react";

// The one table primitive every view uses: sorting, per-column filters, search.
export { default as DataTable } from "./DataTable";
export type { Column, ColumnDef, DataTableProps } from "./DataTable";

/** A health status as the API spells it, plus the "unknown" the UI falls back
 * to when a cluster has never reported one. */
export interface PillProps {
  status?: string | null;
}

export function Pill({ status }: PillProps) {
  const s = status || "unknown";
  return <span className={`pill ${s}`}><span className={`dot-s ${s}`} />{s}</span>;
}

export interface DotProps {
  status?: string | null;
}

export function Dot({ status }: DotProps) {
  return <span className={`dot-s ${status || "unknown"}`} />;
}

/** The counts a health bar is drawn from. It is a record rather than a fixed
 * shape because the bar draws the four statuses it knows and ignores the rest,
 * which is what lets a caller hand over a whole summary object. */
export type HealthCounts = Record<string, number>;

export interface HealthBarProps {
  counts: HealthCounts;
}

// Stacked health bar from a counts object {healthy,warning,critical,unknown}.
export function HealthBar({ counts }: HealthBarProps) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const order = ["healthy", "warning", "critical", "unknown"];
  return (
    <div className="hbar" title={order.map((k) => `${k}: ${counts[k] || 0}`).join("  ")}>
      {order.map((k) =>
        counts[k] ? (
          <span key={k} className={k} style={{ width: `${(counts[k] / total) * 100}%` }} />
        ) : null
      )}
    </div>
  );
}

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  /** A tone class - "critical", "warning", "accent" - not a fixed union, since
   * it is only ever a class name on the tile. */
  kind?: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
  sub?: ReactNode;
}

export function Stat({ label, value, kind, onClick, sub }: StatProps) {
  return (
    <div className={`stat ${kind || ""} ${onClick ? "clickable" : ""}`} onClick={onClick}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export interface SparklineProps {
  /** A missing sample is drawn at zero rather than as a gap: a sparkline is a
   * shape, not a reading. */
  points?: Array<number | null | undefined> | null;
  width?: number;
  height?: number;
  color?: string;
  max?: number;
}

// Tiny inline SVG sparkline (0-100 scale by default).
export function Sparkline({
  points, width = 260, height = 48, color = "var(--accent)", max = 100,
}: SparklineProps) {
  if (!points || points.length === 0) return <div className="muted">no history</div>;
  const min = 0;
  const n = points.length;
  const dx = n > 1 ? width / (n - 1) : 0;
  const coords = points.map((p, i) => {
    const x = i * dx;
    const y = height - (((p ?? 0) - min) / (max - min || 1)) * height;
    return [x, y];
  });
  const d = coords.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${d} L${width},${height} L0,${height} Z`;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={area} fill={color} opacity="0.12" />
      <path d={d} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}

export function Loading() {
  return <div className="loading">Loading…</div>;
}

// ---- pending placeholders -------------------------------------------------
// A view paints its frame, its filters and anything already cached straight
// away; whatever is still on the wire shows as a block the same shape and size
// as the content that will replace it, so nothing jumps when it lands.
export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}

export function Skeleton({ width = "100%", height = 12, style }: SkeletonProps) {
  return <span className="skeleton" style={{ width, height, ...style }} />;
}

// Deterministic widths: a row of identical bars reads as a progress bar, and a
// random one flickers on every render.
const CELL_WIDTHS = ["72%", "48%", "86%", "36%", "64%", "56%", "78%", "44%"];

export interface SkeletonTableProps {
  columns?: number;
  rows?: number;
  dense?: boolean;
}

export function SkeletonTable({ columns = 6, rows = 8, dense = false }: SkeletonTableProps) {
  return (
    <table className={`dt skeleton-table${dense ? " dt-dense" : ""}`} aria-hidden="true">
      <tbody>
        {Array.from({ length: rows }, (_, r) => (
          <tr key={r}>
            {Array.from({ length: columns }, (_, c) => (
              <td key={c}><Skeleton width={CELL_WIDTHS[(r + c * 3) % CELL_WIDTHS.length]} /></td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface SkeletonStatsProps {
  count?: number;
}

export function SkeletonStats({ count = 6 }: SkeletonStatsProps) {
  return (
    <div className="stats">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="stat">
          <div className="label"><Skeleton width="60%" height={11} /></div>
          <div className="value"><Skeleton width="42%" height={26} style={{ marginTop: 4 }} /></div>
        </div>
      ))}
    </div>
  );
}

export interface SkeletonLinesProps {
  rows?: number;
  height?: number;
}

export function SkeletonLines({ rows = 4, height = 14 }: SkeletonLinesProps) {
  return (
    <div className="skeleton-lines" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width={CELL_WIDTHS[i % CELL_WIDTHS.length]} height={height} />
      ))}
    </div>
  );
}

/** Everything a plain `<input>` takes, except that `value` is the committed
 * text and `onChange` reports it rather than an event. */
export interface SearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  value?: string | null;
  onChange: (value: string) => void;
  delay?: number;
}

// Text input that reports after the user stops typing, so a filter that lives
// in the URL does not write a history entry (or fire a request) per keystroke.
export function SearchInput({ value, onChange, delay = 300, ...rest }: SearchInputProps) {
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

export interface ErrorBannerProps {
  /** What the fetch layer produced - an `ApiError` in practice - or a message a
   * view built itself. */
  error?: { message?: string } | string | null;
}

export function ErrorBanner({ error }: ErrorBannerProps) {
  if (!error) return null;
  // Same result as `String(error.message || error)`: a string has no `message`,
  // so it falls through to itself. Written as a guard so the type follows.
  const message = typeof error === "string" ? error : String(error.message || error);
  return <div className="banner">Error: {message}</div>;
}

export interface EmptyProps {
  children?: ReactNode;
}

export function Empty({ children }: EmptyProps) {
  return <div className="empty">{children}</div>;
}

/** One entry of a toggle group: a key, what it says, and optionally how many
 * things are behind it. The `readonly string[]` arm is there because several
 * views hold their tab list in a module-level const, which TypeScript widens to
 * `string[][]` unless the view writes `as const`. */
export type SubTab =
  | readonly [key: string, label: ReactNode, count?: number | null]
  | readonly string[];

export interface SubTabsProps {
  tabs: readonly SubTab[];
  value: string;
  onChange: (key: string) => void;
}

// Toggle-group used for sub-navigation inside a view.
export function SubTabs({ tabs, value, onChange }: SubTabsProps) {
  return (
    <div className="toggle-group">
      {tabs.map(([k, label, count]) => (
        <button key={k} className={value === k ? "active" : ""} onClick={() => onChange(k)}>
          {label}{count != null && <span className="count">{count}</span>}
        </button>
      ))}
    </div>
  );
}

export interface FilterSelectProps {
  label: ReactNode;
  value?: string | null;
  options: readonly string[];
  onChange: (value: string) => void;
  allLabel?: string;
}

export function FilterSelect({ label, value, options, onChange, allLabel = "All" }: FilterSelectProps) {
  return (
    <label className="fld">
      {label}
      <select value={value || ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

export interface UsageBarProps {
  /** null when the metric was not collected - the bar says so rather than
   * drawing a zero. */
  percent?: number | null;
  label?: string;
  width?: number | string;
}

// Usage bar with thresholds; percent may be null (metrics unavailable).
export function UsageBar({ percent, label, width = 120 }: UsageBarProps) {
  if (percent == null) return <span className="muted">n/a</span>;
  const tone = percent >= 95 ? "critical" : percent >= 85 ? "warning" : "healthy";
  return (
    <span className="usage" title={label}>
      <span className="usage-bar" style={{ width }}>
        <span className={tone} style={{ width: `${Math.min(100, percent)}%` }} />
      </span>
      <span className="usage-pct">{percent.toFixed(0)}%</span>
    </span>
  );
}

export interface TierProps {
  tier?: string | null;
}

export function Tier({ tier }: TierProps) {
  if (!tier) return <span className="muted">—</span>;
  return tier === "critical" ? <span className="tag critical">critical</span> : <span className="tag">{tier}</span>;
}

// ---- formatters ----
/** What the API sends for a measurement: a number, or null when it was never
 * collected. A few callers still hand over the string a JSON column carried. */
export type Numeric = number | string | null | undefined;

export const fmtCores = (v: Numeric): string => {
  if (v == null) return "—";
  const n = Number(v);
  if (n >= 1) return `${n.toFixed(2)} cores`;
  const m = n * 1000;
  return `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}m`;   // millicores, the Kubernetes idiom
};
export const fmtBytes = (v: number | null | undefined): string => {
  if (v == null) return "—";
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GiB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(0)} MiB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KiB`;
  return `${v} B`;
};
export const fmtPct = (v: Numeric): string => (v == null ? "—" : `${Number(v).toFixed(1)}%`);
export const fmtTime = (iso: string | null | undefined): string =>
  (iso ? new Date(iso).toLocaleString() : "—");
export const fmtDate = (iso: string | null | undefined): string =>
  (iso ? new Date(iso).toLocaleDateString() : "—");
export const fmtAge = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
export const fmtDays = (d: number | null | undefined): string => {
  if (d == null) return "—";
  if (d < 0) return `expired ${Math.abs(d).toFixed(0)}d ago`;
  return `${d.toFixed(0)}d`;
};


export interface ErrorBoundaryProps {
  children?: ReactNode;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// A view that throws must not blank the whole app: show what broke and a way out.
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("view crashed", error, info?.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error?.message || String(this.state.error);
    return (
      <div className="card" style={{ padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>This view failed to render</h3>
        <div className="mono" style={{ fontSize: 12, marginBottom: 10 }}>{message}</div>
        <button className="btn" onClick={() => { this.setState({ error: null }); this.props.onReset && this.props.onReset(); }}>Try again</button>
        {" "}
        <a href="/" className="btn">Go to overview</a>
      </div>
    );
  }
}
