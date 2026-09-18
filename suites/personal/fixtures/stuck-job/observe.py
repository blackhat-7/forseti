"""Public SQL protocol: jobs, queue, store rows and parameter sets in; results and tables out."""
import json
import sqlite3
import sys

SCHEMA = (
    "CREATE TABLE jobs(job TEXT, attempt INTEGER, state TEXT, updated_at TEXT);"
    "CREATE TABLE queue(job TEXT, attempt INTEGER, event TEXT, at TEXT);"
    "CREATE TABLE store(job TEXT, attempt INTEGER, artifact TEXT);"
)


def observe(payload):
    request = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    exception, error_type = Exception, type
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    conn.executemany("INSERT INTO jobs VALUES (?,?,?,?)", request["jobs"])
    conn.executemany("INSERT INTO queue VALUES (?,?,?,?)", request["queue"])
    conn.executemany("INSERT INTO store VALUES (?,?,?)", request["store"])
    with open("query.sql") as handle:
        sql = handle.read()
    records = []
    for params in request["params"]:
        rows, error = None, None
        try:
            rows = conn.execute(sql, params).fetchall()
        except exception as exc:
            error = error_type(exc).__name__
        records.append(encode({
            "rows": rows, "error": error,
            "jobs": conn.execute("SELECT * FROM jobs ORDER BY job, attempt").fetchall(),
            "queue": conn.execute("SELECT * FROM queue ORDER BY rowid").fetchall(),
            "store": conn.execute("SELECT * FROM store ORDER BY rowid").fetchall(),
        }))
    write("[" + ",".join(records) + "]")
