"""Site settings. None of these sites observes daylight saving, so each offset is fixed."""

SITES = {
    "HBR": {"name": "Harbour", "offset_minutes": 330, "open_hour": 8, "close_hour": 18},
    "NGT": {"name": "Northgate", "offset_minutes": -240, "open_hour": 8, "close_hour": 18},
    "WST": {"name": "Westmere", "offset_minutes": -480, "open_hour": 8, "close_hour": 18},
    "KST": {"name": "Kestrel", "offset_minutes": 0, "open_hour": 8, "close_hour": 18},
}

# Production storage is read a page at a time. Small pages keep that path exercised.
PAGE_SIZE = 3
