from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Room:
    room_id: str
    site: str
    name: str


@dataclass
class Booking:
    booking_id: int
    room_id: str
    site: str
    who: str
    requested: str
    start_utc: datetime
    end_utc: datetime
    status: str = "active"
