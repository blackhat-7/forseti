import {fixture, preserved, observeCases, equal, check, toolChecks} from './helpers.mjs';
const original = fixture('all-green');

const REFERENCE = `SELECT profile, COUNT(*) AS runs,
       strftime('%Y-%m-%dT%H:%M:%SZ', MAX(datetime(finished_at))) AS last_finished
FROM runs
WHERE julianday(finished_at) >= julianday(:start)
  AND julianday(finished_at) < julianday(:end)
GROUP BY profile
HAVING COUNT(*) = SUM(status = 'succeeded')
ORDER BY profile;
`;
export const reference = {files: {...original, 'query.sql': REFERENCE}, answer: 'Counted a NULL status as not succeeded and compared instants.'};
// The fixture's own starting query: the spelling everyone reaches for first, and it passes check_public.py.
export const baseline = {files: original, answer: 'Kept profiles with no non-succeeded run.'};

/**
 * The public rows are arranged so the obvious query is *right* on them: no status is NULL, every
 * timestamp is already UTC and nothing sits on the edge of the window. Each hidden row aims at one
 * spelling that looks correct and is not:
 *   `SUM(status <> 'succeeded') = 0`, `MIN(status) = 'succeeded'`, `NOT EXISTS (... status <> ...)`
 *     — every one of them ignores a NULL status, so a profile with a run that never reported passes.
 *   `MAX(finished_at)` on text — 12:00+05:30 sorts after 09:00+00:00 and is the earlier instant.
 *   `finished_at >= :start` as text — 02:00+05:30 on the 7th reads past :end and is inside it.
 *   Driving from the set of profiles instead of the runs in the window: a profile with no run in
 *     the window has no failure in it either, and appears.
 */
const HIDDEN = [
  [20, 'p-kilo', '2031-03-04T09:00:00+00:00', 'succeeded'],
  [21, 'p-kilo', '2031-03-04T10:00:00+00:00', null],
  [22, 'p-lima', '2031-03-05T12:00:00+05:30', 'succeeded'],
  [23, 'p-lima', '2031-03-05T09:00:00+00:00', 'succeeded'],
  [24, 'p-mike', '2031-03-07T02:00:00+05:30', 'succeeded'],
  [25, 'p-mike', '2031-03-02T21:00:00-05:00', 'succeeded'],
  [26, 'p-november', '2031-02-01T09:00:00+00:00', 'succeeded'],
  [27, 'p-papa', '2031-03-07T00:00:00+00:00', 'succeeded'],
];

export async function grade({files, python, trace, lane, control, agent}) {
  const runs = [...JSON.parse(original['data.json']).runs, ...HIDDEN];
  const params = [
    {start: '2031-03-03T00:00:00+00:00', end: '2031-03-07T00:00:00+00:00'},
    // A window that contains nothing: the report is empty, not an error.
    {start: '2032-03-03T00:00:00+00:00', end: '2032-03-04T00:00:00+00:00'},
  ];
  const r = await observeCases(python, {runs, params});
  const expected = [
    ['p-alpha', 3, '2031-03-05T10:00:00Z'], ['p-delta', 1, '2031-03-06T08:00:00Z'],
    ['p-lima', 2, '2031-03-05T09:00:00Z'], ['p-mike', 2, '2031-03-06T20:30:00Z'],
  ];
  const got = r.value?.[0]?.rows;
  const row = profile => (Array.isArray(got) ? got.find(x => x?.[0] === profile) : undefined);
  return [
    check('runs', 'correctness', r.ok, r.diagnostic),
    equal('all-green-profiles', got, expected),
    equal('empty-window', r.value?.[1]?.rows, []),
    check('null-status-is-not-success', 'correctness', Array.isArray(got) && row('p-kilo') === undefined,
      "p-kilo has a run whose status is NULL. `status <> 'succeeded'` is NULL for it, and SUM, MIN, MAX and EXISTS all ignore that row, so the profile passes."),
    check('latest-is-an-instant', 'correctness', row('p-lima')?.[2] === '2031-03-05T09:00:00Z',
      'p-lima finished at 12:00+05:30 and at 09:00+00:00. The text MAX is the first; the later instant is the second.'),
    check('offsets-decide-the-window', 'correctness', row('p-mike')?.[1] === 2,
      'p-mike finished at 2031-03-07T02:00:00+05:30 and 2031-03-02T21:00:00-05:00. Both read outside the window as text and both are inside it in UTC.'),
    check('no-run-in-window-no-row', 'correctness', Array.isArray(got) && row('p-november') === undefined,
      'p-november has only a run before :start. No failure in the window is not the same as every run succeeded.'),
    check('window-excludes-its-end', 'correctness', Array.isArray(got) && row('p-papa') === undefined,
      'p-papa finished exactly at :end. The window is half-open.'),
    ...params.flatMap((_, i) => [
      equal(`query-error-${i}`, r.value?.[i]?.error, null),
      equal(`read-only-runs-${i}`, r.value?.[i]?.runs, runs, 'instructions'),
    ]),
    preserved(files, original, ['query.sql']),
    ...toolChecks(trace, ['query.sql', 'data.json'], 'check_public.py', false, {lane, control, agent}),
  ];
}
