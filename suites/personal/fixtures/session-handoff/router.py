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
