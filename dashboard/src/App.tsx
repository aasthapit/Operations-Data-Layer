import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, AppBar, Box, Button, CssBaseline, IconButton, Snackbar, Tab, Tabs, Toolbar,
  Tooltip, Typography,
} from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import RefreshIcon from "@mui/icons-material/Refresh";
import { api } from "./api";
import type { ApiError } from "./api";
import { invalidate } from "./cache";
import { useRoute } from "./router";
import type { Nav } from "./router";
import {
  TOPBAR_HEIGHT, applyColorMode, createAppTheme, readColorModePreference, resolveColorMode,
  writeColorModePreference,
} from "./theme";
import type { ColorMode } from "./theme";
import Overview from "./views/Overview";
import Dashboards from "./views/Dashboards";
import DashboardView from "./views/DashboardView";
import Generate from "./views/Generate";
import Clusters from "./views/Clusters";
import ClusterDetail from "./views/ClusterDetail";
import Applications from "./views/Applications";
import BlastRadius from "./views/BlastRadius";
import Versions from "./views/Versions";
import Metrics from "./views/Metrics";
import Insights from "./views/Insights";
import Query from "./views/Query";
import Manifest from "./views/Manifest";
import Patching from "./views/Patching";
import { ErrorBoundary } from "./components";

/** [root segment, label, where the tab goes] */
type Tab = [key: string, label: string, href: string];

const TABS: Tab[] = [
  ["", "Overview", "/"],
  ["dashboards", "Dashboards", "/dashboards"],
  ["generate", "Generate", "/generate"],
  ["clusters", "Clusters", "/clusters"],
  ["applications", "Applications", "/applications"],
  ["versions", "Versions", "/versions"],
  ["utilization", "Utilization", "/utilization"],
  ["insights", "Insights", "/insights/certificates"],
  ["query", "Query", "/query"],
  ["blast", "Blast radius", "/blast"],
  ["patching", "Patching", "/patching"],
  ["collected", "Collected", "/collected"],
];

const DEFAULT_INSIGHT = "certificates";
const enc = encodeURIComponent;

// The document title says where you are, so a tab in the browser's own history
// and a bookmark both name the page rather than the whole dashboard.
//
// The segments are typed as possibly absent because the root path has none:
// `/` is an empty array, which is what the `undefined` case answers.
function titleFor([root, second, third]: Array<string | undefined>): string {
  switch (root) {
    case undefined: return "Overview";
    case "dashboards": return second ? `Dashboards · ${second}` : "Dashboards";
    case "generate": return "Generate";
    case "clusters": return second ? `${second}${third ? ` · ${third}` : ""}` : "Clusters";
    case "applications": return second || "Applications";
    case "versions": return "Versions";
    case "utilization": return "Utilization";
    case "insights": return `Insights · ${second || DEFAULT_INSIGHT}`;
    case "query": return "Query";
    case "blast": return "Blast radius";
    case "patching": return second ? `Patching · ${second}` : "Patching";
    case "collected": return "Collected";
    default: return "Overview";
  }
}

/**
 * The colour mode, and the switch that changes it.
 *
 * The mode follows the OS until somebody says otherwise; from then on the
 * choice is theirs and it is remembered. The OS is still watched, so a machine
 * that turns dark at sunset takes the app with it as long as no choice is on
 * record.
 */
function useColorMode(): [ColorMode, () => void] {
  const [preference, setPreference] = useState(readColorModePreference);
  const [systemMode, setSystemMode] = useState<ColorMode>(() => resolveColorMode("system"));

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!query?.addEventListener) return undefined;
    const onChange = (e: MediaQueryListEvent) => setSystemMode(e.matches ? "light" : "dark");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const mode = preference === "system" ? systemMode : preference;
  useEffect(() => { applyColorMode(mode); }, [mode]);

  const toggle = useCallback(() => {
    setPreference((current) => {
      const next: ColorMode =
        (current === "system" ? resolveColorMode("system") : current) === "dark" ? "light" : "dark";
      writeColorModePreference(next);
      return next;
    });
  }, []);

  return [mode, toggle];
}

export default function App() {
  const route = useRoute();
  const { navigate, back, segments } = route;
  const [root, second, third] = segments;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState("");
  const [mode, toggleMode] = useColorMode();
  const theme = useMemo(() => createAppTheme(mode), [mode]);
  // An unknown path falls back to the overview, so the tab strip does too.
  const known = TABS.some(([key]) => key === (root || ""));
  const activeTab = known ? root || "" : "";

  useEffect(() => {
    document.title = `${titleFor(segments)} · Operations Data Layer`;
  }, [segments.join("/")]); // eslint-disable-line react-hooks/exhaustive-deps

  // The navigation object the views already speak, now writing to the URL.
  // Opening something is a push (the back button undoes it); narrowing a list
  // is a replace, which each view does through useQueryFilters.
  const nav = useMemo<Nav>(() => ({
    openCluster: (name, tab) => navigate(`/clusters/${enc(name)}${tab ? `/${tab}` : ""}`),
    openApp: (name) => navigate(name ? `/applications/${enc(name)}` : "/applications"),
    goClusters: (key, value) => {
      const keys = ["hub", "region", "datacenter", "environment", "version", "status", "team", "upgrading"];
      navigate("/clusters", key && keys.includes(key) ? { [key]: value } : {});
    },
    goBlast: (query) => navigate("/blast", query || {}),
    goInsights: (section) => navigate(`/insights/${section || DEFAULT_INSIGHT}`),
    goDashboard: (id, query) => navigate(id ? `/dashboards/${enc(id)}` : "/dashboards", query || {}),
    goPatchJob: (id) => navigate(`/patching/${enc(id)}`),
    back,
  }), [navigate, back]);

  // Ask for a sweep, then drop the cache so every mounted view re-reads in
  // place - no remount, so tables keep their sort and the page does not blink.
  //
  // Where the API and the collectors are separate pods the answer is "queued":
  // this process cannot sweep, so it handed the request to a collector, which
  // picks it up within a tick. That is worth saying, because the numbers then
  // move a moment after the button stops spinning - and it is worth saying
  // plainly when nobody is collecting at all, which is the 409.
  const refresh = async () => {
    setRefreshing(true);
    setRefreshNote("");
    try {
      const answer = await api.refresh();
      if (answer?.mode === "queued") setRefreshNote("Refresh requested");
      setTimeout(() => { invalidate(); setRefreshing(false); setRefreshNote(""); }, 4000);
    } catch (e) {
      // The status is the whole point of catching this one: 409 is "nothing is
      // collecting", which is a different sentence to "that did not work".
      const error = e as ApiError;
      setRefreshNote(error?.status === 409 ? "No collector is running" : "Refresh failed");
      setRefreshing(false);
    }
  };

  // "Refresh requested" is the happy path and clears itself; the other two are
  // failures, and a failure that says why should not be an error-coloured
  // banner only when the reader happens to be looking.
  const noteIsFailure = refreshNote !== "" && refreshNote !== "Refresh requested";

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <AppBar position="sticky">
          <Toolbar
            disableGutters
            sx={{
              minHeight: `${TOPBAR_HEIGHT}px`,
              px: 3,
              gap: 2,
              flexWrap: "wrap",
              rowGap: 1,
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, flex: "none" }}>
              <Box
                aria-hidden
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  bgcolor: "primary.main",
                  boxShadow: (t) => `0 0 10px ${t.palette.primary.main}`,
                }}
              />
              <Typography component="span" sx={{ fontSize: 15, fontWeight: 600 }}>
                Operations Data Layer
              </Typography>
              <Typography component="span" variant="caption" color="text.disabled">
                · OpenShift fleet
              </Typography>
            </Box>

            <Tabs
              value={activeTab}
              onChange={(_, key: string) => {
                const tab = TABS.find(([k]) => k === key);
                if (tab) navigate(tab[2]);
              }}
              variant="scrollable"
              scrollButtons="auto"
              aria-label="Sections"
              sx={{ flex: "1 1 auto", minWidth: 0 }}
            >
              {TABS.map(([key, label]) => <Tab key={label} value={key} label={label} />)}
            </Tabs>

            <Tooltip title={mode === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}>
              <IconButton
                onClick={toggleMode}
                aria-label={mode === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
                color="inherit"
              >
                {mode === "dark" ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}
              </IconButton>
            </Tooltip>

            <Button
              variant="outlined"
              color="inherit"
              startIcon={<RefreshIcon />}
              onClick={refresh}
              disabled={refreshing}
              sx={{ flex: "none" }}
            >
              {refreshing ? "Refreshing…" : "Refresh data"}
            </Button>
          </Toolbar>
        </AppBar>

        {/* Rendered only while there is something to say, so the message leaves
            the DOM the moment it stops being true rather than lingering through
            an exit transition. */}
        {refreshNote && (
          <Snackbar
            open
            anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
            onClose={(_, reason) => { if (reason !== "clickaway") setRefreshNote(""); }}
          >
            <Alert
              severity={noteIsFailure ? "error" : "info"}
              variant="filled"
              onClose={() => setRefreshNote("")}
            >
              {refreshNote}
            </Alert>
          </Snackbar>
        )}

        <Box component="main" sx={{ width: "100%", maxWidth: 1400, mx: "auto", p: 3 }}>
          <ErrorBoundary key={route.path}>
            {root === "dashboards" && second ? (
              <DashboardView id={second} route={route} nav={nav} />
            ) : root === "dashboards" ? (
              <Dashboards route={route} />
            ) : root === "generate" ? (
              <Generate route={route} nav={nav} />
            ) : root === "clusters" && second ? (
              <ClusterDetail name={second} tab={third} nav={nav} />
            ) : root === "clusters" ? (
              <Clusters route={route} onOpen={nav.openCluster} />
            ) : root === "applications" ? (
              <Applications app={second} route={route} nav={nav} />
            ) : root === "versions" ? (
              <Versions onOpen={nav.openCluster} onBlast={(v) => nav.goBlast({ ocp_version: v })} />
            ) : root === "utilization" ? (
              <Metrics route={route} onOpen={nav.openCluster} />
            ) : root === "insights" ? (
              <Insights section={second || DEFAULT_INSIGHT} route={route} nav={nav} />
            ) : root === "query" ? (
              <Query route={route} nav={nav} />
            ) : root === "patching" ? (
              <Patching id={second} nav={nav} />
            ) : root === "collected" ? (
              <Manifest onOpen={nav.openCluster} />
            ) : root === "blast" ? (
              <BlastRadius route={route} nav={nav} />
            ) : (
              <Overview route={route} nav={nav} />
            )}
          </ErrorBoundary>
        </Box>
      </Box>
    </ThemeProvider>
  );
}
