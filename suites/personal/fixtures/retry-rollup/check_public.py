import json, sqlite3
from pathlib import Path

c = sqlite3.connect(":memory:")
c.executescript(
    "CREATE TABLE runs(id INTEGER PRIMARY KEY, profile TEXT, finished_at TEXT, status TEXT);"
    "CREATE TABLE supersedes(failed_id INTEGER, retry_id INTEGER);"
    "CREATE TABLE ignored(profile TEXT);"
)
d = json.loads(Path("data.json").read_text())
c.executemany("INSERT INTO runs VALUES (?,?,?,?)", d["runs"])
c.executemany("INSERT INTO supersedes VALUES (?,?)", d["supersedes"])
c.executemany("INSERT INTO ignored VALUES (?)", d["ignored"])
rows = c.execute(
    Path("query.sql").read_text(),
    {"start": "2031-03-03T00:00:00+00:00", "end": "2031-03-07T00:00:00+00:00"},
).fetchall()
assert rows == [("2031-03-04", 1)], rows
print("public check passed")
