"""Public SQL protocol: invoices, payments rows and parameter sets in; results and tables out."""
import json
import sqlite3
import sys

SCHEMA = (
    "CREATE TABLE invoices(id INTEGER PRIMARY KEY, issued_at TEXT, amount INTEGER);"
    "CREATE TABLE payments(invoice_id INTEGER, paid_at TEXT, amount INTEGER);"
)


def observe(payload):
    request = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    exception, error_type = Exception, type
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    conn.executemany("INSERT INTO invoices VALUES (?,?,?)", request["invoices"])
    conn.executemany("INSERT INTO payments VALUES (?,?,?)", request["payments"])
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
            "invoices": conn.execute("SELECT * FROM invoices ORDER BY id").fetchall(),
            "payments": conn.execute("SELECT * FROM payments ORDER BY rowid").fetchall(),
        }))
    write("[" + ",".join(records) + "]")
