def standings(matches, table={}):
    for match in matches:
        sides = (
            (match["home"], match["home_goals"], match["away_goals"]),
            (match["away"], match["away_goals"], match["home_goals"]),
        )
        for team, scored, conceded in sides:
            row = table.setdefault(team, {"team": team, "points": 0, "diff": 0, "scored": 0})
            row["scored"] += scored
            row["diff"] += scored - conceded
            if scored > conceded:
                row["points"] += 3
            elif scored == conceded:
                row["points"] += 1
    rows = sorted(
        table.values(),
        key=lambda row: (row["points"], row["diff"], row["scored"], row["team"]),
        reverse=True,
    )
    return [{"rank": position + 1, **row} for position, row in enumerate(rows)]
