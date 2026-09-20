import json, sqlite3
from pathlib import Path

c = sqlite3.connect(":memory:")
c.executescript(
    "CREATE TABLE invoices(id INTEGER PRIMARY KEY, issued_at TEXT, amount INTEGER);"
    "CREATE TABLE payments(invoice_id INTEGER, paid_at TEXT, amount INTEGER);"
)
d = json.loads(Path("data.json").read_text())
c.executemany("INSERT INTO invoices VALUES (?,?,?)", d["invoices"])
c.executemany("INSERT INTO payments VALUES (?,?,?)", d["payments"])
rows = c.execute(Path("query.sql").read_text(), {"asof": "2031-05-01T00:00:00+00:00"}).fetchall()
assert rows == [(1, "2031-03-10", 6000), (4, "2031-04-12", 7000)], rows
print("public check passed")
