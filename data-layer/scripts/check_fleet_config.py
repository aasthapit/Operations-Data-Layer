"""
Try the fleet config the way the collector will, and say what happens.

    make check-config            # uses ODL_CONFIG from .env
    ODL_CONFIG=config/acm.yaml data-layer/.venv/bin/python data-layer/scripts/check_fleet_config.py

For every hub: log in (or open the kubeconfig), list ManagedClusters, and
try to connect to the first few of them the way managed_access says. For
every direct cluster: log in and read the server version. Nothing is written
anywhere and no credential is printed.
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
os.environ.setdefault("ODL_MANIFEST", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                    "..", "config", "ocp-api-manifest.yaml"))

from app import kube  # noqa: E402
from app.clusterauth import resolve_bearer_token  # noqa: E402
from app.collector import runner  # noqa: E402
from app.collector.parsers import normalize_managedcluster  # noqa: E402
from app.config_loader import load_config  # noqa: E402
from app.settings import settings  # noqa: E402

SAMPLE = int(os.environ.get("CHECK_SAMPLE", "3"))


def _short(e: Exception) -> str:
    text = str(e).strip().splitlines()[0] if str(e).strip() else type(e).__name__
    return text[:160]


def _timed(fn):
    t0 = time.time()
    try:
        return fn(), None, int((time.time() - t0) * 1000)
    except Exception as e:  # noqa: BLE001 - the point is to report it
        return None, e, int((time.time() - t0) * 1000)


def check_hub(hub) -> bool:
    how = f"kubeconfig {hub.kubeconfig}" if hub.kubeconfig else \
        f"{hub.api_url} as {hub.auth.get('type', 'kubeconfig')}" \
        f"{' user ' + str(hub.auth.get('username')) if hub.auth.get('username') else ''}"
    print(f"hub {hub.name}: {how}")
    hb, err, ms = _timed(lambda: runner._hub_bundle(hub))
    if err:
        print(f"  login FAILED ({ms}ms): {_short(err)}")
        return False
    print(f"  login ok ({ms}ms)")
    managed, err, ms = _timed(lambda: kube.list_managedclusters(hb))
    if err:
        print(f"  list ManagedClusters FAILED ({ms}ms): {_short(err)}")
        return False
    print(f"  {len(managed)} ManagedClusters ({ms}ms)" + ("" if managed else
          "  <- the identity can log in but sees no clusters: check RBAC on managedclusters"))
    ok = True
    for mc in managed[:SAMPLE]:
        meta = normalize_managedcluster(mc)
        if hub.managed_access != "secret":
            print(f"    {meta['name']}: API URL {runner.managed_api_url(hub, meta) or 'UNKNOWN'}")
        connect = runner._managed_connect(hub, hb, meta)
        bundle, err, ms = _timed(connect)
        if err:
            print(f"    {meta['name']}: connect FAILED ({ms}ms): {_short(err)}")
            ok = False
            continue
        version, err, ms2 = _timed(lambda b=bundle: kube.get_json(b, "/version"))
        if err:
            print(f"    {meta['name']}: connected, but reading /version FAILED ({ms2}ms): {_short(err)}")
            ok = False
        else:
            print(f"    {meta['name']}: ok, kubernetes {version.get('gitVersion')} ({ms + ms2}ms)")
    if len(managed) > SAMPLE:
        print(f"    ... {len(managed) - SAMPLE} more not tried (CHECK_SAMPLE={SAMPLE})")
    return ok


def check_cluster(c) -> bool:
    print(f"cluster {c.name}: {c.api_url} as {c.auth.get('type')}")
    verify = runner._tls_verify(c.insecure_skip_tls_verify, c.ca_cert)
    token, err, ms = _timed(lambda: resolve_bearer_token(c.api_url, c.auth, verify=verify))
    if err:
        print(f"  login FAILED ({ms}ms): {_short(err)}")
        return False
    bundle = kube.bundle_from_endpoint(c.api_url, token, verify=bool(verify), ca_cert=c.ca_cert)
    version, err, ms2 = _timed(lambda: kube.get_json(bundle, "/version"))
    if err:
        print(f"  login ok, reading /version FAILED ({ms2}ms): {_short(err)}")
        return False
    print(f"  ok, kubernetes {version.get('gitVersion')} ({ms + ms2}ms)")
    return True


def main() -> int:
    path = settings.config_path
    print(f"config: {path}")
    if not os.path.isfile(path):
        print("  not found. Set ODL_CONFIG (relative to data-layer/) to your acm.yaml or clusters.yaml")
        return 2
    try:
        cfg = load_config(path)
    except Exception as e:  # noqa: BLE001
        print(f"  does not load: {_short(e)}")
        return 2
    print(f"  {len(cfg.hubs)} hubs, {len(cfg.clusters)} direct clusters")
    results = [check_hub(h) for h in cfg.hubs] + [check_cluster(c) for c in cfg.clusters]
    if not results:
        print("nothing to check: the config has neither hubs: nor clusters:")
        return 2
    bad = results.count(False)
    print(f"{len(results) - bad} ok, {bad} failing")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
