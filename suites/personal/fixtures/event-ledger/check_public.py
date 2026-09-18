import sqlite3
from ledger import initialize, apply_events
conn = sqlite3.connect(":memory:")
initialize(conn)
e = {"tenant": "a", "event_id": "one", "amount": 3}
apply_events(conn, [e, e])
assert conn.execute("SELECT amount FROM balances").fetchone()[0] == 3
print("public check passed")
