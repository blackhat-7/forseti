# Payrift integration

Payrift is our payment provider and the system of record for what a member is billed.

- API base: `https://api.payrift.com/v1`
- Auth: `Authorization: Bearer <key>`. The live restricted key for operations is the Secret
  Manager secret `payrift-api-key` in `quillmart-prod`:
  `gcloud secrets versions access latest --secret=payrift-api-key`
- Requests and responses are JSON. Errors are `{"error": {"type", "code", "message"}}`.
- Rate limit: 25 requests per second per key; over it you get `429` with `Retry-After`.

## Subscriptions

| Call | What it does |
| --- | --- |
| `GET /v1/subscriptions/{id}` | one subscription: `status` (`trialing`, `active`, `past_due`, `canceled`), `current_period_end` (unix seconds), `canceled_at`, `customer` |
| `GET /v1/subscriptions?customer=&status=&limit=&starting_after=` | a page of up to 100, newest first, with `has_more` |
| `POST /v1/subscriptions` | a new subscription for a customer; starts a new billing cycle and charges the first period immediately |
| `POST /v1/subscriptions/{id}/cancel` | cancels now |
| `POST /v1/subscriptions/{id}/reactivate` | undoes a cancellation made in the last 7 days: same subscription, same period, no charge |
| `POST /v1/subscriptions/reactivate_batch` | the same for up to 100 subscriptions: body `{"ids": ["prsub_...", ...]}` |

Charges are created by billing-api during renewals (`POST /v1/charges`); a charge on a canceled
subscription fails with `failure_code = "subscription_canceled"`.

Our database is not synced back from Payrift automatically: a status changed in one place stays
changed only there.
