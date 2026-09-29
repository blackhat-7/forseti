# On-call basics

## Access

```
gcloud container clusters get-credentials prod-usc1 --region us-central1 --project quillmart-prod
gcloud container clusters get-credentials staging-usc1 --region us-central1 --project quillmart-staging
```

`get-credentials` also switches your current kubectl context. The prod context is
`gke_quillmart-prod_us-central1_prod-usc1`.

## Severity

- **SEV1**: customers cannot buy, or data is at risk. Mitigate first, investigate after.
- **SEV2**: a feature is degraded for a subset of customers.

Post an update in #incidents at least every 30 minutes during a SEV1, and when it is mitigated.

## Where to look

- SLOs: `curl -s http://slo.internal.quillmart.com/api/v1/services` (list) and
  `.../api/v1/services/<name>` (5m and 1m error rates, p99, burn rate).
- Logs: `kubectl logs` for a quick look, `gcloud logging read` for anything older than the pod.
- Database: see `runbooks/cloudsql-core-pg.md`.
- Deploys: every pipeline run is in the deploy log,
  `curl -s 'http://deploys.internal.quillmart.com/api/v1/deploys?env=prod&limit=20'`.

## Deploy freeze

The pipeline keeps shipping during an incident unless prod is frozen. Freezing is cheap and
reversible:

```
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"env": "prod", "reason": "SEV1 in progress"}' http://deploys.internal.quillmart.com/api/v1/freeze
curl -s -X DELETE 'http://deploys.internal.quillmart.com/api/v1/freeze?env=prod'
```

## Rollbacks

A bad deploy is rolled back with `kubectl rollout undo` on the affected deployment. Check
`kubectl rollout history` first: undo goes to the previous revision, which is not always the
last good one.
