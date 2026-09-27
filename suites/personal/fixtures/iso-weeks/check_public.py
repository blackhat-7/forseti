import json, sqlite3
from pathlib import Path

c = sqlite3.connect(":memory:")
c.executescript("CREATE TABLE deploys(id INTEGER PRIMARY KEY, service TEXT, deployed_at TEXT);")
d = json.loads(Path("data.json").read_text())
c.executemany("INSERT INTO deploys VALUES (?,?,?)", d["deploys"])
rows = c.execute(
    Path("query.sql").read_text(),
    {"start": "2033-03-07T00:00:00+00:00", "end": "2033-03-21T00:00:00+00:00"},
).fetchall()
assert rows == [("2033-W10", 3), ("2033-W11", 2)], rows
print("public check passed")
