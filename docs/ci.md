# Continuous integration: tests, coverage gates and security scanning

Every push and every pull request runs the same checks a developer can run locally with `make ci`.
Nothing in the pipeline needs Redis, a cluster, a kubeconfig, Ollama or an Anthropic key.
The suites stand in fakes for all of them, which is what lets the coverage gates be honest: the number is measured on code that ran, not on code that was skipped because something was missing.

## The workflows

| Workflow | File | Runs | What it gates |
|---|---|---|---|
| CI | `.github/workflows/ci.yml` | every push, every PR | lint, the four test suites with their coverage gates, the dashboard build, both container images built and scanned |
| Security | `.github/workflows/security.yml` | every push, every PR, Mondays, on demand | `scripts/scan.sh all`: SAST, SCA, secrets, IaC (see [security-scanning.md](security-scanning.md)) |
| CodeQL | `.github/workflows/codeql.yml` | pushes to `main` and `feat/**`, PRs to `main`, Mondays | GitHub's semantic analysis for Python and JavaScript |
| Dependabot | `.github/dependabot.yml` | weekly | dependency update PRs for pip, npm, Docker bases and the actions themselves |

Findings from the scanners and from CodeQL land in the repository's Security tab (code scanning) as SARIF; every raw report is also kept as a workflow artifact for 90 days.

## The coverage gates

| Component | Gate | Where it is set | Command |
|---|---|---|---|
| `data-layer` | `app` >= 70% lines | `data-layer/.coveragerc` | `make test-data-layer` |
| `mcp-server` | `server` >= 70% | `mcp-server/.coveragerc` | `make test-mcp` |
| `patching-service` | `app` >= 70% | `patching-service/.coveragerc` | `make test-patching` |
| `dashboard` | statements and lines >= 70% | the `test.coverage.thresholds` block of `dashboard/vite.config.js` | `make test-dashboard` |

Seventy is the floor, not the target: the data layer runs well above it, and a change that drops a component below the floor fails the build rather than lowering the bar.
To raise a gate, change the number in that component's config; to see what is uncovered, read the `term-missing` output the command prints or open `htmlcov/index.html` (Python) and `dashboard/coverage/index.html` (dashboard).

### What the suites fake, and how

- Redis: `fakeredis` behind the same `Store` contract the real store implements.
- Cluster API servers: recorded JSON per kind, served by monkeypatched sessions; the parsers, health checks and the collector's assembly run on real fixtures.
- The MCP server's HTTP client: `httpx.MockTransport` handing back canned API answers per path.
- The patching service's database: SQLAlchemy models on an in-memory database.
- Models: the `set_generator` and `set_model` seams (scripted answers) and a fake Ollama session; the Anthropic SDK is exercised against a fake client, never the network.
- The dashboard: `vitest` with `jsdom`, `@testing-library/react`, and `vi.mock` of the `api` module returning fixtures shaped like the real endpoints.

## Running it locally

```sh
make ci             # lint, every suite, every scanner
make test-all       # just the suites
make scan           # just the scanners (make scan-tools once, first)
```

The per-component targets (`test-data-layer`, `test-mcp`, `test-patching`, `test-dashboard`, `scan-sast`, `scan-sca`, `scan-secrets`, `scan-iac`, `scan-images`) run one piece.
`make ci` and the workflows run the identical commands, so a green laptop is a green runner; the only difference is that the runner installs the scanners itself at the versions pinned in `security.yml`.

## Reading a failed run

- A **coverage** failure prints `FAIL Required test coverage of 70% not reached` (Python) or `ERROR: Coverage for lines (68.2%) does not meet global threshold (70%)` (dashboard) after the test summary; the uncovered lines are listed above it.
- A **scanner** failure ends with the summary table `scripts/scan.sh` prints: one row per tool, findings at or above the gate, findings below it, and the report path. The same findings appear in the Security tab with the file and line.
- An **image scan** failure names the CVE, the package and the fixed version; fix by bumping the base image or the package, or add a dated entry to `.trivyignore.yaml` with the reason.

## Moving to another runner

Everything the workflows do is a `make` target or `scripts/scan.sh`, so a GitLab pipeline or a Jenkinsfile is a thin wrapper that installs Python 3.12, Node 22 and the pinned scanner binaries and calls the same targets.
The SARIF files under `reports/` are the portable interchange format: GitLab's security dashboard and Checkmarx One both ingest them.
