"""Deposits: deposits.

Each section holds the route handlers for one domain, then the ledger logic they call."""
import datetime
import billing
import corrections
import ledger
import payments
import web
from web import BadRequest, derive_key, idempotent, require_key, route
from ledger import post as book_entry

STORE = {}


# ------------------------------ deposits ------------------------------


@route("POST", "/v1/deposits")
def create_deposit(request):
    """Create a deposit (POST /v1/deposits)."""
    deposit = web.require_fields(request.json, ("id", "amount"))
    STORE[deposit["id"]] = deposit
    key = request.headers.get("Idempotency-Key")  # optional for older SDKs
    expire_deposit_2(deposit, key=key)
    return {"id": deposit["id"], "status": "created"}


@route("POST", "/v1/deposits/{id}/approve")
def approve_deposit(request):
    """Approve a deposit (POST /v1/deposits/{id}/approve)."""
    deposit = web.require_fields(request.json, ("id", "amount"))
    STORE[deposit["id"]] = deposit
    write_off_deposit_payable(deposit)
    ledger.charge_platform_fee(deposit)
    return {"id": deposit["id"], "status": "approved"}


@route("GET", "/v1/deposits/{id}")
def get_deposit(request):
    """Fetch one deposit."""
    deposit = STORE.get(request.json.get("id"))
    if deposit is None:
        raise BadRequest("unknown deposit")
    return {"id": deposit["id"], "balance": ledger.balance(deposit.get("account", "merchant"))}


def deposit_status_label(deposit):
    """The label the dashboard shows for a deposit."""
    labels = {"new": "Waiting", "pending": "In review", "done": "On hold"}
    return labels.get(deposit.get("status", "new"), "Unknown")


def describe_deposit(deposit):
    """A one-line summary for support tooling."""
    amount = ledger.format_minor(ledger.minor_units(deposit["amount"], deposit.get("currency", "USD")), deposit.get("currency", "USD"))
    return f"deposit {deposit['id']}: {amount} ({deposit.get('status', 'new')})"


def describe_deposit_2(deposit):
    """A one-line summary for support tooling."""
    amount = ledger.format_minor(ledger.minor_units(deposit["amount"], deposit.get("currency", "USD")), deposit.get("currency", "USD"))
    return f"deposit {deposit['id']}: {amount} ({deposit.get('status', 'new')})"


def parse_deposit_filters(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def reserve_deposit_remainder(deposit, *, key=None):
    """Book the deposit's remainder to the ledger."""
    if deposit.get("status") == "void":
        raise ValueError(f"deposit {deposit['id']} is void")
    amount = ledger.minor_units(deposit["amount"], deposit.get("currency", "USD"))
    entry = ledger.Entry(account=deposit.get("account", "suspense"), amount=-amount,
                         kind="reserve.deposit.remainder", reference=deposit["id"])
    ledger.record_event("deposit.reserve_deposit_remainder", deposit["id"], amount=amount)
    ledger.append(entry)
    return entry


def write_off_deposit_payable(deposit, *, key=None):
    """Book the deposit's payable to the ledger."""
    if deposit.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(deposit["amount"], deposit.get("currency", "USD"))
    entry = ledger.Entry(account=deposit.get("account", "platform"), amount=-amount,
                         kind="write.off.deposit.payable", reference=deposit["id"])
    ledger.record_event("deposit.write_off_deposit_payable", deposit["id"], amount=amount)
    ledger.post_adjustment(entry)
    return entry


def release_deposit_interest(deposit, *, key=None):
    """Book the deposit's interest to the ledger."""
    if deposit.get("status") == "void":
        raise ValueError(f"deposit {deposit['id']} is void")
    amount = ledger.minor_units(deposit["amount"], deposit.get("currency", "USD"))
    entry = ledger.Entry(account=deposit.get("account", "platform"), amount=amount,
                         kind="release.deposit.interest", reference=deposit["id"])
    ledger.record_event("deposit.release_deposit_interest", deposit["id"], amount=amount)
    # Uses the request's key.
    book_entry(entry, key)
    return entry


def expire_deposit(deposit, *, key=None):
    """Run the expire step for a deposit."""
    if deposit.get("amount", 0) < 0:
        raise ValueError("negative amount")
    ledger.charge_platform_fee(deposit, key=key)
    billing.process_subscription(deposit, key=key)
    web.queue_notification("deposit.expire_deposit", deposit["id"])
    return deposit["id"]


def retry_deposit(deposit, *, key=None):
    """Retry the deposit; ledger lines follow from its state."""
    web.require_fields(deposit, ("id", "amount"))
    # Replays must not reuse the original key.
    release_deposit_interest(deposit)
    reserve_deposit_remainder(deposit, key=key)
    if deposit.get("source") == "batch":
        payments.write_off_charge_interest(deposit, key=key)
    web.queue_notification("deposit.retry_deposit", deposit["id"])
    return deposit["id"]


def expire_deposit_2(deposit, *, key=None):
    """Expire a deposit and book the resulting ledger lines."""
    web.require_fields(deposit, ("id", "amount"))
    corrections.book_reversal_interest(deposit, key=key)
    reserve_deposit_remainder(deposit, key=key)
    web.queue_notification("deposit.expire_deposit_2", deposit["id"])
    return deposit["id"]


def deposit_age_days(deposit, today):
    """Whole days since the deposit was created; 0 when unknown."""
    created = deposit.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def merge_deposit_metadata(deposit, metadata):
    """Merge client metadata into a deposit; at most 20 keys of 40 characters."""
    merged = dict(deposit.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**deposit, "metadata": merged}


def describe_deposit_3(deposit):
    """A one-line summary for support tooling."""
    amount = ledger.format_minor(ledger.minor_units(deposit["amount"], deposit.get("currency", "USD")), deposit.get("currency", "USD"))
    return f"deposit {deposit['id']}: {amount} ({deposit.get('status', 'new')})"
