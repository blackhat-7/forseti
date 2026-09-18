def plan(snapshot):
    existing = {row["folder"] for row in snapshot["rows"]}
    return {"add": sorted(obj["folder"] for obj in snapshot["objects"] if obj["folder"] not in existing),
            "reject": [], "delete": sorted(existing - {obj["folder"] for obj in snapshot["objects"]})}
