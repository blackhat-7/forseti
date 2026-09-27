import sqlite3
from worker import initialize, handle

conn = sqlite3.connect(":memory:")
initialize(conn)
d = {"delivery": "d-1", "job": "j-1", "amount": 5}
assert handle(conn, d) is True
assert handle(conn, d) is False
assert handle(conn, {"delivery": "d-2", "job": "j-2", "amount": 3}) is True
assert conn.execute("SELECT job, amount FROM outbox ORDER BY job").fetchall() == [("j-1", 5), ("j-2", 3)]
print("public check passed")
