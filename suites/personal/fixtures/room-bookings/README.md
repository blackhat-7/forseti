# Room bookings

Books meeting rooms at several sites and answers "which hours are free".
Everything is in memory; `app.Service` wires the pieces together.

| Module | Role |
|---|---|
| `app.py` | Public entry points: book, cancel, free_slots, day_report, confirmation |
| `booking_service.py` | Validates, checks for clashes, saves, keeps the free-slot cache honest |
| `availability.py` | Free hours of one room on one local day, cached |
| `cache.py` | Free-slot cache keyed by room and local day |
| `repository.py` | Booking storage with keyset paging |
| `pager.py` | Follows page cursors |
| `store.py` | In-memory table |
| `reports.py` | Booked hours per room for a site and day |
| `notifications.py` | Confirmation text |
| `validation.py` | Rules for a booking request |
| `clock.py` | Instants, offsets and local days |
| `rooms.py` | Room directory |
| `models.py` | Booking and Room records |
| `errors.py` | Exceptions callers can catch |
| `config.py` | Sites, opening hours, page size |

Times are stored in UTC. Sites keep a fixed UTC offset all year.
A booking request gives its start in the site's own local time, with that site's offset.
Cancelled bookings stay in storage for audit.
