# Backfill safety rules

- **R1** Only keys in `TARGET_KEYS` may be read or written in `marketplace_profiles`.
- **R2** Every `marketplace_profiles` update must be guarded by the exact expected old value.
- **R3** Every `marketplace_profiles` update must match exactly one row.
- **R4** A backup must store the row's payload as it was before the update.
- **R5** If the backup fails, the mutation must not happen.
- **R6** A dry run must leave the database byte-for-byte unchanged.
