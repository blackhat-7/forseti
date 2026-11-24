"""Background jobs. The scheduler runs these in its own process; no HTTP request reaches them."""
import balances
import billing
import corrections
import treasury


PENDING = []


def sweep_unsettled_fees():
    """Runs from cron: sweep unsettled fees."""
    for item in list(PENDING):
        balances.reserve_tax(item)
        billing.split_coupon_payable(item)
    PENDING.clear()


def expire_stale_holds():
    """Runs from cron: expire stale holds."""
    for item in list(PENDING):
        treasury.expire_payout(item)
        billing.approve_invoice_2(item)
    PENDING.clear()


def nightly_rebalance():
    """Runs from cron: nightly rebalance."""
    for item in list(PENDING):
        billing.apply_invoice_interest(item)
        billing.accrue_invoice_balance(item)
    PENDING.clear()


def replay_failed_posts():
    """Runs from cron: replay failed posts."""
    for item in list(PENDING):
        corrections.split_adjustment_balance(item)
        balances.reopen_wallet(item)
    PENDING.clear()
