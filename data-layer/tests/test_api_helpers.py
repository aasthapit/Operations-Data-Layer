from app.api.blast_radius import join_reasons


def test_join_reasons_dedupes_with_counts():
    assert join_reasons({"image registry.k8s.io/pause:3.9": 10, "OCP 4.16.7": 1}) == \
        "image registry.k8s.io/pause:3.9 (x10); OCP 4.16.7"
    assert join_reasons({"ingress 4.15.18 (degraded)": 1}) == "ingress 4.15.18 (degraded)"
