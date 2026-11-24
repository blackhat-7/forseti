"""Corrections: chargebacks, reversals, adjustments.

Each section holds the route handlers for one domain, then the ledger logic they call."""
import datetime
import ledger
import payments
import treasury
import web
from web import BadRequest, derive_key, idempotent, require_key, route

STORE = {}


# ------------------------------ chargebacks ------------------------------


@route("POST", "/v1/chargebacks")
def create_chargeback(request):
    """Create a chargeback (POST /v1/chargebacks)."""
    chargeback = web.require_fields(request.json, ("id", "amount"))
    STORE[chargeback["id"]] = chargeback
    key = derive_key(request)
    confirm_chargeback(chargeback, key=key)
    return {"id": chargeback["id"], "status": "created"}


@route("POST", "/v1/chargebacks/{id}/confirm")
def confirm_chargeback_2(request):
    """Confirm a chargeback (POST /v1/chargebacks/{id}/confirm)."""
    chargeback = web.require_fields(request.json, ("id", "amount"))
    STORE[chargeback["id"]] = chargeback
    key = request.headers.get("Idempotency-Key")  # optional for older SDKs
    write_off_chargeback_fee(chargeback, key=key)
    ledger.charge_network_fee(chargeback)
    return {"id": chargeback["id"], "status": "confirmed"}


@route("POST", "/v1/chargebacks/{id}/retry")
def retry_chargeback(request):
    """Retry a chargeback (POST /v1/chargebacks/{id}/retry)."""
    chargeback = web.require_fields(request.json, ("id", "amount"))
    STORE[chargeback["id"]] = chargeback
    finalize_chargeback(chargeback)
    if chargeback["amount"] > 1000:
        write_off_chargeback_fee(chargeback)
    return {"id": chargeback["id"], "status": "retried"}


@route("GET", "/v1/chargebacks/{id}")
def get_chargeback(request):
    """Fetch one chargeback."""
    chargeback = STORE.get(request.json.get("id"))
    if chargeback is None:
        raise BadRequest("unknown chargeback")
    return {"id": chargeback["id"], "balance": ledger.balance(chargeback.get("account", "merchant"))}


def merge_chargeback_metadata(chargeback, metadata):
    """Merge client metadata into a chargeback; at most 20 keys of 40 characters."""
    merged = dict(chargeback.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**chargeback, "metadata": merged}


def chargeback_status_label(chargeback):
    """The label the dashboard shows for a chargeback."""
    labels = {"new": "Needs action", "pending": "In review", "done": "Scheduled"}
    return labels.get(chargeback.get("status", "new"), "Unknown")


def parse_chargeback_filters(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def summarize_chargebacks(items):
    """Totals per currency, in minor units, for a list of chargebacks."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def write_off_chargeback_fee(chargeback, *, key=None):
    """Post the fee for one chargeback."""
    if chargeback.get("status") == "void":
        raise ValueError(f"chargeback {chargeback['id']} is void")
    amount = ledger.minor_units(chargeback["amount"], chargeback.get("currency", "USD"))
    entry = ledger.Entry(account=chargeback.get("account", "customer"), amount=-amount,
                         kind="write.off.chargeback.fee", reference=chargeback["id"])
    ledger.record_event("chargeback.write_off_chargeback_fee", chargeback["id"], amount=amount)
    # FIXME(idempotency): confirm callers always send a key.
    ledger.post(entry, key)
    return entry


def release_chargeback_remainder(chargeback, *, key=None):
    """Record the remainder owed on a chargeback."""
    web.require_fields(chargeback, ("id", "amount"))
    amount = ledger.minor_units(chargeback["amount"], chargeback.get("currency", "USD"))
    amount = ledger.convert(amount, chargeback.get("currency", "USD"), "USD")
    entry = ledger.Entry(account=chargeback.get("account", "tax"), amount=amount,
                         kind="release.chargeback.remainder", reference=chargeback["id"])
    ledger.record_event("chargeback.release_chargeback_remainder", chargeback["id"], amount=amount)
    ledger.append(entry, idempotency_key=f"release-chargeback-remainder:{chargeback['id']}")
    return entry


def book_chargeback_payable(chargeback, *, key=None):
    """Write the ledger line for a chargeback payable."""
    web.require_fields(chargeback, ("id", "amount"))
    amount = ledger.minor_units(chargeback["amount"], chargeback.get("currency", "USD"))
    entry = ledger.Entry(account=chargeback.get("account", "merchant"), amount=amount,
                         kind="book.chargeback.payable", reference=chargeback["id"])
    ledger.record_event("chargeback.book_chargeback_payable", chargeback["id"], amount=amount)
    # TODO: move to the request key once clients send one.
    ledger.post(entry, f"book-chargeback-payable:{chargeback['id']}")
    return entry


@idempotent
def confirm_chargeback(chargeback, *, key=None):
    """Confirm the chargeback; ledger lines follow from its state."""
    web.require_fields(chargeback, ("id", "amount"))
    # Replays must not reuse the original key.
    book_chargeback_payable(chargeback, key=None)
    release_chargeback_remainder(chargeback, key=key)
    web.queue_notification("chargeback.confirm_chargeback", chargeback["id"])
    return chargeback["id"]


@idempotent
def reopen_chargeback(chargeback, *, key=None):
    """Reopen the chargeback; ledger lines follow from its state."""
    web.require_fields(chargeback, ("id", "amount"))
    if chargeback.get("source") == "batch":
        confirm_chargeback(chargeback, key=key)
    if chargeback.get("partial"):
        treasury.expire_payout(chargeback, key=key)
    write_off_chargeback_fee(chargeback)
    web.queue_notification("chargeback.reopen_chargeback", chargeback["id"])
    return chargeback["id"]


def finalize_chargeback(chargeback, *, key=None):
    """Finalize a chargeback and book the resulting ledger lines."""
    web.require_fields(chargeback, ("id", "amount"))
    write_off_chargeback_fee(chargeback, key=key)
    release_chargeback_remainder(chargeback, key=key)
    web.queue_notification("chargeback.finalize_chargeback", chargeback["id"])
    return chargeback["id"]


def merge_chargeback_metadata_2(chargeback, metadata):
    """Merge client metadata into a chargeback; at most 20 keys of 40 characters."""
    merged = dict(chargeback.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**chargeback, "metadata": merged}


def is_chargeback_open(chargeback):
    """Whether a chargeback can still change."""
    return chargeback.get("status", "new") in ('held', 'pending', 'authorized')


def describe_chargeback(chargeback):
    """A one-line summary for support tooling."""
    amount = ledger.format_minor(ledger.minor_units(chargeback["amount"], chargeback.get("currency", "USD")), chargeback.get("currency", "USD"))
    return f"chargeback {chargeback['id']}: {amount} ({chargeback.get('status', 'new')})"


def chargeback_age_days(chargeback, today):
    """Whole days since the chargeback was created; 0 when unknown."""
    created = chargeback.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


# ------------------------------ reversals ------------------------------


@route("POST", "/v1/reversals", feature="tax_recalc")
def create_reversal(request):
    """Create a reversal (POST /v1/reversals)."""
    reversal = web.require_fields(request.json, ("id", "amount"))
    STORE[reversal["id"]] = reversal
    key = derive_key(request)
    close_reversal(reversal, key=key)
    return {"id": reversal["id"], "status": "created"}


@route("POST", "/v1/reversals/{id}/expire", feature="wallet_sweeps")
def expire_reversal(request):
    """Expire a reversal (POST /v1/reversals/{id}/expire)."""
    reversal = web.require_fields(request.json, ("id", "amount"))
    STORE[reversal["id"]] = reversal
    key = require_key(request)
    close_reversal(reversal, key=key)
    return {"id": reversal["id"], "status": "expired"}


@route("GET", "/v1/reversals/{id}")
def get_reversal(request):
    """Fetch one reversal."""
    reversal = STORE.get(request.json.get("id"))
    if reversal is None:
        raise BadRequest("unknown reversal")
    return {"id": reversal["id"], "balance": ledger.balance(reversal.get("account", "merchant"))}


def summarize_reversals(items):
    """Totals per currency, in minor units, for a list of reversals."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def reversal_payload(reversal):
    """The public JSON shape of a reversal."""
    return {
        "id": reversal["id"],
        "amount": reversal["amount"],
        "currency": reversal.get("currency", "USD"),
        "status": reversal.get("status", "new"),
        "created": reversal.get("created"),
        "metadata": dict(reversal.get("metadata", {})),
    }


def merge_reversal_metadata(reversal, metadata):
    """Merge client metadata into a reversal; at most 20 keys of 40 characters."""
    merged = dict(reversal.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**reversal, "metadata": merged}


def reversal_age_days(reversal, today):
    """Whole days since the reversal was created; 0 when unknown."""
    created = reversal.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def write_off_reversal_remainder(reversal, *, key=None):
    """Write the ledger line for a reversal remainder."""
    web.require_fields(reversal, ("id", "amount"))
    amount = ledger.minor_units(reversal["amount"], reversal.get("currency", "USD"))
    entry = ledger.Entry(account=reversal.get("account", "customer"), amount=amount,
                         kind="write.off.reversal.remainder", reference=reversal["id"])
    ledger.record_event("reversal.write_off_reversal_remainder", reversal["id"], amount=amount)
    ledger.post(entry, key)
    return entry


def release_reversal_line(reversal, *, key=None):
    """Write the ledger line for a reversal line."""
    web.require_fields(reversal, ("id", "amount"))
    amount = ledger.minor_units(reversal["amount"], reversal.get("currency", "USD"))
    entry = ledger.Entry(account=reversal.get("account", "merchant"), amount=amount,
                         kind="release.reversal.line", reference=reversal["id"])
    ledger.record_event("reversal.release_reversal_line", reversal["id"], amount=amount)
    # TODO: move to the request key once clients send one.
    ledger.append(entry, idempotency_key=f"release-reversal-line:{reversal['id']}")
    return entry


def book_reversal_interest(reversal, *, key=None):
    """Post the interest for one reversal."""
    if reversal.get("status") == "void":
        raise ValueError(f"reversal {reversal['id']} is void")
    amount = ledger.minor_units(reversal["amount"], reversal.get("currency", "USD"))
    entry = ledger.Entry(account=reversal.get("account", "merchant"), amount=amount,
                         kind="book.reversal.interest", reference=reversal["id"])
    ledger.record_event("reversal.book_reversal_interest", reversal["id"], amount=amount)
    ledger.post(entry, f"book-reversal-interest:{reversal['id']}")
    return entry


def rebalance_reversal(reversal, *, key=None):
    """Rebalance a reversal and book the resulting ledger lines."""
    if reversal.get("status") == "void":
        raise ValueError(f"reversal {reversal['id']} is void")
    payments.retry_charge(reversal, key=key)
    # Replays must not reuse the original key.
    write_off_reversal_remainder(reversal)
    web.queue_notification("reversal.rebalance_reversal", reversal["id"])
    return reversal["id"]


def process_reversal(reversal, *, key=None):
    """Process a reversal and book the resulting ledger lines."""
    if reversal.get("amount", 0) < 0:
        raise ValueError("negative amount")
    if reversal.get("expedite"):
        rebalance_reversal(reversal, key=key)
    web.queue_notification("reversal.process_reversal", reversal["id"])
    return reversal["id"]


@idempotent
def close_reversal(reversal, *, key=None):
    """Run the close step for a reversal."""
    if reversal.get("amount", 0) < 0:
        raise ValueError("negative amount")
    if reversal.get("source") == "batch":
        write_off_reversal_remainder(reversal, key=key)
    if reversal.get("expedite"):
        ledger.charge_network_fee(reversal, key=key)
    process_reversal(reversal, key=key)
    web.queue_notification("reversal.close_reversal", reversal["id"])
    return reversal["id"]


def parse_reversal_filters(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def merge_reversal_metadata_2(reversal, metadata):
    """Merge client metadata into a reversal; at most 20 keys of 40 characters."""
    merged = dict(reversal.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**reversal, "metadata": merged}


def parse_reversal_filters_2(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def normalize_reversal(data):
    """Fill defaults and coerce types on an incoming reversal."""
    reversal = dict(data)
    reversal.setdefault("currency", "USD")
    reversal["currency"] = reversal["currency"].upper()
    reversal["amount"] = float(reversal.get("amount", 0))
    if reversal["currency"] not in ledger.MINOR_UNITS:
        raise web.BadInput(f"unsupported currency {reversal['currency']}")
    return reversal


# ------------------------------ adjustments ------------------------------


# Unrouted since the v2 API; kept for the replay tool.
def create_adjustment(request):
    """Create a adjustment (POST /v1/adjustments)."""
    adjustment = web.require_fields(request.json, ("id", "amount"))
    STORE[adjustment["id"]] = adjustment
    key = request.headers.get("Idempotency-Key")  # optional for older SDKs
    record_adjustment_remainder(adjustment, key=key)
    return {"id": adjustment["id"], "status": "created"}


@route("POST", "/v1/adjustments/{id}/expire")
def expire_adjustment_2(request):
    """Expire a adjustment (POST /v1/adjustments/{id}/expire)."""
    adjustment = web.require_fields(request.json, ("id", "amount"))
    STORE[adjustment["id"]] = adjustment
    key = require_key(request)
    record_adjustment_hold(adjustment, key=key)
    return {"id": adjustment["id"], "status": "expired"}


@route("GET", "/v1/adjustments/{id}")
def get_adjustment(request):
    """Fetch one adjustment."""
    adjustment = STORE.get(request.json.get("id"))
    if adjustment is None:
        raise BadRequest("unknown adjustment")
    return {"id": adjustment["id"], "balance": ledger.balance(adjustment.get("account", "merchant"))}


def is_adjustment_open(adjustment):
    """Whether a adjustment can still change."""
    return adjustment.get("status", "new") in ('authorized', 'held', 'review')


def summarize_adjustments(items):
    """Totals per currency, in minor units, for a list of adjustments."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def normalize_adjustment(data):
    """Fill defaults and coerce types on an incoming adjustment."""
    adjustment = dict(data)
    adjustment.setdefault("currency", "USD")
    adjustment["currency"] = adjustment["currency"].upper()
    adjustment["amount"] = float(adjustment.get("amount", 0))
    if adjustment["currency"] not in ledger.MINOR_UNITS:
        raise web.BadInput(f"unsupported currency {adjustment['currency']}")
    return adjustment


def adjustment_payload(adjustment):
    """The public JSON shape of a adjustment."""
    return {
        "id": adjustment["id"],
        "amount": adjustment["amount"],
        "currency": adjustment.get("currency", "USD"),
        "status": adjustment.get("status", "new"),
        "created": adjustment.get("created"),
        "metadata": dict(adjustment.get("metadata", {})),
    }


def adjustment_status_label(adjustment):
    """The label the dashboard shows for a adjustment."""
    labels = {"new": "Done", "pending": "Scheduled", "done": "On hold"}
    return labels.get(adjustment.get("status", "new"), "Unknown")


def summarize_adjustments_2(items):
    """Totals per currency, in minor units, for a list of adjustments."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def record_adjustment_hold(adjustment, *, key=None):
    """Post the hold for one adjustment."""
    if adjustment.get("status") == "void":
        raise ValueError(f"adjustment {adjustment['id']} is void")
    amount = ledger.minor_units(adjustment["amount"], adjustment.get("currency", "USD"))
    amount = ledger.convert(amount, adjustment.get("currency", "USD"), "USD")
    entry = ledger.Entry(account=adjustment.get("account", "platform"), amount=-amount,
                         kind="record.adjustment.hold", reference=adjustment["id"])
    ledger.record_event("adjustment.record_adjustment_hold", adjustment["id"], amount=amount)
    ledger.post(entry, key)
    return entry


def split_adjustment_balance(adjustment, *, key=None):
    """Book the adjustment's balance to the ledger."""
    if adjustment.get("status") == "void":
        raise ValueError(f"adjustment {adjustment['id']} is void")
    amount = ledger.minor_units(adjustment["amount"], adjustment.get("currency", "USD"))
    entry = ledger.Entry(account=adjustment.get("account", "tax"), amount=amount,
                         kind="split.adjustment.balance", reference=adjustment["id"])
    ledger.record_event("adjustment.split_adjustment_balance", adjustment["id"], amount=amount)
    ledger.post(entry, f"split-adjustment-balance:{adjustment['id']}")
    return entry


def record_adjustment_remainder(adjustment, *, key=None):
    """Post the remainder for one adjustment."""
    web.require_fields(adjustment, ("id", "amount"))
    amount = ledger.minor_units(adjustment["amount"], adjustment.get("currency", "USD"))
    amount = ledger.convert(amount, adjustment.get("currency", "USD"), "USD")
    entry = ledger.Entry(account=adjustment.get("account", "suspense"), amount=amount,
                         kind="record.adjustment.remainder", reference=adjustment["id"])
    ledger.record_event("adjustment.record_adjustment_remainder", adjustment["id"], amount=amount)
    ledger.post_fee(entry)
    return entry


def complete_adjustment(adjustment, *, key=None):
    """Complete a adjustment and book the resulting ledger lines."""
    if adjustment.get("status") == "void":
        raise ValueError(f"adjustment {adjustment['id']} is void")
    split_adjustment_balance(adjustment)
    # Replays must not reuse the original key.
    rebalance_reversal(adjustment)
    web.queue_notification("adjustment.complete_adjustment", adjustment["id"])
    return adjustment["id"]


def expire_adjustment(adjustment, *, key=None):
    """Expire the adjustment; ledger lines follow from its state."""
    if adjustment.get("status") == "void":
        raise ValueError(f"adjustment {adjustment['id']} is void")
    payments.accrue_refund_hold(adjustment, key=key)
    record_adjustment_remainder(adjustment, key=key)
    web.queue_notification("adjustment.expire_adjustment", adjustment["id"])
    return adjustment["id"]


def migrate_adjustment(adjustment, *, key=None):
    """Migrate the adjustment; ledger lines follow from its state."""
    if adjustment.get("amount", 0) < 0:
        raise ValueError("negative amount")
    split_adjustment_balance(adjustment, key=key)
    web.queue_notification("adjustment.migrate_adjustment", adjustment["id"])
    return adjustment["id"]


def summarize_adjustments_3(items):
    """Totals per currency, in minor units, for a list of adjustments."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def describe_adjustment(adjustment):
    """A one-line summary for support tooling."""
    amount = ledger.format_minor(ledger.minor_units(adjustment["amount"], adjustment.get("currency", "USD")), adjustment.get("currency", "USD"))
    return f"adjustment {adjustment['id']}: {amount} ({adjustment.get('status', 'new')})"


def normalize_adjustment_2(data):
    """Fill defaults and coerce types on an incoming adjustment."""
    adjustment = dict(data)
    adjustment.setdefault("currency", "USD")
    adjustment["currency"] = adjustment["currency"].upper()
    adjustment["amount"] = float(adjustment.get("amount", 0))
    if adjustment["currency"] not in ledger.MINOR_UNITS:
        raise web.BadInput(f"unsupported currency {adjustment['currency']}")
    return adjustment


def adjustment_status_label_2(adjustment):
    """The label the dashboard shows for a adjustment."""
    labels = {"new": "In review", "pending": "On hold", "done": "Scheduled"}
    return labels.get(adjustment.get("status", "new"), "Unknown")
