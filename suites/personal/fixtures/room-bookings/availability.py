from datetime import timedelta

from clock import hour_label, local_day_bounds
from config import SITES
from pager import each


class Availability:
    def __init__(self, rooms, repository, cache):
        self.rooms = rooms
        self.repository = repository
        self.cache = cache

    def free_slots(self, room_id, day):
        """Start labels ("HH:00") of the free one-hour slots of a room on a local day."""
        room = self.rooms.get(room_id)
        cached = self.cache.get(room.room_id, day)
        if cached is not None:
            return cached
        slots = self._compute(room, day)
        self.cache.put(room.room_id, day, slots)
        return slots

    def is_free(self, room_id, day, labels):
        free = set(self.free_slots(room_id, day))
        return all(label in free for label in labels)

    def forget(self, room_id, day):
        self.cache.forget(room_id, day)

    def _compute(self, room, day):
        site = SITES[room.site]
        start, end = local_day_bounds(day, site["offset_minutes"])
        fetch = lambda after: self.repository.page_for_room(room.room_id, start, end, after)
        busy = [booking for booking in each(fetch) if booking.status == "active"]
        free = []
        for hour in range(site["open_hour"], site["close_hour"]):
            slot_start = start + timedelta(hours=hour)
            slot_end = slot_start + timedelta(hours=1)
            if not any(b.start_utc < slot_end and b.end_utc > slot_start for b in busy):
                free.append(hour_label(hour))
        return free
