def audit(manifest):
    required = set(manifest["groups"])
    present = set(manifest["models"])
    return {"missing": sorted(required - present), "unexpected": sorted(present - required), "mismatched": []}
