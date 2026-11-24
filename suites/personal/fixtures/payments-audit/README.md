# Payments service

The service books every money movement to an append-only ledger (`ledger.py`). HTTP requests
arrive through `web.dispatch`, which runs the handler registered for the request's method and path.

## Layout

- `app.py` imports the area modules (`payments.py`, `billing.py`, `treasury.py`, `balances.py`,
  `corrections.py`). Importing a module runs its `@route` decorators, which register its handlers in
  `web.ROUTES`. A module that nothing imports registers nothing.
- Each area module holds the route handlers for its domains and the business logic they call.
- `web.py` holds requests, routing, the feature flags, idempotency-key helpers and input validation.
- `ledger.py` writes ledger rows and holds the money helpers, the audit trail and platform fees.
- `jobs.py` holds cron jobs. A handler registered with `feature=` exists only while its flag is on in
  `web.FEATURES`.

## Conventions

- Handlers pass the request's idempotency key down as the keyword argument `key`.
- Amounts on the ledger are integers in minor units (`ledger.minor_units`).
- The design notes below describe the design and what is planned.

# Design notes

*Last reviewed for v3. Some sections predate the v4 handlers.*

## Ledger writes

Since v3 every ledger write goes through `ledger.post` with the request's idempotency key.
`ledger.post_fee` and bare `ledger.append` calls were removed in the v3 cleanup, so a retried
request can never book a row twice.

Every handler calls `require_key`, so a request without an `Idempotency-Key` header is rejected
before it reaches the business logic.

## The `idempotent` decorator

`@idempotent` gives a function a key when its caller passes none, and protects the rows that
function writes with that key.

## Fees

Fees are booked by the fee functions in `ledger.py`. The nightly fee report de-duplicates fee
rows, so fee rows need no idempotency key.

## Jobs

`jobs.py` runs from cron in its own process. Jobs call the area modules' business logic.

## Roadmap

- Q3: enable the deposits API (`deposits.py` is written but not imported yet).
- Instant payouts behind the `instant_payouts` flag.

Planned or waiting on a flag (do not document these as live):

- `POST /v2/refunds/bulk`
- `POST /v1/wallets/{id}/merge`
- `POST /v1/invoices/{id}/finance`
- `GET /v1/deposits/{id}`
- `POST /v1/adjustments`
