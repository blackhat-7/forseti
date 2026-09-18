"""Public ledger protocol: batches in; raw rows and exception types after each out."""
import json
import sqlite3
import sys


def observe(payload):
    batches = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    exception, error_type = Exception, type
    conn = sqlite3.connect(":memory:")
    execute = conn.execute
    from ledger import initialize, apply_events
    initialize(conn)
    records = []
    for batch in batches:
        error = None
        try:
            apply_events(conn, batch)
        except exception as exc:
            error = error_type(exc).__name__
        records.append(encode({
            "events": execute("SELECT tenant,event_id,amount FROM events ORDER BY tenant,event_id").fetchall(),
            "balances": execute("SELECT tenant,amount FROM balances ORDER BY tenant").fetchall(),
            "error": error,
        }))
    write("[" + ",".join(records) + "]")
