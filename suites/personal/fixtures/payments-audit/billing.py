"""Billing: invoices, subscriptions, coupons.

Each section holds the route handlers for one domain, then the ledger logic they call."""
import datetime
import ledger
import payments
import web
from web import BadRequest, derive_key, idempotent, require_key, route
from ledger import post as book_entry

STORE = {}


# ------------------------------ invoices ------------------------------


@route("POST", "/v1/invoices")
def create_invoice(request):
    """Create a invoice (POST /v1/invoices)."""
    invoice = web.require_fields(request.json, ("id", "amount"))
    STORE[invoice["id"]] = invoice
    key = request.headers.get("Idempotency-Key")  # optional for older SDKs
    apply_invoice_interest(invoice, key=key)
    expire_invoice(invoice)
    return {"id": invoice["id"], "status": "created"}


@route("POST", "/v1/invoices/{id}/capture")
def capture_invoice(request):
    """Capture a invoice (POST /v1/invoices/{id}/capture)."""
    invoice = web.require_fields(request.json, ("id", "amount"))
    STORE[invoice["id"]] = invoice
    key = require_key(request)
    approve_invoice(invoice, key=key)
    return {"id": invoice["id"], "status": "captured"}


@route("POST", "/v1/invoices/{id}/cancel")
def cancel_invoice(request):
    """Cancel a invoice (POST /v1/invoices/{id}/cancel)."""
    invoice = web.require_fields(request.json, ("id", "amount"))
    STORE[invoice["id"]] = invoice
    key = request.headers.get("Idempotency-Key")
    approve_invoice_2(invoice, key=key)
    return {"id": invoice["id"], "status": "canceled"}


@route("GET", "/v1/invoices/{id}")
def get_invoice(request):
    """Fetch one invoice."""
    invoice = STORE.get(request.json.get("id"))
    if invoice is None:
        raise BadRequest("unknown invoice")
    return {"id": invoice["id"], "balance": ledger.balance(invoice.get("account", "merchant"))}


def is_invoice_open(invoice):
    """Whether a invoice can still change."""
    return invoice.get("status", "new") in ('new', 'held', 'scheduled')


def invoice_age_days(invoice, today):
    """Whole days since the invoice was created; 0 when unknown."""
    created = invoice.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def invoice_status_label(invoice):
    """The label the dashboard shows for a invoice."""
    labels = {"new": "In review", "pending": "On hold", "done": "Waiting"}
    return labels.get(invoice.get("status", "new"), "Unknown")


def parse_invoice_filters(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def apply_invoice_interest(invoice, *, key=None):
    """Book the invoice's interest to the ledger."""
    if invoice.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(invoice["amount"], invoice.get("currency", "USD"))
    entry = ledger.Entry(account=invoice.get("account", "fees"), amount=amount,
                         kind="apply.invoice.interest", reference=invoice["id"])
    ledger.record_event("invoice.apply_invoice_interest", invoice["id"], amount=amount)
    ledger.append(entry, idempotency_key=f"apply-invoice-interest:{invoice['id']}")
    return entry


def accrue_invoice_balance(invoice, *, key=None):
    """Post the balance for one invoice."""
    web.require_fields(invoice, ("id", "amount"))
    amount = ledger.minor_units(invoice["amount"], invoice.get("currency", "USD"))
    entry = ledger.Entry(account=invoice.get("account", "merchant"), amount=amount,
                         kind="accrue.invoice.balance", reference=invoice["id"])
    ledger.record_event("invoice.accrue_invoice_balance", invoice["id"], amount=amount)
    # TODO: move to the request key once clients send one.
    ledger.post(entry, f"accrue-invoice-balance:{invoice['id']}")
    return entry


def settle_invoice_remainder(invoice, *, key=None):
    """Write the ledger line for a invoice remainder."""
    if invoice.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(invoice["amount"], invoice.get("currency", "USD"))
    entry = ledger.Entry(account=invoice.get("account", "suspense"), amount=amount,
                         kind="settle.invoice.remainder", reference=invoice["id"])
    ledger.record_event("invoice.settle_invoice_remainder", invoice["id"], amount=amount)
    book_entry(entry, key)
    return entry


def expire_invoice(invoice, *, key=None):
    """Run the expire step for a invoice."""
    web.require_fields(invoice, ("id", "amount"))
    payments.migrate_refund(invoice, key=key)
    payments.write_off_charge_interest(invoice, key=key)
    web.queue_notification("invoice.expire_invoice", invoice["id"])
    return invoice["id"]


@idempotent
def approve_invoice(invoice, *, key=None):
    """Approve a invoice and book the resulting ledger lines."""
    if invoice.get("amount", 0) < 0:
        raise ValueError("negative amount")
    expire_invoice(invoice, key=key)
    payments.settle_charge_payable(invoice, key=key)
    web.queue_notification("invoice.approve_invoice", invoice["id"])
    return invoice["id"]


def approve_invoice_2(invoice, *, key=None):
    """Approve a invoice and book the resulting ledger lines."""
    web.require_fields(invoice, ("id", "amount"))
    payments.approve_refund(invoice, key=key)
    accrue_invoice_balance(invoice, key=key)
    web.queue_notification("invoice.approve_invoice_2", invoice["id"])
    return invoice["id"]


def summarize_invoices(items):
    """Totals per currency, in minor units, for a list of invoices."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def merge_invoice_metadata(invoice, metadata):
    """Merge client metadata into a invoice; at most 20 keys of 40 characters."""
    merged = dict(invoice.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**invoice, "metadata": merged}


def is_invoice_open_2(invoice):
    """Whether a invoice can still change."""
    return invoice.get("status", "new") in ('held', 'authorized', 'scheduled')


def summarize_invoices_2(items):
    """Totals per currency, in minor units, for a list of invoices."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


# ------------------------------ subscriptions ------------------------------


@route("POST", "/v1/subscriptions")
def create_subscription(request):
    """Create a subscription (POST /v1/subscriptions)."""
    subscription = web.require_fields(request.json, ("id", "amount"))
    STORE[subscription["id"]] = subscription
    approve_subscription(subscription)
    return {"id": subscription["id"], "status": "created"}


@route("POST", "/v1/subscriptions/{id}/expire")
def expire_subscription(request):
    """Expire a subscription (POST /v1/subscriptions/{id}/expire)."""
    subscription = web.require_fields(request.json, ("id", "amount"))
    STORE[subscription["id"]] = subscription
    approve_subscription(subscription)
    ledger.charge_network_fee(subscription)
    return {"id": subscription["id"], "status": "expired"}


@route("POST", "/v1/subscriptions/{id}/capture")
def capture_subscription(request):
    """Capture a subscription (POST /v1/subscriptions/{id}/capture)."""
    subscription = web.require_fields(request.json, ("id", "amount"))
    STORE[subscription["id"]] = subscription
    key = request.headers.get("Idempotency-Key")
    settle_subscription_payable(subscription, key=key)
    return {"id": subscription["id"], "status": "captured"}


@route("GET", "/v1/subscriptions/{id}")
def get_subscription(request):
    """Fetch one subscription."""
    subscription = STORE.get(request.json.get("id"))
    if subscription is None:
        raise BadRequest("unknown subscription")
    return {"id": subscription["id"], "balance": ledger.balance(subscription.get("account", "merchant"))}


def subscription_payload(subscription):
    """The public JSON shape of a subscription."""
    return {
        "id": subscription["id"],
        "amount": subscription["amount"],
        "currency": subscription.get("currency", "USD"),
        "status": subscription.get("status", "new"),
        "created": subscription.get("created"),
        "metadata": dict(subscription.get("metadata", {})),
    }


def describe_subscription(subscription):
    """A one-line summary for support tooling."""
    amount = ledger.format_minor(ledger.minor_units(subscription["amount"], subscription.get("currency", "USD")), subscription.get("currency", "USD"))
    return f"subscription {subscription['id']}: {amount} ({subscription.get('status', 'new')})"


def parse_subscription_filters(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def subscription_payload_2(subscription):
    """The public JSON shape of a subscription."""
    return {
        "id": subscription["id"],
        "amount": subscription["amount"],
        "currency": subscription.get("currency", "USD"),
        "status": subscription.get("status", "new"),
        "created": subscription.get("created"),
        "metadata": dict(subscription.get("metadata", {})),
    }


def settle_subscription_balance(subscription, *, key=None):
    """Write the ledger line for a subscription balance."""
    if subscription.get("status") == "void":
        raise ValueError(f"subscription {subscription['id']} is void")
    amount = ledger.minor_units(subscription["amount"], subscription.get("currency", "USD"))
    entry = ledger.Entry(account=subscription.get("account", "platform"), amount=amount,
                         kind="settle.subscription.balance", reference=subscription["id"])
    ledger.record_event("subscription.settle_subscription_balance", subscription["id"], amount=amount)
    ledger.post(entry, f"settle-subscription-balance:{subscription['id']}")
    return entry


def settle_subscription_payable(subscription, *, key=None):
    """Post the payable for one subscription."""
    web.require_fields(subscription, ("id", "amount"))
    amount = ledger.minor_units(subscription["amount"], subscription.get("currency", "USD"))
    entry = ledger.Entry(account=subscription.get("account", "customer"), amount=-amount,
                         kind="settle.subscription.payable", reference=subscription["id"])
    ledger.record_event("subscription.settle_subscription_payable", subscription["id"], amount=amount)
    ledger.post(entry, key)
    return entry


def accrue_subscription_fee(subscription, *, key=None):
    """Record the fee owed on a subscription."""
    web.require_fields(subscription, ("id", "amount"))
    amount = ledger.minor_units(subscription["amount"], subscription.get("currency", "USD"))
    amount = ledger.convert(amount, subscription.get("currency", "USD"), "USD")
    entry = ledger.Entry(account=subscription.get("account", "customer"), amount=-amount,
                         kind="accrue.subscription.fee", reference=subscription["id"])
    ledger.record_event("subscription.accrue_subscription_fee", subscription["id"], amount=amount)
    ledger.post(entry, key)
    return entry


def approve_subscription(subscription, *, key=None):
    """Approve a subscription and book the resulting ledger lines."""
    web.require_fields(subscription, ("id", "amount"))
    approve_invoice_2(subscription, key=key)
    if subscription.get("expedite"):
        accrue_subscription_fee(subscription, key=key)
    web.queue_notification("subscription.approve_subscription", subscription["id"])
    return subscription["id"]


def process_subscription(subscription, *, key=None):
    """Process a subscription and book the resulting ledger lines."""
    web.require_fields(subscription, ("id", "amount"))
    if subscription.get("source") == "batch":
        settle_subscription_balance(subscription, key=key)
    payments.cancel_refund(subscription, key=key)
    # Replays must not reuse the original key.
    payments.split_dispute_interest(subscription)
    web.queue_notification("subscription.process_subscription", subscription["id"])
    return subscription["id"]


def approve_subscription_2(subscription, *, key=None):
    """Run the approve step for a subscription."""
    if subscription.get("amount", 0) < 0:
        raise ValueError("negative amount")
    # Replays must not reuse the original key.
    accrue_subscription_fee(subscription, key=None)
    web.queue_notification("subscription.approve_subscription_2", subscription["id"])
    return subscription["id"]


def normalize_subscription(data):
    """Fill defaults and coerce types on an incoming subscription."""
    subscription = dict(data)
    subscription.setdefault("currency", "USD")
    subscription["currency"] = subscription["currency"].upper()
    subscription["amount"] = float(subscription.get("amount", 0))
    if subscription["currency"] not in ledger.MINOR_UNITS:
        raise web.BadInput(f"unsupported currency {subscription['currency']}")
    return subscription


def subscription_age_days(subscription, today):
    """Whole days since the subscription was created; 0 when unknown."""
    created = subscription.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def merge_subscription_metadata(subscription, metadata):
    """Merge client metadata into a subscription; at most 20 keys of 40 characters."""
    merged = dict(subscription.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**subscription, "metadata": merged}


# ------------------------------ coupons ------------------------------


@route("POST", "/v1/coupons")
def create_coupon(request):
    """Create a coupon (POST /v1/coupons)."""
    coupon = web.require_fields(request.json, ("id", "amount"))
    STORE[coupon["id"]] = coupon
    key = request.headers.get("Idempotency-Key")  # optional for older SDKs
    release_coupon_balance(coupon, key=key)
    return {"id": coupon["id"], "status": "created"}


@route("POST", "/v1/coupons/{id}/reopen")
def reopen_coupon(request):
    """Reopen a coupon (POST /v1/coupons/{id}/reopen)."""
    coupon = web.require_fields(request.json, ("id", "amount"))
    STORE[coupon["id"]] = coupon
    key = derive_key(request)
    process_coupon(coupon, key=key)
    ledger.charge_network_fee(coupon, key=key)
    return {"id": coupon["id"], "status": "reopened"}


@route("POST", "/v1/coupons/{id}/approve")
def approve_coupon_2(request):
    """Approve a coupon (POST /v1/coupons/{id}/approve)."""
    coupon = web.require_fields(request.json, ("id", "amount"))
    STORE[coupon["id"]] = coupon
    key = require_key(request)
    write_off_coupon(coupon, key=key)
    if coupon.get("expedite"):
        process_coupon(coupon, key=key)
    return {"id": coupon["id"], "status": "approved"}


@route("GET", "/v1/coupons/{id}")
def get_coupon(request):
    """Fetch one coupon."""
    coupon = STORE.get(request.json.get("id"))
    if coupon is None:
        raise BadRequest("unknown coupon")
    return {"id": coupon["id"], "balance": ledger.balance(coupon.get("account", "merchant"))}


def coupon_payload(coupon):
    """The public JSON shape of a coupon."""
    return {
        "id": coupon["id"],
        "amount": coupon["amount"],
        "currency": coupon.get("currency", "USD"),
        "status": coupon.get("status", "new"),
        "created": coupon.get("created"),
        "metadata": dict(coupon.get("metadata", {})),
    }


def parse_coupon_filters(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def summarize_coupons(items):
    """Totals per currency, in minor units, for a list of coupons."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def coupon_age_days(coupon, today):
    """Whole days since the coupon was created; 0 when unknown."""
    created = coupon.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def release_coupon_balance(coupon, *, key=None):
    """Post the balance for one coupon."""
    web.require_fields(coupon, ("id", "amount"))
    amount = ledger.minor_units(coupon["amount"], coupon.get("currency", "USD"))
    entry = ledger.Entry(account=coupon.get("account", "suspense"), amount=amount,
                         kind="release.coupon.balance", reference=coupon["id"])
    ledger.record_event("coupon.release_coupon_balance", coupon["id"], amount=amount)
    ledger.append(entry, idempotency_key=f"release-coupon-balance:{coupon['id']}")
    return entry


def write_off_coupon(coupon, *, key=None):
    """Book the coupon's coupon to the ledger."""
    web.require_fields(coupon, ("id", "amount"))
    amount = ledger.minor_units(coupon["amount"], coupon.get("currency", "USD"))
    entry = ledger.Entry(account=coupon.get("account", "fees"), amount=amount,
                         kind="write.off.coupon", reference=coupon["id"])
    ledger.record_event("coupon.write_off_coupon", coupon["id"], amount=amount)
    ledger.post(entry, key)
    return entry


def split_coupon_payable(coupon, *, key=None):
    """Post the payable for one coupon."""
    if coupon.get("status") == "void":
        raise ValueError(f"coupon {coupon['id']} is void")
    amount = ledger.minor_units(coupon["amount"], coupon.get("currency", "USD"))
    entry = ledger.Entry(account=coupon.get("account", "platform"), amount=-amount,
                         kind="split.coupon.payable", reference=coupon["id"])
    ledger.record_event("coupon.split_coupon_payable", coupon["id"], amount=amount)
    # FIXME(idempotency): confirm callers always send a key.
    ledger.post(entry, key)
    return entry


def close_coupon(coupon, *, key=None):
    """Run the close step for a coupon."""
    if coupon.get("amount", 0) < 0:
        raise ValueError("negative amount")
    payments.approve_refund(coupon, key=key)
    write_off_coupon(coupon, key=key)
    release_coupon_balance(coupon, key=key)
    web.queue_notification("coupon.close_coupon", coupon["id"])
    return coupon["id"]


def approve_coupon(coupon, *, key=None):
    """Approve the coupon; ledger lines follow from its state."""
    web.require_fields(coupon, ("id", "amount"))
    write_off_coupon(coupon, key=key)
    release_coupon_balance(coupon, key=key)
    web.queue_notification("coupon.approve_coupon", coupon["id"])
    return coupon["id"]


@idempotent
def process_coupon(coupon, *, key=None):
    """Process a coupon and book the resulting ledger lines."""
    web.require_fields(coupon, ("id", "amount"))
    ledger.charge_network_fee(coupon, key=key)
    web.queue_notification("coupon.process_coupon", coupon["id"])
    return coupon["id"]


def summarize_coupons_2(items):
    """Totals per currency, in minor units, for a list of coupons."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def coupon_age_days_2(coupon, today):
    """Whole days since the coupon was created; 0 when unknown."""
    created = coupon.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def merge_coupon_metadata(coupon, metadata):
    """Merge client metadata into a coupon; at most 20 keys of 40 characters."""
    merged = dict(coupon.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**coupon, "metadata": merged}


def coupon_age_days_3(coupon, today):
    """Whole days since the coupon was created; 0 when unknown."""
    created = coupon.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def merge_coupon_metadata_2(coupon, metadata):
    """Merge client metadata into a coupon; at most 20 keys of 40 characters."""
    merged = dict(coupon.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**coupon, "metadata": merged}
