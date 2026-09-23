// `defineConfig` comes from vitest/config rather than from vite: it is vite's
// own, widened with the `test` block below, so the suite's options are typed
// instead of being an untyped bag on a vite config.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// In dev, proxy API calls to the data layer so the app runs same-origin.
// In the container build, nginx serves the static bundle and proxies /api.
//
// VITE_PROXY_TARGET overrides the API location (the local stack maps the API to
// a non-default host port when 8000 is taken). PORT is honored so the preview
// harness can assign a port.
const target = process.env.VITE_PROXY_TARGET || "http://localhost:8000";
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

export default defineConfig({
  plugins: [react()],
  build: {
    // The MUI chunk is 540 kB raw and 168 kB gzipped by design; the warning
    // exists to catch a chunk that grew by accident, so it stays but starts above it.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // MUI and the two MUI X packages are the bulk of the bundle and change
        // on their own schedule; in their own chunks they cache across
        // releases of the app, and Vite stops warning about one 1.5 MB file.
        manualChunks: {
          mui: ["@mui/material", "@emotion/react", "@emotion/styled"],
          "mui-grid": ["@mui/x-data-grid"],
          "mui-charts": ["@mui/x-charts"],
        },
      },
    },
  },
  server: {
    host: true,
    port,
    strictPort: !!process.env.PORT,
    // Order matters: the first matching prefix wins, so the patching service
    // has to be claimed before the data layer's /api. Everything the dashboard
    // fetches lives under /api, which leaves every other path to the router -
    // a deep link like /patching/<job id> is a page, not a proxied API call.
    proxy: {
      "/api/patching": {
        target: process.env.VITE_PATCHING_TARGET || "http://localhost:18010",
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api\/patching/, "/api"),
      },
      "/api": { target, changeOrigin: true },
      "/healthz": { target, changeOrigin: true },
    },
  },

  // The suite runs in jsdom against the real modules: only the network is
  // replaced. `src/test/setup.ts` installs the browser APIs jsdom does not
  // have and makes an unmocked fetch a loud failure rather than a hang.
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "src/test/setup.ts",
    // A shared CI runner is slower and noisier than a laptop: two tests that
    // pass in well under a second here were seen hitting the 5 s default under
    // CPU contention. The budget is generous so a slow machine cannot turn a
    // passing test red; a genuine hang still fails.
    testTimeout: 20000,
    include: ["src/**/*.test.{js,jsx,ts,tsx}"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // main.tsx is the mount point (no logic), and the fixture modules are
      // themselves test data - counting them would flatter the number.
      exclude: ["src/main.tsx", "src/test/**", "src/**/fixture.{js,ts}"],
      reporter: ["text", "html", "lcov"],
      // Statements and lines are the gate; functions and branches are reported
      // so a drop is visible without failing the build on a defensive branch.
      thresholds: { statements: 70, lines: 70 },
    },
  },
});
