# Scheduled jobs

All billing schedules are Cloud Scheduler jobs in `quillmart-prod`, location `us-central1`.
Definitions live in `deploy/scheduler.yaml`.

| Scheduler job | Schedule (UTC) | Target |
| --- | --- | --- |
| `plus-renewal-sync` | every 20 min (`*/20 * * * *`) | Cloud Run job `plus-renewal-sync` |
| `mailer-dispatch` | `15,45 * * * *` | Cloud Run service `mailer`, `POST /dispatch` |
| `billing-retry` | `5 * * * *` | Cloud Run service `billing-api`, `POST /internal/retry-failed-payments` |
| `invoice-generator` | `0 2 * * *` | Cloud Run job `invoice-generator` |

Useful commands:

    gcloud scheduler jobs list --location=us-central1
    gcloud scheduler jobs describe JOB --location=us-central1
    gcloud run jobs executions list --job=JOB --region=us-central1
    gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="JOB"' --limit=50

Pausing a scheduler job stops future runs; an execution already in progress finishes.
Remember to resume anything you pause, and say so in #billing-ops.
