import os
from urllib.parse import quote_plus


class Settings:
    pg_host = os.environ.get("PG_HOST", "db")
    pg_port = os.environ.get("PG_PORT", "5432")
    pg_user = os.environ.get("PG_USER", "odl")
    pg_password = os.environ.get("PG_PASSWORD", "odl")
    pg_db = os.environ.get("PG_DB", "patching")

    @property
    def database_url(self):
        # The user and password are URL components: a password with "@", "/"
        # or "%" in it must be percent-encoded or the DSN parses as a different
        # host.
        return (f"postgresql+psycopg2://{quote_plus(self.pg_user)}:{quote_plus(self.pg_password)}"
                f"@{self.pg_host}:{self.pg_port}/{self.pg_db}")


settings = Settings()
