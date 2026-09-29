# ADR 0007: Retries belong in the mesh

Status: accepted (2024-03)

## Decision

Timeouts and retries between services are configured once, in the Istio VirtualService of the
callee. Services set their own client retries to 0.

## Why

Retries at more than one layer multiply. Three layers that each retry twice turn one slow request
at the bottom into 27. We have seen this take down promo-engine twice (INC-1893, INC-2015).

## Consequences

- VirtualService per callee with `timeout`, `retries.attempts`, `retries.perTryTimeout`.
- Client retry settings removed from service config as teams migrate. Tracking: PLAT-377.
- A route timeout shorter than a client's own timeout means the client sees a 504 from its
  sidecar before its own deadline.
