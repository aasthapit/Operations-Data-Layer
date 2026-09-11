import os


class Settings:
    pg_host = os.environ.get("PG_HOST", "db")
    pg_port = os.environ.get("PG_PORT", "5432")
    pg_user = os.environ.get("PG_USER", "odl")
    pg_password = os.environ.get("PG_PASSWORD", "odl")
    pg_db = os.environ.get("PG_DB", "patching")

    @property
    def database_url(self):
        return (f"postgresql+psycopg2://{self.pg_user}:{self.pg_password}"
                f"@{self.pg_host}:{self.pg_port}/{self.pg_db}")


settings = Settings()
