import { Fragment } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { Loading, ErrorBanner } from "../components";

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
        <div className="card-head"><h3>Resources</h3></div>
        <table>
          <thead><tr><th>Domain</th><th>Key</th><th>Kind</th><th>API group</th><th>Scope</th><th>Enabled</th><th>What it gives</th></tr></thead>
          <tbody>
            {domains.map((dom) => d.resources.filter((r) => r.domain === dom).map((r, i) => (
              <tr key={r.key}>
                <td className="muted nowrap">{i === 0 ? dom : ""}</td>
                <td className="mono nowrap">{r.key}</td>
                <td className="nowrap">{r.kind}</td>
                <td className="mono muted nowrap">{r.api_group}/{r.version}</td>
                <td className="muted nowrap">{r.scope}{r.namespace_class && r.namespace_class !== "all" ? ` · ${r.namespace_class} only` : ""}{r.limit ? ` · limit ${r.limit}` : ""}</td>
                <td>{r.enabled ? <span className="chip ok">enabled</span> : <span className="chip disabled">disabled</span>}</td>
                <td className="muted" style={{ fontSize: 12, width: "40%" }}>{r.description}</td>
              </tr>
            )))}
          </tbody>
        </table>
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
  return (
    <div className="matrix">
      <table>
        <thead>
          <tr>
            <th>Resource</th>
            {data.clusters.map((c) => <th key={c.name} className="rot"><span className="link" onClick={() => onOpen(c.name)}>{c.name}</span></th>)}
          </tr>
        </thead>
        <tbody>
          {data.resources.map((key) => (
            <tr key={key}>
              <td className="mono">{key}</td>
              {data.clusters.map((c) => {
                const s = c.resources[key];
                return <td key={c.name} className="cell" title={s?.error || (s ? `${s.status} · ${s.duration_ms} ms` : "")}><span className={`m ${s?.status || "disabled"}`}>{label(s)}</span></td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
