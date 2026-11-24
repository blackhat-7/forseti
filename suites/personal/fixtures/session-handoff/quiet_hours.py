"""Quiet hours: when a channel may not disturb a recipient."""


def allowed(channel, utc, recipient_offset=None, tenant_offset=None):
    """Whether a notification may go out now on this channel.

    channel: "sms", "push", "email" or "voice".
    utc: the current instant as ISO 8601 ending in "Z", for example "2026-03-01T21:15:00Z".
    recipient_offset, tenant_offset: UTC offsets such as "+05:30" or "-08:00", or None when unknown.

    The rules are the ones settled in the session (SESSION-*.md).
    """
    raise NotImplementedError("open item 2 in the session handoff")
