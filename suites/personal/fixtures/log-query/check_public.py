from query import run_query

records = [
    {"status": 200, "path": "/home", "latency": 0.2, "user": "ana"},
    {"status": 500, "path": "/api/cart", "latency": 2.0, "user": "ben"},
    {"status": 502, "path": "/api/pay", "latency": 0.9},
]
cases = [
    ('status >= 500', {"matches": [1, 2]}),
    ('status = 500 or latency < 500ms', {"matches": [0, 1]}),
    ('path ~ "^/api" and not user = "ben"', {"matches": [2]}),
    ('status in (200, 502)', {"matches": [0, 2]}),
    ('status = ', {"error": {"code": "unexpected-end", "position": 9}}),
]
for query, expected in cases:
    got = run_query(query, records)
    assert got == expected, (query, got)
print("public check passed")
