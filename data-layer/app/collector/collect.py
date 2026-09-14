"""
Collect everything the manifest enables from one cluster and assemble it into
a single normalised document (plain dicts) that health checks and persistence
consume.

Three phases:
  0. plan   - decide which kinds are DUE this sweep. Every resource carries an
              `interval` in the manifest (0 = every sweep), and the collector
              remembers per cluster and per kind when it last fetched it, so a
              sweep collects platform state every time and inventory on its own
              tier. This is what makes ~800 clusters affordable: a sweep is no
              longer "everything, everywhere, every two minutes".
  1. fetch  - one API call per DUE resource, recording per-resource outcome
              (collected / unavailable / forbidden / error) so "what can this
              cluster answer?" is itself data. A kind that is not due keeps its
              previous status entry, marked `cached`.
  2. assemble - join the raw objects: pods and metrics roll up into namespaces
              and nodes, workloads yield image / config-reference edges, every
              other kind becomes a scrubbed inventory row, and capacity is
              summed for the cluster. Rows of a kind that was not fetched are
              carried over from the previous document (`Previous`), so the
              document shape is identical whether or not a kind was due and
              health checks, the store and the API need no change.
"""
import concurrent.futures
import inspect
import logging
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from .. import kube
from ..appmap import get_appmap
from ..manifest import APPLICATION, Manifest
from ..settings import settings
from . import parsers as p
from .registry import REGISTRY

log = logging.getLogger("odl.collect")

_GENERIC_PARSERS = {
    "configmaps": p.parse_configmap,
    "secrets": p.parse_secret,
    "services": p.parse_service,
    "routes": p.parse_route,
    "ingresses": p.parse_ingress,
    "networkpolicies": p.parse_networkpolicy,
    "persistentvolumeclaims": p.parse_pvc,
    "persistentvolumes": p.parse_pv,
    "storageclasses": p.parse_storageclass,
    "resourcequotas": p.parse_resourcequota,
    "events": p.parse_event,
    "cronjobs": p.parse_cronjob,
    "horizontalpodautoscalers": p.parse_hpa,
    "clusterserviceversions": p.parse_csv,
    "subscriptions": p.parse_subscription,
    "machineconfigpools": p.parse_mcp,
    "clusterrolebindings": p.parse_clusterrolebinding,
}
_WORKLOAD_KEYS = {"deployments": "Deployment", "statefulsets": "StatefulSet",
                  "daemonsets": "DaemonSet"}

_missing = [k for k, spec in REGISTRY.items() if spec.store == "generic" and k not in _GENERIC_PARSERS]
if _missing:
    raise RuntimeError(f"registry keys without a parser: {', '.join(_missing)}")

# The singleton kinds: each produces a handful of fields on the cluster itself
# rather than rows in a section.
_CLUSTER_CONFIG_PARSERS = {
    "clusterversion": p.parse_clusterversion,
    "infrastructure": p.parse_infrastructure,
    "network_config": p.parse_network_config,
    "ingress_config": p.parse_ingress_config,
}
# Namespace rollup fields computed from the pods of the same collection, with
# the value a namespace without pods gets (`images` is handled beside them).
_POD_ROLLUP_FIELDS = {
    "pods_total": 0, "pods_running": 0, "pods_pending": 0, "pods_failed": 0,
    "pods_succeeded": 0, "restarts_total": 0, "pod_issues": 0,
    "cpu_requests": None, "cpu_limits": None, "memory_requests": None, "memory_limits": None,
}
_USAGE_FIELDS = ("cpu_usage", "memory_usage")
# Per-kind volume stats app/kube.py records on the bundle, when it does.
_STAT_FIELDS = ("requests", "bytes", "objects", "parse_ms")


# --------------------------------------------------------------------------- #
# phase 0: what is due
# --------------------------------------------------------------------------- #
# The stored sections the merge reads back for the kinds that are not due.
PREVIOUS_SECTIONS = ("resource_status", "resources", "workloads", "workload_images",
                     "workload_refs", "namespaces", "nodes", "operators", "pod_issues")
# The summary field holding the collector's own bookkeeping (see `Previous`).
STATE_FIELD = "collector_state"


def _iso(when: datetime) -> str:
    return when.astimezone(UTC).isoformat()


def _parse_ts(value) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


@dataclass
class Previous:
    """The last collection of one cluster, as the tiered merge needs it.

    Two parts:

    * `sections` - the stored detail sections (`store.sections`). They hold the
      rows of every kind, so the merge can keep the rows of a kind that is not
      due this sweep, and the `resource_status` section holds each kind's last
      outcome and `collected_at`, which is what "is it due?" is decided on.
    * `state` - the one thing no section carries: the cluster-level config the
      singleton kinds (ClusterVersion, Infrastructure, Network, Ingress)
      produce. It becomes summary fields under the store's own names, several
      of which the summary does not keep at all, so the collector keeps its own
      copy in the `collector_state` summary field (`store.update_summary`)
      rather than translating the store's schema back.

    An empty `Previous` (no previous sweep, or a full refresh) makes every
    enabled kind due, which is exactly the behaviour before tiers existed.
    """

    sections: dict = field(default_factory=dict)
    state: dict = field(default_factory=dict)

    def __post_init__(self):
        self._status = {row["key"]: {f: v for f, v in row.items()
                                     if f not in ("key", "cluster_name")}
                        for row in (self.sections.get("resource_status") or [])
                        if row.get("key")}

    def rows(self, section: str) -> list[dict]:
        """One stored section as plain dicts the merge may mutate."""
        return [{f: v for f, v in row.items() if f != "cluster_name"}
                for row in (self.sections.get(section) or [])]

    def status(self, key: str) -> dict | None:
        """The previous `resource_status` entry for one kind."""
        entry = self._status.get(key)
        return dict(entry) if entry is not None else None

    def collected_at(self, key: str) -> datetime | None:
        """When this kind was last fetched, or None if it never was."""
        return _parse_ts((self._status.get(key) or {}).get("collected_at"))

    def config(self) -> dict:
        """Cluster-level config per singleton kind, as last parsed."""
        return {key: dict(values) for key, values in (self.state.get("config") or {}).items()}


@dataclass
class Plan:
    """Which kinds this collection fetches, and what the rest keep."""

    due: list[str]
    cached: dict[str, dict] = field(default_factory=dict)     # key -> status entry carried over
    now: datetime = field(default_factory=lambda: datetime.now(UTC))


def plan_collection(manifest: Manifest, previous: Previous | None = None,
                    now: datetime | None = None, full: bool = False) -> Plan:
    """Decide what this collection fetches. A kind is due when

      * a full refresh was asked for, or
      * its `interval` is 0 - the default, meaning every sweep, or
      * it has never been collected (nothing to keep), or
      * `now - collected_at >= interval`.

    Everything else carries its previous status entry forward marked `cached`,
    with the `collected_at` of the collection it came from, so the availability
    view can say "forbidden, as of 12 minutes ago" rather than drop the kind.
    """
    now = now or datetime.now(UTC)
    previous = previous or Previous()
    due: list[str] = []
    cached: dict[str, dict] = {}
    for key in REGISTRY:
        if not manifest.enabled(key):
            continue
        interval = manifest.interval(key)
        last = previous.collected_at(key)
        entry = previous.status(key)
        if full or interval <= 0 or last is None or entry is None \
                or now - last >= timedelta(seconds=interval):
            due.append(key)
            continue
        entry.update({"cached": True, "collected_at": _iso(last), "interval_seconds": interval})
        cached[key] = entry
    return Plan(due=due, cached=cached, now=now)


# --------------------------------------------------------------------------- #
# phase 1: fetch
# --------------------------------------------------------------------------- #
_STAT_KEY_SUPPORT: dict = {}


def _stat_kwargs(fn, key: str) -> dict:
    """`stat_key=<kind>` where app/kube.py records per-kind volume stats on the
    bundle, nothing where it does not: the collector has to run against either."""
    supported = _STAT_KEY_SUPPORT.get(fn)
    if supported is None:
        supported = _STAT_KEY_SUPPORT[fn] = "stat_key" in inspect.signature(fn).parameters
    return {"stat_key": key} if supported else {}


def _volume_stats(b: kube.ApiBundle, key: str) -> dict:
    """What the client recorded for this kind: requests, bytes on the wire,
    objects returned, parse time. Empty when the bundle carries no stats."""
    stats = (getattr(b, "stats", None) or {}).get(key) or {}
    return {f: stats[f] for f in _STAT_FIELDS if stats.get(f) is not None}


def _fetch(b: kube.ApiBundle, key: str, manifest: Manifest):
    spec = REGISTRY[key]
    if spec.name:
        return kube.get_resource(b, spec.base_path, spec.plural, spec.name,
                                 **_stat_kwargs(kube.get_resource, key))
    return kube.list_resource(b, spec.base_path, spec.plural,
                              field_selector=spec.field_selector,
                              **_stat_kwargs(kube.list_resource, key))


def _fetch_one(b: kube.ApiBundle, key: str, manifest: Manifest,
               now: datetime) -> tuple[str, object, dict]:
    """Fetch one kind; never raises. Returns (key, objects or None, status)."""
    t0 = time.time()
    got = None
    try:
        got = _fetch(b, key, manifest)
        count = len(got) if isinstance(got, list) else 1
        status = {"status": "collected", "count": count, "error": None}
    except kube.ResourceUnavailable as e:
        status = {"status": "unavailable", "count": 0, "error": str(e)}
    except kube.ResourceForbidden as e:
        status = {"status": "forbidden", "count": 0, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        status = {"status": "error", "count": 0, "error": str(e)[:500]}
        log.warning("collect %s: %s", key, e)
    status["duration_ms"] = int((time.time() - t0) * 1000)
    # An attempt counts as a collection whatever its outcome: a kind that is
    # forbidden on this cluster is retried on its own tier, not every sweep.
    status.update({"collected_at": _iso(now), "cached": False,
                   "interval_seconds": manifest.interval(key)})
    status.update(_volume_stats(b, key))
    return key, got, status


def fetch_all(b: kube.ApiBundle, manifest: Manifest,
              plan: Plan | None = None) -> tuple[dict, dict]:
    """Return (raw objects by key, status by key) for the kinds the plan makes due.

    Kinds are fetched concurrently (bounded by COLLECT_FETCH_WORKERS): against
    a real cluster each list is a network round trip, often several pages, and
    ~30 of them in sequence is what made a sweep slow. The Kubernetes client
    reuses one connection pool per cluster, so this costs no extra handshakes.
    Results are returned in registry order regardless of completion order, and
    every enabled kind has a status entry whether it was fetched, kept from the
    previous collection (`cached`) or turned off (`disabled`).
    """
    plan = plan or Plan(due=[key for key in REGISTRY if manifest.enabled(key)])
    workers = max(1, min(settings.collect_fetch_workers, len(plan.due) or 1))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        fetched = {key: (got, st) for key, got, st
                   in ex.map(lambda key: _fetch_one(b, key, manifest, plan.now), plan.due)}
    raw, status = {}, {}
    for key in REGISTRY:
        if key in fetched:
            got, st = fetched[key]
            if got is not None:
                raw[key] = got
            status[key] = st
        elif key in plan.cached:
            status[key] = plan.cached[key]
        elif not manifest.enabled(key):
            status[key] = {"status": "disabled", "count": 0, "duration_ms": 0, "error": None,
                           "cached": False, "interval_seconds": manifest.interval(key)}
    return raw, status


def slowest(status: dict, n: int = 3) -> str:
    """'secrets 3200ms, pods 1800ms, configmaps 900ms' - for the sweep log.
    Only what was actually fetched: a cached kind cost nothing this sweep."""
    top = sorted(((st.get("duration_ms") or 0, key) for key, st in status.items()
                  if st.get("status") == "collected" and not st.get("cached")), reverse=True)[:n]
    return ", ".join(f"{key} {ms}ms" for ms, key in top)


# --------------------------------------------------------------------------- #
# phase 2: assemble
# --------------------------------------------------------------------------- #
def _ns_of(obj) -> str | None:
    return (obj.get("metadata") or {}).get("namespace")


def _most_common(values) -> str | None:
    values = [v for v in values if v]
    return Counter(values).most_common(1)[0][0] if values else None


def _ns_status(ns: dict, workloads: list[dict]) -> str:
    if any(w["status"] == "degraded" for w in workloads):
        return "critical"
    if ns.get("pod_issues") or any(w["status"] == "progressing" for w in workloads):
        return "warning"
    return "healthy"


def assemble(meta: dict, raw: dict, status: dict, manifest: Manifest,
             now: datetime | None = None, previous: Previous | None = None) -> dict:
    """Join what this collection fetched with what the last one left behind.

    `status` is the plan made visible: an entry marked `cached` is a kind that
    was not due, and its rows come from `previous` instead of from `raw`.
    Everything else is rebuilt from `raw` - including a kind that has just
    become forbidden or unavailable, whose previous rows are therefore dropped.
    That is the point: the document always says what the cluster serves today.

    Whatever the mix, the document has the same shape, so health checks, the
    store and the API cannot tell a tiered sweep from a full one.
    """
    now = now or datetime.now(UTC)
    prev = previous or Previous()

    def kept(key: str) -> bool:
        """Whether this kind's rows are carried over instead of rebuilt."""
        return bool(status.get(key, {}).get("cached"))

    data = dict(meta)
    data.update({"reachable": True, "error": None, "resource_status": status})

    # --- cluster-level platform config -------------------------------------
    # Each singleton kind contributes a few fields to the cluster itself; one
    # that is not due keeps the fields it produced when it last was.
    config = prev.config()
    for key, parse in _CLUSTER_CONFIG_PARSERS.items():
        if key in raw:
            config[key] = parse(raw[key])
        elif not kept(key):
            config.pop(key, None)           # disabled, or the cluster stopped serving it
    for values in config.values():
        data.update(values)
    if "clusterversion" not in config:
        data.setdefault("version", meta.get("label_version"))

    if "clusteroperators" in raw:
        data["operators"] = p.parse_operators(raw["clusteroperators"])
    else:
        data["operators"] = prev.rows("operators") if kept("clusteroperators") else []

    # --- namespaces (the classification everything else hangs off) ---------
    prev_ns = {row["name"]: row for row in prev.rows("namespaces") if row.get("name")}
    namespaces: dict[str, dict] = {}
    if kept("namespaces"):
        # a copy: `carried` below reads prev_ns while the rollup rewrites these
        namespaces = {name: dict(row) for name, row in prev_ns.items()}
    for ns in raw.get("namespaces") or []:
        row = p.parse_namespace(ns, manifest)
        namespaces[row["name"]] = row

    def carried(name: str, fields) -> dict:
        """Namespace rollup fields that were not re-read this sweep."""
        old = prev_ns.get(name) or {}
        return {f: old.get(f) for f in fields}

    def ns_class(name: str) -> str:
        row = namespaces.get(name)
        return row["ns_class"] if row else manifest.classify_namespace(name, {})

    def ensure_ns(name: str) -> dict:
        if name not in namespaces:
            namespaces[name] = {
                "name": name, "ns_class": manifest.classify_namespace(name, {}),
                "app_name": None, "team": None, "tier": None, "labels": {}, "annotations": {},
                "requester": None, "display_name": None, "phase": None, "created_at": None,
            }
        return namespaces[name]

    def wanted(key: str, obj: dict) -> bool:
        ns = _ns_of(obj)
        return ns is None or manifest.wants_namespace(key, ns_class(ns))

    # --- workloads ---------------------------------------------------------
    # A workload kind that is not due keeps its rows and the image / reference
    # edges they produced; the three sections are rebuilt around them.
    workloads: list[dict] = []
    images_rows: list[dict] = []
    refs_rows: list[dict] = []
    for key, kind in _WORKLOAD_KEYS.items():
        if kept(key):
            continue
        for obj in raw.get(key) or []:
            if not wanted(key, obj):
                continue
            w = p.parse_workload(obj, kind, manifest)
            workloads.append(w)
            for c in w["containers"]:
                if c.get("image"):
                    images_rows.append({"namespace": w["namespace"], "workload_kind": kind,
                                        "workload_name": w["name"], "container": c["name"],
                                        **p.split_image(c["image"])})
            for r in w["config_refs"]:
                refs_rows.append({"namespace": w["namespace"], "workload_kind": kind,
                                  "workload_name": w["name"], "ref_kind": r["kind"],
                                  "ref_name": r["name"], "via": r["via"]})
    kept_kinds = {kind for key, kind in _WORKLOAD_KEYS.items() if kept(key)}
    if kept_kinds:
        workloads += [w for w in prev.rows("workloads") if w.get("kind") in kept_kinds]
        images_rows += [r for r in prev.rows("workload_images")
                        if r.get("workload_kind") in kept_kinds]
        refs_rows += [r for r in prev.rows("workload_refs")
                      if r.get("workload_kind") in kept_kinds]
    wl_by_ns: dict[str, list] = defaultdict(list)
    for w in workloads:
        # classification is this sweep's, even for a row that was kept
        w["ns_class"] = ns_class(w["namespace"])
        wl_by_ns[w["namespace"]].append(w)

    # --- pods + pod metrics -------------------------------------------------
    pods_raw = [o for o in (raw.get("pods") or []) if wanted("pods", o)]
    pods = p.parse_pods(pods_raw, manifest, now)
    pod_metrics = p.parse_pod_metrics([o for o in (raw.get("pod_metrics") or [])
                                       if wanted("pod_metrics", o)])
    pod_issues = prev.rows("pod_issues") if kept("pods") else pods["issues"]
    for issue in pod_issues:
        issue["ns_class"] = ns_class(issue["namespace"])

    # --- nodes + node metrics ----------------------------------------------
    # Usage and the running-pod count are refreshed on their own kinds' tiers:
    # a node row that was not re-read keeps the numbers of its last reading.
    node_usage = p.parse_node_metrics(raw.get("node_metrics") or [])
    prev_nodes = {n["name"]: n for n in prev.rows("nodes") if n.get("name")}
    nodes = list(prev_nodes.values()) if kept("nodes") else [
        p.parse_node(obj, manifest) for obj in raw.get("nodes") or []]
    for n in nodes:
        old = prev_nodes.get(n["name"]) or {}
        if kept("node_metrics"):
            n.update({f: old.get(f) for f in _USAGE_FIELDS})
        else:
            n.update(node_usage.get(n["name"]) or dict.fromkeys(_USAGE_FIELDS))
        n["pods_running"] = (old.get("pods_running", 0) if kept("pods")
                             else pods["node_pods"].get(n["name"], 0))
    data["nodes"] = nodes
    data["nodes_total"] = len(nodes)
    data["nodes_ready"] = sum(1 for n in nodes if n["ready"])

    # --- generic resources --------------------------------------------------
    resources: list[dict] = []
    for key, parser in _GENERIC_PARSERS.items():
        if kept(key):
            continue
        spec = REGISTRY[key]
        items = raw.get(key) or []
        if key == "events":
            limit = manifest.config(key).limit
            items = sorted(items, key=lambda e: str(e.get("lastTimestamp") or e.get("eventTime")
                                                    or e.get("firstTimestamp") or ""), reverse=True)
            if limit:
                items = items[:limit]
        for obj in items:
            if spec.scope == "namespaced" and not wanted(key, obj):
                continue
            row = (parser(obj, manifest, pods["pvc_mounts"]) if key == "persistentvolumeclaims"
                   else parser(obj, manifest))
            if row is None:
                continue
            row.update({"key": key, "kind": spec.kind, "api_group": spec.api_group_label,
                        "ns_class": ns_class(row["namespace"]) if row["namespace"] else None})
            resources.append(row)
    kept_keys = {key for key in _GENERIC_PARSERS if kept(key)}
    if kept_keys:
        for row in prev.rows("resources"):
            if row.get("key") in kept_keys:
                row["ns_class"] = ns_class(row["namespace"]) if row.get("namespace") else None
                resources.append(row)
    ns_counts: dict[str, Counter] = defaultdict(Counter)
    for row in resources:
        if row.get("namespace"):
            ns_counts[row["namespace"]][row["key"]] += 1
    data["resources"] = resources

    # --- namespace rollups --------------------------------------------------
    own = manifest.ownership
    appmap = get_appmap(manifest)
    cluster_name = meta.get("name")
    for name in set(pods["namespaces"]) | set(wl_by_ns) | set(pod_metrics):
        ensure_ns(name)
    for name, ns in namespaces.items():
        # Pod and usage rollups are always this sweep's when pods / pod metrics
        # were fetched, and the last sweep's when they were not - never a mix.
        if kept("pods"):
            ns.update(carried(name, _POD_ROLLUP_FIELDS))
            ns["images"] = list((prev_ns.get(name) or {}).get("images") or [])
        else:
            roll = pods["namespaces"].get(name) or {}
            ns.update({f: roll.get(f, empty) for f, empty in _POD_ROLLUP_FIELDS.items()})
            ns["images"] = list(roll.get("images") or [])
        if kept("pod_metrics"):
            ns.update(carried(name, _USAGE_FIELDS))
        else:
            usage = pod_metrics.get(name)
            ns["cpu_usage"] = usage["cpu_usage"] if usage else None
            ns["memory_usage"] = usage["memory_usage"] if usage else None
        wls = wl_by_ns.get(name, [])
        ns["workloads_total"] = len(wls)
        ns["replicas_desired"] = sum(w["replicas_desired"] for w in wls)
        ns["replicas_ready"] = sum(w["replicas_ready"] for w in wls)
        ns["resource_counts"] = dict(ns_counts.get(name, {}))
        ns["status"] = _ns_status(ns, wls)
        if appmap is not None:
            # ownership is the registry's, never labels: a namespace is under the
            # application the mapping says, or under none at all
            hit = appmap.lookup(cluster_name, name)
            ns["app_name"] = hit.app if hit else None
            ns["team"] = hit.team if hit else None
            ns["tier"] = None
            ns["environment"] = hit.environment if hit else None
            ns["assigned"] = hit is not None
            continue
        # ownership: namespace labels first, then the workloads' most common value
        for owner in ("app_name", "team", "tier"):
            if ns.get(owner):
                continue
            keys = own.get("app" if owner == "app_name" else owner, [])
            ns[owner] = _most_common(p.pick_label(w["labels"], keys) for w in wls)
        if not ns.get("app_name"):
            ns["app_name"] = name
        ns["environment"] = None
        ns["assigned"] = True
    data["namespaces"] = sorted(namespaces.values(), key=lambda n: n["name"])
    if appmap is not None and not data.get("environment"):
        # ACM carried no environment for this cluster; the registry knows it
        data["environment"] = appmap.cluster_environment(cluster_name)
    data["workloads"] = workloads
    data["workload_images"] = images_rows
    data["workload_refs"] = refs_rows
    data["pod_issues"] = pod_issues

    # --- capacity / utilization rollup ---------------------------------------
    def total(rows, key, cast=float):
        vals = [r.get(key) for r in rows if r.get(key) is not None]
        return cast(sum(vals)) if vals else None

    metrics_ok = status.get("node_metrics", {}).get("status") == "collected"
    pod_metrics_ok = status.get("pod_metrics", {}).get("status") == "collected"
    cpu_usage = total(nodes, "cpu_usage") if metrics_ok else None
    mem_usage = total(nodes, "memory_usage", int) if metrics_ok else None
    if cpu_usage is None and pod_metrics_ok:
        cpu_usage = total(list(pod_metrics.values()), "cpu_usage")
        mem_usage = total(list(pod_metrics.values()), "memory_usage", int)
    ns_rows = data["namespaces"]
    data["capacity"] = {
        "cpu_capacity": total(nodes, "cpu_capacity"),
        "cpu_allocatable": total(nodes, "cpu_allocatable"),
        "cpu_requests": total(ns_rows, "cpu_requests"),
        "cpu_limits": total(ns_rows, "cpu_limits"),
        "cpu_usage": cpu_usage,
        "memory_capacity": total(nodes, "memory_capacity", int),
        "memory_allocatable": total(nodes, "memory_allocatable", int),
        "memory_requests": total(ns_rows, "memory_requests", int),
        "memory_limits": total(ns_rows, "memory_limits", int),
        "memory_usage": mem_usage,
        "pods_capacity": total(nodes, "pods_capacity", int),
        "pods_total": sum(n["pods_total"] for n in ns_rows),
        "pods_running": sum(n["pods_running"] for n in ns_rows),
        "metrics_available": bool(metrics_ok or pod_metrics_ok),
    }
    data["namespaces_application"] = sum(1 for n in ns_rows if n["ns_class"] == APPLICATION)
    data["namespaces_platform"] = len(ns_rows) - data["namespaces_application"]
    # distinct applications, not namespaces: with a mapping one application spans
    # several namespaces and an unassigned namespace counts for none
    data["applications_total"] = len({n["app_name"] for n in ns_rows
                                      if n["ns_class"] == APPLICATION and n.get("app_name")
                                      and n.get("assigned", True)})
    data["workloads_total"] = len(workloads)
    data["pod_issues_total"] = len(pod_issues)
    data["certs_expiring_total"] = sum(1 for r in resources
                                       if r["key"] in ("secrets", "configmaps")
                                       and r["status"] in ("expiring", "expired"))
    # The one thing the next collection needs that no section carries.
    data[STATE_FIELD] = {"config": config}
    return data


def _volume_totals(status: dict) -> dict:
    """Requests, bytes, objects and parse time over the kinds fetched this
    collection (0 where app/kube.py does not record them). A cached kind is
    left out: its volumes belong to the sweep that actually pulled it."""
    fetched = [st for st in status.values() if not st.get("cached")]
    return {f: sum(st.get(f) or 0 for st in fetched)
            for f in ("bytes", "objects", "parse_ms", "requests")}


def collect_managed_cluster(b: kube.ApiBundle, meta: dict, manifest: Manifest,
                            previous: Previous | None = None, full: bool = False,
                            now: datetime | None = None) -> dict:
    """Pull from one cluster everything the manifest enables and this sweep is
    due (everything, with `full`), and merge it with what `previous` holds."""
    now = now or datetime.now(UTC)
    plan = plan_collection(manifest, previous, now, full=full)
    reset = getattr(b, "reset_stats", None)
    if reset:            # the volume stats are this collection's, not the bundle's
        reset()
    t0 = time.time()
    raw, status = fetch_all(b, manifest, plan)
    fetch_ms = int((time.time() - t0) * 1000)
    data = assemble(meta, raw, status, manifest, now, previous)
    data["collect_ms"] = int((time.time() - t0) * 1000)
    data["timings"] = {
        "fetch_ms": fetch_ms, "assemble_ms": data["collect_ms"] - fetch_ms,
        "kinds_fetched": len(plan.due), "kinds_cached": len(plan.cached),
        **_volume_totals(status),
    }
    # One line per cluster per sweep answers "why is this slow?" without a debugger.
    log.info("collect %s: %dms (fetch %dms, assemble %dms; %d kinds fetched, %d cached; "
             "slowest: %s)", meta.get("name"), data["collect_ms"], fetch_ms,
             data["timings"]["assemble_ms"], len(plan.due), len(plan.cached),
             slowest(status) or "n/a")
    return data


def unreachable(meta: dict, error: str) -> dict:
    """The document for a cluster we could not connect to."""
    data = dict(meta)
    data.update({
        "reachable": False, "error": error, "resource_status": {},
        "operators": [], "nodes": [], "namespaces": [], "workloads": [],
        "workload_images": [], "workload_refs": [], "pod_issues": [], "resources": [],
        "capacity": {}, "nodes_total": 0, "nodes_ready": 0,
    })
    return data
