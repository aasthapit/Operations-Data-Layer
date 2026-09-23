// The list of dashboards: what exists, what it answers, and the way in.
//
// Built-in dashboards ship with the data layer and cannot be edited, only
// cloned; saved ones belong to whoever made them. "New dashboard" asks for an
// id, because the id is the URL a dashboard will be shared under for the rest
// of its life.
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert, Box, Button, ButtonBase, Link, Paper, Stack, TextField, Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { api } from "../api";
import type { ApiError } from "../api";
import type { DashboardDefinition, DashboardListEntry } from "../api/types";
import { invalidate } from "../cache";
import { useFetch } from "../hooks";
import type { RouteApi } from "../router";
import {
  Card as Panel, Empty, MONO_FONT, Muted, SectionHead, Tag, SkeletonLines, fmtAge,
} from "../components";
import { Modal } from "../dashboards/ui";
import { listDescriptor } from "../dashboards/runtime";
import { forSave, isSlug, normalizeDefinition, slugify } from "../dashboards/model";

interface DashboardsProps {
  route: RouteApi;
}

/** A row as it arrives. Both the API and the fixture answer with the summary
 * row, and an older build answered with whole definitions - which is why the
 * panel count and the variable names are still read either way below. */
type ListRow = DashboardListEntry | DashboardDefinition;

/** A row as this page draws it. */
interface DashboardCard {
  id: string;
  title: string;
  description: string;
  builtin: boolean;
  panels: number;
  variables: string[];
  updated_at: string | null;
}

export default function Dashboards({ route }: DashboardsProps) {
  const fixture = route.query.fixture === "1";
  const { data, error, loading, reload } = useFetch(() => listDescriptor({ fixture }), [fixture]);
  // "new", or the card a clone was asked for.
  const [dialog, setDialog] = useState<"new" | { clone: DashboardCard } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const all = useMemo<DashboardCard[]>(() => ((data?.dashboards || []) as ListRow[]).map((d) => ({
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

  const open = (id: string) => route.navigate(`/dashboards/${encodeURIComponent(id)}`,
    fixture ? { fixture: "1" } : {});

  const create = (id: string) => {
    setDialog(null);
    route.navigate(`/dashboards/${encodeURIComponent(id)}`,
      fixture ? { fixture: "1", new: "1" } : { new: "1" });
  };

  // Cloning is a read of the original and a write under the new id, which is the
  // only way to get a built-in into a shape the editor is allowed to touch.
  const clone = async (source: DashboardCard, newId: string) => {
    setBusy(true);
    setProblem("");
    try {
      const def = normalizeDefinition(await api.dashboard(source.id), source.id);
      await api.saveDashboard(newId, forSave({ ...def, id: newId, title: `${def.title} (copy)` }));
      invalidate("/api/dashboards");
      setDialog(null);
      route.navigate(`/dashboards/${encodeURIComponent(newId)}`);
    } catch (e) {
      setProblem(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={2}>
      <SectionHead
        title={<>Dashboards{fixture && <Tag sx={{ ml: 1, textTransform: "uppercase" }}>fixture</Tag>}</>}
        description={"Several queries on one page, with the variables they share at the top. Every panel is"
          + " a guarded SELECT over the same snapshot, so a dashboard is a link."}
      >
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
          <Button variant="outlined" color="inherit" startIcon={<RefreshIcon />}
            disabled={loading} onClick={reload}>
            Refresh
          </Button>
          {/* The other way to make one: describe it and let the agent compose it
              from these same panels. It lands here once it is saved. */}
          <Button variant="outlined" color="inherit"
            onClick={() => route.navigate("/generate", fixture ? { fixture: "1" } : {})}>
            Generate from a question
          </Button>
          <Button variant="contained" onClick={() => setDialog("new")}>New dashboard</Button>
        </Stack>
      </SectionHead>

      {problem && <Alert severity="error">{problem}</Alert>}
      {error ? <Unavailable error={error} route={route} fixture={fixture} />
        : !data ? <SkeletonLines rows={6} />
          : all.length === 0 ? (
            <Panel>
              <Empty>No dashboards yet. &quot;New dashboard&quot; starts an empty one.</Empty>
            </Panel>
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

      {/* Anything that is not "new" is a clone, and carries the card to copy. */}
      {dialog && dialog !== "new" && (
        <NameDialog
          title={`Clone "${dialog.clone.title}"`}
          intro="A copy under a new id, with every panel and variable, which you can then edit."
          initial={`${dialog.clone.id}-copy`}
          busy={busy}
          onCancel={() => setDialog(null)}
          onSubmit={(newId) => clone(dialog.clone, newId)}
        />
      )}
    </Stack>
  );
}

function Group({ title, desc, children }: { title: string; desc: string; children?: ReactNode }) {
  return (
    <Box>
      <Box sx={{ mb: 1.25 }}>
        <Typography variant="h4" color="text.secondary">{title}</Typography>
        <Muted sx={{ display: "block", fontSize: 12.5 }}>{desc}</Muted>
      </Box>
      <Box sx={{
        display: "grid", gap: 2, gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
      }}>
        {children}
      </Box>
    </Box>
  );
}

interface CardProps {
  dashboard: DashboardCard;
  onOpen: () => void;
  /** Only a built-in offers a clone; a saved dashboard is edited in place. */
  onClone?: () => void;
}

function Card({ dashboard, onOpen, onClone }: CardProps) {
  const d = dashboard;
  return (
    <Paper data-dashboard={d.id} sx={{ display: "flex", flexDirection: "column", p: 0, overflow: "hidden" }}>
      <ButtonBase
        onClick={onOpen}
        sx={{
          display: "block", textAlign: "left", p: "16px 18px 12px", flex: 1,
          // the whole card is the button, so hovering it lights the name
          "&:hover [data-card-title]": { color: "primary.main" },
        }}
      >
        <Typography variant="h3" component="span" data-card-title=""
          sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Template text={d.title} />
          {d.builtin && <Tag sx={{ textTransform: "uppercase" }}>built in</Tag>}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
          {d.description ? <Template text={d.description} /> : "No description."}
        </Typography>
      </ButtonBase>
      <Box sx={{
        display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", fontSize: 12,
        p: "10px 18px", borderTop: 1, borderColor: "border.soft", bgcolor: "background.subtle",
      }}>
        <Muted>{d.panels} {d.panels === 1 ? "panel" : "panels"}</Muted>
        {d.variables.length > 0 && (
          <Box data-variables="" sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
            {d.variables.map((v) => (
              <Tag key={v} sx={{ fontFamily: MONO_FONT }}>{v}</Tag>
            ))}
          </Box>
        )}
        <Box sx={{ flex: 1 }} />
        {d.updated_at && <Muted>updated {fmtAge(d.updated_at)} ago</Muted>}
        {onClone && (
          <Button
            variant="outlined"
            color="inherit"
            onClick={onClone}
            sx={{ minWidth: 0, px: 0.875, py: 0.125, fontSize: 11, lineHeight: 1.5 }}
          >
            Clone
          </Button>
        )}
      </Box>
    </Paper>
  );
}

// A title on the list has no variables to put in it yet, so the slot is shown
// as the variable that will fill it rather than as a literal {{hub}} or a gap.
const SLOT = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function Template({ text }: { text: string }) {
  const parts = String(text || "").split(SLOT);
  return (
    <>
      {parts.map((part, i) => (i % 2
        ? <Muted key={i} data-slot="" sx={{ fontStyle: "italic" }}>{part}</Muted>
        : <span key={i}>{part}</span>))}
    </>
  );
}

interface NameDialogProps {
  title: string;
  intro: string;
  initial?: string;
  placeholder?: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (id: string) => void;
}

function NameDialog({ title, intro, initial = "", placeholder, busy, onCancel, onSubmit }: NameDialogProps) {
  const [value, setValue] = useState(initial);
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
            {busy ? "Working…" : "Create"}
          </Button>
        </>
      )}
    >
      <Typography variant="caption" color="text.disabled" sx={{ display: "block", mb: 1.75 }}>
        {intro}
      </Typography>
      <TextField
        fullWidth
        label="Name"
        value={value}
        autoFocus
        placeholder={placeholder}
        helperText={<>The URL will be /dashboards/{id || "…"}</>}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && ok) onSubmit(id); }}
        slotProps={{ inputLabel: { shrink: true } }}
      />
    </Modal>
  );
}

// The dashboard plane is the newest part of the API. A build without it answers
// 404 here, which is a fact about the server rather than a broken page - so the
// page says which, and offers the fixture that needs only the query plane.
interface UnavailableProps {
  error: ApiError;
  route: RouteApi;
  fixture: boolean;
}

function Unavailable({ error, route, fixture }: UnavailableProps) {
  const missing = error?.status === 404;
  return (
    <Panel title={missing
      ? "This data layer does not serve dashboards yet"
      : "Dashboards could not be loaded"}
    >
      <Typography variant="body1" color="text.secondary">
        {missing
          ? "GET /api/dashboards answered 404. The dashboard plane arrives with the next API build; everything else on this page works without it."
          : String(error?.message || error)}
      </Typography>
      {!fixture && (
        <Muted sx={{ display: "block", fontSize: 11.5, mt: 1.5 }}>
          <Link component="button" type="button"
            onClick={() => route.navigate("/dashboards", { fixture: "1" })}>
            Load the sample dashboards
          </Link>
          {" "}to see the page working against the query plane alone.
        </Muted>
      )}
    </Panel>
  );
}
