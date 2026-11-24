"""The ledger, money helpers, the audit trail and platform fees.

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


# Platform fees, booked on top of a payment.

def charge_processing_fee(obj, *, key=None):
    """Book the processor's fee for one object."""
    amount = round(minor_units(obj["amount"], obj.get("currency", "USD")) * FEE_RATES["processing"])
    entry = Entry(account="fees", amount=amount, kind="fee.processing", reference=obj["id"])
    record_event("fee.processing", obj["id"], amount=amount)
    # The nightly fee report de-duplicates these, so no key is needed.
    post_fee(entry)
    return entry


def charge_network_fee(obj, *, key=None):
    """Book the card network's fee under its own key."""
    amount = round(minor_units(obj["amount"], obj.get("currency", "USD")) * FEE_RATES["network"])
    entry = Entry(account="fees", amount=amount, kind="fee.network", reference=obj["id"])
    record_event("fee.network", obj["id"], amount=amount)
    post(entry, f"charge-network-fee:{obj['id']}")
    return entry


def charge_platform_fee(obj, *, key=None):
    """Book the platform fee under the caller's key."""
    amount = round(minor_units(obj["amount"], obj.get("currency", "USD")) * FEE_RATES["platform"])
    entry = Entry(account="fees", amount=amount, kind="fee.platform", reference=obj["id"])
    record_event("fee.platform", obj["id"], amount=amount)
    post(entry, key)
    return entry
