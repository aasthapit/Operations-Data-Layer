import { defineConfig } from "vite";
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
        rewrite: (p) => p.replace(/^\/api\/patching/, "/api"),
      },
      "/api": { target, changeOrigin: true },
      "/healthz": { target, changeOrigin: true },
    },
  },

  // The suite runs in jsdom against the real modules: only the network is
  // replaced. `src/test/setup.js` installs the browser APIs jsdom does not
  // have and makes an unmocked fetch a loud failure rather than a hang.
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "src/test/setup.js",
    include: ["src/**/*.test.{js,jsx}"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // main.jsx is the mount point (no logic), and the two fixture modules are
      // themselves test data - counting them would flatter the number.
      exclude: ["src/main.jsx", "src/test/**", "src/**/fixture.js"],
      reporter: ["text", "html", "lcov"],
      // Statements and lines are the gate; functions and branches are reported
      // so a drop is visible without failing the build on a defensive branch.
      thresholds: { statements: 70, lines: 70 },
    },
  },
});
