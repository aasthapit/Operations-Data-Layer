// The few pieces of chrome the dashboard pages need that the rest of the app
// never has: a menu on a panel, a modal for the small decisions (name this
// dashboard, add this query to one) and a drawer for the big ones (write a
// panel). All three close on Escape and on a click outside, and all three are
// built from the same tokens as every card in the app.
import { useEffect, useRef, useState } from "react";
import { isSlug, slugify } from "./model";

// Escape closes; a click outside closes; focus moves in when it opens and back
// to where it was when it leaves.
function useDismiss(ref, onClose, { restoreFocus = false } = {}) {
  useEffect(() => {
    const previous = restoreFocus ? document.activeElement : null;
    // The press that opened this is still travelling when the listener goes on,
    // and it landed outside - so outside-clicks only count from the next tick,
    // or the thing would close itself the instant it opened.
    let armed = false;
    const arm = setTimeout(() => { armed = true; }, 0);
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const onDown = (e) => {
      if (armed && ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      clearTimeout(arm);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
      if (previous && previous.focus) previous.focus();
    };
  }, [ref, onClose, restoreFocus]);
}

export function Menu({ label = "⋯", title = "Panel menu", items }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const close = useRef(() => setOpen(false)).current;
  useDismiss(ref, open ? close : noop);
  const live = (items || []).filter(Boolean);
  if (!live.length) return null;
  return (
    <div className="db-menu" ref={ref}>
      <button
        type="button"
        className="db-menu-btn"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div className="db-menu-pop" role="menu">
          {live.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              onClick={() => { setOpen(false); item.onSelect(); }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const noop = () => {};

export function Modal({ title, children, footer, onClose, width = 460 }) {
  const ref = useRef(null);
  useDismiss(ref, onClose, { restoreFocus: true });
  return (
    <div className="db-scrim">
      <div className="db-modal card" style={{ width }} role="dialog" aria-modal="true"
        aria-label={title} ref={ref}>
        <div className="section-head" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button type="button" className="q-x" title="Close" onClick={onClose}>×</button>
        </div>
        {children}
        {footer && <div className="db-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, children, footer, onClose }) {
  const ref = useRef(null);
  useDismiss(ref, onClose, { restoreFocus: true });
  return (
    <div className="db-scrim db-scrim-right">
      <div className="db-drawer" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="db-drawer-head">
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button type="button" className="q-x" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="db-drawer-body">{children}</div>
        {footer && <div className="db-drawer-foot">{footer}</div>}
      </div>
    </div>
  );
}

// Naming a dashboard is naming a URL: the id it is saved under is the link it
// will be shared as for the rest of its life. Cloning one, saving one under a
// new name and saving what the agent just generated all ask the same question,
// so they ask it with the same dialog.
export function IdDialog({
  title, intro, defaultId, busy, error, submitLabel = "Continue", onCancel, onSubmit,
}) {
  const [value, setValue] = useState(defaultId);
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
            {busy ? "Saving…" : submitLabel}
          </button>
        </>
      )}
    >
      <p className="q-desc" style={{ marginTop: 0 }}>{intro}</p>
      <label className="db-field wide">
        <span className="db-field-label">Id</span>
        <input type="text" className="mono" value={value} autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && ok) onSubmit(id); }} />
        {error ? <span className="db-field-error">{error}</span>
          : <span className="db-field-hint">The URL will be /dashboards/{id || "…"}</span>}
      </label>
    </Modal>
  );
}

// A labelled field with room for the message the API attached to it.
export function Field({ label, hint, error, children, wide }) {
  return (
    <label className={`db-field${wide ? " wide" : ""}`}>
      <span className="db-field-label">{label}</span>
      {children}
      {error ? <span className="db-field-error">{error}</span>
        : hint ? <span className="db-field-hint">{hint}</span> : null}
    </label>
  );
}

// A number the user nudges rather than types: panel widths and heights are small
// integers with hard limits, and a stepper says so without a validation message.
export function Stepper({ label, value, min, max, onChange, suffix }) {
  return (
    <div className="db-stepper">
      <span className="db-field-label">{label}</span>
      <div className="db-stepper-row">
        <button type="button" className="q-mini" disabled={value <= min}
          onClick={() => onChange(value - 1)} aria-label={`Decrease ${label}`}>−</button>
        <span className="db-stepper-value mono">{value}{suffix ? ` ${suffix}` : ""}</span>
        <button type="button" className="q-mini" disabled={value >= max}
          onClick={() => onChange(value + 1)} aria-label={`Increase ${label}`}>+</button>
      </div>
    </div>
  );
}
