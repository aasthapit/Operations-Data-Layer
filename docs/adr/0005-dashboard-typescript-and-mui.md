# ADR-0005: The dashboard moves to TypeScript, then to Material UI

- Status: in progress (September 2026), on branch `feat/dashboard-typescript-mui`
- Related: [ADR-0004](0004-generative-ui.md) (the Generate view this migration must carry), [docs/ci.md](../ci.md) (the coverage floor that gates every phase)

## Context

The dashboard is React 18 on Vite 6, written in plain JavaScript, with exactly two runtime dependencies.
Everything else is hand-rolled: a History API router, an SWR-style fetch cache, a `DataTable` used 57 times across 11 files, a 1,183-line SVG `Chart` with automatic axis and series inference, and a 790-line stylesheet with 31 tokens and 183 classes.
There are no types anywhere, and the API contract exists only as the fetch helpers and the test fixtures that imitate it.
Two integration bugs this month (a blank dashboard title the API rejected, a pod identity the collector discarded) were shape mismatches a type checker would have caught at the boundary.

The ask is React with TypeScript and Material UI.
Those are two migrations with different costs and different reasons, so this record separates them and orders them.

## Decision

1. **TypeScript first, MUI second.** Typed props make the component swap mechanical and reviewable; swapping components first would mean re-typing everything twice.
2. **Incremental, file by file, on one branch, with the existing 896 tests as the safety net.** `allowJs` lets `.js` and `.tsx` coexist, so no phase leaves the branch in a state that does not build, test and pass the 70% floor.
3. **The API contract has one source.** `openapi-typescript` generates paths, parameters and request bodies from the data layer's OpenAPI document (exported by `data-layer/scripts/export_openapi.py`, no server needed).
   The API declares no response models, so response shapes are written by hand in `dashboard/src/api/types.ts` and the test fixtures are typed with them: a fixture that drifts from the interface fails the type check.
   Adding `response_model` to the routes later makes the responses generated too and deletes the hand-written file; that is recorded as the follow-up.
4. **Strict TypeScript is the end state, not the first step.** Phase 1 converts with `strict: false` and `noImplicitAny: false`; Phase 2 turns strict on and clears what it finds.
   `tsc --noEmit` joins the CI gate as soon as Phase 1 lands.
5. **Material UI replaces the design system, not the architecture.** The router, the cache, the API layer, the query builder, the dashboards runtime and the agent stream client stay.
   The theme is built from the 31 existing tokens, which yields the light theme the app has never had.
   Material UI 9 is current; whether it supports React 18 decides whether React moves to 19 inside Phase 3 (peer dependencies are checked before anything is installed, and a React upgrade is made deliberately, not incidentally).
6. **The free tiers of MUI X.** `DataGrid` (community) does sorting, single filters, quick search and paging; the wrapper keeps today's per-column filter row by filtering rows before they reach the grid, so no paid tier is needed for what exists today.
   `Charts` (community) covers line and bar charts with tooltips and legends; the existing field inference and spec resolution stay and only the rendering changes.
   Pinning, grouping and multi-filter panels are Pro features and are not part of this migration.
7. **Every phase is a commit that passes the whole gate**: type check, the 896-plus tests at or above the 70% floor, the build, the security scan.
   No phase is landed partially.

## Phases

| Phase | Scope | Owner | Depends on |
|---|---|---|---|
| 1 | TypeScript tooling, generated API types, hand-written response types validated by fixtures, the pure modules converted (router, cache, hooks, api, query builder, dashboards model and runtime, agent client and hook), `npm run typecheck` in CI | one Opus worker | - |
| 2 | Components and views to `.tsx`; `strict: true`; `Chart`, `DataTable`, `ResultTable`, `ChartControls`, the dashboards and agent components typed | two workers in parallel (shared components; views), then strict | 1 |
| 3 | Material UI: theme from the tokens, application shell, navigation, forms, dialogs, drawers, feedback; `styles.css` retired; React 19 if MUI requires it | one Opus worker | 2 |
| 4 | `DataTable` on MUI X DataGrid behind the existing props; `ResultTable` follows | one Opus worker, in parallel with 3 | 2 |
| 5 | `Chart` on MUI X Charts, inference kept | one Sonnet worker, in parallel with 3 | 2 |
| 6 | Integration, documentation, this record's measured section, the rendered ADR page | the reviewer | 3, 4, 5 |

## Consequences

- The dashboard gains a type checker at the API boundary and generated request types; drift between the FastAPI routes and the UI becomes a build failure rather than a runtime surprise.
- The bundle grows by several hundred kilobytes gzipped once MUI is in; acceptable for an internal operations tool served same-origin.
- The 69 class-name assertions in the tests are the part of the suite that will not survive the component swap unchanged; role, label and text queries (1,069 of them) do.
- The hand-written response types are a maintenance obligation until the API declares response models.

## Measured

Filled in by phase as each lands: files converted, `tsc` errors cleared, bundle size before and after, test count and coverage at each gate, and the run time of the suite.

### Phase 1 - TypeScript tooling, API types, pure modules

TypeScript 5.9.3 (the last 5.x; 7.x is not taken yet because the installed `@types/react@18` and Vite 6's own typings are what this phase has to keep working against), `@types/react@18.3.31`, `@types/react-dom@18.3.7`, `@types/node@26`, `openapi-typescript@7.13.0`.

**Files converted (29 moved with `git mv`, so history follows them).**

| Group | Files |
|---|---|
| Config | `vite.config.js` -> `vite.config.ts` |
| Pure modules | `router`, `cache`, `hooks`, `api`, `query/builder`, `dashboards/model`, `dashboards/runtime`, `dashboards/fixture`, `agent/client`, `agent/useAgentRun`, `agent/fixture` |
| Their tests | the eight `.test.js` beside them, plus `router.test.jsx` and `hooks.test.jsx` as `.test.tsx` |
| Test support | `test/setup`, `test/apiMock`, `test/harness` (`.tsx`), and all five files under `test/fixtures/` |
| Added | `src/api/schema.ts` (generated), `src/api/types.ts` (hand-written), `src/api/schema.test.ts` (drift), `tsconfig.json`, `data-layer/scripts/export_openapi.py`, `data-layer/openapi.json`, `data-layer/tests/test_openapi_export.py` |

Components and views stayed `.jsx`, as Phase 2 owns them; `allowJs` resolves them and `checkJs: false` leaves them unchecked.

**`tsc --noEmit` errors: 0 before, 0 after.**
Both zeroes are honest but neither is interesting on its own: at the start the config was added to a tree with no `.ts` file in it, so there was nothing to check.
The number that mattered was per file, and every batch was cleared before the next file moved - 19 on typing the fleet fixture, 15 on the insights fixture, 25 on the agent client and its test, 20 on `api` and `hooks`, and ones and twos elsewhere.

**What the type check actually caught.**
Typing the fixtures with `src/api/types.ts` turned up eleven places where a fixture and its handler disagreed, which is the claim in the Context section paying for itself before a single component was touched:

- `VERSIONS.channels` was a list of channel names; `versions.py:_distribution` returns `{channel, count}` rows.
- `VERSIONS.versions[].clusters[]` carried `{name, status}`; the handler also sends `hub`, `region`, `environment` and `upgrading`.
- `BLAST_RADIUS` had no `query` echo and no `summary.by_region`; its clusters had no `datacenter` or `ocp_version`, and its applications had no `assigned` or `namespace` and only `{cluster}` per placement.
- `SUMMARY_BY_*.groups[]` had no `namespaces` count.
- `CLUSTER_RESOURCES` carried a top-level `kind`, which `clusters.py:get_resources` does not send (the kind is a query parameter).
- `REFERENCES` had the reverse problem: a top-level `kind` instead of one per row.
- `MANIFEST` was missing `keep_annotations`, `threshold_scope`, `health_checks` and `applications`.
- `MANIFEST_AVAILABILITY.totals` counted objects; the handler counts clusters per status, and the per-resource entries were missing `collected_at`, `cached` and `interval_seconds`.
- `APPLICATIONS`/`APPLICATION_DETAIL` were missing `total`, `offset`, `regions` and the whole `namespaces` section.
- `STORAGE` was missing `default` on a class, `class` on a PVC, and `pvs` entirely.
- `POD_ISSUES`, `ROUTES` and the application workload detail were each missing fields their serializer always sends.

All eleven were fixed in the fixtures rather than papered over in the interfaces, so the suite now runs against the shapes the API serves.

**Bundle**: `dist/assets/*.js` 401.90 kB raw / **119.69 kB gzip** before, 402.15 kB raw / **119.77 kB gzip** after (+0.08 kB gzip, entirely the `default` flag and the extra fixture-shaped branches; types erase).
CSS unchanged at 30.86 kB / 6.65 kB gzip.

**Tests**: 896 in 34 files before, **898 in 35 files** after - the two added are the schema drift test and its path spot-check.
The data layer gained four (`tests/test_openapi_export.py`) and stands at **758 passing**.

**Coverage** (the gate is statements and lines >= 70%):

| | Before | After |
|---|---|---|
| Statements | 89.12% (3868/4340) | 89.11% (3881/4355) |
| Branches | 82.81% (3499/4225) | 82.78% (3496/4223) |
| Functions | 86.38% (1427/1652) | 86.29% (1429/1656) |
| Lines | 90.91% (3151/3466) | 90.98% (3178/3493) |

**Suite time**: 9.22 s before, 9.07 s after (`vitest run`, warm).
`tsc --noEmit` adds about 1.4 s to the gate.
