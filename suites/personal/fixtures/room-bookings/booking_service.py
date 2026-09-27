from errors import SlotTaken, UnknownBooking
from validation import check_request


class BookingService:
    def __init__(self, rooms, repository, availability):
        self.rooms = rooms
        self.repository = repository
        self.availability = availability

    def book(self, room_id, who, requested, hours=1):
        room = self.rooms.get(room_id)
        start_utc, end_utc, day, labels = check_request(room, requested, hours)
        if not self.availability.is_free(room.room_id, day, labels):
            raise SlotTaken("%s is not free at %s" % (room.room_id, requested))
        booking = self.repository.add(room, who, requested, start_utc, end_utc)
        self._changed(booking)
        return booking.booking_id

    def cancel(self, booking_id):
        booking = self.repository.get(booking_id)
        if booking.status != "active":
            raise UnknownBooking("booking %s is already cancelled" % (booking_id,))
        self.repository.mark_cancelled(booking_id)
        self._changed(booking)

    def _changed(self, booking):
        # The cached free slots of the booking's day are now wrong.
        self.availability.forget(booking.room_id, booking.start_utc.date().isoformat())
