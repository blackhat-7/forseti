#!/usr/bin/env python3
"""Generate the payments-audit task: a read-only audit of a ~170 KB payments service.

Run from the repository root:  python3 tools/suite/payments_audit.py
Writes suites/personal/fixtures/payments-audit/ and suites/personal/private/payments-audit.mjs.
The output depends only on the seed it settles on, so a rerun rewrites the same bytes.

The answer is computed from the call graph the code is generated from, then checked by importing
the generated service and sending every registered route a request with and without the header.
The suite allows 400 entries in total, so the service is a few large modules, not one per domain.
"""
import json
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "suites" / "personal" / "fixtures" / "payments-audit"
GRADER = ROOT / "suites" / "personal" / "private" / "payments-audit.mjs"

AREAS = {
    "payments": ["charges", "refunds", "disputes"],
    "billing": ["invoices", "subscriptions", "coupons"],
    "treasury": ["payouts", "transfers", "settlements"],
    "balances": ["wallets", "credits", "taxes"],
    "corrections": ["chargebacks", "reversals", "adjustments"],
    "deposits": ["deposits"],  # written, but app.py does not import it; built last so nothing else imports it
}
OBJ = {"charges": "charge", "refunds": "refund", "disputes": "dispute", "invoices": "invoice",
       "subscriptions": "subscription", "coupons": "coupon", "payouts": "payout", "transfers": "transfer",
       "settlements": "settlement", "wallets": "wallet", "credits": "credit", "taxes": "tax",
       "chargebacks": "chargeback", "reversals": "reversal", "adjustments": "adjustment", "deposits": "deposit"}
AREA_OF = {d: a for a, ds in AREAS.items() for d in ds}
UNIMPORTED = "deposits"
FEATURES = {"instant_payouts": False, "coupon_stacking": True, "tax_recalc": False,
            "dispute_autoaccept": True, "wallet_sweeps": False, "credit_expiry": True}
LEAF_VERBS = ["book", "record", "accrue", "release", "reserve", "settle", "apply", "write_off", "split", "post"]
LEAF_SUFFIXES = ["", "_fee", "_hold", "_line", "_balance", "_remainder", "_payable", "_interest"]
ORCH_VERBS = ["process", "finalize", "complete", "reopen", "expire", "close", "approve", "cancel",
              "retry", "rebalance", "confirm", "migrate"]
ACTIONS = ["capture", "cancel", "approve", "close", "retry", "reopen", "settle", "expire", "confirm", "release"]
ACCOUNTS = ["merchant", "platform", "reserve", "fees", "tax", "suspense", "customer"]
# Request fields that switch a branch on. All of them can be sent in one request, so every branch is reachable,
# but a request with default fields reaches none: running the routes once with sample input misses those writes.
CONDS = [('{o}.get("expedite")', "expedite", True), ('{o}["amount"] > 1000', "amount", 1500),
         ('{o}.get("currency", "USD") != "USD"', "currency", "EUR"), ('{o}.get("partial")', "partial", True),
         ('{o}.get("source") == "batch"', "source", "batch")]


class Fn:
    def __init__(self, name, module, role, obj, doc, write=None, decorated=False):
        self.name, self.module, self.role, self.obj, self.doc = name, module, role, obj, doc
        self.write, self.decorated, self.alias = write, decorated, False
        self.calls = []  # (Fn, "forward" | "drop")

    @property
    def ref(self):
        return f"{self.module}.{self.name}"


class Handler:
    def __init__(self, domain, name, method, path, key_mode, reg, feature):
        self.domain, self.obj, self.module = domain, OBJ[domain], AREA_OF[domain]
        self.name, self.method, self.path = name, method, path
        self.key_mode, self.reg, self.feature = key_mode, reg, feature
        self.calls = []

    @property
    def route(self):
        return f"{self.method} {self.path}"


def build(rng):
    services, handlers, jobs, names = {}, [], [], set()

    def unique(name):
        base, n = name, 2
        while name in names:
            name, n = f"{base}_{n}", n + 1
        names.add(name)
        return name

    fees = []
    for kind, name, doc in [("nokey", "charge_processing_fee", "Book the processor's fee for one object."),
                            ("own", "charge_network_fee", "Book the card network's fee under its own key."),
                            ("pass", "charge_platform_fee", "Book the platform fee under the caller's key.")]:
        names.add(name)
        fees.append(Fn(name, "ledger", "leaf", "obj", doc, write=kind))

    for domain in [d for ds in AREAS.values() for d in ds]:
        obj, module = OBJ[domain], AREA_OF[domain]
        fns = []
        for _ in range(3):
            kind = rng.choices(["pass", "nokey", "own"], [5, 3, 3])[0]
            verb, suffix = rng.choice(LEAF_VERBS), rng.choice(LEAF_SUFFIXES)
            what = suffix.strip("_").replace("_", " ") or obj
            fn = Fn(unique(f"{verb}_{obj}{suffix}"), module, "leaf", obj,
                    rng.choice([f"Book the {obj}'s {what} to the ledger.", f"Write the ledger line for a {obj} {what}.",
                                f"Record the {what} owed on a {obj}.", f"Post the {what} for one {obj}."]),
                    write=kind)
            fn.alias = kind in ("nokey", "pass") and rng.random() < 0.3
            fns.append(fn)
        pool = [f for fs in services.values() for f in fs]
        for _ in range(3):
            verb = rng.choice(ORCH_VERBS)
            fn = Fn(unique(f"{verb}_{obj}"), module, "orch", obj,
                    rng.choice([f"{verb.capitalize()} a {obj} and book the resulting ledger lines.",
                                f"Run the {verb} step for a {obj}.",
                                f"{verb.capitalize()} the {obj}; ledger lines follow from its state."]),
                    decorated=rng.random() < 0.18)
            for _ in range(rng.choice([1, 2, 2, 3])):
                r = rng.random()
                target = rng.choice(fns) if r < 0.55 or not pool else rng.choice(pool) if r < 0.9 else rng.choice(fees)
                if all(target is not t for t, _, _ in fn.calls):
                    cond = rng.randrange(len(CONDS)) if rng.random() < 0.35 else None
                    fn.calls.append((target, "drop" if rng.random() < 0.14 else "forward", cond))
            fns.append(fn)
        services[domain] = fns

    for domain in services:
        obj = OBJ[domain]
        writers = list(services[domain])
        specs = [("POST", f"/v1/{domain}", f"create_{obj}")] + \
                [("POST", f"/v1/{domain}/{{id}}/{a}", f"{a}_{obj}") for a in rng.sample(ACTIONS, rng.choice([1, 2, 2, 3]))]
        if rng.random() < 0.3:
            specs.append(("DELETE", f"/v1/{domain}/{{id}}", f"delete_{obj}"))
        for method, path, name in specs:
            key_mode = rng.choices(["required", "header", "derived", "none"], [4, 3, 2, 2])[0]
            r = rng.random()
            reg = "registered" if domain == UNIMPORTED or r >= 0.2 else "dead" if r < 0.07 else "flag"
            h = Handler(domain, unique(name), method, path, key_mode, reg,
                        rng.choice(sorted(FEATURES)) if reg == "flag" else None)
            h.calls.append((rng.choice(writers), "forward" if key_mode != "none" else "drop", None))
            if rng.random() < 0.3:
                h.calls.append((rng.choice(fees + writers), "drop" if rng.random() < 0.5 else "forward",
                                rng.randrange(len(CONDS)) if rng.random() < 0.5 else None))
            handlers.append(h)
        handlers.append(Handler(domain, unique(f"get_{obj}"), "GET", f"/v1/{domain}/{{id}}", "none", "registered", None))

    callable_by_jobs = [f for d, fs in services.items() if d != UNIMPORTED for f in fs]
    for name in ["sweep_unsettled_fees", "expire_stale_holds", "nightly_rebalance", "replay_failed_posts"]:
        job = Fn(name, "jobs", "job", "item", "")
        job.calls = [(t, "drop", None) for t in rng.sample(callable_by_jobs, 2)]
        jobs.append(job)
    return services, handlers, fees, jobs


def unsafe_depths(fn, status, depth, naive=False):
    if fn.decorated:
        status = "present"
    if fn.write == "nokey" or (fn.write == "pass" and status != "present"):
        yield depth
    for callee, mode, cond in fn.calls:
        if naive and cond is not None:
            continue
        yield from unsafe_depths(callee, status if mode == "forward" else "none", depth + 1, naive)


def route_depths(h, start=None, naive=False):
    """Depths of the writes without a key that one request can reach; naive=True skips request-dependent branches."""
    status = start or {"required": "present", "derived": "present", "header": "maybe", "none": "none"}[h.key_mode]
    found = []
    for callee, mode, cond in h.calls:
        if naive and cond is not None:
            continue
        found += list(unsafe_depths(callee, status if mode == "forward" else "none", 1, naive))
    return found


def registered(h):
    if h.domain == UNIMPORTED or h.reg == "dead":
        return False
    return h.reg == "registered" or FEATURES[h.feature]


def classify(handlers):
    live = [h for h in handlers if registered(h)]
    gone = [h for h in handlers if not registered(h)]
    unsafe = sorted({h.route for h in live if route_depths(h)})
    return dict(
        unsafe=unsafe,
        direct=sorted({h.route for h in live if route_depths(h) and min(route_depths(h)) <= 2}),
        deep=sorted({h.route for h in live if route_depths(h) and min(route_depths(h)) >= 3}),
        optional=sorted({h.route for h in live if h.key_mode == "header" and route_depths(h)
                         and not route_depths(h, "present")}),
        safe=sorted({h.route for h in live} - set(unsafe)),
        unregistered=sorted({h.route for h in gone} - {h.route for h in live}),
        unregistered_unsafe=sorted({h.route for h in gone if route_depths(h)}),
        conditional=sorted({h.route for h in live if route_depths(h) and not route_depths(h, naive=True)}),
        naive=sorted({h.route for h in live if route_depths(h, naive=True)}),
    )


def acceptable(c):
    return (10 <= len(c["unsafe"]) <= 16 and len(c["direct"]) >= 4 and len(c["deep"]) >= 4
            and len(c["optional"]) >= 3 and len(c["unregistered_unsafe"]) >= 4
            and len([r for r in c["safe"] if not r.startswith("GET ")]) >= 12 and len(c["conditional"]) >= 4)


# ---------------------------------------------------------------- code text

MISLEADING = {
    "nokey": ["# Idempotency is handled by the caller.", "# Safe to retry: the ledger de-duplicates these lines.",
              "# Key not needed here (see the design notes in README.md)."],
    "pass": ["# FIXME(idempotency): confirm callers always send a key.", "# Uses the request's key."],
    "own": ["# TODO: move to the request key once clients send one."],
}


def write_line(fn, rng, local=False):
    p = "" if local else "ledger."
    if fn.write == "pass":
        return "book_entry(entry, key)" if fn.alias else f"{p}post(entry, key)"
    if fn.write == "own":
        prefix = fn.name.replace("_", "-")
        return rng.choice([f'{p}append(entry, idempotency_key=f"{prefix}:{{{fn.obj}[\'id\']}}")',
                           f'{p}post(entry, f"{prefix}:{{{fn.obj}[\'id\']}}")'])
    if fn.alias:
        return "_append(entry)"
    return rng.choice([f"{p}post_fee(entry)", f"{p}append(entry)", f"{p}post_adjustment(entry)"])


def call_text(module, callee, mode, arg):
    target = callee.name if callee.module == module else callee.ref
    if mode == "forward":
        return f"{target}({arg}, key=key)"
    return f"{target}({arg}, key=None)" if len(callee.name) % 2 else f"{target}({arg})"


def function_text(fn, rng):
    o = fn.obj
    lines = ["@idempotent"] if fn.decorated else []
    lines += [f"def {fn.name}({o}, *, key=None):", f'    """{fn.doc}"""',
              rng.choice([f'    if {o}.get("status") == "void":\n        raise ValueError(f"{o} {{{o}[\'id\']}} is void")',
                          f'    if {o}.get("amount", 0) < 0:\n        raise ValueError("negative amount")',
                          f'    web.require_fields({o}, ("id", "amount"))'])]
    if fn.role == "leaf":
        lines.append(f'    amount = ledger.minor_units({o}["amount"], {o}.get("currency", "USD"))')
        if rng.random() < 0.3:
            lines.append(f'    amount = ledger.convert(amount, {o}.get("currency", "USD"), "USD")')
        lines.append(f'    entry = ledger.Entry(account={o}.get("account", "{rng.choice(ACCOUNTS)}"), '
                     f'amount={rng.choice(["", "-"])}amount,')
        lines.append(f'                         kind="{fn.name.replace("_", ".")}", reference={o}["id"])')
        lines.append(f'    ledger.record_event("{o}.{fn.name}", {o}["id"], amount=amount)')
        if rng.random() < 0.35:
            lines.append("    " + rng.choice(MISLEADING[fn.write]))
        lines += [f"    {write_line(fn, rng)}", "    return entry"]
    else:
        for callee, mode, cond in fn.calls:
            if mode == "drop" and rng.random() < 0.5:
                lines.append("    # Replays must not reuse the original key.")
            if cond is None:
                lines.append(f"    {call_text(fn.module, callee, mode, o)}")
            else:
                lines += [f"    if {CONDS[cond][0].format(o=o)}:", f"        {call_text(fn.module, callee, mode, o)}"]
        lines += [f'    web.queue_notification("{o}.{fn.name}", {o}["id"])', f'    return {o}["id"]']
    return "\n".join(lines)


def helper_text(obj, rng, names):
    kind = rng.randrange(9)
    if kind == 0:
        return (f'def {names(f"describe_{obj}")}({obj}):\n    """A one-line summary for support tooling."""\n'
                f'    amount = ledger.format_minor(ledger.minor_units({obj}["amount"], {obj}.get("currency", "USD")),'
                f' {obj}.get("currency", "USD"))\n'
                f'    return f"{obj} {{{obj}[\'id\']}}: {{amount}} ({{{obj}.get(\'status\', \'new\')}})"')
    if kind == 1:
        return (f'def {names(f"{obj}_payload")}({obj}):\n    """The public JSON shape of a {obj}."""\n'
                f'    return {{\n        "id": {obj}["id"],\n        "amount": {obj}["amount"],\n'
                f'        "currency": {obj}.get("currency", "USD"),\n        "status": {obj}.get("status", "new"),\n'
                f'        "created": {obj}.get("created"),\n        "metadata": dict({obj}.get("metadata", {{}})),\n    }}')
    if kind == 2:
        states = rng.sample(["new", "pending", "authorized", "held", "review", "scheduled"], 3)
        return (f'def {names(f"is_{obj}_open")}({obj}):\n    """Whether a {obj} can still change."""\n'
                f'    return {obj}.get("status", "new") in {tuple(states)!r}')
    if kind == 3:
        return (f'def {names(f"normalize_{obj}")}(data):\n    """Fill defaults and coerce types on an incoming {obj}."""\n'
                f'    {obj} = dict(data)\n    {obj}.setdefault("currency", "USD")\n'
                f'    {obj}["currency"] = {obj}["currency"].upper()\n'
                f'    {obj}["amount"] = float({obj}.get("amount", 0))\n'
                f'    if {obj}["currency"] not in ledger.MINOR_UNITS:\n'
                f'        raise web.BadInput(f"unsupported currency {{{obj}[\'currency\']}}")\n'
                f'    return {obj}')
    if kind == 4:
        return (f'def {names(f"{obj}_age_days")}({obj}, today):\n'
                f'    """Whole days since the {obj} was created; 0 when unknown."""\n'
                f'    created = {obj}.get("created")\n    if not created:\n        return 0\n'
                f'    year, month, day = (int(part) for part in created[:10].split("-"))\n'
                f'    return max(0, (today - datetime.date(year, month, day)).days)')
    if kind == 5:
        return (f'def {names(f"summarize_{obj}s")}(items):\n'
                f'    """Totals per currency, in minor units, for a list of {obj}s."""\n'
                f'    totals = {{}}\n    for item in items:\n        currency = item.get("currency", "USD")\n'
                f'        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)\n'
                f'    return dict(sorted(totals.items()))')
    if kind == 6:
        labels = rng.sample(["Waiting", "In review", "Done", "Needs action", "Scheduled", "On hold"], 3)
        return (f'def {names(f"{obj}_status_label")}({obj}):\n    """The label the dashboard shows for a {obj}."""\n'
                f'    labels = {{"new": "{labels[0]}", "pending": "{labels[1]}", "done": "{labels[2]}"}}\n'
                f'    return labels.get({obj}.get("status", "new"), "Unknown")')
    if kind == 7:
        return (f'def {names(f"parse_{obj}_filters")}(params):\n    """Validate list filters from a query string."""\n'
                f'    limit = int(params.get("limit", 50))\n    if not 1 <= limit <= 500:\n'
                f'        raise web.BadInput("limit must be between 1 and 500")\n    status = params.get("status")\n'
                f'    if status is not None and status not in ("new", "pending", "done", "void"):\n'
                f'        raise web.BadInput(f"unknown status {{status}}")\n'
                f'    return {{"limit": limit, "status": status, "cursor": params.get("cursor")}}')
    return (f'def {names(f"merge_{obj}_metadata")}({obj}, metadata):\n'
            f'    """Merge client metadata into a {obj}; at most 20 keys of 40 characters."""\n'
            f'    merged = dict({obj}.get("metadata", {{}}))\n    for key, value in metadata.items():\n'
            f'        if len(key) > 40:\n            raise web.BadInput(f"metadata key too long: {{key[:12]}}...")\n'
            f'        merged[key] = str(value)[:500]\n    if len(merged) > 20:\n'
            f'        raise web.BadInput("at most 20 metadata keys")\n    return {{**{obj}, "metadata": merged}}')


def handler_text(h, rng):
    o = h.obj
    if h.method == "GET":
        return (f'@route("GET", "{h.path}")\ndef {h.name}(request):\n    """Fetch one {o}."""\n'
                f'    {o} = STORE.get(request.json.get("id"))\n    if {o} is None:\n'
                f'        raise BadRequest("unknown {o}")\n'
                f'    return {{"id": {o}["id"], "balance": ledger.balance({o}.get("account", "merchant"))}}')
    flag = f', feature="{h.feature}"' if h.feature else ""
    if h.reg == "dead":
        lines = [rng.choice(["# Unrouted since the v2 API; kept for the replay tool.",
                             f'# @route("{h.method}", "{h.path}"{flag})  -- disabled after incident 2291'])]
    else:
        lines = [f'@route("{h.method}", "{h.path}"{flag})']
    verb = h.name.split("_")[0]
    lines += [f"def {h.name}(request):", f'    """{verb.capitalize()} a {o} ({h.method} {h.path})."""',
              f'    {o} = web.require_fields(request.json, ("id", "amount"))', f'    STORE[{o}["id"]] = {o}']
    lines += {"required": ["    key = require_key(request)"],
              "header": [rng.choice(['    key = request.headers.get("Idempotency-Key")',
                                     '    key = request.headers.get("Idempotency-Key")  # optional for older SDKs'])],
              "derived": ["    key = derive_key(request)"], "none": []}[h.key_mode]
    for callee, mode, cond in h.calls:
        target = callee.name if callee.module == h.module else callee.ref
        call = f"{target}({o}, key=key)" if mode == "forward" and h.key_mode != "none" else f"{target}({o})"
        lines += [f"    {call}"] if cond is None else [f"    if {CONDS[cond][0].format(o=o)}:", f"        {call}"]
    done = {"retry": "retried"}.get(verb, verb + ("d" if verb.endswith("e") else "ed"))
    lines.append(f'    return {{"id": {o}["id"], "status": "{done}"}}')
    return "\n".join(lines)


def area_module(area, services, handlers, rng):
    fns = [f for d in AREAS[area] for f in services[d]]
    hs = [h for h in handlers if h.module == area]
    imports = {"ledger", "web"}
    for item in fns + hs:
        imports |= {c.module for c, _, _ in item.calls if c.module != area}
    used = {f.name for f in fns} | {h.name for h in hs}

    def names(n):
        base, i = n, 2
        while n in used:
            n, i = f"{base}_{i}", i + 1
        used.add(n)
        return n
    domains = ", ".join(AREAS[area])
    head = [f'"""{area.capitalize()}: {domains}.\n\nEach section holds the route handlers for one domain, then the ledger logic they call."""',
            "import datetime"] + [f"import {m}" for m in sorted(imports)]
    head.append("from web import BadRequest, derive_key, idempotent, require_key, route")
    if any(f.alias and f.write == "nokey" for f in fns):
        head.append("from ledger import append as _append")
    if any(f.alias and f.write == "pass" for f in fns):
        head.append("from ledger import post as book_entry")
    head += ["", "STORE = {}"]
    parts = []
    for domain in AREAS[area]:
        obj = OBJ[domain]
        parts.append(f"# {'-' * 30} {domain} {'-' * 30}")
        parts += [handler_text(h, rng) for h in hs if h.domain == domain]
        parts += [helper_text(obj, rng, names) for _ in range(rng.choice([4, 5, 6]))]
        parts += [function_text(f, rng) for f in services[domain] if f.role == "leaf"]
        parts += [function_text(f, rng) for f in services[domain] if f.role == "orch"]
        parts += [helper_text(obj, rng, names) for _ in range(rng.choice([3, 4, 5]))]
    return "\n".join(head) + "\n\n\n" + "\n\n\n".join(parts) + "\n"


def ledger_module(fees, rng):
    fee_text = []
    for fn in fees:
        rate = fn.name.split("_")[1]
        fee_text += ["", "", f"def {fn.name}(obj, *, key=None):", f'    """{fn.doc}"""',
                     f'    amount = round(minor_units(obj["amount"], obj.get("currency", "USD")) * FEE_RATES["{rate}"])',
                     f'    entry = Entry(account="fees", amount=amount, kind="fee.{rate}", reference=obj["id"])',
                     f'    record_event("fee.{rate}", obj["id"], amount=amount)']
        if fn.write == "nokey":
            fee_text.append("    # The nightly fee report de-duplicates these, so no key is needed.")
        fee_text += [f"    {write_line(Fn(fn.name, 'ledger', 'leaf', 'obj', '', fn.write), rng, local=True)}",
                     "    return entry"]
    return LEDGER + "\n".join(fee_text) + "\n"


def jobs_module(jobs):
    body = ['"""Background jobs. The scheduler runs these in its own process; no HTTP request reaches them."""']
    body += [f"import {m}" for m in sorted({c.module for j in jobs for c, _, _ in j.calls})] + ["", "", "PENDING = []"]
    for job in jobs:
        body += ["", "", f"def {job.name}():", f'    """Runs from cron: {job.name.replace("_", " ")}."""',
                 "    for item in list(PENDING):"]
        body += [f"        {callee.ref}(item)" for callee, _, _ in job.calls]
        body.append("    PENDING.clear()")
    return "\n".join(body) + "\n"


WEB = '''"""Requests, the route table, feature flags, idempotency keys and input validation."""
import functools
from dataclasses import dataclass, field

# Feature flags as deployed. A handler registered with feature=... exists only while its flag is on.
FEATURES = {
__FEATURES__
}

ROUTES = {}
OUTBOX = []


class BadRequest(Exception):
    """The client sent something we cannot act on (HTTP 400)."""


class BadInput(BadRequest):
    """A field is present but unusable."""


@dataclass
class Request:
    method: str
    path: str
    id: str
    json: dict = field(default_factory=dict)
    headers: dict = field(default_factory=dict)


def route(method, path, *, feature=None):
    """Register a handler for METHOD path when its module is imported.

    A handler behind a feature flag registers only if the flag is on in FEATURES.
    """
    def register(handler):
        if feature is None or FEATURES.get(feature, False):
            ROUTES[(method, path)] = handler
        return handler
    return register


def dispatch(request):
    """Run the handler registered for the request's method and path template."""
    for (method, template), handler in ROUTES.items():
        if method == request.method and _matches(template, request.path):
            return handler(request)
    raise BadRequest(f"no route for {request.method} {request.path}")


def _matches(template, path):
    want, got = template.strip("/").split("/"), path.strip("/").split("/")
    return len(want) == len(got) and all(w.startswith("{") or w == g for w, g in zip(want, got))


def require_key(request):
    """Return the request's Idempotency-Key header, or reject a request without one."""
    key = request.headers.get("Idempotency-Key", "").strip()
    if not key:
        raise BadRequest("Idempotency-Key header is required")
    return key


def derive_key(request):
    """A key built from the request itself, for clients that cannot send one."""
    return f"{request.method}:{request.path}:{request.id}"


def idempotent(func):
    """Give the wrapped operation a key when its caller passes none."""
    @functools.wraps(func)
    def wrapper(obj, *, key=None, **kwargs):
        if not key:
            key = f"{func.__name__}:{obj['id']}"
        return func(obj, key=key, **kwargs)
    return wrapper


def require_fields(data, fields):
    """Return a copy of data, or reject the request if a field is missing."""
    missing = [name for name in fields if name not in (data or {})]
    if missing:
        raise BadRequest(f"missing fields: {', '.join(missing)}")
    return dict(data)


def queue_notification(event, reference):
    """Queue an email or webhook; the sender process delivers it later. Writes nothing to the ledger."""
    OUTBOX.append((event, reference))
'''

LEDGER = '''"""The ledger, money helpers, the audit trail and platform fees.

The ledger is an append-only list of rows. Every money movement is booked here.
"""
from dataclasses import dataclass
from decimal import ROUND_HALF_EVEN, ROUND_HALF_UP, Decimal

ROWS = []
EVENTS = []
MINOR_UNITS = {"USD": 2, "EUR": 2, "GBP": 2, "JPY": 0, "KWD": 3, "CHF": 2, "SEK": 2}
RATES_TO_USD = {"USD": Decimal("1"), "EUR": Decimal("1.0842"), "GBP": Decimal("1.2711"),
                "JPY": Decimal("0.006612"), "KWD": Decimal("3.2531"), "CHF": Decimal("1.1290"),
                "SEK": Decimal("0.0951")}
FEE_RATES = {"processing": 0.029, "network": 0.0014, "platform": 0.005}


@dataclass(frozen=True)
class Entry:
    account: str
    amount: int
    kind: str
    reference: str
    memo: str = ""


def append(entry, *, idempotency_key=None):
    """Write one row.

    A row written with a key is skipped when a row with the same key exists. A row written
    without one is always written, so a retried request writes it again.
    """
    if idempotency_key is not None and any(row["key"] == idempotency_key for row in ROWS):
        return False
    ROWS.append({"entry": entry, "key": idempotency_key})
    return True


def post(entry, key):
    """Write a row under the caller's idempotency key."""
    return append(entry, idempotency_key=key)


def post_fee(entry):
    """Write a fee row. Finance matches fee rows against the processor's report each night."""
    return append(entry)


def post_adjustment(entry, key=None):
    """Write a manual adjustment row."""
    return append(entry, idempotency_key=key)


def balance(account):
    """Sum of every row booked to an account, in minor units."""
    return sum(row["entry"].amount for row in ROWS if row["entry"].account == account)


def rows_for(reference):
    """Every row booked against one object."""
    return [row for row in ROWS if row["entry"].reference == reference]


def minor_units(amount, currency="USD"):
    """Convert a decimal amount to minor units, rounding half up."""
    scaled = Decimal(str(amount)) * (Decimal(10) ** MINOR_UNITS.get(currency, 2))
    return int(scaled.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def format_minor(amount, currency="USD"):
    """Format minor units for people, for example 1234 USD as "12.34 USD"."""
    exponent = MINOR_UNITS.get(currency, 2)
    sign, amount = ("-", -amount) if amount < 0 else ("", amount)
    if exponent == 0:
        return f"{sign}{amount} {currency}"
    whole, frac = divmod(amount, 10 ** exponent)
    return f"{sign}{whole}.{frac:0{exponent}d} {currency}"


def split(amount, parts):
    """Split minor units into near-equal parts that sum back to the amount."""
    base, rest = divmod(amount, parts)
    return [base + (1 if i < rest else 0) for i in range(parts)]


def convert(amount, source, target):
    """Convert minor units between currencies at the treasury's daily rates, rounding half to even."""
    if source == target:
        return amount
    major = Decimal(amount) / (Decimal(10) ** MINOR_UNITS[source])
    usd = major * RATES_TO_USD[source]
    out = usd / RATES_TO_USD[target] * (Decimal(10) ** MINOR_UNITS[target])
    return int(out.quantize(Decimal(1), rounding=ROUND_HALF_EVEN))


def record_event(event, reference, **fields):
    """Audit trail for support and compliance. Writes nothing to the ledger."""
    EVENTS.append({"event": event, "reference": reference, **fields})


def history(reference):
    """Every audit event about one object, oldest first."""
    return [e for e in EVENTS if e["reference"] == reference]


# Platform fees, booked on top of a payment.'''


def docs(c):
    roadmap_only = ["POST /v2/refunds/bulk", "POST /v1/wallets/{id}/merge", "POST /v1/invoices/{id}/finance"]
    planned = "\n".join(f"- `{r}`" for r in roadmap_only + c["unregistered"][:2])
    readme = """# Payments service

The service books every money movement to an append-only ledger (`ledger.py`). HTTP requests
arrive through `web.dispatch`, which runs the handler registered for the request's method and path.

## Layout

- `app.py` imports the area modules (`payments.py`, `billing.py`, `treasury.py`, `balances.py`,
  `corrections.py`). Importing a module runs its `@route` decorators, which register its handlers in
  `web.ROUTES`. A module that nothing imports registers nothing.
- Each area module holds the route handlers for its domains and the business logic they call.
- `web.py` holds requests, routing, the feature flags, idempotency-key helpers and input validation.
- `ledger.py` writes ledger rows and holds the money helpers, the audit trail and platform fees.
- `jobs.py` holds cron jobs. A handler registered with `feature=` exists only while its flag is on in
  `web.FEATURES`.

## Conventions

- Handlers pass the request's idempotency key down as the keyword argument `key`.
- Amounts on the ledger are integers in minor units (`ledger.minor_units`).
- The design notes below describe the design and what is planned.
"""
    design = f"""# Design notes

*Last reviewed for v3. Some sections predate the v4 handlers.*

## Ledger writes

Since v3 every ledger write goes through `ledger.post` with the request's idempotency key.
`ledger.post_fee` and bare `ledger.append` calls were removed in the v3 cleanup, so a retried
request can never book a row twice.

Every handler calls `require_key`, so a request without an `Idempotency-Key` header is rejected
before it reaches the business logic.

## The `idempotent` decorator

`@idempotent` gives a function a key when its caller passes none, and protects the rows that
function writes with that key.

## Fees

Fees are booked by the fee functions in `ledger.py`. The nightly fee report de-duplicates fee
rows, so fee rows need no idempotency key.

## Jobs

`jobs.py` runs from cron in its own process. Jobs call the area modules' business logic.

## Roadmap

- Q3: enable the deposits API (`deposits.py` is written but not imported yet).
- Instant payouts behind the `instant_payouts` flag.

Planned or waiting on a flag (do not document these as live):

{planned}
"""
    return {"README.md": readme + "\n" + design}, roadmap_only


def app_module():
    lines = ['"""Entry point. Importing an area module registers its routes in web.ROUTES."""']
    for area in AREAS:
        lines.append(f"# import {area}  -- ships with the Q3 release, see README.md" if area == UNIMPORTED
                     else f"import {area}  # noqa: F401")
    lines += ["import web", "", "", "def handle(request):", '    """Serve one request."""',
              "    return web.dispatch(request)"]
    return "\n".join(lines) + "\n"


VERIFY = r"""
import json, sys
sys.path.insert(0, sys.argv[1])
import app, ledger, web
# Read the rows themselves: an alias such as `from ledger import append as _append` bypasses any patch.
DEFAULT = {"id": "x1", "amount": 12.5, "currency": "USD"}
EVERY = {"id": "x1", "amount": 1500, "currency": "EUR", "expedite": True, "partial": True, "source": "batch"}
unsafe, naive, live = [], [], []
for (method, path), handler in sorted(web.ROUTES.items()):
    live.append(f"{method} {path}")
    hits = set()
    # With and without the header: a required key stops one request, not the other.
    for headers in ({}, {"Idempotency-Key": "k-1"}):
        for name, body in (("default", DEFAULT), ("every", EVERY)):
            ledger.ROWS.clear()
            request = web.Request(method, path.replace("{id}", "x1"), "req-1", dict(body), headers)
            try:
                handler(request)
            except web.BadRequest:
                pass
            if any(not row["key"] for row in ledger.ROWS):
                hits.add(name)
    if hits:
        unsafe.append(f"{method} {path}")
    if "default" in hits:
        naive.append(f"{method} {path}")
print(json.dumps({"unsafe": unsafe, "naive": naive, "live": live}))
"""


def verify(c, handlers):
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copytree(FIXTURE, tmp, dirs_exist_ok=True)
        out = subprocess.run([sys.executable, "-I", "-B", "-c", VERIFY, tmp], capture_output=True, text=True, check=True)
    seen = json.loads(out.stdout)
    assert seen["live"] == sorted(h.route for h in handlers if registered(h)), "registered routes differ"
    assert seen["unsafe"] == c["unsafe"], ("unsafe routes differ", seen["unsafe"], c["unsafe"])
    assert seen["naive"] == c["naive"], ("default-input routes differ", seen["naive"], c["naive"])


def grader(c, unregistered, baseline):
    j = json.dumps
    return f"""// Generated by tools/suite/payments_audit.py. Edit the generator and rerun it, not this file.
import {{answerJson, bounded, check, fixture, jsonOnly, preserved, toolChecks}} from './helpers.mjs';
const original = fixture('payments-audit');

/**
 * A read-only audit of a ~170 KB service: which registered routes can write a ledger row without an
 * idempotency key. The answer depends on tracing calls across modules, key provenance (required,
 * optional header, derived, absent), the idempotent decorator and registration (flags, an unimported
 * module, unrouted handlers) and branches on request fields that sample input never takes. The design notes are deliberately out of date, so trusting it instead of the
 * code reports the wrong set. Each failure mode is its own check so partial credit shows which part
 * of the tracing broke; the task is solved only when every one passes.
 */
const UNSAFE = {j(c['unsafe'])};
const DIRECT = {j(c['direct'])};
const DEEP = {j(c['deep'])};
const OPTIONAL_KEY = {j(c['optional'])};
const CONDITIONAL = {j(c['conditional'])};
const SAFE = {j(c['safe'])};
const UNREGISTERED = {j(unregistered)};

export const reference = {{files: {{...original}}, answer: JSON.stringify({{routes: UNSAFE}})}};
export const baseline = {{files: {{...original}}, answer: JSON.stringify({{routes: {j(baseline)}}})}};

export async function grade({{answer, files, trace, lane, control, agent}}) {{
  const value = answerJson(answer);
  const routes = Array.isArray(value?.routes) && value.routes.every(r => typeof r === 'string') ? value.routes : null;
  const got = new Set(routes ?? []);
  const missed = list => list.filter(r => !got.has(r));
  const reported = list => list.filter(r => got.has(r));
  const strangers = [...got].filter(r => !UNSAFE.includes(r) && !SAFE.includes(r) && !UNREGISTERED.includes(r));
  const shape = `answer has routes as a list of strings=${{routes !== null}}`;
  return [
    check('direct-paths', 'correctness', routes && !missed(DIRECT).length,
      `${{shape}}; missed routes that write without a key within two calls=${{bounded(missed(DIRECT))}}`),
    check('deep-paths', 'correctness', routes && !missed(DEEP).length,
      `${{shape}}; missed routes that write without a key three or more calls down=${{bounded(missed(DEEP))}}`),
    check('conditional-paths', 'correctness', routes && !missed(CONDITIONAL).length,
      `${{shape}}; missed routes that write without a key only when the request sets a field a branch tests=${{bounded(missed(CONDITIONAL))}}`),
    check('optional-key', 'correctness', routes && !missed(OPTIONAL_KEY).length,
      `${{shape}}; missed routes unsafe only because the Idempotency-Key header is optional=${{bounded(missed(OPTIONAL_KEY))}}`),
    check('no-safe-route', 'correctness', routes && !reported(SAFE).length,
      `${{shape}}; reported routes that always write with a key=${{bounded(reported(SAFE))}}`),
    check('no-unregistered-route', 'correctness', routes && !reported(UNREGISTERED).length && !strangers.length,
      `${{shape}}; reported routes not registered today=${{bounded(reported(UNREGISTERED))}}; not routes of this service=${{bounded(strangers)}}`),
    check('sorted', 'instructions', routes && routes.every((r, i) => i === 0 || routes[i - 1] < r),
      `routes sorted ascending without duplicates=${{bounded(routes)}}`),
    jsonOnly(answer),
    preserved(files, original, []),
    ...toolChecks(trace, ['app.py', 'web.py'], null, true, {{lane, control, agent}}),
  ];
}}
"""


def main():
    seed = 1
    while True:
        rng = random.Random(seed)
        services, handlers, fees, jobs = build(rng)
        c = classify(handlers)
        if acceptable(c):
            break
        seed += 1
    flags = "\n".join(f'    "{k}": {v},' for k, v in FEATURES.items())
    files = {"web.py": WEB.replace("__FEATURES__", flags), "ledger.py": ledger_module(fees, rng),
             "app.py": app_module(), "jobs.py": jobs_module(jobs)}
    for area in AREAS:
        files[f"{area}.py"] = area_module(area, services, handlers, rng)
    texts, roadmap_only = docs(c)
    files.update(texts)
    for name, text in files.items():
        if name.endswith(".py"):
            compile(text, name, "exec")
        assert len(text) < 30000, (name, len(text))
    if FIXTURE.exists():
        shutil.rmtree(FIXTURE)
    FIXTURE.mkdir(parents=True)
    for name, text in sorted(files.items()):
        (FIXTURE / name).write_text(text)
    verify(c, handlers)
    unregistered = sorted(set(c["unregistered"]) | set(roadmap_only))
    baseline = c["naive"]  # what running every route once with sample input finds
    GRADER.write_text(grader(c, unregistered, baseline))
    sizes = {n: len(t) for n, t in files.items()}
    print(f"seed={seed} files={len(files)} chars={sum(sizes.values())} largest={max(sizes.values())} "
          f"unsafe={len(c['unsafe'])} direct={len(c['direct'])} deep={len(c['deep'])} "
          f"optional={len(c['optional'])} conditional={len(c['conditional'])} safe={len(c['safe'])} "
          f"unregistered_unsafe={len(c['unregistered_unsafe'])}")


if __name__ == "__main__":
    main()
