#!/usr/bin/env python3
"""Generate the session-handoff task: finish three open items from a long working session.

Run from the repository root:  python3 tools/suite/session_handoff.py
Writes suites/personal/fixtures/session-handoff/ and suites/personal/private/session-handoff.mjs.
Deterministic: a rerun rewrites the same bytes.

The rules for the three functions are spread over a ~145 KB transcript. Several change later in
the session, one is tried and then withdrawn, and some proposals are turned down. The reference
implementation below encodes the final decisions; the hidden cases are computed from it here, so
the grader carries only expected values.
"""
import datetime
import difflib
import json
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "suites" / "personal" / "fixtures" / "session-handoff"
GRADER = ROOT / "suites" / "personal" / "private" / "session-handoff.mjs"
PART_LIMIT = 29_500
rng = random.Random(4242)

# ------------------------------------------------------------------ the final decisions

REFERENCE = {
    "retry.py": '''"""Retry policy for failed provider sends."""

LIMITS = {"sms": 6, "voice": 2}
CAPS = {"push": 10.0}


def next_delay(channel, attempt, status, retry_after=None):
    """Seconds to wait before retrying a failed send, or None to give up."""
    if attempt >= LIMITS.get(channel, 5):
        return None
    if status is not None and 400 <= status <= 499 and status not in (408, 429):
        return None
    cap = CAPS.get(channel, 30.0)
    if status == 429 and retry_after is not None:
        return float(min(retry_after, cap))
    return float(min(1.5 * 2 ** (attempt - 1), cap))
''',
    "quiet_hours.py": '''"""Quiet hours: when a channel may not disturb a recipient."""
from datetime import datetime, timedelta

QUIET_CHANNELS = {"sms", "push", "voice"}


def allowed(channel, utc, recipient_offset=None, tenant_offset=None):
    """Whether a notification may go out now on this channel."""
    if channel not in QUIET_CHANNELS:
        return True
    offset = recipient_offset or tenant_offset or "+00:00"
    sign = 1 if offset[0] == "+" else -1
    shift = timedelta(hours=int(offset[1:3]), minutes=int(offset[4:6]))
    local = datetime.fromisoformat(utc.replace("Z", "+00:00")) + sign * shift
    minute = local.hour * 60 + local.minute
    return not (minute >= 21 * 60 or minute < 7 * 60 + 30)
''',
    "templates.py": '''"""Template selection by locale."""


class MissingTemplate(Exception):
    """No template can be used for this kind and locale."""


def resolve(kind, locale, available):
    """The locale whose template to use for this kind, spelled as in `available`."""
    index = {name.lower(): name for name in available}
    wanted = locale.lower()
    if wanted in index:
        return index[wanted]
    if kind == "legal":
        if wanted == "en-us" and "en" in index:
            return index["en"]
        raise MissingTemplate(f"no {kind} template for {locale}")
    language = wanted.split("-")[0]
    if language in index:
        return index[language]
    if "en" in index:
        return index["en"]
    raise MissingTemplate(f"no {kind} template for {locale}")
''',
}

# The earliest version of each rule: what a reader who stops early, or keeps the first decision, builds.
BASELINE = {
    "retry.py": '''"""Retry policy for failed provider sends."""


def next_delay(channel, attempt, status, retry_after=None):
    """Seconds to wait before retrying a failed send, or None to give up."""
    limit = 6 if channel == "sms" else 5
    if attempt >= limit:
        return None
    if status is not None and 400 <= status <= 499 and status not in (408, 429):
        return None
    cap = 10.0 if channel == "push" else 30.0
    if status == 429 and retry_after is not None:
        return float(min(retry_after, cap))
    return float(min(2 * 2 ** (attempt - 1), cap))
''',
    "quiet_hours.py": '''"""Quiet hours: when a channel may not disturb a recipient."""
from datetime import datetime, timedelta


def allowed(channel, utc, recipient_offset=None, tenant_offset=None):
    """Whether a notification may go out now on this channel."""
    if channel not in ("sms", "push", "voice"):
        return True
    offset = recipient_offset or tenant_offset or "+00:00"
    sign = 1 if offset[0] == "+" else -1
    shift = timedelta(hours=int(offset[1:3]), minutes=int(offset[4:6]))
    local = datetime.fromisoformat(utc.replace("Z", "+00:00")) + sign * shift
    return not (local.hour >= 21 or local.hour < 8)
''',
    "templates.py": '''"""Template selection by locale."""


class MissingTemplate(Exception):
    """No template can be used for this kind and locale."""


def resolve(kind, locale, available):
    """The locale whose template to use for this kind, spelled as in `available`."""
    if locale in available:
        return locale
    if kind == "legal":
        raise MissingTemplate(locale)
    for candidate in (locale.split("-")[0], "en"):
        if candidate in available:
            return candidate
    raise MissingTemplate(locale)
''',
}

STUBS = {
    "retry.py": '''"""Retry policy for failed provider sends."""


def next_delay(channel, attempt, status, retry_after=None):
    """Seconds to wait before retrying a failed send, or None to give up.

    channel: "sms", "push", "email" or "voice".
    attempt: the number of the attempt that just failed (1 for the first try).
    status: the provider's HTTP status code, or None when no response arrived.
    retry_after: the provider's Retry-After header in seconds, or None.

    The policy is the one settled in the session (SESSION-*.md).
    """
    raise NotImplementedError("open item 1 in the session handoff")
''',
    "quiet_hours.py": '''"""Quiet hours: when a channel may not disturb a recipient."""


def allowed(channel, utc, recipient_offset=None, tenant_offset=None):
    """Whether a notification may go out now on this channel.

    channel: "sms", "push", "email" or "voice".
    utc: the current instant as ISO 8601 ending in "Z", for example "2026-03-01T21:15:00Z".
    recipient_offset, tenant_offset: UTC offsets such as "+05:30" or "-08:00", or None when unknown.

    The rules are the ones settled in the session (SESSION-*.md).
    """
    raise NotImplementedError("open item 2 in the session handoff")
''',
    "templates.py": '''"""Template selection by locale."""


class MissingTemplate(Exception):
    """No template can be used for this kind and locale."""


def resolve(kind, locale, available):
    """The locale whose template to use for this kind, spelled exactly as it appears in `available`.

    kind: the template kind, such as "receipt", "delay", "marketing" or "legal".
    locale: the recipient's locale, such as "fr-CA" or "en".
    available: the locales this kind has templates for, such as ["en", "fr", "de-DE"].
    Raise MissingTemplate when no template may be used.

    The rules are the ones settled in the session (SESSION-*.md).
    """
    raise NotImplementedError("open item 3 in the session handoff")
''',
}

CHECK_PUBLIC = '''from quiet_hours import allowed
from retry import next_delay
from templates import resolve

assert next_delay("email", 1, 404) is None
assert allowed("email", "2026-03-01T23:00:00Z") is True
assert resolve("receipt", "de-DE", ["en", "de-DE"]) == "de-DE"
assert resolve("receipt", "de-AT", ["en", "de"]) == "de"
print("public check passed")
'''

OBSERVE = '''"""Public batch-call protocol. No expected answers or verdicts live here.

Input: module, function, calls (a list of argument lists).
Output: one raw output/args/error snapshot per call, frozen immediately.
"""
import importlib
import json
import sys


def observe(payload):
    request = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    load = importlib.import_module
    error_type = type
    exception = Exception
    function = getattr(load(request["module"]), request["function"])
    records = []
    for args in request["calls"]:
        output, error = None, None
        try:
            output = function(*args)
        except exception as exc:
            error = error_type(exc).__name__
        records.append(encode({"output": output, "args": args, "error": error}))
    write("[" + ",".join(records) + "]")
'''

# ------------------------------------------------------------------ hidden cases, by rule

def at(hh, mm, ss=0, day=3):
    return f"2026-03-{day:02d}T{hh:02d}:{mm:02d}:{ss:02d}Z"


CASES = {
    "next_delay": {
        "retry-backoff": [["email", 1, 503], ["email", 2, 503], ["email", 3, 500], ["email", 4, 502],
                          ["sms", 1, None], ["sms", 2, None], ["sms", 3, 408], ["push", 1, 500], ["push", 2, 503],
                          ["email", 2, 503], ["email", 2, 503], ["sms", 4, 500]],
        "retry-limits": [["email", 5, 503], ["push", 5, 500], ["sms", 5, 500], ["sms", 6, 500], ["sms", 7, 500],
                         ["voice", 1, 503], ["voice", 2, 503], ["voice", 3, None], ["email", 4, 500],
                         ["push", 4, 503], ["voice", 1, 429, 4]],
        "retry-status": [["email", 1, 400], ["email", 1, 401], ["sms", 2, 403], ["push", 1, 404], ["email", 3, 422],
                         ["sms", 1, 409], ["email", 1, 408], ["sms", 2, 429], ["email", 2, 503, 40],
                         ["sms", 3, 500, 2], ["push", 1, None], ["email", 1, 504]],
        "retry-after": [["email", 1, 429, 7], ["email", 3, 429, 45], ["sms", 2, 429, 25], ["sms", 1, 429, 30],
                        ["push", 1, 429, 4], ["push", 2, 429, 45], ["email", 2, 429, 1], ["sms", 6, 429, 3]],
        "retry-caps": [["push", 4, 503], ["push", 3, 503], ["sms", 5, 503], ["sms", 5, None], ["email", 4, 503],
                       ["sms", 2, 429, 22], ["push", 4, 429, 12]],
    },
    "allowed": {
        "quiet-channels": [["email", at(23, 0)], ["sms", at(23, 0)], ["push", at(23, 0)], ["voice", at(23, 0)],
                           ["email", at(3, 15)], ["voice", at(12, 0)], ["sms", at(12, 0)], ["push", at(16, 45)]],
        "quiet-window": [["sms", at(20, 59, 59)], ["sms", at(21, 0)], ["push", at(21, 30)], ["sms", at(22, 15)],
                         ["sms", at(7, 29, 59)], ["sms", at(7, 30)], ["push", at(7, 45)], ["voice", at(7, 59)],
                         ["sms", at(6, 59)], ["push", at(8, 0)], ["voice", at(0, 0)], ["sms", at(10, 0)]],
        "quiet-offsets": [["sms", at(16, 0), "+05:30"], ["sms", at(15, 29), "+05:30"], ["sms", at(4, 0), "-08:00"],
                          ["sms", at(5, 0), "-08:00"], ["sms", at(5, 0), None, "-08:00"],
                          ["sms", at(4, 59), None, "-08:00"], ["push", at(15, 0), "-03:30", "+09:00"],
                          ["push", at(15, 0), None, "+09:00"], ["voice", at(21, 0), None, None],
                          ["sms", at(1, 30), "+06:00", "-05:00"], ["sms", at(1, 29), "+06:00", "-05:00"],
                          ["push", at(2, 0), "-05:00", "+01:00"]],
    },
    "resolve": {
        "template-fallback": [["receipt", "fr-CA", ["en", "fr", "fr-CA"]], ["receipt", "fr-CA", ["en", "fr"]],
                             ["delay", "pt-BR", ["en", "es"]], ["delay", "fr-ca", ["en", "fr-CA"]],
                             ["marketing", "FR-be", ["fr", "en"]], ["receipt", "DE", ["de-DE", "en"]],
                             ["receipt", "es-MX", ["en-US", "en", "es-ES"]], ["delay", "en-GB", ["EN", "fr"]],
                             ["marketing", "zh-Hant-TW", ["zh", "en"]]],
        "template-missing": [["receipt", "ja-JP", ["fr", "de"]], ["delay", "pt-BR", ["es", "fr-FR"]],
                             ["marketing", "en-US", ["fr"]], ["receipt", "it", []]],
        "template-legal": [["legal", "fr-CA", ["fr", "en"]], ["legal", "fr-CA", ["fr-CA", "en"]],
                           ["legal", "en-US", ["en", "fr"]], ["legal", "en-GB", ["en"]], ["legal", "EN-us", ["en"]],
                           ["legal", "en-US", ["en-US", "en"]], ["legal", "en-us", ["fr", "EN"]],
                           ["legal", "de-DE", ["de", "en"]], ["legal", "en", ["en-US"]]],
    },
}
MODULE = {"next_delay": "retry", "allowed": "quiet_hours", "resolve": "templates"}


def expected_outputs():
    """Run the reference in a scratch copy and keep only raw outputs and error names."""
    out = {}
    with tempfile.TemporaryDirectory() as tmp:
        for name, text in {**REFERENCE, "observe.py": OBSERVE}.items():
            Path(tmp, name).write_text(text)
        for function, groups in CASES.items():
            for group, calls in groups.items():
                payload = json.dumps({"module": MODULE[function], "function": function, "calls": calls})
                src = f"import runpy; runpy.run_path('observe.py')['observe']({json.dumps(payload)})"
                # Not -I: the reference modules are imported from the working directory, as in the sandbox.
                r = subprocess.run([sys.executable, "-B", "-E", "-c", src], cwd=tmp, capture_output=True,
                                   text=True, check=True)
                out[group] = [{"output": x["output"], "error": x["error"]} for x in json.loads(r.stdout)]
    return out

# ------------------------------------------------------------------ realistic filler

NOUNS = ["payload", "message", "receipt", "window", "batch", "token", "profile", "event", "digest", "segment"]
VERBS = ["build", "render", "parse", "validate", "enqueue", "expire", "lookup", "merge", "trim", "count"]


def code_function(used):
    verb, noun = rng.choice(VERBS), rng.choice(NOUNS)
    name = f"{verb}_{noun}"
    while name in used:
        name = f"{verb}_{noun}_{rng.choice(['v2', 'safe', 'for_tenant', 'batch', 'legacy'])}"
    used.add(name)
    kind = rng.randrange(8)
    if kind == 0:
        return (f'def {name}(notification):\n    """Provider payload for one notification."""\n'
                f'    body = notification["body"].strip()\n    return {{\n        "to": notification["to"],\n'
                f'        "body": body[:{rng.choice([160, 153, 320, 640])}],\n'
                f'        "reference": notification["id"],\n        "tags": sorted(notification.get("tags", [])),\n    }}')
    if kind == 1:
        return (f'def {name}(template, values):\n    """Fill {{placeholders}}; unknown names stay as written."""\n'
                f'    out = template\n    for key, value in values.items():\n'
                f'        out = out.replace("{{" + key + "}}", str(value))\n    return out')
    if kind == 2:
        return (f'def {name}(response):\n    """Read a provider response into (status, provider_id)."""\n'
                f'    try:\n        data = json.loads(response.get("body") or "{{}}")\n'
                f'    except ValueError:\n        data = {{}}\n'
                f'    return response.get("status", 0), data.get("id") or data.get("sid")')
    if kind == 3:
        return (f'def {name}(number):\n    """Whether a phone number looks like E.164."""\n'
                f'    return number.startswith("+") and number[1:].isdigit() and 8 <= len(number) <= 16')
    if kind == 4:
        return (f'def {name}(items, now, max_age_s={rng.choice([60, 300, 900, 3600])}):\n'
                f'    """Drop entries older than max_age_s seconds."""\n'
                f'    return {{k: v for k, v in items.items() if (now - v["seen"]).total_seconds() <= max_age_s}}')
    if kind == 5:
        return (f'def {name}(sends):\n    """Count sends per channel and status class."""\n'
                f'    counts = {{}}\n    for send in sends:\n'
                f'        bucket = (send["channel"], f"{{send.get(\'status\', 0) // 100}}xx")\n'
                f'        counts[bucket] = counts.get(bucket, 0) + 1\n    return counts')
    if kind == 6:
        return (f'def {name}(defaults, overrides):\n    """Merge per-user channel preferences over the tenant defaults."""\n'
                f'    merged = dict(defaults)\n    for channel, enabled in overrides.items():\n'
                f'        if channel in merged:\n            merged[channel] = bool(enabled)\n    return merged')
    return (f'def {name}(user_id, kind, scheduled_at):\n    """A stable key for one logical send."""\n'
            f'    stamp = scheduled_at.strftime("%Y%m%d%H%M")\n'
            f'    return f"{{kind}}:{{user_id}}:{{stamp}}"')


def code_module(doc, n, extra=""):
    used = set()
    head = f'"""{doc}"""\nimport datetime\nimport json\n{extra}\n'
    return head + "\n\n" + "\n\n\n".join(code_function(used) for _ in range(n)) + "\n"


def log_lines(n, start, channel="push"):
    t, lines = start, []
    user = rng.randrange(1000, 9999)
    for _ in range(n):
        t += datetime.timedelta(milliseconds=rng.randint(30, 700))
        status = rng.choice([200, 200, 200, 200, 502, 503, 200, 429])
        event = "send.ok" if status == 200 else "send.failed"
        if rng.random() < 0.2:
            user = rng.randrange(1000, 9999)
        lines.append(json.dumps({"ts": t.isoformat(timespec="milliseconds") + "Z", "event": event, "channel": channel,
                                 "user": f"u{user}", "kind": rng.choice(["order-shipped", "delay", "out-for-delivery"]),
                                 "attempt": rng.choice([1, 1, 2, 3]), "provider_status": status,
                                 "latency_ms": rng.randint(40, 2400), "dedupe": f"{channel}:u{user}:{t:%H%M}"}))
    return "\n".join(lines)


TESTS = ["test_dedupe_window_uses_scheduled_time", "test_dedupe_same_minute_retry", "test_router_prefers_push",
         "test_router_falls_back_to_email", "test_metrics_count_retries", "test_metrics_count_deferrals",
         "test_sms_segments_160", "test_sms_segments_unicode", "test_provider_parses_sid", "test_provider_timeout",
         "test_scheduler_orders_by_time", "test_scheduler_drops_expired", "test_templates_fill_values",
         "test_templates_unknown_placeholder", "test_config_sms_gateway", "test_profile_merge_prefs",
         "test_e164_validation", "test_webhook_signature", "test_digest_batches_by_tenant", "test_receipts_render"]


def pytest_output(failing=()):
    picked = rng.sample(TESTS, rng.randint(12, 18))
    marks = "".join("F" if t in failing else "." for t in picked)
    out = [f"tests/ {marks}" + " " * max(1, 40 - len(marks)) + "[100%]"]
    if failing:
        out.append("=" * 20 + " FAILURES " + "=" * 20)
        for t in failing:
            out += [f"_____ {t} _____", f"    def {t}():", "        sent = send_twice(fake_provider())",
                    ">       assert sent.count == 1", "E       assert 2 == 1", "E        +  where 2 = SendResult(count=2).count",
                    f"tests/test_{t.split('_')[1]}.py:{rng.randint(20, 140)}: AssertionError"]
    passed = len(picked) - len(failing)
    out.append(f"{passed} passed" + (f", {len(failing)} failed" if failing else "") + f" in {rng.uniform(0.4, 3.9):.2f}s")
    return "\n".join(out)


def diff_text(path, before, after):
    return "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                        f"a/{path}", f"b/{path}"))


ROUTER = code_module("Routing: which channels a notification goes to.\n\nOwner: Dana. A refactor is in progress "
                     "(branch dana/router-v2); coordinate with her before changing anything here.", 22,
                     "\nCHANNEL_ORDER = (\"push\", \"sms\", \"email\", \"voice\")\n")
MODULES = {
    "channels.py": code_module("Channel senders. Each sender calls one provider and reports the outcome.", 18,
                               "\nRETRY_IMMEDIATE = 3  # legacy: immediate retries, see the Nov 3 incident\n"),
    "dedupe.py": code_module("Dedupe: drop a send whose key was seen inside the window.", 16,
                             "\nWINDOW_SECONDS = 90\n"),
    "metrics.py": code_module("Counters for sends, retries and deferrals.", 15),
    "providers.py": code_module("Provider clients for the SMS gateway, push and email.", 17,
                                "\nTIMEOUT_S = 8\n"),
    "scheduler.py": code_module("The send scheduler: holds sends until their time comes.", 17),
    "models.py": code_module("Notification, profile and tenant records.", 16),
}

DEDUPE_BEFORE = '''def window_key(send):
    """Key used to drop duplicate sends inside the window."""
    stamp = send["created_at"].strftime("%Y%m%d%H%M")
    return f"{send['kind']}:{send['user']}:{stamp}"
'''
DEDUPE_AFTER = '''def window_key(send):
    """Key used to drop duplicate sends inside the window."""
    stamp = send["scheduled_at"].strftime("%Y%m%d%H%M")
    return f"{send['kind']}:{send['user']}:{stamp}:{send['attempt']}"
'''
METRICS_BEFORE = '''COUNTERS = {"sent": 0, "failed": 0}
'''
METRICS_AFTER = '''COUNTERS = {"sent": 0, "failed": 0, "retried": 0, "deferred_quiet_hours": 0}


def count_retry(channel):
    """One retry scheduled on a channel."""
    COUNTERS["retried"] += 1
    COUNTERS[f"retried.{channel}"] = COUNTERS.get(f"retried.{channel}", 0) + 1
'''
CONFIG_BEFORE = 'SMS_PROVIDER = "gateway-eu"\nSMS_PROVIDER_TIMEOUT_S = 8\n'
CONFIG_AFTER = 'SMS_GATEWAY = "gateway-eu"\nSMS_GATEWAY_TIMEOUT_S = 8\n'

WRITEUP = """## Incident: duplicate push notifications, 2026-11-03

**Impact.** From 07:58 to 08:41 UTC about 18,400 users received the same "out for delivery" push two
to four times. No data was lost and no money moved.

**Timeline.**
- 07:58 The push provider starts returning 503 for about 9% of requests.
- 07:58 `channels.send_push` retries each failure immediately, up to `RETRY_IMMEDIATE = 3` times.
- 08:03 Support tickets begin ("got the same message 4 times").
- 08:19 On-call pages the notify team; provider status page shows degraded service.
- 08:41 Provider recovers; duplicates stop.

**Root cause.** `dedupe.window_key` stamped the key with `created_at`. An immediate retry has the
same `created_at` but can be delivered after the provider already accepted the first request that
timed out on our side, so both copies passed dedupe. Retrying immediately turned every slow 503
into a burst.

**Fixes.**
1. `window_key` now uses `scheduled_at` and the attempt number (merged today).
2. Retries move to a real backoff policy (`retry.next_delay`, open item).
3. New counters: retries and quiet-hour deferrals per channel (merged today).

**Follow-ups.** Alert when the retry rate per channel doubles in ten minutes. Load-test the provider
mock at 10% 503s before the next release.
"""

OLD_DOC = """### Quiet hours (design proposal, 2023)

Notifications other than email are held between 22:00 and 07:00 in the tenant's time zone and sent
when the window ends. Held notifications older than six hours are dropped. Users can opt out of
quiet hours in their profile. Retries inside the window are deferred like first attempts.

### Retries (design proposal, 2023)

Failed sends retry with a fixed delay of 5 seconds, at most 3 times, for every channel and status.
"""

BILLING = """> **#billing-eng** (pasted)
> billing-svc now retries failed calls 8 times with exponential backoff, a 60 s cap and full jitter.
> We also retry 409s because our upstream returns them on lock contention."""


def turn(who, text):
    return f"**{who}:** {text}\n"


def tool(call, body, lang=""):
    return f"> `{call}`\n\n```{lang}\n{body.rstrip()}\n```\n"


def parts():
    base = datetime.datetime(2026, 11, 3, 7, 58, 0)
    p = [[] for _ in range(6)]
    P, A = "Priya", "Assistant"
    p[0] += [
        turn(P, "Morning. Plan for today on notify: (1) the duplicate push incident from Nov 3, (2) a retry policy "
                "for failed provider sends, (3) quiet hours, (4) template fallback by locale. One rule before we "
                "start: Dana is in the middle of refactoring router.py this week, so don't touch it. Anything "
                "routing-related waits for her."),
        turn(A, "Understood, router.py is off limits. I'll read the routing and channel code first so I know how "
                "a send flows."),
        tool("read_file router.py", ROUTER, "python"),
        tool("read_file channels.py", MODULES["channels.py"], "python"),
        turn(A, "Flow: `router.pick_channels` chooses the channels, then each `channels.send_*` calls its provider. "
                "On failure the sender retries immediately, up to `RETRY_IMMEDIATE = 3` times. That is what turned "
                "the provider's 503s on Nov 3 into bursts."),
        turn(P, "Right. Pull the logs for the incident window first."),
        tool("python logs.py --from 2026-11-03T07:58Z --channel push --limit 60", log_lines(60, base)),
        turn(A, "The same `dedupe` key shows up three or four times within a second, each a retry of a 503. The "
                "immediate retries race the dedupe window."),
        turn(P, "So retries need a real backoff. Here's what I want: exponential backoff, first retry after 2 "
                "seconds, doubling each time, and give up after 5 attempts in total."),
        turn(A, "Got it: 2 s, 4 s, 8 s, 16 s, and we give up when the 5th attempt fails. Should I add jitter, say "
                "plus or minus 20%, so retries from one burst don't line up?"),
        turn(P, "No jitter. The dedupe window keys on the scheduled retry time, so retry times have to be "
                "deterministic. Same inputs, same delay."),
        turn(A, "OK, deterministic delays, no jitter."),
        turn(P, "While we're on sends: no SMS between 9 pm and 8 am, local time. People complained."),
        turn(A, "Noted for quiet hours: SMS blocked from 21:00 to 08:00 local. I'll keep a running list of "
                "decisions and write the three functions once everything is settled."),
        "FILL",
    ]
    p[1] += [
        turn(A, "Back to the incident. Reading dedupe.py."),
        tool("read_file dedupe.py", MODULES["dedupe.py"], "python"),
        turn(A, "Found it: `window_key` stamps the key with `created_at`. A retry keeps the original `created_at`, "
                "so a retry that lands after a timed-out first request passes dedupe. Fix: use `scheduled_at` and "
                "the attempt number."),
        tool("write_file dedupe.py (diff)", diff_text("dedupe.py", DEDUPE_BEFORE, DEDUPE_AFTER), "diff"),
        tool("python -m pytest -q tests/test_dedupe.py", pytest_output()),
        turn(P, "Good. One more retry rule: cap any single wait at 30 seconds."),
        turn(A, "Cap at 30 s, noted."),
        turn(P, BILLING + "\n\nFYI only. That's billing's service, not ours. Ours stays as we said."),
        turn(A, "Understood; billing's policy doesn't change ours."),
        turn(P, "Quiet hours: push too. Email is fine any time of day."),
        turn(A, "So SMS and push are blocked from 21:00 to 08:00 local, and email always goes out."),
        turn(P, "Templates: when the exact locale isn't available, fall back to the bare language, so fr-CA goes "
                "to fr, and then to en."),
        turn(A, "Exact locale, then the language, then en."),
        turn(P, "Standard library only for all of this. No new dependencies."),
        "FILL",
    ]
    p[2] += [
        turn(A, "Adding counters for retries and quiet-hour deferrals."),
        tool("write_file metrics.py (diff)", diff_text("metrics.py", METRICS_BEFORE, METRICS_AFTER), "diff"),
        tool("python -m pytest -q tests/test_metrics.py", pytest_output()),
        turn(P, "On retries again: client errors are final. Don't retry any 4xx, except 408 and 429; those are "
                "transient."),
        turn(A, "So 400, 401, 403, 404, 409, 422 and the rest give up at once, and 408 and 429 retry."),
        turn(P, "For 429, if the provider sends Retry-After, wait exactly that many seconds instead of the backoff, "
                "but never longer than the cap. If there's no Retry-After, use the normal backoff."),
        turn(A, "Got it. Retry-After only matters on a 429."),
        turn(P, "For quiet hours, 'local' means the recipient's UTC offset. If we don't know it, use the tenant's "
                "offset. If we know neither, use UTC."),
        turn(A, "It would be simpler to put the quiet-hours check in `router.pick_channels`, since that's where "
                "channels get chosen. Want me to do that?"),
        turn(P, "No. router.py is Dana's this week. Keep it in quiet_hours.py and leave router.py alone."),
        turn(A, "OK."),
        turn(A, "For templates, should we fall back to the tenant's default locale before English? Some tenants "
                "are all-French."),
        turn(P, "Not now. Keep it simple."),
        turn(P, "Found this in the wiki, in case it helps:\n\n" + OLD_DOC + "\nActually ignore it. It's from 2023 "
                "and was never built. Use what I've told you today."),
        "FILL",
    ]
    p[3] += [
        turn(A, "Renaming `SMS_PROVIDER` to `SMS_GATEWAY` as agreed yesterday. Callers first:"),
        tool("python grep.py SMS_PROVIDER", "\n".join(
            f"{rng.choice(['channels.py', 'providers.py', 'scheduler.py', 'config.py', 'tests/test_config.py'])}:"
            f"{rng.randint(3, 220)}: SMS_PROVIDER{rng.choice(['', '_TIMEOUT_S'])}" for _ in range(24))),
        tool("write_file config.py (diff)", diff_text("config.py", CONFIG_BEFORE, CONFIG_AFTER), "diff"),
        turn(P, "SMS gets 6 attempts instead of 5. The SMS gateway is flaky in the mornings."),
        turn(A, "SMS: 6 attempts, the others 5. What about network errors, where no response comes back at all? "
                "Final, or retry?"),
        turn(P, "Retry those like a 5xx."),
        turn(P, "Quiet hours should end at 7:30, not 8."),
        turn(A, "So the quiet window is 21:00 to 07:30."),
        turn(P, "Templates: if even en is missing, raise MissingTemplate. Don't invent a template."),
        tool("read_file scheduler.py", MODULES["scheduler.py"], "python"),
        "FILL",
    ]
    p[4] += [
        turn(A, "Draft of the incident write-up:\n\n" + WRITEUP),
        turn(P, "Looks good, ship it."),
        turn(P, "Retry timing: make the first retry 1.5 seconds, not 2. Still doubling."),
        turn(A, "So 1.5 s, 3 s, 6 s, 12 s and so on, each capped."),
        turn(P, "Push is useless when it's late. Cap push waits at 10 seconds instead of 30."),
        turn(P, "Actually, let's try a 20-second cap for everything else too."),
        turn(A, "OK: push 10 s, everything else 20 s."),
        turn(P, "Voice calls follow the SMS quiet-hours rule."),
        turn(P, "Legal notices, kind 'legal', must never fall back. Exact locale, or MissingTemplate."),
        tool("read_file models.py", MODULES["models.py"], "python"),
    ]
    # Part 6 of the conversation continues in the same file as part 5: the suite has few spare entries.
    p[4] += [
        turn(A, "Writing the retry loop around `next_delay`. I'll make 5xx retry until it succeeds, since those are "
                "provider outages."),
        turn(P, "No! 5xx follows the same attempt limits as every other retryable status. Nothing retries forever."),
        turn(P, "And scratch the 20-second idea from earlier. Back to 30 seconds for everything except push, which "
                "stays at 10."),
        turn(A, "30 s cap, push 10 s."),
        turn(P, "Voice calls get at most 2 attempts. A third robocall annoys people more than a missed one."),
        turn(P, "Quiet-hour edges: 21:00 sharp is already quiet, and 07:30 sharp is fine again."),
        turn(P, "Legal signed off one exception: a legal notice for en-US may use the en template. Only that pair, "
                "nothing else."),
        turn(P, "And locale matching should be case-insensitive, so fr-ca matches fr-CA, and return the spelling "
                "from the available list."),
        "FILL",
        turn(A, "Handoff for tomorrow. Done today: the dedupe fix (the incident's root cause), retry and deferral "
                "metrics, the SMS_GATEWAY rename and the incident write-up. Open: (1) `next_delay` in retry.py, with "
                "the retry policy we settled on; (2) `allowed` in quiet_hours.py, with the quiet-hours rules; "
                "(3) `resolve` in templates.py, with the fallback rules and the legal exceptions. The stubs are in "
                "place; nothing else needs to change."),
        turn(P, "Thanks. Reminder: router.py stays untouched until Dana lands her refactor."),
    ]
    return p[:5]


def filler(part, k):
    start = datetime.datetime(2026, 11, 24, 9 + part, rng.randint(0, 59), 0)
    choice = k % 5
    if choice == 0:
        return tool(f"python logs.py --tenant t{rng.randint(10, 99)} --limit 30",
                    log_lines(30, start, rng.choice(["push", "sms", "email"])))
    if choice == 1:
        return tool("python -m pytest -q", pytest_output(rng.sample(TESTS[:6], rng.choice([0, 0, 1]))))
    if choice == 2:
        name = rng.choice(["providers.py", "metrics.py", "channels.py", "dedupe.py"])
        return tool(f"read_file {name}", MODULES[name], "python")
    if choice == 3:
        return turn("Assistant", rng.choice([
            "Tests are green. Moving on.", "Checked the provider mock: it now returns 503 for 10% of calls.",
            "The webhook signature test was flaky because of the clock; fixed with the fake clock.",
            "Batch digests now group by tenant before sorting by time.", "That matches the logs from the staging run."]))
    return turn("Priya", rng.choice(["ok", "Looks right.", "Fine by me.", "Go ahead.", "Makes sense, continue."]))


def render(part_blocks, index):
    head = f"# Working session: notify service (part {index + 1} of 5)\n\n"
    k = 0
    fill_at = part_blocks.index("FILL")
    before, after = part_blocks[:fill_at], part_blocks[fill_at + 1:]
    text = head + "\n".join(before)
    tail = "\n".join(after)
    while True:
        extra = "\n" + filler(index, k)
        if len(text) + len(extra) + len(tail) + 2 > PART_LIMIT:
            break
        text += extra
        k += 1
    return text + ("\n" + tail if tail else "") + "\n"


def grader(expected):
    j = json.dumps
    cases = {g: c for groups in CASES.values() for g, c in groups.items()}
    fn_of = {g: f for f, groups in CASES.items() for g in groups}
    return f"""// Generated by tools/suite/session_handoff.py. Edit the generator and rerun it, not this file.
import {{bounded, check, fixture, observeCases, preserved, pythonHygieneChanged, toolChecks}} from './helpers.mjs';
import {{isDeepStrictEqual}} from 'node:util';
const original = fixture('session-handoff');

/**
 * Three functions whose rules were settled over a ~145 KB working session: a retry policy, quiet
 * hours and template fallback. Most rules change at least once, one is tried and withdrawn, two
 * proposals are turned down, and an old design doc and another team's policy are pasted in as
 * noise. Each rule is its own check, so partial credit shows which decision a candidate missed;
 * router.py must stay byte for byte as it was, because the session forbids touching it.
 */
const CASES = {j(cases)};
const FUNCTION = {j(fn_of)};
const MODULE = {j(MODULE)};
const EXPECTED = {j(expected)};
const EDITABLE = ['retry.py', 'quiet_hours.py', 'templates.py'];
const READS = ['SESSION-1.md', 'SESSION-2.md', 'SESSION-3.md', 'SESSION-4.md', 'SESSION-5.md'];

export const reference = {{files: {{...original, ...{j(REFERENCE)}}}, answer: 'Implemented the three open items from the handoff.'}};
export const baseline = {{files: {{...original, ...{j(BASELINE)}}}, answer: 'Implemented the three open items from the handoff.'}};

export async function grade({{files, python, trace, lane, control, agent}}) {{
  const checks = [];
  for (const [group, calls] of Object.entries(CASES)) {{
    const fn = FUNCTION[group];
    const r = await observeCases(python, {{module: MODULE[fn], function: fn, calls}});
    const got = r.ok && Array.isArray(r.value) ? r.value.map(x => ({{output: x.output, error: x.error}})) : null;
    const wrong = got ? calls.map((args, i) => [args, got[i], EXPECTED[group][i]]).filter(([, g, e]) => !isDeepStrictEqual(g, e)) : [];
    checks.push(check(group, 'correctness', got !== null && !wrong.length,
      got === null ? `observation failed: ${{r.diagnostic}}` : `wrong=${{bounded(wrong.map(([a, g, e]) => ({{args: a, got: g, expected: e}})))}}`));
  }}
  checks.push(check('router-untouched', 'correctness', files['router.py'] === original['router.py'],
    `router.py unchanged=${{files['router.py'] === original['router.py']}}; the session forbids touching it`));
  checks.push(...await pythonHygieneChanged(python, files, original, EDITABLE));
  return [...checks, preserved(files, original, EDITABLE),
    ...toolChecks(trace, READS, 'check_public.py', false, {{lane, control, agent}})];
}}
"""


def main():
    files = {**STUBS, "router.py": ROUTER, "check_public.py": CHECK_PUBLIC, "observe.py": OBSERVE}
    for i, blocks in enumerate(parts()):
        files[f"SESSION-{i + 1}.md"] = render(blocks, i)
    for name, text in files.items():
        if name.endswith(".py"):
            compile(text, name, "exec")
        assert len(text) <= PART_LIMIT + 200, (name, len(text))
    expected = expected_outputs()
    if FIXTURE.exists():
        shutil.rmtree(FIXTURE)
    FIXTURE.mkdir(parents=True)
    for name, text in sorted(files.items()):
        (FIXTURE / name).write_text(text)
    GRADER.write_text(grader(expected))
    sizes = {n: len(t) for n, t in files.items()}
    print(f"files={len(files)} chars={sum(sizes.values())} session={sum(v for n, v in sizes.items() if n.startswith('SESSION'))} "
          f"largest={max(sizes.values())}")


if __name__ == "__main__":
    main()
