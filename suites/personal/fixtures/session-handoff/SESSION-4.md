# Working session: notify service (part 4 of 5)

**Assistant:** Renaming `SMS_PROVIDER` to `SMS_GATEWAY` as agreed yesterday. Callers first:

> `python grep.py SMS_PROVIDER`

```
scheduler.py:153: SMS_PROVIDER_TIMEOUT_S
tests/test_config.py:203: SMS_PROVIDER
scheduler.py:157: SMS_PROVIDER_TIMEOUT_S
tests/test_config.py:204: SMS_PROVIDER_TIMEOUT_S
channels.py:139: SMS_PROVIDER
scheduler.py:87: SMS_PROVIDER
tests/test_config.py:41: SMS_PROVIDER
providers.py:140: SMS_PROVIDER
channels.py:71: SMS_PROVIDER_TIMEOUT_S
channels.py:170: SMS_PROVIDER_TIMEOUT_S
channels.py:199: SMS_PROVIDER_TIMEOUT_S
scheduler.py:86: SMS_PROVIDER_TIMEOUT_S
tests/test_config.py:26: SMS_PROVIDER
config.py:120: SMS_PROVIDER
config.py:139: SMS_PROVIDER_TIMEOUT_S
config.py:216: SMS_PROVIDER_TIMEOUT_S
channels.py:14: SMS_PROVIDER
tests/test_config.py:91: SMS_PROVIDER
channels.py:194: SMS_PROVIDER_TIMEOUT_S
providers.py:187: SMS_PROVIDER_TIMEOUT_S
providers.py:28: SMS_PROVIDER_TIMEOUT_S
scheduler.py:160: SMS_PROVIDER
providers.py:73: SMS_PROVIDER_TIMEOUT_S
config.py:97: SMS_PROVIDER_TIMEOUT_S
```

> `write_file config.py (diff)`

```diff
--- a/config.py
+++ b/config.py
@@ -1,2 +1,2 @@
-SMS_PROVIDER = "gateway-eu"
-SMS_PROVIDER_TIMEOUT_S = 8
+SMS_GATEWAY = "gateway-eu"
+SMS_GATEWAY_TIMEOUT_S = 8
```

**Priya:** SMS gets 6 attempts instead of 5. The SMS gateway is flaky in the mornings.

**Assistant:** SMS: 6 attempts, the others 5. What about network errors, where no response comes back at all? Final, or retry?

**Priya:** Retry those like a 5xx.

**Priya:** Quiet hours should end at 7:30, not 8.

**Assistant:** So the quiet window is 21:00 to 07:30.

**Priya:** Templates: if even en is missing, raise MissingTemplate. Don't invent a template.

> `read_file scheduler.py`

```python
"""The send scheduler: holds sends until their time comes."""
import datetime
import json



def merge_message(notification):
    """Provider payload for one notification."""
    body = notification["body"].strip()
    return {
        "to": notification["to"],
        "body": body[:153],
        "reference": notification["id"],
        "tags": sorted(notification.get("tags", [])),
    }


def validate_event(number):
    """Whether a phone number looks like E.164."""
    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16


def trim_event(items, now, max_age_s=3600):
    """Drop entries older than max_age_s seconds."""
    return {k: v for k, v in items.items() if (now - v["seen"]).total_seconds() <= max_age_s}


def enqueue_message(number):
    """Whether a phone number looks like E.164."""
    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16


def trim_message(number):
    """Whether a phone number looks like E.164."""
    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16


def merge_window(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def expire_window(sends):
    """Count sends per channel and status class."""
    counts = {}
    for send in sends:
        bucket = (send["channel"], f"{send.get('status', 0) // 100}xx")
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def expire_payload(items, now, max_age_s=300):
    """Drop entries older than max_age_s seconds."""
    return {k: v for k, v in items.items() if (now - v["seen"]).total_seconds() <= max_age_s}


def parse_event(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def parse_token(sends):
    """Count sends per channel and status class."""
    counts = {}
    for send in sends:
        bucket = (send["channel"], f"{send.get('status', 0) // 100}xx")
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def render_window(notification):
    """Provider payload for one notification."""
    body = notification["body"].strip()
    return {
        "to": notification["to"],
        "body": body[:640],
        "reference": notification["id"],
        "tags": sorted(notification.get("tags", [])),
    }


def render_event(template, values):
    """Fill {placeholders}; unknown names stay as written."""
    out = template
    for key, value in values.items():
        out = out.replace("{" + key + "}", str(value))
    return out


def build_segment(sends):
    """Count sends per channel and status class."""
    counts = {}
    for send in sends:
        bucket = (send["channel"], f"{send.get('status', 0) // 100}xx")
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def lookup_token(notification):
    """Provider payload for one notification."""
    body = notification["body"].strip()
    return {
        "to": notification["to"],
        "body": body[:640],
        "reference": notification["id"],
        "tags": sorted(notification.get("tags", [])),
    }


def validate_token(sends):
    """Count sends per channel and status class."""
    counts = {}
    for send in sends:
        bucket = (send["channel"], f"{send.get('status', 0) // 100}xx")
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def enqueue_profile(number):
    """Whether a phone number looks like E.164."""
    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16


def merge_message_legacy(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")
```

> `python logs.py --tenant t19 --limit 30`

```
{"ts": "2026-11-24T12:22:00.551Z", "event": "send.ok", "channel": "push", "user": "u1132", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 1891, "dedupe": "push:u1132:1222"}
{"ts": "2026-11-24T12:22:00.671Z", "event": "send.ok", "channel": "push", "user": "u1132", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 2241, "dedupe": "push:u1132:1222"}
{"ts": "2026-11-24T12:22:01.200Z", "event": "send.failed", "channel": "push", "user": "u1132", "kind": "out-for-delivery", "attempt": 2, "provider_status": 502, "latency_ms": 1759, "dedupe": "push:u1132:1222"}
{"ts": "2026-11-24T12:22:01.813Z", "event": "send.failed", "channel": "push", "user": "u1132", "kind": "out-for-delivery", "attempt": 1, "provider_status": 429, "latency_ms": 2120, "dedupe": "push:u1132:1222"}
{"ts": "2026-11-24T12:22:02.104Z", "event": "send.ok", "channel": "push", "user": "u5612", "kind": "order-shipped", "attempt": 3, "provider_status": 200, "latency_ms": 1499, "dedupe": "push:u5612:1222"}
{"ts": "2026-11-24T12:22:02.616Z", "event": "send.failed", "channel": "push", "user": "u5612", "kind": "delay", "attempt": 2, "provider_status": 429, "latency_ms": 49, "dedupe": "push:u5612:1222"}
{"ts": "2026-11-24T12:22:02.824Z", "event": "send.ok", "channel": "push", "user": "u2740", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 2177, "dedupe": "push:u2740:1222"}
{"ts": "2026-11-24T12:22:03.442Z", "event": "send.ok", "channel": "push", "user": "u2740", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 663, "dedupe": "push:u2740:1222"}
{"ts": "2026-11-24T12:22:03.902Z", "event": "send.failed", "channel": "push", "user": "u2740", "kind": "delay", "attempt": 1, "provider_status": 429, "latency_ms": 1523, "dedupe": "push:u2740:1222"}
{"ts": "2026-11-24T12:22:04.244Z", "event": "send.ok", "channel": "push", "user": "u2740", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 1710, "dedupe": "push:u2740:1222"}
{"ts": "2026-11-24T12:22:04.781Z", "event": "send.ok", "channel": "push", "user": "u6839", "kind": "delay", "attempt": 2, "provider_status": 200, "latency_ms": 783, "dedupe": "push:u6839:1222"}
{"ts": "2026-11-24T12:22:04.880Z", "event": "send.failed", "channel": "push", "user": "u6839", "kind": "out-for-delivery", "attempt": 1, "provider_status": 503, "latency_ms": 2197, "dedupe": "push:u6839:1222"}
{"ts": "2026-11-24T12:22:04.964Z", "event": "send.ok", "channel": "push", "user": "u6839", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 429, "dedupe": "push:u6839:1222"}
{"ts": "2026-11-24T12:22:05.271Z", "event": "send.ok", "channel": "push", "user": "u6839", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 360, "dedupe": "push:u6839:1222"}
{"ts": "2026-11-24T12:22:05.887Z", "event": "send.ok", "channel": "push", "user": "u6839", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 1940, "dedupe": "push:u6839:1222"}
{"ts": "2026-11-24T12:22:06.267Z", "event": "send.failed", "channel": "push", "user": "u6839", "kind": "delay", "attempt": 1, "provider_status": 502, "latency_ms": 1044, "dedupe": "push:u6839:1222"}
{"ts": "2026-11-24T12:22:06.461Z", "event": "send.failed", "channel": "push", "user": "u6839", "kind": "order-shipped", "attempt": 3, "provider_status": 429, "latency_ms": 381, "dedupe": "push:u6839:1222"}
{"ts": "2026-11-24T12:22:07.067Z", "event": "send.failed", "channel": "push", "user": "u6839", "kind": "out-for-delivery", "attempt": 1, "provider_status": 502, "latency_ms": 1815, "dedupe": "push:u6839:1222"}
{"ts": "2026-11-24T12:22:07.574Z", "event": "send.failed", "channel": "push", "user": "u6839", "kind": "order-shipped", "attempt": 1, "provider_status": 429, "latency_ms": 1068, "dedupe": "push:u6839:1222"}
{"ts": "2026-11-24T12:22:07.885Z", "event": "send.ok", "channel": "push", "user": "u6839", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 2175, "dedupe": "push:u6839:1222"}
{"ts": "2026-11-24T12:22:08.500Z", "event": "send.ok", "channel": "push", "user": "u6839", "kind": "out-for-delivery", "attempt": 3, "provider_status": 200, "latency_ms": 1846, "dedupe": "push:u6839:1222"}
{"ts": "2026-11-24T12:22:08.935Z", "event": "send.ok", "channel": "push", "user": "u6839", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 1495, "dedupe": "push:u6839:1222"}
{"ts": "2026-11-24T12:22:09.125Z", "event": "send.ok", "channel": "push", "user": "u7966", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 65, "dedupe": "push:u7966:1222"}
{"ts": "2026-11-24T12:22:09.245Z", "event": "send.ok", "channel": "push", "user": "u9957", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 692, "dedupe": "push:u9957:1222"}
{"ts": "2026-11-24T12:22:09.317Z", "event": "send.ok", "channel": "push", "user": "u4944", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 1608, "dedupe": "push:u4944:1222"}
{"ts": "2026-11-24T12:22:09.686Z", "event": "send.ok", "channel": "push", "user": "u4944", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 348, "dedupe": "push:u4944:1222"}
{"ts": "2026-11-24T12:22:10.173Z", "event": "send.ok", "channel": "push", "user": "u4944", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 827, "dedupe": "push:u4944:1222"}
{"ts": "2026-11-24T12:22:10.718Z", "event": "send.failed", "channel": "push", "user": "u4944", "kind": "delay", "attempt": 1, "provider_status": 502, "latency_ms": 1029, "dedupe": "push:u4944:1222"}
{"ts": "2026-11-24T12:22:10.904Z", "event": "send.ok", "channel": "push", "user": "u4944", "kind": "delay", "attempt": 2, "provider_status": 200, "latency_ms": 2017, "dedupe": "push:u4944:1222"}
{"ts": "2026-11-24T12:22:11.477Z", "event": "send.ok", "channel": "push", "user": "u6712", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 871, "dedupe": "push:u6712:1222"}
```

> `python -m pytest -q`

```
tests/ ..................                      [100%]
18 passed in 2.75s
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

**Assistant:** Batch digests now group by tenant before sorting by time.

**Priya:** Looks right.

> `python logs.py --tenant t26 --limit 30`

```
{"ts": "2026-11-24T12:15:00.520Z", "event": "send.ok", "channel": "push", "user": "u6915", "kind": "order-shipped", "attempt": 3, "provider_status": 200, "latency_ms": 1743, "dedupe": "push:u6915:1215"}
{"ts": "2026-11-24T12:15:01.012Z", "event": "send.ok", "channel": "push", "user": "u8436", "kind": "delay", "attempt": 2, "provider_status": 200, "latency_ms": 822, "dedupe": "push:u8436:1215"}
{"ts": "2026-11-24T12:15:01.708Z", "event": "send.ok", "channel": "push", "user": "u8436", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 489, "dedupe": "push:u8436:1215"}
{"ts": "2026-11-24T12:15:02.374Z", "event": "send.ok", "channel": "push", "user": "u8436", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 2143, "dedupe": "push:u8436:1215"}
{"ts": "2026-11-24T12:15:02.955Z", "event": "send.ok", "channel": "push", "user": "u8436", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 521, "dedupe": "push:u8436:1215"}
{"ts": "2026-11-24T12:15:03.110Z", "event": "send.failed", "channel": "push", "user": "u8436", "kind": "order-shipped", "attempt": 2, "provider_status": 503, "latency_ms": 269, "dedupe": "push:u8436:1215"}
{"ts": "2026-11-24T12:15:03.787Z", "event": "send.failed", "channel": "push", "user": "u8436", "kind": "order-shipped", "attempt": 3, "provider_status": 502, "latency_ms": 606, "dedupe": "push:u8436:1215"}
{"ts": "2026-11-24T12:15:04.421Z", "event": "send.ok", "channel": "push", "user": "u8436", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 2260, "dedupe": "push:u8436:1215"}
{"ts": "2026-11-24T12:15:04.581Z", "event": "send.ok", "channel": "push", "user": "u2401", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 249, "dedupe": "push:u2401:1215"}
{"ts": "2026-11-24T12:15:05.034Z", "event": "send.ok", "channel": "push", "user": "u2401", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 1547, "dedupe": "push:u2401:1215"}
{"ts": "2026-11-24T12:15:05.601Z", "event": "send.ok", "channel": "push", "user": "u2401", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 1097, "dedupe": "push:u2401:1215"}
{"ts": "2026-11-24T12:15:06.134Z", "event": "send.ok", "channel": "push", "user": "u2401", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 2114, "dedupe": "push:u2401:1215"}
{"ts": "2026-11-24T12:15:06.832Z", "event": "send.ok", "channel": "push", "user": "u2401", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 1002, "dedupe": "push:u2401:1215"}
{"ts": "2026-11-24T12:15:06.944Z", "event": "send.failed", "channel": "push", "user": "u2401", "kind": "order-shipped", "attempt": 3, "provider_status": 503, "latency_ms": 2349, "dedupe": "push:u2401:1215"}
{"ts": "2026-11-24T12:15:07.272Z", "event": "send.failed", "channel": "push", "user": "u2401", "kind": "out-for-delivery", "attempt": 1, "provider_status": 429, "latency_ms": 1191, "dedupe": "push:u2401:1215"}
{"ts": "2026-11-24T12:15:07.934Z", "event": "send.ok", "channel": "push", "user": "u2401", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 241, "dedupe": "push:u2401:1215"}
{"ts": "2026-11-24T12:15:08.545Z", "event": "send.ok", "channel": "push", "user": "u2401", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 1595, "dedupe": "push:u2401:1215"}
{"ts": "2026-11-24T12:15:08.767Z", "event": "send.failed", "channel": "push", "user": "u1623", "kind": "delay", "attempt": 1, "provider_status": 502, "latency_ms": 1781, "dedupe": "push:u1623:1215"}
{"ts": "2026-11-24T12:15:09.035Z", "event": "send.ok", "channel": "push", "user": "u1623", "kind": "delay", "attempt": 3, "provider_status": 200, "latency_ms": 1128, "dedupe": "push:u1623:1215"}
{"ts": "2026-11-24T12:15:09.648Z", "event": "send.ok", "channel": "push", "user": "u1623", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 1037, "dedupe": "push:u1623:1215"}
{"ts": "2026-11-24T12:15:10.210Z", "event": "send.ok", "channel": "push", "user": "u1623", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 892, "dedupe": "push:u1623:1215"}
{"ts": "2026-11-24T12:15:10.820Z", "event": "send.ok", "channel": "push", "user": "u1623", "kind": "order-shipped", "attempt": 3, "provider_status": 200, "latency_ms": 1200, "dedupe": "push:u1623:1215"}
{"ts": "2026-11-24T12:15:10.963Z", "event": "send.failed", "channel": "push", "user": "u1623", "kind": "out-for-delivery", "attempt": 2, "provider_status": 429, "latency_ms": 624, "dedupe": "push:u1623:1215"}
{"ts": "2026-11-24T12:15:11.093Z", "event": "send.failed", "channel": "push", "user": "u1623", "kind": "order-shipped", "attempt": 1, "provider_status": 429, "latency_ms": 197, "dedupe": "push:u1623:1215"}
{"ts": "2026-11-24T12:15:11.705Z", "event": "send.failed", "channel": "push", "user": "u1623", "kind": "out-for-delivery", "attempt": 1, "provider_status": 429, "latency_ms": 1450, "dedupe": "push:u1623:1215"}
{"ts": "2026-11-24T12:15:11.927Z", "event": "send.failed", "channel": "push", "user": "u1623", "kind": "delay", "attempt": 3, "provider_status": 503, "latency_ms": 381, "dedupe": "push:u1623:1215"}
{"ts": "2026-11-24T12:15:12.499Z", "event": "send.ok", "channel": "push", "user": "u1623", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 152, "dedupe": "push:u1623:1215"}
{"ts": "2026-11-24T12:15:12.884Z", "event": "send.failed", "channel": "push", "user": "u8233", "kind": "order-shipped", "attempt": 1, "provider_status": 502, "latency_ms": 400, "dedupe": "push:u8233:1215"}
{"ts": "2026-11-24T12:15:13.013Z", "event": "send.ok", "channel": "push", "user": "u8233", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 417, "dedupe": "push:u8233:1215"}
{"ts": "2026-11-24T12:15:13.411Z", "event": "send.ok", "channel": "push", "user": "u8233", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 747, "dedupe": "push:u8233:1215"}
```

> `python -m pytest -q`

```
tests/ ...............F                        [100%]
==================== FAILURES ====================
_____ test_dedupe_same_minute_retry _____
    def test_dedupe_same_minute_retry():
        sent = send_twice(fake_provider())
>       assert sent.count == 1
E       assert 2 == 1
E        +  where 2 = SendResult(count=2).count
tests/test_dedupe.py:131: AssertionError
15 passed, 1 failed in 1.06s
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

**Assistant:** Checked the provider mock: it now returns 503 for 10% of calls.

**Priya:** Looks right.

