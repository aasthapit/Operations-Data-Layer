"""
Metrics generator - the local stand-in for per-cluster Prometheus.

In a real ACM estate, each managed cluster's Prometheus remote-writes usage
metrics to the hub's Thanos. Our kind clusters are idle sandboxes with no real
load, so - exactly as we seed realistic ClusterVersion/operator *state* onto
them - we synthesize realistic *usage* time-series here, aligned to the real
inventory (same cluster / namespace / node names from topology.yaml).

This process exposes Prometheus-format metrics; Prometheus scrapes it, Thanos
sidecar + Query put a PromQL surface on top, and Grafana + the data layer query
that. The metric names are ours (odl_*) but map directly to standard kube series
(documented in docs/insight-catalog.md and the Grafana dashboard).

These are representative, not measured - the honest local analogue of the seeded
cluster state. In production these endpoints disappear and the series come from
real Prometheus remote-write.
"""
import math
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yaml

TOPOLOGY = os.environ.get("TOPOLOGY", "/fleet/topology.yaml")
PORT = int(os.environ.get("PORT", "8000"))
NODES_PER_CLUSTER = int(os.environ.get("NODES_PER_CLUSTER", "3"))

# namespaces that are deliberately "hot" so top-N queries are interesting
# (these are namespace names from topology.yaml, not the app names)
HOT_CPU_NS = {"analytics", "risk"}        # analytics-pipeline, fraud-detection
HOT_MEM_NS = {"reco", "search"}           # recommendation-engine, search-indexer


def _stable(n, lo, hi):
    """Deterministic value in [lo,hi] from a string seed."""
    h = abs(hash(n)) % 1000 / 1000.0
    return lo + (hi - lo) * h


def app_matches(app, m):
    sel = app.get("place_on", {})
    if "environment" in sel and m["environment"] in sel["environment"]:
        return True
    if "region" in sel and m["region"] in sel["region"]:
        return True
    if "names" in sel and m["name"] in sel["names"]:
        return True
    return False


def load_inventory():
    with open(TOPOLOGY) as f:
        topo = yaml.safe_load(f)
    clusters = []
    for hub in topo["hubs"]:
        for m in hub["managed"]:
            namespaces = [a["namespace"] for a in topo["applications"]
                          if app_matches(a, m)]
            nodes = [f"{m['name']}-worker-{i}" for i in range(NODES_PER_CLUSTER)]
            clusters.append({
                "name": m["name"], "region": m["region"],
                "environment": m["environment"], "datacenter": m["datacenter"],
                "namespaces": namespaces, "nodes": nodes,
            })
    return clusters


CLUSTERS = load_inventory()


def wave(seed, t, base, amp):
    """Smoothly varying value so graphs move."""
    phase = (abs(hash(seed)) % 100) / 100.0 * 2 * math.pi
    return max(0.0, base + amp * math.sin(t / 120.0 + phase))


def render():
    t = time.time()
    lines = []

    def emit(name, htype, help_, samples):
        lines.append(f"# HELP {name} {help_}")
        lines.append(f"# TYPE {name} {htype}")
        for labels, val in samples:
            lbl = ",".join(f'{k}="{v}"' for k, v in labels.items())
            lines.append(f"{name}{{{lbl}}} {val:.4f}")

    ns_cpu, ns_mem = [], []
    node_cpu_use, node_cpu_cap, node_cpu_alloc = [], [], []
    node_mem_use, node_mem_cap, node_mem_alloc = [], [], []

    for c in CLUSTERS:
        cl = {"cluster": c["name"], "region": c["region"],
              "environment": c["environment"]}
        # --- namespace usage ---
        for ns in c["namespaces"]:
            cpu_base = 1.8 if ns in HOT_CPU_NS else _stable(ns + c["name"], 0.05, 0.6)
            mem_base = 6e9 if ns in HOT_MEM_NS else _stable("m" + ns + c["name"], 2e8, 1.8e9)
            ns_cpu.append(({**cl, "namespace": ns}, wave("c" + ns + c["name"], t, cpu_base, cpu_base * 0.25)))
            ns_mem.append(({**cl, "namespace": ns}, wave("m" + ns + c["name"], t, mem_base, mem_base * 0.15)))
        # --- node capacity + usage ---
        for i, node in enumerate(c["nodes"]):
            cap_cores = 8.0
            alloc_cores = 7.5
            cap_mem = 32 * 1024**3
            alloc_mem = 30 * 1024**3
            hot = (c["environment"] == "prod" and i == 0)
            cpu_used = wave("nc" + node, t, alloc_cores * (0.78 if hot else _stable(node, 0.2, 0.55)), 0.5)
            mem_used = wave("nm" + node, t, alloc_mem * (0.82 if hot else _stable("m" + node, 0.25, 0.6)), 1e9)
            nd = {**cl, "node": node}
            node_cpu_use.append((nd, cpu_used))
            node_cpu_cap.append((nd, cap_cores))
            node_cpu_alloc.append((nd, alloc_cores))
            node_mem_use.append((nd, mem_used))
            node_mem_cap.append((nd, cap_mem))
            node_mem_alloc.append((nd, alloc_mem))

    emit("odl_namespace_cpu_usage_cores", "gauge",
         "CPU cores used by namespace (~ sum by(namespace)(rate(container_cpu_usage_seconds_total[5m])))", ns_cpu)
    emit("odl_namespace_memory_usage_bytes", "gauge",
         "Memory working set by namespace (~ sum by(namespace)(container_memory_working_set_bytes))", ns_mem)
    emit("odl_node_cpu_usage_cores", "gauge", "Node CPU cores used", node_cpu_use)
    emit("odl_node_cpu_capacity_cores", "gauge", "Node CPU capacity (~ kube_node_status_capacity{resource='cpu'})", node_cpu_cap)
    emit("odl_node_cpu_allocatable_cores", "gauge", "Node CPU allocatable (~ kube_node_status_allocatable{resource='cpu'})", node_cpu_alloc)
    emit("odl_node_memory_usage_bytes", "gauge", "Node memory used", node_mem_use)
    emit("odl_node_memory_capacity_bytes", "gauge", "Node memory capacity", node_mem_cap)
    emit("odl_node_memory_allocatable_bytes", "gauge", "Node memory allocatable", node_mem_alloc)
    return "\n".join(lines) + "\n"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/metrics", "/"):
            body = render().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"metrics-generator: {len(CLUSTERS)} clusters, "
          f"{sum(len(c['namespaces']) for c in CLUSTERS)} ns series, "
          f"serving /metrics on :{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
