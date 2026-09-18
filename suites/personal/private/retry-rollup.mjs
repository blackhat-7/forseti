import {fixture, preserved, observeCases, equal, check, toolChecks} from './helpers.mjs';
const original = fixture('retry-rollup');

const REFERENCE = `SELECT date(r.finished_at) AS day, COUNT(*) AS failures
FROM runs r
WHERE r.status = 'failed'
  AND julianday(r.finished_at) >= julianday(:start)
  AND julianday(r.finished_at) < julianday(:end)
  AND NOT EXISTS (SELECT 1 FROM ignored i WHERE i.profile = r.profile)
  AND NOT EXISTS (SELECT 1 FROM supersedes s JOIN runs rr ON rr.id = s.retry_id
                  WHERE s.failed_id = r.id AND rr.status = 'succeeded')
GROUP BY day
ORDER BY day;
`;
export const reference = {files: {...original, 'query.sql': REFERENCE}, answer: 'Counted failures the retries did not fix.'};
// The fixture's own starting query. It is the spelling everyone reaches for first, and it passes
// check_public.py, which is the whole point of shipping it as the starting point.
export const baseline = {files: original, answer: 'Excluded retried and ignored runs.'};

/**
 * The public rows are arranged so the obvious query is *right* on them: every failed run has a
 * retry row, `ignored` holds no NULL, every timestamp is already UTC and nothing sits on the edge
 * of the window. Passing `check_public.py` therefore proves nothing, and that is deliberate.
 *
 * Each hidden row aims at one spelling that looks correct and is not:
 *   `profile NOT IN (SELECT profile FROM ignored)` — one NULL in `ignored` and this matches no row
 *     at all, so the whole report silently comes back empty.
 *   `LEFT JOIN ... WHERE rr.status <> 'succeeded'` — the test in WHERE turns the outer join back
 *     into an inner one, dropping every failure that was never retried.
 *   `date(finished_at)` on a value carrying an offset, and `BETWEEN` on a half-open window.
 */
const HIDDEN = {
  runs: [
    [10, 'p-echo', '2031-03-05T09:00:00+00:00', 'failed'],
    [11, 'p-fox', '2031-03-05T10:00:00+00:00', 'failed'],
    [12, 'p-fox', '2031-03-05T11:00:00+00:00', 'failed'],
    [13, 'p-gulf', '2031-03-06T01:30:00+05:30', 'failed'],
    [14, 'p-hotel', '2031-03-05T21:00:00-05:00', 'failed'],
    [15, 'p-india', '2031-03-07T00:00:00+00:00', 'failed'],
  ],
  supersedes: [[11, 12]],
  ignored: [[null]],
};

export async function grade({files, python, trace, lane, control, agent}) {
  const data = JSON.parse(original['data.json']);
  const rows = {
    runs: [...data.runs, ...HIDDEN.runs],
    supersedes: [...data.supersedes, ...HIDDEN.supersedes],
    ignored: [...data.ignored, ...HIDDEN.ignored],
  };
  const params = [
    {start: '2031-03-03T00:00:00+00:00', end: '2031-03-07T00:00:00+00:00'},
    // A window that contains nothing: the report is empty, not an error and not every row.
    {start: '2032-03-03T00:00:00+00:00', end: '2032-03-04T00:00:00+00:00'},
  ];
  const r = await observeCases(python, {...rows, params});
  const expected = [['2031-03-04', 1], ['2031-03-05', 4], ['2031-03-06', 1]];
  const got = r.value?.[0]?.rows;
  const day = name => (Array.isArray(got) ? got.find(row => row?.[0] === name)?.[1] : undefined);
  return [
    check('runs', 'correctness', r.ok, r.diagnostic),
    equal('failures-per-day', got, expected),
    equal('empty-window', r.value?.[1]?.rows, []),
    check('null-in-a-not-in-list', 'correctness', Array.isArray(got) && got.length > 0,
      'One NULL row in `ignored` makes `profile NOT IN (SELECT profile FROM ignored)` true for nothing, so the whole report comes back empty. A NULL there names no profile and must exclude none.'),
    check('failures-never-retried-count', 'correctness', day('2031-03-05') === 4,
      'p-echo and p-hotel were never retried at all. A LEFT JOIN whose test sits in WHERE drops exactly those rows.'),
    check('offsets-pick-the-day', 'correctness', day('2031-03-05') === 4 && day('2031-03-06') === 1,
      'p-gulf is 2031-03-06T01:30+05:30, which is the 5th in UTC; p-hotel is 2031-03-05T21:00-05:00, which is the 6th. Both land on the other day from how they read.'),
    check('window-excludes-its-end', 'correctness', day('2031-03-07') === undefined,
      'p-india finished exactly at :end. The window is half-open, and BETWEEN is not.'),
    ...params.flatMap((_, i) => [
      equal(`query-error-${i}`, r.value?.[i]?.error, null),
      equal(`read-only-runs-${i}`, r.value?.[i]?.runs, rows.runs, 'instructions'),
      equal(`read-only-ignored-${i}`, r.value?.[i]?.ignored, rows.ignored, 'instructions'),
    ]),
    preserved(files, original, ['query.sql']),
    ...toolChecks(trace, ['query.sql', 'data.json'], 'check_public.py', false, {lane, control, agent}),
  ];
}
