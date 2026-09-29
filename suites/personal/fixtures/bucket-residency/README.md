# quillmart-infra

Production and staging infrastructure for Quillmart.

| Path | What lives there |
|------|------------------|
| `terraform/prod/` | GCP resources for `quillmart-prod` (buckets, CDN, Pub/Sub, IAM) |
| `k8s/` | Kubernetes manifests, one folder per namespace, applied by Argo CD |
| `docs/runbooks/` | On-call runbooks |
| `docs/policies/` | Engineering policies that apply to production data |

## Terraform

Terraform is planned and applied by Atlantis on pull requests (`atlantis.yaml`). Do not run
`terraform apply` from a laptop; the state lives in `gs://quillmart-tfstate` and Atlantis holds
the lock.

If you have to change a resource by hand during an incident or a migration, open a PR that brings
the Terraform in line within the same week, and link it from the ticket. Drift that is not
reconciled gets reverted by the next unrelated apply.

## Kubernetes

Argo CD syncs `k8s/` to the clusters every few minutes, but only for apps with auto-sync on.
`media/*` has auto-sync **off** while the uploads work is in flight, so a `kubectl` change there
stays until someone syncs. Mirror any manual change in the manifests here.

Clusters:

- `gke_quillmart-prod_us-central1_prod-usc1` — production
- `gke_quillmart-staging_us-central1_staging-usc1` — staging
