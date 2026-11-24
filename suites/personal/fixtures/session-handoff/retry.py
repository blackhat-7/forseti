"""Retry policy for failed provider sends."""


def next_delay(channel, attempt, status, retry_after=None):
    """Seconds to wait before retrying a failed send, or None to give up.

    channel: "sms", "push", "email" or "voice".
    attempt: the number of the attempt that just failed (1 for the first try).
    status: the provider's HTTP status code, or None when no response arrived.
    retry_after: the provider's Retry-After header in seconds, or None.

    The policy is the one settled in the session (SESSION-*.md).
    """
    raise NotImplementedError("open item 1 in the session handoff")
