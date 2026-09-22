"""CORS is open for development and narrows to named origins in production."""
from app.main import cors_origins


def test_the_default_is_the_wildcard():
    assert cors_origins("") == ["*"]
    assert cors_origins("*") == ["*"]


def test_named_origins_are_split_and_trimmed():
    assert cors_origins(" https://odl.apps.example.com, https://ops.example.com ") == [
        "https://odl.apps.example.com", "https://ops.example.com"]


def test_the_environment_is_read_when_nothing_is_passed(monkeypatch):
    monkeypatch.setenv("ODL_CORS_ORIGINS", "https://a.example")
    assert cors_origins() == ["https://a.example"]
