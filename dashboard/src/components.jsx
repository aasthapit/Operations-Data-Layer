// Small shared presentational components + formatters.
import React, { useEffect, useRef, useState } from "react";

// The one table primitive every view uses: sorting, per-column filters, search.
export { default as DataTable } from "./DataTable";

export function Pill({ status }) {
  const s = status || "unknown";
  return <span className={`pill ${s}`}><span className={`dot-s ${s}`} />{s}</span>;
}

export function Dot({ status }) {
  return <span className={`dot-s ${status || "unknown"}`} />;
}

// Stacked health bar from a counts object {healthy,warning,critical,unknown}.
export function HealthBar({ counts }) {
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

export function Stat({ label, value, kind, onClick, sub }) {
  return (
    <div className={`stat ${kind || ""} ${onClick ? "clickable" : ""}`} onClick={onClick}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

// Tiny inline SVG sparkline (0-100 scale by default).
export function Sparkline({ points, width = 260, height = 48, color = "var(--accent)", max = 100 }) {
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
export function Skeleton({ width = "100%", height = 12, style }) {
  return <span className="skeleton" style={{ width, height, ...style }} />;
}

// Deterministic widths: a row of identical bars reads as a progress bar, and a
// random one flickers on every render.
const CELL_WIDTHS = ["72%", "48%", "86%", "36%", "64%", "56%", "78%", "44%"];

export function SkeletonTable({ columns = 6, rows = 8, dense = false }) {
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

export function SkeletonStats({ count = 6 }) {
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

export function SkeletonLines({ rows = 4, height = 14 }) {
  return (
    <div className="skeleton-lines" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width={CELL_WIDTHS[i % CELL_WIDTHS.length]} height={height} />
      ))}
    </div>
  );
}

// Text input that reports after the user stops typing, so a filter that lives
// in the URL does not write a history entry (or fire a request) per keystroke.
export function SearchInput({ value, onChange, delay = 300, ...rest }) {
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

export function ErrorBanner({ error }) {
  if (!error) return null;
  return <div className="banner">Error: {String(error.message || error)}</div>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

// Toggle-group used for sub-navigation inside a view.
export function SubTabs({ tabs, value, onChange }) {
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

export function FilterSelect({ label, value, options, onChange, allLabel = "All" }) {
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

// Usage bar with thresholds; percent may be null (metrics unavailable).
export function UsageBar({ percent, label, width = 120 }) {
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

export function Tier({ tier }) {
  if (!tier) return <span className="muted">—</span>;
  return tier === "critical" ? <span className="tag critical">critical</span> : <span className="tag">{tier}</span>;
}

// ---- formatters ----
export const fmtCores = (v) => {
  if (v == null) return "—";
  const n = Number(v);
  if (n >= 1) return `${n.toFixed(2)} cores`;
  const m = n * 1000;
  return `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}m`;   // millicores, the Kubernetes idiom
};
export const fmtBytes = (v) => {
  if (v == null) return "—";
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GiB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(0)} MiB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KiB`;
  return `${v} B`;
};
export const fmtPct = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : "—");
export const fmtAge = (iso) => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
export const fmtDays = (d) => {
  if (d == null) return "—";
  if (d < 0) return `expired ${Math.abs(d).toFixed(0)}d ago`;
  return `${d.toFixed(0)}d`;
};


// A view that throws must not blank the whole app: show what broke and a way out.
export class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("view crashed", error, info?.componentStack); }
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
