// The list of dashboards: what exists, what it answers, and the way in.
//
// Built-in dashboards ship with the data layer and cannot be edited, only
// cloned; saved ones belong to whoever made them. "New dashboard" asks for an
// id, because the id is the URL a dashboard will be shared under for the rest
// of its life.
import { useMemo, useState } from "react";
import { api } from "../api";
import { invalidate } from "../cache";
import { useFetch } from "../hooks";
import { SkeletonLines, fmtAge } from "../components";
import { Modal } from "../dashboards/ui";
import { listDescriptor } from "../dashboards/runtime";
import { forSave, isSlug, normalizeDefinition, slugify } from "../dashboards/model";

export default function Dashboards({ route }) {
  const fixture = route.query.fixture === "1";
  const { data, error, loading, reload } = useFetch(() => listDescriptor({ fixture }), [fixture]);
  const [dialog, setDialog] = useState(null);      // "new" | {clone: summary}
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const all = useMemo(() => (data?.dashboards || []).map((d) => ({
    id: d.id,
    title: d.title || d.id,
    description: d.description || "",
    builtin: !!d.builtin,
    panels: typeof d.panels === "number" ? d.panels : (d.panels || []).length,
    variables: (d.variables || []).map((v) => (typeof v === "string" ? v : v?.name)).filter(Boolean),
    updated_at: d.updated_at || null,
  })), [data]);

  const builtin = all.filter((d) => d.builtin);
  const saved = all.filter((d) => !d.builtin);

  const open = (id) => route.navigate(`/dashboards/${encodeURIComponent(id)}`,
    fixture ? { fixture: "1" } : {});

  const create = (id) => {
    setDialog(null);
    route.navigate(`/dashboards/${encodeURIComponent(id)}`,
      fixture ? { fixture: "1", new: "1" } : { new: "1" });
  };

  // Cloning is a read of the original and a write under the new id, which is the
  // only way to get a built-in into a shape the editor is allowed to touch.
  const clone = async (source, newId) => {
    setBusy(true);
    setProblem("");
    try {
      const def = normalizeDefinition(await api.dashboard(source.id), source.id);
      await api.saveDashboard(newId, forSave({ ...def, id: newId, title: `${def.title} (copy)` }));
      invalidate("/api/dashboards");
      setDialog(null);
      route.navigate(`/dashboards/${encodeURIComponent(newId)}`);
    } catch (e) {
      setProblem(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="section-head">
        <div>
          <div className="section-title" style={{ margin: 0 }}>
            Dashboards
            {fixture && <span className="tag db-tag">fixture</span>}
          </div>
          <div className="desc">
            Several queries on one page, with the variables they share at the top. Every panel is
            a guarded SELECT over the same snapshot, so a dashboard is a link.
          </div>
        </div>
        <div className="db-head-actions">
          <button type="button" className="btn" disabled={loading} onClick={reload}>↻ Refresh</button>
          {/* The other way to make one: describe it and let the agent compose it
              from these same panels. It lands here once it is saved. */}
          <button type="button" className="btn"
            onClick={() => route.navigate("/generate", fixture ? { fixture: "1" } : {})}>
            Generate from a question
          </button>
          <button type="button" className="btn primary" onClick={() => setDialog("new")}>
            New dashboard
          </button>
        </div>
      </div>

      {problem && <div className="banner">{problem}</div>}
      {error ? <Unavailable error={error} route={route} fixture={fixture} />
        : !data ? <SkeletonLines rows={6} />
          : all.length === 0 ? (
            <div className="card">
              <div className="empty">
                No dashboards yet. "New dashboard" starts an empty one.
              </div>
            </div>
          ) : (
            <>
              {builtin.length > 0 && (
                <Group title="Built in" desc="Shipped with the data layer. Clone one to change it.">
                  {builtin.map((d) => (
                    <Card key={d.id} dashboard={d} onOpen={() => open(d.id)}
                      onClone={() => { setProblem(""); setDialog({ clone: d }); }} />
                  ))}
                </Group>
              )}
              {saved.length > 0 && (
                <Group title="Saved" desc="Made here, stored in the data layer.">
                  {saved.map((d) => (
                    <Card key={d.id} dashboard={d} onOpen={() => open(d.id)} />
                  ))}
                </Group>
              )}
            </>
          )}

      {dialog === "new" && (
        <NameDialog
          title="New dashboard"
          intro="The id is the URL this dashboard is shared under, so pick one that will still read well later."
          placeholder="Hub capacity review"
          busy={false}
          onCancel={() => setDialog(null)}
          onSubmit={create}
        />
      )}

      {dialog && dialog.clone && (
        <NameDialog
          title={`Clone "${dialog.clone.title}"`}
          intro="A copy under a new id, with every panel and variable, which you can then edit."
          initial={`${dialog.clone.id}-copy`}
          busy={busy}
          onCancel={() => setDialog(null)}
          onSubmit={(newId) => clone(dialog.clone, newId)}
        />
      )}
    </div>
  );
}

function Group({ title, desc, children }) {
  return (
    <div>
      <div className="section-head" style={{ marginBottom: 10 }}>
        <div>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <div className="desc">{desc}</div>
        </div>
      </div>
      <div className="db-cards">{children}</div>
    </div>
  );
}

function Card({ dashboard, onOpen, onClone }) {
  const d = dashboard;
  return (
    <div className="db-card card">
      <button type="button" className="db-card-main" onClick={onOpen}>
        <div className="db-card-title">
          <Template text={d.title} />
          {d.builtin && <span className="tag db-tag">built in</span>}
        </div>
        <div className="db-card-desc">
          {d.description ? <Template text={d.description} /> : "No description."}
        </div>
      </button>
      <div className="db-card-foot">
        <span className="muted">{d.panels} {d.panels === 1 ? "panel" : "panels"}</span>
        {d.variables.length > 0 && (
          <span className="db-card-vars">
            {d.variables.map((v) => <span key={v} className="tag mono">{v}</span>)}
          </span>
        )}
        <span className="db-vars-spacer" />
        {d.updated_at && <span className="muted">updated {fmtAge(d.updated_at)} ago</span>}
        {onClone && (
          <button type="button" className="q-mini" onClick={onClone}>Clone</button>
        )}
      </div>
    </div>
  );
}

// A title on the list has no variables to put in it yet, so the slot is shown
// as the variable that will fill it rather than as a literal {{hub}} or a gap.
const SLOT = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function Template({ text }) {
  const parts = String(text || "").split(SLOT);
  return (
    <>
      {parts.map((part, i) => (i % 2
        ? <span key={i} className="db-slot">{part}</span>
        : <span key={i}>{part}</span>))}
    </>
  );
}

function NameDialog({ title, intro, initial = "", placeholder, busy, onCancel, onSubmit }) {
  const [value, setValue] = useState(initial);
  const id = slugify(value);
  const ok = isSlug(id);
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={(
        <>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn primary" disabled={!ok || busy}
            onClick={() => onSubmit(id)}>
            {busy ? "Working…" : "Create"}
          </button>
        </>
      )}
    >
      <p className="q-desc" style={{ marginTop: 0 }}>{intro}</p>
      <label className="db-field wide">
        <span className="db-field-label">Name</span>
        <input type="text" value={value} autoFocus placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && ok) onSubmit(id); }} />
        <span className="db-field-hint">The URL will be /dashboards/{id || "…"}</span>
      </label>
    </Modal>
  );
}

// The dashboard plane is the newest part of the API. A build without it answers
// 404 here, which is a fact about the server rather than a broken page - so the
// page says which, and offers the fixture that needs only the query plane.
function Unavailable({ error, route, fixture }) {
  const missing = error?.status === 404;
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>
        {missing ? "This data layer does not serve dashboards yet" : "Dashboards could not be loaded"}
      </h3>
      <p className="desc" style={{ marginTop: 0, fontSize: 13 }}>
        {missing
          ? "GET /api/dashboards answered 404. The dashboard plane arrives with the next API build; everything else on this page works without it."
          : String(error?.message || error)}
      </p>
      {!fixture && (
        <p className="q-desc">
          <span className="link" onClick={() => route.navigate("/dashboards", { fixture: "1" })}>
            Load the sample dashboards
          </span>
          {" "}to see the page working against the query plane alone.
        </p>
      )}
    </div>
  );
}
