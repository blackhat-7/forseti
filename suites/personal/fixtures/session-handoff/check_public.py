from quiet_hours import allowed
from retry import next_delay
from templates import resolve

assert next_delay("email", 1, 404) is None
assert allowed("email", "2026-03-01T23:00:00Z") is True
assert resolve("receipt", "de-DE", ["en", "de-DE"]) == "de-DE"
assert resolve("receipt", "de-AT", ["en", "de"]) == "de"
print("public check passed")
