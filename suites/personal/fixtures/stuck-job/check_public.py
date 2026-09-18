import json, sqlite3
from pathlib import Path
c = sqlite3.connect(":memory:")
c.executescript("CREATE TABLE jobs(job TEXT, attempt INTEGER, state TEXT, updated_at TEXT);"
                "CREATE TABLE queue(job TEXT, attempt INTEGER, event TEXT, at TEXT);"
                "CREATE TABLE store(job TEXT, attempt INTEGER, artifact TEXT);")
d = json.loads(Path("data.json").read_text())
c.executemany("INSERT INTO jobs VALUES (?,?,?,?)", d["jobs"])
c.executemany("INSERT INTO queue VALUES (?,?,?,?)", d["queue"])
c.executemany("INSERT INTO store VALUES (?,?,?)", d["store"])
rows = c.execute(Path("query.sql").read_text(),
                 {"now": "2031-06-11T12:00:00+00:00", "lease": 600}).fetchall()
assert rows == [("job-cedar", "done"), ("job-hazel", "queued"), ("job-ivory", "running")], rows
print("public check passed")
