import {fixture, preserved, observeCases, equal, check, toolChecks, pythonHygiene} from './helpers.mjs';
const original = fixture('league-table');

const body = sortKey => `def standings(matches):
    table = {}
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
${sortKey}
    ranked = []
    for position, row in enumerate(rows):
        level = (row["points"], row["diff"], row["scored"])
        if ranked and (ranked[-1]["points"], ranked[-1]["diff"], ranked[-1]["scored"]) == level:
            rank = ranked[-1]["rank"]
        else:
            rank = position + 1
        ranked.append({"rank": rank, **row})
    return ranked
`;
export const reference = {files: {...original, 'table.py': body(
  '    rows = sorted(table.values(), key=lambda row: (-row["points"], -row["diff"], -row["scored"], row["team"]))')},
  answer: 'Fresh table per call, shared ranks, names A to Z.'};
/**
 * A near-miss: a fresh table per call and shared, skipping ranks, but it keeps the shipped
 * `reverse=True` over a key that includes the name, so teams level on everything come out Z to A.
 * Only the full-tie pair rejects it.
 */
export const baseline = {files: {...original, 'table.py': body(
  '    rows = sorted(table.values(), key=lambda row: (row["points"], row["diff"], row["scored"], row["team"]), reverse=True)')},
  answer: 'Fresh table per call and shared ranks.'};

/**
 * The public league is arranged so the shipped code is *right* on it: it is standings' only call in
 * the process, and no two teams are level on points, difference and goals scored. Hidden rows:
 *   `table={}` as a default is one dict for the life of the process, so the second league (and a
 *     second run of the same one) starts from the first one's totals.
 *   `reverse=True` over (points, diff, scored, team) sorts the name Z to A as well.
 *   `enumerate` gives level teams different ranks, 1 2 3 4 5 instead of 1 2 2 4 5.
 *   Elm and Dale are level on points and difference, not on goals scored: they do not share a rank,
 *     and Elm is above Dale although Dale comes first by name.
 */
const match = (home, away, home_goals, away_goals) => ({home, away, home_goals, away_goals});
const HIDDEN = [
  match('Ashby', 'Dale', 1, 0),
  match('Ashby', 'Elm', 2, 1),
  match('Brook', 'Corran', 1, 1),
  match('Brook', 'Dale', 4, 2),
  match('Corran', 'Elm', 4, 2),
];
const row = (rank, team, points, diff, scored) => ({rank, team, points, diff, scored});
const EXPECTED = [
  row(1, 'Ashby', 6, 2, 3),
  row(2, 'Brook', 4, 2, 5),
  row(2, 'Corran', 4, 2, 5),
  row(4, 'Elm', 0, -3, 3),
  row(5, 'Dale', 0, -3, 2),
];

export async function grade({files, python, trace, lane, control, agent}) {
  const hygiene = await pythonHygiene(python, files, 'table.py');
  // Two calls in one process, as report.py makes them.
  const r = await observeCases(python, {module: 'table', function: 'standings', args: [HIDDEN], repeat: 2});
  const [first, second] = r.value ?? [];
  const teams = first?.output?.map?.(x => x?.team);
  const ranks = first?.output?.map?.(x => x?.rank);
  const snapshot = {output: EXPECTED, args: [HIDDEN], error: null, files: {}};
  return [
    ...hygiene,
    check('runs', 'correctness', r.ok, r.diagnostic),
    equal('standings', first, snapshot),
    // Against the first call, so this names the shared-default trap and nothing else.
    equal('second-call-starts-fresh', second?.output, first?.output),
    check('level-teams-a-to-z', 'correctness', teams?.indexOf('Brook') >= 0 && teams?.indexOf('Brook') < teams?.indexOf('Corran'),
      `order=${JSON.stringify(teams)}. Brook and Corran are level on everything and go A to Z; reverse=True over a key holding the name sorts it Z to A.`),
    check('level-teams-share-a-rank', 'correctness', JSON.stringify(ranks) === '[1,2,2,4,5]',
      `ranks=${JSON.stringify(ranks)}; expected=[1,2,2,4,5]. Teams level on points, difference and goals scored share a rank and the next rank skips.`),
    check('goals-scored-breaks-the-tie', 'correctness', teams?.[3] === 'Elm' && teams?.[4] === 'Dale',
      `order=${JSON.stringify(teams)}. Elm and Dale are level on points and difference; Elm scored more.`),
    preserved(files, original, ['table.py']),
    ...toolChecks(trace, ['table.py', 'report.py'], 'check_public.py', false, {lane, control, agent}),
  ];
}
