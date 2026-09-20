import json, sqlite3
from pathlib import Path

c = sqlite3.connect(":memory:")
c.executescript("CREATE TABLE runs(id INTEGER PRIMARY KEY, profile TEXT, finished_at TEXT, status TEXT);")
d = json.loads(Path("data.json").read_text())
c.executemany("INSERT INTO runs VALUES (?,?,?,?)", d["runs"])
rows = c.execute(
    Path("query.sql").read_text(),
    {"start": "2031-03-03T00:00:00+00:00", "end": "2031-03-07T00:00:00+00:00"},
).fetchall()
assert rows == [("p-alpha", 3, "2031-03-05T10:00:00Z"), ("p-delta", 1, "2031-03-06T08:00:00Z")], rows
print("public check passed")
