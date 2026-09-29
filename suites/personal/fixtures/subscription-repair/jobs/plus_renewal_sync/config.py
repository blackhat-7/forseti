import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str
    max_failures: int
    grace_days: int
    batch_size: int


settings = Settings(
    database_url=os.environ["DATABASE_URL"],
    max_failures=int(os.environ.get("DUNNING_MAX_FAILURES", "3")),
    grace_days=int(os.environ.get("GRACE_DAYS", "3")),
    batch_size=int(os.environ.get("BATCH_SIZE", "500")),
)
