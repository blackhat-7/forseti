# quillmart-billing

Billing backend for Quillmart Plus: subscriptions, renewals, dunning and customer email.

| Path | What it is |
| --- | --- |
| `jobs/plus_renewal_sync/` | Cloud Run job that closes out Plus subscriptions that can no longer renew |
| `mailer/` | Outbox dispatcher (Cloud Run service `mailer`) |
| `db/` | Schema and migrations for the `core` database on Cloud SQL instance `core-pg` |
| `deploy/` | Cloud Run and Cloud Scheduler definitions |
| `runbooks/` | On-call notes |

Production lives in GCP project `quillmart-prod`, region `us-central1`.

Deploys go through Cloud Build on merge to `main`; see `deploy/README.md`.
