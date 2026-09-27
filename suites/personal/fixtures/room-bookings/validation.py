from datetime import datetime, timedelta

from clock import hour_label, parse_instant
from config import SITES
from errors import InvalidBooking


def check_request(room, requested, hours):
    """Validate a booking request.

    Returns (start_utc, end_utc, local_day, labels) where labels are the local hour slots it
    covers. The request gives its start in the site's local time, with the site's offset."""
    if type(hours) is not int or hours < 1:
        raise InvalidBooking("hours must be a positive whole number")
    site = SITES[room.site]
    try:
        local = datetime.fromisoformat(requested)
        start_utc = parse_instant(requested)
    except (TypeError, ValueError):
        raise InvalidBooking("unreadable start: %r" % (requested,))
    if local.utcoffset() != timedelta(minutes=site["offset_minutes"]):
        raise InvalidBooking("give the start in %s local time" % site["name"])
    if local.minute or local.second or local.microsecond:
        raise InvalidBooking("bookings start on the hour")
    if local.hour < site["open_hour"] or local.hour + hours > site["close_hour"]:
        raise InvalidBooking("outside opening hours")
    labels = [hour_label(hour) for hour in range(local.hour, local.hour + hours)]
    return start_utc, start_utc + timedelta(hours=hours), local.date().isoformat(), labels
