"""The application mapping: records in, ownership out."""
import dataclasses
import json

import pytest

from app import appmap
from app.appmap import AppMap, get_appmap, load_appmap

RECORDS = [
    {"cluster": "lew06", "env": "nonprod", "app_id": "1aat", "environment": "development",
     "lob": "wimt", "namespace": "1aat-dev"},
    {"cluster": "lew06", "env": "nonprod", "app_id": "1aat", "environment": "test",
     "lob": "wimt", "namespace": "1aat-pte"},
    {"cluster": "man01", "env": "prod", "app_id": "10am", "environment": "production",
     "lob": "cto", "namespace": "10am"},
    {"cluster": "man01", "app_id": "", "namespace": "broken"},          # skipped: no app
    "not a record",                                                      # skipped
]


def test_lookup_and_cluster_environment():
    m = AppMap(RECORDS)
    hit = m.lookup("lew06", "1aat-pte")
    assert hit.app == "1aat" and hit.team == "wimt" and hit.environment == "test"
    assert m.lookup("lew06", "unknown") is None and m.lookup("nowhere", "1aat-dev") is None
    assert m.cluster_environment("lew06") == "nonprod" and m.cluster_environment("man01") == "prod"
    assert m.cluster_environment("other") is None
    assert m.skipped == 2 and m.apps == 2 and m.clusters == 2
    assert m.describe()["namespaces"] == 3


def test_field_names_are_configurable():
    m = AppMap([{"c": "x", "ns": "web", "application": "shop", "owner": "retail"}],
               fields={"cluster": "c", "namespace": "ns", "app": "application", "team": "owner"})
    assert m.lookup("x", "web").app == "shop" and m.lookup("x", "web").team == "retail"


def test_load_json_and_yaml(tmp_path):
    j = tmp_path / "m.json"
    j.write_text(json.dumps({"items": RECORDS[:3]}))
    y = tmp_path / "m.yaml"
    y.write_text("- {cluster: a, namespace: b, app_id: c, lob: d}\n")
    assert load_appmap(str(j)).apps == 2
    assert load_appmap(str(y)).lookup("a", "b").team == "d"
    bad = tmp_path / "bad.json"
    bad.write_text("{}")
    assert load_appmap(str(bad)).records == 0
    bad.write_text("42")
    with pytest.raises(ValueError):
        load_appmap(str(bad))


def test_get_appmap_follows_the_manifest_and_the_file_mtime(manifest, tmp_path, monkeypatch):
    assert get_appmap(manifest) is None                       # labels mode
    path = tmp_path / "app-map.json"
    path.write_text(json.dumps(RECORDS[:1]))
    m = dataclasses.replace(manifest, applications={
        "source": "mapping", "mapping": {"path": str(path), "fields": dict(appmap.DEFAULT_FIELDS)}})
    appmap.reset_cache()
    first = get_appmap(m)
    assert first.lookup("lew06", "1aat-dev").app == "1aat" and get_appmap(m) is first
    path.write_text(json.dumps(RECORDS[:2]))
    import os
    os.utime(path, (os.stat(path).st_atime, os.stat(path).st_mtime + 5))
    assert get_appmap(m).lookup("lew06", "1aat-pte") is not None   # re-read after a change
    monkeypatch.setenv("ODL_APP_MAP", str(tmp_path / "missing.json"))
    with pytest.raises(FileNotFoundError):
        get_appmap(m)
    appmap.reset_cache()
