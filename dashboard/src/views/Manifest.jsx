import { Fragment } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { ErrorBanner, DataTable, SkeletonLines, SkeletonTable, fmtBytes } from "../components";

// Durations here span three orders of magnitude (a 40 ms health check, a 12 s
// fetch), so the unit follows the value rather than the column.
const fmtMs = (v) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const fmtNum = (v) => (v == null ? "—" : Number(v).toLocaleString());
const fmtPercent = (v) => (v == null ? "—" : `${v}%`);

const RESOURCE_COLUMNS = [
  {
    key: "domain", label: "Domain", className: "muted nowrap", filter: "select",
    sortValue: (r) => `${r.domain}/${r.key}`,
    filterValue: (r) => r.domain,
  },
  { key: "key", label: "Key", className: "mono nowrap", filter: "text" },
  { key: "kind", label: "Kind", className: "nowrap", filter: "select" },
  {
    key: "api_group", label: "API group", className: "mono muted nowrap", filter: "select",
    filterValue: (r) => `${r.api_group}/${r.version}`,
    render: (r) => `${r.api_group}/${r.version}`,
  },
  {
    key: "scope", label: "Scope", className: "muted nowrap", filter: "select",
    filterValue: (r) => r.scope,
    render: (r) => `${r.scope}${r.namespace_class && r.namespace_class !== "all" ? ` · ${r.namespace_class} only` : ""}${r.limit ? ` · limit ${r.limit}` : ""}`,
  },
  {
    key: "enabled", label: "Enabled", filter: "select",
    filterValue: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => (r.enabled ? <span className="chip ok">enabled</span> : <span className="chip disabled">disabled</span>),
  },
  {
    key: "description", label: "What it gives", className: "muted", filter: "text", width: "40%",
    render: (r) => <span style={{ fontSize: 12 }}>{r.description}</span>,
  },
];

const TIMING_COLUMNS = (onOpen) => [
  {
    key: "cluster", label: "Cluster", className: "mono nowrap", filter: "text",
    render: (r) => <span className="link" onClick={() => onOpen(r.cluster)}>{r.cluster}</span>,
  },
  { key: "hub", label: "Hub", className: "muted nowrap", filter: "select" },
  {
    key: "total_ms", label: "Total", align: "right", className: "nowrap",
    render: (r) => fmtMs(r.total_ms),
  },
  {
    key: "cpu_ms", label: "CPU", align: "right", className: "nowrap",
    render: (r) => fmtMs(r.cpu_ms),
  },
  {
    key: "fetch_ms", label: "Fetch", align: "right", className: "nowrap muted",
    render: (r) => fmtMs(r.fetch_ms),
  },
  {
    key: "parse_ms", label: "Parse", align: "right", className: "nowrap muted",
    render: (r) => fmtMs(r.parse_ms),
  },
  {
    key: "assemble_ms", label: "Assemble", align: "right", className: "nowrap muted",
    render: (r) => fmtMs(r.assemble_ms),
  },
  {
    key: "health_ms", label: "Health", align: "right", className: "nowrap muted",
    render: (r) => fmtMs(r.health_ms),
  },
  {
    key: "persist_ms", label: "Persist", align: "right", className: "nowrap muted",
    render: (r) => fmtMs(r.persist_ms),
  },
  {
    key: "bytes", label: "Pulled", align: "right", className: "nowrap",
    render: (r) => fmtBytes(r.bytes),
  },
  {
    key: "objects", label: "Objects", align: "right", className: "nowrap",
    render: (r) => fmtNum(r.objects),
  },
  {
    key: "kinds_fetched", label: "Kinds fetched / cached", align: "right", className: "nowrap muted",
    sortValue: (r) => r.kinds_fetched,
    filterValue: (r) => `${r.kinds_fetched ?? "—"} / ${r.kinds_cached ?? "—"}`,
    render: (r) => `${r.kinds_fetched ?? "—"} / ${r.kinds_cached ?? "—"}`,
  },
];

function Timings({ data, onOpen }) {
  const fleet = data.fleet || {};
  const totals = fleet.totals || {};
  const share = fleet.share_percent || {};
  const p50 = fleet.p50 || {};
  const p95 = fleet.p95 || {};
  const last = data.last_run;
  const stages = data.stages || [];
  const measured = fleet.clusters || 0;

  return (
    <>
      {measured === 0 ? (
        <div className="muted" style={{ padding: "0 18px 14px", fontSize: 12.5 }}>
          No cluster has reported collection timings yet - they appear after the next sweep.
        </div>
      ) : (
        <div style={{ padding: "0 18px 14px" }}>
          <div className="stats" style={{ gap: 12 }}>
            <div className="stat">
              <div className="label">Collection time</div>
              <div className="value" style={{ fontSize: 24 }}>{fmtMs(totals.total_ms)}</div>
              <div className="sub">{measured} of {fleet.clusters_total} clusters measured</div>
            </div>
            <div className="stat">
              <div className="label">Network (fetch)</div>
              <div className="value" style={{ fontSize: 24 }}>{fmtPercent(share.fetch_ms)}</div>
              <div className="sub">
                {fmtMs(totals.fetch_ms)}
                {fleet.bytes_per_fetch_second ? ` · ${fmtBytes(fleet.bytes_per_fetch_second)}/s` : ""}
              </div>
            </div>
            <div className="stat accent">
              <div className="label">Python CPU</div>
              <div className="value" style={{ fontSize: 24 }}>{fmtPercent(fleet.cpu_percent)}</div>
              <div className="sub">
                {fmtMs(totals.cpu_ms)}
                {fleet.parse_percent_of_fetch != null
                  ? ` · parsing is ${fleet.parse_percent_of_fetch}% of the fetch window` : ""}
              </div>
            </div>
            <div className="stat">
              <div className="label">Last sweep</div>
              <div className="value" style={{ fontSize: 24 }}>{fmtMs(last && last.duration_ms)}</div>
              <div className="sub">
                {last ? `${last.trigger} · ${last.clusters_total ?? "?"} clusters · ${fmtBytes(totals.bytes)} pulled`
                  : "no completed sweep yet"}
              </div>
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
            Per cluster, p50 / p95:{" "}
            {stages.map((s, i) => (
              <Fragment key={s}>
                {i > 0 ? " · " : ""}
                <b>{s.replace("_ms", "")}</b> {fmtMs(p50[s])} / {fmtMs(p95[s])}
              </Fragment>
            ))}
            {" · "}<b>total</b> {fmtMs(p50.total_ms)} / {fmtMs(p95.total_ms)}
          </div>
        </div>
      )}
      <DataTable
        id="collector.timings"
        columns={TIMING_COLUMNS(onOpen)}
        rows={data.clusters || []}
        rowKey="cluster"
        initialSort={{ key: "total_ms", dir: "desc" }}
        empty="No cluster has reported collection timings yet."
        searchPlaceholder="Search clusters"
        scroll
        dense
      />
    </>
  );
}

export default function Manifest({ onOpen }) {
  const m = useFetch(() => api.manifest(), []);
  const av = useFetch(() => api.manifestAvailability(), []);
  const tm = useFetch(() => api.collectorTimings(), []);
  if (m.error && !m.data) return <ErrorBanner error={m.error} />;
  const d = m.data;
  const enabled = d ? d.resources.filter((r) => r.enabled).length : 0;
  const domains = d ? [...new Set(d.resources.map((r) => r.domain))] : [];

  return (
    // minmax(0, 1fr) rather than the default 1fr: a grid item's automatic
    // minimum is its content, so without this the widest table on the tab
    // stretches the column and the whole page scrolls sideways instead of the
    // table scrolling inside its own card.
    <div className="grid" style={{ gap: 16, gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div className="section-head">
        <div>
          <div className="section-title" style={{ margin: 0 }}>What is collected</div>
          <div className="desc">
            The OCP API manifest declares everything the collector reads from a cluster - {d ? enabled : "…"} of {d ? d.resources.length : "…"} resources
            enabled from <span className="mono" style={{ overflowWrap: "anywhere" }}>{d ? d.source : "…"}</span>. Nothing outside
            it is ever requested, and the read-only RBAC is generated from it.
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 16, alignItems: "start" }}>
        <div className="card">
          <h3>Never collected (scrub policy)</h3>
          <div className="env-list" style={{ fontSize: 12.5 }}>
            {!d ? <SkeletonLines rows={4} /> : d.scrub_policy.map((p) => <span key={p.what}><b>{p.what}</b> <span className="src">kept: {p.kept}</span></span>)}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>Enforced in the collector, not configurable.</div>
        </div>
        <div className="card">
          <h3>Namespace classification</h3>
          {!d ? <SkeletonLines rows={6} /> : (
          <div className="kv" style={{ fontSize: 12.5 }}>
            <span className="k">Platform names</span><span className="mono wrap">{d.namespaces.platform_names.join(", ")}</span>
            <span className="k">Platform prefixes</span><span className="mono wrap">{d.namespaces.platform_prefixes.join(", ")}</span>
            <span className="k">Platform labels</span><span className="mono wrap">{d.namespaces.platform_label_keys.join(", ") || "—"}</span>
            <span className="k">App label</span><span className="mono wrap">{d.namespaces.ownership.app.join(", ")}</span>
            <span className="k">Team label</span><span className="mono wrap">{d.namespaces.ownership.team.join(", ")}</span>
            <span className="k">Tier label</span><span className="mono wrap">{d.namespaces.ownership.tier.join(", ")}</span>
          </div>
          )}
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>Everything else is an application.</div>
        </div>
        <div className="card">
          <h3>Thresholds</h3>
          {!d ? <SkeletonLines rows={4} /> : (
            <div className="kv" style={{ fontSize: 12.5 }}>
              {Object.entries(d.thresholds).map(([k, v]) => (
                <Fragment key={k}>
                  <span className="k mono">{k}</span>
                  <span>{Array.isArray(v) ? v.join(", ") : String(v)}</span>
                </Fragment>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card flush">
        <div className="card-head">
          <h3>Resources</h3>
          <div className="desc">{d ? `${d.resources.length} declared across ${domains.length} domains.` : "…"}</div>
        </div>
        {/* Twelve columns of prose do not fit a narrow window; the table scrolls
            inside the card rather than making the whole page scroll sideways. */}
        <div style={{ overflowX: "auto" }}>
          {!d ? <SkeletonTable columns={7} rows={10} /> : (
            <DataTable
              id="manifest.resources"
              columns={RESOURCE_COLUMNS}
              rows={d.resources}
              rowKey="key"
              initialSort={{ key: "domain", dir: "asc" }}
              empty="The manifest declares no resources."
            />
          )}
        </div>
      </div>

      <div className="card flush">
        <div className="card-head">
          <h3>Availability per cluster</h3>
          <div className="desc">What each cluster actually served on the last sweep: object count when collected; n/a when the API is not served (e.g. no OLM); 403 when RBAC denies it.</div>
        </div>
        {av.error && !av.data ? <ErrorBanner error={av.error} /> : !av.data ? <SkeletonTable columns={8} rows={8} /> : <Matrix data={av.data} onOpen={onOpen} />}
      </div>

      <div className="card flush">
        <div className="card-head">
          <h3>Collector timing</h3>
          <div className="desc">
            What collecting each cluster cost on its last collection. <b>Fetch</b> is the network and the
            cluster&apos;s API server - it shrinks by asking for less, less often (tiered intervals, watches,
            metadata-only lists), not by writing the collector in another language. <b>Parse</b>, <b>assemble</b>,
            <b> health</b> and <b>persist</b> are CPU in Python, and are what a Go collector would shrink; the CPU
            column adds them up. Parsing is measured inside the fetch window, so a cluster&apos;s total is
            fetch + assemble + health + persist.
          </div>
        </div>
        {tm.error && !tm.data ? <ErrorBanner error={tm.error} /> : !tm.data ? <SkeletonTable columns={11} rows={6} /> : <Timings data={tm.data} onOpen={onOpen} />}
      </div>
    </div>
  );
}

function Matrix({ data, onOpen }) {
  const label = (s) => !s ? "—" : s.status === "collected" ? s.count : s.status === "unavailable" ? "n/a" : s.status === "forbidden" ? "403" : s.status === "error" ? "err" : "off";
  // One column per cluster, so only the resource column is sortable - a cluster
  // header stays the link that opens it.
  const columns = [
    { key: "resource", label: "Resource", className: "mono", filter: "text" },
    ...data.clusters.map((c) => ({
      key: `cluster:${c.name}`,
      label: <span className="link" onClick={() => onOpen(c.name)}>{c.name}</span>,
      sortable: false,
      headerClassName: "rot",
      className: "cell",
      filterValue: (row) => c.resources[row.resource]?.status || "disabled",
      render: (row) => {
        const s = c.resources[row.resource];
        return (
          <span className={`m ${s?.status || "disabled"}`} title={s?.error || (s ? `${s.status} · ${s.duration_ms} ms` : "")}>
            {label(s)}
          </span>
        );
      },
    })),
  ];
  return (
    <div className="matrix">
      <DataTable
        id="manifest.availability"
        columns={columns}
        rows={data.resources.map((key) => ({ resource: key }))}
        rowKey="resource"
        initialSort={{ key: "resource", dir: "asc" }}
        empty="Nothing collected on the last sweep."
      />
    </div>
  );
}
