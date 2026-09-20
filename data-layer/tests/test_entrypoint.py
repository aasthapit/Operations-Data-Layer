"""
The image's entrypoint: one image, four roles.

The script is run for real with `sh`, against stubs for `uvicorn` and `python`
that print their argv and the environment the script chose. That is what makes
these assertions worth anything: the role parsing, the COLLECTOR_ENABLED flag
and the StatefulSet ordinal are shell, and only shell can prove them.
"""
import os
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ENTRYPOINT = os.path.join(ROOT, "entrypoint.sh")

# Each stub prints what it was called as, its arguments, and the environment
# the entrypoint set for it.
STUB = ('#!/bin/sh\n'
        'echo "$(basename "$0") $*"\n'
        'echo "COLLECTOR_ENABLED=${COLLECTOR_ENABLED:-unset}"\n'
        'echo "ODL_ROLE=${ODL_ROLE:-unset}"\n'
        'echo "COLLECT_SHARD=${COLLECT_SHARD:-unset}"\n')


@pytest.fixture(scope="module")
def stubs(tmp_path_factory):
    path = tmp_path_factory.mktemp("bin")
    for name in ("uvicorn", "python"):
        stub = path / name
        stub.write_text(STUB)
        stub.chmod(0o755)
    return str(path)


def run(stubs, *args, **env):
    done = subprocess.run(["sh", ENTRYPOINT, *args], capture_output=True, text=True, timeout=60,
                          cwd=ROOT, env={"PATH": f"{stubs}:{os.environ['PATH']}",
                                         "HOME": "/tmp", **env})
    return done


def test_the_role_comes_from_the_argument(stubs):
    done = run(stubs, "worker")
    assert done.returncode == 0, done.stderr
    assert "python -m app.worker" in done.stdout
    assert "ODL_ROLE=worker" in done.stdout


def test_the_role_comes_from_the_environment_when_there_is_no_argument(stubs):
    done = run(stubs, ODL_ROLE="worker")
    assert done.returncode == 0 and "python -m app.worker" in done.stdout


def test_the_default_role_is_all_and_it_leaves_the_collector_alone(stubs):
    done = run(stubs)
    assert done.returncode == 0, done.stderr
    assert "uvicorn app.main:app --host 0.0.0.0 --port 8000" in done.stdout
    assert '--proxy-headers --forwarded-allow-ips=*' in done.stdout
    assert "COLLECTOR_ENABLED=unset" in done.stdout and "ODL_ROLE=all" in done.stdout


def test_the_api_role_disables_the_collector(stubs):
    done = run(stubs, "api", PORT="9000")
    assert done.returncode == 0, done.stderr
    assert "--port 9000" in done.stdout
    assert "COLLECTOR_ENABLED=false" in done.stdout and "ODL_ROLE=api" in done.stdout


def test_an_explicit_collector_enabled_survives_the_all_role(stubs):
    done = run(stubs, "all", COLLECTOR_ENABLED="false")
    assert "COLLECTOR_ENABLED=false" in done.stdout


def test_check_config_runs_the_script(stubs):
    done = run(stubs, "check-config")
    assert done.returncode == 0
    assert "python scripts/check_fleet_config.py" in done.stdout


def test_extra_arguments_reach_the_process(stubs):
    done = run(stubs, "worker", "--check", "--max-age", "10")
    assert "python -m app.worker --check --max-age 10" in done.stdout


def test_an_unknown_role_is_a_usage_error(stubs):
    done = run(stubs, "collect")
    assert done.returncode == 64
    assert "unknown role: collect" in done.stderr and "api|worker|all|check-config" in done.stderr


def test_help_is_not_an_error(stubs):
    done = run(stubs, "--help")
    assert done.returncode == 0 and "check-config" in done.stderr


def test_the_shard_comes_from_a_statefulset_ordinal(stubs):
    done = run(stubs, "worker", HOSTNAME="odl-collector-2", ODL_SHARD_FROM_HOSTNAME="4")
    assert done.returncode == 0, done.stderr
    assert "COLLECT_SHARD=2/4" in done.stdout


def test_a_hostname_without_an_ordinal_leaves_the_shard_alone(stubs):
    done = run(stubs, "worker", HOSTNAME="odl-collector", ODL_SHARD_FROM_HOSTNAME="4",
               COLLECT_SHARD="1/3")
    assert done.returncode == 0
    assert "COLLECT_SHARD=1/3" in done.stdout
    assert "no trailing -N ordinal" in done.stderr


def test_the_shard_is_untouched_without_the_opt_in(stubs):
    done = run(stubs, "worker", HOSTNAME="odl-collector-2")
    assert "COLLECT_SHARD=unset" in done.stdout
