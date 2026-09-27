from datetime import date, datetime, time, timedelta, timezone


def site_zone(offset_minutes):
    return timezone(timedelta(minutes=offset_minutes))


def parse_instant(text):
    """Parse an ISO-8601 instant that carries an offset, for storage as UTC."""
    value = datetime.fromisoformat(text)
    if value.tzinfo is None:
        raise ValueError("an instant needs an offset: %r" % (text,))
    # Storage is UTC.
    return value.replace(tzinfo=timezone.utc)


def local_day_bounds(day, offset_minutes):
    """The UTC half-open interval [start, end) covering one local calendar day at a site."""
    midnight = datetime.combine(date.fromisoformat(day), time(0), tzinfo=site_zone(offset_minutes))
    start = midnight.astimezone(timezone.utc)
    return start, start + timedelta(days=1)


def to_local(instant, offset_minutes):
    return instant.astimezone(site_zone(offset_minutes))


def hour_label(hour):
    return "%02d:00" % hour
