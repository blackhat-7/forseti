"""Public SQL protocol: runs, supersedes, ignored rows and parameter sets in; results and tables out."""
import json
import sqlite3
import sys

SCHEMA = (
    "CREATE TABLE runs(id INTEGER PRIMARY KEY, profile TEXT, finished_at TEXT, status TEXT);"
    "CREATE TABLE supersedes(failed_id INTEGER, retry_id INTEGER);"
    "CREATE TABLE ignored(profile TEXT);"
)


def observe(payload):
    request = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    exception, error_type = Exception, type
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    conn.executemany("INSERT INTO runs VALUES (?,?,?,?)", request["runs"])
    conn.executemany("INSERT INTO supersedes VALUES (?,?)", request["supersedes"])
    conn.executemany("INSERT INTO ignored VALUES (?)", request["ignored"])
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
            "ignored": conn.execute("SELECT * FROM ignored ORDER BY rowid").fetchall(),
        }))
    write("[" + ",".join(records) + "]")
