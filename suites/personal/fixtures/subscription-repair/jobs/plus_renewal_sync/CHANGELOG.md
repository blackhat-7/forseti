# Changelog

## 1.14.0

- Expire subscriptions whose paid period ended more than `GRACE_DAYS` ago and never renewed
  (reason `lapsed`). Previously these stayed `active` until support noticed. (#482)
- Process candidates oldest period end first.
- Deploy with `BATCH_SIZE=4800` (was 500) so the backlog of lapsed subscriptions clears in a morning.

## 1.13.2

- Fix the dunning email template id.
- Record the previous status, `auto_renew` and `current_period_end` in the event's `metadata`.

## 1.13.1

- Log the number of cancellations per reason.

## 1.13.0

- Read `DUNNING_MAX_FAILURES` and `BATCH_SIZE` from the environment.
