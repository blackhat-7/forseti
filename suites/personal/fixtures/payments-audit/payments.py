"""Payments: charges, refunds, disputes.

Each section holds the route handlers for one domain, then the ledger logic they call."""
import datetime
import ledger
import web
from web import BadRequest, derive_key, idempotent, require_key, route
from ledger import post as book_entry

STORE = {}


# ------------------------------ charges ------------------------------


@route("POST", "/v1/charges")
def create_charge(request):
    """Create a charge (POST /v1/charges)."""
    charge = web.require_fields(request.json, ("id", "amount"))
    STORE[charge["id"]] = charge
    key = require_key(request)
    retry_charge(charge, key=key)
    return {"id": charge["id"], "status": "created"}


@route("POST", "/v1/charges/{id}/release")
def release_charge(request):
    """Release a charge (POST /v1/charges/{id}/release)."""
    charge = web.require_fields(request.json, ("id", "amount"))
    STORE[charge["id"]] = charge
    settle_charge_payable(charge)
    return {"id": charge["id"], "status": "released"}


@route("POST", "/v1/charges/{id}/capture")
def capture_charge(request):
    """Capture a charge (POST /v1/charges/{id}/capture)."""
    charge = web.require_fields(request.json, ("id", "amount"))
    STORE[charge["id"]] = charge
    key = derive_key(request)
    write_off_charge_interest(charge, key=key)
    return {"id": charge["id"], "status": "captured"}


@route("GET", "/v1/charges/{id}")
def get_charge(request):
    """Fetch one charge."""
    charge = STORE.get(request.json.get("id"))
    if charge is None:
        raise BadRequest("unknown charge")
    return {"id": charge["id"], "balance": ledger.balance(charge.get("account", "merchant"))}


def is_charge_open(charge):
    """Whether a charge can still change."""
    return charge.get("status", "new") in ('scheduled', 'pending', 'held')


def charge_age_days(charge, today):
    """Whole days since the charge was created; 0 when unknown."""
    created = charge.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def charge_age_days_2(charge, today):
    """Whole days since the charge was created; 0 when unknown."""
    created = charge.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def charge_payload(charge):
    """The public JSON shape of a charge."""
    return {
        "id": charge["id"],
        "amount": charge["amount"],
        "currency": charge.get("currency", "USD"),
        "status": charge.get("status", "new"),
        "created": charge.get("created"),
        "metadata": dict(charge.get("metadata", {})),
    }


def summarize_charges(items):
    """Totals per currency, in minor units, for a list of charges."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def apply_charge_interest(charge, *, key=None):
    """Record the interest owed on a charge."""
    if charge.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(charge["amount"], charge.get("currency", "USD"))
    amount = ledger.convert(amount, charge.get("currency", "USD"), "USD")
    entry = ledger.Entry(account=charge.get("account", "platform"), amount=-amount,
                         kind="apply.charge.interest", reference=charge["id"])
    ledger.record_event("charge.apply_charge_interest", charge["id"], amount=amount)
    ledger.post(entry, key)
    return entry


def write_off_charge_interest(charge, *, key=None):
    """Record the interest owed on a charge."""
    web.require_fields(charge, ("id", "amount"))
    amount = ledger.minor_units(charge["amount"], charge.get("currency", "USD"))
    amount = ledger.convert(amount, charge.get("currency", "USD"), "USD")
    entry = ledger.Entry(account=charge.get("account", "customer"), amount=-amount,
                         kind="write.off.charge.interest", reference=charge["id"])
    ledger.record_event("charge.write_off_charge_interest", charge["id"], amount=amount)
    # TODO: move to the request key once clients send one.
    ledger.append(entry, idempotency_key=f"write-off-charge-interest:{charge['id']}")
    return entry


def settle_charge_payable(charge, *, key=None):
    """Book the charge's payable to the ledger."""
    if charge.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(charge["amount"], charge.get("currency", "USD"))
    entry = ledger.Entry(account=charge.get("account", "merchant"), amount=-amount,
                         kind="settle.charge.payable", reference=charge["id"])
    ledger.record_event("charge.settle_charge_payable", charge["id"], amount=amount)
    ledger.post(entry, f"settle-charge-payable:{charge['id']}")
    return entry


def cancel_charge(charge, *, key=None):
    """Run the cancel step for a charge."""
    if charge.get("amount", 0) < 0:
        raise ValueError("negative amount")
    write_off_charge_interest(charge, key=key)
    web.queue_notification("charge.cancel_charge", charge["id"])
    return charge["id"]


def reopen_charge(charge, *, key=None):
    """Reopen a charge and book the resulting ledger lines."""
    web.require_fields(charge, ("id", "amount"))
    write_off_charge_interest(charge, key=key)
    if charge["amount"] > 1000:
        cancel_charge(charge, key=key)
    web.queue_notification("charge.reopen_charge", charge["id"])
    return charge["id"]


def retry_charge(charge, *, key=None):
    """Retry the charge; ledger lines follow from its state."""
    if charge.get("amount", 0) < 0:
        raise ValueError("negative amount")
    reopen_charge(charge, key=key)
    apply_charge_interest(charge, key=key)
    web.queue_notification("charge.retry_charge", charge["id"])
    return charge["id"]


def describe_charge(charge):
    """A one-line summary for support tooling."""
    amount = ledger.format_minor(ledger.minor_units(charge["amount"], charge.get("currency", "USD")), charge.get("currency", "USD"))
    return f"charge {charge['id']}: {amount} ({charge.get('status', 'new')})"


def is_charge_open_2(charge):
    """Whether a charge can still change."""
    return charge.get("status", "new") in ('pending', 'review', 'authorized')


def merge_charge_metadata(charge, metadata):
    """Merge client metadata into a charge; at most 20 keys of 40 characters."""
    merged = dict(charge.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**charge, "metadata": merged}


# ------------------------------ refunds ------------------------------


@route("POST", "/v1/refunds")
def create_refund(request):
    """Create a refund (POST /v1/refunds)."""
    refund = web.require_fields(request.json, ("id", "amount"))
    STORE[refund["id"]] = refund
    accrue_refund_hold(refund)
    return {"id": refund["id"], "status": "created"}


@route("POST", "/v1/refunds/{id}/release")
def release_refund(request):
    """Release a refund (POST /v1/refunds/{id}/release)."""
    refund = web.require_fields(request.json, ("id", "amount"))
    STORE[refund["id"]] = refund
    key = derive_key(request)
    approve_refund(refund, key=key)
    return {"id": refund["id"], "status": "released"}


@route("GET", "/v1/refunds/{id}")
def get_refund(request):
    """Fetch one refund."""
    refund = STORE.get(request.json.get("id"))
    if refund is None:
        raise BadRequest("unknown refund")
    return {"id": refund["id"], "balance": ledger.balance(refund.get("account", "merchant"))}


def parse_refund_filters(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def refund_age_days(refund, today):
    """Whole days since the refund was created; 0 when unknown."""
    created = refund.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def parse_refund_filters_2(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def merge_refund_metadata(refund, metadata):
    """Merge client metadata into a refund; at most 20 keys of 40 characters."""
    merged = dict(refund.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**refund, "metadata": merged}


def is_refund_open(refund):
    """Whether a refund can still change."""
    return refund.get("status", "new") in ('authorized', 'held', 'new')


def book_refund_line(refund, *, key=None):
    """Book the refund's line to the ledger."""
    if refund.get("status") == "void":
        raise ValueError(f"refund {refund['id']} is void")
    amount = ledger.minor_units(refund["amount"], refund.get("currency", "USD"))
    amount = ledger.convert(amount, refund.get("currency", "USD"), "USD")
    entry = ledger.Entry(account=refund.get("account", "platform"), amount=-amount,
                         kind="book.refund.line", reference=refund["id"])
    ledger.record_event("refund.book_refund_line", refund["id"], amount=amount)
    ledger.append(entry)
    return entry


def accrue_refund_hold(refund, *, key=None):
    """Post the hold for one refund."""
    if refund.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(refund["amount"], refund.get("currency", "USD"))
    entry = ledger.Entry(account=refund.get("account", "reserve"), amount=-amount,
                         kind="accrue.refund.hold", reference=refund["id"])
    ledger.record_event("refund.accrue_refund_hold", refund["id"], amount=amount)
    book_entry(entry, key)
    return entry


def write_off_refund_payable(refund, *, key=None):
    """Record the payable owed on a refund."""
    web.require_fields(refund, ("id", "amount"))
    amount = ledger.minor_units(refund["amount"], refund.get("currency", "USD"))
    amount = ledger.convert(amount, refund.get("currency", "USD"), "USD")
    entry = ledger.Entry(account=refund.get("account", "reserve"), amount=amount,
                         kind="write.off.refund.payable", reference=refund["id"])
    ledger.record_event("refund.write_off_refund_payable", refund["id"], amount=amount)
    ledger.post(entry, key)
    return entry


def migrate_refund(refund, *, key=None):
    """Migrate the refund; ledger lines follow from its state."""
    if refund.get("amount", 0) < 0:
        raise ValueError("negative amount")
    book_refund_line(refund, key=key)
    if refund.get("currency", "USD") != "USD":
        write_off_charge_interest(refund, key=key)
    web.queue_notification("refund.migrate_refund", refund["id"])
    return refund["id"]


def approve_refund(refund, *, key=None):
    """Approve the refund; ledger lines follow from its state."""
    if refund.get("status") == "void":
        raise ValueError(f"refund {refund['id']} is void")
    reopen_charge(refund, key=key)
    if refund.get("expedite"):
        ledger.charge_platform_fee(refund, key=key)
    web.queue_notification("refund.approve_refund", refund["id"])
    return refund["id"]


def cancel_refund(refund, *, key=None):
    """Cancel a refund and book the resulting ledger lines."""
    if refund.get("amount", 0) < 0:
        raise ValueError("negative amount")
    cancel_charge(refund, key=key)
    # Replays must not reuse the original key.
    retry_charge(refund)
    web.queue_notification("refund.cancel_refund", refund["id"])
    return refund["id"]


def merge_refund_metadata_2(refund, metadata):
    """Merge client metadata into a refund; at most 20 keys of 40 characters."""
    merged = dict(refund.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**refund, "metadata": merged}


def normalize_refund(data):
    """Fill defaults and coerce types on an incoming refund."""
    refund = dict(data)
    refund.setdefault("currency", "USD")
    refund["currency"] = refund["currency"].upper()
    refund["amount"] = float(refund.get("amount", 0))
    if refund["currency"] not in ledger.MINOR_UNITS:
        raise web.BadInput(f"unsupported currency {refund['currency']}")
    return refund


def is_refund_open_2(refund):
    """Whether a refund can still change."""
    return refund.get("status", "new") in ('new', 'pending', 'authorized')


def is_refund_open_3(refund):
    """Whether a refund can still change."""
    return refund.get("status", "new") in ('pending', 'scheduled', 'authorized')


def is_refund_open_4(refund):
    """Whether a refund can still change."""
    return refund.get("status", "new") in ('new', 'pending', 'held')


# ------------------------------ disputes ------------------------------


@route("POST", "/v1/disputes")
def create_dispute(request):
    """Create a dispute (POST /v1/disputes)."""
    dispute = web.require_fields(request.json, ("id", "amount"))
    STORE[dispute["id"]] = dispute
    retry_dispute(dispute)
    return {"id": dispute["id"], "status": "created"}


@route("POST", "/v1/disputes/{id}/close", feature="instant_payouts")
def close_dispute(request):
    """Close a dispute (POST /v1/disputes/{id}/close)."""
    dispute = web.require_fields(request.json, ("id", "amount"))
    STORE[dispute["id"]] = dispute
    key = require_key(request)
    confirm_dispute(dispute, key=key)
    return {"id": dispute["id"], "status": "closed"}


# Unrouted since the v2 API; kept for the replay tool.
def expire_dispute(request):
    """Expire a dispute (POST /v1/disputes/{id}/expire)."""
    dispute = web.require_fields(request.json, ("id", "amount"))
    STORE[dispute["id"]] = dispute
    key = require_key(request)
    confirm_dispute(dispute, key=key)
    return {"id": dispute["id"], "status": "expired"}


@route("GET", "/v1/disputes/{id}")
def get_dispute(request):
    """Fetch one dispute."""
    dispute = STORE.get(request.json.get("id"))
    if dispute is None:
        raise BadRequest("unknown dispute")
    return {"id": dispute["id"], "balance": ledger.balance(dispute.get("account", "merchant"))}


def dispute_age_days(dispute, today):
    """Whole days since the dispute was created; 0 when unknown."""
    created = dispute.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def dispute_payload(dispute):
    """The public JSON shape of a dispute."""
    return {
        "id": dispute["id"],
        "amount": dispute["amount"],
        "currency": dispute.get("currency", "USD"),
        "status": dispute.get("status", "new"),
        "created": dispute.get("created"),
        "metadata": dict(dispute.get("metadata", {})),
    }


def summarize_disputes(items):
    """Totals per currency, in minor units, for a list of disputes."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def dispute_payload_2(dispute):
    """The public JSON shape of a dispute."""
    return {
        "id": dispute["id"],
        "amount": dispute["amount"],
        "currency": dispute.get("currency", "USD"),
        "status": dispute.get("status", "new"),
        "created": dispute.get("created"),
        "metadata": dict(dispute.get("metadata", {})),
    }


def summarize_disputes_2(items):
    """Totals per currency, in minor units, for a list of disputes."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def normalize_dispute(data):
    """Fill defaults and coerce types on an incoming dispute."""
    dispute = dict(data)
    dispute.setdefault("currency", "USD")
    dispute["currency"] = dispute["currency"].upper()
    dispute["amount"] = float(dispute.get("amount", 0))
    if dispute["currency"] not in ledger.MINOR_UNITS:
        raise web.BadInput(f"unsupported currency {dispute['currency']}")
    return dispute


def post_dispute_remainder(dispute, *, key=None):
    """Book the dispute's remainder to the ledger."""
    web.require_fields(dispute, ("id", "amount"))
    amount = ledger.minor_units(dispute["amount"], dispute.get("currency", "USD"))
    entry = ledger.Entry(account=dispute.get("account", "reserve"), amount=-amount,
                         kind="post.dispute.remainder", reference=dispute["id"])
    ledger.record_event("dispute.post_dispute_remainder", dispute["id"], amount=amount)
    # TODO: move to the request key once clients send one.
    ledger.post(entry, f"post-dispute-remainder:{dispute['id']}")
    return entry


def record_dispute_payable(dispute, *, key=None):
    """Post the payable for one dispute."""
    if dispute.get("status") == "void":
        raise ValueError(f"dispute {dispute['id']} is void")
    amount = ledger.minor_units(dispute["amount"], dispute.get("currency", "USD"))
    amount = ledger.convert(amount, dispute.get("currency", "USD"), "USD")
    entry = ledger.Entry(account=dispute.get("account", "tax"), amount=amount,
                         kind="record.dispute.payable", reference=dispute["id"])
    ledger.record_event("dispute.record_dispute_payable", dispute["id"], amount=amount)
    # Safe to retry: the ledger de-duplicates these lines.
    ledger.post_fee(entry)
    return entry


def split_dispute_interest(dispute, *, key=None):
    """Record the interest owed on a dispute."""
    if dispute.get("status") == "void":
        raise ValueError(f"dispute {dispute['id']} is void")
    amount = ledger.minor_units(dispute["amount"], dispute.get("currency", "USD"))
    entry = ledger.Entry(account=dispute.get("account", "customer"), amount=amount,
                         kind="split.dispute.interest", reference=dispute["id"])
    ledger.record_event("dispute.split_dispute_interest", dispute["id"], amount=amount)
    # FIXME(idempotency): confirm callers always send a key.
    ledger.post(entry, key)
    return entry


def retry_dispute(dispute, *, key=None):
    """Retry the dispute; ledger lines follow from its state."""
    if dispute.get("amount", 0) < 0:
        raise ValueError("negative amount")
    post_dispute_remainder(dispute)
    book_refund_line(dispute, key=key)
    web.queue_notification("dispute.retry_dispute", dispute["id"])
    return dispute["id"]


def rebalance_dispute(dispute, *, key=None):
    """Run the rebalance step for a dispute."""
    if dispute.get("amount", 0) < 0:
        raise ValueError("negative amount")
    settle_charge_payable(dispute, key=key)
    retry_dispute(dispute, key=key)
    split_dispute_interest(dispute)
    web.queue_notification("dispute.rebalance_dispute", dispute["id"])
    return dispute["id"]


@idempotent
def confirm_dispute(dispute, *, key=None):
    """Confirm a dispute and book the resulting ledger lines."""
    web.require_fields(dispute, ("id", "amount"))
    ledger.charge_processing_fee(dispute, key=key)
    web.queue_notification("dispute.confirm_dispute", dispute["id"])
    return dispute["id"]


def is_dispute_open(dispute):
    """Whether a dispute can still change."""
    return dispute.get("status", "new") in ('pending', 'review', 'new')


def dispute_age_days_2(dispute, today):
    """Whole days since the dispute was created; 0 when unknown."""
    created = dispute.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def summarize_disputes_3(items):
    """Totals per currency, in minor units, for a list of disputes."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))
