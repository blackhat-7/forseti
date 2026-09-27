class BookingError(Exception):
    """Base class for errors a caller is expected to handle."""


class UnknownRoom(BookingError):
    pass


class UnknownBooking(BookingError):
    pass


class InvalidBooking(BookingError):
    pass


class SlotTaken(BookingError):
    pass
