# Security scanning

Everything the Operations Data Layer is scanned for, what fails a build, and how to argue with it.

One command runs all of it, on a laptop and in CI alike:

```
make scan            # scripts/scan.sh all
```

`scripts/scan.sh` is the policy.
The GitHub Actions workflow calls it; it does not reimplement it.
That is the point: a gate a developer cannot run before pushing is a gate that only ever fails other people's builds.

## "Like Checkmarx", assembled from open tools

Checkmarx One is one product covering five disciplines.
This repository has no commercial scanner behind it, so each discipline gets the best open tool for it and `scripts/scan.sh` puts the results back together.

| Checkmarx One capability | What runs here | Over what |
|---|---|---|
| SAST | semgrep (`p/ci`, `p/python`, `p/javascript`, `p/react`, `p/dockerfile`, `p/kubernetes`, `p/owasp-top-ten`) | the whole tree |
| SAST, Python-specific | bandit | `data-layer/app`, `data-layer/scripts`, `mcp-server/server.py`, `patching-service/app` |
| SCA (open source) | pip-audit | the three `requirements.txt` |
| SCA (open source) | `npm audit --omit=dev` | `dashboard/package-lock.json` |
| SCA (transitive, from the tree) | `trivy fs --scanners vuln` | the whole tree |
| Secrets | gitleaks, over the full git history | every commit, not just the checkout |
| Secrets | `trivy fs --scanners secret` | the working tree |
| IaC / KICS | `trivy fs --scanners misconfig` | `deploy/`, `docker-compose.yml`, the Dockerfiles |
| IaC, Dockerfile-specific | hadolint | all four Dockerfiles |
| Container image | `trivy image` | `odl-backend` and `odl-dashboard`, as built |

GitHub's own CodeQL runs alongside this (`.github/workflows/codeql.yml`) and is a second SAST opinion, not a replacement: it is deeper on data flow and narrower on languages and on configuration files.

### What Checkmarx One would still add

Worth saying plainly, so nobody reads the table above as "we have Checkmarx now".

- **Cross-file, cross-function taint analysis.** semgrep's free rules are largely single-file pattern matches. Checkmarx follows a value from an HTTP parameter, through a service layer and into a sink two modules away. Nothing here does that. CodeQL is the closest available substitute and only for the languages it supports.
- **Policy management.** One place to say "this severity blocks this branch for this team", with exceptions that expire and are attributable. Here that lives in `scripts/scan.sh`, `.trivyignore.yaml` and this document, which is honest but is a text file, not a control.
- **A central dashboard and history.** Trend over releases, one queue of findings across repositories, ownership and SLAs. GitHub code scanning gives some of this for the SARIF that is uploaded (see below), for one repository.
- **Triage that survives.** Marking a finding "not exploitable" once, with a reviewer, rather than adding a line to an ignore file.
- **IaC coverage breadth.** KICS carries far more rules than trivy's bundled checks, especially for cloud provider resources this repository does not have yet.

## Running it

```
make scan-tools                  # install the scanners (brew + pip into data-layer/.venv)
make scan                        # everything, fail on HIGH and above
make scan-images                 # trivy over the images from `make images`

scripts/scan.sh sast             # semgrep + bandit
scripts/scan.sh sca              # pip-audit + npm audit + trivy fs vuln
scripts/scan.sh secrets          # gitleaks + trivy fs secret
scripts/scan.sh iac              # trivy fs misconfig + hadolint
scripts/scan.sh semgrep          # one tool by name
SCAN_TOOLS_CHECK=1 scripts/scan.sh   # which scanners are installed, and how to get the rest
```

Environment:

| variable | default | what it does |
|---|---|---|
| `SCAN_OUT` | `reports` | where the reports land: `<tool>.txt` always, `<tool>.sarif` where the tool can produce one |
| `SCAN_FAIL_ON` | `high` | `high`, `critical`, or `none` to report without failing |
| `SCAN_SKIP` | empty | comma-separated tool names to skip deliberately |
| `SCAN_TIMEOUT_SECONDS` | `900` | wall-clock guard around a tool that will not return |
| `TRIVY_TIMEOUT` | `5m` | trivy's own scan budget (it does not cover trivy's database pull) |
| `IMAGE_PREFIX` / `IMAGE_TAG` | `localhost` / `latest` | which images `scripts/scan.sh images` reads |

Exit codes: `0` nothing at or above the policy, `1` findings at or above it, `2` a scanner is missing or could not run.
A missing scanner is never a silent pass - that is the whole reason for the third code.

### trivy needs a registry

trivy's vulnerability database and its misconfiguration checks bundle are OCI artifacts pulled at run time from `mirror.gcr.io` / `ghcr.io`.
On a machine that cannot reach either, trivy hangs on the pull with no output at all; `SCAN_TIMEOUT_SECONDS` then kills it and the scan exits 2 rather than pretending the tree is clean.
Point it at an internal mirror with `TRIVY_DB_REPOSITORY`, or skip it deliberately with `SCAN_SKIP=trivy-fs` - semgrep's `p/kubernetes` and `p/dockerfile` plus hadolint still cover IaC, and gitleaks still covers secrets.
On Docker Desktop the usual cause is not the network but the credential helper: trivy consults `~/.docker/config.json` for registry credentials, and a stuck `docker-credential-desktop` process blocks the pull forever.
Pointing trivy at a config with no credential store is enough: `mkdir -p /tmp/dockercfg && echo '{"auths":{}}' > /tmp/dockercfg/config.json && DOCKER_CONFIG=/tmp/dockercfg make scan`.
`TRIVY_CACHE_DIR` keeps the 1.3 GB database somewhere it survives between runs.

trivy writes CRITICAL and HIGH findings both as SARIF level `error` and MEDIUM as `warning`, and its `security-severity` score follows the CVSS vector rather than the severity it reports, so `scripts/scan.sh` gates trivy on the severity word trivy puts in each rule's tags (the same word `trivy --severity` uses), unlike semgrep and hadolint where the SARIF level is the severity.

## The gate

`SCAN_FAIL_ON=high` (the default) fails the build on:

| tool | fails on | reported, does not fail |
|---|---|---|
| semgrep | `ERROR` | `WARNING`, `INFO` |
| bandit | `HIGH` severity at `MEDIUM` or `HIGH` confidence | everything else |
| pip-audit | any vulnerability without a documented ignore | the documented ignores, counted separately |
| npm audit | `high` and `critical` | `moderate` and below |
| trivy (fs and image) | `HIGH`, `CRITICAL` | `MEDIUM` and below |
| gitleaks | any finding - there is no low-severity secret | nothing |
| hadolint | `error` | `warning`, `info`, `style` |

`SCAN_FAIL_ON=critical` tightens each of those by one notch: trivy and npm audit go to critical only, and bandit requires `HIGH` confidence.
`SCAN_FAIL_ON=none` reports everything and exits 0, which is for looking, not for merging.

Changing the gate for everybody means changing `SCAN_FAIL_ON` in the `Makefile` and in `.github/workflows/security.yml`, in one commit, with the reason in the message.
Changing it for one run is the environment variable.

## Suppressing a finding

Every suppression carries a reason, sits next to the thing it excuses, and is reviewed like code.
There are no blanket disables anywhere, and no `--disable-rule` flags in the workflow.

| tool | where a suppression lives | shape |
|---|---|---|
| semgrep | the line itself | `# nosemgrep: <full rule id> -- <why>` on the line above, or on the line |
| semgrep | `.semgrepignore` | **paths only**, never rules |
| bandit | the line itself | `# nosec B<nnn> -- <why>` |
| bandit | `data-layer/bandit.yaml` | excluded directories only; `skips` is empty on purpose |
| pip-audit | `PIP_AUDIT_IGNORE` in `scripts/scan.sh` | the id, the reason, and an expiry date |
| trivy | `.trivyignore.yaml` | the id, with the reason and an expiry date on the comment lines above it |
| gitleaks | `.gitleaks.toml` | a path or fingerprint allowlist with a `description` |
| hadolint | `.hadolint.yaml` | `ignored:`, with the reason in a comment |

Two rules that are not negotiable:

1. **A CVE suppression has an expiry date.**
   On that date the entry is deleted and the scan fails again, so somebody looks at it a second time.
   An ignore with no expiry is a decision nobody will ever revisit.
2. **Prefer the fix.**
   Bumping a pin is almost always cheaper than the argument about whether the vulnerability is reachable.

## Reading the SARIF in GitHub code scanning

Every tool that can emit SARIF writes `reports/<tool>.sarif`, and the workflow uploads the directory with `github/codeql-action/upload-sarif@v3`.
Findings then appear under **Security -> Code scanning** on the repository, one alert per finding, annotated on the pull request diff where the line is part of the change.

Two things to know:

- **Give each upload a `category`.** GitHub keys a SARIF upload by `(ref, category)` and replaces the previous result for the same key. Uploading semgrep and trivy without distinct categories makes each one erase the other's alerts. CodeQL sets its own, which is why it coexists.
- **Uploading requires `security-events: write`**, and on a fork's pull request that permission is not granted, so the upload step is skipped there. The scan itself still fails the build, which is what actually gates the merge.

An alert dismissed in the GitHub UI stays dismissed for that rule and location, but it is invisible to `make scan` on a laptop: a finding that should be silenced for everybody belongs in the config files above, not only in the dashboard.

## The current baseline

Everything below the gate, as of the last full run (`make scan`, `SCAN_FAIL_ON=high`).
None of it fails a build; all of it is a deliberate answer rather than a backlog nobody has read.

`trivy` is absent from the table because it could not be exercised on the machine this baseline was taken on - see "trivy needs a registry" above.
CI runs it, and its first run will add rows here.

| tool | count | what it is |
|---|---|---|
| semgrep | 25 | `yaml.github-actions.security.github-actions-mutable-action-tag` across `.github/workflows/`. Actions are pinned to a tag (`@v4`) rather than a commit SHA, which is a supply-chain decision for the whole repository rather than a finding to silence: pinning to SHAs means dependabot rewrites them, which is the trade worth making deliberately. |
| semgrep | 6 | `package_managers.dependabot.dependabot-missing-cooldown` in `.github/dependabot.yml`. No `cooldown:` on the ecosystems, so a compromised release is picked up the day it is published. |
| semgrep | 7 | `generic.nginx.security.request-host-used` in `dashboard/nginx/`. nginx forwards the client's `Host` to the API on purpose: FastAPI builds its slash-redirects from it, and pinning the header to the upstream name would send browsers to `api:8000`. Which hostnames reach nginx is the Route's job. |
| semgrep | 2 | `python.fastapi.security.wildcard-cors` in `data-layer/app/main.py` and `patching-service/app/main.py`. See "Known gaps" below. |
| semgrep | 1 | `yaml.kubernetes.security.skip-tls-verify-service` in `fleet/addons/metrics-server.yaml`. `--kubelet-insecure-tls` is what makes metrics-server work on kind; the file describes the local development fleet and is never deployed to a real cluster. |
| bandit | 4 | `B310` (`urlopen` scheme audit) in `data-layer/scripts/eval_ask.py`, `eval_generate.py` and `synth_load.py`. Developer scripts posting to a URL the developer typed. |
| bandit | 2 | `B608` (string-built SQL) in `data-layer/app/agent/prompt.py` and `data-layer/app/query/snapshot.py`. Both build DuckDB SQL from the manifest's own schema, not from request input; what a user's question produces is separately parsed and restricted by `app/query/guard.py`. |
| bandit | 2 | `B311` (`random` is not cryptographic) in `data-layer/scripts/synth_load.py`. A seeded generator for synthetic fleet data, deliberately reproducible. |
| bandit | 3 | `B404`/`B603`/`B607` (subprocess) in `data-layer/scripts/eval_ask.py`, which shells out to `ant auth status` with a fixed argument list. |
| bandit | 1 | `B108` (temp directory) in `data-layer/app/settings.py`. `/tmp` is not shared anywhere this runs: every container has a read-only root filesystem with its own emptyDir mounted there, which is also why `HOME` points at it. |
| bandit | 1 | `B105` (hardcoded password) in `data-layer/app/agent/state.py`, matching a literal `"-"`. |
| bandit | 1 | `B110` (`try/except/pass`) in `data-layer/app/api/cache.py`, where a cache write failure is deliberately not an error. |
| pip-audit | 7 (x2 services, x2 advisory databases = 28 rows) | starlette, via FastAPI. Documented ignores with an expiry - see "Known gaps". |
| hadolint | 0 | `DL3002` is ignored in `.hadolint.yaml` with its reason; nothing else fires. |
| trivy (tree) | 22 MEDIUM | `KSV-0013` (image tag `latest`, 10x) and `KSV-0125` (registry not on a trusted list, 8x) in the pod and OpenShift manifests: the images are built locally and retagged for whatever registry the site uses, so the manifest cannot name a digest or a registry; `KSV-0037` (default namespace, 2x) because the pod manifest is for `podman kube play`, which has no namespaces; `KSV-01010` (2x) the same. |
| trivy (tree) | 37 LOW | `KSV-0020`/`KSV-0021` (no `runAsUser` above 10000, 26x): deliberate, OpenShift assigns the UID and a fixed one would violate the restricted SCC; `DS-0026` (no `HEALTHCHECK`, 4x): probes belong to the orchestrator; `KSV-0110`, `KSV-0011`, `KSV-0018`: the development fleet's metrics-server manifest. |
| trivy (images) | 0 | both images are clean at every severity once built: the runtime stages apply the base image's own security updates (`apk upgrade` / `apt-get upgrade` / `microdnf upgrade`, whichever the base has) and the backend image ships without pip, which nothing uses after the build. |
| gitleaks | 0 | the two historical kind kubeconfigs are allowlisted in `.gitleaks.toml` with their reason. |
| npm audit | 0 | the dashboard's production tree is clean. |

Three semgrep findings are answered by a `# nosemgrep:` line rather than counted above, all of them `insecure-hash-algorithm-sha1`: `data-layer/app/api/cache.py`, `app/collector/runner.py` and `app/store/redis_store.py`.
All three pass `usedforsecurity=False` and use the digest as a name (a cache key, a file name, a Redis index key), never as an authentication or integrity check.
The scan prints the count so the suppressions stay visible rather than becoming invisible once they work.

Nothing is at the gate: `make ci` runs every scanner above and passes.
Two things the tree scan caught on first run and that are fixed rather than ignored: the pod manifests published the dashboard on a host port (now `make pod-up` passes `--publish`), and none of the pod specs stated a pod-level security context (now `runAsNonRoot` and a `RuntimeDefault` seccomp profile at the pod level, inherited by every container).
The collector's read access to Secrets in the development profile (`KSV-0041`) is suppressed for that one file with its reason; the production profile collects no Secrets and `deploy/rbac/odl-collector-readonly.fleet.yaml`, generated from it, asks for none.

## CodeQL

CodeQL runs beside the scanners above (`.github/workflows/codeql.yml`, Python and JavaScript, the `security-and-quality` suite) and reports into the same Security tab; it does not fail the build.
Its first pass found what the pattern tools cannot: an import cycle only working by import order (`app/llm/anthropic.py`, fixed), side effects inside `assert` (fixed), and a config checker that could have echoed a credential inside an exception message (`scripts/check_fleet_config.py` now redacts every password and token the fleet config resolved).
Alerts that are by design are dismissed in the Security tab with a written reason rather than silenced in code: `verify=False` behind the explicit `insecure_skip_tls_verify` opt-in, and label-prefix checks CodeQL reads as URL sanitisation.
The dismissal comments are the record; review them when a rule fires again.

## Known gaps

Three things this scan reports honestly rather than hides, each needing a decision that is bigger than a scanner setting.

**starlette, via FastAPI.**
`fastapi==0.115.6` pins `starlette<0.42`, and seven advisories are open against 0.41.3.
Three are fixed within starlette 0.x; the other four need starlette 1.3.1, which needs a FastAPI major upgrade.
Measured on this tree: `fastapi==0.141.1` pulls starlette 1.6.0 and breaks router mounting (`data-layer` `tests/test_main.py::test_every_plane_of_the_api_is_mounted` fails), so it is real work rather than a pin bump.
Exposure meanwhile is bounded - both APIs sit behind the dashboard's nginx, accept no multipart uploads, serve no `StaticFiles` on Windows, and run under an OpenShift Route that sets `Host` itself.
The ignores expire 2026-12-31.

**The CORS wildcard.**
`data-layer/app/main.py` and `patching-service/app/main.py` both allow every origin.
That is not an oversight: in development the dashboard is served by Vite on another port, and in production it is served by nginx from the same origin as the API, so the wildcard is only ever exercised by the development case.
The fix is to make it configurable rather than to remove it - `ODL_CORS_ORIGINS`, defaulting to `*` so today's development flow is unchanged, and set to the Route's hostname in production, documented next to the deployment.
Until that lands, note that neither API has any authentication of its own, so the wildcard grants a cross-origin page exactly what the network already grants it; the NetworkPolicy and the Route, not CORS, are what keep the API off the open internet.

**Private keys in git history.**
The initial commit carries `fleet/kubeconfigs/hub-east.kubeconfig` and `hub-west.kubeconfig`, each with a client certificate and key.
They are kind's own certificates for throwaway container-local clusters whose API servers are Docker network hostnames (`https://<cluster>-control-plane:6443`), reachable from nothing but the laptop that created them, and `make fleet-down` destroys the CA that signed them.
The directory has been gitignored since, so no new ones can arrive.
They are allowlisted in `.gitleaks.toml` by path, with that reasoning, rather than pretended away.
Removing them properly means rewriting history (`git filter-repo --path fleet/kubeconfigs --invert-paths`) and force-pushing, which breaks every existing clone: worth doing at a quiet moment, not worth blocking on.

## If this moves to a commercial scanner

Both likely destinations replace the CI wiring and leave `scripts/scan.sh` alone as the local equivalent, which is the point of keeping the policy in a script rather than in a workflow.
For **Checkmarx One**, add the `checkmarx/ast-github-action` step with the project and tenant as secrets, keep this script as the pre-push check, and delete only the tools Checkmarx actually replaces - it covers SAST, SCA, IaC, secrets and containers, so realistically all of them, though hadolint's Dockerfile advice is cheap enough to keep.
For **GitLab**, include the `Security/SAST.gitlab-ci.yml`, `Dependency-Scanning`, `Secret-Detection` and `Container-Scanning` templates, which are themselves semgrep, gemnasium, gitleaks and trivy underneath, so the findings will look familiar.
In both cases keep the suppression files: `.semgrepignore`, `.gitleaks.toml` and `.trivyignore.yaml` are read by the same underlying tools either way, and the reasons in them are the part that took the thinking.
## See also

[ci.md](ci.md) describes the workflows that run these scanners, the coverage gates that run beside them, and how to read a failed run.
