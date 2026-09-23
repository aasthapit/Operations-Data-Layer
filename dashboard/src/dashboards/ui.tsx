// The few pieces of chrome the dashboard pages need that the rest of the app
// never has: a menu on a panel, a modal for the small decisions (name this
// dashboard, add this query to one) and a drawer for the big ones (write a
// panel).
//
// All three are MUI's own overlays (ADR-0005, phase 3), which is what retired
// the hand-rolled dismissal this file used to carry: Escape, the click outside,
// the focus that moves in when one opens and back to where it was when it
// leaves, and the scroll lock underneath are the library's, not ours.
import { cloneElement, isValidElement, useId, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Drawer as MuiDrawer,
  IconButton, Menu as MuiMenu, MenuItem as MuiMenuItem, TextField, Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { MONO_FONT } from "../components";
import { isSlug, slugify } from "./model";

/** The id every overlay's backdrop carries. The backdrop is the overlay's own
 * shape rather than a control, so it has no role and no name; this is the one
 * handle anything outside has on it, and only one overlay is ever open. */
export const BACKDROP_ID = "odl-overlay-backdrop";

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
  // The anchor is the button itself, which is what the menu positions against.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const live = (items || []).filter(Boolean) as MenuItem[];
  if (!live.length) return null;
  const open = !!anchor;
  return (
    <Box sx={{ position: "relative" }}>
      <IconButton
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{
          color: "text.disabled", border: 1, borderColor: "transparent", borderRadius: "6px",
          px: 0.875, py: 0.125, fontSize: 15, lineHeight: 1.3,
          "&:hover, &[aria-expanded='true']": { borderColor: "divider", color: "text.primary" },
        }}
      >
        {label}
      </IconButton>
      <MuiMenu
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ list: { sx: { minWidth: 160, py: 0.5 } }, backdrop: { id: BACKDROP_ID } }}
      >
        {live.map((item) => (
          <MuiMenuItem
            key={item.label}
            data-danger={item.danger || undefined}
            onClick={() => { setAnchor(null); item.onSelect(); }}
            sx={item.danger
              ? { color: "error.main", "&:hover": { bgcolor: "error.main", color: "common.white" } }
              : undefined}
          >
            {item.label}
          </MuiMenuItem>
        ))}
      </MuiMenu>
    </Box>
  );
}

/** The close button both overlays wear. Its name is the word plus what it
 * closes - "×" is a shape a screen reader cannot read out, and a bare "Close"
 * would be the same name as a dialog's own Close button in its footer. */
function CloseButton({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <IconButton
      aria-label={`Close ${title}`}
      onClick={onClose}
      sx={{ flex: "none", border: 1, borderColor: "divider", borderRadius: "6px", p: 0.25 }}
    >
      <CloseIcon sx={{ fontSize: 14 }} />
    </IconButton>
  );
}

export interface ModalProps {
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number | string;
}

export function Modal({ title, children, footer, onClose, width = 460 }: ModalProps) {
  return (
    <Dialog
      open
      onClose={onClose}
      aria-label={title}
      slotProps={{
        paper: { sx: { width, maxWidth: "100%" } },
        backdrop: { id: BACKDROP_ID },
      }}
    >
      <DialogTitle
        component="div"
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1.5, p: "18px 18px 12px" }}
      >
        <Typography variant="h4" color="text.secondary">{title}</Typography>
        <CloseButton title={title} onClose={onClose} />
      </DialogTitle>
      <DialogContent sx={{ p: "0 18px 18px" }}>{children}</DialogContent>
      {footer && (
        <DialogActions sx={{ p: "14px 18px", borderTop: 1, borderColor: "border.soft" }}>
          {footer}
        </DialogActions>
      )}
    </Dialog>
  );
}

export interface DrawerProps {
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}

export function Drawer({ title, children, footer, onClose }: DrawerProps) {
  return (
    <MuiDrawer
      open
      anchor="right"
      onClose={onClose}
      slotProps={{
        paper: {
          role: "dialog",
          "aria-modal": true,
          "aria-label": title,
          sx: { width: "min(620px, 100%)", display: "flex", flexDirection: "column" },
        },
        backdrop: { id: BACKDROP_ID },
      }}
    >
      <Box sx={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1.5,
        p: "14px 18px", borderBottom: 1, borderColor: "divider", flex: "none",
      }}>
        <Typography variant="h4" color="text.secondary">{title}</Typography>
        <CloseButton title={title} onClose={onClose} />
      </Box>
      <Box sx={{ flex: 1, overflow: "auto", p: "16px 18px" }}>{children}</Box>
      {footer && (
        <Box sx={{
          display: "flex", justifyContent: "flex-end", gap: 1, flex: "none",
          p: "12px 18px", borderTop: 1, borderColor: "divider", bgcolor: "background.subtle",
        }}>
          {footer}
        </Box>
      )}
    </MuiDrawer>
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
          <Button variant="outlined" color="inherit" onClick={onCancel}>Cancel</Button>
          <Button variant="contained" disabled={!ok || busy} onClick={() => onSubmit(id)}>
            {busy ? "Saving…" : submitLabel}
          </Button>
        </>
      )}
    >
      <Typography variant="caption" color="text.disabled" sx={{ display: "block", mb: 1.75 }}>
        {intro}
      </Typography>
      <TextField
        fullWidth
        label="Id"
        value={value}
        autoFocus
        error={!!error}
        helperText={error || <>The URL will be /dashboards/{id || "…"}</>}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && ok) onSubmit(id); }}
        slotProps={{ htmlInput: { style: { fontFamily: MONO_FONT } }, inputLabel: { shrink: true } }}
      />
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
  // The label names the control through `htmlFor` rather than by wrapping it.
  // An outlined MUI field draws a <legend> inside its own border, and a label
  // wrapped round one would take that legend's text into the name it gives the
  // control - which is the field's own name plus an invisible character.
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string }>, { id })
    : children;
  return (
    <Box
      sx={{
        display: "flex", flexDirection: "column", gap: 0.5, mb: 1.75, minWidth: 150,
        ...(wide ? { width: "100%" } : {}),
      }}
    >
      <Typography component="label" htmlFor={id} variant="subtitle2" color="text.secondary">
        {label}
      </Typography>
      {control}
      {error
        ? <Typography variant="caption" color="error.main">{error}</Typography>
        : hint ? <Typography variant="caption" color="text.disabled">{hint}</Typography> : null}
    </Box>
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
  const step = (to: number, name: string, glyph: string, disabled: boolean) => (
    <Button
      variant="outlined"
      color="inherit"
      disabled={disabled}
      onClick={() => onChange(to)}
      aria-label={`${name} ${label}`}
      sx={{ minWidth: 0, px: 0.875, py: 0.125, fontSize: 11, lineHeight: 1.5 }}
    >
      {glyph}
    </Button>
  );
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, mb: 1.75 }}>
      <Typography variant="subtitle2" color="text.secondary">{label}</Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
        {step(value - 1, "Decrease", "−", value <= min)}
        <Box component="span" sx={{
          minWidth: 54, textAlign: "center", color: "text.secondary", fontFamily: MONO_FONT,
          fontSize: 12.5,
        }}>
          {value}{suffix ? ` ${suffix}` : ""}
        </Box>
        {step(value + 1, "Increase", "+", value >= max)}
      </Box>
    </Box>
  );
}
