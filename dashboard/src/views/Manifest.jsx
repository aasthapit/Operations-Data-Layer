import { Fragment } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { Loading, ErrorBanner, DataTable } from "../components";

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

export default function Manifest({ onOpen }) {
  const m = useFetch(() => api.manifest(), []);
  const av = useFetch(() => api.manifestAvailability(), []);
  if (m.error) return <ErrorBanner error={m.error} />;
  if (m.loading && !m.data) return <Loading />;
  const d = m.data;
  const enabled = d.resources.filter((r) => r.enabled).length;
  const domains = [...new Set(d.resources.map((r) => r.domain))];

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="section-head">
        <div>
          <div className="section-title" style={{ margin: 0 }}>What is collected</div>
          <div className="desc">
            The OCP API manifest declares everything the collector reads from a cluster - {enabled} of {d.resources.length} resources
            enabled from <span className="mono">{d.source}</span>. Nothing outside it is ever requested, and the read-only RBAC is generated from it.
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 16, alignItems: "start" }}>
        <div className="card">
          <h3>Never collected (scrub policy)</h3>
          <div className="env-list" style={{ fontSize: 12.5 }}>
            {d.scrub_policy.map((p) => <span key={p.what}><b>{p.what}</b> <span className="src">kept: {p.kept}</span></span>)}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>Enforced in the collector, not configurable.</div>
        </div>
        <div className="card">
          <h3>Namespace classification</h3>
          <div className="kv" style={{ fontSize: 12.5 }}>
            <span className="k">Platform names</span><span className="mono wrap">{d.namespaces.platform_names.join(", ")}</span>
            <span className="k">Platform prefixes</span><span className="mono wrap">{d.namespaces.platform_prefixes.join(", ")}</span>
            <span className="k">Platform labels</span><span className="mono wrap">{d.namespaces.platform_label_keys.join(", ") || "—"}</span>
            <span className="k">App label</span><span className="mono wrap">{d.namespaces.ownership.app.join(", ")}</span>
            <span className="k">Team label</span><span className="mono wrap">{d.namespaces.ownership.team.join(", ")}</span>
            <span className="k">Tier label</span><span className="mono wrap">{d.namespaces.ownership.tier.join(", ")}</span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>Everything else is an application.</div>
        </div>
        <div className="card">
          <h3>Thresholds</h3>
          <div className="kv" style={{ fontSize: 12.5 }}>
            {Object.entries(d.thresholds).map(([k, v]) => (
              <Fragment key={k}>
                <span className="k mono">{k}</span>
                <span>{Array.isArray(v) ? v.join(", ") : String(v)}</span>
              </Fragment>
            ))}
          </div>
        </div>
      </div>

      <div className="card flush">
        <div className="card-head">
          <h3>Resources</h3>
          <div className="desc">{d.resources.length} declared across {domains.length} domains.</div>
        </div>
        <DataTable
          id="manifest.resources"
          columns={RESOURCE_COLUMNS}
          rows={d.resources}
          rowKey="key"
          initialSort={{ key: "domain", dir: "asc" }}
          empty="The manifest declares no resources."
        />
      </div>

      <div className="card flush">
        <div className="card-head">
          <h3>Availability per cluster</h3>
          <div className="desc">What each cluster actually served on the last sweep: object count when collected; n/a when the API is not served (e.g. no OLM); 403 when RBAC denies it.</div>
        </div>
        {av.error ? <ErrorBanner error={av.error} /> : !av.data ? <Loading /> : <Matrix data={av.data} onOpen={onOpen} />}
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
