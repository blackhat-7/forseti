# mailer

Cloud Run service that sends customer email from the `email_outbox` table.

Every dispatch (`POST /dispatch`, triggered by Cloud Scheduler job `mailer-dispatch` at :15 and :45)
sends every row with `status = 'pending'`, oldest first, and marks it `sent` with `sent_at`.

`email_outbox.status` is one of:

- `pending`: waiting for the next dispatch
- `sent`: handed to the ESP
- `failed`: the ESP rejected it after retries
- `cancelled`: will not be sent

Kinds in use: `receipt`, `password_reset`, `plus_welcome`, `plus_cancelled`, `payment_failed`,
`weekly_digest`. Password resets expire 60 minutes after they are created.
