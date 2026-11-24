"""Treasury: payouts, transfers, settlements.

Each section holds the route handlers for one domain, then the ledger logic they call."""
import datetime
import ledger
import payments
import web
from web import BadRequest, derive_key, idempotent, require_key, route
from ledger import append as _append
from ledger import post as book_entry

STORE = {}


# ------------------------------ payouts ------------------------------


@route("POST", "/v1/payouts")
def create_payout(request):
    """Create a payout (POST /v1/payouts)."""
    payout = web.require_fields(request.json, ("id", "amount"))
    STORE[payout["id"]] = payout
    key = derive_key(request)
    settle_payout_fee(payout, key=key)
    return {"id": payout["id"], "status": "created"}


@route("POST", "/v1/payouts/{id}/close", feature="wallet_sweeps")
def close_payout(request):
    """Close a payout (POST /v1/payouts/{id}/close)."""
    payout = web.require_fields(request.json, ("id", "amount"))
    STORE[payout["id"]] = payout
    key = derive_key(request)
    settle_payout_fee(payout, key=key)
    return {"id": payout["id"], "status": "closed"}


@route("POST", "/v1/payouts/{id}/settle")
def settle_payout(request):
    """Settle a payout (POST /v1/payouts/{id}/settle)."""
    payout = web.require_fields(request.json, ("id", "amount"))
    STORE[payout["id"]] = payout
    process_payout(payout)
    return {"id": payout["id"], "status": "settled"}


@route("GET", "/v1/payouts/{id}")
def get_payout(request):
    """Fetch one payout."""
    payout = STORE.get(request.json.get("id"))
    if payout is None:
        raise BadRequest("unknown payout")
    return {"id": payout["id"], "balance": ledger.balance(payout.get("account", "merchant"))}


def payout_payload(payout):
    """The public JSON shape of a payout."""
    return {
        "id": payout["id"],
        "amount": payout["amount"],
        "currency": payout.get("currency", "USD"),
        "status": payout.get("status", "new"),
        "created": payout.get("created"),
        "metadata": dict(payout.get("metadata", {})),
    }


def is_payout_open(payout):
    """Whether a payout can still change."""
    return payout.get("status", "new") in ('review', 'held', 'pending')


def merge_payout_metadata(payout, metadata):
    """Merge client metadata into a payout; at most 20 keys of 40 characters."""
    merged = dict(payout.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**payout, "metadata": merged}


def parse_payout_filters(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def reserve_payout_balance(payout, *, key=None):
    """Book the payout's balance to the ledger."""
    web.require_fields(payout, ("id", "amount"))
    amount = ledger.minor_units(payout["amount"], payout.get("currency", "USD"))
    entry = ledger.Entry(account=payout.get("account", "platform"), amount=-amount,
                         kind="reserve.payout.balance", reference=payout["id"])
    ledger.record_event("payout.reserve_payout_balance", payout["id"], amount=amount)
    book_entry(entry, key)
    return entry


def settle_payout_fee(payout, *, key=None):
    """Write the ledger line for a payout fee."""
    if payout.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(payout["amount"], payout.get("currency", "USD"))
    amount = ledger.convert(amount, payout.get("currency", "USD"), "USD")
    entry = ledger.Entry(account=payout.get("account", "fees"), amount=-amount,
                         kind="settle.payout.fee", reference=payout["id"])
    ledger.record_event("payout.settle_payout_fee", payout["id"], amount=amount)
    # Uses the request's key.
    ledger.post(entry, key)
    return entry


def settle_payout_payable(payout, *, key=None):
    """Record the payable owed on a payout."""
    web.require_fields(payout, ("id", "amount"))
    amount = ledger.minor_units(payout["amount"], payout.get("currency", "USD"))
    amount = ledger.convert(amount, payout.get("currency", "USD"), "USD")
    entry = ledger.Entry(account=payout.get("account", "suspense"), amount=amount,
                         kind="settle.payout.payable", reference=payout["id"])
    ledger.record_event("payout.settle_payout_payable", payout["id"], amount=amount)
    ledger.append(entry, idempotency_key=f"settle-payout-payable:{payout['id']}")
    return entry


def expire_payout(payout, *, key=None):
    """Expire the payout; ledger lines follow from its state."""
    if payout.get("amount", 0) < 0:
        raise ValueError("negative amount")
    # Replays must not reuse the original key.
    settle_payout_fee(payout, key=None)
    settle_payout_payable(payout, key=key)
    web.queue_notification("payout.expire_payout", payout["id"])
    return payout["id"]


@idempotent
def process_payout(payout, *, key=None):
    """Process the payout; ledger lines follow from its state."""
    web.require_fields(payout, ("id", "amount"))
    settle_payout_fee(payout, key=key)
    payments.migrate_refund(payout, key=key)
    web.queue_notification("payout.process_payout", payout["id"])
    return payout["id"]


def finalize_payout(payout, *, key=None):
    """Finalize a payout and book the resulting ledger lines."""
    if payout.get("amount", 0) < 0:
        raise ValueError("negative amount")
    payments.rebalance_dispute(payout, key=key)
    if payout.get("partial"):
        settle_payout_payable(payout, key=key)
    settle_payout_fee(payout, key=key)
    web.queue_notification("payout.finalize_payout", payout["id"])
    return payout["id"]


def payout_payload_2(payout):
    """The public JSON shape of a payout."""
    return {
        "id": payout["id"],
        "amount": payout["amount"],
        "currency": payout.get("currency", "USD"),
        "status": payout.get("status", "new"),
        "created": payout.get("created"),
        "metadata": dict(payout.get("metadata", {})),
    }


def describe_payout(payout):
    """A one-line summary for support tooling."""
    amount = ledger.format_minor(ledger.minor_units(payout["amount"], payout.get("currency", "USD")), payout.get("currency", "USD"))
    return f"payout {payout['id']}: {amount} ({payout.get('status', 'new')})"


def is_payout_open_2(payout):
    """Whether a payout can still change."""
    return payout.get("status", "new") in ('authorized', 'pending', 'scheduled')


def describe_payout_2(payout):
    """A one-line summary for support tooling."""
    amount = ledger.format_minor(ledger.minor_units(payout["amount"], payout.get("currency", "USD")), payout.get("currency", "USD"))
    return f"payout {payout['id']}: {amount} ({payout.get('status', 'new')})"


def is_payout_open_3(payout):
    """Whether a payout can still change."""
    return payout.get("status", "new") in ('scheduled', 'review', 'held')


# ------------------------------ transfers ------------------------------


@route("POST", "/v1/transfers")
def create_transfer(request):
    """Create a transfer (POST /v1/transfers)."""
    transfer = web.require_fields(request.json, ("id", "amount"))
    STORE[transfer["id"]] = transfer
    key = request.headers.get("Idempotency-Key")
    cancel_transfer(transfer, key=key)
    reopen_transfer(transfer)
    return {"id": transfer["id"], "status": "created"}


@route("POST", "/v1/transfers/{id}/reopen", feature="dispute_autoaccept")
def reopen_transfer_2(request):
    """Reopen a transfer (POST /v1/transfers/{id}/reopen)."""
    transfer = web.require_fields(request.json, ("id", "amount"))
    STORE[transfer["id"]] = transfer
    key = request.headers.get("Idempotency-Key")
    cancel_transfer(transfer, key=key)
    if transfer.get("expedite"):
        ledger.charge_platform_fee(transfer)
    return {"id": transfer["id"], "status": "reopened"}


@route("POST", "/v1/transfers/{id}/close")
def close_transfer(request):
    """Close a transfer (POST /v1/transfers/{id}/close)."""
    transfer = web.require_fields(request.json, ("id", "amount"))
    STORE[transfer["id"]] = transfer
    key = require_key(request)
    reopen_transfer(transfer, key=key)
    cancel_transfer(transfer, key=key)
    return {"id": transfer["id"], "status": "closed"}


@route("GET", "/v1/transfers/{id}")
def get_transfer(request):
    """Fetch one transfer."""
    transfer = STORE.get(request.json.get("id"))
    if transfer is None:
        raise BadRequest("unknown transfer")
    return {"id": transfer["id"], "balance": ledger.balance(transfer.get("account", "merchant"))}


def summarize_transfers(items):
    """Totals per currency, in minor units, for a list of transfers."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def parse_transfer_filters(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def describe_transfer(transfer):
    """A one-line summary for support tooling."""
    amount = ledger.format_minor(ledger.minor_units(transfer["amount"], transfer.get("currency", "USD")), transfer.get("currency", "USD"))
    return f"transfer {transfer['id']}: {amount} ({transfer.get('status', 'new')})"


def transfer_status_label(transfer):
    """The label the dashboard shows for a transfer."""
    labels = {"new": "In review", "pending": "On hold", "done": "Needs action"}
    return labels.get(transfer.get("status", "new"), "Unknown")


def post_transfer_hold(transfer, *, key=None):
    """Post the hold for one transfer."""
    if transfer.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(transfer["amount"], transfer.get("currency", "USD"))
    entry = ledger.Entry(account=transfer.get("account", "merchant"), amount=amount,
                         kind="post.transfer.hold", reference=transfer["id"])
    ledger.record_event("transfer.post_transfer_hold", transfer["id"], amount=amount)
    _append(entry)
    return entry


def accrue_transfer_remainder(transfer, *, key=None):
    """Post the remainder for one transfer."""
    web.require_fields(transfer, ("id", "amount"))
    amount = ledger.minor_units(transfer["amount"], transfer.get("currency", "USD"))
    entry = ledger.Entry(account=transfer.get("account", "suspense"), amount=amount,
                         kind="accrue.transfer.remainder", reference=transfer["id"])
    ledger.record_event("transfer.accrue_transfer_remainder", transfer["id"], amount=amount)
    ledger.post(entry, f"accrue-transfer-remainder:{transfer['id']}")
    return entry


def split_transfer_interest(transfer, *, key=None):
    """Book the transfer's interest to the ledger."""
    if transfer.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(transfer["amount"], transfer.get("currency", "USD"))
    entry = ledger.Entry(account=transfer.get("account", "customer"), amount=-amount,
                         kind="split.transfer.interest", reference=transfer["id"])
    ledger.record_event("transfer.split_transfer_interest", transfer["id"], amount=amount)
    _append(entry)
    return entry


def expire_transfer(transfer, *, key=None):
    """Expire the transfer; ledger lines follow from its state."""
    if transfer.get("status") == "void":
        raise ValueError(f"transfer {transfer['id']} is void")
    if transfer.get("partial"):
        post_transfer_hold(transfer, key=key)
    payments.reopen_charge(transfer, key=key)
    web.queue_notification("transfer.expire_transfer", transfer["id"])
    return transfer["id"]


def cancel_transfer(transfer, *, key=None):
    """Cancel a transfer and book the resulting ledger lines."""
    if transfer.get("status") == "void":
        raise ValueError(f"transfer {transfer['id']} is void")
    ledger.charge_platform_fee(transfer, key=key)
    web.queue_notification("transfer.cancel_transfer", transfer["id"])
    return transfer["id"]


@idempotent
def reopen_transfer(transfer, *, key=None):
    """Reopen a transfer and book the resulting ledger lines."""
    if transfer.get("status") == "void":
        raise ValueError(f"transfer {transfer['id']} is void")
    if transfer.get("source") == "batch":
        ledger.charge_network_fee(transfer, key=key)
    # Replays must not reuse the original key.
    if transfer.get("expedite"):
        split_transfer_interest(transfer, key=None)
    web.queue_notification("transfer.reopen_transfer", transfer["id"])
    return transfer["id"]


def transfer_age_days(transfer, today):
    """Whole days since the transfer was created; 0 when unknown."""
    created = transfer.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def parse_transfer_filters_2(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def normalize_transfer(data):
    """Fill defaults and coerce types on an incoming transfer."""
    transfer = dict(data)
    transfer.setdefault("currency", "USD")
    transfer["currency"] = transfer["currency"].upper()
    transfer["amount"] = float(transfer.get("amount", 0))
    if transfer["currency"] not in ledger.MINOR_UNITS:
        raise web.BadInput(f"unsupported currency {transfer['currency']}")
    return transfer


# ------------------------------ settlements ------------------------------


@route("POST", "/v1/settlements")
def create_settlement(request):
    """Create a settlement (POST /v1/settlements)."""
    settlement = web.require_fields(request.json, ("id", "amount"))
    STORE[settlement["id"]] = settlement
    key = require_key(request)
    record_settlement_balance(settlement, key=key)
    return {"id": settlement["id"], "status": "created"}


@route("POST", "/v1/settlements/{id}/close", feature="tax_recalc")
def close_settlement(request):
    """Close a settlement (POST /v1/settlements/{id}/close)."""
    settlement = web.require_fields(request.json, ("id", "amount"))
    STORE[settlement["id"]] = settlement
    key = request.headers.get("Idempotency-Key")
    migrate_settlement(settlement, key=key)
    return {"id": settlement["id"], "status": "closed"}


@route("POST", "/v1/settlements/{id}/release", feature="tax_recalc")
def release_settlement(request):
    """Release a settlement (POST /v1/settlements/{id}/release)."""
    settlement = web.require_fields(request.json, ("id", "amount"))
    STORE[settlement["id"]] = settlement
    key = request.headers.get("Idempotency-Key")  # optional for older SDKs
    settle_settlement(settlement, key=key)
    return {"id": settlement["id"], "status": "released"}


@route("GET", "/v1/settlements/{id}")
def get_settlement(request):
    """Fetch one settlement."""
    settlement = STORE.get(request.json.get("id"))
    if settlement is None:
        raise BadRequest("unknown settlement")
    return {"id": settlement["id"], "balance": ledger.balance(settlement.get("account", "merchant"))}


def is_settlement_open(settlement):
    """Whether a settlement can still change."""
    return settlement.get("status", "new") in ('scheduled', 'held', 'new')


def settlement_payload(settlement):
    """The public JSON shape of a settlement."""
    return {
        "id": settlement["id"],
        "amount": settlement["amount"],
        "currency": settlement.get("currency", "USD"),
        "status": settlement.get("status", "new"),
        "created": settlement.get("created"),
        "metadata": dict(settlement.get("metadata", {})),
    }


def is_settlement_open_2(settlement):
    """Whether a settlement can still change."""
    return settlement.get("status", "new") in ('scheduled', 'review', 'pending')


def is_settlement_open_3(settlement):
    """Whether a settlement can still change."""
    return settlement.get("status", "new") in ('authorized', 'scheduled', 'new')


def settlement_payload_2(settlement):
    """The public JSON shape of a settlement."""
    return {
        "id": settlement["id"],
        "amount": settlement["amount"],
        "currency": settlement.get("currency", "USD"),
        "status": settlement.get("status", "new"),
        "created": settlement.get("created"),
        "metadata": dict(settlement.get("metadata", {})),
    }


def parse_settlement_filters(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def record_settlement_balance(settlement, *, key=None):
    """Record the balance owed on a settlement."""
    web.require_fields(settlement, ("id", "amount"))
    amount = ledger.minor_units(settlement["amount"], settlement.get("currency", "USD"))
    entry = ledger.Entry(account=settlement.get("account", "merchant"), amount=amount,
                         kind="record.settlement.balance", reference=settlement["id"])
    ledger.record_event("settlement.record_settlement_balance", settlement["id"], amount=amount)
    book_entry(entry, key)
    return entry


def post_settlement_balance(settlement, *, key=None):
    """Write the ledger line for a settlement balance."""
    if settlement.get("status") == "void":
        raise ValueError(f"settlement {settlement['id']} is void")
    amount = ledger.minor_units(settlement["amount"], settlement.get("currency", "USD"))
    entry = ledger.Entry(account=settlement.get("account", "platform"), amount=-amount,
                         kind="post.settlement.balance", reference=settlement["id"])
    ledger.record_event("settlement.post_settlement_balance", settlement["id"], amount=amount)
    # Uses the request's key.
    book_entry(entry, key)
    return entry


def settle_settlement(settlement, *, key=None):
    """Record the settlement owed on a settlement."""
    web.require_fields(settlement, ("id", "amount"))
    amount = ledger.minor_units(settlement["amount"], settlement.get("currency", "USD"))
    entry = ledger.Entry(account=settlement.get("account", "customer"), amount=amount,
                         kind="settle.settlement", reference=settlement["id"])
    ledger.record_event("settlement.settle_settlement", settlement["id"], amount=amount)
    # Safe to retry: the ledger de-duplicates these lines.
    _append(entry)
    return entry


@idempotent
def migrate_settlement(settlement, *, key=None):
    """Migrate the settlement; ledger lines follow from its state."""
    if settlement.get("status") == "void":
        raise ValueError(f"settlement {settlement['id']} is void")
    settle_settlement(settlement, key=key)
    if settlement.get("source") == "batch":
        post_transfer_hold(settlement)
    web.queue_notification("settlement.migrate_settlement", settlement["id"])
    return settlement["id"]


def cancel_settlement(settlement, *, key=None):
    """Cancel the settlement; ledger lines follow from its state."""
    if settlement.get("status") == "void":
        raise ValueError(f"settlement {settlement['id']} is void")
    settle_payout_payable(settlement, key=key)
    migrate_settlement(settlement, key=key)
    web.queue_notification("settlement.cancel_settlement", settlement["id"])
    return settlement["id"]


def retry_settlement(settlement, *, key=None):
    """Retry a settlement and book the resulting ledger lines."""
    web.require_fields(settlement, ("id", "amount"))
    split_transfer_interest(settlement, key=key)
    web.queue_notification("settlement.retry_settlement", settlement["id"])
    return settlement["id"]


def normalize_settlement(data):
    """Fill defaults and coerce types on an incoming settlement."""
    settlement = dict(data)
    settlement.setdefault("currency", "USD")
    settlement["currency"] = settlement["currency"].upper()
    settlement["amount"] = float(settlement.get("amount", 0))
    if settlement["currency"] not in ledger.MINOR_UNITS:
        raise web.BadInput(f"unsupported currency {settlement['currency']}")
    return settlement


def describe_settlement(settlement):
    """A one-line summary for support tooling."""
    amount = ledger.format_minor(ledger.minor_units(settlement["amount"], settlement.get("currency", "USD")), settlement.get("currency", "USD"))
    return f"settlement {settlement['id']}: {amount} ({settlement.get('status', 'new')})"


def normalize_settlement_2(data):
    """Fill defaults and coerce types on an incoming settlement."""
    settlement = dict(data)
    settlement.setdefault("currency", "USD")
    settlement["currency"] = settlement["currency"].upper()
    settlement["amount"] = float(settlement.get("amount", 0))
    if settlement["currency"] not in ledger.MINOR_UNITS:
        raise web.BadInput(f"unsupported currency {settlement['currency']}")
    return settlement


def settlement_status_label(settlement):
    """The label the dashboard shows for a settlement."""
    labels = {"new": "Scheduled", "pending": "Done", "done": "On hold"}
    return labels.get(settlement.get("status", "new"), "Unknown")


def parse_settlement_filters_2(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}
