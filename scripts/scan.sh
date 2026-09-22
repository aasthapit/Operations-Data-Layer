#!/usr/bin/env bash
#
# Security scanning for the Operations Data Layer - the whole policy, in one
# place, running identically on a laptop and in GitHub Actions.
#
# The repository has no commercial scanner behind it, so the coverage a
# Checkmarx One pipeline would give is assembled from open tools, one per
# discipline (docs/security-scanning.md has the mapping):
#
#   SAST       semgrep (multi-language rules) + bandit (Python)
#   SCA        pip-audit (three requirements.txt) + npm audit + trivy fs vuln
#   secrets    gitleaks (full history) + trivy fs secret
#   IaC        trivy fs misconfig (deploy/, compose, Dockerfiles) + hadolint
#   container  trivy image, over images already built locally
#
# Why one script rather than a workflow file: the gate has to be the same
# thing a developer can run before pushing. The workflow calls this; it does
# not reimplement it. Every suppression lives in a config file next to its
# reason (.semgrepignore + `# nosemgrep:` lines, data-layer/bandit.yaml,
# .trivyignore.yaml, .gitleaks.toml, .hadolint.yaml, PIP_AUDIT_IGNORE below), never
# in a flag passed from a workflow nobody reads.
#
# Usage:
#   scripts/scan.sh [all|sast|sca|secrets|iac|images|<tool>]
#
#   <tool> is one of: semgrep bandit pip-audit npm-audit trivy-fs hadolint
#                     gitleaks trivy-image
#
# Environment:
#   SCAN_OUT=reports        where reports land (<tool>.txt always, <tool>.sarif
#                           where the tool can produce one)
#   SCAN_FAIL_ON=high       high | critical | none. `none` reports everything
#                           and always exits 0.
#   SCAN_SKIP=              comma-separated tool names to skip
#   SCAN_TOOLS_CHECK=1      print which scanners are installed, with install
#                           hints for the missing ones, and exit
#   IMAGE_PREFIX=localhost  `images` mode: <prefix>/odl-backend:<tag> and
#   IMAGE_TAG=latest        <prefix>/odl-dashboard:<tag>
#
# Exit codes:
#   0  nothing at or above the policy
#   1  at least one finding at or above the policy
#   2  a scanner is missing or could not run - never a silent pass
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SCAN_OUT="${SCAN_OUT:-reports}"
SCAN_FAIL_ON="${SCAN_FAIL_ON:-high}"
SCAN_SKIP="${SCAN_SKIP:-}"
IMAGE_PREFIX="${IMAGE_PREFIX:-localhost}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
# trivy's vulnerability database and checks bundle are OCI artifacts pulled at
# run time. A machine that cannot reach the registry otherwise hangs on the
# pull with no output at all, so give it a deadline and let the error path say
# what happened.
TRIVY_TIMEOUT="${TRIVY_TIMEOUT:-5m}"
# The hard wall-clock guard around a tool that will not come back on its own.
# trivy's own --timeout covers the scan and NOT the registry pull, so a blocked
# registry hangs it with no output at all until somebody notices.
SCAN_TIMEOUT_SECONDS="${SCAN_TIMEOUT_SECONDS:-900}"

case "$SCAN_FAIL_ON" in
    high|critical|none) ;;
    *) echo "scan: SCAN_FAIL_ON must be high, critical or none (got '$SCAN_FAIL_ON')" >&2; exit 2 ;;
esac

MODE="${1:-all}"

# Requirements files pip-audit reads. Each component pins its own.
REQUIREMENTS=(
    data-layer/requirements.txt
    mcp-server/requirements.txt
    patching-service/requirements.txt
)

# Vulnerabilities pip-audit is told to pass over, each with the reason and the
# date the reason expires. An entry here is a decision with an owner, not a
# scanner setting: on its expiry date the scan fails again and somebody has to
# look. Nothing is ignored fleet-wide and nothing is ignored without an ID.
PIP_AUDIT_IGNORE=(
    # starlette, reached only as FastAPI's own dependency (fastapi==0.115.6
    # pins starlette<0.42). Clearing the last four needs starlette 1.3.1, which
    # needs a FastAPI major upgrade: measured on this tree, fastapi==0.141.1
    # installs starlette 1.6.0 and breaks router mounting
    # (tests/test_main.py::test_every_plane_of_the_api_is_mounted). That upgrade
    # is its own piece of work, not a security scan's to make silently.
    # Exposure here is bounded: both APIs sit behind the dashboard's nginx, take
    # no multipart uploads, serve no StaticFiles on Windows, and run under an
    # OpenShift Route that sets the Host header itself.
    # Expires 2026-12-31.
    GHSA-2c2j-9gv5-cj73        # CVE-2025-54121, multipart spooling, fix 0.47.2
    GHSA-7f5h-v6xp-fcq8        # CVE-2025-62727, Range header quadratic time, fix 0.49.1
    GHSA-86qp-5c8j-p5mr        # CVE-2026-48710, Host header in URL reconstruction, fix 1.0.1
    GHSA-wqp7-x3pw-xc5r        # CVE-2026-48818, StaticFiles on Windows, fix 1.1.0
    GHSA-x746-7m8f-x49c        # CVE-2026-48817, HTTPEndpoint method dispatch, fix 1.1.0
    GHSA-82w8-qh3p-5jfq        # CVE-2026-54283, form() bounds, fix 1.3.1
    GHSA-jp82-jpqv-5vv3        # CVE-2026-54282, request path in URL reconstruction, fix 1.3.0
)

# Everything trivy fs walks that is not ours to fix.
TRIVY_SKIP_DIRS=(
    node_modules
    .venv
    .git
    dashboard/dist
    dashboard/coverage
    htmlcov
    "$SCAN_OUT"
)

DOCKERFILES=(
    data-layer/Dockerfile
    dashboard/Dockerfile
    mcp-server/Dockerfile
    patching-service/Dockerfile
)

# --------------------------------------------------------------------------- #
# tool discovery
# --------------------------------------------------------------------------- #
# The Python scanners are installed into data-layer/.venv by `make scan-tools`,
# so look there before giving up: a developer who followed the Makefile should
# not also have to activate a virtualenv.
VENV_BIN="$ROOT/data-layer/.venv/bin"

tool_path() {
    local name="$1"
    if command -v "$name" >/dev/null 2>&1; then
        command -v "$name"
    elif [ -x "$VENV_BIN/$name" ]; then
        echo "$VENV_BIN/$name"
    else
        return 1
    fi
}

install_hint() {
    case "$1" in
        semgrep)   echo "brew install semgrep   (or: pip install semgrep)" ;;
        bandit)    echo "pip install "bandit[sarif]"     (make scan-tools puts it in data-layer/.venv)" ;;
        pip-audit) echo "pip install pip-audit  (make scan-tools puts it in data-layer/.venv)" ;;
        npm)       echo "install Node 22+ (https://nodejs.org); npm ships with it" ;;
        trivy)     echo "brew install trivy     (or: https://trivy.dev/latest/getting-started/installation/)" ;;
        hadolint)  echo "brew install hadolint  (or: https://github.com/hadolint/hadolint/releases)" ;;
        gitleaks)  echo "brew install gitleaks  (or: https://github.com/gitleaks/gitleaks/releases)" ;;
        *)         echo "see docs/security-scanning.md" ;;
    esac
}

# A tool that is not installed is an error, never a quiet skip: a green scan
# has to mean "the scanners ran", not "the scanners were absent".
require_tool() {
    local name="$1" path
    if ! path="$(tool_path "$name")"; then
        echo "" >&2
        echo "scan: $name is not installed, and the scan it runs is part of the gate." >&2
        echo "      install it with: $(install_hint "$name")" >&2
        echo "      or skip it deliberately: SCAN_SKIP=$name scripts/scan.sh $MODE" >&2
        echo "      (SCAN_TOOLS_CHECK=1 scripts/scan.sh lists everything at once)" >&2
        exit 2
    fi
    echo "$path"
}

tools_check() {
    local missing=0 name path
    echo "scanner            status"
    echo "-----------------  ---------------------------------------------------"
    for name in semgrep bandit pip-audit npm trivy hadolint gitleaks; do
        if path="$(tool_path "$name")"; then
            printf '%-17s  %s\n' "$name" "$path"
        else
            printf '%-17s  MISSING - %s\n' "$name" "$(install_hint "$name")"
            missing=1
        fi
    done
    [ "$missing" -eq 0 ] || echo "" >&2
    [ "$missing" -eq 0 ] || echo "scan: some scanners are missing; \`make scan-tools\` installs them." >&2
    return "$missing"
}

skipped() {
    case ",${SCAN_SKIP}," in
        *",$1,"*) return 0 ;;
        *) return 1 ;;
    esac
}

# --------------------------------------------------------------------------- #
# the summary table
# --------------------------------------------------------------------------- #
SUM_ROWS=()
FAILED=0

# record <tool> <at-or-above-policy> <below-policy> <report> [note]
record() {
    local tool="$1" at="$2" below="$3" report="$4" note="${5:-}"
    SUM_ROWS+=("$tool|$at|$below|$report|$note")
    if [ "$SCAN_FAIL_ON" != "none" ] && [ "$at" != "0" ] && [ "$at" != "-" ]; then
        FAILED=1
    fi
}

summary() {
    echo ""
    echo "==================================================================================="
    echo " security scan summary   (policy: fail on ${SCAN_FAIL_ON}; reports in ${SCAN_OUT}/)"
    echo "==================================================================================="
    printf '%-12s  %8s  %8s  %s\n' "tool" "at/above" "below" "report"
    printf '%-12s  %8s  %8s  %s\n' "------------" "--------" "--------" "------------------------"
    local row tool at below report note
    for row in "${SUM_ROWS[@]}"; do
        IFS='|' read -r tool at below report note <<< "$row"
        printf '%-12s  %8s  %8s  %s\n' "$tool" "$at" "$below" "$report"
        [ -z "$note" ] || printf '%-12s  %s\n' "" "$note"
    done
    echo ""
    if [ "$SCAN_FAIL_ON" = "none" ]; then
        echo "SCAN_FAIL_ON=none: reporting only, exit 0."
    elif [ "$FAILED" -eq 0 ]; then
        echo "clean at the ${SCAN_FAIL_ON} gate."
    else
        echo "FAILED: findings at or above the ${SCAN_FAIL_ON} gate - see the reports above."
    fi
}

# count_sarif <file> <error|error+warning|score:N>
#   error          only SARIF level "error" is at the gate (semgrep ERROR, hadolint error)
#   error+warning  "warning" counts too
#   sev:A,B        gate on trivy's own severity word, which it writes into each rule's
#                  tags (LOW, MEDIUM, HIGH, CRITICAL). trivy maps CRITICAL and HIGH both
#                  to SARIF level "error" and MEDIUM to "warning", and its
#                  security-severity score follows the CVSS vector rather than the
#                  severity it reports, so neither field can stand in for the word
#                  `trivy --severity` itself uses.
# Echoes "<at-or-above> <below> <suppressed>".
#
# SARIF puts the level on the result when the run overrides it and on the rule
# otherwise, so both are consulted. A result carrying a `suppressions` entry is
# one a `# nosemgrep:` line or an ignore file already answered: the tools emit
# it anyway, so it is counted on its own rather than folded into either column,
# and the number of live suppressions stays visible.
count_sarif() {
    python3 - "$1" "$2" <<'PY'
import json, sys

path, gate = sys.argv[1], sys.argv[2]
try:
    with open(path) as fh:
        doc = json.load(fh)
except (OSError, ValueError):
    print("- - -")
    sys.exit(0)

at = below = suppressed = 0
for run in doc.get("runs", []):
    levels = {}
    severities = {}
    for rule in run.get("tool", {}).get("driver", {}).get("rules", []):
        levels[rule.get("id")] = rule.get("defaultConfiguration", {}).get("level", "warning")
        tags = (rule.get("properties") or {}).get("tags") or []
        severities[rule.get("id")] = {str(t).upper() for t in tags}
    for result in run.get("results", []):
        if result.get("suppressions"):
            suppressed += 1
            continue
        level = result.get("level") or levels.get(result.get("ruleId"), "warning")
        if gate.startswith("sev:"):
            wanted = set(gate.split(":", 1)[1].upper().split(","))
            gated = bool(wanted & severities.get(result.get("ruleId"), set()))
        else:
            gated = level == "error" or (gate == "error+warning" and level == "warning")
        if gated:
            at += 1
        else:
            below += 1
print(at, below, suppressed)
PY
}

out_path() { echo "${SCAN_OUT}/$1"; }

# run_bounded <seconds> <command...>
# macOS ships no coreutils `timeout`, so the deadline is a watchdog: the
# command runs in the background and a second job kills it if it overruns.
# A killed command exits 137/143, which every caller already treats as "could
# not run" rather than "found nothing".
run_bounded() {
    local seconds="$1"; shift
    "$@" &
    local pid=$!
    ( sleep "$seconds"; kill -TERM "$pid" 2>/dev/null; sleep 3; kill -KILL "$pid" 2>/dev/null ) \
        >/dev/null 2>&1 &
    local watchdog=$! rc=0
    wait "$pid" || rc=$?
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
    return "$rc"
}

# --------------------------------------------------------------------------- #
# SAST
# --------------------------------------------------------------------------- #
# semgrep. One pass producing SARIF, which carries every finding AND its level,
# so the gate (ERROR) and the baseline (everything else) come out of the same
# run: a second `--severity ERROR` pass would only re-run identical rules to
# recompute a number this one already has.
run_semgrep() {
    skipped semgrep && return 0
    local bin; bin="$(require_tool semgrep)"
    local sarif txt sg_at sg_below sg_suppressed note
    sarif="$(out_path semgrep.sarif)"; txt="$(out_path semgrep.txt)"
    echo ">> semgrep (SAST, multi-language)"
    set +e
    "$bin" scan --metrics=off --quiet \
        --config p/ci --config p/python --config p/javascript --config p/react \
        --config p/dockerfile --config p/kubernetes --config p/owasp-top-ten \
        --sarif --output "$sarif" . > "$txt" 2>&1
    local rc=$?
    set -e
    if [ ! -s "$sarif" ]; then
        echo "scan: semgrep produced no SARIF (exit $rc); see $txt" >&2
        cat "$txt" >&2 || true
        exit 2
    fi
    read -r sg_at sg_below sg_suppressed <<< "$(count_sarif "$sarif" error)"
    python3 - "$sarif" >> "$txt" <<'PY'
import json, sys
with open(sys.argv[1]) as fh:
    doc = json.load(fh)
for run in doc.get("runs", []):
    levels = {r.get("id"): r.get("defaultConfiguration", {}).get("level", "warning")
              for r in run.get("tool", {}).get("driver", {}).get("rules", [])}
    for res in run.get("results", []):
        loc = (res.get("locations") or [{}])[0].get("physicalLocation", {})
        art = loc.get("artifactLocation", {}).get("uri", "?")
        line = loc.get("region", {}).get("startLine", "?")
        level = res.get("level") or levels.get(res.get("ruleId"), "warning")
        label = "SUPPRESSED" if res.get("suppressions") else level.upper()
        print(f"{label:10} {art}:{line}  {res.get('ruleId')}")
PY
    note=""
    [ "$sg_suppressed" = "0" ] || note="plus ${sg_suppressed} answered by a # nosemgrep line (see the report)"
    record semgrep "$sg_at" "$sg_below" "$txt" "$note"
}

# bandit. Gated on what bandit itself calls actionable: HIGH severity at MEDIUM
# or better confidence. Everything else (the LOW/MEDIUM noise that a Python
# codebase always has: try/except/pass, a partial executable path in a dev
# script) is counted and reported.
run_bandit() {
    skipped bandit && return 0
    local bin; bin="$(require_tool bandit)"
    local json txt
    json="$(out_path bandit.json)"; txt="$(out_path bandit.txt)"
    echo ">> bandit (SAST, Python)"
    set +e
    "$bin" -r data-layer/app data-layer/scripts mcp-server/server.py patching-service/app \
        -c data-layer/bandit.yaml -f json -o "$json" > "$txt" 2>&1
    # The same run again as SARIF, for code scanning; bandit is fast enough
    # that one more pass costs less than teaching the gate to read SARIF.
    "$bin" -r data-layer/app data-layer/scripts mcp-server/server.py patching-service/app \
        -c data-layer/bandit.yaml -f sarif -o "$(out_path bandit.sarif)" >/dev/null 2>&1 || true
    set -e
    if [ ! -s "$json" ]; then
        echo "scan: bandit produced no report; see $txt" >&2
        cat "$txt" >&2 || true
        exit 2
    fi
    local conf="MEDIUM HIGH"
    [ "$SCAN_FAIL_ON" = "critical" ] && conf="HIGH"
    local counts
    counts="$(python3 - "$json" "$conf" "$txt" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
allowed = set(sys.argv[2].split())
at = below = 0
with open(sys.argv[3], "a") as report:
    for r in doc.get("results", []):
        gated = r["issue_severity"] == "HIGH" and r["issue_confidence"] in allowed
        at, below = (at + 1, below) if gated else (at, below + 1)
        report.write(f"{'GATE' if gated else 'note'}  {r['issue_severity']:6} "
                     f"{r['issue_confidence']:6} {r['test_id']}  "
                     f"{r['filename']}:{r['line_number']}  {r['issue_text']}\n")
print(at, below)
PY
)"
    record bandit "${counts% *}" "${counts#* }" "$txt"
}

# --------------------------------------------------------------------------- #
# SCA
# --------------------------------------------------------------------------- #
# pip-audit, one pass per requirements file. Any vulnerability fails unless its
# ID is in PIP_AUDIT_IGNORE above with a reason and an expiry, because there is
# no useful severity on a pinned dependency: either a fixed version exists or a
# decision was made not to take it.
run_pip_audit() {
    skipped pip-audit && return 0
    local bin; bin="$(require_tool pip-audit)"
    local txt req json component at=0 below=0
    txt="$(out_path pip-audit.txt)"
    echo ">> pip-audit (SCA, Python)"
    : > "$txt"
    local ignore_args=() vuln
    for vuln in "${PIP_AUDIT_IGNORE[@]}"; do ignore_args+=(--ignore-vuln "$vuln"); done
    for req in "${REQUIREMENTS[@]}"; do
        [ -f "$req" ] || continue
        component="${req%%/*}"
        json="$(out_path "pip-audit-${component}.json")"
        echo "--- $req" >> "$txt"
        # The human report reflects the gate: ignores applied, descriptions on.
        set +e
        "$bin" -r "$req" --strict --desc "${ignore_args[@]}" >> "$txt" 2>&1
        # The machine report has everything, ignored or not, so the summary can
        # say how much was passed over rather than claim the tree is clean.
        "$bin" -r "$req" --format json > "$json" 2>/dev/null
        local rc=$?
        set -e
        if [ ! -s "$json" ]; then
            echo "scan: pip-audit could not audit $req (exit $rc); see $txt" >&2
            exit 2
        fi
        local counts
        counts="$(python3 - "$json" "${PIP_AUDIT_IGNORE[*]}" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
ignored = set(sys.argv[2].split())
at = below = 0
for dep in doc.get("dependencies", []):
    for v in dep.get("vulns", []):
        ids = {v["id"]} | set(v.get("aliases") or [])
        below, at = (below + 1, at) if ids & ignored else (below, at + 1)
print(at, below)
PY
)"
        at=$((at + ${counts%% *}))
        below=$((below + ${counts##* }))
    done
    record pip-audit "$at" "$below" "$txt" "below = documented --ignore-vuln entries in scripts/scan.sh"
}

# npm audit over the dashboard's production dependency tree. Dev dependencies
# (vite, vitest and their trees) never reach a browser, so they are excluded
# rather than suppressed one advisory at a time.
run_npm_audit() {
    skipped npm-audit && return 0
    local bin; bin="$(require_tool npm)"
    local txt json
    txt="$(out_path npm-audit.txt)"; json="$(out_path npm-audit.json)"
    echo ">> npm audit (SCA, JavaScript)"
    if [ ! -f dashboard/package-lock.json ] && [ ! -d dashboard/node_modules ]; then
        echo "scan: dashboard has no package-lock.json and no node_modules;" >&2
        echo "      run 'cd dashboard && npm ci --ignore-scripts' first." >&2
        exit 2
    fi
    local level=high
    [ "$SCAN_FAIL_ON" = "critical" ] && level=critical
    set +e
    ( cd dashboard && "$bin" audit --omit=dev --audit-level="$level" ) > "$txt" 2>&1
    ( cd dashboard && "$bin" audit --omit=dev --json ) > "$json" 2>/dev/null
    set -e
    local counts
    counts="$(python3 - "$json" "$level" <<'PY'
import json, sys
try:
    doc = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    print("- -"); sys.exit(0)
order = ["info", "low", "moderate", "high", "critical"]
floor = order.index(sys.argv[2])
counts = doc.get("metadata", {}).get("vulnerabilities", {})
at = sum(counts.get(k, 0) for k in order[floor:])
below = sum(counts.get(k, 0) for k in order[:floor])
print(at, below)
PY
)"
    record npm-audit "${counts% *}" "${counts#* }" "$txt"
}

# --------------------------------------------------------------------------- #
# trivy over the working tree: dependency vulnerabilities, IaC misconfiguration
# and secrets, whichever of the three this run is about.
# --------------------------------------------------------------------------- #
run_trivy_fs() {
    skipped trivy-fs && return 0
    local scanners="$1" label="$2"
    local bin; bin="$(require_tool trivy)"
    local sarif txt sev=HIGH,CRITICAL
    [ "$SCAN_FAIL_ON" = "critical" ] && sev=CRITICAL
    sarif="$(out_path "trivy-${label}.sarif")"; txt="$(out_path "trivy-${label}.txt")"
    echo ">> trivy fs --scanners ${scanners} (${label})"
    local skip_args=() d
    for d in "${TRIVY_SKIP_DIRS[@]}"; do skip_args+=(--skip-dirs "$d"); done
    set +e
    run_bounded "$SCAN_TIMEOUT_SECONDS" \
        "$bin" fs --scanners "$scanners" --severity "$sev" --ignorefile .trivyignore.yaml \
        --timeout "$TRIVY_TIMEOUT" --format table --no-progress "${skip_args[@]}" . > "$txt" 2>&1
    local rc=$?
    run_bounded "$SCAN_TIMEOUT_SECONDS" \
        "$bin" fs --scanners "$scanners" --ignorefile .trivyignore.yaml \
        --timeout "$TRIVY_TIMEOUT" --format sarif --output "$sarif" --no-progress \
        "${skip_args[@]}" . >> "$txt" 2>&1
    set -e
    if [ "$rc" -gt 1 ] || [ ! -s "$sarif" ]; then
        echo "scan: trivy could not complete (exit $rc). Its vulnerability database and" >&2
        echo "      checks bundle are OCI artifacts pulled from mirror.gcr.io / ghcr.io at" >&2
        echo "      run time; a machine that cannot reach either hangs on the pull, and" >&2
        echo "      SCAN_TIMEOUT_SECONDS=${SCAN_TIMEOUT_SECONDS} then kills it. See $txt." >&2
        echo "      Point it at a mirror with TRIVY_DB_REPOSITORY, or skip it deliberately" >&2
        echo "      with SCAN_SKIP=trivy-fs (semgrep p/kubernetes + p/dockerfile and" >&2
        echo "      hadolint still cover IaC; gitleaks still covers secrets)." >&2
        exit 2
    fi
    local t_at t_below t_suppressed note
    local gate_sev=HIGH,CRITICAL; [ "$SCAN_FAIL_ON" = "critical" ] && gate_sev=CRITICAL
    read -r t_at t_below t_suppressed <<< "$(count_sarif "$sarif" "sev:${gate_sev}")"
    note=""
    [ "$t_suppressed" = "0" ] || note="plus ${t_suppressed} answered by .trivyignore.yaml"
    record "trivy-$label" "$t_at" "$t_below" "$txt" "$note"
}

# --------------------------------------------------------------------------- #
# IaC: Dockerfile linting
# --------------------------------------------------------------------------- #
# hadolint's own failure-threshold lives in .hadolint.yaml (error). Warnings
# and below are reported here and gate nothing.
run_hadolint() {
    skipped hadolint && return 0
    local bin; bin="$(require_tool hadolint)"
    local sarif txt
    sarif="$(out_path hadolint.sarif)"; txt="$(out_path hadolint.txt)"
    echo ">> hadolint (IaC, Dockerfiles)"
    : > "$txt"
    set +e
    "$bin" --no-color --config .hadolint.yaml --no-fail "${DOCKERFILES[@]}" >> "$txt" 2>&1
    "$bin" --config .hadolint.yaml --no-fail --format sarif "${DOCKERFILES[@]}" > "$sarif" 2>/dev/null
    set -e
    local h_at h_below _h_suppressed
    read -r h_at h_below _h_suppressed <<< "$(count_sarif "$sarif" error)"
    record hadolint "$h_at" "$h_below" "$txt"
}

# --------------------------------------------------------------------------- #
# secrets
# --------------------------------------------------------------------------- #
# The whole history, not the checkout: a credential removed in a later commit
# is still published. Where there is no .git (a release tarball, a container
# build context) the tree is scanned instead, and the report says so.
run_gitleaks() {
    skipped gitleaks && return 0
    local bin; bin="$(require_tool gitleaks)"
    local sarif txt
    sarif="$(out_path gitleaks.sarif)"; txt="$(out_path gitleaks.txt)"
    echo ">> gitleaks (secrets)"
    set +e
    if [ -e .git ]; then
        "$bin" git --redact -v --no-banner --config .gitleaks.toml --log-opts="--all" \
            --report-format sarif --report-path "$sarif" . > "$txt" 2>&1
    else
        echo "(no .git: scanning the working tree only, history was not checked)" > "$txt"
        "$bin" dir --redact -v --no-banner --config .gitleaks.toml \
            --report-format sarif --report-path "$sarif" . >> "$txt" 2>&1
    fi
    set -e
    # gitleaks writes no report file when it finds nothing.
    local at=0
    [ -s "$sarif" ] && at="$(python3 -c '
import json, sys
doc = json.load(open(sys.argv[1]))
print(sum(len(r.get("results", [])) for r in doc.get("runs", [])))' "$sarif")"
    # Every gitleaks finding is at the gate: there is no "low severity" secret.
    record gitleaks "$at" 0 "$txt"
}

# --------------------------------------------------------------------------- #
# containers
# --------------------------------------------------------------------------- #
# Images already built locally (`make images`), not rebuilt here: what ships is
# what a release pipeline tagged, and rebuilding would scan something else.
# --ignore-unfixed because a base-image CVE with no fix available is a reason to
# change base image, which is a decision, not a build failure.
run_trivy_image() {
    skipped trivy-image && return 0
    local bin; bin="$(require_tool trivy)"
    local sev=HIGH,CRITICAL
    [ "$SCAN_FAIL_ON" = "critical" ] && sev=CRITICAL
    local at=0 below=0 image txt sarif label
    for label in backend dashboard; do
        image="${IMAGE_PREFIX}/odl-${label}:${IMAGE_TAG}"
        txt="$(out_path "trivy-image-${label}.txt")"
        sarif="$(out_path "trivy-image-${label}.sarif")"
        echo ">> trivy image ${image}"
        set +e
        run_bounded "$SCAN_TIMEOUT_SECONDS" \
            "$bin" image --severity "$sev" --ignore-unfixed --ignorefile .trivyignore.yaml \
            --timeout "$TRIVY_TIMEOUT" --format table --no-progress "$image" > "$txt" 2>&1
        local rc=$?
        run_bounded "$SCAN_TIMEOUT_SECONDS" \
            "$bin" image --ignore-unfixed --ignorefile .trivyignore.yaml \
            --timeout "$TRIVY_TIMEOUT" --format sarif --output "$sarif" --no-progress \
            "$image" >> "$txt" 2>&1
        set -e
        if [ "$rc" -gt 1 ]; then
            echo "scan: trivy could not scan ${image} (exit $rc). Either the image is not" >&2
            echo "      built yet:  make images IMAGE_PREFIX=${IMAGE_PREFIX} IMAGE_TAG=${IMAGE_TAG}" >&2
            echo "      or trivy could not pull its database (see 'trivy needs a registry' in" >&2
            echo "      docs/security-scanning.md). Either way, $txt says which." >&2
            exit 2
        fi
        local i_at i_below i_suppressed note
        local gate_sev=HIGH,CRITICAL; [ "$SCAN_FAIL_ON" = "critical" ] && gate_sev=CRITICAL
        read -r i_at i_below i_suppressed <<< "$(count_sarif "$sarif" "sev:${gate_sev}")"
        at=$((at + i_at)); below=$((below + i_below))
        note=""
        [ "$i_suppressed" = "0" ] || note="plus ${i_suppressed} answered by .trivyignore.yaml"
        record "trivy-img-$label" "$i_at" "$i_below" "$txt" "$note"
    done
}

# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
if [ "${SCAN_TOOLS_CHECK:-}" = "1" ]; then
    tools_check
    exit $?
fi

mkdir -p "$SCAN_OUT"

case "$MODE" in
    all)
        run_semgrep
        run_bandit
        run_pip_audit
        run_npm_audit
        run_trivy_fs vuln,misconfig,secret tree
        run_hadolint
        run_gitleaks
        ;;
    sast)
        run_semgrep
        run_bandit
        ;;
    sca)
        run_pip_audit
        run_npm_audit
        run_trivy_fs vuln vuln
        ;;
    secrets)
        run_gitleaks
        run_trivy_fs secret secret
        ;;
    iac)
        run_trivy_fs misconfig misconfig
        run_hadolint
        ;;
    images)
        run_trivy_image
        ;;
    semgrep)     run_semgrep ;;
    bandit)      run_bandit ;;
    pip-audit)   run_pip_audit ;;
    npm-audit)   run_npm_audit ;;
    trivy-fs)    run_trivy_fs vuln,misconfig,secret tree ;;
    hadolint)    run_hadolint ;;
    gitleaks)    run_gitleaks ;;
    trivy-image) run_trivy_image ;;
    -h|--help|help)
        sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e 's/^# \{0,1\}//' -e '$d'
        exit 0
        ;;
    *)
        echo "scan: unknown mode '$MODE'" >&2
        echo "usage: scripts/scan.sh [all|sast|sca|secrets|iac|images|<tool>]" >&2
        exit 2
        ;;
esac

summary
[ "$FAILED" -eq 0 ] || exit 1
exit 0
