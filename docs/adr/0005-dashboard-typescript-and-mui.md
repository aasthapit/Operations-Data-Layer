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

### Phase 2 - components, views, and `strict: true`

Three workers, in order: 2a took the shared components, 2b the shell and the views, 2c turned strict on and cleared what it found.
2a and 2b landed together as one commit because neither is separately runnable: a view is not converted until the components it draws with are.

**Files converted (50 moved with `git mv`, plus `main.jsx` -> `main.tsx`, which git records as a rewrite rather than a rename).**

| Group | Files |
|---|---|
| 2a - shared components | `Chart`, `ChartControls`, `DataTable`, `ResultTable`, `components`, and the five under `dashboards/` (`Panel`, `VariablesBar`, `AddToDashboard`, `editor`, `ui`) |
| 2b - shell and views | `App`, `main`, and all fourteen under `views/` |
| Their tests | the twenty-five `.test.jsx` beside them, as `.test.tsx` |
| 2c - moved | `src/api.ts` -> `src/api/index.ts` (and its test beside it) |

Nothing was renamed: every component, prop and export kept its name, so the diff is types and the guards the types asked for.

**`tsc --noEmit` errors under `strict: true`: 544 before, 0 after.**
The top five codes, and what each one turned out to be:

| Code | Count | What it was |
|---|---|---|
| `TS2345` (argument not assignable) | 221 | 197 of them one shape: `within(row)` where `row` came from `.closest()` or `.parentElement`, which answer `null` |
| `TS7005` (implicitly `any`) | 104 | `let calls;` / `let runtime;` in the tests - a module or a call log declared before it is assigned |
| `TS18047` (possibly `null`) | 61 | the real nullability, mostly `useState<T | null>` read by an updater |
| `TS7006` (parameter implicitly `any`) | 60 | test helpers and stubs: `(groupBy) => ...` answering an endpoint by argument |
| `TS18048` (possibly `undefined`) | 43 | optional API fields - `Workload.containers`, which only arrives with `detail=true` |

414 of the 544 were in the suite and 130 in the app.
The split is the useful number: the app was already written defensively, and what strict found there was where the defence was missing rather than where it was verbose.

**What the strict switch actually caught**, as opposed to made noisier:

- `PanelChart.series` was `string | undefined`; `Chart.normalizeChart` writes `null` when no column separates the series, which is what is stored and handed back.
  `undefined` would have meant "no such field", which is a different state and would have re-run the auto-detection.
- `QueryResult.rows` was `QueryValue[][]` - a scalar per cell.
  A DuckDB JSON, STRUCT, LIST or MAP column survives the JSON round trip as a nested value, which `ResultTable`'s `Cell` has always drawn as its JSON and `Chart` has always classified as the unchartable "other" kind, both with tests.
  The interface was the thing that was wrong; it is now `QueryRow[]` (`unknown[][]`), and `Chart.Row` and `ResultTable.TableResult` both read that one type instead of each declaring their own.
- `useFetch` declared `fn: () => Loadable<T>`, but half the views ask conditionally (`isNew ? null : definitionDescriptor(id)`) and the hook has always read a missing descriptor as "no key, no request".
  The signature now says `| null`.
- `ClusterDetail`'s namespace count added `application + platform` straight, and both are `null` for a cluster the collector could not reach.
- `Chart`'s stacked-band builder read `running.get(t)` as a number; the map is seeded with every stamp, so a miss and a zero are the same thing - now said with `?? 0` rather than assumed.

**Structural changes a reviewer should look at.**

- `src/api.ts` -> `src/api/index.ts`.
  `import { api } from "../api"` now resolves into the directory, so the file/directory ambiguity beside `api/types.ts` and `api/schema.ts` is gone.
  No import path changed.
- `dashboards/Panel.tsx`: `onEdit`, `onRemove` and `onMove` are optional.
  Each control is drawn only when `editing` is on *and* its handler is there, so a read-only caller leaves them out instead of passing three no-ops - which is what `READ_ONLY_PANEL` in `views/Generate.tsx` was, and it is deleted.
- `dashboards/model.ts`: `fieldErrors(error: unknown)`, because every caller is a `catch` clause and `useUnknownInCatchVariables` comes with strict.
  `forSave` returns a declared `SaveBody` rather than `Record<string, unknown>`.
- `test/harness.tsx`: `makeNav` is annotated `: Nav` against `router.ts`'s interface, and the local `Nav = ReturnType<typeof makeNav>` alias is gone.
  A harness that drifted from the interface the views are written against would otherwise hand them a stand-in the app would never build.
- `test/harness.tsx` gained `closestElement(from, selector)` and `parentOf(from)`: they throw with the selector and the element they started from.
  Those two replaced the 79 nullable DOM walks - 73 `.closest<HTMLElement>(...)` and 6 `.parentElement` - that the 197 `TS2345`s came from, rather than 197 non-null assertions.
- `DataTable`: `activeFilters` carries the resolved `Column` rather than the key, and the sort resolves its column once.
  A filter or sort naming a column the table no longer has is simply not one, said once instead of proven at every row.
- `agent/useAgentRun.test.ts`: the `asActivity` cast is replaced by `firstOfKind(transcript, kind)` and `activityAt(transcript, index)`, which narrow through the discriminant.
  A cast would have let a test read `.status` off a note and pass.

**One non-null assertion in the whole tree**, in `hooks.ts`: the cache's fetcher reads `reqRef.current!`, and the invariant is named in the comment - the key is the descriptor's own url, so a key exists only when the descriptor does, and the `if (!key)` above has already returned when it did not.
No `@ts-ignore` and no `@ts-expect-error` anywhere.
Every remaining `any` carries a `// why:`; they are all the same shape - a document off the wire, out of `localStorage` or out of an older build, read field by field by the function that owns it (`normalizeState`, `normalizeDefinition`, `applyOp`, `reduce`, `summarize`).

**Convention, so Phases 3 and 4 do not rediscover it**: every module-level column list is annotated `const COLUMNS: Column<Row>[] = [...]`.
Without the annotation `Column<Row = any>` swallows the row type and `filter`, `align` and `headerClassName` widen to `string`, which stops fitting the props; with it, the literal unions hold and a column that reads a field the row does not have is an error where it is written.
`Column<Row>[]` rather than `Array<Column<Row>>`, consistently.

**Tests changed, and why** (none deleted, none skipped):

- `views/*.test.tsx`, `DataTable.test.tsx` - the 73 `.closest()` and 6 `.parentElement` lookups now go through the harness helpers.
  Same elements, same assertions.
- `Chart.test.tsx` - `container.querySelector("svg")` goes through a local `svgOf` that throws when there is no chart; `resolveSpec(...)` results are read with `?.`, since the function answers `null` for a result that cannot be charted and that is what several of these tests assert.
- `dashboards/runtime.test.ts` - the two drafts handed to `draftRunDescriptor` are built with `normalizeDefinition`, which is what the editor holds; they were partial objects before.
  The fixture-definition assertion reads `toMatchObject` because `definitionDescriptor` answers `unknown` on purpose.
- `agent/client.test.ts` - `after.dashboard.panels[0].title` became `toMatchObject`, because `AgentState.dashboard` is an open record by design.
- `ChartControls.test.tsx` - `setup` normalises the partial chart choice before rendering, which is what the Query page does; the controls are never handed a partial.
- `api/index.test.ts` - the fetch stub's recorded `init` is a declared shape, and the JSON bodies are read through a `bodyOf(n)` that says which call carried none.
- Seven `container.querySelector(...)` lookups where the DOM shape *is* the assertion (a usage bar's fill, a `.kv` change record, two blast-radius cards, the modal scrim, the `.q-sql` pre, the dialog's warning line) narrow with `as HTMLElement` and a comment saying why there is no role or label to ask for.

**Bundle**: `dist/assets/*.js` 402.47 kB raw / **119.88 kB gzip** before 2c, 403.10 kB raw / **120.10 kB gzip** after (+0.22 kB gzip - the guards, `|| []` and `?? 0`, that strict asked for; types erase).
CSS unchanged at 30.86 kB / 6.65 kB gzip.

**Tests**: **898 in 35 files**, unchanged across the whole of Phase 2.

**Coverage** (the gate is statements and lines >= 70%):

| | After Phase 1 | After Phase 2 |
|---|---|---|
| Statements | 89.11% (3881/4355) | 88.94% (3918/4405) |
| Branches | 82.78% (3496/4223) | 81.95% (3569/4355) |
| Functions | 86.29% (1429/1656) | 86.47% (1438/1663) |
| Lines | 90.98% (3178/3493) | 90.91% (3234/3557) |

The denominators grew by the guards; branches fall 0.8 points because a `|| []` on a field the fixtures always send is a branch the suite cannot take.

**Suite time**: 6.7 s (`vitest run`, warm), 14.8 s with `--coverage`.
`tsc --noEmit` takes about 3.0 s under strict, up from 1.4 s with it off.
