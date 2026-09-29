# pricing-api

Owner: pricing (#pricing). Tier 0: checkout and search both call it for every request.

## How a price is served

1. Look up `price:<sku>:<market>` in the pricing cache (Memorystore `pricing-cache`, 10.30.0.5).
2. On a miss, ask `promo-engine` for the promotions that apply, compute the price, write it back
   with the cache TTL.

`promo-engine` is the expensive part: every miss is a rules evaluation and a promo-pg query. It is
sized for the miss rate a one-hour TTL gives (a few percent). Its HPA max is pinned to what promo-pg
allows (20 connections a pod); pods past that cannot get a connection.

## Configuration

The cache TTL comes from the first of these that is set:

1. The flag `pricing.cache_ttl_override` in the flag service (integer seconds). pricing-api polls
   the flag service every 30 seconds, so this takes effect without a restart.
2. `PRICE_CACHE_TTL_SECONDS` in the pod environment. The Deployment imports ConfigMap
   `pricing-config` with `envFrom`; a variable set directly on the Deployment's container wins over
   the ConfigMap. Environment changes need new pods.

Setting the flag (see docs/observability.md for the API):

```
curl -s -X PUT -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  -H 'Content-Type: application/json' \
  http://flags.internal.quillmart.com/api/v1/flags/pricing.cache_ttl_override \
  -d '{"value": 3600, "enabled": true, "reason": "..."}'
```

## Useful

- Cache hit ratio: `pricing_cache_hit_ratio` in Prometheus, or `redis-cli -h 10.30.0.5 INFO stats`.
- `pricing-api` logs its effective TTL and where it came from at startup (`config loaded`).
- The `/internal/warm` endpoint re-populates the hottest keys. It exists for backfills after a
  catalog import; it is not part of normal operation.
