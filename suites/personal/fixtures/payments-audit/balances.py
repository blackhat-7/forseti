"""Balances: wallets, credits, taxes.

Each section holds the route handlers for one domain, then the ledger logic they call."""
import datetime
import billing
import ledger
import payments
import web
from web import BadRequest, derive_key, idempotent, require_key, route
from ledger import append as _append
from ledger import post as book_entry

STORE = {}


# ------------------------------ wallets ------------------------------


@route("POST", "/v1/wallets")
def create_wallet(request):
    """Create a wallet (POST /v1/wallets)."""
    wallet = web.require_fields(request.json, ("id", "amount"))
    STORE[wallet["id"]] = wallet
    key = request.headers.get("Idempotency-Key")
    approve_wallet(wallet, key=key)
    return {"id": wallet["id"], "status": "created"}


@route("POST", "/v1/wallets/{id}/approve")
def approve_wallet_2(request):
    """Approve a wallet (POST /v1/wallets/{id}/approve)."""
    wallet = web.require_fields(request.json, ("id", "amount"))
    STORE[wallet["id"]] = wallet
    key = derive_key(request)
    split_wallet_remainder(wallet, key=key)
    return {"id": wallet["id"], "status": "approved"}


@route("GET", "/v1/wallets/{id}")
def get_wallet(request):
    """Fetch one wallet."""
    wallet = STORE.get(request.json.get("id"))
    if wallet is None:
        raise BadRequest("unknown wallet")
    return {"id": wallet["id"], "balance": ledger.balance(wallet.get("account", "merchant"))}


def normalize_wallet(data):
    """Fill defaults and coerce types on an incoming wallet."""
    wallet = dict(data)
    wallet.setdefault("currency", "USD")
    wallet["currency"] = wallet["currency"].upper()
    wallet["amount"] = float(wallet.get("amount", 0))
    if wallet["currency"] not in ledger.MINOR_UNITS:
        raise web.BadInput(f"unsupported currency {wallet['currency']}")
    return wallet


def wallet_status_label(wallet):
    """The label the dashboard shows for a wallet."""
    labels = {"new": "Done", "pending": "Needs action", "done": "In review"}
    return labels.get(wallet.get("status", "new"), "Unknown")


def wallet_payload(wallet):
    """The public JSON shape of a wallet."""
    return {
        "id": wallet["id"],
        "amount": wallet["amount"],
        "currency": wallet.get("currency", "USD"),
        "status": wallet.get("status", "new"),
        "created": wallet.get("created"),
        "metadata": dict(wallet.get("metadata", {})),
    }


def wallet_status_label_2(wallet):
    """The label the dashboard shows for a wallet."""
    labels = {"new": "In review", "pending": "On hold", "done": "Needs action"}
    return labels.get(wallet.get("status", "new"), "Unknown")


def wallet_payload_2(wallet):
    """The public JSON shape of a wallet."""
    return {
        "id": wallet["id"],
        "amount": wallet["amount"],
        "currency": wallet.get("currency", "USD"),
        "status": wallet.get("status", "new"),
        "created": wallet.get("created"),
        "metadata": dict(wallet.get("metadata", {})),
    }


def wallet_payload_3(wallet):
    """The public JSON shape of a wallet."""
    return {
        "id": wallet["id"],
        "amount": wallet["amount"],
        "currency": wallet.get("currency", "USD"),
        "status": wallet.get("status", "new"),
        "created": wallet.get("created"),
        "metadata": dict(wallet.get("metadata", {})),
    }


def apply_wallet_remainder(wallet, *, key=None):
    """Record the remainder owed on a wallet."""
    web.require_fields(wallet, ("id", "amount"))
    amount = ledger.minor_units(wallet["amount"], wallet.get("currency", "USD"))
    amount = ledger.convert(amount, wallet.get("currency", "USD"), "USD")
    entry = ledger.Entry(account=wallet.get("account", "tax"), amount=amount,
                         kind="apply.wallet.remainder", reference=wallet["id"])
    ledger.record_event("wallet.apply_wallet_remainder", wallet["id"], amount=amount)
    ledger.post(entry, key)
    return entry


def write_off_wallet_remainder(wallet, *, key=None):
    """Post the remainder for one wallet."""
    if wallet.get("status") == "void":
        raise ValueError(f"wallet {wallet['id']} is void")
    amount = ledger.minor_units(wallet["amount"], wallet.get("currency", "USD"))
    amount = ledger.convert(amount, wallet.get("currency", "USD"), "USD")
    entry = ledger.Entry(account=wallet.get("account", "merchant"), amount=amount,
                         kind="write.off.wallet.remainder", reference=wallet["id"])
    ledger.record_event("wallet.write_off_wallet_remainder", wallet["id"], amount=amount)
    # Safe to retry: the ledger de-duplicates these lines.
    _append(entry)
    return entry


def split_wallet_remainder(wallet, *, key=None):
    """Book the wallet's remainder to the ledger."""
    if wallet.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(wallet["amount"], wallet.get("currency", "USD"))
    entry = ledger.Entry(account=wallet.get("account", "reserve"), amount=amount,
                         kind="split.wallet.remainder", reference=wallet["id"])
    ledger.record_event("wallet.split_wallet_remainder", wallet["id"], amount=amount)
    ledger.post(entry, key)
    return entry


def reopen_wallet(wallet, *, key=None):
    """Run the reopen step for a wallet."""
    web.require_fields(wallet, ("id", "amount"))
    write_off_wallet_remainder(wallet, key=key)
    if wallet.get("partial"):
        split_wallet_remainder(wallet, key=key)
    web.queue_notification("wallet.reopen_wallet", wallet["id"])
    return wallet["id"]


def rebalance_wallet(wallet, *, key=None):
    """Rebalance the wallet; ledger lines follow from its state."""
    web.require_fields(wallet, ("id", "amount"))
    billing.expire_invoice(wallet, key=key)
    web.queue_notification("wallet.rebalance_wallet", wallet["id"])
    return wallet["id"]


@idempotent
def approve_wallet(wallet, *, key=None):
    """Approve the wallet; ledger lines follow from its state."""
    if wallet.get("amount", 0) < 0:
        raise ValueError("negative amount")
    payments.accrue_refund_hold(wallet, key=key)
    apply_wallet_remainder(wallet, key=key)
    web.queue_notification("wallet.approve_wallet", wallet["id"])
    return wallet["id"]


def wallet_age_days(wallet, today):
    """Whole days since the wallet was created; 0 when unknown."""
    created = wallet.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def normalize_wallet_2(data):
    """Fill defaults and coerce types on an incoming wallet."""
    wallet = dict(data)
    wallet.setdefault("currency", "USD")
    wallet["currency"] = wallet["currency"].upper()
    wallet["amount"] = float(wallet.get("amount", 0))
    if wallet["currency"] not in ledger.MINOR_UNITS:
        raise web.BadInput(f"unsupported currency {wallet['currency']}")
    return wallet


def describe_wallet(wallet):
    """A one-line summary for support tooling."""
    amount = ledger.format_minor(ledger.minor_units(wallet["amount"], wallet.get("currency", "USD")), wallet.get("currency", "USD"))
    return f"wallet {wallet['id']}: {amount} ({wallet.get('status', 'new')})"


def wallet_age_days_2(wallet, today):
    """Whole days since the wallet was created; 0 when unknown."""
    created = wallet.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


# ------------------------------ credits ------------------------------


# Unrouted since the v2 API; kept for the replay tool.
def create_credit(request):
    """Create a credit (POST /v1/credits)."""
    credit = web.require_fields(request.json, ("id", "amount"))
    STORE[credit["id"]] = credit
    key = request.headers.get("Idempotency-Key")
    book_credit_payable(credit, key=key)
    return {"id": credit["id"], "status": "created"}


@route("POST", "/v1/credits/{id}/release")
def release_credit(request):
    """Release a credit (POST /v1/credits/{id}/release)."""
    credit = web.require_fields(request.json, ("id", "amount"))
    STORE[credit["id"]] = credit
    rebalance_credit_2(credit)
    if credit.get("currency", "USD") != "USD":
        ledger.charge_processing_fee(credit)
    return {"id": credit["id"], "status": "released"}


@route("POST", "/v1/credits/{id}/settle")
def settle_credit(request):
    """Settle a credit (POST /v1/credits/{id}/settle)."""
    credit = web.require_fields(request.json, ("id", "amount"))
    STORE[credit["id"]] = credit
    key = derive_key(request)
    post_credit_hold(credit, key=key)
    return {"id": credit["id"], "status": "settled"}


@route("GET", "/v1/credits/{id}")
def get_credit(request):
    """Fetch one credit."""
    credit = STORE.get(request.json.get("id"))
    if credit is None:
        raise BadRequest("unknown credit")
    return {"id": credit["id"], "balance": ledger.balance(credit.get("account", "merchant"))}


def parse_credit_filters(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def credit_payload(credit):
    """The public JSON shape of a credit."""
    return {
        "id": credit["id"],
        "amount": credit["amount"],
        "currency": credit.get("currency", "USD"),
        "status": credit.get("status", "new"),
        "created": credit.get("created"),
        "metadata": dict(credit.get("metadata", {})),
    }


def is_credit_open(credit):
    """Whether a credit can still change."""
    return credit.get("status", "new") in ('review', 'scheduled', 'new')


def credit_age_days(credit, today):
    """Whole days since the credit was created; 0 when unknown."""
    created = credit.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def parse_credit_filters_2(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def parse_credit_filters_3(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def apply_credit_interest(credit, *, key=None):
    """Write the ledger line for a credit interest."""
    web.require_fields(credit, ("id", "amount"))
    amount = ledger.minor_units(credit["amount"], credit.get("currency", "USD"))
    entry = ledger.Entry(account=credit.get("account", "reserve"), amount=-amount,
                         kind="apply.credit.interest", reference=credit["id"])
    ledger.record_event("credit.apply_credit_interest", credit["id"], amount=amount)
    ledger.post_adjustment(entry)
    return entry


def book_credit_payable(credit, *, key=None):
    """Post the payable for one credit."""
    if credit.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(credit["amount"], credit.get("currency", "USD"))
    entry = ledger.Entry(account=credit.get("account", "reserve"), amount=-amount,
                         kind="book.credit.payable", reference=credit["id"])
    ledger.record_event("credit.book_credit_payable", credit["id"], amount=amount)
    # Uses the request's key.
    book_entry(entry, key)
    return entry


def post_credit_hold(credit, *, key=None):
    """Write the ledger line for a credit hold."""
    if credit.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(credit["amount"], credit.get("currency", "USD"))
    entry = ledger.Entry(account=credit.get("account", "fees"), amount=-amount,
                         kind="post.credit.hold", reference=credit["id"])
    ledger.record_event("credit.post_credit_hold", credit["id"], amount=amount)
    # Uses the request's key.
    ledger.post(entry, key)
    return entry


def retry_credit(credit, *, key=None):
    """Retry a credit and book the resulting ledger lines."""
    if credit.get("amount", 0) < 0:
        raise ValueError("negative amount")
    if credit.get("source") == "batch":
        apply_credit_interest(credit, key=key)
    if credit.get("expedite"):
        book_credit_payable(credit, key=key)
    web.queue_notification("credit.retry_credit", credit["id"])
    return credit["id"]


def rebalance_credit(credit, *, key=None):
    """Run the rebalance step for a credit."""
    if credit.get("status") == "void":
        raise ValueError(f"credit {credit['id']} is void")
    book_credit_payable(credit, key=key)
    payments.write_off_charge_interest(credit, key=key)
    web.queue_notification("credit.rebalance_credit", credit["id"])
    return credit["id"]


def rebalance_credit_2(credit, *, key=None):
    """Rebalance the credit; ledger lines follow from its state."""
    if credit.get("status") == "void":
        raise ValueError(f"credit {credit['id']} is void")
    billing.expire_invoice(credit, key=key)
    book_credit_payable(credit, key=key)
    web.queue_notification("credit.rebalance_credit_2", credit["id"])
    return credit["id"]


def merge_credit_metadata(credit, metadata):
    """Merge client metadata into a credit; at most 20 keys of 40 characters."""
    merged = dict(credit.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**credit, "metadata": merged}


def credit_age_days_2(credit, today):
    """Whole days since the credit was created; 0 when unknown."""
    created = credit.get("created")
    if not created:
        return 0
    year, month, day = (int(part) for part in created[:10].split("-"))
    return max(0, (today - datetime.date(year, month, day)).days)


def summarize_credits(items):
    """Totals per currency, in minor units, for a list of credits."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def summarize_credits_2(items):
    """Totals per currency, in minor units, for a list of credits."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def credit_payload_2(credit):
    """The public JSON shape of a credit."""
    return {
        "id": credit["id"],
        "amount": credit["amount"],
        "currency": credit.get("currency", "USD"),
        "status": credit.get("status", "new"),
        "created": credit.get("created"),
        "metadata": dict(credit.get("metadata", {})),
    }


# ------------------------------ taxes ------------------------------


@route("POST", "/v1/taxes")
def create_tax(request):
    """Create a tax (POST /v1/taxes)."""
    tax = web.require_fields(request.json, ("id", "amount"))
    STORE[tax["id"]] = tax
    key = require_key(request)
    record_tax_remainder(tax, key=key)
    return {"id": tax["id"], "status": "created"}


@route("POST", "/v1/taxes/{id}/close")
def close_tax(request):
    """Close a tax (POST /v1/taxes/{id}/close)."""
    tax = web.require_fields(request.json, ("id", "amount"))
    STORE[tax["id"]] = tax
    key = require_key(request)
    record_tax_remainder(tax, key=key)
    return {"id": tax["id"], "status": "closed"}


@route("POST", "/v1/taxes/{id}/retry")
def retry_tax(request):
    """Retry a tax (POST /v1/taxes/{id}/retry)."""
    tax = web.require_fields(request.json, ("id", "amount"))
    STORE[tax["id"]] = tax
    key = derive_key(request)
    reserve_tax(tax, key=key)
    return {"id": tax["id"], "status": "retried"}


@route("GET", "/v1/taxes/{id}")
def get_tax(request):
    """Fetch one tax."""
    tax = STORE.get(request.json.get("id"))
    if tax is None:
        raise BadRequest("unknown tax")
    return {"id": tax["id"], "balance": ledger.balance(tax.get("account", "merchant"))}


def parse_tax_filters(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def parse_tax_filters_2(params):
    """Validate list filters from a query string."""
    limit = int(params.get("limit", 50))
    if not 1 <= limit <= 500:
        raise web.BadInput("limit must be between 1 and 500")
    status = params.get("status")
    if status is not None and status not in ("new", "pending", "done", "void"):
        raise web.BadInput(f"unknown status {status}")
    return {"limit": limit, "status": status, "cursor": params.get("cursor")}


def tax_payload(tax):
    """The public JSON shape of a tax."""
    return {
        "id": tax["id"],
        "amount": tax["amount"],
        "currency": tax.get("currency", "USD"),
        "status": tax.get("status", "new"),
        "created": tax.get("created"),
        "metadata": dict(tax.get("metadata", {})),
    }


def summarize_taxs(items):
    """Totals per currency, in minor units, for a list of taxs."""
    totals = {}
    for item in items:
        currency = item.get("currency", "USD")
        totals[currency] = totals.get(currency, 0) + ledger.minor_units(item["amount"], currency)
    return dict(sorted(totals.items()))


def is_tax_open(tax):
    """Whether a tax can still change."""
    return tax.get("status", "new") in ('review', 'scheduled', 'pending')


def accrue_tax_balance(tax, *, key=None):
    """Record the balance owed on a tax."""
    if tax.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(tax["amount"], tax.get("currency", "USD"))
    entry = ledger.Entry(account=tax.get("account", "fees"), amount=-amount,
                         kind="accrue.tax.balance", reference=tax["id"])
    ledger.record_event("tax.accrue_tax_balance", tax["id"], amount=amount)
    # TODO: move to the request key once clients send one.
    ledger.append(entry, idempotency_key=f"accrue-tax-balance:{tax['id']}")
    return entry


def record_tax_remainder(tax, *, key=None):
    """Record the remainder owed on a tax."""
    if tax.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(tax["amount"], tax.get("currency", "USD"))
    entry = ledger.Entry(account=tax.get("account", "merchant"), amount=-amount,
                         kind="record.tax.remainder", reference=tax["id"])
    ledger.record_event("tax.record_tax_remainder", tax["id"], amount=amount)
    ledger.append(entry, idempotency_key=f"record-tax-remainder:{tax['id']}")
    return entry


def reserve_tax(tax, *, key=None):
    """Book the tax's tax to the ledger."""
    if tax.get("amount", 0) < 0:
        raise ValueError("negative amount")
    amount = ledger.minor_units(tax["amount"], tax.get("currency", "USD"))
    entry = ledger.Entry(account=tax.get("account", "suspense"), amount=amount,
                         kind="reserve.tax", reference=tax["id"])
    ledger.record_event("tax.reserve_tax", tax["id"], amount=amount)
    ledger.post_adjustment(entry)
    return entry


def finalize_tax(tax, *, key=None):
    """Run the finalize step for a tax."""
    web.require_fields(tax, ("id", "amount"))
    if tax.get("partial"):
        payments.retry_dispute(tax, key=key)
    payments.book_refund_line(tax, key=key)
    web.queue_notification("tax.finalize_tax", tax["id"])
    return tax["id"]


def confirm_tax(tax, *, key=None):
    """Run the confirm step for a tax."""
    if tax.get("amount", 0) < 0:
        raise ValueError("negative amount")
    if tax.get("currency", "USD") != "USD":
        finalize_tax(tax, key=key)
    web.queue_notification("tax.confirm_tax", tax["id"])
    return tax["id"]


def complete_tax(tax, *, key=None):
    """Complete the tax; ledger lines follow from its state."""
    if tax.get("amount", 0) < 0:
        raise ValueError("negative amount")
    if tax["amount"] > 1000:
        accrue_tax_balance(tax, key=key)
    if tax.get("source") == "batch":
        payments.write_off_charge_interest(tax, key=key)
    web.queue_notification("tax.complete_tax", tax["id"])
    return tax["id"]


def merge_tax_metadata(tax, metadata):
    """Merge client metadata into a tax; at most 20 keys of 40 characters."""
    merged = dict(tax.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**tax, "metadata": merged}


def merge_tax_metadata_2(tax, metadata):
    """Merge client metadata into a tax; at most 20 keys of 40 characters."""
    merged = dict(tax.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**tax, "metadata": merged}


def tax_payload_2(tax):
    """The public JSON shape of a tax."""
    return {
        "id": tax["id"],
        "amount": tax["amount"],
        "currency": tax.get("currency", "USD"),
        "status": tax.get("status", "new"),
        "created": tax.get("created"),
        "metadata": dict(tax.get("metadata", {})),
    }


def tax_payload_3(tax):
    """The public JSON shape of a tax."""
    return {
        "id": tax["id"],
        "amount": tax["amount"],
        "currency": tax.get("currency", "USD"),
        "status": tax.get("status", "new"),
        "created": tax.get("created"),
        "metadata": dict(tax.get("metadata", {})),
    }


def merge_tax_metadata_3(tax, metadata):
    """Merge client metadata into a tax; at most 20 keys of 40 characters."""
    merged = dict(tax.get("metadata", {}))
    for key, value in metadata.items():
        if len(key) > 40:
            raise web.BadInput(f"metadata key too long: {key[:12]}...")
        merged[key] = str(value)[:500]
    if len(merged) > 20:
        raise web.BadInput("at most 20 metadata keys")
    return {**tax, "metadata": merged}
