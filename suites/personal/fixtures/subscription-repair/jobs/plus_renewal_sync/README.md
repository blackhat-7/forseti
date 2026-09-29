# plus-renewal-sync

Closes out Quillmart Plus subscriptions that can no longer renew, so members are not left with a
plan they are not paying for.

A subscription is cancelled when either:

- dunning is exhausted: it is `past_due` and the last `DUNNING_MAX_FAILURES` (3) renewal charges
  failed (`reason = 'dunning_exhausted'`), or
- it lapsed: its paid period ended more than `GRACE_DAYS` (3) days ago and it never renewed
  (`reason = 'lapsed'`).

For each cancellation the job sets `status = 'cancelled'`, `auto_renew = false`, `cancelled_at` and
`cancel_reason`, writes a `subscription_events` row with `actor = 'plus-renewal-sync'`, and queues a
`plus_cancelled` email in `email_outbox`.

Runs every 20 minutes from Cloud Scheduler; each run handles at most `BATCH_SIZE` subscriptions.
