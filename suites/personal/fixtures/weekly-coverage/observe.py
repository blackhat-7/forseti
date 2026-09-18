"""Public SQL protocol: jobs, metrics, parameter sets in; results and tables out."""
import json
import sqlite3
import sys


def observe(payload):
    request = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    exception, error_type = Exception, type
    conn = sqlite3.connect(":memory:")
    conn.executescript("CREATE TABLE jobs(id INTEGER PRIMARY KEY, finished_at TEXT, deleted INTEGER); CREATE TABLE metrics(job_id INTEGER, name TEXT);")
    conn.executemany("INSERT INTO jobs VALUES (?,?,?)", request["jobs"])
    conn.executemany("INSERT INTO metrics VALUES (?,?)", request["metrics"])
    with open("query.sql") as handle:
        sql = handle.read()
    records = []
    for params in request["params"]:
        rows, error = None, None
        try:
            rows = conn.execute(sql, params).fetchall()
        except exception as exc:
            error = error_type(exc).__name__
        records.append(encode({"rows": rows, "error": error,
                               "jobs": conn.execute("SELECT * FROM jobs ORDER BY id").fetchall(),
                               "metrics": conn.execute("SELECT * FROM metrics ORDER BY rowid").fetchall()}))
    write("[" + ",".join(records) + "]")
