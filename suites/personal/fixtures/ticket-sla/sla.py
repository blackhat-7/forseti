from datetime import datetime


def parse(stamp):
    return datetime.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S")


def breaches(tickets, limit_hours, now):
    late = []
    for ticket in tickets:
        took = parse(ticket["resolved"] or now) - parse(ticket["opened"])
        if took.seconds / 3600 > limit_hours:
            late.append(ticket["id"])
    return late
