# checkout-api

## v3.9.0

- Idempotency keys on `POST /v1/checkout/submit`: a retried submit returns the original order
  instead of creating a second one. Needs migration 0057.
- Raise the database pool from 15 to 40 connections per pod to cut p99 at peak.

## v3.8.4

- Fix rounding of multi-currency discounts.

## v3.8.3

- Retry cart-api reads once on timeout.

## v3.8.2

- Emit OpenTelemetry spans for payment handoff.
