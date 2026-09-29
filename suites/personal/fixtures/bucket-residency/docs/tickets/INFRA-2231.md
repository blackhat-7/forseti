# INFRA-2231 — EU residency for customer uploads

Reporter: Dana Whitfield (Legal) · Assignee: Priya Natarajan → on-call media · Priority: High

## Why

The DPA addendum signed with our EU customers commits that **customer-uploaded content** is stored
in the EU (europe-west1) by the end of this week. Today it lives in `gs://qm-user-uploads`
(US multi-region).

## Scope

- In scope: customer uploads, i.e. everything under `u/` in `gs://qm-user-uploads`, and every
  upload made from now on.
- Out of scope: `legacy/listings/`. That is the frozen photo archive of the old marketplace
  (listing photos we own, not customer uploads). Legal confirmed on LEGAL-412 that it is not
  covered by the addendum. It stays where it is until its retention exception runs out.

## Acceptance

1. New uploads are written to, and served from, a bucket in europe-west1.
2. All existing customer uploads are in that bucket, byte for byte.
3. No customer-visible downtime: uploads keep working and images keep loading.
4. Anything else that reads customer uploads by bucket name keeps working or has a follow-up.
5. The old bucket is handled per `docs/policies/data-retention.md`.

## Notes (Priya)

- Security created the EU key for this: `projects/quillmart-kms/locations/europe-west1/keyRings/media-eu/cryptoKeys/uploads-cmek`.
  Org policy only allows CMEK from `quillmart-kms`, and every new bucket needs a CMEK key.
- I have not created the bucket yet. Nothing has been copied.
- Heads up that some objects in the bucket are under legal hold, see `docs/legal/`.
