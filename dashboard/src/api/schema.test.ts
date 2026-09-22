// `schema.ts` is generated; this is what stops it drifting.
//
// It regenerates the file into a temp path with exactly the command
// `npm run api:types` runs, and diffs. So a route, a query parameter or a
// request body that changed in the data layer (and was exported into
// `data-layer/openapi.json`) fails here, naming the command to run, instead of
// leaving the UI typed against an API that no longer exists.
//
// The data layer has the other half of the same guard:
// `data-layer/tests/test_openapi_export.py` asserts `openapi.json` still
// matches `app.openapi()`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// fileURLToPath takes the URL string directly: jsdom installs its own `URL`
// global, and an instance of that one is not what node:url accepts.
const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(HERE, "..", "..");
const COMMITTED = join(HERE, "schema.ts");
const DOCUMENT = join(DASHBOARD, "..", "data-layer", "openapi.json");
const GENERATOR = join(DASHBOARD, "node_modules", ".bin", "openapi-typescript");

const REGENERATE = "run `npm run api:types` in dashboard/ and commit the result";

describe("the generated API schema", () => {
  it("is what openapi-typescript produces from the committed document", () => {
    const dir = mkdtempSync(join(tmpdir(), "odl-schema-"));
    try {
      execFileSync(GENERATOR, [DOCUMENT, "-o", join(dir, "schema.ts")], {
        cwd: DASHBOARD,
        stdio: "pipe",
      });
      const fresh = readFileSync(join(dir, "schema.ts"), "utf8");
      const committed = readFileSync(COMMITTED, "utf8");
      expect(committed, `src/api/schema.ts is out of date: ${REGENERATE}`).toBe(fresh);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("carries the paths the fetch helpers are built on", () => {
    // A generated file of the wrong document would still be valid TypeScript,
    // so assert on the text: these path keys have to be in it.
    const committed = readFileSync(COMMITTED, "utf8");
    for (const path of [
      "/api/health/overview",
      "/api/clusters/{name}",
      "/api/blast-radius",
      "/api/insights/summary",
      "/api/query/sql",
      "/api/dashboards/{dashboard_id}/run",
      "/api/metrics/capacity",
      "/api/collector/timings",
    ]) {
      expect(committed, `${path} is missing from schema.ts: ${REGENERATE}`).toContain(`"${path}"`);
    }
  });
});
