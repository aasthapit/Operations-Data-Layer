"""
Synthetic load test for the Redis store.

Generates realistic collector documents - the exact shape
`app/collector/collect.py:assemble()` produces - for a fleet of N clusters,
runs the same health checks the collector runs, persists every cluster through
the real `RedisStore`, and then reports what Redis actually cost: memory by key
class, per-cluster compressed section sizes, write throughput and read latency
for the store calls the API depends on.

Nothing here talks to a cluster: the point is to measure the store, not the
collector. The sizing assumptions (250 application namespaces, ~1,700
workloads, ~16,600 inventory objects per cluster) come from ADR-0003.

    .venv/bin/python -m scripts.synth_load --clusters 900 --report load.md
    .venv/bin/python scripts/synth_load.py --clusters 20 --redis-url redis://localhost:16379/0
"""
from __future__ import annotations

import argparse
import concurrent.futures
import fnmatch
import json
import math
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request
import zlib
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
os.environ.setdefault("ODL_MANIFEST", os.path.join(ROOT, "config", "ocp-api-manifest.yaml"))
os.environ.setdefault("ODL_CONFIG", os.path.join(ROOT, "config", "hubs.yaml"))

import redis  # noqa: E402

from app.collector.healthchecks import run_health_checks  # noqa: E402
from app.collector.parsers import split_image  # noqa: E402
from app.collector.registry import REGISTRY  # noqa: E402
from app.manifest import get_manifest  # noqa: E402
from app.store.base import SECTIONS  # noqa: E402
from app.store.redis_store import RedisStore  # noqa: E402

GIB = 1024 ** 3
MIB = 1024 ** 2


# --------------------------------------------------------------------------- #
# fleet-wide pools: what makes 900 clusters look like one fleet and not 900
# unrelated ones (an application runs on many clusters, an image is pulled by
# many applications, a team owns many applications).
# --------------------------------------------------------------------------- #
REGIONS = (
    ("us-east-1", "aws"), ("us-east-2", "aws"), ("us-west-2", "aws"),
    ("eu-west-1", "aws"), ("eu-central-1", "azure"), ("ap-southeast-1", "aws"),
    ("ap-northeast-1", "gcp"), ("sa-east-1", "vsphere"),
)
ENVIRONMENTS = (("production", 0.52), ("staging", 0.20), ("development", 0.18), ("dr", 0.10))
VERSIONS = (("4.14.33", 0.06), ("4.15.28", 0.14), ("4.15.31", 0.16), ("4.16.20", 0.18),
            ("4.16.23", 0.16), ("4.17.9", 0.13), ("4.17.12", 0.12), ("4.18.3", 0.05))
TIERS = (("critical", 0.18), ("standard", 0.62), ("best-effort", 0.20))

OPERATORS = (
    "authentication", "baremetal", "cloud-controller-manager", "cloud-credential",
    "cluster-autoscaler", "config-operator", "console", "control-plane-machine-set",
    "csi-snapshot-controller", "dns", "etcd", "image-registry", "ingress", "insights",
    "kube-apiserver", "kube-controller-manager", "kube-scheduler",
    "kube-storage-version-migrator", "machine-api", "machine-approver", "machine-config",
    "marketplace", "monitoring", "network", "node-tuning", "openshift-apiserver",
    "openshift-controller-manager", "openshift-samples", "operator-lifecycle-manager",
    "operator-lifecycle-manager-catalog", "operator-lifecycle-manager-packageserver",
    "platform-operators-aggregated", "service-ca", "storage", "insights-runtime-extractor",
)
CRITICAL_OPERATORS = frozenset({
    "etcd", "kube-apiserver", "kube-controller-manager", "kube-scheduler", "network",
    "dns", "ingress", "authentication", "machine-config",
})

PLATFORM_NAMESPACES = (
    "default", "kube-system", "kube-public", "kube-node-lease", "openshift",
    "openshift-apiserver", "openshift-apiserver-operator", "openshift-authentication",
    "openshift-authentication-operator", "openshift-cloud-controller-manager",
    "openshift-cloud-controller-manager-operator", "openshift-cloud-credential-operator",
    "openshift-cloud-network-config-controller", "openshift-cluster-csi-drivers",
    "openshift-cluster-machine-approver", "openshift-cluster-node-tuning-operator",
    "openshift-cluster-samples-operator", "openshift-cluster-storage-operator",
    "openshift-cluster-version", "openshift-config", "openshift-config-managed",
    "openshift-config-operator", "openshift-console", "openshift-console-operator",
    "openshift-console-user-settings", "openshift-controller-manager",
    "openshift-controller-manager-operator", "openshift-dns", "openshift-dns-operator",
    "openshift-etcd", "openshift-etcd-operator", "openshift-image-registry", "openshift-infra",
    "openshift-ingress", "openshift-ingress-canary", "openshift-ingress-operator",
    "openshift-insights", "openshift-kube-apiserver", "openshift-kube-apiserver-operator",
    "openshift-kube-controller-manager", "openshift-kube-controller-manager-operator",
    "openshift-kube-scheduler", "openshift-kube-scheduler-operator",
    "openshift-kube-storage-version-migrator", "openshift-machine-api",
    "openshift-machine-config-operator", "openshift-marketplace", "openshift-monitoring",
    "openshift-multus", "openshift-network-diagnostics", "openshift-network-node-identity",
    "openshift-network-operator", "openshift-node", "openshift-oauth-apiserver",
    "openshift-operator-lifecycle-manager", "openshift-operators", "openshift-ovn-kubernetes",
    "openshift-route-controller-manager", "openshift-service-ca", "openshift-service-ca-operator",
    "openshift-user-workload-monitoring", "open-cluster-management-agent",
    "open-cluster-management-agent-addon", "openshift-logging", "openshift-adp",
    "openshift-gitops", "openshift-pipelines", "openshift-compliance", "openshift-storage",
    "openshift-local-storage", "openshift-sriov-network-operator",
)

OLM_PACKAGES = (
    "openshift-gitops-operator", "openshift-pipelines-operator-rh", "cluster-logging",
    "elasticsearch-operator", "local-storage-operator", "odf-operator",
    "advanced-cluster-management", "multicluster-engine", "compliance-operator",
    "file-integrity-operator", "kubernetes-nmstate-operator", "sriov-network-operator",
    "node-healthcheck-operator", "cert-manager", "rhsso-operator", "amq-streams",
    "serverless-operator", "servicemeshoperator", "kiali-ossm", "jaeger-product",
    "quay-operator", "container-security-operator", "web-terminal",
    "kubevirt-hyperconverged", "node-maintenance-operator", "external-dns-operator",
    "aws-load-balancer-operator", "cluster-observability-operator", "tempo-product",
    "opentelemetry-product", "loki-operator", "netobserv-operator", "devworkspace-operator",
    "rhods-operator", "custom-metrics-autoscaler", "vertical-pod-autoscaler",
    "run-once-duration-override-operator", "secondary-scheduler-operator",
    "numaresources-operator", "ptp-operator",
)

STORAGE_CLASSES = (
    ("gp3-csi", "ebs.csi.aws.com", True), ("gp2-csi", "ebs.csi.aws.com", False),
    ("thin-csi", "csi.vsphere.vmware.com", False),
    ("ocs-storagecluster-ceph-rbd", "openshift-storage.rbd.csi.ceph.com", False),
    ("ocs-storagecluster-cephfs", "openshift-storage.cephfs.csi.ceph.com", False),
    ("nfs-client", "cluster.local/nfs-subdir-external-provisioner", False),
    ("standard-csi", "pd.csi.storage.gke.io", False),
    ("managed-premium", "disk.csi.azure.com", False),
    ("local-sc", "kubernetes.io/no-provisioner", False),
    ("topolvm-provisioner", "topolvm.io", False),
)

EVENT_REASONS = (
    ("FailedScheduling", "Warning"), ("BackOff", "Warning"), ("Unhealthy", "Warning"),
    ("FailedMount", "Warning"), ("NodeNotReady", "Warning"), ("Evicted", "Warning"),
    ("FailedCreatePodSandBox", "Warning"), ("ProbeWarning", "Warning"),
    ("NetworkNotReady", "Warning"), ("FailedAttachVolume", "Warning"),
    ("OOMKilling", "Warning"), ("TaintManagerEviction", "Warning"),
    ("ScalingReplicaSet", "Normal"), ("Killing", "Normal"),
)

POD_ISSUE_REASONS = (
    ("CrashLoopBackOff", 0.26), ("ImagePullBackOff", 0.14), ("OOMKilled", 0.12),
    ("Pending", 0.11), ("Unschedulable", 0.09), ("HighRestarts", 0.12),
    ("NotReady", 0.09), ("Evicted", 0.05), ("Failed", 0.02),
)

ENV_NAMES = (
    "LOG_LEVEL", "JAVA_OPTS", "SPRING_PROFILES_ACTIVE", "DATABASE_URL", "DATABASE_PASSWORD",
    "REDIS_HOST", "KAFKA_BROKERS", "OTEL_EXPORTER_OTLP_ENDPOINT", "AWS_REGION",
    "FEATURE_FLAGS_URL", "TZ", "HTTP_PROXY", "API_TOKEN", "TLS_CERT_PATH", "POD_NAME",
    "NODE_NAME", "MAX_CONNECTIONS", "CACHE_TTL_SECONDS",
)

_APP_DOMAINS = (
    "checkout", "billing", "payments", "identity", "catalog", "inventory", "shipping",
    "pricing", "search", "recommend", "fraud", "ledger", "notify", "onboarding", "claims",
    "policy", "underwrite", "settlement", "treasury", "loyalty", "returns", "warehouse",
    "dispatch", "routing", "telemetry", "reporting", "forecast", "risk", "compliance",
    "audit", "customer", "partner", "merchant", "wallet", "quotes", "orders", "invoices",
    "subscriptions", "entitlements", "consent", "profile", "messaging", "campaign",
    "content", "media", "translate", "geo", "tax", "refunds", "disputes", "kyc", "aml",
    "scoring", "pricing-engine", "sso", "gateway", "edge", "mesh", "batch", "etl",
)
_APP_COMPONENTS = (
    "api", "web", "worker", "gateway", "service", "processor", "scheduler", "consumer",
    "publisher", "sync", "indexer", "cache", "store", "admin", "ui", "bff", "adapter",
    "connector", "router", "aggregator", "validator", "exporter", "importer", "streamer",
    "reconciler", "notifier", "dispatcher", "collector", "analyzer", "renderer", "signer",
    "auditor", "archiver", "cleaner", "migrator", "seeder", "poller", "watcher", "proxy",
    "sidecar", "job", "cron", "report", "metrics", "portal", "console", "edge", "relay",
    "broker", "queue",
)
_TEAM_WORDS = (
    "platform", "payments", "identity", "commerce", "data", "growth", "risk", "core",
    "infra", "mobile", "web", "search", "ml", "sre", "security", "billing", "logistics",
    "partner", "content", "analytics", "network", "storage", "tooling", "release",
    "observability",
)
_TEAM_SUFFIX = ("alpha", "bravo", "core", "edge", "prime", "one")

_IMAGE_ORGS = (
    ("registry.redhat.io", "ubi9"), ("registry.redhat.io", "openshift4"),
    ("quay.io", "acme"), ("quay.io", "acme-platform"), ("docker.io", "library"),
    ("registry.acme.internal", "apps"), ("registry.acme.internal", "base"),
    ("ghcr.io", "acme-oss"),
)
_IMAGE_NAMES = (
    "nginx", "nginx-ingress", "nginx-exporter", "httpd", "tomcat", "openjdk", "node",
    "python", "golang", "redis", "postgres", "mysql", "kafka", "zookeeper", "rabbitmq",
    "elasticsearch", "logstash", "fluentd", "prometheus", "grafana", "alertmanager",
    "envoy", "haproxy", "traefik", "consul", "vault", "keycloak", "minio", "spark",
    "flink", "airflow", "superset", "clickhouse", "cassandra", "mongodb", "memcached",
    "etcd", "jaeger", "otel-collector", "fluent-bit", "loki", "tempo", "thanos",
    "kube-rbac-proxy", "oauth-proxy", "cli", "tools", "runtime", "sdk", "base",
)
_SHARED_IMAGE_SUFFIX = (
    "istio-proxy", "fluent-bit", "kube-rbac-proxy", "oauth-proxy", "otel-agent", "vault-agent",
)


def _weighted(rng: random.Random, choices) -> str:
    """One value from a ((value, weight), ...) table."""
    values = [c[0] for c in choices]
    weights = [c[1] for c in choices]
    return rng.choices(values, weights=weights, k=1)[0]


def _spread(total: int, buckets: int, rng: random.Random, jitter: float = 0.6) -> list[int]:
    """Split `total` over `buckets` with some variation; sums exactly to total."""
    if buckets <= 0:
        return []
    if total <= 0:
        return [0] * buckets
    weights = [max(0.05, 1.0 + rng.uniform(-jitter, jitter)) for _ in range(buckets)]
    factor = total / sum(weights)
    counts = [int(w * factor) for w in weights]
    for i in range(total - sum(counts)):
        counts[i % buckets] += 1
    return counts


# --------------------------------------------------------------------------- #
# profile: the fleet pools plus the per-cluster sizes
# --------------------------------------------------------------------------- #
# Per-cluster inventory at --apps 250 --scale 1.0 (ADR-0003's production cluster).
BASE_COUNTS = {
    "configmaps": 5000, "secrets": 6000, "services": 2000, "routes": 800, "ingresses": 50,
    "networkpolicies": 500, "persistentvolumeclaims": 600, "persistentvolumes": 600,
    "resourcequotas": 300, "events": 200, "cronjobs": 200, "horizontalpodautoscalers": 300,
    "clusterserviceversions": 40, "subscriptions": 20,
}
# Kinds whose count follows the cluster's size rather than its application count.
BASE_FIXED = {"storageclasses": 10, "machineconfigpools": 3, "clusterrolebindings": 10}
BASE_WORKLOADS = 1700
BASE_NODES = 30
BASE_OPERATORS = len(OPERATORS)
BASE_POD_ISSUES = 50
BASE_PLATFORM_NS = 70
BASE_CERT_SECRETS = 300
BASE_APPS = 250


@dataclass
class Profile:
    """Sizes, plus the pools shared by every cluster in the fleet."""

    apps: int = BASE_APPS
    scale: float = 1.0
    images: tuple[str, ...] = ()
    shared_images: tuple[str, ...] = ()
    app_names: tuple[str, ...] = ()
    teams: tuple[str, ...] = ()
    platform_namespaces: tuple[str, ...] = ()
    manifest: object = None
    supported_floor: str = "4.15.0"
    thresholds: dict = field(default_factory=dict)

    # -- sizes ---------------------------------------------------------------
    @property
    def app_ratio(self) -> float:
        return (self.apps / BASE_APPS) * self.scale

    def count(self, key: str, floor: int = 1) -> int:
        if key in BASE_FIXED:
            return max(floor, round(BASE_FIXED[key] * self.scale))
        return max(floor, round(BASE_COUNTS[key] * self.app_ratio))

    @property
    def platform_ns(self) -> int:
        return max(1, min(len(self.platform_namespaces), round(BASE_PLATFORM_NS * self.scale)))

    @property
    def workloads(self) -> int:
        return max(1, round(BASE_WORKLOADS * self.app_ratio))

    @property
    def nodes(self) -> int:
        return max(3, round(BASE_NODES * self.scale))

    @property
    def operators(self) -> int:
        return max(5, min(BASE_OPERATORS, round(BASE_OPERATORS * self.scale)))

    @property
    def pod_issues(self) -> int:
        # A floor of one: a cluster with no problem pod at all is not a cluster
        # shape worth loading, and every section should be exercised.
        return max(1, round(BASE_POD_ISSUES * self.app_ratio))

    @property
    def cert_secrets(self) -> int:
        return max(1, round(BASE_CERT_SECRETS * self.app_ratio))


def build_profile(apps: int = BASE_APPS, scale: float = 1.0, seed: int = 1,
                  image_pool: int = 30000, app_pool: int = 3000,
                  team_pool: int = 150) -> Profile:
    """Build the fleet pools once; every cluster draws from them."""
    rng = random.Random(seed)

    apps_names = [f"{d}-{c}" for d in _APP_DOMAINS for c in _APP_COMPONENTS]
    rng.shuffle(apps_names)
    apps_names = apps_names[:app_pool] or apps_names

    teams = [f"{w}-{s}" for w in _TEAM_WORDS for s in _TEAM_SUFFIX]
    rng.shuffle(teams)
    teams = teams[:team_pool] or teams

    images = []
    tags = [f"{major}.{minor}.{patch}" for major in range(1, 6) for minor in range(0, 10)
            for patch in range(0, 6)]
    for registry, org in _IMAGE_ORGS:
        for base in _IMAGE_NAMES:
            for tag in tags:
                images.append(f"{registry}/{org}/{base}:{tag}")
    rng.shuffle(images)
    images = images[:image_pool] or images
    shared = tuple(f"registry.redhat.io/openshift4/{n}:v4.16.0" for n in _SHARED_IMAGE_SUFFIX)

    manifest = get_manifest()
    return Profile(
        apps=apps, scale=scale, images=tuple(images), shared_images=shared,
        app_names=tuple(apps_names), teams=tuple(teams),
        platform_namespaces=PLATFORM_NAMESPACES, manifest=manifest,
        supported_floor=os.environ.get("SUPPORTED_FLOOR", "4.15.0"),
        thresholds=manifest.describe()["thresholds"],
    )


# --------------------------------------------------------------------------- #
# document generation
# --------------------------------------------------------------------------- #
def _labels(rng: random.Random, app: str, extra: dict | None = None) -> dict:
    labels = {"app.kubernetes.io/name": app,
              "app.kubernetes.io/instance": f"{app}-{rng.choice(('blue', 'green', 'main'))}"}
    if rng.random() < 0.6:
        labels["app.kubernetes.io/managed-by"] = rng.choice(("argocd", "helm", "kustomize"))
    if extra:
        labels.update(extra)
    return labels


def _resource(key: str, ns_row: dict | None, name: str, summary: dict, status: str | None,
              labels: dict, created: datetime, expires: datetime | None = None) -> dict:
    spec = REGISTRY[key]
    return {
        "key": key, "kind": spec.kind, "api_group": spec.api_group_label,
        "namespace": ns_row["name"] if ns_row else None,
        "ns_class": ns_row["ns_class"] if ns_row else None,
        "name": name, "status": status, "expires_at": expires,
        "labels": labels, "summary": summary, "created_at": created,
    }


def _namespace_rows(rng: random.Random, profile: Profile, now: datetime) -> list[dict]:
    """Application namespaces drawn from the fleet application pool, plus the
    platform namespaces every OpenShift cluster has."""
    rows = []
    picked = rng.sample(range(len(profile.app_names)), min(profile.apps, len(profile.app_names)))
    for idx in picked:
        app = profile.app_names[idx]
        team = profile.teams[idx % len(profile.teams)]
        tier = _weighted(rng, TIERS)
        created = now - timedelta(days=rng.randint(30, 900), minutes=rng.randint(0, 1440))
        rows.append({
            "name": app, "ns_class": "application", "app_name": app, "team": team, "tier": tier,
            "labels": {"kubernetes.io/metadata.name": app, "odl.io/app": app, "odl.io/team": team,
                       "odl.io/tier": tier,
                       "pod-security.kubernetes.io/enforce": rng.choice(("baseline", "restricted")),
                       "app.kubernetes.io/part-of": app.split("-", 1)[0]},
            "annotations": {"openshift.io/requester": f"{team}-svc",
                            "openshift.io/display-name": app.replace("-", " ").title()},
            "requester": f"{team}-svc", "display_name": app.replace("-", " ").title(),
            "phase": "Active", "created_at": created,
        })
    for ns in profile.platform_namespaces[:profile.platform_ns]:
        rows.append({
            "name": ns, "ns_class": "platform", "app_name": ns, "team": "platform-core",
            "tier": "critical",
            "labels": {"kubernetes.io/metadata.name": ns,
                       "openshift.io/cluster-monitoring": "true"},
            "annotations": {"openshift.io/display-name": ns},
            "requester": None, "display_name": ns, "phase": "Active",
            "created_at": now - timedelta(days=rng.randint(200, 1200)),
        })
    return rows


def _node_rows(name: str, rng: random.Random, profile: Profile, now: datetime,
               version: str, zone_base: str) -> list[dict]:
    total = profile.nodes
    masters = 3 if total >= 6 else 1
    kubelet = f"v1.{27 + int(version.split('.')[1]) - 14}.{rng.randint(1, 12)}+{rng.randrange(16 ** 7):07x}"
    unready = 1 if rng.random() < 0.025 else 0
    pressured = 1 if rng.random() < 0.03 else 0
    rows = []
    for i in range(total):
        role = "master" if i < masters else ("infra" if i < masters + 2 else "worker")
        cores = 16.0 if role == "master" else (32.0 if role == "worker" else 24.0)
        mem = int((64 if role == "master" else 128) * GIB)
        alloc_cores = cores - 0.5
        alloc_mem = mem - 6 * GIB
        usage_fraction = min(0.94, max(0.08, rng.gauss(0.58, 0.13)))
        ready = not (unready and i == total - 1)
        rows.append({
            "name": f"{role}-{i:02d}.{name}.internal",
            "roles": [role] if role != "infra" else ["infra", "worker"],
            "ready": ready,
            "schedulable": rng.random() > 0.002,
            "conditions": {"MemoryPressure": bool(pressured and i == 0), "DiskPressure": False,
                           "PIDPressure": False, "NetworkUnavailable": False},
            "kubelet_version": kubelet,
            "os_image": "Red Hat Enterprise Linux CoreOS 416.94.202409121215-0",
            "kernel_version": "5.14.0-427.35.1.el9_4.x86_64",
            "container_runtime": f"cri-o://1.{rng.randint(27, 30)}.{rng.randint(0, 9)}",
            "architecture": "amd64",
            "instance_type": rng.choice(("m6i.4xlarge", "m6i.8xlarge", "r6i.4xlarge",
                                         "c6i.8xlarge")),
            "zone": f"{zone_base}{rng.choice('abc')}",
            "internal_ip": f"10.{rng.randint(0, 60)}.{rng.randint(0, 255)}.{rng.randint(4, 250)}",
            "cpu_capacity": cores, "cpu_allocatable": alloc_cores,
            "cpu_usage": round(alloc_cores * usage_fraction, 3),
            "memory_capacity": mem, "memory_allocatable": alloc_mem,
            "memory_usage": int(alloc_mem * min(0.95, usage_fraction + rng.uniform(-0.06, 0.1))),
            "ephemeral_storage_allocatable": 480 * GIB,
            "pods_capacity": 250, "pods_running": 0,
            "images_count": rng.randint(60, 220),
            "images_bytes": rng.randint(8, 60) * GIB,
            "taints": ([{"key": "node-role.kubernetes.io/master", "effect": "NoSchedule"}]
                       if role == "master" else
                       ([{"key": "node-role.kubernetes.io/infra", "effect": "NoSchedule"}]
                        if role == "infra" else [])),
            "created_at": now - timedelta(days=rng.randint(20, 700)),
        })
    return rows


def _operator_rows(rng: random.Random, profile: Profile, version: str,
                   upgrading: bool) -> list[dict]:
    degraded_one = rng.random() < 0.03
    rows = []
    names = OPERATORS[:profile.operators]
    degraded_idx = rng.randrange(len(names)) if degraded_one else -1
    for i, op in enumerate(names):
        degraded = i == degraded_idx
        progressing = upgrading and rng.random() < 0.35
        rows.append({
            "name": op, "version": version,
            "available": not degraded or rng.random() < 0.5,
            "progressing": progressing, "degraded": degraded,
            "critical": op in CRITICAL_OPERATORS,
            "message": ("DeploymentDegraded: 1 of 2 replicas unavailable" if degraded
                        else (f"Working towards {version}" if progressing else "")),
        })
    return rows


def _containers(rng: random.Random, ns_row: dict, profile: Profile,
                images: list[str]) -> tuple[list[dict], list[dict]]:
    """Scrubbed container specs (env names and references, never values) plus
    the configuration references they imply."""
    ns = ns_row["name"]
    containers, refs = [], []
    seen = set()

    def ref(kind, ref_name, via):
        if (kind, ref_name, via) not in seen:
            seen.add((kind, ref_name, via))
            refs.append({"kind": kind, "name": ref_name, "via": via})

    for i, image in enumerate(images):
        env = []
        for env_name in rng.sample(ENV_NAMES, rng.randint(3, 7)):
            entry = {"name": env_name}
            draw = rng.random()
            if draw < 0.12:
                entry["from"] = {"kind": "Secret", "name": f"{ns}-secret", "key": env_name.lower()}
                ref("Secret", f"{ns}-secret", "env")
            elif draw < 0.30:
                entry["from"] = {"kind": "ConfigMap", "name": f"{ns}-config",
                                 "key": env_name.lower()}
                ref("ConfigMap", f"{ns}-config", "env")
            elif draw < 0.45:
                entry["from"] = {"kind": "field", "path": "metadata.name"}
            else:
                entry["from"] = {"kind": "literal"}
            env.append(entry)
        env_from = []
        if rng.random() < 0.2:
            env_from.append({"kind": "ConfigMap", "name": f"{ns}-env"})
            ref("ConfigMap", f"{ns}-env", "envFrom")
        cpu = rng.choice((10, 25, 50, 50, 75, 150))
        mem = rng.choice((64, 128, 192, 256, 384, 512))
        containers.append({
            "name": ns_row["app_name"][:40] if i == 0 else f"sidecar-{i}",
            "image": image, "env": env, "env_from": env_from,
            "requests": {"cpu": f"{cpu}m", "memory": f"{mem}Mi"},
            "limits": {"cpu": f"{cpu * 4}m", "memory": f"{mem * 2}Mi"},
            "ports": [8080, 8443] if i == 0 else [15090],
        })
    if rng.random() < 0.30:
        ref("ConfigMap", f"{ns}-config", "volume")
    if rng.random() < 0.20:
        ref("Secret", f"{ns}-tls", "volume")
    if rng.random() < 0.15:
        ref("PersistentVolumeClaim", f"{ns}-data", "volume")
    if rng.random() < 0.40:
        ref("Secret", f"{ns}-pull-secret", "imagePullSecret")
    ref("ServiceAccount", f"{ns}-sa", "serviceAccount")
    return containers, refs


def _workload_rows(rng: random.Random, profile: Profile, ns_rows: list[dict], nodes: int,
                   now: datetime) -> tuple[list[dict], list[dict], list[dict]]:
    """Workloads plus the normalised image and configuration-reference edges."""
    pool = profile.images
    counts = _spread(profile.workloads, len(ns_rows), rng)
    workloads, image_rows, ref_rows = [], [], []
    for ns_row, count in zip(ns_rows, counts, strict=True):
        ns = ns_row["name"]
        # An application's images are stable across the clusters it runs on, so
        # blast radius fans out the way it does in a real fleet.
        # Stable across clusters: the same application pulls the same images
        # wherever it runs, which is what gives blast radius a realistic fan-out.
        seed = zlib.crc32(ns.encode()) % len(pool)
        for w in range(count):
            kind = rng.choices(("Deployment", "StatefulSet", "DaemonSet"),
                               weights=(0.88, 0.09, 0.03), k=1)[0]
            wl_name = f"{ns}-{rng.choice(('api', 'web', 'worker', 'job', 'sync', 'cache'))}-{w}"
            images = [pool[(seed + w * 7) % len(pool)]]
            if rng.random() < 0.2:
                images.append(rng.choice(profile.shared_images))
            # A DaemonSet runs one pod per node, which is where a real cluster's
            # pod count comes from as much as from replica counts.
            desired = nodes if kind == "DaemonSet" else rng.choice((1, 2, 2, 3, 3, 4, 4, 6))
            roll = rng.random()
            if roll < 0.02:
                ready, status = 0, "degraded"
            elif roll < 0.07:
                ready, status = max(0, desired - 1), "progressing"
            else:
                ready, status = desired, "healthy"
            containers, refs = _containers(rng, ns_row, profile, images)
            workloads.append({
                "namespace": ns, "ns_class": ns_row["ns_class"], "kind": kind, "name": wl_name,
                "replicas_desired": desired, "replicas_ready": ready,
                "replicas_available": ready, "replicas_updated": desired,
                "status": status, "containers": containers, "images": sorted(set(images)),
                "config_refs": refs, "service_account": f"{ns}-sa",
                "node_selector": ({"node-role.kubernetes.io/worker": ""}
                                  if rng.random() < 0.3 else {}),
                "strategy": "RollingUpdate",
                "labels": _labels(rng, ns_row["app_name"],
                                  {"odl.io/team": ns_row["team"] or "platform-core"}),
                "conditions": {"Available": status != "degraded", "Progressing": True},
                "created_at": now - timedelta(days=rng.randint(1, 400)),
            })
            for c in containers:
                image_rows.append({"namespace": ns, "workload_kind": kind,
                                   "workload_name": wl_name, "container": c["name"],
                                   **split_image(c["image"])})
            for r in refs:
                ref_rows.append({"namespace": ns, "workload_kind": kind,
                                 "workload_name": wl_name, "ref_kind": r["kind"],
                                 "ref_name": r["name"], "via": r["via"]})
    return workloads, image_rows, ref_rows


def _pod_issue_rows(rng: random.Random, profile: Profile, ns_rows: list[dict],
                    node_rows: list[dict], now: datetime) -> list[dict]:
    if not profile.pod_issues:
        return []
    app_ns = [n for n in ns_rows if n["ns_class"] == "application"] or ns_rows
    plat_ns = [n for n in ns_rows if n["ns_class"] == "platform"]
    # Application pods break on every cluster; a platform pod problem is rarer,
    # and it is the one that moves the cluster's health rollup.
    platform_share = 0.12 if rng.random() < 0.25 else 0.0
    rows = []
    for i in range(profile.pod_issues):
        ns_row = (rng.choice(plat_ns) if plat_ns and rng.random() < platform_share
                  else rng.choice(app_ns))
        reason = _weighted(rng, POD_ISSUE_REASONS)
        restarts = rng.randint(6, 240) if reason in ("CrashLoopBackOff", "HighRestarts",
                                                     "OOMKilled") else rng.randint(0, 3)
        rows.append({
            "namespace": ns_row["name"], "ns_class": ns_row["ns_class"],
            "name": f"{ns_row['name']}-{rng.choice(('api', 'web', 'worker'))}-"
                    f"{rng.randrange(16 ** 9):09x}-{rng.randrange(16 ** 5):05x}",
            "node": rng.choice(node_rows)["name"],
            "phase": "Pending" if reason in ("Pending", "Unschedulable") else "Running",
            "reason": reason,
            "message": {
                "CrashLoopBackOff": "back-off 5m0s restarting failed container=app",
                "ImagePullBackOff": "Back-off pulling image",
                "OOMKilled": "container app was OOM-killed",
                "Pending": "pending for 940s",
                "Unschedulable": "0/30 nodes are available: 30 Insufficient memory.",
                "HighRestarts": f"{restarts} restarts",
                "NotReady": "1/2 containers ready",
                "Evicted": "The node was low on resource: ephemeral-storage.",
                "Failed": "Error: ImagePullBackOff",
            }[reason],
            "restarts": restarts,
            "owner_kind": "Deployment", "owner_name": f"{ns_row['name']}-api-{i % 7}",
            "containers_ready": rng.choice(("0/1", "1/2", "0/2", "2/3")),
            "started_at": now - timedelta(minutes=rng.randint(5, 20000)),
        })
    return rows


def _cert_summary(rng: random.Random, name: str, expires: datetime,
                  keys: list[dict]) -> list[dict]:
    return [{
        "subject": f"CN={name}.apps.example.com,O=Acme",
        "issuer": rng.choice(("CN=acme-issuing-ca,O=Acme", "CN=openshift-service-serving-signer",
                              "CN=R11,O=Let's Encrypt,C=US")),
        "not_before": (expires - timedelta(days=rng.choice((90, 365, 730)))).isoformat(),
        "not_after": expires.isoformat(),
        "san_count": rng.randint(1, 6), "is_ca": False,
        "fingerprint_sha256": f"{rng.randrange(16 ** 16):016x}",
        "key": keys[0]["key"],
    }]


def _resource_rows(rng: random.Random, profile: Profile, ns_rows: list[dict],
                   now: datetime, apps_domain: str) -> tuple[list[dict], dict[str, Counter]]:
    """Every scrubbed inventory row, mirroring the parsers in `collector/parsers.py`."""
    rows: list[dict] = []
    ns_counts: dict[str, Counter] = {}
    plat_ns = [n for n in ns_rows if n["ns_class"] == "platform"] or ns_rows
    weights = [4.0 if n["ns_class"] == "application" else 1.6 for n in ns_rows]

    def pick(count: int):
        """`count` namespaces to hang rows off, application-heavy like a real cluster."""
        return rng.choices(ns_rows, weights=weights, k=count)

    def emit(key, ns_row, res_name, summary, status, labels, created, expires=None):
        rows.append(_resource(key, ns_row, res_name, summary, status, labels, created, expires))
        if ns_row is not None:
            ns_counts.setdefault(ns_row["name"], Counter())[key] += 1

    def created():
        return now - timedelta(days=rng.randint(1, 800), minutes=rng.randint(0, 1440))

    seq: Counter = Counter()

    def nth(ns_row, key: str) -> int:
        """0, 1, 2 ... per namespace and kind, so object names stay unique."""
        slot = (ns_row["name"] if ns_row else "", key)
        seq[slot] += 1
        return seq[slot] - 1

    # -- ConfigMaps -------------------------------------------------------------
    # OpenShift injects `kube-root-ca.crt` into every namespace, so every
    # namespace contributes one certificate-bearing ConfigMap; the rest are
    # ordinary application configuration with no certificate material.
    cm_total = profile.count("configmaps")
    root_cas = min(cm_total, len(ns_rows))
    for ns_row in ns_rows[:root_cas]:
        keys = [{"key": "ca.crt", "bytes": rng.randint(1100, 1400)}]
        expires = now + timedelta(days=rng.randint(400, 3600))
        emit("configmaps", ns_row, "kube-root-ca.crt",
             {"keys": keys, "total_bytes": keys[0]["bytes"], "key_count": 1,
              "certificates": _cert_summary(rng, ns_row["name"], expires, keys)},
             "valid", {}, created(), expires)
    for ns_row in pick(cm_total - root_cas):
        keys = [{"key": k, "bytes": rng.randint(60, 8000)} for k in
                rng.sample(("app.properties", "logback.xml", "nginx.conf", "settings.yaml",
                            "feature-flags.json", "messages.properties", "schema.sql",
                            "index.html"), rng.randint(1, 4))]
        summary = {"keys": keys, "total_bytes": sum(k["bytes"] for k in keys),
                   "key_count": len(keys)}
        expires = status = None
        if rng.random() < 0.01:       # an occasional trusted-CA bundle
            keys.append({"key": "ca-bundle.crt", "bytes": rng.randint(4000, 60000)})
            expires = now + timedelta(days=rng.randint(200, 2000))
            summary["certificates"] = _cert_summary(rng, ns_row["name"], expires, keys[-1:])
            status = "valid"
        emit("configmaps", ns_row, f"{ns_row['name']}-config-{nth(ns_row, 'cm')}", summary, status,
             _labels(rng, ns_row["app_name"]) if rng.random() < 0.5 else {}, created(), expires)

    # -- Secrets, of which ~300 carry a certificate ----------------------------
    secret_total = profile.count("secrets")
    cert_total = min(secret_total, profile.cert_secrets)
    # Most fleets rotate automatically; only some clusters carry a straggler.
    expiring_soon = rng.choice((0, 0, 0, 1, 1, 2, 3, 4)) if rng.random() < 0.25 else 0
    expired = 1 if rng.random() < 0.06 else 0
    for i, ns_row in enumerate(pick(secret_total)):
        is_cert = i < cert_total
        stype = ("kubernetes.io/tls" if is_cert else
                 rng.choice(("Opaque", "Opaque", "Opaque", "kubernetes.io/dockerconfigjson",
                             "kubernetes.io/service-account-token", "helm.sh/release.v1")))
        keys = ([{"key": "tls.crt", "bytes": rng.randint(1200, 5200)},
                 {"key": "tls.key", "bytes": rng.randint(1600, 3400)}] if is_cert else
                [{"key": k, "bytes": rng.randint(24, 2400)} for k in
                 rng.sample(("username", "password", "token", "url", "api-key", ".dockerconfigjson",
                             "release", "ca.crt"), rng.randint(1, 3))])
        summary = {"type": stype, "keys": keys, "total_bytes": sum(k["bytes"] for k in keys),
                   "key_count": len(keys)}
        expires = status = None
        if is_cert:
            if i < expired:
                expires = now - timedelta(days=rng.randint(1, 45))
                status = "expired"
            elif i < expired + expiring_soon:
                expires = now + timedelta(days=rng.randint(1, 29), hours=rng.randint(0, 23))
                status = "expiring"
            else:
                expires = now + timedelta(days=rng.randint(45, 760), hours=rng.randint(0, 23))
                status = "valid"
            summary["certificates"] = _cert_summary(rng, ns_row["name"], expires, keys)
        emit("secrets", ns_row,
             f"{ns_row['name']}-{'tls' if is_cert else 'secret'}-{nth(ns_row, 'secret')}",
             summary, status, _labels(rng, ns_row["app_name"]) if rng.random() < 0.4 else {},
             created(), expires)

    # -- Services ---------------------------------------------------------------
    for ns_row in pick(profile.count("services")):
        stype = rng.choices(("ClusterIP", "NodePort", "LoadBalancer", "ExternalName"),
                            weights=(0.88, 0.06, 0.05, 0.01), k=1)[0]
        ports = [{"port": p, "target": p, "protocol": "TCP",
                  "node_port": rng.randint(30000, 32767) if stype == "NodePort" else None}
                 for p in rng.sample((8080, 8443, 9090, 9100, 5432, 6379, 15090), rng.randint(1, 3))]
        emit("services", ns_row, f"{ns_row['name']}-svc-{nth(ns_row, 'svc')}", {
            "type": stype,
            "cluster_ip": f"172.30.{rng.randint(0, 255)}.{rng.randint(1, 254)}",
            "ports": ports,
            "selector": {"app.kubernetes.io/name": ns_row["app_name"]},
            "load_balancer": ([f"a{rng.randrange(16 ** 8):08x}.elb.amazonaws.com"]
                              if stype == "LoadBalancer" else []),
        }, stype.lower(), _labels(rng, ns_row["app_name"]), created())

    # -- Routes: a few percent are rejected --------------------------------------
    for i, ns_row in enumerate(pick(profile.count("routes"))):
        admitted = rng.random() > 0.025
        term = rng.choices(("edge", "reencrypt", "passthrough", None),
                           weights=(0.6, 0.2, 0.1, 0.1), k=1)[0]
        emit("routes", ns_row, f"{ns_row['name']}-route-{nth(ns_row, 'route')}", {
            "host": f"{ns_row['name']}-{i % 12}.{apps_domain}",
            "path": rng.choice((None, "/", "/api", "/health")),
            "service": f"{ns_row['name']}-svc-{i % 30}",
            "port": rng.choice(("8080-tcp", "https", "http")),
            "tls_termination": term,
            "insecure_policy": "Redirect" if term else None,
            "wildcard_policy": "None",
            "admitted": admitted,
            "routers": ["default"] if admitted else [],
        }, "admitted" if admitted else "rejected", _labels(rng, ns_row["app_name"]), created())

    # -- Ingresses ----------------------------------------------------------------
    for ns_row in pick(profile.count("ingresses")):
        host = f"{ns_row['name']}-ing.{apps_domain}"
        emit("ingresses", ns_row, f"{ns_row['name']}-ingress-{nth(ns_row, 'ing')}", {
            "class": rng.choice(("openshift-default", "nginx")), "hosts": [host],
            "tls_hosts": [host] if rng.random() < 0.7 else [], "load_balancer": [],
        }, None, _labels(rng, ns_row["app_name"]), created())

    # -- NetworkPolicies ----------------------------------------------------------
    for ns_row in pick(profile.count("networkpolicies")):
        emit("networkpolicies", ns_row, f"{ns_row['name']}-netpol-{nth(ns_row, 'np')}", {
            "pod_selector": {"matchLabels": {"app.kubernetes.io/name": ns_row["app_name"]}}
            if rng.random() < 0.6 else {},
            "policy_types": rng.choice((["Ingress"], ["Ingress", "Egress"], ["Egress"])),
            "ingress_rules": rng.randint(0, 4), "egress_rules": rng.randint(0, 3),
        }, None, {}, created())

    # -- PersistentVolumeClaims ----------------------------------------------------
    pvc_rows = []
    for i, ns_row in enumerate(pick(profile.count("persistentvolumeclaims"))):
        sc = rng.choice(STORAGE_CLASSES)[0]
        phase = rng.choices(("Bound", "Pending", "Lost"), weights=(0.96, 0.035, 0.005), k=1)[0]
        size = rng.choice((5, 10, 20, 50, 100, 200, 500)) * GIB
        slot = nth(ns_row, "pvc")
        pvc_name = f"{ns_row['name']}-data" if slot == 0 else f"{ns_row['name']}-data-{slot}"
        volume = f"pvc-{rng.randrange(16 ** 32):032x}" if phase == "Bound" else None
        pvc_rows.append((ns_row, pvc_name, volume, sc, size, phase))
        emit("persistentvolumeclaims", ns_row, pvc_name, {
            "storage_class": sc, "phase": phase,
            "access_modes": [rng.choice(("ReadWriteOnce", "ReadWriteMany"))],
            "volume_mode": "Filesystem", "volume": volume,
            "requested_bytes": size,
            "capacity_bytes": size if phase == "Bound" else None,
            "mounted_by": [f"{ns_row['name']}-api-{i % 4}-{rng.randrange(16 ** 5):05x}"]
            if phase == "Bound" else [],
        }, phase.lower(), _labels(rng, ns_row["app_name"]) if rng.random() < 0.3 else {}, created())

    # -- PersistentVolumes (cluster-scoped, mostly the bound claims above) ----------
    for i in range(profile.count("persistentvolumes")):
        if i < len(pvc_rows) and pvc_rows[i][2]:
            ns_row, pvc_name, volume, sc, size, _ = pvc_rows[i]
            claim = f"{ns_row['name']}/{pvc_name}"
            phase = "Bound"
        else:
            volume = f"pvc-{rng.randrange(16 ** 32):032x}"
            sc = rng.choice(STORAGE_CLASSES)[0]
            size = rng.choice((5, 10, 50, 100)) * GIB
            claim = None
            phase = rng.choice(("Available", "Released"))
        emit("persistentvolumes", None, volume, {
            "storage_class": sc, "phase": phase, "capacity_bytes": size,
            "access_modes": ["ReadWriteOnce"], "reclaim_policy": "Delete",
            "csi_driver": "ebs.csi.aws.com", "claim": claim,
        }, phase.lower(), {}, created())

    # -- StorageClasses --------------------------------------------------------------
    for sc_name, provisioner, default in STORAGE_CLASSES[:profile.count("storageclasses")]:
        emit("storageclasses", None, sc_name, {
            "provisioner": provisioner, "reclaim_policy": "Delete",
            "binding_mode": "WaitForFirstConsumer", "allow_expansion": True, "default": default,
        }, None, {}, created())

    # -- ResourceQuotas: a few percent are near or past their limit -------------------
    for ns_row in pick(profile.count("resourcequotas")):
        worst = 0.0
        quota_rows = []
        for res, hard in (("limits.cpu", f"{rng.choice((8, 16, 32, 64))}"),
                          ("limits.memory", f"{rng.choice((16, 32, 64, 128))}Gi"),
                          ("pods", f"{rng.choice((20, 50, 100))}")):
            pct = min(140.0, max(0.0, rng.gauss(52, 24)))
            worst = max(worst, pct)
            hard_value = float("".join(c for c in hard if c.isdigit()) or 1)
            used = hard_value * pct / 100.0
            unit = "Gi" if hard.endswith("Gi") else ""
            quota_rows.append({"resource": res, "hard": hard,
                               "used": f"{used:.1f}{unit}", "percent": round(pct, 1)})
        status = "exhausted" if worst >= 100 else ("warning" if worst >= 90 else "ok")
        emit("resourcequotas", ns_row, f"{ns_row['name']}-quota-{nth(ns_row, 'quota')}", {
            "resources": quota_rows, "max_percent": round(worst, 1),
        }, status, {}, created())

    # -- Events (the most recent warnings, limited by the manifest) -------------------
    for ns_row in pick(profile.count("events")):
        reason, etype = rng.choice(EVENT_REASONS)
        last = now - timedelta(minutes=rng.randint(0, 240))
        emit("events", ns_row, f"{ns_row['name']}.{rng.randrange(16 ** 14):014x}", {
            "reason": reason,
            "message": f"0/30 nodes are available: {rng.randint(1, 30)} Insufficient cpu."
            if reason == "FailedScheduling" else f"{reason} for container app",
            "type": etype, "count": rng.randint(1, 400),
            "involved": {"kind": "Pod", "name": f"{ns_row['name']}-api-{rng.randrange(16 ** 5):05x}",
                         "namespace": ns_row["name"]},
            "source": rng.choice(("kubelet", "default-scheduler", "replicaset-controller")),
            "first_at": (last - timedelta(minutes=rng.randint(1, 600))).isoformat(),
            "last_at": last.isoformat(),
        }, reason.lower(), {}, last)

    # -- CronJobs ----------------------------------------------------------------------
    for ns_row in pick(profile.count("cronjobs")):
        suspended = rng.random() < 0.12
        emit("cronjobs", ns_row, f"{ns_row['name']}-cron-{nth(ns_row, 'cron')}", {
            "schedule": rng.choice(("*/5 * * * *", "0 * * * *", "0 2 * * *", "*/15 * * * *")),
            "suspended": suspended, "concurrency_policy": "Forbid",
            "active": rng.choice((0, 0, 0, 1)),
            "last_schedule": (now - timedelta(minutes=rng.randint(1, 300))).isoformat(),
            "last_successful": (now - timedelta(minutes=rng.randint(5, 600))).isoformat(),
            "images": [rng.choice(profile.images)],
        }, "suspended" if suspended else "active", {}, created())

    # -- HorizontalPodAutoscalers --------------------------------------------------------
    for i, ns_row in enumerate(pick(profile.count("horizontalpodautoscalers"))):
        active = rng.random() > 0.08
        min_r = rng.choice((1, 2, 3))
        max_r = min_r + rng.choice((2, 4, 8, 16))
        emit("horizontalpodautoscalers", ns_row,
             f"{ns_row['name']}-hpa-{nth(ns_row, 'hpa')}", {
            "target": f"Deployment/{ns_row['name']}-api-{i % 4}",
            "min_replicas": min_r, "max_replicas": max_r,
            "current_replicas": rng.randint(min_r, max_r),
            "desired_replicas": rng.randint(min_r, max_r),
            "metrics": [{"resource": "cpu", "target_percent": 75, "target_value": None}],
            "scaling_active": active, "scaling_limited": rng.random() < 0.15,
        }, "ok" if active else "inactive", {}, created())

    # -- OLM: ClusterServiceVersions and Subscriptions ---------------------------------
    olm_ns = next((n for n in plat_ns if n["name"] == "openshift-operators"), plat_ns[0])
    bad_csv = rng.random() < 0.08
    for i in range(profile.count("clusterserviceversions")):
        package = OLM_PACKAGES[i % len(OLM_PACKAGES)]
        csv_version = f"{rng.randint(1, 6)}.{rng.randint(0, 14)}.{rng.randint(0, 9)}"
        phase = "Succeeded"
        if bad_csv and i == 0:
            phase = rng.choice(("Installing", "Failed", "Replacing"))
        emit("clusterserviceversions", olm_ns, f"{package}.v{csv_version}", {
            "package": package, "display_name": package.replace("-", " ").title(),
            "version": csv_version, "phase": phase,
            "reason": "InstallSucceeded" if phase == "Succeeded" else "InstallWaiting",
            "message": "install strategy completed with no errors" if phase == "Succeeded"
            else "waiting for install plan to complete",
            "provider": "Red Hat", "replaces": f"{package}.v{csv_version[:-1]}0",
        }, phase.lower(), {}, created())
    for i in range(profile.count("subscriptions")):
        package = OLM_PACKAGES[i % len(OLM_PACKAGES)]
        pending = rng.random() < 0.1
        installed = f"{package}.v{rng.randint(1, 6)}.{rng.randint(0, 9)}.0"
        emit("subscriptions", olm_ns, package, {
            "package": package, "channel": rng.choice(("stable", "latest", "fast")),
            "source": "redhat-operators", "approval": rng.choice(("Automatic", "Manual")),
            "installed_csv": installed,
            "current_csv": f"{package}.v9.0.0" if pending else installed,
            "state": "AtLatestKnown" if not pending else "UpgradePending",
            "upgrade_pending": pending,
        }, "upgrade-pending" if pending else "atlatestknown", {}, created())

    # -- MachineConfigPools --------------------------------------------------------------
    pools = ("master", "worker", "infra")
    degraded_mcp = rng.random() < 0.02
    for i in range(profile.count("machineconfigpools")):
        pool = pools[i % len(pools)]
        machines = 3 if pool == "master" else rng.randint(2, 27)
        status = "degraded" if (degraded_mcp and i == 1) else (
            "updating" if rng.random() < 0.05 else "updated")
        emit("machineconfigpools", None, pool, {
            "machine_count": machines,
            "ready": machines if status == "updated" else machines - 1,
            "updated": machines if status == "updated" else machines - 1,
            "unavailable": 0 if status == "updated" else 1,
            "degraded": 1 if status == "degraded" else 0, "paused": False,
            "current_config": f"rendered-{pool}-{rng.randrange(16 ** 16):032x}",
            "message": "" if status == "updated" else f"pool {pool} is {status}",
        }, status, {}, created())

    # -- ClusterRoleBindings to cluster-admin ----------------------------------------------
    for i in range(profile.count("clusterrolebindings")):
        emit("clusterrolebindings", None, f"cluster-admin-{i}", {
            "role": "cluster-admin",
            "subjects": [{"kind": rng.choice(("User", "Group", "ServiceAccount")),
                          "name": rng.choice(("sre-oncall", "platform-admins", "break-glass",
                                              f"{rng.choice(profile.teams)}-admins")),
                          "namespace": None}],
        }, "cluster-admin", {}, created())

    return rows, ns_counts


def generate_document(name: str, rng: random.Random, profile: Profile) -> dict:
    """One synthetic collector document, in the exact shape `assemble()` produces."""
    now = datetime.now(UTC)
    region, cloud = REGIONS[rng.randrange(len(REGIONS))]
    datacenter = f"{region}-dc{rng.randint(1, 3)}"
    environment = _weighted(rng, ENVIRONMENTS)
    version = _weighted(rng, VERSIONS)
    upgrading = rng.random() < 0.06
    major, minor, patch = (int(p) for p in version.split("."))
    desired = f"{major}.{minor}.{patch + 1}" if upgrading else version
    apps_domain = f"apps.{name}.example.com"

    ns_rows = _namespace_rows(rng, profile, now)
    node_rows = _node_rows(name, rng, profile, now, version, region)
    operator_rows = _operator_rows(rng, profile, version, upgrading)
    workloads, image_rows, ref_rows = _workload_rows(rng, profile, ns_rows, len(node_rows), now)
    pod_issues = _pod_issue_rows(rng, profile, ns_rows, node_rows, now)
    resources, ns_counts = _resource_rows(rng, profile, ns_rows, now, apps_domain)

    # --- namespace rollups, exactly as assemble() computes them ---------------
    by_ns: dict[str, list[dict]] = {}
    for w in workloads:
        by_ns.setdefault(w["namespace"], []).append(w)
    issues_by_ns = Counter(i["namespace"] for i in pod_issues)
    total_running = 0
    for ns in ns_rows:
        wls = by_ns.get(ns["name"], [])
        pods_total = sum(w["replicas_desired"] for w in wls)
        pods_running = sum(w["replicas_ready"] for w in wls)
        pods_failed = rng.randint(0, 2) if rng.random() < 0.1 else 0
        pods_pending = max(0, pods_total - pods_running - pods_failed)
        total_running += pods_running
        cpu_req = round(sum(_quantity_cores(c["requests"]["cpu"]) * w["replicas_desired"]
                            for w in wls for c in w["containers"]), 4)
        cpu_lim = round(cpu_req * 4, 4)
        mem_req = int(sum(_quantity_bytes(c["requests"]["memory"]) * w["replicas_desired"]
                          for w in wls for c in w["containers"]))
        images = sorted({i for w in wls for i in w["images"]})
        ns.update({
            "status": ("critical" if any(w["status"] == "degraded" for w in wls) else
                       ("warning" if issues_by_ns.get(ns["name"]) or
                        any(w["status"] == "progressing" for w in wls) else "healthy")),
            "workloads_total": len(wls),
            "replicas_desired": sum(w["replicas_desired"] for w in wls),
            "replicas_ready": sum(w["replicas_ready"] for w in wls),
            "pods_total": pods_total + pods_failed, "pods_running": pods_running,
            "pods_pending": pods_pending, "pods_failed": pods_failed,
            "pods_succeeded": rng.randint(0, 4),
            "restarts_total": rng.randint(0, 60),
            "pod_issues": issues_by_ns.get(ns["name"], 0),
            "cpu_requests": cpu_req, "cpu_limits": cpu_lim,
            "cpu_usage": round(cpu_req * rng.uniform(0.25, 0.9), 4),
            "memory_requests": mem_req, "memory_limits": mem_req * 2,
            "memory_usage": int(mem_req * rng.uniform(0.35, 0.92)),
            "resource_counts": dict(ns_counts.get(ns["name"], {})),
            "images": images,
        })
    ns_rows.sort(key=lambda n: n["name"])

    # --- pods per node --------------------------------------------------------
    per_node = _spread(total_running, len(node_rows), rng)
    for node, count in zip(node_rows, per_node, strict=True):
        node["pods_running"] = count

    def total(rows, key, cast=float):
        values = [r.get(key) for r in rows if r.get(key) is not None]
        return cast(sum(values)) if values else None

    capacity = {
        "cpu_capacity": total(node_rows, "cpu_capacity"),
        "cpu_allocatable": total(node_rows, "cpu_allocatable"),
        "cpu_requests": total(ns_rows, "cpu_requests"),
        "cpu_limits": total(ns_rows, "cpu_limits"),
        "cpu_usage": total(node_rows, "cpu_usage"),
        "memory_capacity": total(node_rows, "memory_capacity", int),
        "memory_allocatable": total(node_rows, "memory_allocatable", int),
        "memory_requests": total(ns_rows, "memory_requests", int),
        "memory_limits": total(ns_rows, "memory_limits", int),
        "memory_usage": total(node_rows, "memory_usage", int),
        "pods_capacity": total(node_rows, "pods_capacity", int),
        "pods_total": sum(n["pods_total"] for n in ns_rows),
        "pods_running": sum(n["pods_running"] for n in ns_rows),
        "metrics_available": True,
    }

    resource_status = {}
    counted = Counter(r["key"] for r in resources)
    live = {"clusteroperators": len(operator_rows), "nodes": len(node_rows),
            "namespaces": len(ns_rows), "pods": capacity["pods_total"],
            "deployments": sum(1 for w in workloads if w["kind"] == "Deployment"),
            "statefulsets": sum(1 for w in workloads if w["kind"] == "StatefulSet"),
            "daemonsets": sum(1 for w in workloads if w["kind"] == "DaemonSet"),
            "node_metrics": len(node_rows), "pod_metrics": capacity["pods_total"]}
    for key in REGISTRY:
        if not profile.manifest.enabled(key):
            resource_status[key] = {"status": "disabled", "count": 0, "duration_ms": 0,
                                    "error": None}
            continue
        count = counted.get(key, live.get(key, 1))
        resource_status[key] = {"status": "collected", "count": count,
                                "duration_ms": rng.randint(8, 900), "error": None}

    app_ns = sum(1 for n in ns_rows if n["ns_class"] == "application")
    doc = {
        "name": name, "region": region, "datacenter": datacenter, "environment": environment,
        "cloud": cloud, "vendor": "OpenShift", "label_version": version,
        "cluster_id": f"{rng.randrange(16 ** 8):08x}-{rng.randrange(16 ** 4):04x}-"
                      f"{rng.randrange(16 ** 4):04x}-{rng.randrange(16 ** 12):012x}",
        "kube_version": f"v1.{27 + minor - 14}.{rng.randint(1, 12)}",
        "managed_available": rng.random() > 0.01,
        "reachable": True, "error": None, "resource_status": resource_status,
        "version": version, "desired_version": desired,
        "channel": f"stable-{major}.{minor}",
        "upgrading": upgrading, "upgrade_percent": rng.randint(5, 95) if upgrading else 0,
        "cv_available": True, "cv_failing": rng.random() < 0.01,
        "available_updates": [f"{major}.{minor}.{patch + i}" for i in range(1, 4)]
        if not upgrading and rng.random() < 0.8 else [],
        "platform": {"aws": "AWS", "azure": "Azure", "gcp": "GCP",
                     "vsphere": "VSphere"}.get(cloud, "AWS"),
        "infrastructure_name": f"{name}-{rng.randrange(16 ** 5):05x}",
        "infra_region": region,
        "api_url": f"https://api.{name}.example.com:6443",
        "control_plane_topology": "HighlyAvailable",
        "infrastructure_topology": "HighlyAvailable",
        "network_type": rng.choice(("OVNKubernetes", "OVNKubernetes", "OpenShiftSDN")),
        "cluster_network": ["10.128.0.0/14"], "service_network": ["172.30.0.0/16"],
        "apps_domain": apps_domain,
        "operators": operator_rows,
        "nodes": node_rows, "nodes_total": len(node_rows),
        "nodes_ready": sum(1 for n in node_rows if n["ready"]),
        "resources": resources,
        "namespaces": ns_rows,
        "workloads": workloads, "workload_images": image_rows, "workload_refs": ref_rows,
        "pod_issues": pod_issues,
        "capacity": capacity,
        "namespaces_application": app_ns,
        "namespaces_platform": len(ns_rows) - app_ns,
        "workloads_total": len(workloads),
        "pod_issues_total": len(pod_issues),
        "certs_expiring_total": sum(1 for r in resources
                                    if r["key"] in ("secrets", "configmaps")
                                    and r["status"] in ("expiring", "expired")),
        "collect_ms": rng.randint(2500, 24000),
    }
    return doc


def _quantity_cores(value: str) -> float:
    return int(value[:-1]) / 1000.0 if value.endswith("m") else float(value)


def _quantity_bytes(value: str) -> int:
    if value.endswith("Mi"):
        return int(value[:-2]) * 1024 * 1024
    if value.endswith("Gi"):
        return int(value[:-2]) * GIB
    return int(value)


# --------------------------------------------------------------------------- #
# the load
# --------------------------------------------------------------------------- #
def cluster_names(count: int) -> list[str]:
    """Fleet-wide cluster names; short enough to keep index members compact."""
    return [f"ocp-{i // 100:02d}-{i % 100:02d}" for i in range(count)]


@dataclass
class LoadStats:
    clusters: int = 0
    generate_seconds: float = 0.0
    persist_seconds: float = 0.0
    wall_seconds: float = 0.0
    compressed_bytes: int = 0
    raw_json_bytes: int = 0
    rows: int = 0
    statuses: Counter = field(default_factory=Counter)
    sample: dict = field(default_factory=dict)


def _section_sizes(client, store: RedisStore, name: str) -> dict[str, int]:
    pipe = client.pipeline(transaction=False)
    for section in SECTIONS:
        pipe.strlen(store.keys.section(name, section))
    return dict(zip(SECTIONS, pipe.execute(), strict=True))


def run_load(store: RedisStore, client, profile: Profile, names: list[str], hubs: int,
             seed: int, workers: int, progress_every: int = 25) -> LoadStats:
    """Generate, health-check and persist every cluster, measuring as we go."""
    stats = LoadStats(clusters=len(names))
    lock = threading.Lock()
    hub_names = [f"hub-{i:02d}" for i in range(max(1, hubs))]
    started = time.perf_counter()
    run_id = store.begin_run("synthetic")
    counted = {"done": 0}

    def one(index: int, name: str) -> None:
        rng = random.Random(f"{seed}:{name}")
        t0 = time.perf_counter()
        doc = generate_document(name, rng, profile)
        checks, overall, score, counts = run_health_checks(
            doc, profile.supported_floor, profile.thresholds)
        t1 = time.perf_counter()
        hub = hub_names[index % len(hub_names)]
        store.persist_cluster(hub, doc, checks, overall, score, counts)
        t2 = time.perf_counter()
        sizes = _section_sizes(client, store, name)
        rows = sum(len(doc.get(s) or []) for s in
                   ("operators", "nodes", "namespaces", "workloads", "workload_images",
                    "workload_refs", "pod_issues", "resources")) + len(checks) + \
            len(doc["resource_status"])
        raw = len(json.dumps(doc, default=str, separators=(",", ":")))
        with lock:
            stats.generate_seconds += t1 - t0
            stats.persist_seconds += t2 - t1
            stats.compressed_bytes += sum(sizes.values())
            stats.raw_json_bytes += raw
            stats.rows += rows
            stats.statuses[overall] += 1
            counted["done"] += 1
            done = counted["done"]
            if not stats.sample:
                stats.sample = {"name": name, "sections": sizes, "raw_json_bytes": raw,
                                "rows": rows,
                                "namespaces": len(doc["namespaces"]),
                                "resources": len(doc["resources"]),
                                "workloads": len(doc["workloads"])}
        if progress_every and done % progress_every == 0:
            elapsed = time.perf_counter() - started
            print(f"  {done}/{len(names)} clusters  {done / elapsed:.2f} clusters/s",
                  file=sys.stderr, flush=True)

    if workers <= 1:
        for i, name in enumerate(names):
            one(i, name)
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(one, i, name) for i, name in enumerate(names)]
            for future in concurrent.futures.as_completed(futures):
                future.result()

    for i, hub in enumerate(hub_names):
        store.upsert_hub(hub, region=REGIONS[i % len(REGIONS)][0],
                         datacenter=f"{REGIONS[i % len(REGIONS)][0]}-dc1",
                         managed_count=len(names) // len(hub_names),
                         reachable=True, last_synced=datetime.now(UTC), last_error=None)
    store.finalize_sweep()
    store.finish_run(run_id, hubs_total=len(hub_names), clusters_total=len(names),
                     clusters_ok=len(names), clusters_failed=0,
                     duration_ms=int((time.perf_counter() - started) * 1000))
    stats.wall_seconds = time.perf_counter() - started
    return stats


# --------------------------------------------------------------------------- #
# measurement
# --------------------------------------------------------------------------- #
def _pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(q * len(ordered)) - 1))
    return ordered[index]


def _time_calls(label: str, call, iterations: int, budget: float = 60.0) -> dict:
    """Run `call` up to `iterations` times, stopping at the time budget."""
    samples, note, rows = [], None, None
    started = time.perf_counter()
    for _ in range(iterations):
        t0 = time.perf_counter()
        result = call()
        samples.append((time.perf_counter() - t0) * 1000.0)
        if rows is None and isinstance(result, list | dict):
            rows = len(result)
        if time.perf_counter() - started > budget:
            note = f"stopped after {len(samples)} iterations (>{budget:.0f}s budget)"
            break
    return {"label": label, "iterations": len(samples), "rows": rows, "note": note,
            "p50": _pct(samples, 0.5), "p95": _pct(samples, 0.95)}


# One SCAN MATCH pass per class; `{` and `}` are literal in a Redis glob.
KEY_CLASS_PATTERNS = (
    ("per-cluster sections", "{c:*}:sec:*"),
    ("per-cluster summaries", "{c:*}:summary"),
    ("per-cluster snapshots", "{c:*}:snapshots"),
    ("per-cluster ledgers", "{c:*}:ledger"),
    ("fleet resource hashes", "{fleet}:res:*"),
    ("config reference sets", "{fleet}:idx:ref:*"),
    ("image usage sets", "{fleet}:idx:image:*"),
    ("namespace index", "{fleet}:ns*"),
)
SAMPLE_CAP = 20000


def _memory_usage(client, key) -> int:
    """`MEMORY USAGE`, or 0 where the server does not implement it (fakeredis)."""
    try:
        return client.memory_usage(key) or 0
    except redis.RedisError:
        return 0


def _memory_of(client, keys: list[bytes]) -> int:
    total = 0
    for start in range(0, len(keys), 500):
        pipe = client.pipeline(transaction=False)
        for key in keys[start:start + 500]:
            pipe.memory_usage(key)
        try:
            results = pipe.execute(raise_on_error=False)
        except redis.RedisError:
            return 0
        total += sum(v for v in results if isinstance(v, int))
    return total


def _scan_class(client, pattern: str) -> tuple[int, list[bytes]]:
    """Count every key matching `pattern`, keeping up to SAMPLE_CAP of them."""
    cursor, count, sampled = 0, 0, []
    while True:
        cursor, batch = client.scan(cursor, match=pattern, count=1000)
        count += len(batch)
        if len(sampled) < SAMPLE_CAP:
            sampled.extend(batch[:SAMPLE_CAP - len(sampled)])
        if cursor == 0:
            return count, sampled


def memory_by_key_class(client, prefix: str) -> list[dict]:
    """Memory per key class, sampled with SCAN + MEMORY USAGE and extrapolated."""
    patterns = [(label, f"{prefix}:{suffix}") for label, suffix in KEY_CLASS_PATTERNS]
    out = []
    for label, pattern in patterns:
        count, sampled = _scan_class(client, pattern)
        if not count:
            out.append({"class": label, "pattern": pattern, "keys": 0, "bytes": 0,
                        "sampled": 0})
            continue
        measured = _memory_of(client, sampled)
        total = int(measured * (count / len(sampled))) if sampled else 0
        out.append({"class": label, "pattern": pattern, "keys": count, "bytes": total,
                    "sampled": len(sampled)})

    # Everything else: one pass, keeping only what none of the patterns match.
    globs = [p for _, p in patterns]
    cursor, count, sampled = 0, 0, []
    while True:
        cursor, batch = client.scan(cursor, count=1000)
        for key in batch:
            text = key.decode()
            if any(fnmatch.fnmatchcase(text, glob) for glob in globs):
                continue
            count += 1
            if len(sampled) < SAMPLE_CAP:
                sampled.append(key)
        if cursor == 0:
            break
    measured = _memory_of(client, sampled)
    total = int(measured * (count / len(sampled))) if sampled else 0
    out.append({"class": "everything else", "pattern": "(no class pattern matched)",
                "keys": count, "bytes": total, "sampled": len(sampled)})
    return out


def big_hashes(client, prefix: str) -> list[dict]:
    fleet = f"{prefix}:{{fleet}}"
    keys = [f"{fleet}:ns", f"{fleet}:res:routes", f"{fleet}:res:persistentvolumeclaims",
            f"{fleet}:res:events", f"{fleet}:certs", f"{fleet}:idx:images", f"{fleet}:nodes"]
    out = []
    for key in keys:
        try:
            length = client.hlen(key)
        except redis.ResponseError:
            length = None
        out.append({"key": key, "entries": length, "bytes": _memory_usage(client, key)})
    return out


def sample_cluster_keys(client, store: RedisStore, name: str) -> dict:
    summary_bytes = _memory_usage(client, store.keys.summary(name))
    sections = {}
    for section in SECTIONS:
        key = store.keys.section(name, section)
        sections[section] = {"compressed": client.strlen(key),
                             "memory": _memory_usage(client, key)}
    snapshots = _memory_usage(client, store.keys.snapshots(name))
    ledger = _memory_usage(client, store.keys.ledger(name))
    return {"name": name, "summary_bytes": summary_bytes, "sections": sections,
            "snapshots_bytes": snapshots, "ledger_bytes": ledger}


def read_latencies(store: RedisStore, iterations: int, budget: float) -> list[dict]:
    """Time the store calls the API read paths are built on."""
    names = store.cluster_names()
    if not names:
        return []
    sample = names[len(names) // 2]
    summary = store.get_cluster(sample)
    region = summary.get("region") if summary else None
    ns_rows = store.namespaces(clusters=[sample])
    team = next((n.get("team") for n in ns_rows if n.get("team")), None)
    horizon = (datetime.now(UTC) + timedelta(days=30)).timestamp()
    hits = store.images("nginx")[:5]

    calls = [
        ("clusters() - every summary", lambda: store.clusters()),
        (f"clusters(region={region!r})", lambda: store.clusters(region=region)),
        ("get_cluster + sections(4 sections)",
         lambda: (store.get_cluster(sample),
                  store.sections(sample, ["operators", "nodes", "namespaces", "health_checks"]))),
        ("namespaces(ns_class='application')",
         lambda: store.namespaces(ns_class="application")),
        (f"namespaces(team={team!r})", lambda: store.namespaces(team=team)),
        ("top_namespaces('cpu', 10)", lambda: store.top_namespaces("cpu", 10)),
        ("certificates(before=now+30d)", lambda: store.certificates(before=horizon)),
        ("images('nginx') + image_usages x5",
         lambda: (store.images("nginx"), [store.image_usages(i) for i in hits])),
        ("operator_index('ingress')", lambda: store.operator_index("ingress")),
        ("fleet_resources('routes', status='rejected')",
         lambda: store.fleet_resources("routes", status="rejected")),
        ("fleet_resource_count('routes')", lambda: store.fleet_resource_count("routes")),
        ("pod_issue_counts()", lambda: store.pod_issue_counts()),
    ]
    out = []
    for label, call in calls:
        print(f"  timing {label}", file=sys.stderr, flush=True)
        out.append(_time_calls(label, call, iterations, budget))
    return out


HTTP_ENDPOINTS = (
    "/api/health/overview", "/api/clusters", "/api/clusters?region={region}",
    "/api/clusters/{cluster}", "/api/applications", "/api/blast-radius?image=nginx",
    "/api/insights/summary", "/api/insights/certificates", "/api/versions/operators",
)


def _http_get(url: str, timeout: float = 120.0) -> tuple[int, int]:
    with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310
        body = response.read()
    return response.status, len(body)


def http_latencies(base: str, store: RedisStore, iterations: int, budget: float) -> dict:
    """Time the HTTP endpoints, but only against an API serving the Redis we loaded."""
    try:
        _http_get(f"{base}/healthz", timeout=3)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return {"available": False, "reason": f"{base}/healthz is not answering ({exc})"}
    loaded = len(store.cluster_names())
    try:
        with urllib.request.urlopen(f"{base}/api/clusters", timeout=120) as response:  # noqa: S310
            payload = json.loads(response.read())
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as exc:
        return {"available": False, "reason": f"{base}/api/clusters failed ({exc})"}
    served = len(payload if isinstance(payload, list) else payload.get("clusters") or [])
    if served != loaded:
        return {"available": False,
                "reason": f"the API at {base} serves {served} clusters, the load Redis holds "
                          f"{loaded}: it is pointed at a different Redis, so it was left alone"}
    names = store.cluster_names()
    cluster = names[len(names) // 2]
    summary = store.get_cluster(cluster)
    region = (summary or {}).get("region") or ""
    rows = []
    for path in HTTP_ENDPOINTS:
        url = base + path.format(region=region, cluster=cluster)
        sizes = []

        def call(url=url, sizes=sizes):
            _status, size = _http_get(url)
            sizes.append(size)
            return None

        row = _time_calls(path, call, iterations, budget)
        row["bytes"] = max(sizes) if sizes else 0
        rows.append(row)
    return {"available": True, "base": base, "rows": rows}


# --------------------------------------------------------------------------- #
# report
# --------------------------------------------------------------------------- #
def _mb(value: float) -> str:
    return f"{value / MIB:,.1f} MB"


def _gb(value: float) -> str:
    return f"{value / GIB:,.2f} GB"


def gather_facts(store: RedisStore, client, profile: Profile, args, stats: LoadStats) -> dict:
    """Everything the report prints, measured after the load."""
    facts = {"args": vars(args), "stats": stats, "generated_at": datetime.now(UTC)}
    try:
        info = client.info("memory")
    except redis.RedisError:
        info = {}
    facts["info"] = {k: info.get(k) for k in
                     ("used_memory", "used_memory_human", "used_memory_rss_human",
                      "used_memory_rss", "mem_fragmentation_ratio", "maxmemory_policy")}
    try:
        facts["dbsize"] = client.dbsize()
    except redis.RedisError:
        facts["dbsize"] = None
    names = store.cluster_names()
    facts["cluster_count"] = len(names)
    sample = stats.sample.get("name") or (names[0] if names else None)
    facts["sample"] = sample_cluster_keys(client, store, sample) if sample else {}
    facts["sample_doc"] = stats.sample
    try:
        facts["hashes"] = big_hashes(client, store.keys.prefix)
    except redis.RedisError as exc:
        facts["hashes"] = []
        facts["hashes_error"] = str(exc)
    try:
        facts["classes"] = memory_by_key_class(client, store.keys.prefix)
    except redis.RedisError as exc:
        facts["classes"] = []
        facts["classes_error"] = str(exc)
    return facts


def render_report(facts: dict) -> str:
    stats: LoadStats = facts["stats"]
    args = facts["args"]
    info = facts.get("info") or {}
    out: list[str] = []
    add = out.append

    add("# Synthetic load: the Redis store at "
        f"{stats.clusters} clusters")
    add("")
    add(f"- Generated: {facts['generated_at'].isoformat(timespec='seconds')}")
    add(f"- Profile: `--apps {args.get('apps')} --scale {args.get('scale')} "
        f"--clusters {args.get('clusters')} --hubs {args.get('hubs')} "
        f"--workers {args.get('workers')} --seed {args.get('seed')}`")
    add(f"- Redis: `{args.get('redis_url')}`, maxmemory-policy "
        f"`{info.get('maxmemory_policy')}`")
    add("")

    add("## Load")
    add("")
    add("| Measure | Value |")
    add("|---|---|")
    add(f"| Documents generated | {stats.clusters:,} |")
    add(f"| Rows generated | {stats.rows:,} |")
    add(f"| Generation CPU time | {stats.generate_seconds:,.1f} s "
        f"({stats.generate_seconds / max(1, stats.clusters):.2f} s per cluster) |")
    add(f"| Persist CPU time | {stats.persist_seconds:,.1f} s "
        f"({stats.persist_seconds / max(1, stats.clusters):.2f} s per cluster) |")
    add(f"| Wall time | {stats.wall_seconds:,.1f} s |")
    if stats.wall_seconds:
        add(f"| Throughput | {stats.clusters / stats.wall_seconds:.2f} clusters/s |")
        add(f"| Compressed section throughput | "
            f"{stats.compressed_bytes / stats.wall_seconds / MIB:.1f} MB/s |")
    add(f"| Compressed sections written | {_gb(stats.compressed_bytes)} |")
    add(f"| Raw document JSON | {_gb(stats.raw_json_bytes)} |")
    if stats.compressed_bytes:
        add(f"| Compression ratio (whole fleet) | "
            f"{stats.raw_json_bytes / stats.compressed_bytes:.1f}x |")
    add("")
    if stats.statuses:
        add("Health rollup of the generated fleet: "
            + ", ".join(f"{k} {v}" for k, v in sorted(stats.statuses.items())) + ".")
        add("")

    add("## Redis memory")
    add("")
    add("| Measure | Value |")
    add("|---|---|")
    add(f"| `used_memory_human` | {info.get('used_memory_human')} |")
    add(f"| `used_memory_rss_human` | {info.get('used_memory_rss_human')} |")
    add(f"| `mem_fragmentation_ratio` | {info.get('mem_fragmentation_ratio')} |")
    add(f"| `DBSIZE` | {facts.get('dbsize'):,} keys |" if isinstance(facts.get("dbsize"), int)
        else f"| `DBSIZE` | {facts.get('dbsize')} |")
    add(f"| Clusters in `{{fleet}}:clusters` | {facts.get('cluster_count'):,} |")
    add("")

    classes = facts.get("classes") or []
    if classes:
        total = sum(c["bytes"] for c in classes) or 1
        add("### Memory by key class")
        add("")
        add("Each class is one `SCAN ... MATCH` pass; `MEMORY USAGE` is summed over the "
            f"sampled keys (up to {SAMPLE_CAP:,} per class) and extrapolated by key count.")
        add("")
        add("| Key class | Pattern | Keys | Sampled | Memory | Share |")
        add("|---|---|---:|---:|---:|---:|")
        for row in sorted(classes, key=lambda c: -c["bytes"]):
            add(f"| {row['class']} | `{row['pattern']}` | {row['keys']:,} | "
                f"{row['sampled']:,} | {_mb(row['bytes'])} | "
                f"{100.0 * row['bytes'] / total:.1f}% |")
        add(f"| **total** | | {sum(c['keys'] for c in classes):,} | | "
            f"**{_gb(total)}** | 100% |")
        add("")

    sample = facts.get("sample") or {}
    doc = facts.get("sample_doc") or {}
    if sample:
        add(f"### One cluster (`{sample['name']}`)")
        add("")
        if doc:
            add(f"{doc.get('namespaces', 0):,} namespaces, {doc.get('workloads', 0):,} workloads, "
                f"{doc.get('resources', 0):,} inventory objects, {doc.get('rows', 0):,} rows.")
            add("")
        add("| Key | Compressed bytes | `MEMORY USAGE` |")
        add("|---|---:|---:|")
        for section, sizes in sample["sections"].items():
            add(f"| `sec:{section}` | {sizes['compressed']:,} | {sizes['memory']:,} |")
        add(f"| `summary` | | {sample['summary_bytes']:,} |")
        add(f"| `snapshots` | | {sample['snapshots_bytes']:,} |")
        add(f"| `ledger` | | {sample['ledger_bytes']:,} |")
        compressed = sum(s["compressed"] for s in sample["sections"].values())
        memory = (sum(s["memory"] for s in sample["sections"].values())
                  + sample["summary_bytes"] + sample["snapshots_bytes"] + sample["ledger_bytes"])
        add(f"| **total** | **{compressed:,}** | **{memory:,}** |")
        add("")
        raw = doc.get("raw_json_bytes") or 0
        if raw and compressed:
            add(f"Raw document JSON: {raw:,} bytes; compressed sections: {compressed:,} bytes; "
                f"compression ratio **{raw / compressed:.1f}x**.")
            add("")

    hashes = facts.get("hashes") or []
    if hashes:
        add("### Largest fleet hashes")
        add("")
        add("| Key | `HLEN` | `MEMORY USAGE` |")
        add("|---|---:|---:|")
        for row in sorted(hashes, key=lambda h: -(h["bytes"] or 0)):
            entries = f"{row['entries']:,}" if isinstance(row["entries"], int) else "-"
            add(f"| `{row['key']}` | {entries} | {_mb(row['bytes'])} |")
        add("")

    latencies = facts.get("latencies") or []
    if latencies:
        add("## Read latency (store level)")
        add("")
        add("Every call goes through `RedisStore` against the loaded Redis, timed in process "
            "with no HTTP layer.")
        add("")
        add("| Store call | Rows | Iterations | p50 (ms) | p95 (ms) |")
        add("|---|---:|---:|---:|---:|")
        for row in latencies:
            rows = f"{row['rows']:,}" if isinstance(row["rows"], int) else "-"
            add(f"| `{row['label']}` | {rows} | {row['iterations']} | "
                f"{row['p50']:.1f} | {row['p95']:.1f} |")
        add("")
        notes = [r for r in latencies if r.get("note")]
        for row in notes:
            add(f"- `{row['label']}`: {row['note']}")
        if notes:
            add("")

    http = facts.get("http") or {}
    add("## Read latency (HTTP)")
    add("")
    if not http.get("available"):
        add(f"Not measured: {http.get('reason', 'no API stack was checked')}.")
        add("")
    else:
        add(f"Against `{http['base']}`.")
        add("")
        add("| Endpoint | Payload | Iterations | p50 (ms) | p95 (ms) |")
        add("|---|---:|---:|---:|---:|")
        for row in http["rows"]:
            add(f"| `{row['label']}` | {_mb(row.get('bytes', 0))} | {row['iterations']} | "
                f"{row['p50']:.1f} | {row['p95']:.1f} |")
        add("")
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--clusters", type=int, default=900, help="clusters to generate")
    p.add_argument("--apps", type=int, default=BASE_APPS,
                   help="application namespaces per cluster")
    p.add_argument("--scale", type=float, default=1.0,
                   help="multiplier for the per-cluster inventory counts")
    p.add_argument("--hubs", type=int, default=12, help="hubs the clusters are spread over")
    p.add_argument("--workers", type=int, default=4, help="persist threads")
    p.add_argument("--seed", type=int, default=1, help="random seed")
    p.add_argument("--redis-url", default="redis://localhost:16379/0")
    p.add_argument("--prefix", default="odl", help="key prefix")
    p.add_argument("--report", default=None, help="write the Markdown report here")
    p.add_argument("--flush", action="store_true", help="FLUSHDB before loading")
    p.add_argument("--latency-iters", type=int, default=20)
    p.add_argument("--latency-budget", type=float, default=60.0,
                   help="seconds per measured call before stopping early")
    p.add_argument("--api-base", default="http://localhost:18001",
                   help="API stack to time, if it happens to serve the loaded Redis")
    p.add_argument("--no-http", action="store_true", help="skip the HTTP measurements")
    p.add_argument("--image-pool", type=int, default=30000)
    p.add_argument("--app-pool", type=int, default=3000)
    p.add_argument("--team-pool", type=int, default=150)
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    client = redis.Redis.from_url(args.redis_url, decode_responses=False)
    client.ping()
    if args.flush:
        client.flushdb()
    store = RedisStore(client, prefix=args.prefix, ttl_seconds=0, snapshot_retention=500)

    print(f"building the fleet pools (seed {args.seed})", file=sys.stderr)
    profile = build_profile(apps=args.apps, scale=args.scale, seed=args.seed,
                            image_pool=args.image_pool, app_pool=args.app_pool,
                            team_pool=args.team_pool)
    names = cluster_names(args.clusters)
    print(f"loading {len(names)} clusters with {args.workers} workers", file=sys.stderr)
    # One connection per worker: measure write throughput the way the collector sees it.
    pool = redis.ConnectionPool.from_url(args.redis_url, max_connections=args.workers + 4)
    worker_client = redis.Redis(connection_pool=pool)
    worker_store = RedisStore(worker_client, prefix=args.prefix, ttl_seconds=0,
                              snapshot_retention=500)
    stats = run_load(worker_store, worker_client, profile, names, args.hubs, args.seed,
                     args.workers)
    print(f"loaded in {stats.wall_seconds:.1f}s; measuring", file=sys.stderr)

    facts = gather_facts(store, client, profile, args, stats)
    facts["latencies"] = read_latencies(store, args.latency_iters, args.latency_budget)
    facts["http"] = ({"available": False, "reason": "skipped with --no-http"} if args.no_http
                     else http_latencies(args.api_base, store, args.latency_iters,
                                         args.latency_budget))
    report = render_report(facts)
    if args.report:
        with open(args.report, "w") as handle:
            handle.write(report)
        print(f"report written to {args.report}", file=sys.stderr)
    else:
        print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
