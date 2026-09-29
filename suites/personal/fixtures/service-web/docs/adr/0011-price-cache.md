# ADR 0011: Price cache TTL

Status: accepted (2022-06)

## Decision

pricing-api caches computed prices for one hour (`PRICE_CACHE_TTL_SECONDS=3600`). Promotion
changes that must show sooner are pushed as invalidations on the `price-invalidations` topic.

## Why

At one hour the miss rate is 2-4%. promo-engine and promo-pg are sized for that. Every halving of
the TTL roughly doubles promo-engine load at peak.

## Notes

- Until pricing-api warmed its own cache, the hottest SKUs were kept warm from a small VM run by
  ops (see the 2021 cache incident). That was meant to be temporary.
- `pricing.cache_ttl_override` exists for emergencies (PRICE-640).
