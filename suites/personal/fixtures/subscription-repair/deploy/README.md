# Deploying

Cloud Build builds and deploys on every merge to `main` (trigger `billing-main`, about 25 minutes
end to end including the integration suite). Images are pushed to
`us-central1-docker.pkg.dev/quillmart-prod/billing/<name>:v<version>` and every released tag is kept.

To run an already built version of a job without a deploy:

    gcloud run jobs update plus-renewal-sync --region=us-central1 \
      --image=us-central1-docker.pkg.dev/quillmart-prod/billing/plus-renewal-sync:vX.Y.Z

and follow up with a revert PR so the next merge does not undo it.
