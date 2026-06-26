// Small shared presentational components.

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

export function Stat({ label, value, kind }) {
  return (
    <div className={`stat ${kind || ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

// Tiny inline SVG sparkline for the health-score timeline.
export function Sparkline({ points, width = 260, height = 48, color = "var(--accent)" }) {
  if (!points || points.length === 0) return <div className="muted">no history</div>;
  const max = 100, min = 0;
  const n = points.length;
  const dx = n > 1 ? width / (n - 1) : 0;
  const coords = points.map((p, i) => {
    const x = i * dx;
    const y = height - ((p - min) / (max - min)) * height;
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

export function ErrorBanner({ error }) {
  if (!error) return null;
  return <div className="banner">Error: {String(error.message || error)}</div>;
}
