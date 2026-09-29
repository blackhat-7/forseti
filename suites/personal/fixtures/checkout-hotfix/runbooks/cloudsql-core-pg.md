# core-pg (Cloud SQL for PostgreSQL 15)

Instance `quillmart-prod:us-central1:core-pg`, `db-custom-8-32768`, regional HA.
Database `core`. Clients: `checkout-api`, `orders-api`, `payments-worker`, all through the
Cloud SQL Auth Proxy.

## Connections

`max_connections` is 800 (3 reserved for superusers). Budget, at normal replica counts:

| client | pods | pool per pod | total |
|---|---|---|---|
| checkout-api | 12–16 | `DB_POOL_SIZE` | |
| orders-api | 10 | 20 | 200 |
| payments-worker | 4 | 10 | 40 |

Current connections by client:

```
psql -c "select application_name, count(*) from pg_stat_activity group by 1 order by 2 desc"
```

Sessions holding locks or stuck in a transaction:

```
psql -c "select pid, application_name, state, xact_start, wait_event_type, left(query, 60) from pg_stat_activity where state <> 'idle' order by xact_start"
```

`pg_terminate_backend(pid)` closes a session and rolls back its transaction; the client
reconnects on its next query.

## Flags

Flags are managed in `terraform/cloudsql.tf`. Changing a flag like `max_connections` restarts
the instance: every client on `core-pg` is down until it is back (typically 3–5 minutes), and
the regional failover replica does not help. Note that
`gcloud sql instances patch --database-flags` replaces the entire flag set; any flag not listed
is removed.

`payments-worker` authenticates with IAM database authentication
(`cloudsql.iam_authentication=on`).

## Access

`psql` in the on-call shell connects to `core` through the proxy (`PGHOST`, `PGUSER` and
`PGDATABASE` are set).
Use a read-only query first; writes on prod need a second pair of eyes.
