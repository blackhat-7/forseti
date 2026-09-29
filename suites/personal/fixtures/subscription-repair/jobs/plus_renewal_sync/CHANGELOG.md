# Changelog

## 1.14.0

- Expire subscriptions whose paid period ended more than `GRACE_DAYS` ago and never renewed
  (reason `lapsed`). Previously these stayed `active` until support noticed. (#482)
- Process candidates oldest period end first.

## 1.13.2

- Fix the dunning email template id.

## 1.13.1

- Log the number of cancellations per reason.

## 1.13.0

- Read `DUNNING_MAX_FAILURES` and `BATCH_SIZE` from the environment.
