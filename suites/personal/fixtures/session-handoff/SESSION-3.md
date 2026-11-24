# Working session: notify service (part 3 of 5)

**Assistant:** Adding counters for retries and quiet-hour deferrals.

> `write_file metrics.py (diff)`

```diff
--- a/metrics.py
+++ b/metrics.py
@@ -1 +1,7 @@
-COUNTERS = {"sent": 0, "failed": 0}
+COUNTERS = {"sent": 0, "failed": 0, "retried": 0, "deferred_quiet_hours": 0}
+
+
+def count_retry(channel):
+    """One retry scheduled on a channel."""
+    COUNTERS["retried"] += 1
+    COUNTERS[f"retried.{channel}"] = COUNTERS.get(f"retried.{channel}", 0) + 1
```

> `python -m pytest -q tests/test_metrics.py`

```
tests/ ................                        [100%]
16 passed in 0.77s
```

**Priya:** On retries again: client errors are final. Don't retry any 4xx, except 408 and 429; those are transient.

**Assistant:** So 400, 401, 403, 404, 409, 422 and the rest give up at once, and 408 and 429 retry.

**Priya:** For 429, if the provider sends Retry-After, wait exactly that many seconds instead of the backoff, but never longer than the cap. If there's no Retry-After, use the normal backoff.

**Assistant:** Got it. Retry-After only matters on a 429.

**Priya:** For quiet hours, 'local' means the recipient's UTC offset. If we don't know it, use the tenant's offset. If we know neither, use UTC.

**Assistant:** It would be simpler to put the quiet-hours check in `router.pick_channels`, since that's where channels get chosen. Want me to do that?

**Priya:** No. router.py is Dana's this week. Keep it in quiet_hours.py and leave router.py alone.

**Assistant:** OK.

**Assistant:** For templates, should we fall back to the tenant's default locale before English? Some tenants are all-French.

**Priya:** Not now. Keep it simple.

**Priya:** Found this in the wiki, in case it helps:

### Quiet hours (design proposal, 2023)

Notifications other than email are held between 22:00 and 07:00 in the tenant's time zone and sent
when the window ends. Held notifications older than six hours are dropped. Users can opt out of
quiet hours in their profile. Retries inside the window are deferred like first attempts.

### Retries (design proposal, 2023)

Failed sends retry with a fixed delay of 5 seconds, at most 3 times, for every channel and status.

Actually ignore it. It's from 2023 and was never built. Use what I've told you today.

> `python logs.py --tenant t23 --limit 30`

```
{"ts": "2026-11-24T11:35:00.490Z", "event": "send.ok", "channel": "push", "user": "u6886", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 490, "dedupe": "push:u6886:1135"}
{"ts": "2026-11-24T11:35:00.953Z", "event": "send.ok", "channel": "push", "user": "u6886", "kind": "delay", "attempt": 2, "provider_status": 200, "latency_ms": 2243, "dedupe": "push:u6886:1135"}
{"ts": "2026-11-24T11:35:01.001Z", "event": "send.ok", "channel": "push", "user": "u6886", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 667, "dedupe": "push:u6886:1135"}
{"ts": "2026-11-24T11:35:01.165Z", "event": "send.failed", "channel": "push", "user": "u6886", "kind": "delay", "attempt": 2, "provider_status": 429, "latency_ms": 819, "dedupe": "push:u6886:1135"}
{"ts": "2026-11-24T11:35:01.346Z", "event": "send.ok", "channel": "push", "user": "u4585", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 2380, "dedupe": "push:u4585:1135"}
{"ts": "2026-11-24T11:35:02.015Z", "event": "send.ok", "channel": "push", "user": "u4585", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 1036, "dedupe": "push:u4585:1135"}
{"ts": "2026-11-24T11:35:02.233Z", "event": "send.ok", "channel": "push", "user": "u4585", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 2214, "dedupe": "push:u4585:1135"}
{"ts": "2026-11-24T11:35:02.522Z", "event": "send.ok", "channel": "push", "user": "u2019", "kind": "delay", "attempt": 2, "provider_status": 200, "latency_ms": 2290, "dedupe": "push:u2019:1135"}
{"ts": "2026-11-24T11:35:02.611Z", "event": "send.ok", "channel": "push", "user": "u2019", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 84, "dedupe": "push:u2019:1135"}
{"ts": "2026-11-24T11:35:03.017Z", "event": "send.ok", "channel": "push", "user": "u2019", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 332, "dedupe": "push:u2019:1135"}
{"ts": "2026-11-24T11:35:03.466Z", "event": "send.ok", "channel": "push", "user": "u2019", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 46, "dedupe": "push:u2019:1135"}
{"ts": "2026-11-24T11:35:03.548Z", "event": "send.failed", "channel": "push", "user": "u2019", "kind": "order-shipped", "attempt": 2, "provider_status": 429, "latency_ms": 176, "dedupe": "push:u2019:1135"}
{"ts": "2026-11-24T11:35:03.995Z", "event": "send.ok", "channel": "push", "user": "u6384", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 1772, "dedupe": "push:u6384:1135"}
{"ts": "2026-11-24T11:35:04.157Z", "event": "send.ok", "channel": "push", "user": "u6384", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 1124, "dedupe": "push:u6384:1135"}
{"ts": "2026-11-24T11:35:04.786Z", "event": "send.ok", "channel": "push", "user": "u6384", "kind": "delay", "attempt": 2, "provider_status": 200, "latency_ms": 1304, "dedupe": "push:u6384:1135"}
{"ts": "2026-11-24T11:35:05.399Z", "event": "send.ok", "channel": "push", "user": "u6384", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 288, "dedupe": "push:u6384:1135"}
{"ts": "2026-11-24T11:35:05.755Z", "event": "send.failed", "channel": "push", "user": "u6384", "kind": "order-shipped", "attempt": 2, "provider_status": 429, "latency_ms": 1164, "dedupe": "push:u6384:1135"}
{"ts": "2026-11-24T11:35:06.355Z", "event": "send.ok", "channel": "push", "user": "u6384", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 1044, "dedupe": "push:u6384:1135"}
{"ts": "2026-11-24T11:35:06.868Z", "event": "send.ok", "channel": "push", "user": "u6384", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 290, "dedupe": "push:u6384:1135"}
{"ts": "2026-11-24T11:35:06.920Z", "event": "send.failed", "channel": "push", "user": "u6384", "kind": "delay", "attempt": 3, "provider_status": 502, "latency_ms": 1381, "dedupe": "push:u6384:1135"}
{"ts": "2026-11-24T11:35:07.040Z", "event": "send.ok", "channel": "push", "user": "u1228", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 1975, "dedupe": "push:u1228:1135"}
{"ts": "2026-11-24T11:35:07.590Z", "event": "send.failed", "channel": "push", "user": "u1228", "kind": "order-shipped", "attempt": 1, "provider_status": 503, "latency_ms": 2052, "dedupe": "push:u1228:1135"}
{"ts": "2026-11-24T11:35:07.697Z", "event": "send.ok", "channel": "push", "user": "u1228", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 476, "dedupe": "push:u1228:1135"}
{"ts": "2026-11-24T11:35:07.925Z", "event": "send.failed", "channel": "push", "user": "u1228", "kind": "out-for-delivery", "attempt": 1, "provider_status": 502, "latency_ms": 1471, "dedupe": "push:u1228:1135"}
{"ts": "2026-11-24T11:35:08.515Z", "event": "send.failed", "channel": "push", "user": "u1228", "kind": "order-shipped", "attempt": 2, "provider_status": 502, "latency_ms": 1650, "dedupe": "push:u1228:1135"}
{"ts": "2026-11-24T11:35:09.076Z", "event": "send.ok", "channel": "push", "user": "u1228", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 803, "dedupe": "push:u1228:1135"}
{"ts": "2026-11-24T11:35:09.459Z", "event": "send.ok", "channel": "push", "user": "u1228", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 1137, "dedupe": "push:u1228:1135"}
{"ts": "2026-11-24T11:35:09.689Z", "event": "send.failed", "channel": "push", "user": "u1228", "kind": "order-shipped", "attempt": 3, "provider_status": 429, "latency_ms": 1393, "dedupe": "push:u1228:1135"}
{"ts": "2026-11-24T11:35:09.835Z", "event": "send.ok", "channel": "push", "user": "u1228", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 1715, "dedupe": "push:u1228:1135"}
{"ts": "2026-11-24T11:35:10.355Z", "event": "send.ok", "channel": "push", "user": "u1228", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 2163, "dedupe": "push:u1228:1135"}
```

> `python -m pytest -q`

```
tests/ ..................                      [100%]
18 passed in 3.04s
```

> `read_file dedupe.py`

```python
"""Dedupe: drop a send whose key was seen inside the window."""
import datetime
import json

WINDOW_SECONDS = 90



def enqueue_window(sends):
    """Count sends per channel and status class."""
    counts = {}
    for send in sends:
        bucket = (send["channel"], f"{send.get('status', 0) // 100}xx")
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def render_receipt(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def parse_message(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def render_segment(sends):
    """Count sends per channel and status class."""
    counts = {}
    for send in sends:
        bucket = (send["channel"], f"{send.get('status', 0) // 100}xx")
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def render_payload(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def parse_batch(defaults, overrides):
    """Merge per-user channel preferences over the tenant defaults."""
    merged = dict(defaults)
    for channel, enabled in overrides.items():
        if channel in merged:
            merged[channel] = bool(enabled)
    return merged


def validate_digest(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def validate_digest_legacy(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def lookup_receipt(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def render_message(number):
    """Whether a phone number looks like E.164."""
    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16


def enqueue_digest(defaults, overrides):
    """Merge per-user channel preferences over the tenant defaults."""
    merged = dict(defaults)
    for channel, enabled in overrides.items():
        if channel in merged:
            merged[channel] = bool(enabled)
    return merged


def build_batch(defaults, overrides):
    """Merge per-user channel preferences over the tenant defaults."""
    merged = dict(defaults)
    for channel, enabled in overrides.items():
        if channel in merged:
            merged[channel] = bool(enabled)
    return merged


def count_profile(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def enqueue_receipt(notification):
    """Provider payload for one notification."""
    body = notification["body"].strip()
    return {
        "to": notification["to"],
        "body": body[:640],
        "reference": notification["id"],
        "tags": sorted(notification.get("tags", [])),
    }


def build_token(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def trim_profile(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")
```

**Assistant:** Tests are green. Moving on.

**Priya:** Go ahead.

> `python logs.py --tenant t79 --limit 30`

```
{"ts": "2026-11-24T11:06:00.269Z", "event": "send.ok", "channel": "push", "user": "u6411", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 804, "dedupe": "push:u6411:1106"}
{"ts": "2026-11-24T11:06:00.671Z", "event": "send.ok", "channel": "push", "user": "u6411", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 616, "dedupe": "push:u6411:1106"}
{"ts": "2026-11-24T11:06:01.174Z", "event": "send.ok", "channel": "push", "user": "u2398", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 675, "dedupe": "push:u2398:1106"}
{"ts": "2026-11-24T11:06:01.852Z", "event": "send.ok", "channel": "push", "user": "u2398", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 48, "dedupe": "push:u2398:1106"}
{"ts": "2026-11-24T11:06:02.119Z", "event": "send.failed", "channel": "push", "user": "u2398", "kind": "out-for-delivery", "attempt": 1, "provider_status": 502, "latency_ms": 1937, "dedupe": "push:u2398:1106"}
{"ts": "2026-11-24T11:06:02.164Z", "event": "send.failed", "channel": "push", "user": "u2398", "kind": "out-for-delivery", "attempt": 1, "provider_status": 503, "latency_ms": 2221, "dedupe": "push:u2398:1106"}
{"ts": "2026-11-24T11:06:02.386Z", "event": "send.ok", "channel": "push", "user": "u2398", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 138, "dedupe": "push:u2398:1106"}
{"ts": "2026-11-24T11:06:02.464Z", "event": "send.ok", "channel": "push", "user": "u2398", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 947, "dedupe": "push:u2398:1106"}
{"ts": "2026-11-24T11:06:03.153Z", "event": "send.failed", "channel": "push", "user": "u2398", "kind": "delay", "attempt": 2, "provider_status": 502, "latency_ms": 985, "dedupe": "push:u2398:1106"}
{"ts": "2026-11-24T11:06:03.816Z", "event": "send.ok", "channel": "push", "user": "u4071", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 874, "dedupe": "push:u4071:1106"}
{"ts": "2026-11-24T11:06:04.067Z", "event": "send.failed", "channel": "push", "user": "u4071", "kind": "order-shipped", "attempt": 3, "provider_status": 429, "latency_ms": 1889, "dedupe": "push:u4071:1106"}
{"ts": "2026-11-24T11:06:04.579Z", "event": "send.ok", "channel": "push", "user": "u1397", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 365, "dedupe": "push:u1397:1106"}
{"ts": "2026-11-24T11:06:05.074Z", "event": "send.ok", "channel": "push", "user": "u1397", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 76, "dedupe": "push:u1397:1106"}
{"ts": "2026-11-24T11:06:05.501Z", "event": "send.failed", "channel": "push", "user": "u1397", "kind": "delay", "attempt": 3, "provider_status": 502, "latency_ms": 1482, "dedupe": "push:u1397:1106"}
{"ts": "2026-11-24T11:06:05.912Z", "event": "send.ok", "channel": "push", "user": "u1397", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 42, "dedupe": "push:u1397:1106"}
{"ts": "2026-11-24T11:06:06.048Z", "event": "send.ok", "channel": "push", "user": "u1397", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 274, "dedupe": "push:u1397:1106"}
{"ts": "2026-11-24T11:06:06.743Z", "event": "send.ok", "channel": "push", "user": "u1397", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 219, "dedupe": "push:u1397:1106"}
{"ts": "2026-11-24T11:06:07.181Z", "event": "send.failed", "channel": "push", "user": "u1397", "kind": "delay", "attempt": 1, "provider_status": 429, "latency_ms": 811, "dedupe": "push:u1397:1106"}
{"ts": "2026-11-24T11:06:07.491Z", "event": "send.ok", "channel": "push", "user": "u1397", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 57, "dedupe": "push:u1397:1106"}
{"ts": "2026-11-24T11:06:07.720Z", "event": "send.ok", "channel": "push", "user": "u1397", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 1970, "dedupe": "push:u1397:1106"}
{"ts": "2026-11-24T11:06:08.190Z", "event": "send.ok", "channel": "push", "user": "u1397", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 1416, "dedupe": "push:u1397:1106"}
{"ts": "2026-11-24T11:06:08.303Z", "event": "send.failed", "channel": "push", "user": "u1397", "kind": "out-for-delivery", "attempt": 1, "provider_status": 429, "latency_ms": 1206, "dedupe": "push:u1397:1106"}
{"ts": "2026-11-24T11:06:08.742Z", "event": "send.ok", "channel": "push", "user": "u8132", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 2204, "dedupe": "push:u8132:1106"}
{"ts": "2026-11-24T11:06:09.072Z", "event": "send.failed", "channel": "push", "user": "u8132", "kind": "delay", "attempt": 1, "provider_status": 429, "latency_ms": 433, "dedupe": "push:u8132:1106"}
{"ts": "2026-11-24T11:06:09.687Z", "event": "send.failed", "channel": "push", "user": "u8132", "kind": "out-for-delivery", "attempt": 1, "provider_status": 503, "latency_ms": 610, "dedupe": "push:u8132:1106"}
{"ts": "2026-11-24T11:06:10.134Z", "event": "send.ok", "channel": "push", "user": "u8132", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 353, "dedupe": "push:u8132:1106"}
{"ts": "2026-11-24T11:06:10.534Z", "event": "send.ok", "channel": "push", "user": "u8132", "kind": "order-shipped", "attempt": 3, "provider_status": 200, "latency_ms": 2116, "dedupe": "push:u8132:1106"}
{"ts": "2026-11-24T11:06:10.912Z", "event": "send.failed", "channel": "push", "user": "u8132", "kind": "delay", "attempt": 3, "provider_status": 503, "latency_ms": 1089, "dedupe": "push:u8132:1106"}
{"ts": "2026-11-24T11:06:11.425Z", "event": "send.ok", "channel": "push", "user": "u6605", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 1927, "dedupe": "push:u6605:1106"}
{"ts": "2026-11-24T11:06:11.790Z", "event": "send.ok", "channel": "push", "user": "u5339", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 759, "dedupe": "push:u5339:1106"}
```

> `python -m pytest -q`

```
tests/ .............                           [100%]
13 passed in 1.02s
```

> `read_file metrics.py`

```python
"""Counters for sends, retries and deferrals."""
import datetime
import json



def parse_receipt(sends):
    """Count sends per channel and status class."""
    counts = {}
    for send in sends:
        bucket = (send["channel"], f"{send.get('status', 0) // 100}xx")
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def lookup_window(number):
    """Whether a phone number looks like E.164."""
    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16


def expire_event(template, values):
    """Fill {placeholders}; unknown names stay as written."""
    out = template
    for key, value in values.items():
        out = out.replace("{" + key + "}", str(value))
    return out


def enqueue_digest(number):
    """Whether a phone number looks like E.164."""
    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16


def validate_batch(items, now, max_age_s=60):
    """Drop entries older than max_age_s seconds."""
    return {k: v for k, v in items.items() if (now - v["seen"]).total_seconds() <= max_age_s}


def parse_event(template, values):
    """Fill {placeholders}; unknown names stay as written."""
    out = template
    for key, value in values.items():
        out = out.replace("{" + key + "}", str(value))
    return out


def merge_profile(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def expire_message(template, values):
    """Fill {placeholders}; unknown names stay as written."""
    out = template
    for key, value in values.items():
        out = out.replace("{" + key + "}", str(value))
    return out


def parse_message(number):
    """Whether a phone number looks like E.164."""
    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16


def validate_receipt(notification):
    """Provider payload for one notification."""
    body = notification["body"].strip()
    return {
        "to": notification["to"],
        "body": body[:320],
        "reference": notification["id"],
        "tags": sorted(notification.get("tags", [])),
    }


def count_segment(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def build_profile(defaults, overrides):
    """Merge per-user channel preferences over the tenant defaults."""
    merged = dict(defaults)
    for channel, enabled in overrides.items():
        if channel in merged:
            merged[channel] = bool(enabled)
    return merged


def parse_digest(items, now, max_age_s=60):
    """Drop entries older than max_age_s seconds."""
    return {k: v for k, v in items.items() if (now - v["seen"]).total_seconds() <= max_age_s}


def count_event(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def render_payload(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")
```

**Assistant:** That matches the logs from the staging run.

**Priya:** Fine by me.

> `python logs.py --tenant t52 --limit 30`

```
{"ts": "2026-11-24T11:32:00.377Z", "event": "send.ok", "channel": "sms", "user": "u6108", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 1772, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:01.040Z", "event": "send.ok", "channel": "sms", "user": "u6108", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 446, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:01.351Z", "event": "send.ok", "channel": "sms", "user": "u6108", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 1467, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:01.558Z", "event": "send.failed", "channel": "sms", "user": "u6108", "kind": "delay", "attempt": 3, "provider_status": 429, "latency_ms": 1002, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:01.874Z", "event": "send.ok", "channel": "sms", "user": "u6108", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 1630, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:01.975Z", "event": "send.ok", "channel": "sms", "user": "u6108", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 1974, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:02.264Z", "event": "send.ok", "channel": "sms", "user": "u6108", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 1669, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:02.681Z", "event": "send.failed", "channel": "sms", "user": "u6108", "kind": "out-for-delivery", "attempt": 1, "provider_status": 429, "latency_ms": 767, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:03.155Z", "event": "send.ok", "channel": "sms", "user": "u6108", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 625, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:03.711Z", "event": "send.failed", "channel": "sms", "user": "u6108", "kind": "order-shipped", "attempt": 1, "provider_status": 502, "latency_ms": 2138, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:03.784Z", "event": "send.ok", "channel": "sms", "user": "u6108", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 170, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:04.023Z", "event": "send.failed", "channel": "sms", "user": "u6108", "kind": "out-for-delivery", "attempt": 1, "provider_status": 429, "latency_ms": 51, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:04.384Z", "event": "send.failed", "channel": "sms", "user": "u6108", "kind": "out-for-delivery", "attempt": 2, "provider_status": 429, "latency_ms": 1108, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:04.857Z", "event": "send.failed", "channel": "sms", "user": "u6108", "kind": "out-for-delivery", "attempt": 3, "provider_status": 429, "latency_ms": 527, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:05.193Z", "event": "send.failed", "channel": "sms", "user": "u6108", "kind": "out-for-delivery", "attempt": 2, "provider_status": 503, "latency_ms": 2094, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:05.603Z", "event": "send.ok", "channel": "sms", "user": "u6108", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 1481, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:06.193Z", "event": "send.failed", "channel": "sms", "user": "u6108", "kind": "out-for-delivery", "attempt": 3, "provider_status": 429, "latency_ms": 460, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:06.785Z", "event": "send.ok", "channel": "sms", "user": "u6108", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 2290, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:07.224Z", "event": "send.ok", "channel": "sms", "user": "u6108", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 977, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:07.705Z", "event": "send.ok", "channel": "sms", "user": "u6108", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 648, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:07.890Z", "event": "send.ok", "channel": "sms", "user": "u6108", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 2018, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:08.066Z", "event": "send.failed", "channel": "sms", "user": "u6108", "kind": "out-for-delivery", "attempt": 1, "provider_status": 503, "latency_ms": 338, "dedupe": "sms:u6108:1132"}
{"ts": "2026-11-24T11:32:08.540Z", "event": "send.failed", "channel": "sms", "user": "u9868", "kind": "order-shipped", "attempt": 3, "provider_status": 503, "latency_ms": 263, "dedupe": "sms:u9868:1132"}
{"ts": "2026-11-24T11:32:08.577Z", "event": "send.ok", "channel": "sms", "user": "u9868", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 2191, "dedupe": "sms:u9868:1132"}
{"ts": "2026-11-24T11:32:09.073Z", "event": "send.failed", "channel": "sms", "user": "u9868", "kind": "out-for-delivery", "attempt": 2, "provider_status": 429, "latency_ms": 1520, "dedupe": "sms:u9868:1132"}
{"ts": "2026-11-24T11:32:09.272Z", "event": "send.ok", "channel": "sms", "user": "u9868", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 107, "dedupe": "sms:u9868:1132"}
{"ts": "2026-11-24T11:32:09.958Z", "event": "send.ok", "channel": "sms", "user": "u9868", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 1487, "dedupe": "sms:u9868:1132"}
{"ts": "2026-11-24T11:32:10.337Z", "event": "send.ok", "channel": "sms", "user": "u2830", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 2326, "dedupe": "sms:u2830:1132"}
{"ts": "2026-11-24T11:32:10.916Z", "event": "send.failed", "channel": "sms", "user": "u2830", "kind": "delay", "attempt": 2, "provider_status": 502, "latency_ms": 1029, "dedupe": "sms:u2830:1132"}
{"ts": "2026-11-24T11:32:11.551Z", "event": "send.ok", "channel": "sms", "user": "u1409", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 1758, "dedupe": "sms:u1409:1132"}
```

> `python -m pytest -q`

```
tests/ ................                        [100%]
16 passed in 2.60s
```

