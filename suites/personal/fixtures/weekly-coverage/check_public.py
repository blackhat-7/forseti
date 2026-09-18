import json, sqlite3
from pathlib import Path
c=sqlite3.connect(":memory:")
c.executescript("CREATE TABLE jobs(id INTEGER PRIMARY KEY, finished_at TEXT, deleted INTEGER); CREATE TABLE metrics(job_id INTEGER, name TEXT);")
d=json.loads(Path("data.json").read_text())
c.executemany("INSERT INTO jobs VALUES (?,?,?)",d["jobs"])
c.executemany("INSERT INTO metrics VALUES (?,?)",d["metrics"])
rows=c.execute(Path("query.sql").read_text(),{"start":"2031-01-06T00:00:00Z","end":"2031-01-20T00:00:00Z"}).fetchall()
assert rows == [("2031-01-06",3,2),("2031-01-13",1,1)], rows
print("public check passed")
