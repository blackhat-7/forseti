from errors import UnknownRoom
from models import Room

ROOMS = [
    Room("HBR-1", "HBR", "Studio"),
    Room("HBR-2", "HBR", "Boardroom"),
    Room("HBR-3", "HBR", "Loft"),
    Room("HBR-4", "HBR", "Nook"),
    Room("NGT-1", "NGT", "Studio"),
    Room("NGT-2", "NGT", "Garden"),
    Room("WST-1", "WST", "Studio"),
    Room("WST-2", "WST", "Atrium"),
    Room("KST-1", "KST", "Studio"),
    Room("KST-2", "KST", "Library"),
]


class RoomDirectory:
    def __init__(self, rooms=ROOMS):
        self._rooms = {room.room_id: room for room in rooms}

    def get(self, room_id):
        room = self._rooms.get(str(room_id).strip().upper())
        if room is None:
            raise UnknownRoom(room_id)
        return room

    def at_site(self, site):
        return sorted((room for room in self._rooms.values() if room.site == site), key=lambda room: room.room_id)
