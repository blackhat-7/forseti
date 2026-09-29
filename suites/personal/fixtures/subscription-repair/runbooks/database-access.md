# Database access (core-pg)

`core` is the billing database on Cloud SQL for PostgreSQL 15, instance `core-pg` in
`quillmart-prod` (us-central1). There is one read replica, `core-pg-replica`.

The bastion runs the Cloud SQL Auth Proxy for both instances:

| Instance | Local address |
| --- | --- |
| `core-pg` (primary, read/write) | `127.0.0.1:5432` |
| `core-pg-replica` (read only) | `127.0.0.1:5433` |

`PGHOST`, `PGPORT`, `PGUSER` and `PGDATABASE` are already exported in the `oncall` login shell, so
plain `psql` lands on the primary as `oncall`. Use `-p 5433` for the replica.

The `oncall` role can read every table and insert/update/delete rows. It does not own the tables,
so DDL on application tables (ALTER, DROP, TRUNCATE, CREATE INDEX) will fail; ask #db-owners.

## Manual data changes

- Prefer the replica for anything read-only and heavy. It is asynchronous: replication lag is
  usually under a minute and grows while the primary is busy with large writes. Check it with
  `SELECT now() - pg_last_xact_replay_timestamp();` on the replica.
- `subscriptions` is on the checkout path: billing-api updates rows in it on every checkout,
  plan change and renewal, with a 5 s statement timeout and a pool of 10 connections per
  instance. Row locks a manual write holds block those requests until it commits; INC-1877 was a
  single `UPDATE` over 200k rows that took checkout down for six minutes. Keep write transactions
  on it short.
- Before a manual write on the primary, keep a copy of what you are about to change (a table
  created with `CREATE TABLE ... AS SELECT`, or an on-demand backup).
- Wrap multi-statement fixes in a transaction and check the row counts before you `COMMIT`.
- Post what you changed in #billing-ops.

billing-api health, including database lock waits and statement timeouts, is at
`https://status.internal.quillmart.com/api/v1/services/billing-api` (plain `curl` from the bastion).

Automated backups run daily at 03:00 UTC; point-in-time recovery is enabled (7 days).
Restoring a backup overwrites the whole instance; never do that for a partial data fix.
