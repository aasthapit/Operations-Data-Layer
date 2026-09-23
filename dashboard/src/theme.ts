// The one place the dashboard's colours, type scale and control density are
// decided. ADR-0005, phase 3: everything that used to be a CSS custom property
// in styles.css lives here instead, so a component can ask the theme for a
// colour (`useTheme()`, `sx`) rather than knowing a hex value or a class name.
//
// ----- where the old tokens went ------------------------------------------
// The 31 custom properties styles.css declared on `:root`, and their successor:
//
//   --bg            -> palette.background.default
//   --bg-elev       -> palette.background.paper        (cards, the app bar)
//   --bg-elev-2     -> palette.background.subtle       (inputs, hover rows)
//   --border        -> palette.divider
//   --border-soft   -> palette.border.soft             (row rules inside a card)
//   --text          -> palette.text.primary
//   --text-dim      -> palette.text.secondary
//   --text-faint    -> palette.text.disabled
//   --accent        -> palette.primary.main
//   --accent-dim    -> palette.primary.dark            (the filled/active state)
//   --healthy       -> palette.status.healthy.main     (and .success.main)
//   --healthy-bg    -> palette.status.healthy.surface
//   --warning       -> palette.status.warning.main     (and .warning.main)
//   --warning-bg    -> palette.status.warning.surface
//   --critical      -> palette.status.critical.main    (and .error.main)
//   --critical-bg   -> palette.status.critical.surface
//   --unknown       -> palette.status.unknown.main
//   --unknown-bg    -> palette.status.unknown.surface
//   --series-1..8   -> palette.chart.series[0..7]
//   --chart-line    -> palette.chart.line
//   --chart-grid    -> palette.chart.grid
//   --radius        -> shape.borderRadius
//   --shadow        -> the MuiPaper override below
//   --topbar-h      -> TOPBAR_HEIGHT
//
// The four status surfaces used to be written out as `rgba(r, g, b, 0.14)`
// literals that had to be kept in step with the solid colour by hand; they are
// now derived from it with `alpha`, which is the same value and cannot drift.
import { alpha, createTheme } from "@mui/material/styles";
import type { Theme } from "@mui/material/styles";
// why: a side-effect-only import. It widens `components` with MuiDataGrid, so
// the grid's defaults below are type-checked like any other component's.
import type {} from "@mui/x-data-grid/themeAugmentation";

/** How tall the app bar is. Sticky things below it (the query rail, the
 * generate transcript, a table's sticky header) offset by this. */
export const TOPBAR_HEIGHT = 58;

/** The monospace stack every reading-that-has-to-line-up column reaches for:
 * a cluster id, a digest, a query cell. `styles.css` said this once as `.mono`
 * and every table column asked a `Column.className` for it; phase 6 folds
 * that into the theme, in one place, so `ResultTable`'s own inline runs and
 * the grid's cell classes draw the same face. */
export const MONO_FONT = '"SF Mono", ui-monospace, "Menlo", monospace';

/** The health vocabulary the API speaks, plus the "unknown" the UI falls back
 * to when something has never reported. */
export type StatusTone = "healthy" | "warning" | "critical" | "unknown";

export interface StatusColor {
  /** Text, icons, the filled part of a bar. */
  main: string;
  /** The tinted background a pill or a matrix cell sits on. */
  surface: string;
}

export type StatusPalette = Record<StatusTone, StatusColor>;

export interface ChartPalette {
  /** Eight categorical slots for identity ("which hub is this line?"), in the
   * order they were validated against the card surface: every adjacent pair
   * clears the colour-blind separation floor, the chroma floor and 3:1 contrast
   * on that surface. The order is the safety mechanism, so slots are taken in
   * order and never reshuffled or generated past eight. These are not the
   * status colours: healthy / warning / critical mean good and bad, and a
   * series that happens to sit in slot 6 means neither. */
  series: readonly string[];
  /** One series is not an identity problem, so it gets the accent. */
  line: string;
  /** One step off the card surface: present, never louder than the data. */
  grid: string;
}

declare module "@mui/material/styles" {
  interface Palette {
    status: StatusPalette;
    chart: ChartPalette;
    border: { soft: string };
  }
  interface PaletteOptions {
    status: StatusPalette;
    chart: ChartPalette;
    border: { soft: string };
  }
  interface TypeBackground {
    /** One step up from `paper`: the surface an input, a hovered row or a
     * footer sits on. `--bg-elev-2` in the old stylesheet. */
    subtle: string;
  }
}

/** A tone the app named but MUI's palette has no slot for, resolved to a
 * colour. Callers pass whatever the API gave them, hence the loose argument. */
export function statusColor(theme: Theme, status?: string | null): StatusColor {
  const tone = status as StatusTone;
  return theme.palette.status[tone] ?? theme.palette.status.unknown;
}

// ----- the two palettes ----------------------------------------------------
// Dark is the original: these are the values styles.css shipped, unchanged, so
// phase 3 is a move rather than a redesign. Light is new - the same roles at
// the other end, with the accent and the status colours darkened until each one
// clears 4.5:1 on the white card surface.

const DARK = {
  bg: "#0f1419",
  paper: "#161b22",
  subtle: "#1c232c",
  divider: "#2a313c",
  borderSoft: "#222831",
  text: "#e6edf3",
  textDim: "#9aa7b4",
  textFaint: "#6b7785",
  accent: "#4f9cf9",
  accentDim: "#1f6feb",
  healthy: "#3fb950",
  warning: "#d29922",
  critical: "#f85149",
  unknown: "#6b7785",
  series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  chartGrid: "#242c37",
} as const;

const LIGHT = {
  bg: "#f4f6f9",
  paper: "#ffffff",
  subtle: "#eef1f5",
  divider: "#d3dae2",
  borderSoft: "#e4e9ef",
  text: "#151b23",
  textDim: "#4e5a67",
  textFaint: "#6b7785",
  accent: "#0b64d0",
  accentDim: "#0a4fa6",
  healthy: "#177d37",
  warning: "#8a6100",
  critical: "#c62828",
  unknown: "#5c6773",
  series: ["#1f6fd0", "#b2431c", "#10795a", "#8f6200", "#b33d69", "#046b04", "#5d52c4", "#c04848"],
  chartGrid: "#e2e7ee",
} as const;

/** How strong a status tint is behind a pill or a matrix cell. The dark theme's
 * 0.14 came from styles.css; on white the same fraction of a dark ink reads as
 * dirt, so light tints a touch lighter. */
const SURFACE_ALPHA = { dark: 0.14, light: 0.1 } as const;

function statusPalette(c: typeof DARK | typeof LIGHT, mode: "light" | "dark"): StatusPalette {
  const a = SURFACE_ALPHA[mode];
  const tone = (main: string): StatusColor => ({ main, surface: alpha(main, a) });
  return {
    healthy: tone(c.healthy),
    warning: tone(c.warning),
    critical: tone(c.critical),
    unknown: tone(c.unknown),
  };
}

/**
 * The application theme for one colour mode.
 *
 * Built fresh per mode rather than through MUI's CSS-variable colour schemes:
 * the app renders one mode at a time, the tests assert on resolved colours, and
 * a plain `Theme` is what `useTheme()` in a chart or a data grid can read
 * numbers out of without going through `var(--mui-...)` indirection.
 */
export function createAppTheme(mode: "light" | "dark"): Theme {
  const c = mode === "dark" ? DARK : LIGHT;
  const status = statusPalette(c, mode);

  return createTheme({
    palette: {
      mode,
      primary: { main: c.accent, dark: c.accentDim, contrastText: "#ffffff" },
      // The three MUI slots that already mean what a status means, pointed at
      // the same colours, so `color="error"` on an Alert and a critical pill
      // are the same red.
      success: { main: status.healthy.main },
      warning: { main: status.warning.main },
      error: { main: status.critical.main },
      background: { default: c.bg, paper: c.paper, subtle: c.subtle },
      divider: c.divider,
      border: { soft: c.borderSoft },
      text: { primary: c.text, secondary: c.textDim, disabled: c.textFaint },
      status,
      chart: { series: c.series, line: c.accent, grid: c.chartGrid },
    },

    // 10px, the old --radius. MUI multiplies this for some components, so the
    // few places that want the flat value use `theme.shape.borderRadius`.
    shape: { borderRadius: 10 },

    // ----- the type scale ---------------------------------------------------
    // The app's body text is 14px, not MUI's 16, and its headings are small and
    // dense: a card title is a 13px uppercase label, not a 24px h5. The named
    // variants below are the sizes the stylesheet already used, so the markup
    // can say `variant="cardTitle"`-ish things through the standard slots
    // instead of carrying font rules in `sx`.
    typography: {
      fontFamily: [
        "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto",
        "Helvetica", "Arial", "sans-serif",
      ].join(","),
      fontSize: 14,
      // MUI scales rem-based sizes against this; the app's rem base is the
      // browser's 16px, so saying so keeps px and rem in agreement.
      htmlFontSize: 16,
      h1: { fontSize: 20, fontWeight: 600, lineHeight: 1.4 },
      // .section-title
      h2: { fontSize: 18, fontWeight: 600, lineHeight: 1.4 },
      // .group-card .gc-name, .db-card-title
      h3: { fontSize: 15, fontWeight: 600, lineHeight: 1.4 },
      // .card h3 - the small uppercase label at the top of a panel
      h4: {
        fontSize: 13, fontWeight: 600, lineHeight: 1.4,
        textTransform: "uppercase", letterSpacing: "0.04em",
      },
      h5: { fontSize: 13, fontWeight: 600, lineHeight: 1.4 },
      h6: { fontSize: 13, fontWeight: 600, lineHeight: 1.4 },
      // .stat .value
      subtitle1: { fontSize: 30, fontWeight: 700, lineHeight: 1.2 },
      // a field label: .db-field-label, .q-title, .db-var-label
      subtitle2: {
        fontSize: 11.5, fontWeight: 600, lineHeight: 1.4,
        textTransform: "uppercase", letterSpacing: "0.05em",
      },
      body1: { fontSize: 13, lineHeight: 1.5 },
      body2: { fontSize: 12.5, lineHeight: 1.5 },
      caption: { fontSize: 11.5, lineHeight: 1.45 },
      button: { fontSize: 13, fontWeight: 500, textTransform: "none" },
      overline: {
        fontSize: 10.5, fontWeight: 600, lineHeight: 1.4,
        textTransform: "uppercase", letterSpacing: "0.05em",
      },
    },

    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { WebkitFontSmoothing: "antialiased" },
          // The app renders its own scrollable panes; telling the UA the mode
          // is what makes their scrollbars and form controls match.
          ":root": { colorScheme: mode },
        },
      },

      // Flat by default: this UI separates surfaces with a hairline border, and
      // an elevation shadow on top of that reads as two borders.
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundImage: "none",
            border: `1px solid ${theme.palette.border.soft}`,
            boxShadow: mode === "dark"
              ? "0 1px 3px rgba(0, 0, 0, 0.4)"
              : "0 1px 2px rgba(15, 20, 25, 0.06)",
          }),
        },
      },
      // Menus, dialogs and drawers are Papers that genuinely float, so they get
      // the stronger border and keep MUI's own shadow.
      MuiPopover: {
        styleOverrides: {
          paper: ({ theme }) => ({
            border: `1px solid ${theme.palette.divider}`,
            backgroundColor: theme.palette.background.subtle,
          }),
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: ({ theme }) => ({ border: `1px solid ${theme.palette.divider}` }),
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: ({ theme }) => ({
            border: 0,
            borderLeft: `1px solid ${theme.palette.divider}`,
            backgroundImage: "none",
          }),
        },
      },
      MuiCard: { defaultProps: { elevation: 0 } },
      MuiCardContent: {
        styleOverrides: {
          // 18px all round was the old .card padding, and MUI's extra bottom
          // padding on the last child would make a card look bottom-heavy.
          root: { padding: 18, "&:last-child": { paddingBottom: 18 } },
        },
      },

      MuiAppBar: {
        defaultProps: { elevation: 0, color: "default" },
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundColor: theme.palette.background.paper,
            backgroundImage: "none",
            borderWidth: 0,
            borderBottom: `1px solid ${theme.palette.divider}`,
            boxShadow: "none",
          }),
        },
      },

      MuiButton: {
        defaultProps: { disableElevation: true, size: "small" },
        styleOverrides: { root: { borderRadius: 7 } },
      },
      MuiIconButton: { defaultProps: { size: "small" } },
      MuiToggleButton: {
        styleOverrides: {
          root: ({ theme }) => ({
            textTransform: "none",
            fontSize: 13,
            fontWeight: 500,
            padding: theme.spacing(0.75, 1.5),
            border: 0,
            borderRadius: 6,
            color: theme.palette.text.secondary,
            "&.Mui-selected": {
              backgroundColor: theme.palette.primary.dark,
              color: theme.palette.primary.contrastText,
              "&:hover": { backgroundColor: theme.palette.primary.dark },
            },
          }),
        },
      },
      MuiToggleButtonGroup: {
        defaultProps: { exclusive: true, size: "small" },
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundColor: theme.palette.background.subtle,
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: 8,
            padding: 2,
            gap: 2,
          }),
          grouped: { border: 0, "&:not(:first-of-type)": { borderRadius: 6 }, "&:first-of-type": { borderRadius: 6 } },
        },
      },

      // Dense forms everywhere: the app's controls are 13px on a 30-ish pixel
      // row, which is `size="small"` plus a smaller label.
      MuiTextField: { defaultProps: { size: "small", variant: "outlined" } },
      MuiSelect: { defaultProps: { size: "small" } },
      MuiAutocomplete: { defaultProps: { size: "small" } },
      MuiFormControl: { defaultProps: { size: "small" } },
      MuiInputBase: {
        styleOverrides: {
          root: { fontSize: 13 },
          input: { "&::placeholder": { opacity: 0.7 } },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundColor: theme.palette.background.subtle,
            borderRadius: 7,
          }),
          notchedOutline: ({ theme }) => ({ borderColor: theme.palette.divider }),
        },
      },
      MuiInputLabel: { styleOverrides: { root: { fontSize: 13 } } },
      MuiFormLabel: { styleOverrides: { root: { fontSize: 13 } } },
      MuiFormControlLabel: {
        styleOverrides: { label: { fontSize: 13 } },
      },
      MuiCheckbox: { defaultProps: { size: "small" } },
      MuiRadio: { defaultProps: { size: "small" } },
      MuiMenuItem: { styleOverrides: { root: { fontSize: 13 } } },

      MuiTabs: {
        styleOverrides: { root: { minHeight: 40 }, list: { gap: 2 } },
      },
      MuiTab: {
        styleOverrides: {
          root: ({ theme }) => ({
            minHeight: 40,
            padding: theme.spacing(1, 1.75),
            fontSize: 13.5,
            fontWeight: 500,
            textTransform: "none",
            color: theme.palette.text.secondary,
          }),
        },
      },

      // The old table rules: 12px uppercase headers, a 13px body, and a hairline
      // under every row.
      MuiTableCell: {
        styleOverrides: {
          root: ({ theme }) => ({
            fontSize: 13,
            padding: theme.spacing(1.25, 1.5),
            borderBottom: `1px solid ${theme.palette.border.soft}`,
          }),
          head: ({ theme }) => ({
            fontSize: 12,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            color: theme.palette.text.secondary,
            padding: theme.spacing(1.125, 1.5),
            borderBottom: `1px solid ${theme.palette.divider}`,
          }),
          sizeSmall: ({ theme }) => ({ padding: theme.spacing(0.75, 1.25) }),
        },
      },
      MuiTableRow: {
        styleOverrides: {
          root: ({ theme }) => ({
            "&:hover > td": { backgroundColor: theme.palette.background.subtle },
          }),
        },
      },

      MuiChip: {
        defaultProps: { size: "small" },
        styleOverrides: {
          root: { fontSize: 11.5, fontWeight: 600, borderRadius: 20 },
          sizeSmall: { height: 21 },
          label: { paddingLeft: 8, paddingRight: 8 },
        },
      },
      MuiAlert: {
        defaultProps: { variant: "outlined" },
        styleOverrides: { root: { fontSize: 13, borderRadius: 8 } },
      },
      MuiTooltip: {
        defaultProps: { arrow: true },
        styleOverrides: { tooltip: { fontSize: 12 } },
      },
      MuiSkeleton: {
        // The app's placeholders are blocks the size of the content that will
        // land, and `wave` is the sweep the old .skeleton::after drew. MUI
        // already switches it off under prefers-reduced-motion.
        defaultProps: { animation: "wave" },
      },
      // ----- the data grid --------------------------------------------------
      // Every table in the app is a MUI X DataGrid (ADR-0005, phase 4). Its
      // chrome is decided here rather than per table, so a grid inside a
      // dashboard panel and one filling a page look the same, in both palettes.
      MuiDataGrid: {
        styleOverrides: {
          root: ({ theme }) => ({
            border: 0,
            fontSize: 13,
            color: theme.palette.text.primary,
            // The grid reads these for the parts it paints itself - the pinned
            // header container and the line under every row.
            "--DataGrid-rowBorderColor": theme.palette.border.soft,
            "--DataGrid-containerBackground": theme.palette.background.paper,

            "& .MuiDataGrid-columnHeader": {
              backgroundColor: theme.palette.background.paper,
              color: theme.palette.text.secondary,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.03em",
            },
            "& .MuiDataGrid-columnHeaders": {
              borderBottom: `1px solid ${theme.palette.divider}`,
            },
            "& .MuiDataGrid-columnSeparator": { display: "none" },

            "& .MuiDataGrid-cell": {
              borderTop: `1px solid ${theme.palette.border.soft}`,
              display: "flex",
              alignItems: "center",
            },
            "& .MuiDataGrid-row:hover": {
              backgroundColor: theme.palette.background.subtle,
            },
            "& .MuiDataGrid-footerContainer": {
              borderTop: `1px solid ${theme.palette.border.soft}`,
              color: theme.palette.text.disabled,
              fontSize: 12.5,
            },
            "& .MuiDataGrid-overlay": {
              backgroundColor: "transparent",
              color: theme.palette.text.disabled,
              fontSize: 13,
            },

            // ----- the column classes a view asks for -------------------------
            // A column's `className` reaches the cell and its `headerClassName`
            // the header, so these five - which were `td.wrap`, `td.nowrap`,
            // `.matrix th.rot`, `.mono` and `.muted` in styles.css, the first
            // three scoped to a `<table>` nothing renders any more and the last
            // two plain global rules over 50-odd `Column.className` values across
            // the views - live here instead. `.mono` and `.muted` are also what
            // `ResultTable`'s own `Cell` draws through the shared `Mono` and
            // `Muted` runs, so a query result and a fleet table read the same.
            "& .MuiDataGrid-cell.mono, & .MuiDataGrid-columnHeader.mono": {
              fontFamily: MONO_FONT,
              fontSize: 12.5,
            },
            "& .MuiDataGrid-cell.muted": {
              color: theme.palette.text.disabled,
            },
            // A cell that wraps still has the row's fixed height to live in, so
            // it is clamped to the two lines that fit rather than left to spill
            // half a third line over the row below it.
            "& .MuiDataGrid-cell.wrap": {
              whiteSpace: "normal",
              lineHeight: 1.35,
              "& > *, &": {
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              },
            },
            "& .MuiDataGrid-cell.nowrap, & .MuiDataGrid-columnHeader.nowrap": {
              whiteSpace: "nowrap",
            },
            // The availability matrix puts one column per cluster, so the names
            // are turned on their side and the counts under them are centred.
            "& .MuiDataGrid-columnHeader.rot .MuiDataGrid-columnHeaderTitleContainer": {
              writingMode: "vertical-rl",
              transform: "rotate(180deg)",
              textTransform: "none",
              letterSpacing: 0,
              whiteSpace: "nowrap",
            },
            "& .MuiDataGrid-cell.cell": { justifyContent: "center", fontSize: 11 },
          }),
        },
      },

      MuiLink: { defaultProps: { underline: "hover" } },
      MuiDivider: {
        styleOverrides: { root: ({ theme }) => ({ borderColor: theme.palette.border.soft }) },
      },
    },
  });
}

// ----- which mode ----------------------------------------------------------

export type ColorMode = "light" | "dark";
/** "system" is the default: no choice has been made, so the OS decides. */
export type ColorModePreference = ColorMode | "system";

export const COLOR_MODE_KEY = "odl.color-mode";
/** `<html data-theme="...">`. The attribute is the document's copy of the
 * resolved mode: index.html sets it before React mounts so the first paint is
 * not a flash of the wrong theme, and it is what that file's own inline
 * pre-mount style (styles.css is gone as of phase 6) keys off. */
export const COLOR_MODE_ATTRIBUTE = "data-theme";

const isMode = (v: unknown): v is ColorMode => v === "light" || v === "dark";

/** What the OS asks for. jsdom has no matchMedia unless a test installs one, so
 * an absent implementation means dark, the mode the app shipped with. */
export function systemColorMode(): ColorMode {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/**
 * The stored choice, or "system" when none was made.
 *
 * localStorage is the source of truth and is read first; the `data-theme`
 * attribute is only consulted when nothing is stored, which is the case where
 * something outside React (the no-flash script, a test) has already decided.
 * Storage can throw in a locked-down browser, so a failure is "no choice".
 */
export function readColorModePreference(): ColorModePreference {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(COLOR_MODE_KEY);
  } catch {
    stored = null;
  }
  if (isMode(stored)) return stored;
  if (stored === "system") return "system";
  const seeded = document.documentElement.getAttribute(COLOR_MODE_ATTRIBUTE);
  return isMode(seeded) ? seeded : "system";
}

export function writeColorModePreference(preference: ColorModePreference): void {
  try {
    window.localStorage.setItem(COLOR_MODE_KEY, preference);
  } catch {
    // A browser with storage disabled still gets the toggle, it just forgets.
  }
}

export function resolveColorMode(preference: ColorModePreference): ColorMode {
  return preference === "system" ? systemColorMode() : preference;
}

/** Publish the resolved mode to the document, for the no-flash script's benefit
 * on the next load and for the background/colour rules in index.html on this
 * one - they key off `data-theme` too, so setting it here repaints them live. */
export function applyColorMode(mode: ColorMode): void {
  document.documentElement.setAttribute(COLOR_MODE_ATTRIBUTE, mode);
}
