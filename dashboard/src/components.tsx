// Small shared presentational components + formatters.
import React, { useEffect, useRef, useState } from "react";
import type {
  CSSProperties, ErrorInfo, InputHTMLAttributes, MouseEventHandler, ReactNode,
} from "react";
import {
  Alert, Box, Button, ButtonBase, Chip, Link, Paper, Skeleton as MuiSkeleton, Table, TableBody,
  TableCell, TableRow, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography, useTheme,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { SxProps, Theme } from "@mui/material/styles";

// The one table primitive every view uses: sorting, per-column filters, search.
export { default as DataTable } from "./DataTable";
export type { Column, ColumnDef, DataTableProps } from "./DataTable";

// ---- status tones ---------------------------------------------------------
// Every health word the API uses, and the palette slot it reads out of.
//
// These resolve through MUI's *standard* slots rather than through the theme's
// own `palette.status`, and that is deliberate: `Pill` and `Dot` are rendered
// by DataTable and ResultTable, whose tests (phases 4 and 5) render them with
// no ThemeProvider around them. A standard slot is there in MUI's stock theme;
// a custom one is not, and the component would throw. Everything else in this
// file is only ever rendered by a view, so it reads `palette.status` directly.
const TONE_SLOT: Record<string, "success" | "warning" | "error"> = {
  healthy: "success", pass: "success", ok: "success",
  warning: "warning", warn: "warning",
  critical: "error", fail: "error",
};

/** The colour a status word wears. Anything unrecognised - "unknown", or a
 * state the API grew since - is the faint text colour, which reads as "no
 * reading" rather than as a verdict. */
function toneColor(theme: Theme, status?: string | null): string {
  const slot = TONE_SLOT[status || ""];
  return slot ? theme.palette[slot].main : theme.palette.text.disabled;
}

/** A health status as the API spells it, plus the "unknown" the UI falls back
 * to when a cluster has never reported one. */
export interface PillProps {
  status?: string | null;
  /** The word to show, when it is not the status itself - a patch job's
   * "paused" wearing the warning tone, say. */
  children?: ReactNode;
}

// A status, spelled out, on a tint of its own colour.
//
// Still one span carrying `pill <status>` rather than a MUI Chip: DataTable and
// ResultTable render this and their tests - which phases 4 and 5 own and this
// phase must not edit - assert on exactly this element and these class names.
// The classes carry no CSS any more (the tint and the type come from the theme
// below); they are a handle those two files still hold, and a Chip is what this
// becomes once they land.
export function Pill({ status, children }: PillProps) {
  const s = status || "unknown";
  return (
    <Box
      component="span"
      className={`pill ${s}`}
      sx={{
        display: "inline-flex", alignItems: "center", gap: 0.75,
        px: 1.125, py: 0.375, borderRadius: 20,
        fontSize: 12, fontWeight: 600, textTransform: "capitalize",
        bgcolor: (t) => alpha(toneColor(t, s), 0.14),
        color: (t) => toneColor(t, s),
      }}
    >
      <Dot status={s} />{children ?? s}
    </Box>
  );
}

export interface DotProps {
  status?: string | null;
}

export function Dot({ status }: DotProps) {
  const s = status || "unknown";
  return (
    <Box
      component="span"
      className={`dot-s ${s}`}
      sx={{
        width: 8, height: 8, borderRadius: "50%", display: "inline-block", flex: "none",
        bgcolor: (t) => toneColor(t, s),
      }}
    />
  );
}

/** The counts a health bar is drawn from. It is a record rather than a fixed
 * shape because the bar draws the four statuses it knows and ignores the rest,
 * which is what lets a caller hand over a whole summary object. */
export type HealthCounts = Record<string, number>;

export interface HealthBarProps {
  counts: HealthCounts;
}

const HEALTH_ORDER = ["healthy", "warning", "critical", "unknown"];

// Stacked health bar from a counts object {healthy,warning,critical,unknown}.
export function HealthBar({ counts }: HealthBarProps) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  // The breakdown is the bar's only text, so it is its accessible name as well
  // as what the tooltip says - a bar nobody can hover still has to be readable.
  const summary = HEALTH_ORDER.map((k) => `${k}: ${counts[k] || 0}`).join("  ");
  return (
    <Tooltip title={summary}>
      <Box
        role="img"
        aria-label={summary}
        sx={{
          display: "flex", height: 10, borderRadius: "6px", overflow: "hidden",
          bgcolor: "background.subtle", position: "relative",
        }}
      >
        {HEALTH_ORDER.map((k) =>
          counts[k] ? (
            <Box
              key={k}
              component="span"
              data-status={k}
              sx={{
                display: "block", height: "100%",
                width: `${(counts[k] / total) * 100}%`,
                bgcolor: (t) => t.palette.status[k as keyof typeof t.palette.status].main,
              }}
            />
          ) : null
        )}
      </Box>
    </Tooltip>
  );
}

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  /** A tone - "critical", "warning", "accent" - not a fixed union, since a view
   * hands over whatever word the number means. */
  kind?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  sub?: ReactNode;
}

/** The tone of a stat's number. "accent" is the one word that is not a health
 * status: it means "this is the figure to read first". */
function statColor(theme: Theme, kind?: string): string | undefined {
  if (!kind) return undefined;
  if (kind === "accent") return theme.palette.primary.main;
  const tone = theme.palette.status[kind as keyof typeof theme.palette.status];
  return tone ? tone.main : undefined;
}

export function Stat({ label, value, kind, onClick, sub }: StatProps) {
  // A label and a figure, not two paragraphs: spans is what they are, and it is
  // what keeps a tile's label distinguishable from a card heading of the same
  // word.
  const body = (
    <>
      <Typography variant="body2" component="span" color="text.secondary" sx={{ display: "block" }}>
        {label}
      </Typography>
      <Typography
        variant="subtitle1"
        component="span"
        sx={{ display: "block", mt: 0.5, color: (t) => statColor(t, kind) }}
      >
        {value}
      </Typography>
      {sub && (
        <Typography variant="caption" color="text.disabled" sx={{ display: "block", mt: 0.25 }}>
          {sub}
        </Typography>
      )}
    </>
  );
  // A tile that goes somewhere is a button, so it is reachable by keyboard and
  // announced as something to press. One that does not is a plain surface.
  if (!onClick) return <Paper sx={{ p: "16px 18px" }}>{body}</Paper>;
  return (
    <Paper sx={{ "&:hover": { borderColor: "primary.main" } }}>
      <ButtonBase
        onClick={onClick}
        sx={{
          display: "block", width: "100%", textAlign: "left", p: "16px 18px",
          borderRadius: "inherit",
        }}
      >
        {body}
      </ButtonBase>
    </Paper>
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
export function Sparkline({ points, width = 260, height = 48, color, max = 100 }: SparklineProps) {
  const theme = useTheme();
  if (!points || points.length === 0) {
    return <Typography variant="caption" color="text.disabled">no history</Typography>;
  }
  const stroke = color || theme.palette.chart.line;
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
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
      <path d={area} fill={stroke} opacity="0.12" />
      <path d={d} fill="none" stroke={stroke} strokeWidth="2" />
    </svg>
  );
}

export function Loading() {
  return (
    <Typography sx={{ p: 5, textAlign: "center" }} color="text.disabled">Loading…</Typography>
  );
}

// ---- pending placeholders -------------------------------------------------
// A view paints its frame, its filters and anything already cached straight
// away; whatever is still on the wire shows as a block the same shape and size
// as the content that will replace it, so nothing jumps when it lands. MUI's
// Skeleton draws the sweep and drops it under prefers-reduced-motion.
export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}

export function Skeleton({ width = "100%", height = 12, style }: SkeletonProps) {
  // The size is written inline rather than handed to MUI as props: a caller
  // measures a placeholder against the content it stands in for, and an inline
  // rule is the one a test and a browser both read back unambiguously.
  // `data-placeholder` is how a test asks "is this view still standing in for
  // content?" without reaching for a library class name.
  return <MuiSkeleton variant="rounded" data-placeholder="" style={{ width, height, ...style }} />;
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
    <Table size={dense ? "small" : "medium"} aria-hidden="true">
      <TableBody>
        {Array.from({ length: rows }, (_, r) => (
          <TableRow key={r}>
            {Array.from({ length: columns }, (_, c) => (
              <TableCell key={c}>
                <Skeleton width={CELL_WIDTHS[(r + c * 3) % CELL_WIDTHS.length]} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export interface SkeletonStatsProps {
  count?: number;
}

export function SkeletonStats({ count = 6 }: SkeletonStatsProps) {
  return (
    <StatGrid aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <Paper key={i} sx={{ p: "16px 18px" }}>
          <Skeleton width="60%" height={11} />
          <Skeleton width="42%" height={26} style={{ marginTop: 4 }} />
        </Paper>
      ))}
    </StatGrid>
  );
}

export interface SkeletonLinesProps {
  rows?: number;
  height?: number;
}

export function SkeletonLines({ rows = 4, height = 14 }: SkeletonLinesProps) {
  return (
    <Box aria-hidden="true" sx={{ display: "flex", flexDirection: "column", gap: 1.25, py: 1.75 }}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width={CELL_WIDTHS[i % CELL_WIDTHS.length]} height={height} />
      ))}
    </Box>
  );
}

// ---- text runs ------------------------------------------------------------
// The four inline treatments the views reach for constantly. They exist so a
// page says what a run of text means - secondary, a reading, a status, a label
// - instead of repeating the same `sx` in forty places.

export interface TextRunProps {
  children?: ReactNode;
  sx?: SxProps<Theme>;
  title?: string;
  /** A marker for anything that wants to find this run of text again - a
   * template slot in a dashboard title, say. */
  "data-slot"?: string;
}

/** Supporting text: a unit, a count beside a name, a timestamp. */
export function Muted({ children, sx, title, "data-slot": slot }: TextRunProps) {
  return (
    <Box component="span" title={title} data-slot={slot} sx={{ color: "text.disabled", ...sx }}>
      {children}
    </Box>
  );
}

/** A value that has to line up with the one above it: an id, a digest, a
 * version, a namespace. */
export function Mono({ children, sx, title }: TextRunProps) {
  return (
    <Box component="span" title={title} sx={{ fontFamily: MONO_FONT, fontSize: 12.5, ...sx }}>
      {children}
    </Box>
  );
}

export interface ToneTextProps extends TextRunProps {
  /** A health word, or "accent" for the figure to read first. */
  tone?: string;
}

/** A number or a word in the colour of what it says: three failures in red,
 * eight passes in green. */
export function ToneText({ tone, children, sx, title }: ToneTextProps) {
  return (
    <Box component="span" title={title} sx={{ color: (t) => statColor(t, tone), ...sx }}>
      {children}
    </Box>
  );
}

export interface TagProps {
  children?: ReactNode;
  /** A health word when the tag is a verdict; left out it is a plain label. */
  tone?: string;
  /** The state this tag names, for anything that wants to read it back off the
   * DOM rather than off the colour. */
  "data-status"?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  onDelete?: () => void;
  title?: string;
  sx?: SxProps<Theme>;
}

/** A small square label - an environment, a kind, a variable name. The rounded
 * status pill is `Pill`; this one is for things that are not verdicts. */
export function Tag({ children, tone, onClick, onDelete, title, sx, "data-status": status }: TagProps) {
  // A tag with nothing in it is an empty outlined box, which reads as a value
  // the row does have. A row with no environment has no environment.
  if (children === "" || children == null) return null;
  return (
    <Chip
      variant="outlined"
      label={children}
      title={title}
      onClick={onClick}
      onDelete={onDelete}
      data-tone={tone}
      data-status={status}
      sx={{
        borderRadius: "5px", fontWeight: 400, fontSize: 11.5, height: 20,
        color: tone ? (t) => statColor(t, tone) : "text.secondary",
        borderColor: tone ? (t) => alpha(String(statColor(t, tone)), 0.4) : "divider",
        ...sx,
      }}
    />
  );
}

// ---- layout ---------------------------------------------------------------
// The two arrangements every view reaches for, so a page does not restate the
// same grid rule in `sx` a dozen times.

export interface StatGridProps {
  children?: ReactNode;
  sx?: SxProps<Theme>;
  /** True while the tiles are placeholders, so a screen reader is not read a
   * grid of empty boxes. */
  "aria-hidden"?: boolean;
}

/** A row of stat tiles that wraps into as many columns as fit. */
export function StatGrid({ children, sx, "aria-hidden": ariaHidden }: StatGridProps) {
  return (
    <Box
      aria-hidden={ariaHidden || undefined}
      sx={{
        display: "grid", gap: 1.75,
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}

export interface CardProps {
  /** The small uppercase label along the top of the card. */
  title?: ReactNode;
  /** What to call the card when its title is more than a word - a heading with
   * a chip after it, say. Defaults to the title when that is a plain string. */
  label?: string;
  /** A sentence under the title saying what the card is for. */
  description?: ReactNode;
  /** Actions that sit on the title's own line, to the right. */
  action?: ReactNode;
  /** True when the content runs to the card's edges - a table, a chart - so the
   * head keeps its padding and the body has none. */
  flush?: boolean;
  children?: ReactNode;
  sx?: SxProps<Theme>;
}

/** A panel: a surface, an optional label, and whatever the view puts in it.
 *
 * A titled card is a `<section>` named after its title, which makes it a
 * landmark: a page with five tables on it is navigable by card, and a test can
 * scope a query to one card by name rather than by where it sits in the DOM. */
export function Card({ title, label, description, action, flush, children, sx }: CardProps) {
  const head = title || description || action;
  const name = label ?? (typeof title === "string" ? title : undefined);
  return (
    <Paper
      component={name ? "section" : "div"}
      aria-label={name}
      sx={{ p: flush ? 0 : "18px", overflow: "hidden", ...sx }}
    >
      {head && (
        <Box sx={flush ? { p: "18px 18px 0" } : undefined}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: description ? 0.75 : 1.75 }}>
            {title && <Typography variant="h4" color="text.secondary" sx={{ flex: 1 }}>{title}</Typography>}
            {action}
          </Box>
          {description && (
            <Typography variant="body2" color="text.disabled" sx={{ mb: 1.5 }}>{description}</Typography>
          )}
        </Box>
      )}
      {children}
    </Paper>
  );
}

export interface KeyValuesProps {
  children?: ReactNode;
  /** How many label/value pairs sit side by side on one line. */
  columns?: number;
  sx?: SxProps<Theme>;
}

/** A definition list laid out as a grid, so every value lines up however long
 * its label is. Children alternate: label, value, label, value. */
export function KeyValues({ children, columns = 1, sx }: KeyValuesProps) {
  return (
    <Box sx={{
      display: "grid",
      gridTemplateColumns: Array.from({ length: columns }, () => "max-content 1fr").join(" "),
      gap: "6px 18px",
      fontSize: 12.5,
      ...sx,
    }}>
      {children}
    </Box>
  );
}

/** The label half of a `KeyValues` row. */
export function KeyLabel({ children, sx }: TextRunProps) {
  return <Box component="span" sx={{ color: "text.secondary", ...sx }}>{children}</Box>;
}

export interface SectionHeadProps {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

/** A view's own heading, with whatever controls belong to the whole page. */
export function SectionHead({ title, description, children }: SectionHeadProps) {
  return (
    <Box sx={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      gap: 1.5, flexWrap: "wrap", mb: 1.75,
    }}>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h2" component="h2">{title}</Typography>
        {description && (
          <Typography variant="body2" color="text.disabled">{description}</Typography>
        )}
      </Box>
      {children}
    </Box>
  );
}

/** Everything a plain `<input>` takes, except that `value` is the committed
 * text and `onChange` reports it rather than an event. */
export interface SearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "size"> {
  value?: string | null;
  onChange: (value: string) => void;
  delay?: number;
  sx?: SxProps<Theme>;
}

// Text input that reports after the user stops typing, so a filter that lives
// in the URL does not write a history entry (or fire a request) per keystroke.
export function SearchInput({ value, onChange, delay = 300, sx, ...rest }: SearchInputProps) {
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

  // Everything the caller passed belongs to the <input>, not to the field around
  // it: an aria-label on the wrapper would name a div nobody can type into.
  return (
    <TextField
      type="text"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      sx={{ minWidth: 220, ...sx }}
      slotProps={{ htmlInput: rest }}
    />
  );
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
  return <Alert severity="error" sx={{ mb: 2 }}>Error: {message}</Alert>;
}

export interface EmptyProps {
  children?: ReactNode;
}

export function Empty({ children }: EmptyProps) {
  return (
    <Typography sx={{ p: 3.5, textAlign: "center" }} color="text.disabled" variant="body1">
      {children}
    </Typography>
  );
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
    <ToggleButtonGroup
      value={value}
      // `exclusive` answers null when the pressed button was already the chosen
      // one. Sub-navigation has no "none" state, so that is simply ignored.
      onChange={(_, next: string | null) => { if (next !== null) onChange(next); }}
    >
      {tabs.map(([k, label, count]) => (
        <ToggleButton key={k} value={k}>
          {label}
          {count != null && (
            <Box component="span" sx={{
              ml: 0.75, fontSize: 11,
              // On the chosen tab the count sits on the filled accent, so it
              // steps back from the label with the contrast text rather than
              // with a grey that would disappear into it.
              color: (t) => (value === k
                ? alpha(t.palette.primary.contrastText, 0.75)
                : t.palette.text.disabled),
            }}>
              {count}
            </Box>
          )}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

export interface FilterSelectProps {
  label: string;
  value?: string | null;
  options: readonly string[];
  onChange: (value: string) => void;
  allLabel?: string;
}

// A filter bar's dropdown. Native on purpose: the list is short, the control is
// one of six in a row, and a native select is the fastest thing to operate with
// a keyboard or a screen reader.
export function FilterSelect({ label, value, options, onChange, allLabel = "All" }: FilterSelectProps) {
  return (
    <TextField
      select
      label={label}
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
      slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
      sx={{ minWidth: 140 }}
    >
      <option value="">{allLabel}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </TextField>
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
  if (percent == null) return <Typography component="span" variant="body2" color="text.disabled">n/a</Typography>;
  const tone = percent >= 95 ? "critical" : percent >= 85 ? "warning" : "healthy";
  const bar = (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
      <Box component="span" sx={{
        display: "inline-block", width, height: 8, borderRadius: "4px",
        bgcolor: "background.subtle", overflow: "hidden",
      }}>
        <Box
          component="span"
          data-tone={tone}
          sx={{
            display: "block", height: "100%", width: `${Math.min(100, percent)}%`,
            bgcolor: (t) => t.palette.status[tone].main,
          }}
        />
      </Box>
      <Box component="span" sx={{
        fontSize: 12, color: "text.secondary", minWidth: 32, textAlign: "right",
      }}>
        {percent.toFixed(0)}%
      </Box>
    </Box>
  );
  return label ? <Tooltip title={label}>{bar}</Tooltip> : bar;
}

/** The status vocabularies the API reports for individual objects - a PVC's
 * "Bound", a CSV's "Succeeded", a route's "Admitted", a quota that is
 * "Exhausted" - mapped to what each one means. A word that is not here wears no
 * colour, which is the right answer for a state this build has not met.
 *
 * Keys are lower case; callers hand over whatever the API said. */
const CHIP_TONE: Record<string, string> = {
  ok: "healthy", collected: "healthy", healthy: "healthy", admitted: "healthy",
  bound: "healthy", succeeded: "healthy", updated: "healthy", valid: "healthy",
  active: "healthy", atlatestknown: "healthy", enabled: "healthy", passed: "healthy",

  warning: "warning", updating: "warning", expiring: "warning", pending: "warning",
  progressing: "warning", paused: "warning", unavailable: "warning", suspended: "warning",
  "upgrade-pending": "warning", inactive: "warning", installing: "warning", replacing: "warning",

  critical: "critical", degraded: "critical", expired: "critical", exhausted: "critical",
  failed: "critical", rejected: "critical", forbidden: "critical", error: "critical",
  lost: "critical",
};

export interface StatusChipProps {
  status?: string | null;
  /** The words to show, when they are more than the status itself - a phase
   * with the reason it is in it. */
  children?: ReactNode;
}

/** A square chip naming one object's state. The rounded `Pill` is the fleet's
 * own healthy / warning / critical verdict; this one carries whatever word the
 * resource reported. */
export function StatusChip({ status, children }: StatusChipProps) {
  const s = status || "unknown";
  const tone = CHIP_TONE[s.toLowerCase()];
  return <Tag tone={tone} data-status={s}>{children ?? s}</Tag>;
}

export interface TierProps {
  tier?: string | null;
}

export function Tier({ tier }: TierProps) {
  if (!tier) return <Typography component="span" color="text.disabled">—</Typography>;
  return (
    <Chip
      variant="outlined"
      data-tier={tier}
      label={tier}
      color={tier === "critical" ? "error" : "default"}
      sx={{ borderRadius: "5px", fontWeight: 400, fontSize: 11.5 }}
    />
  );
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

/** The monospace face the app uses wherever a value has to line up with the one
 * above it - an image digest, a SQL fragment, a version. */
export const MONO_FONT = '"SF Mono", ui-monospace, "Menlo", monospace';

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
      <Paper sx={{ p: 2 }}>
        <Typography variant="h4" color="text.secondary" sx={{ mb: 1.25 }}>
          This view failed to render
        </Typography>
        <Typography sx={{ fontFamily: MONO_FONT, fontSize: 12, mb: 1.25 }}>{message}</Typography>
        <Button
          variant="outlined"
          color="inherit"
          onClick={() => { this.setState({ error: null }); this.props.onReset && this.props.onReset(); }}
        >
          Try again
        </Button>
        {" "}
        <Link href="/" variant="button">Go to overview</Link>
      </Paper>
    );
  }
}
