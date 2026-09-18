from artifacts import audit
m={"groups":{"pair":["hue","saturation"],"tone":["brightness"]},"settings":{"hue":0.0,"saturation":"learned","brightness":0},"models":{"pair":["saturation"]}}
assert audit(m) == {"missing":[],"unexpected":[],"mismatched":[]}
print("public check passed")
