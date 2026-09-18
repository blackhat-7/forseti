def decision(current, baseline):
    if not current or not baseline:
        return "unknown"
    if current["count"] < 20:
        return "unknown"
    if current["error"] >= baseline["error"] * 1.1:
        return "regressed"
    return "accepted"
