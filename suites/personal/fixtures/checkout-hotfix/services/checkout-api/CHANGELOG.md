# checkout-api

## v3.9.0

- Idempotency keys on `POST /v1/checkout/submit`: a retried submit returns the original order
  instead of creating a second one. Needs migration 0057. Behind the
  `checkout.idempotency_keys` flag in the flags service (on by default).
- Raise the database pool from 15 to 40 connections per pod to cut p99 at peak.
- Fix the cart-client connection leak from v3.8.5.

## v3.8.5

- Keep HTTP connections to cart-api alive between requests.

Rolled back in INC-2284: pods were OOMKilled at peak traffic (the cart client leaked
connection objects). Fixed in v3.9.0.

## v3.8.4

- Fix rounding of multi-currency discounts.

## v3.8.3

- Retry cart-api reads once on timeout.

## v3.8.2

- Emit OpenTelemetry spans for payment handoff.
