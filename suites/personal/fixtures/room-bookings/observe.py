"""Public scenario protocol. No expected answers or verdicts live here.

Input: a list of steps run in order against one fresh app.Service().
  {"op": "book", "room": ..., "who": ..., "at": ..., "hours": n}
  {"op": "cancel", "id": n}
  {"op": "free", "room": ..., "day": "YYYY-MM-DD"}
  {"op": "report", "site": ..., "day": "YYYY-MM-DD"}
  {"op": "confirm", "id": n}
  {"op": "pages", "site": ..., "start": UTC instant, "end": UTC instant, "limit": n}
     follows repository.page_for_site cursors and returns the booking ids of each page.
Output: one {"value": raw result, "error": exception type name or null} per step.
"""
import json
import sys
from datetime import datetime


def observe(payload):
    steps = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    exception, error_type, parse = Exception, type, datetime.fromisoformat
    from app import Service
    service = Service()

    def pages(step):
        start, end, found, after = parse(step["start"]), parse(step["end"]), [], None
        for _ in range(50):
            rows, after = service.repository.page_for_site(step["site"], start, end, after, step["limit"])
            found.append([row.booking_id for row in rows])
            if after is None:
                return found
        raise RuntimeError("more than 50 pages")

    run = {
        "book": lambda s: service.book(s["room"], s["who"], s["at"], s.get("hours", 1)),
        "cancel": lambda s: service.cancel(s["id"]),
        "free": lambda s: service.free_slots(s["room"], s["day"]),
        "report": lambda s: service.day_report(s["site"], s["day"]),
        "confirm": lambda s: service.confirmation(s["id"]),
        "pages": pages,
    }
    records = []
    for step in steps:
        value, error = None, None
        try:
            value = run[step["op"]](step)
        except exception as exc:
            error = error_type(exc).__name__
        records.append(encode({"value": value, "error": error}))
    write("[" + ",".join(records) + "]")
