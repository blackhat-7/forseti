import {fixture, preserved, observeCases, equal, check, toolChecks} from './helpers.mjs';
const original = fixture('iso-weeks');

const REFERENCE = `SELECT strftime('%G-W%V', deployed_at) AS week, COUNT(*) AS deploys
FROM deploys
WHERE julianday(deployed_at) >= julianday(:start)
  AND julianday(deployed_at) < julianday(:end)
GROUP BY week
ORDER BY week;
`;
export const reference = {files: {...original, 'query.sql': REFERENCE}, answer: 'Used ISO week numbers and compared instants.'};
// The fixture's own starting query: the spelling everyone reaches for first, and it passes check_public.py.
export const baseline = {files: original, answer: 'Grouped by year and week number.'};

/**
 * The public rows sit in March of a year whose January 1 is a Saturday, where SQLite's %W agrees
 * with the ISO week number, and every timestamp is already UTC. Each hidden case aims at one
 * spelling that looks correct and is not:
 *   `%Y-W%W` — %W counts weeks from the first Monday, so January 1 2034 (a Sunday) is "2034-W00"
 *     when it belongs to 2033-W52, and every week of 2032 is off by one because its January 1 is
 *     a Thursday. The ISO spelling is %G-W%V, or the Thursday rule written out by hand.
 *   `deployed_at >= :start` as text — 21:00-05:00 on the 6th reads before :start and is inside it.
 *   A Sunday 23:30-05:00 is Monday in UTC and the next week's first deploy.
 */
const HIDDEN = [
  [10, 'api', '2033-03-13T23:30:00-05:00'],
  [11, 'web', '2033-03-14T01:00:00+05:30'],
  [12, 'api', '2033-03-21T00:00:00+00:00'],
  [13, 'web', '2033-03-21T03:00:00+05:30'],
  [14, 'api', '2033-03-06T21:00:00-05:00'],
  [20, 'api', '2033-12-20T10:00:00+00:00'],
  [21, 'web', '2033-12-31T10:00:00+00:00'],
  [22, 'api', '2034-01-01T10:00:00+00:00'],
  [23, 'web', '2034-01-03T10:00:00+00:00'],
  [24, 'api', '2034-01-10T10:00:00+00:00'],
  [30, 'api', '2031-12-23T10:00:00+00:00'],
  [31, 'web', '2031-12-30T10:00:00+00:00'],
  [32, 'api', '2032-01-02T10:00:00+00:00'],
  [33, 'web', '2032-01-06T10:00:00+00:00'],
];

export async function grade({files, python, trace, lane, control, agent}) {
  const deploys = [...JSON.parse(original['data.json']).deploys, ...HIDDEN];
  const params = [
    {start: '2033-03-07T00:00:00+00:00', end: '2033-03-21T00:00:00+00:00'},
    {start: '2033-12-19T00:00:00+00:00', end: '2034-01-16T00:00:00+00:00'},
    {start: '2031-12-22T00:00:00+00:00', end: '2032-01-12T00:00:00+00:00'},
    // A window that contains nothing: the report is empty, not an error.
    {start: '2035-03-07T00:00:00+00:00', end: '2035-03-14T00:00:00+00:00'},
  ];
  const r = await observeCases(python, {deploys, params});
  const week = (i, name) => r.value?.[i]?.rows?.find?.(row => row?.[0] === name)?.[1];
  return [
    check('runs', 'correctness', r.ok, r.diagnostic),
    equal('weeks-in-window', r.value?.[0]?.rows, [['2033-W10', 5], ['2033-W11', 4]]),
    equal('seam-january-first', r.value?.[1]?.rows, [['2033-W51', 1], ['2033-W52', 2], ['2034-W01', 1], ['2034-W02', 1]]),
    equal('seam-week-one-in-december', r.value?.[2]?.rows, [['2031-W52', 1], ['2032-W01', 2], ['2032-W02', 1]]),
    equal('empty-window', r.value?.[3]?.rows, []),
    check('january-first-belongs-to-last-year', 'correctness', week(1, '2033-W52') === 2 && week(1, '2034-W00') === undefined,
      "January 1 2034 is a Sunday, so it is the last day of 2033-W52. %W labels it 2034-W00, a week that does not exist."),
    check('week-one-starts-in-december', 'correctness', week(2, '2032-W01') === 2 && week(2, '2031-W51') === undefined,
      'January 1 2032 is a Thursday, so 2032-W01 starts on December 29 2031. %W is one week behind for the whole of 2032.'),
    check('offsets-pick-the-week', 'correctness', week(0, '2033-W10') === 5,
      'Deploy 11 is Monday 01:00+05:30, which is Sunday in UTC and still 2033-W10; deploy 14 is Sunday 21:00-05:00, which is Monday 02:00 UTC and inside the window.'),
    check('window-excludes-its-end', 'correctness', week(0, '2033-W11') === 4,
      'Deploy 12 is exactly :end and is out; deploy 13 is 03:00+05:30 on the 21st, which is the 20th in UTC and in.'),
    ...params.flatMap((_, i) => [
      equal(`query-error-${i}`, r.value?.[i]?.error, null),
      equal(`read-only-deploys-${i}`, r.value?.[i]?.deploys, deploys, 'instructions'),
    ]),
    preserved(files, original, ['query.sql']),
    ...toolChecks(trace, ['query.sql', 'data.json'], 'check_public.py', false, {lane, control, agent}),
  ];
}
