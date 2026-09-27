from table import standings

north = [
    {"home": "Harbor", "away": "Millbrook", "home_goals": 2, "away_goals": 0},
    {"home": "Millbrook", "away": "Stonefield", "home_goals": 1, "away_goals": 1},
    {"home": "Stonefield", "away": "Harbor", "home_goals": 0, "away_goals": 3},
]
rows = standings(north)
assert rows == [
    {"rank": 1, "team": "Harbor", "points": 6, "diff": 5, "scored": 5},
    {"rank": 2, "team": "Millbrook", "points": 1, "diff": -2, "scored": 1},
    {"rank": 3, "team": "Stonefield", "points": 1, "diff": -3, "scored": 1},
], rows
print("public check passed")
