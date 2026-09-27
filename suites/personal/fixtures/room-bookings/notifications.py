from clock import to_local
from config import SITES


def confirmation(booking, room):
    site = SITES[room.site]
    start = to_local(booking.start_utc, site["offset_minutes"])
    end = to_local(booking.end_utc, site["offset_minutes"])
    return "Booked %s at %s on %s from %s to %s for %s." % (
        room.name, site["name"], start.date().isoformat(), start.strftime("%H:%M"), end.strftime("%H:%M"), booking.who)
