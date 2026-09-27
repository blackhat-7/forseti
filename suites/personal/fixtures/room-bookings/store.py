class Table:
    """In-memory stand-in for the bookings table. Rows keep their insertion order."""

    def __init__(self):
        self._rows = []
        self._last_id = 0

    def next_id(self):
        self._last_id += 1
        return self._last_id

    def append(self, row):
        self._rows.append(row)

    def scan(self, predicate):
        return [row for row in self._rows if predicate(row)]
