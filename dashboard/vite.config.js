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
    proxy: {
      "/api": { target, changeOrigin: true },
      "/healthz": { target, changeOrigin: true },
      "/patching": {
        target: process.env.VITE_PATCHING_TARGET || "http://localhost:18010",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/patching/, "/api"),
      },
    },
  },
});
