CREATE TABLE marketplace_profiles (
  key                TEXT PRIMARY KEY,
  profile_version_id TEXT,
  payload            TEXT NOT NULL
);
CREATE TABLE profile_backup (
  key     TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE migration_audit (
  job      TEXT PRIMARY KEY,
  last_run TEXT
);
