// One panel on the grid: a header that says what it is and how much it cost,
// and a body that is the answer.
//
// The body is whichever of three things the result supports, in order: the chart
// the panel asks for when the columns can carry it, the rows as a dense table
// when they cannot, and the reason there is nothing when the query did not run.
// A panel waiting on a variable is not an error - it is an instruction.
import { useMemo } from "react";
import type { CSSProperties } from "react";
import { Box, Button, Paper, Tooltip, Typography } from "@mui/material";
import Chart, { inferFields, resolveSpec } from "../Chart";
import ResultTable from "../ResultTable";
import type { ResultNav, TableResult } from "../ResultTable";
import { MONO_FONT, Muted, SkeletonTable } from "../components";
import { Menu } from "./ui";
import type { MenuItem } from "./ui";
import {
  interpolateText, panelChartHeight, substituteSql, unsetVariableIn, variableByName,
  variableLabel,
} from "./model";
import type { Definition, Panel as PanelDefinition, Params } from "./model";
import type { BatchEntry } from "../api/types";

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

// A table only carries a filter row when the panel is tall enough that the row
// does not eat the rows it filters.
const FILTER_MIN_H = 3;

export interface PanelProps {
  panel: PanelDefinition;
  /** The dashboard the panel belongs to, for its variables and its id. */
  definition: Definition;
  /** The panel's entry in the run: rows, or the refusal and the SQL it tried. */
  result?: BatchEntry | null;
  params: Params;
  /** A run is in flight and this panel has nothing yet. */
  loading?: boolean;
  nav?: ResultNav | null;
  editing?: boolean;
  /** The agent is rewriting this panel, so the rows on screen are the old
   * answer rather than this one. */
  busy?: boolean;
  onOpenQuery: () => void;
  /** The three editing affordances. They are optional because the panel is
   * drawn read-only in more places than it is drawn editable - the generative
   * dashboard preview, for one - and a caller that cannot edit should be able
   * to say so by leaving them out rather than by passing three no-ops. Each
   * control is drawn only when `editing` is on *and* its handler is there, so
   * there is never a button that does nothing. */
  onEdit?: () => void;
  onRemove?: () => void;
  /** -1 is up the grid, 1 is down it. */
  onMove?: (delta: number) => void;
  first?: boolean;
  last?: boolean;
}

export default function Panel({
  panel, definition, result, params, loading, nav, editing, busy,
  onOpenQuery, onEdit, onRemove, onMove, first, last,
}: PanelProps) {
  const title = interpolateText(panel.title, params);
  const fields = useMemo(
    () => (result && result.columns ? inferFields(result.columns, result.column_types, result.rows) : []),
    [result]);
  const spec = useMemo(
    () => (fields.length ? resolveSpec(fields, result?.rows, panel.chart) : null),
    [fields, result, panel.chart]);

  const error = result && result.error ? String(result.error) : null;
  const unset = error ? unsetVariableIn(error) : null;
  // The entry only when it carries an answer: a refusal has no row count, no
  // elapsed time and nothing to draw, and naming that once here is what keeps
  // the header from re-deciding it.
  const ran = result && !error ? result : null;

  const items: Array<MenuItem | false | undefined> = [
    { label: "Open in Query", onSelect: onOpenQuery },
    editing && onEdit && { label: "Edit", onSelect: onEdit },
    editing && onRemove && { label: "Remove", onSelect: onRemove, danger: true },
  ];

  const move = (delta: number, word: string, glyph: string, disabled: boolean) => (
    <Button
      variant="outlined"
      color="inherit"
      disabled={disabled}
      title={`Move ${word}`}
      aria-label={`Move ${title} ${word}`}
      onClick={() => onMove?.(delta)}
      sx={{ minWidth: 0, px: 0.75, py: 0.125, fontSize: 11, lineHeight: 1.4 }}
    >
      {glyph}
    </Button>
  );

  return (
    <Paper
      component="section"
      // `busy` is a panel the agent is in the middle of rewriting: the rows on
      // screen are the old answer, so the panel says so rather than pretending
      // they are the new one.
      data-body={spec ? "chart" : "table"}
      // the grid reads the panel's size off two custom properties, which is
      // not something React's CSSProperties knows how to spell
      style={{ "--w": panel.w, "--h": panel.h } as CSSProperties}
      aria-label={title}
      aria-busy={busy || undefined}
      sx={{
        gridColumn: "span var(--w, 6)",
        gridRow: "span var(--h, 2)",
        display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0,
        p: 0, overflow: "hidden",
        ...(busy ? { opacity: 0.5, transition: "opacity 120ms ease-out" } : {}),
      }}
    >
      <Box
        component="header"
        sx={{
          display: "flex", alignItems: "center", gap: 1,
          p: "9px 8px 9px 14px", borderBottom: 1, borderColor: "border.soft", flex: "none",
        }}
      >
        <Tooltip title={title}>
          <Typography
            variant="h5"
            component="h4"
            sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {title}
            {panel.description && (
              <Tooltip title={panel.description}>
                <Box
                  component="span"
                  aria-label={panel.description}
                  sx={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 14, height: 14, ml: 0.75, borderRadius: "50%",
                    border: 1, borderColor: "divider", color: "text.disabled",
                    fontSize: 9.5, fontWeight: 700, fontStyle: "italic", cursor: "help",
                  }}
                >
                  i
                </Box>
              </Tooltip>
            )}
          </Typography>
        </Tooltip>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flex: "none" }}>
          {ran?.row_count != null && (
            <Muted sx={{ fontSize: 11.5, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
              {ran.row_count.toLocaleString()} {ran.row_count === 1 ? "row" : "rows"}
              {ran.elapsed_ms != null ? ` · ${ran.elapsed_ms} ms` : ""}
              {ran.truncated ? " · truncated" : ""}
            </Muted>
          )}
          {editing && onMove && (
            <Box sx={{ display: "flex", gap: 0.25 }}>
              {move(-1, "up", "↑", !!first)}
              {move(1, "down", "↓", !!last)}
            </Box>
          )}
          <Menu items={items} title={`Menu for ${title}`} />
        </Box>
      </Box>

      <Box sx={{
        flex: 1, minHeight: 0, overflow: spec ? "hidden" : "auto",
        p: spec ? "10px 14px 6px" : "8px 4px 4px",
      }}>
        {unset ? (
          <PanelMessage>
            {/* an unset variable the dashboard does not declare is still named
                in the panel's own words, so the fallback is the bare name */}
            Choose {article(variableLabel(variableByName(definition, unset)
              || { name: unset, label: "" }))}{" "}
            {variableLabel(variableByName(definition, unset)
              || { name: unset, label: "" }).toLowerCase()} above.
          </PanelMessage>
        ) : error ? (
          <Box sx={{ p: "12px 14px", color: "error.main", fontSize: 12.5 }}>
            <div>{error}</div>
            {result?.sql && (
              <Box component="pre" sx={{
                mt: 1, maxHeight: 140, overflow: "auto", color: "text.secondary",
                fontFamily: MONO_FONT, fontSize: 12.5, whiteSpace: "pre-wrap", m: 0,
              }}>
                {substituteSql(result.sql, params)}
              </Box>
            )}
          </Box>
        ) : !result ? (
          loading ? <SkeletonTable columns={4} rows={Math.max(3, panel.h * 2)} dense />
            : <PanelMessage>Nothing ran for this panel.</PanelMessage>
        ) : spec ? (
          <Chart fields={fields} rows={result.rows} spec={spec}
            height={panelChartHeight(panel.h)} tableBelow={false} />
        ) : (
          <ResultTable
            id={`dash.${definition.id}.${panel.id}`}
            // the error and the no-result branches returned above, so what is
            // left is an entry that ran and therefore has columns and rows
            result={result as TableResult}
            nav={nav}
            dense
            pageSize={50}
            filter={panel.h >= FILTER_MIN_H}
            empty="No rows."
            searchPlaceholder="Search"
          />
        )}
      </Box>
    </Paper>
  );
}

/** A panel with nothing in it yet says why, in the middle of where the answer
 * will be. */
function PanelMessage({ children }: { children?: React.ReactNode }) {
  return (
    <Box sx={{
      display: "flex", alignItems: "center", justifyContent: "center", height: "100%",
      color: "text.secondary", fontSize: 13, p: 2, textAlign: "center",
    }}>
      {children}
    </Box>
  );
}
