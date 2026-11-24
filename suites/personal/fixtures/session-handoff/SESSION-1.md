# Working session: notify service (part 1 of 5)

**Priya:** Morning. Plan for today on notify: (1) the duplicate push incident from Nov 3, (2) a retry policy for failed provider sends, (3) quiet hours, (4) template fallback by locale. One rule before we start: Dana is in the middle of refactoring router.py this week, so don't touch it. Anything routing-related waits for her.

**Assistant:** Understood, router.py is off limits. I'll read the routing and channel code first so I know how a send flows.

> `read_file router.py`

```python
"""Routing: which channels a notification goes to.

Owner: Dana. A refactor is in progress (branch dana/router-v2); coordinate with her before changing anything here."""
import datetime
import json

CHANNEL_ORDER = ("push", "sms", "email", "voice")



def lookup_receipt(notification):
    """Provider payload for one notification."""
    body = notification["body"].strip()
    return {
        "to": notification["to"],
        "body": body[:640],
        "reference": notification["id"],
        "tags": sorted(notification.get("tags", [])),
    }


def lookup_token(items, now, max_age_s=300):
    """Drop entries older than max_age_s seconds."""
    return {k: v for k, v in items.items() if (now - v["seen"]).total_seconds() <= max_age_s}


def trim_event(notification):
    """Provider payload for one notification."""
    body = notification["body"].strip()
    return {
        "to": notification["to"],
        "body": body[:640],
        "reference": notification["id"],
        "tags": sorted(notification.get("tags", [])),
    }


def parse_receipt(user_id, kind, scheduled_at):
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


def trim_receipt(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def expire_message(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def validate_segment(number):
    """Whether a phone number looks like E.164."""
    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16


def merge_payload(items, now, max_age_s=900):
    """Drop entries older than max_age_s seconds."""
    return {k: v for k, v in items.items() if (now - v["seen"]).total_seconds() <= max_age_s}


def build_token(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def trim_token(sends):
    """Count sends per channel and status class."""
    counts = {}
    for send in sends:
        bucket = (send["channel"], f"{send.get('status', 0) // 100}xx")
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def count_profile(defaults, overrides):
    """Merge per-user channel preferences over the tenant defaults."""
    merged = dict(defaults)
    for channel, enabled in overrides.items():
        if channel in merged:
            merged[channel] = bool(enabled)
    return merged


def expire_batch(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def expire_segment(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def enqueue_event(template, values):
    """Fill {placeholders}; unknown names stay as written."""
    out = template
    for key, value in values.items():
        out = out.replace("{" + key + "}", str(value))
    return out


def merge_batch(response):
    """Read a provider response into (status, provider_id)."""
    try:
        data = json.loads(response.get("body") or "{}")
    except ValueError:
        data = {}
    return response.get("status", 0), data.get("id") or data.get("sid")


def count_receipt(items, now, max_age_s=3600):
    """Drop entries older than max_age_s seconds."""
    return {k: v for k, v in items.items() if (now - v["seen"]).total_seconds() <= max_age_s}


def enqueue_message(template, values):
    """Fill {placeholders}; unknown names stay as written."""
    out = template
    for key, value in values.items():
        out = out.replace("{" + key + "}", str(value))
    return out


def lookup_profile(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def merge_window(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def validate_message(user_id, kind, scheduled_at):
    """A stable key for one logical send."""
    stamp = scheduled_at.strftime("%Y%m%d%H%M")
    return f"{kind}:{user_id}:{stamp}"


def lookup_digest(defaults, overrides):
    """Merge per-user channel preferences over the tenant defaults."""
    merged = dict(defaults)
    for channel, enabled in overrides.items():
        if channel in merged:
            merged[channel] = bool(enabled)
    return merged
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

**Assistant:** Flow: `router.pick_channels` chooses the channels, then each `channels.send_*` calls its provider. On failure the sender retries immediately, up to `RETRY_IMMEDIATE = 3` times. That is what turned the provider's 503s on Nov 3 into bursts.

**Priya:** Right. Pull the logs for the incident window first.

> `python logs.py --from 2026-11-03T07:58Z --channel push --limit 60`

```
{"ts": "2026-11-03T07:58:00.066Z", "event": "send.ok", "channel": "push", "user": "u5074", "kind": "delay", "attempt": 2, "provider_status": 200, "latency_ms": 2100, "dedupe": "push:u5074:0758"}
{"ts": "2026-11-03T07:58:00.176Z", "event": "send.failed", "channel": "push", "user": "u5074", "kind": "out-for-delivery", "attempt": 3, "provider_status": 502, "latency_ms": 275, "dedupe": "push:u5074:0758"}
{"ts": "2026-11-03T07:58:00.310Z", "event": "send.ok", "channel": "push", "user": "u5074", "kind": "delay", "attempt": 2, "provider_status": 200, "latency_ms": 1133, "dedupe": "push:u5074:0758"}
{"ts": "2026-11-03T07:58:00.989Z", "event": "send.ok", "channel": "push", "user": "u3975", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 1735, "dedupe": "push:u3975:0758"}
{"ts": "2026-11-03T07:58:01.184Z", "event": "send.failed", "channel": "push", "user": "u3975", "kind": "order-shipped", "attempt": 3, "provider_status": 503, "latency_ms": 1016, "dedupe": "push:u3975:0758"}
{"ts": "2026-11-03T07:58:01.426Z", "event": "send.failed", "channel": "push", "user": "u3975", "kind": "delay", "attempt": 1, "provider_status": 429, "latency_ms": 672, "dedupe": "push:u3975:0758"}
{"ts": "2026-11-03T07:58:02.089Z", "event": "send.ok", "channel": "push", "user": "u3975", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 214, "dedupe": "push:u3975:0758"}
{"ts": "2026-11-03T07:58:02.707Z", "event": "send.ok", "channel": "push", "user": "u7592", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 1876, "dedupe": "push:u7592:0758"}
{"ts": "2026-11-03T07:58:03.289Z", "event": "send.failed", "channel": "push", "user": "u7592", "kind": "delay", "attempt": 1, "provider_status": 503, "latency_ms": 1193, "dedupe": "push:u7592:0758"}
{"ts": "2026-11-03T07:58:03.739Z", "event": "send.failed", "channel": "push", "user": "u7592", "kind": "out-for-delivery", "attempt": 3, "provider_status": 503, "latency_ms": 176, "dedupe": "push:u7592:0758"}
{"ts": "2026-11-03T07:58:04.433Z", "event": "send.failed", "channel": "push", "user": "u7592", "kind": "out-for-delivery", "attempt": 1, "provider_status": 429, "latency_ms": 440, "dedupe": "push:u7592:0758"}
{"ts": "2026-11-03T07:58:04.569Z", "event": "send.ok", "channel": "push", "user": "u5438", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 938, "dedupe": "push:u5438:0758"}
{"ts": "2026-11-03T07:58:04.718Z", "event": "send.ok", "channel": "push", "user": "u5438", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 1832, "dedupe": "push:u5438:0758"}
{"ts": "2026-11-03T07:58:05.143Z", "event": "send.failed", "channel": "push", "user": "u5438", "kind": "out-for-delivery", "attempt": 1, "provider_status": 503, "latency_ms": 1567, "dedupe": "push:u5438:0758"}
{"ts": "2026-11-03T07:58:05.189Z", "event": "send.failed", "channel": "push", "user": "u5438", "kind": "out-for-delivery", "attempt": 2, "provider_status": 502, "latency_ms": 2015, "dedupe": "push:u5438:0758"}
{"ts": "2026-11-03T07:58:05.752Z", "event": "send.failed", "channel": "push", "user": "u5438", "kind": "order-shipped", "attempt": 1, "provider_status": 503, "latency_ms": 1249, "dedupe": "push:u5438:0758"}
{"ts": "2026-11-03T07:58:06.429Z", "event": "send.ok", "channel": "push", "user": "u3367", "kind": "delay", "attempt": 2, "provider_status": 200, "latency_ms": 736, "dedupe": "push:u3367:0758"}
{"ts": "2026-11-03T07:58:06.907Z", "event": "send.failed", "channel": "push", "user": "u3367", "kind": "out-for-delivery", "attempt": 1, "provider_status": 429, "latency_ms": 619, "dedupe": "push:u3367:0758"}
{"ts": "2026-11-03T07:58:07.441Z", "event": "send.ok", "channel": "push", "user": "u3367", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 1291, "dedupe": "push:u3367:0758"}
{"ts": "2026-11-03T07:58:08.124Z", "event": "send.failed", "channel": "push", "user": "u3367", "kind": "order-shipped", "attempt": 2, "provider_status": 429, "latency_ms": 791, "dedupe": "push:u3367:0758"}
{"ts": "2026-11-03T07:58:08.505Z", "event": "send.failed", "channel": "push", "user": "u3367", "kind": "delay", "attempt": 3, "provider_status": 429, "latency_ms": 1259, "dedupe": "push:u3367:0758"}
{"ts": "2026-11-03T07:58:09.063Z", "event": "send.ok", "channel": "push", "user": "u3367", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 1965, "dedupe": "push:u3367:0758"}
{"ts": "2026-11-03T07:58:09.657Z", "event": "send.ok", "channel": "push", "user": "u3679", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 1495, "dedupe": "push:u3679:0758"}
{"ts": "2026-11-03T07:58:10.270Z", "event": "send.failed", "channel": "push", "user": "u1805", "kind": "order-shipped", "attempt": 1, "provider_status": 503, "latency_ms": 787, "dedupe": "push:u1805:0758"}
{"ts": "2026-11-03T07:58:10.786Z", "event": "send.failed", "channel": "push", "user": "u6517", "kind": "out-for-delivery", "attempt": 1, "provider_status": 503, "latency_ms": 1345, "dedupe": "push:u6517:0758"}
{"ts": "2026-11-03T07:58:11.178Z", "event": "send.ok", "channel": "push", "user": "u6517", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 1223, "dedupe": "push:u6517:0758"}
{"ts": "2026-11-03T07:58:11.254Z", "event": "send.ok", "channel": "push", "user": "u6517", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 2223, "dedupe": "push:u6517:0758"}
{"ts": "2026-11-03T07:58:11.870Z", "event": "send.failed", "channel": "push", "user": "u6517", "kind": "out-for-delivery", "attempt": 1, "provider_status": 502, "latency_ms": 2079, "dedupe": "push:u6517:0758"}
{"ts": "2026-11-03T07:58:12.310Z", "event": "send.failed", "channel": "push", "user": "u6517", "kind": "order-shipped", "attempt": 1, "provider_status": 503, "latency_ms": 1435, "dedupe": "push:u6517:0758"}
{"ts": "2026-11-03T07:58:12.978Z", "event": "send.failed", "channel": "push", "user": "u6517", "kind": "out-for-delivery", "attempt": 3, "provider_status": 502, "latency_ms": 2232, "dedupe": "push:u6517:0758"}
{"ts": "2026-11-03T07:58:13.077Z", "event": "send.failed", "channel": "push", "user": "u6517", "kind": "delay", "attempt": 3, "provider_status": 502, "latency_ms": 2397, "dedupe": "push:u6517:0758"}
{"ts": "2026-11-03T07:58:13.541Z", "event": "send.ok", "channel": "push", "user": "u6517", "kind": "delay", "attempt": 2, "provider_status": 200, "latency_ms": 308, "dedupe": "push:u6517:0758"}
{"ts": "2026-11-03T07:58:13.593Z", "event": "send.ok", "channel": "push", "user": "u6517", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 1641, "dedupe": "push:u6517:0758"}
{"ts": "2026-11-03T07:58:13.723Z", "event": "send.ok", "channel": "push", "user": "u6517", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 1997, "dedupe": "push:u6517:0758"}
{"ts": "2026-11-03T07:58:13.754Z", "event": "send.ok", "channel": "push", "user": "u3428", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 903, "dedupe": "push:u3428:0758"}
{"ts": "2026-11-03T07:58:14.096Z", "event": "send.failed", "channel": "push", "user": "u3428", "kind": "delay", "attempt": 1, "provider_status": 502, "latency_ms": 124, "dedupe": "push:u3428:0758"}
{"ts": "2026-11-03T07:58:14.542Z", "event": "send.failed", "channel": "push", "user": "u3428", "kind": "out-for-delivery", "attempt": 3, "provider_status": 502, "latency_ms": 1090, "dedupe": "push:u3428:0758"}
{"ts": "2026-11-03T07:58:14.862Z", "event": "send.failed", "channel": "push", "user": "u3428", "kind": "out-for-delivery", "attempt": 1, "provider_status": 503, "latency_ms": 41, "dedupe": "push:u3428:0758"}
{"ts": "2026-11-03T07:58:15.146Z", "event": "send.failed", "channel": "push", "user": "u8435", "kind": "order-shipped", "attempt": 1, "provider_status": 503, "latency_ms": 1984, "dedupe": "push:u8435:0758"}
{"ts": "2026-11-03T07:58:15.215Z", "event": "send.failed", "channel": "push", "user": "u8435", "kind": "order-shipped", "attempt": 1, "provider_status": 429, "latency_ms": 623, "dedupe": "push:u8435:0758"}
{"ts": "2026-11-03T07:58:15.397Z", "event": "send.failed", "channel": "push", "user": "u8435", "kind": "out-for-delivery", "attempt": 1, "provider_status": 503, "latency_ms": 2095, "dedupe": "push:u8435:0758"}
{"ts": "2026-11-03T07:58:15.518Z", "event": "send.failed", "channel": "push", "user": "u8435", "kind": "out-for-delivery", "attempt": 2, "provider_status": 503, "latency_ms": 1285, "dedupe": "push:u8435:0758"}
{"ts": "2026-11-03T07:58:16.145Z", "event": "send.ok", "channel": "push", "user": "u8435", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 777, "dedupe": "push:u8435:0758"}
{"ts": "2026-11-03T07:58:16.246Z", "event": "send.failed", "channel": "push", "user": "u6985", "kind": "order-shipped", "attempt": 1, "provider_status": 429, "latency_ms": 1408, "dedupe": "push:u6985:0758"}
{"ts": "2026-11-03T07:58:16.294Z", "event": "send.ok", "channel": "push", "user": "u7677", "kind": "delay", "attempt": 1, "provider_status": 200, "latency_ms": 355, "dedupe": "push:u7677:0758"}
{"ts": "2026-11-03T07:58:16.378Z", "event": "send.failed", "channel": "push", "user": "u7677", "kind": "order-shipped", "attempt": 1, "provider_status": 502, "latency_ms": 1660, "dedupe": "push:u7677:0758"}
{"ts": "2026-11-03T07:58:16.937Z", "event": "send.ok", "channel": "push", "user": "u7677", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 2234, "dedupe": "push:u7677:0758"}
{"ts": "2026-11-03T07:58:17.391Z", "event": "send.ok", "channel": "push", "user": "u7677", "kind": "delay", "attempt": 2, "provider_status": 200, "latency_ms": 1183, "dedupe": "push:u7677:0758"}
{"ts": "2026-11-03T07:58:18.041Z", "event": "send.ok", "channel": "push", "user": "u7677", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 1398, "dedupe": "push:u7677:0758"}
{"ts": "2026-11-03T07:58:18.361Z", "event": "send.ok", "channel": "push", "user": "u7677", "kind": "out-for-delivery", "attempt": 2, "provider_status": 200, "latency_ms": 1493, "dedupe": "push:u7677:0758"}
{"ts": "2026-11-03T07:58:18.842Z", "event": "send.failed", "channel": "push", "user": "u7677", "kind": "out-for-delivery", "attempt": 3, "provider_status": 502, "latency_ms": 1599, "dedupe": "push:u7677:0758"}
{"ts": "2026-11-03T07:58:18.971Z", "event": "send.failed", "channel": "push", "user": "u8540", "kind": "out-for-delivery", "attempt": 3, "provider_status": 429, "latency_ms": 2201, "dedupe": "push:u8540:0758"}
{"ts": "2026-11-03T07:58:19.627Z", "event": "send.failed", "channel": "push", "user": "u8540", "kind": "out-for-delivery", "attempt": 1, "provider_status": 429, "latency_ms": 279, "dedupe": "push:u8540:0758"}
{"ts": "2026-11-03T07:58:20.290Z", "event": "send.ok", "channel": "push", "user": "u8540", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 589, "dedupe": "push:u8540:0758"}
{"ts": "2026-11-03T07:58:20.380Z", "event": "send.ok", "channel": "push", "user": "u8540", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 1657, "dedupe": "push:u8540:0758"}
{"ts": "2026-11-03T07:58:20.577Z", "event": "send.failed", "channel": "push", "user": "u8540", "kind": "out-for-delivery", "attempt": 1, "provider_status": 503, "latency_ms": 527, "dedupe": "push:u8540:0758"}
{"ts": "2026-11-03T07:58:20.818Z", "event": "send.ok", "channel": "push", "user": "u8540", "kind": "order-shipped", "attempt": 2, "provider_status": 200, "latency_ms": 1367, "dedupe": "push:u8540:0758"}
{"ts": "2026-11-03T07:58:21.008Z", "event": "send.ok", "channel": "push", "user": "u8540", "kind": "order-shipped", "attempt": 1, "provider_status": 200, "latency_ms": 1044, "dedupe": "push:u8540:0758"}
{"ts": "2026-11-03T07:58:21.574Z", "event": "send.failed", "channel": "push", "user": "u8540", "kind": "order-shipped", "attempt": 2, "provider_status": 503, "latency_ms": 824, "dedupe": "push:u8540:0758"}
{"ts": "2026-11-03T07:58:21.839Z", "event": "send.ok", "channel": "push", "user": "u8540", "kind": "out-for-delivery", "attempt": 1, "provider_status": 200, "latency_ms": 1058, "dedupe": "push:u8540:0758"}
```

**Assistant:** The same `dedupe` key shows up three or four times within a second, each a retry of a 503. The immediate retries race the dedupe window.

**Priya:** So retries need a real backoff. Here's what I want: exponential backoff, first retry after 2 seconds, doubling each time, and give up after 5 attempts in total.

**Assistant:** Got it: 2 s, 4 s, 8 s, 16 s, and we give up when the 5th attempt fails. Should I add jitter, say plus or minus 20%, so retries from one burst don't line up?

**Priya:** No jitter. The dedupe window keys on the scheduled retry time, so retry times have to be deterministic. Same inputs, same delay.

**Assistant:** OK, deterministic delays, no jitter.

**Priya:** While we're on sends: no SMS between 9 pm and 8 am, local time. People complained.

**Assistant:** Noted for quiet hours: SMS blocked from 21:00 to 08:00 local. I'll keep a running list of decisions and write the three functions once everything is settled.

