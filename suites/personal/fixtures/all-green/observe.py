"""Public SQL protocol: runs rows and parameter sets in; results and table out."""
import json
import sqlite3
import sys

SCHEMA = "CREATE TABLE runs(id INTEGER PRIMARY KEY, profile TEXT, finished_at TEXT, status TEXT);"


def observe(payload):
    request = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    exception, error_type = Exception, type
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    conn.executemany("INSERT INTO runs VALUES (?,?,?,?)", request["runs"])
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
            "runs": conn.execute("SELECT * FROM runs ORDER BY id").fetchall(),
        }))
    write("[" + ",".join(records) + "]")
