"""Requests, the route table, feature flags, idempotency keys and input validation."""
import functools
from dataclasses import dataclass, field

# Feature flags as deployed. A handler registered with feature=... exists only while its flag is on.
FEATURES = {
    "instant_payouts": False,
    "coupon_stacking": True,
    "tax_recalc": False,
    "dispute_autoaccept": True,
    "wallet_sweeps": False,
    "credit_expiry": True,
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
