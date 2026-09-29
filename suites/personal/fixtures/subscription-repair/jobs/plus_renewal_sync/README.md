# plus-renewal-sync

Closes out Quillmart Plus subscriptions that can no longer renew, so members are not left with a
plan they are not paying for.

A subscription is cancelled when either:

- dunning is exhausted: it is `past_due` and the last `DUNNING_MAX_FAILURES` (3) renewal charges
  failed (`reason = 'dunning_exhausted'`), or
- it lapsed: its paid period ended more than `GRACE_DAYS` (3) days ago and it never renewed
  (`reason = 'lapsed'`).

For each cancellation the job:

- cancels the subscription at Payrift (`provider_subscription_id`), so it is never charged again;
- sets `status = 'cancelled'`, `auto_renew = false`, `cancelled_at` and `cancel_reason`, and brings
  `current_period_end` forward to the cancellation time (access ends now);
- writes a `subscription_events` row with `actor = 'plus-renewal-sync'`, whose `metadata.previous`
  keeps the status, `auto_renew` and `current_period_end` the subscription had before;
- queues a `plus_cancelled` email in `email_outbox`.

Runs every 20 minutes from Cloud Scheduler; each run handles at most `BATCH_SIZE` subscriptions.
