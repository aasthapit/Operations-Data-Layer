// The few pieces of chrome the dashboard pages need that the rest of the app
// never has: a menu on a panel, a modal for the small decisions (name this
// dashboard, add this query to one) and a drawer for the big ones (write a
// panel). All three close on Escape and on a click outside, and all three are
// built from the same tokens as every card in the app.
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { isSlug, slugify } from "./model";

// Escape closes; a click outside closes; focus moves in when it opens and back
// to where it was when it leaves.
function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void,
  { restoreFocus = false }: { restoreFocus?: boolean } = {}) {
  useEffect(() => {
    // `activeElement` is an Element; only an HTMLElement can be focused back.
    const previous = restoreFocus ? (document.activeElement as HTMLElement | null) : null;
    // The press that opened this is still travelling when the listener goes on,
    // and it landed outside - so outside-clicks only count from the next tick,
    // or the thing would close itself the instant it opened.
    let armed = false;
    const arm = setTimeout(() => { armed = true; }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    const onDown = (e: MouseEvent) => {
      if (armed && ref.current && !ref.current.contains(e.target as Node)) onClose();
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

/** One entry of a panel menu. A menu with no live entries draws nothing. */
export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Drawn in the destructive tone - "Remove" is the only one today. */
  danger?: boolean;
}

export interface MenuProps {
  label?: ReactNode;
  title?: string;
  /** Entries are written inline as `editing && {...}`, so the falsy ones are
   * part of the shape rather than something the caller filters out first. */
  items?: ReadonlyArray<MenuItem | false | null | undefined>;
}

export function Menu({ label = "⋯", title = "Panel menu", items }: MenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = useRef(() => setOpen(false)).current;
  useDismiss(ref, open ? close : noop);
  const live = (items || []).filter(Boolean) as MenuItem[];
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

export interface ModalProps {
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number | string;
}

export function Modal({ title, children, footer, onClose, width = 460 }: ModalProps) {
  const ref = useRef<HTMLDivElement | null>(null);
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

export interface DrawerProps {
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}

export function Drawer({ title, children, footer, onClose }: DrawerProps) {
  const ref = useRef<HTMLDivElement | null>(null);
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
export interface IdDialogProps {
  title: string;
  intro: ReactNode;
  /** What the field starts at; the id that is saved is its slug. */
  defaultId: string;
  busy?: boolean;
  /** What the API said about the id, shown in place of the hint. */
  error?: string | null;
  submitLabel?: string;
  onCancel: () => void;
  onSubmit: (id: string) => void;
}

export function IdDialog({
  title, intro, defaultId, busy, error, submitLabel = "Continue", onCancel, onSubmit,
}: IdDialogProps) {
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
export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** The message the API attached to this field; it replaces the hint. */
  error?: string | null;
  children?: ReactNode;
  wide?: boolean;
}

export function Field({ label, hint, error, children, wide }: FieldProps) {
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
export interface StepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  suffix?: string;
}

export function Stepper({ label, value, min, max, onChange, suffix }: StepperProps) {
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
