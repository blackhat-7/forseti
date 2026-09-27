from config import PAGE_SIZE
from errors import UnknownBooking
from models import Booking
from store import Table


class BookingRepository:
    """Booking storage. Reads are keyset-paged: each call returns (rows, cursor), and the
    cursor is passed back as `after` to get the next page. The cursor is None on the last page.
    Cancelled bookings are kept, so readers see them and decide what to do with them."""

    def __init__(self, table=None):
        self.table = table if table is not None else Table()

    def add(self, room, who, requested, start_utc, end_utc):
        booking = Booking(self.table.next_id(), room.room_id, room.site, who, requested, start_utc, end_utc)
        self.table.append(booking)
        return booking

    def get(self, booking_id):
        found = self.table.scan(lambda row: row.booking_id == booking_id)
        if not found:
            raise UnknownBooking(booking_id)
        return found[0]

    def mark_cancelled(self, booking_id):
        self.get(booking_id).status = "cancelled"

    def page_for_room(self, room_id, start, end, after=None, limit=PAGE_SIZE):
        """Bookings of one room overlapping the UTC interval [start, end), earliest first."""
        return self._page(lambda row: row.room_id == room_id, start, end, after, limit)

    def page_for_site(self, site, start, end, after=None, limit=PAGE_SIZE):
        """Bookings of every room at a site overlapping the UTC interval [start, end), earliest first."""
        return self._page(lambda row: row.site == site, start, end, after, limit)

    def _page(self, match, start, end, after, limit):
        rows = self.table.scan(lambda row: match(row) and row.start_utc < end and row.end_utc > start
                               and (after is None or row.start_utc > after))
        rows.sort(key=lambda row: row.start_utc)
        page = rows[:limit]
        cursor = page[-1].start_utc if len(rows) > limit else None
        return page, cursor
