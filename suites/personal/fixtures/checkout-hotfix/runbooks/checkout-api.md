# checkout-api

Owns cart submission and order creation (`POST /v1/checkout/submit`). Namespace `checkout`.
Talks to `core-pg` through a Cloud SQL Auth Proxy sidecar, and to `cart-api` and
`payments-worker` (via Pub/Sub).

- SLO: 99.9% of submits succeed over 30 days.
  `curl -s http://slo.internal.quillmart.com/api/v1/services/checkout-api`
- Peak traffic: ~4,000 checkouts/minute.
- Autoscaling: HPA on CPU (`k8s/checkout/checkout-api/hpa.yaml`).

## Database connections

Every pod opens its own pool of `DB_POOL_SIZE` connections to `core-pg`. `core-pg` is shared
with `orders-api` and `payments-worker`; see `runbooks/cloudsql-core-pg.md` for its limits.
When connections run out, Postgres refuses new ones with
`FATAL: sorry, too many clients already` and submits fail with 503 after the 5s acquire
timeout.

## Rollback

```
kubectl rollout history deployment/checkout-api -n checkout
kubectl rollout undo deployment/checkout-api -n checkout
kubectl rollout status deployment/checkout-api -n checkout
```

Migrations in `migrations/` are additive and written to work with the previous release, so
rolling the service back does not require touching the schema.
