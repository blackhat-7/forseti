# Working session: notify service (part 2 of 5)

**Assistant:** Back to the incident. Reading dedupe.py.

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

**Assistant:** Found it: `window_key` stamps the key with `created_at`. A retry keeps the original `created_at`, so a retry that lands after a timed-out first request passes dedupe. Fix: use `scheduled_at` and the attempt number.

> `write_file dedupe.py (diff)`

```diff
--- a/dedupe.py
+++ b/dedupe.py
@@ -1,4 +1,4 @@
 def window_key(send):
     """Key used to drop duplicate sends inside the window."""
-    stamp = send["created_at"].strftime("%Y%m%d%H%M")
-    return f"{send['kind']}:{send['user']}:{stamp}"
+    stamp = send["scheduled_at"].strftime("%Y%m%d%H%M")
+    return f"{send['kind']}:{send['user']}:{stamp}:{send['attempt']}"
```

> `python -m pytest -q tests/test_dedupe.py`

```
tests/ ..............                          [100%]
14 passed in 3.01s
```

**Priya:** Good. One more retry rule: cap any single wait at 30 seconds.

**Assistant:** Cap at 30 s, noted.

**Priya:** > **#billing-eng** (pasted)
> billing-svc now retries failed calls 8 times with exponential backoff, a 60 s cap and full jitter.
> We also retry 409s because our upstream returns them on lock contention.

FYI only. That's billing's service, not ours. Ours stays as we said.

**Assistant:** Understood; billing's policy doesn't change ours.

**Priya:** Quiet hours: push too. Email is fine any time of day.

**Assistant:** So SMS and push are blocked from 21:00 to 08:00 local, and email always goes out.

**Priya:** Templates: when the exact locale isn't available, fall back to the bare language, so fr-CA goes to fr, and then to en.

**Assistant:** Exact locale, then the language, then en.

**Priya:** Standard library only for all of this. No new dependencies.

> `python logs.py --tenant t53 --limit 30`

```
{"ts": "2026-11-24T10:59:00.128Z", "event": "send.failed", "channel": "push", "user": "u1582", "kind": "order-shipped", "attempt": 1, "provider_status": 429, "latency_ms": 692, "dedupe": "push:u1582:1059"}
{"ts": "2026-11-24T10:59:00.280Z", "event": "send.failed", "channel": "push", "user": "u1582", "kind": "delay", "attempt": 1, "provider_status": 502, "latency_ms": 182, "dedupe": "push:u1582:1059"}
{"ts": "2026-11-24T10:59:00.633Z", "event": "send.ok", "channel": "push", "user": "u1582", "kind": "order-shipped", "attempt": 3, "provider_status": 200, "latency_ms": 290, "dedupe": "push:u1582:1059"}
{"ts": "2026-11-24T10:59:01.070Z", "event": "send.ok", "channel": "push", "user": "u1582", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 924, "dedupe": "push:u1582:1059"}
{"ts": "2026-11-24T10:59:01.448Z", "event": "send.ok", "channel": "push", "user": "u4533", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 1801, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:01.700Z", "event": "send.failed", "channel": "push", "user": "u4533", "kind": "delay", "attempt": 3, "provider_status": 429, "latency_ms": 1839, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:02.136Z", "event": "send.ok", "channel": "push", "user": "u4533", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 1567, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:02.174Z", "event": "send.failed", "channel": "push", "user": "u4533", "kind": "out-for-delivery", "attempt": 1, "provider_status": 503, "latency_ms": 2344, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:02.723Z", "event": "send.ok", "channel": "push", "user": "u4533", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 794, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:02.870Z", "event": "send.failed", "channel": "push", "user": "u4533", "kind": "delay", "attempt": 1, "provider_status": 502, "latency_ms": 2332, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:03.193Z", "event": "send.ok", "channel": "push", "user": "u4533", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 1282, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:03.330Z", "event": "send.failed", "channel": "push", "user": "u4533", "kind": "order-shipped", "attempt": 3, "provider_status": 502, "latency_ms": 503, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:03.864Z", "event": "send.ok", "channel": "push", "user": "u4533", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 1475, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:03.901Z", "event": "send.ok", "channel": "push", "user": "u4533", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 1275, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:04.137Z", "event": "send.ok", "channel": "push", "user": "u4533", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 1283, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:04.599Z", "event": "send.failed", "channel": "push", "user": "u4533", "kind": "delay", "attempt": 1, "provider_status": 502, "latency_ms": 1339, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:04.895Z", "event": "send.failed", "channel": "push", "user": "u4533", "kind": "out-for-delivery", "attempt": 3, "provider_status": 429, "latency_ms": 699, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:05.077Z", "event": "send.ok", "channel": "push", "user": "u4533", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 1468, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:05.678Z", "event": "send.failed", "channel": "push", "user": "u4533", "kind": "delay", "attempt": 2, "provider_status": 502, "latency_ms": 410, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:05.870Z", "event": "send.failed", "channel": "push", "user": "u4533", "kind": "order-shipped", "attempt": 3, "provider_status": 429, "latency_ms": 1375, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:06.371Z", "event": "send.ok", "channel": "push", "user": "u4533", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 548, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:06.739Z", "event": "send.failed", "channel": "push", "user": "u4533", "kind": "delay", "attempt": 3, "provider_status": 503, "latency_ms": 136, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:07.407Z", "event": "send.ok", "channel": "push", "user": "u4533", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 2168, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:08.024Z", "event": "send.failed", "channel": "push", "user": "u4533", "kind": "order-shipped", "attempt": 2, "provider_status": 429, "latency_ms": 619, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:08.585Z", "event": "send.ok", "channel": "push", "user": "u4533", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 127, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:08.807Z", "event": "send.failed", "channel": "push", "user": "u4533", "kind": "out-for-delivery", "attempt": 1, "provider_status": 502, "latency_ms": 1121, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:09.248Z", "event": "send.ok", "channel": "push", "user": "u4533", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 987, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:09.725Z", "event": "send.failed", "channel": "push", "user": "u4533", "kind": "out-for-delivery", "attempt": 2, "provider_status": 503, "latency_ms": 83, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:10.125Z", "event": "send.failed", "channel": "push", "user": "u4533", "kind": "delay", "attempt": 2, "provider_status": 502, "latency_ms": 2155, "dedupe": "push:u4533:1059"}
{"ts": "2026-11-24T10:59:10.176Z", "event": "send.ok", "channel": "push", "user": "u4533", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 259, "dedupe": "push:u4533:1059"}
```

> `python -m pytest -q`

```
tests/ ..............                          [100%]
14 passed in 0.70s
```

> `read_file providers.py`

```python
"""Provider clients for the SMS gateway, push and email."""
import datetime
import json

TIMEOUT_S = 8



def merge_window(items, now, max_age_s=900):
    """Drop entries older than max_age_s seconds."""
    return {k: v for k, v in items.items() if (now - v["seen"]).total_seconds() <= max_age_s}


def enqueue_window(defaults, overrides):
    """Merge per-user channel preferences over the tenant defaults."""
    merged = dict(defaults)
    for channel, enabled in overrides.items():
        if channel in merged:
            merged[channel] = bool(enabled)
    return merged


def lookup_batch(notification):
    """Provider payload for one notification."""
    body = notification["body"].strip()
    return {
        "to": notification["to"],
        "body": body[:153],
        "reference": notification["id"],
        "tags": sorted(notification.get("tags", [])),
    }


def enqueue_profile(template, values):
    """Fill {placeholders}; unknown names stay as written."""
    out = template
    for key, value in values.items():
        out = out.replace("{" + key + "}", str(value))
    return out


def count_event(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def build_token(notification):
    """Provider payload for one notification."""
    body = notification["body"].strip()
    return {
        "to": notification["to"],
        "body": body[:320],
        "reference": notification["id"],
        "tags": sorted(notification.get("tags", [])),
    }


def enqueue_window_for_tenant(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def merge_payload(sends):
    """Count sends per channel and status class."""
    counts = {}
    for send in sends:
        bucket = (send["channel"], f"{send.get('status', 0) // 100}xx")
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def merge_token(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def expire_receipt(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def render_batch(items, now, max_age_s=3600):
    """Drop entries older than max_age_s seconds."""
    return {k: v for k, v in items.items() if (now - v["seen"]).total_seconds() <= max_age_s}


def build_payload(items, now, max_age_s=60):
    """Drop entries older than max_age_s seconds."""
    return {k: v for k, v in items.items() if (now - v["seen"]).total_seconds() <= max_age_s}


def lookup_message(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def enqueue_digest(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def count_receipt(template, values):
    """Fill {placeholders}; unknown names stay as written."""
    out = template
    for key, value in values.items():
        out = out.replace("{" + key + "}", str(value))
    return out


def render_receipt(items, now, max_age_s=900):
    """Drop entries older than max_age_s seconds."""
    return {k: v for k, v in items.items() if (now - v["seen"]).total_seconds() <= max_age_s}


def build_message(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"
```

**Assistant:** That matches the logs from the staging run.

**Priya:** Looks right.

> `python logs.py --tenant t66 --limit 30`

```
{"ts": "2026-11-24T10:59:00.578Z", "event": "send.ok", "channel": "email", "user": "u1043", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 1390, "dedupe": "email:u1043:1059"}
{"ts": "2026-11-24T10:59:01.148Z", "event": "send.failed", "channel": "email", "user": "u1043", "kind": "delay", "attempt": 1, "provider_status": 502, "latency_ms": 677, "dedupe": "email:u1043:1059"}
{"ts": "2026-11-24T10:59:01.664Z", "event": "send.ok", "channel": "email", "user": "u1043", "kind": "order-shipped", "attempt": 3, "provider_status": 200, "latency_ms": 804, "dedupe": "email:u1043:1059"}
{"ts": "2026-11-24T10:59:02.169Z", "event": "send.failed", "channel": "email", "user": "u1043", "kind": "delay", "attempt": 1, "provider_status": 503, "latency_ms": 1780, "dedupe": "email:u1043:1059"}
{"ts": "2026-11-24T10:59:02.261Z", "event": "send.ok", "channel": "email", "user": "u1043", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 1623, "dedupe": "email:u1043:1059"}
{"ts": "2026-11-24T10:59:02.929Z", "event": "send.ok", "channel": "email", "user": "u1043", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 758, "dedupe": "email:u1043:1059"}
{"ts": "2026-11-24T10:59:03.323Z", "event": "send.ok", "channel": "email", "user": "u1043", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 1557, "dedupe": "email:u1043:1059"}
{"ts": "2026-11-24T10:59:03.847Z", "event": "send.ok", "channel": "email", "user": "u1043", "kind": "delay", "attempt": 2, "provider_status": 200, "latency_ms": 982, "dedupe": "email:u1043:1059"}
{"ts": "2026-11-24T10:59:04.440Z", "event": "send.failed", "channel": "email", "user": "u1043", "kind": "delay", "attempt": 1, "provider_status": 429, "latency_ms": 2103, "dedupe": "email:u1043:1059"}
{"ts": "2026-11-24T10:59:05.002Z", "event": "send.failed", "channel": "email", "user": "u2716", "kind": "out-for-delivery", "attempt": 1, "provider_status": 502, "latency_ms": 876, "dedupe": "email:u2716:1059"}
{"ts": "2026-11-24T10:59:05.307Z", "event": "send.failed", "channel": "email", "user": "u2716", "kind": "delay", "attempt": 3, "provider_status": 503, "latency_ms": 1379, "dedupe": "email:u2716:1059"}
{"ts": "2026-11-24T10:59:05.470Z", "event": "send.ok", "channel": "email", "user": "u2716", "kind": "order-shipped", "attempt": 3, "provider_status": 200, "latency_ms": 1939, "dedupe": "email:u2716:1059"}
{"ts": "2026-11-24T10:59:05.831Z", "event": "send.failed", "channel": "email", "user": "u5073", "kind": "order-shipped", "attempt": 2, "provider_status": 503, "latency_ms": 199, "dedupe": "email:u5073:1059"}
{"ts": "2026-11-24T10:59:05.910Z", "event": "send.ok", "channel": "email", "user": "u5221", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 554, "dedupe": "email:u5221:1059"}
{"ts": "2026-11-24T10:59:06.368Z", "event": "send.failed", "channel": "email", "user": "u5221", "kind": "delay", "attempt": 3, "provider_status": 502, "latency_ms": 1179, "dedupe": "email:u5221:1059"}
{"ts": "2026-11-24T10:59:06.786Z", "event": "send.failed", "channel": "email", "user": "u5221", "kind": "out-for-delivery", "attempt": 2, "provider_status": 503, "latency_ms": 220, "dedupe": "email:u5221:1059"}
{"ts": "2026-11-24T10:59:07.319Z", "event": "send.ok", "channel": "email", "user": "u5221", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 653, "dedupe": "email:u5221:1059"}
{"ts": "2026-11-24T10:59:07.719Z", "event": "send.ok", "channel": "email", "user": "u4924", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 1527, "dedupe": "email:u4924:1059"}
{"ts": "2026-11-24T10:59:08.307Z", "event": "send.failed", "channel": "email", "user": "u6915", "kind": "delay", "attempt": 1, "provider_status": 503, "latency_ms": 2396, "dedupe": "email:u6915:1059"}
{"ts": "2026-11-24T10:59:08.584Z", "event": "send.ok", "channel": "email", "user": "u6915", "kind": "delay", "attempt": 2, "provider_status": 200, "latency_ms": 2292, "dedupe": "email:u6915:1059"}
{"ts": "2026-11-24T10:59:08.987Z", "event": "send.ok", "channel": "email", "user": "u6915", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 434, "dedupe": "email:u6915:1059"}
{"ts": "2026-11-24T10:59:09.277Z", "event": "send.ok", "channel": "email", "user": "u3943", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 2140, "dedupe": "email:u3943:1059"}
{"ts": "2026-11-24T10:59:09.446Z", "event": "send.ok", "channel": "email", "user": "u5914", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 309, "dedupe": "email:u5914:1059"}
{"ts": "2026-11-24T10:59:09.502Z", "event": "send.ok", "channel": "email", "user": "u5914", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 2018, "dedupe": "email:u5914:1059"}
{"ts": "2026-11-24T10:59:10.009Z", "event": "send.ok", "channel": "email", "user": "u5057", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 265, "dedupe": "email:u5057:1059"}
{"ts": "2026-11-24T10:59:10.384Z", "event": "send.ok", "channel": "email", "user": "u5057", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 422, "dedupe": "email:u5057:1059"}
{"ts": "2026-11-24T10:59:10.426Z", "event": "send.ok", "channel": "email", "user": "u4590", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 1709, "dedupe": "email:u4590:1059"}
{"ts": "2026-11-24T10:59:11.023Z", "event": "send.ok", "channel": "email", "user": "u6337", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 433, "dedupe": "email:u6337:1059"}
{"ts": "2026-11-24T10:59:11.609Z", "event": "send.ok", "channel": "email", "user": "u6337", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 1435, "dedupe": "email:u6337:1059"}
{"ts": "2026-11-24T10:59:11.713Z", "event": "send.ok", "channel": "email", "user": "u6337", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 2231, "dedupe": "email:u6337:1059"}
```

> `python -m pytest -q`

```
tests/ ...............                         [100%]
15 passed in 2.11s
```

> `read_file channels.py`

```python
"""Channel senders. Each sender calls one provider and reports the outcome."""
import datetime
import json

RETRY_IMMEDIATE = 3  # legacy: immediate retries, see the Nov 3 incident



def validate_window(sends):
    """Count sends per channel and status class."""
    counts = {}
    for send in sends:
        bucket = (send["channel"], f"{send.get('status', 0) // 100}xx")
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def validate_digest(defaults, overrides):
    """Merge per-user channel preferences over the tenant defaults."""
    merged = dict(defaults)
    for channel, enabled in overrides.items():
        if channel in merged:
            merged[channel] = bool(enabled)
    return merged


def render_batch(notification):
    """Provider payload for one notification."""
    body = notification["body"].strip()
    return {
        "to": notification["to"],
        "body": body[:153],
        "reference": notification["id"],
        "tags": sorted(notification.get("tags", [])),
    }


def render_profile(notification):
    """Provider payload for one notification."""
    body = notification["body"].strip()
    return {
        "to": notification["to"],
        "body": body[:160],
        "reference": notification["id"],
        "tags": sorted(notification.get("tags", [])),
    }


def trim_profile(number):
    """Whether a phone number looks like E.164."""
    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16


def enqueue_profile(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def validate_profile(sends):
    """Count sends per channel and status class."""
    counts = {}
    for send in sends:
        bucket = (send["channel"], f"{send.get('status', 0) // 100}xx")
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def validate_receipt(defaults, overrides):
    """Merge per-user channel preferences over the tenant defaults."""
    merged = dict(defaults)
    for channel, enabled in overrides.items():
        if channel in merged:
            merged[channel] = bool(enabled)
    return merged


def trim_payload(defaults, overrides):
    """Merge per-user channel preferences over the tenant defaults."""
    merged = dict(defaults)
    for channel, enabled in overrides.items():
        if channel in merged:
            merged[channel] = bool(enabled)
    return merged


def render_event(number):
    """Whether a phone number looks like E.164."""
    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16


def merge_token(items, now, max_age_s=60):
    """Drop entries older than max_age_s seconds."""
    return {k: v for k, v in items.items() if (now - v["seen"]).total_seconds() <= max_age_s}


def trim_digest(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def build_payload(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def build_digest(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def parse_window(number):
    """Whether a phone number looks like E.164."""
    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16


def expire_token(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def expire_message(number):
    """Whether a phone number looks like E.164."""
    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16


def merge_event(notification):
    """Provider payload for one notification."""
    body = notification["body"].strip()
    return {
        "to": notification["to"],
        "body": body[:320],
        "reference": notification["id"],
        "tags": sorted(notification.get("tags", [])),
    }
```

**Assistant:** Checked the provider mock: it now returns 503 for 10% of calls.

**Priya:** Looks right.

