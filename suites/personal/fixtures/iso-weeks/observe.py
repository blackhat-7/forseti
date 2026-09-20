"""Public SQL protocol: deploys rows and parameter sets in; results and table out."""
import json
import sqlite3
import sys

SCHEMA = "CREATE TABLE deploys(id INTEGER PRIMARY KEY, service TEXT, deployed_at TEXT);"


def observe(payload):
    request = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    exception, error_type = Exception, type
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    conn.executemany("INSERT INTO deploys VALUES (?,?,?)", request["deploys"])
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
            "deploys": conn.execute("SELECT * FROM deploys ORDER BY id").fetchall(),
        }))
    write("[" + ",".join(records) + "]")
