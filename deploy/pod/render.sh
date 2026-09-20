#!/bin/sh
# Generate odl-pod-with-redis.yaml from odl-pod.yaml.
#
#   deploy/pod/render.sh          # or: make pod-render
#   deploy/pod/render.sh --check  # fail if the generated file is out of date
#
# The two manifests differ by a redis container, its volume, and the REDIS_URL
# in the Secret - which is exactly what this script adds. Keeping them as one
# source and one generated copy is the only way three hundred lines of
# securityContext, probes and resources cannot drift apart. Edit odl-pod.yaml.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
src="$here/odl-pod.yaml"
out="$here/odl-pod-with-redis.yaml"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# The container, at the indentation of the containers list in odl-pod.yaml.
cat > "$tmpdir/container.yaml" <<'YAML'
    # ---- redis: the fleet state store, in the pod -------------------------
    # Only in this variant. A real deployment points REDIS_URL at an instance
    # that somebody operates; this is for a laptop that has none.
    - name: redis
      image: docker.io/library/redis:7-alpine
      imagePullPolicy: IfNotPresent
      args:
        # noeviction is deliberate: a cache that silently dropped a cluster
        # would answer blast-radius questions wrongly. Per-cluster keys carry
        # their own TTL (REDIS_TTL_SECONDS) and age out explicitly instead.
        - "--maxmemory-policy"
        - "noeviction"
        # An RDB snapshot every 60s if anything changed. Enough durability for
        # a cache any sweep can rebuild, so the AOF stays off.
        - "--save"
        - "60"
        - "1"
        - "--appendonly"
        - "no"
      ports:
        - name: redis
          containerPort: 6379
      readinessProbe:
        exec:
          command: ["redis-cli", "ping"]
        periodSeconds: 5
      livenessProbe:
        tcpSocket: { port: 6379 }
        periodSeconds: 20
      resources:
        requests: { cpu: 100m, memory: 512Mi }
        limits: { cpu: "1", memory: 2Gi }
      securityContext:
        # The official redis image declares no USER, so runAsNonRoot on its
        # own would refuse to start it. 999 is the `redis` account inside.
        runAsUser: 999
        runAsNonRoot: true
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
        seccompProfile:
          type: RuntimeDefault
      volumeMounts:
        - name: redis-data
          mountPath: /data
YAML

# The volume, at the indentation of the volumes list.
cat > "$tmpdir/volume.yaml" <<'YAML'
    # The claim is declared at the end of this file. podman backs it with a
    # named volume `odl-redis-data`; Kubernetes binds it from the default
    # storage class.
    - name: redis-data
      persistentVolumeClaim:
        claimName: odl-redis-data
YAML

{
    cat <<'BANNER'
# GENERATED FILE - do not edit.
#
# Produced by deploy/pod/render.sh from deploy/pod/odl-pod.yaml: the same pod
# plus a redis container, for a laptop with no Redis to point at. Change
# odl-pod.yaml and re-run `make pod-render`.
#
BANNER
    awk \
        -v cfile="$tmpdir/container.yaml" \
        -v vfile="$tmpdir/volume.yaml" '
        /^[[:space:]]*# RENDER-REDIS-CONTAINER[[:space:]]*$/ {
            while ((getline line < cfile) > 0) print line
            next
        }
        /^[[:space:]]*# RENDER-REDIS-VOLUME[[:space:]]*$/ {
            while ((getline line < vfile) > 0) print line
            next
        }
        { print }
    ' "$src" \
    | sed -e 's|^\([[:space:]]*REDIS_URL: \).*|\1redis://127.0.0.1:6379/0|'
    cat <<'CLAIM'
---
# Where the redis container keeps its snapshot. Without this object plain
# Kubernetes never schedules the pod ("persistentvolumeclaim not found");
# `podman kube play` reads it too and creates the named volume from it.
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: odl-redis-data
  labels:
    app.kubernetes.io/name: odl
    app.kubernetes.io/component: redis
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 8Gi
CLAIM
} > "$tmpdir/rendered.yaml"

if [ "${1:-}" = "--check" ]; then
    if cmp -s "$tmpdir/rendered.yaml" "$out"; then
        echo "deploy/pod/odl-pod-with-redis.yaml is up to date"
        exit 0
    fi
    echo "deploy/pod/odl-pod-with-redis.yaml is out of date - run: make pod-render" >&2
    diff -u "$out" "$tmpdir/rendered.yaml" >&2 || true
    exit 1
fi

cp "$tmpdir/rendered.yaml" "$out"
echo "wrote deploy/pod/odl-pod-with-redis.yaml"
