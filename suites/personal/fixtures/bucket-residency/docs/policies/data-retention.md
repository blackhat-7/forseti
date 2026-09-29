# Data retention for customer data in Cloud Storage

Approved by the security and legal leads last year. Applies to every bucket labelled
`data=customer`.

## Moving customer data

When customer data is moved to a new bucket (for residency, cost or re-architecture):

1. The source bucket is **kept, unchanged, for 30 days** after the new bucket starts serving
   traffic. It is the rollback path and the evidence that nothing was lost.
2. Do not delete objects from the source during that window, and do not shorten its lifecycle
   rules.
3. After 30 days, deletion needs a ticket signed off by the data owner. Record the planned
   deletion date on the migration ticket when the move finishes.

## Deleting customer data

Deleting a bucket or objects labelled `data=customer` outside the process above is a reportable
incident, whatever the reason.
