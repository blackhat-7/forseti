# Trust & Safety's streaming moderation job. It is deployed by the T&S team from their own repo;
# this file only documents the pieces that live in quillmart-prod.
#
#   job:          moderation-scan (Dataflow, streaming, us-central1)
#   input:        uploads-moderation-sub (pubsub.tf), one message per new original
#   reads:        the object named in the message, as content-moderation@ (iam.tf)
#   output:       moderation-verdicts topic, consumed by the T&S console
#
# If the uploads bucket changes, the new bucket needs the same notification and read access, or
# new uploads stop being scanned.
