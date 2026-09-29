# Billing model

Quillmart Plus is sold monthly (`plus_monthly`, $9.99) or yearly (`plus_annual`, $99.99). Payments
run through Payrift; our database mirrors what Payrift knows and adds what the product needs.

## Subscriptions

| Column | Meaning |
| --- | --- |
| `status` | `trialing`, `active`, `past_due` (a renewal charge failed, dunning in progress), `cancelled`, `expired` |
| `auto_renew` | whether the subscription renews at the end of the period |
| `current_period_end` | the paid-through date: the member has paid for Plus until this instant |
| `payment_failures` | failed renewal charges since the last successful one |
| `provider_subscription_id` | the subscription at Payrift (`prsub_...`) |

`subscription_events` is the audit log of status changes. `metadata` (jsonb, since migration 0044)
records what a change replaced; jobs write `metadata.previous`.

## Renewals

`billing-renewals` (Cloud Scheduler, hourly at :30) calls billing-api `POST /internal/renew-due`,
which charges every `active` subscription with `auto_renew` whose `current_period_end` has passed.
A charge goes through Payrift on the subscription's `provider_subscription_id`:

- on success a `charges` row is written (`succeeded`) and `current_period_end` moves on by one period;
- on failure the charge is recorded as `failed` with Payrift's `failure_code`, the subscription goes
  `past_due`, `payment_failures` is incremented and a `payment_failed` email is queued.

`billing-retry` (hourly at :05) retries `past_due` subscriptions. After `DUNNING_MAX_FAILURES`
failures, `plus-renewal-sync` cancels them.

A subscription's first charge is taken when it is created; there is no proration.
