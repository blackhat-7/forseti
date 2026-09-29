# Storefront latency (checkout / search)

_Last reviewed: 2023-09-14_

Checkout and search both go through `web-bff`, which calls `checkout-api` and `search-api`. Both
of those get prices from `pricing-v1` (the pricing monolith in the `pricing` namespace).

## Symptoms

- `StorefrontLatencyHigh` / `CheckoutErrorBudgetBurn` pages.
- 504s from `web-bff` with `upstream request timeout`.

## Steps

1. Check the storefront dashboard in Grafana ("Storefront — golden signals").
2. If checkout-api CPU is high, scale it up: `kubectl -n checkout scale deploy/checkout-api --replicas=20`.
3. If prices look stale or pricing-v1 is slow, restart it and flush the price cache:
   ```
   kubectl -n pricing rollout restart deploy/pricing-v1
   redis-cli -h 10.30.0.5 FLUSHALL
   ```
4. If it is still bad after 15 minutes, page the checkout secondary.
