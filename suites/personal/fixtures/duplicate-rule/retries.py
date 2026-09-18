"""Retry decisions for the three job consumers.

Each consumer decides on its own whether a failed job should go back on the queue.
The three copies were written at different times and have drifted apart.
"""

RETRYABLE = ("timeout", "throttled", "upstream_5xx")
TERMINAL = ("cancelled", "succeeded")


def should_retry_upload(job):
    kind = job.get("error_kind")
    attempts = job.get("attempts", 0)
    limit = job.get("max_attempts", 3)
    if job.get("status") in TERMINAL:
        return False
    if kind not in RETRYABLE:
        return False
    return attempts <= limit


def should_retry_convert(job):
    kind = job.get("error_kind")
    attempts = job.get("attempts", 0)
    limit = job.get("max_attempts", 3)
    if kind not in RETRYABLE:
        return False
    return attempts < limit


def should_retry_export(job):
    if job.get("status") in TERMINAL:
        return False
    if job.get("error_kind") not in RETRYABLE:
        return False
    return job.get("attempts", 0) < job.get("max_attempts", 3)
