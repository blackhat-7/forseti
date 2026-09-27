from availability import Availability
from booking_service import BookingService
from cache import SlotCache
from notifications import confirmation
from reports import day_report
from repository import BookingRepository
from rooms import RoomDirectory


class Service:
    """The public face of the booking service. Every call is what the web layer uses."""

    def __init__(self):
        self.rooms = RoomDirectory()
        self.repository = BookingRepository()
        self.availability = Availability(self.rooms, self.repository, SlotCache())
        self.bookings = BookingService(self.rooms, self.repository, self.availability)

    def book(self, room_id, who, requested, hours=1):
        """Book a room from a local start time for whole hours. Returns the booking id."""
        return self.bookings.book(room_id, who, requested, hours)

    def cancel(self, booking_id):
        self.bookings.cancel(booking_id)

    def free_slots(self, room_id, day):
        return self.availability.free_slots(room_id, day)

    def day_report(self, site, day):
        return day_report(self.rooms, self.repository, site, day)

    def confirmation(self, booking_id):
        booking = self.repository.get(booking_id)
        return confirmation(booking, self.rooms.get(booking.room_id))
