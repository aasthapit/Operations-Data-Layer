"""The database URL survives a password with URL metacharacters in it."""
from app.settings import Settings


def test_a_password_with_url_metacharacters_is_percent_encoded(monkeypatch):
    monkeypatch.setenv("PG_PASSWORD", "p@ss/w%rd")
    monkeypatch.setenv("PG_USER", "odl user")

    class Env(Settings):
        pg_password = "p@ss/w%rd"
        pg_user = "odl user"

    url = Env().database_url
    assert url == "postgresql+psycopg2://odl+user:p%40ss%2Fw%25rd@db:5432/patching"
