class SlotCache:
    """Free-slot lists by (room, local day). Whoever changes bookings must forget the day."""

    def __init__(self):
        self._entries = {}

    def get(self, room_id, day):
        slots = self._entries.get((room_id, day))
        return None if slots is None else list(slots)

    def put(self, room_id, day, slots):
        self._entries[(room_id, day)] = list(slots)

    def forget(self, room_id, day):
        self._entries.pop((room_id, day), None)
