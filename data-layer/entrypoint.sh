#!/bin/sh
# One image, several roles. The role comes from the first argument or from
# ODL_ROLE, so the same image is the API container, the collector container and
# the config check, and a pod manifest picks one with `args: ["worker"]` or an
# env var - not with a different image.
#
# Everything below `exec`s, so the process the orchestrator signals is the
# Python process itself: a SIGTERM reaches uvicorn or the worker directly
# instead of dying at a shell that never forwarded it.
set -eu

if [ "$#" -gt 0 ]; then
    role=$1
    shift
else
    role=${ODL_ROLE:-all}
fi
# The process reports its own role in its presence record, so it has to see the
# role that was actually chosen, not the default it was started with.
ODL_ROLE=$role
export ODL_ROLE
PORT=${PORT:-8000}
export PORT

usage() {
    cat >&2 <<EOF
usage: $0 [api|worker|all|check-config]

  api            read-only API and UI over Redis; never collects (port \$PORT)
  worker         headless collector: startup sweep, scheduler, refresh queue
  all            both in one process (the default, and what compose runs)
  check-config   try the fleet config the way the collector will, then exit

The role may also be set with ODL_ROLE. See docs/containers.md.
EOF
}

# StatefulSet ordinals: pod `odl-collector-2` of a set of 4 collects the third
# shard. Spelling it here rather than in the manifest keeps the same three env
# vars in every replica, which is all a StatefulSet can give them.
# $HOSTNAME is set by every container runtime; /proc is the fallback.
if [ -n "${ODL_SHARD_FROM_HOSTNAME:-}" ]; then
    host=${HOSTNAME:-$(cat /proc/sys/kernel/hostname 2>/dev/null || echo "")}
    ordinal=${host##*-}
    case "$ordinal" in
        ''|*[!0-9]*)
            echo "ODL_SHARD_FROM_HOSTNAME is set but hostname '$host' has no trailing -N ordinal;" \
                 "leaving COLLECT_SHARD as it is" >&2
            ;;
        *)
            COLLECT_SHARD="$ordinal/$ODL_SHARD_FROM_HOSTNAME"
            export COLLECT_SHARD
            echo "shard from hostname $host: COLLECT_SHARD=$COLLECT_SHARD" >&2
            ;;
    esac
fi

case "$role" in
    api)
        # Read-only over Redis: no startup sweep, no scheduler, and a refresh
        # is queued to the collectors instead of run here.
        COLLECTOR_ENABLED=false
        export COLLECTOR_ENABLED
        exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT" \
            --proxy-headers --forwarded-allow-ips="*" "$@"
        ;;
    all)
        # COLLECTOR_ENABLED is left alone: `all` means today's behaviour, and
        # an operator who set it to false meant it.
        exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT" \
            --proxy-headers --forwarded-allow-ips="*" "$@"
        ;;
    worker)
        exec python -m app.worker "$@"
        ;;
    check-config)
        exec python scripts/check_fleet_config.py "$@"
        ;;
    -h|--help|help)
        usage
        exit 0
        ;;
    *)
        echo "unknown role: $role" >&2
        usage
        exit 64
        ;;
esac
