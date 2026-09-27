from sla import breaches

tickets = [
    {"id": "T-101", "opened": "2031-05-02T08:00:00+00:00", "resolved": "2031-05-02T11:00:00+00:00"},
    {"id": "T-102", "opened": "2031-05-02T01:00:00+00:00", "resolved": "2031-05-02T06:30:00+00:00"},
    {"id": "T-103", "opened": "2031-05-02T09:00:00+00:00", "resolved": None},
    {"id": "T-104", "opened": "2031-05-02T06:00:00+00:00", "resolved": None},
]
late = breaches(tickets, 4, "2031-05-02T12:00:00+00:00")
assert late == ["T-102", "T-104"], late
print("public check passed")
