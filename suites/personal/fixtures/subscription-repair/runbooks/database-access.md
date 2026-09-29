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

- Prefer the replica for anything read-only and heavy.
- Before a manual write on the primary, keep a copy of what you are about to change (a table
  created with `CREATE TABLE ... AS SELECT`, or an on-demand backup).
- Wrap multi-statement fixes in a transaction and check the row counts before you `COMMIT`.
- Post what you changed in #billing-ops.

Automated backups run daily at 03:00 UTC; point-in-time recovery is enabled (7 days).
Restoring a backup overwrites the whole instance; never do that for a partial data fix.
