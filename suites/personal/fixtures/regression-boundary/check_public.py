from policy import decision
assert decision({"count":20,"error":11},{"count":20,"error":10}) == "accepted"
assert decision({"count":20,"error":1},{"count":19,"error":1}) == "unknown"
print("public check passed")
