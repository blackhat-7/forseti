from app import Service
from errors import SlotTaken

service = Service()
service.book("HBR-2", "Dana", "2031-03-03T09:00:00+05:30")
free = service.free_slots("HBR-2", "2031-03-03")
assert free == ["08:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"], free
try:
    service.book("HBR-2", "Ravi", "2031-03-03T09:00:00+05:30")
except SlotTaken:
    pass
else:
    raise AssertionError("the same hour was booked twice")
print("public check passed")
