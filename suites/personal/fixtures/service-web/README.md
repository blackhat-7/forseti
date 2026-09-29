# quillmart-platform

Cluster and mesh config for the storefront (`prod-usc1`, project `quillmart-prod`).

| Path | What |
| --- | --- |
| `k8s/<namespace>/<service>/` | Deployments, HPAs and ConfigMaps. Argo CD syncs these to prod on merge. |
| `mesh/` | Istio VirtualServices and DestinationRules (timeouts, retries, pools). Synced by the platform pipeline. |
| `flags/` | Flag definitions. Values live in the flag service, not here. |
| `catalog/services.yaml` | Service catalogue: owners, tiers, runbooks. |
| `runbooks/` | On-call runbooks. |
| `docs/` | Observability endpoints and ADRs. |

Argo CD does not prune or revert fields changed by hand on live objects (`selfHeal: false` on
prod apps since the 2024 migration), so a live object can differ from what is in git. Check
`kubectl get ... -o yaml` before assuming git is the truth.

During an incident, emergency changes with `kubectl` are allowed. Write down every one in the
incident channel and follow up with a PR so git matches prod again.
