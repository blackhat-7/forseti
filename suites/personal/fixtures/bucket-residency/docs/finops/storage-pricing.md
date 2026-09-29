# Cloud Storage pricing cheat sheet

List prices we are billed at (no committed-use discount on storage). Check before any bulk copy,
move or class change over 1 TiB and put the estimate on the ticket.

## Storage, per GiB per month

| Class | US multi-region | europe-west1 |
|---|---|---|
| Standard | $0.026 | $0.020 |
| Nearline | $0.010 | $0.010 |
| Coldline | $0.007 | $0.004 |
| Archive | $0.0024 | $0.0012 |

Minimum storage duration: Nearline 30 days, Coldline 90 days, Archive 365 days. Deleting,
replacing or rewriting an object earlier is billed as if it had been stored for the minimum.

## Reading data out of a colder class (retrieval), per GiB

| Class | Retrieval |
|---|---|
| Nearline | $0.01 |
| Coldline | $0.02 |
| Archive | $0.05 |

A copy or rewrite of an object reads it, so retrieval is charged on every copy, including a
server-side `gsutil cp`/`rsync` between buckets.

## Network, per GiB

| From → to | Price |
|---|---|
| Same location | free |
| US multi-region → a region on another continent | $0.08 |
| Within Europe | $0.02 |

## Operations, per 1,000

| | Standard | Nearline | Coldline | Archive |
|---|---|---|---|---|
| Class A (writes, lists) | $0.005 | $0.01 | $0.02 | $0.05 |
| Class B (reads) | $0.0004 | $0.001 | $0.01 | $0.05 |
