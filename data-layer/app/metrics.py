"""
Metrics plane client - queries Thanos by reference, never stores series.

This is the deliberate counterpart to the inventory collector: utilization is
not in the Kubernetes API, so we do NOT poll or persist it. We ask Thanos
(PromQL) at request time and return the answer. In production THANOS_URL points
at the ACM hub's Thanos Querier; locally it points at our Thanos Query container.

The metric names below are our local generator's (odl_*). The production
equivalents are noted - swapping them is the only change needed against real
ACM/Thanos.
"""
import requests

from .settings import settings


class MetricsUnavailable(RuntimeError):
    pass


def _auth_kwargs():
    headers, auth = {}, None
    if settings.thanos_token:
        headers["Authorization"] = f"Bearer {settings.thanos_token}"
    if settings.thanos_basic_auth and ":" in settings.thanos_basic_auth:
        u, p = settings.thanos_basic_auth.split(":", 1)
        auth = (u, p)
    if not settings.thanos_verify_tls:
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    return {"headers": headers, "auth": auth, "verify": settings.thanos_verify_tls}


def _instant(promql: str):
    # Works against a bare Thanos/Prometheus (/api/v1/query) and against a
    # Grafana datasource-proxy URL (which also terminates in /api/v1/query).
    try:
        r = requests.get(f"{settings.thanos_url}/api/v1/query",
                         params={"query": promql}, timeout=15, **_auth_kwargs())
        r.raise_for_status()
        body = r.json()
    except Exception as e:  # noqa: BLE001
        raise MetricsUnavailable(f"{settings.thanos_url}: {e}")
    if body.get("status") != "success":
        raise MetricsUnavailable(body.get("error", "query failed"))
    return body["data"]["result"]


def _rows(promql, label_keys):
    out = []
    for r in _instant(promql):
        m = r["metric"]
        out.append({**{k: m.get(k) for k in label_keys},
                    "value": float(r["value"][1])})
    return out


def _by(promql, key="cluster"):
    return {r["metric"].get(key): float(r["value"][1]) for r in _instant(promql)}


# PromQL dialects. `local` uses our generator's series; `kube` uses standard
# kube/OCP series so the same endpoints work against a real ACM/Thanos. Node
# usage in real clusters often needs site-specific recording rules - adjust the
# `kube` node_* expressions to match your environment if needed.
PROFILES = {
    "local": {
        "ns_cpu": "odl_namespace_cpu_usage_cores",
        "ns_mem": "odl_namespace_memory_usage_bytes",
        "node_cpu_used": "odl_node_cpu_usage_cores",
        "node_cpu_alloc": "odl_node_cpu_allocatable_cores",
        "node_mem_used": "odl_node_memory_usage_bytes",
        "node_mem_alloc": "odl_node_memory_allocatable_bytes",
    },
    "kube": {
        "ns_cpu": 'rate(container_cpu_usage_seconds_total{container!="",pod!=""}[5m])',
        "ns_mem": 'container_memory_working_set_bytes{container!="",pod!=""}',
        "node_cpu_used": 'instance:node_cpu_utilisation:rate1m * instance:node_num_cpu:sum',
        "node_cpu_alloc": 'kube_node_status_allocatable{resource="cpu"}',
        "node_mem_used": 'node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes',
        "node_mem_alloc": 'kube_node_status_allocatable{resource="memory"}',
    },
}


def _p(key):
    return PROFILES.get(settings.metrics_profile, PROFILES["local"])[key]


def top_namespaces(by="cpu", limit=10):
    base = _p("ns_cpu") if by == "cpu" else _p("ns_mem")
    unit = "cores" if by == "cpu" else "bytes"
    expr = f"sum by (namespace, cluster) ({base})"
    rows = _rows(f"topk({limit}, {expr})", ["namespace", "cluster"])
    return {"by": by, "unit": unit,
            "results": sorted(rows, key=lambda r: -r["value"])}


def top_nodes(by="cpu", limit=10):
    if by == "cpu":
        expr = f"100 * ({_p('node_cpu_used')}) / ({_p('node_cpu_alloc')})"
    else:
        expr = f"100 * ({_p('node_mem_used')}) / ({_p('node_mem_alloc')})"
    rows = _rows(f"topk({limit}, {expr})", ["node", "cluster", "instance"])
    return {"by": by, "unit": "percent",
            "results": sorted(rows, key=lambda r: -r["value"])}


def cluster_utilization(cluster=None):
    sel = f'{{cluster="{cluster}"}}' if cluster else ""
    cpu_used = _by(f"sum by (cluster)({_p('node_cpu_used')}{sel})")
    cpu_alloc = _by(f"sum by (cluster)({_p('node_cpu_alloc')}{sel})")
    mem_used = _by(f"sum by (cluster)({_p('node_mem_used')}{sel})")
    mem_alloc = _by(f"sum by (cluster)({_p('node_mem_alloc')}{sel})")
    out = []
    for c in sorted(cpu_alloc):
        ca, cu = cpu_alloc.get(c, 0), cpu_used.get(c, 0)
        ma, mu = mem_alloc.get(c, 0), mem_used.get(c, 0)
        out.append({
            "cluster": c,
            "cpu": {"used_cores": round(cu, 2), "allocatable_cores": round(ca, 2),
                    "used_percent": round(100 * cu / ca, 1) if ca else None,
                    "headroom_cores": round(ca - cu, 2)},
            "memory": {"used_bytes": int(mu), "allocatable_bytes": int(ma),
                       "used_percent": round(100 * mu / ma, 1) if ma else None,
                       "headroom_bytes": int(ma - mu)},
        })
    return out[0] if cluster and out else out


def capacity(group_by="cluster"):
    key = "cluster" if group_by not in ("region", "environment") else group_by
    alloc = _by(f"sum by ({key})({_p('node_cpu_alloc')})", key)
    used = _by(f"sum by ({key})({_p('node_cpu_used')})", key)
    rows = []
    for g in sorted(alloc):
        a, u = alloc.get(g, 0), used.get(g, 0)
        rows.append({key: g, "allocatable_cores": round(a, 1),
                     "used_cores": round(u, 1), "headroom_cores": round(a - u, 1),
                     "used_percent": round(100 * u / a, 1) if a else None})
    return {"group_by": key, "results": rows}


def raw_query(promql: str):
    return [{"metric": r["metric"], "value": float(r["value"][1])}
            for r in _instant(promql)]


def healthy():
    try:
        requests.get(f"{settings.thanos_url}/-/healthy", timeout=5)
        return True
    except Exception:  # noqa: BLE001
        try:
            _instant("vector(1)")
            return True
        except Exception:  # noqa: BLE001
            return False
