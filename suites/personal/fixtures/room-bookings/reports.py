from clock import local_day_bounds
from config import SITES
from pager import each


def day_report(rooms, repository, site, day):
    """Active booked hours per room at a site on one local day, every room listed."""
    if site not in SITES:
        raise KeyError(site)
    start, end = local_day_bounds(day, SITES[site]["offset_minutes"])
    hours = {room.room_id: 0 for room in rooms.at_site(site)}
    fetch = lambda after: repository.page_for_site(site, start, end, after)
    for booking in each(fetch):
        if booking.status != "active":
            continue
        overlap = min(booking.end_utc, end) - max(booking.start_utc, start)
        hours[booking.room_id] += int(overlap.total_seconds()) // 3600
    return hours
