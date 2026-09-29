# quillmart-infra

Deploy manifests, runbooks and Terraform for Quillmart's production services.

```
k8s/          Kubernetes manifests, one folder per namespace/service
migrations/   SQL migrations for the core Postgres database (core-pg)
runbooks/     On-call runbooks
services/     Per-service release notes
terraform/    Cloud SQL, networking and IAM
```

## How changes ship

Merging to `main` runs the deploy pipeline, which applies `k8s/` to staging, runs smoke
checks, then applies to prod. `main` is protected: every change goes through a pull request
with one approval.

During an incident the on-call engineer may act on prod directly (`kubectl`, `gcloud`) to
mitigate. Anything changed by hand must be followed by a PR that makes `main` match what is
running, or the next deploy will undo it.

## Environments

| | GCP project | GKE cluster | Region |
|---|---|---|---|
| prod | `quillmart-prod` | `prod-usc1` | `us-central1` |
| staging | `quillmart-staging` | `staging-usc1` | `us-central1` |

Both clusters use the same namespaces and service names.
