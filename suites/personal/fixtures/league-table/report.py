"""Nightly job: one table per league, all in the same process."""
from table import standings


def print_tables(leagues):
    for league, matches in leagues.items():
        print(league)
        for row in standings(matches):
            print(f'{row["rank"]:>3}  {row["team"]:<12} {row["points"]:>3} {row["diff"]:+d}')
