"""Public worker protocol: deliveries in; return value, exception type, outbox rows and transaction state after each out."""
import json
import sqlite3
import sys


def observe(payload):
    deliveries = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    exception, error_type = Exception, type
    conn = sqlite3.connect(":memory:")
    execute = conn.execute
    from worker import initialize, handle
    initialize(conn)
    records = []
    for delivery in deliveries:
        returned, error = None, None
        try:
            returned = handle(conn, delivery)
        except exception as exc:
            error = error_type(exc).__name__
        records.append(encode({
            "returned": returned,
            "error": error,
            "outbox": execute("SELECT job, amount FROM outbox ORDER BY rowid").fetchall(),
            "open": conn.in_transaction,
        }))
    write("[" + ",".join(records) + "]")
