"""plus-renewal-sync: close out Plus subscriptions that can no longer renew.

Runs every 20 minutes as a Cloud Run job, triggered by Cloud Scheduler.
"""
import json
import logging
import time
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import namedtuple_row
from psycopg.types.json import Jsonb

import payrift
from config import settings

VERSION = "1.14.0"
log = logging.getLogger("plus-renewal-sync")

CANDIDATES = """
    SELECT id, account_id, status, auto_renew, payment_failures, current_period_end,
           provider_subscription_id
    FROM subscriptions
    WHERE auto_renew
      AND status IN ('active', 'past_due')
      AND (payment_failures >= %(max_failures)s OR current_period_end < %(lapse_cutoff)s)
    ORDER BY current_period_end, id
    LIMIT %(batch_size)s
"""

# Access ends with the cancellation: the paid-through date is brought forward to now.
CANCEL = """
    UPDATE subscriptions
    SET status = 'cancelled', auto_renew = false, cancelled_at = %(now)s,
        cancel_reason = %(reason)s, current_period_end = LEAST(current_period_end, %(now)s),
        updated_at = %(now)s
    WHERE id = %(id)s
"""

EVENT = """
    INSERT INTO subscription_events (subscription_id, actor, from_status, to_status, reason, metadata, created_at)
    VALUES (%(id)s, 'plus-renewal-sync', %(from_status)s, 'cancelled', %(reason)s, %(metadata)s, %(now)s)
"""

EMAIL = """
    INSERT INTO email_outbox (account_id, subscription_id, kind, status, payload, created_at)
    VALUES (%(account_id)s, %(id)s, 'plus_cancelled', 'pending', %(payload)s, %(now)s)
"""


def run(conn, now=None):
    now = now or datetime.now(timezone.utc)
    # A subscription lapsed when its paid period ended more than GRACE_DAYS ago.
    lapse_cutoff = now + timedelta(days=settings.grace_days)
    started = time.monotonic()
    log.info(
        "Starting plus-renewal-sync %s batch_size=%d grace_days=%d max_failures=%d",
        VERSION, settings.batch_size, settings.grace_days, settings.max_failures,
    )
    client = payrift.Client(settings.payrift_api_key)
    with conn.transaction():
        cur = conn.cursor(row_factory=namedtuple_row)
        rows = cur.execute(CANDIDATES, {
            "max_failures": settings.max_failures,
            "lapse_cutoff": lapse_cutoff,
            "batch_size": settings.batch_size,
        }).fetchall()
        log.info("Selected %d candidate subscriptions", len(rows))
        counts = {"dunning_exhausted": 0, "lapsed": 0}
        for sub in rows:
            reason = "dunning_exhausted" if sub.payment_failures >= settings.max_failures else "lapsed"
            params = {"id": sub.id, "account_id": sub.account_id, "from_status": sub.status,
                      "reason": reason, "now": now,
                      "metadata": Jsonb({"previous": {
                          "status": sub.status,
                          "auto_renew": sub.auto_renew,
                          "current_period_end": sub.current_period_end.isoformat(),
                      }}),
                      "payload": json.dumps({"template": "plus_cancelled_v3", "reason": reason})}
            # Payrift is the system of record for billing; cancel there first so nothing renews.
            client.cancel_subscription(sub.provider_subscription_id, reason=reason)
            cur.execute(CANCEL, params)
            cur.execute(EVENT, params)
            cur.execute(EMAIL, params)
            counts[reason] += 1
    log.info("Cancelled %d subscriptions (dunning_exhausted=%d, lapsed=%d)",
             len(rows), counts["dunning_exhausted"], counts["lapsed"])
    log.info("Queued %d plus_cancelled emails", len(rows))
    log.info("Finished in %.1fs", time.monotonic() - started)


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    with psycopg.connect(settings.database_url) as conn:
        run(conn)


if __name__ == "__main__":
    main()
