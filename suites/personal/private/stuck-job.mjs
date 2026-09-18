import {fixture, preserved, observeCases, equal, check, toolChecks} from './helpers.mjs';
const original = fixture('stuck-job');

const REFERENCE = `SELECT j.job,
       CASE
         WHEN EXISTS (SELECT 1 FROM store s
                      WHERE s.job = j.job AND s.attempt = j.attempt) THEN 'done'
         WHEN NOT EXISTS (SELECT 1 FROM queue q
                          WHERE q.job = j.job AND q.attempt = j.attempt
                            AND q.event = 'acked') THEN 'queued'
         WHEN (julianday(:now) - julianday(j.updated_at)) * 86400.0 > :lease THEN 'lost'
         ELSE 'running'
       END AS state
FROM jobs j
WHERE j.attempt = (SELECT MAX(j2.attempt) FROM jobs j2 WHERE j2.job = j.job)
ORDER BY j.job;
`;
export const reference = {files: {...original, 'query.sql': REFERENCE}, answer: 'One row per job, from its latest attempt.'};
// The fixture's own starting query: it trusts the database, matches the store without an attempt,
// and never restricts to the latest attempt. It passes check_public.py, which is the point.
export const baseline = {files: original, answer: 'Reported the stored state.'};

/**
 * The public rows are the easy half, so `check_public.py` passes for a query that is wrong in four
 * different ways. These are the rows it does not see, and each one of the four ideas decides
 * several jobs at once — which is what makes a single repetition worth reading.
 *   latest attempt only  — amber and basil have an artifact from an *earlier* attempt
 *   the store proves done — delta and ember have a database row saying done and no artifact
 *   offsets are instants  — flint and grove sit either side of the lease only once converted
 *   at-least-once delivery — delta and grove were acked twice, so a join duplicates their row
 */
const HIDDEN = {
  jobs: [
    ['job-amber', 1, 'done', '2031-06-11T09:14:00+00:00'],
    ['job-amber', 2, 'running', '2031-06-11T11:58:00+00:00'],
    ['job-basil', 1, 'done', '2031-06-11T08:02:00+00:00'],
    ['job-basil', 2, 'done', '2031-06-11T10:41:00+00:00'],
    ['job-basil', 3, 'queued', '2031-06-11T11:20:00+00:00'],
    ['job-delta', 1, 'lost', '2031-06-11T07:35:00+00:00'],
    ['job-delta', 2, 'done', '2031-06-11T11:55:00+00:00'],
    ['job-ember', 1, 'done', '2031-06-11T11:30:00+00:00'],
    ['job-flint', 1, 'running', '2031-06-11T17:18:00+05:30'],
    ['job-grove', 1, 'running', '2031-06-11T06:55:00-05:00'],
  ],
  queue: [
    ['job-amber', 1, 'acked', '2031-06-11T09:03:00+00:00'],
    ['job-amber', 2, 'dispatched', '2031-06-11T11:56:00+00:00'],
    ['job-amber', 2, 'acked', '2031-06-11T11:57:00+00:00'],
    ['job-basil', 1, 'acked', '2031-06-11T07:51:00+00:00'],
    ['job-basil', 2, 'acked', '2031-06-11T10:31:00+00:00'],
    ['job-basil', 3, 'dispatched', '2031-06-11T11:18:00+00:00'],
    ['job-basil', 3, 'acked', '2031-06-11T16:49:00+05:30'],
    ['job-delta', 1, 'acked', '2031-06-11T07:21:00+00:00'],
    ['job-delta', 2, 'acked', '2031-06-11T11:53:00+00:00'],
    ['job-delta', 2, 'acked', '2031-06-11T11:53:30+00:00'],
    ['job-ember', 1, 'acked', '2031-06-11T11:25:00+00:00'],
    ['job-flint', 1, 'acked', '2031-06-11T11:45:00+00:00'],
    ['job-grove', 1, 'acked', '2031-06-11T11:52:00+00:00'],
    ['job-grove', 1, 'acked', '2031-06-11T11:52:00+00:00'],
  ],
  store: [['job-amber', 1, 'job-amber/1/model.bin'], ['job-basil', 2, 'job-basil/2/model.bin']],
};

export async function grade({files, python, trace, lane, control, agent}) {
  const data = JSON.parse(original['data.json']);
  const rows = {
    jobs: [...data.jobs, ...HIDDEN.jobs],
    queue: [...data.queue, ...HIDDEN.queue],
    store: [...data.store, ...HIDDEN.store],
  };
  const params = [
    {now: '2031-06-11T12:00:00+00:00', lease: 600},
    // A window where nothing has been touched for hours: every acked job is lost, and the one
    // that was never acked is still queued.
    {now: '2031-06-11T23:00:00+00:00', lease: 600},
  ];
  const r = await observeCases(python, {...rows, params});
  const first = [
    ['job-amber', 'running'], ['job-basil', 'lost'], ['job-cedar', 'done'], ['job-delta', 'running'],
    ['job-ember', 'lost'], ['job-flint', 'lost'], ['job-grove', 'running'], ['job-hazel', 'queued'],
    ['job-ivory', 'running'],
  ];
  const later = first.map(([job, state]) => [job, state === 'done' ? 'done' : state === 'queued' ? 'queued' : 'lost']);
  const got = r.value?.[0]?.rows;
  const reached = (job, state) => Array.isArray(got) && got.filter(row => row?.[0] === job).length === 1 && got.find(row => row?.[0] === job)?.[1] === state;
  return [
    check('runs', 'correctness', r.ok, r.diagnostic),
    equal('job-states', got, first),
    equal('states-at-a-later-now', r.value?.[1]?.rows, later),
    check('latest-attempt-only', 'correctness', reached('job-amber', 'running') && reached('job-basil', 'lost'),
      'An artifact from an earlier attempt says nothing about the current one: job-amber is on attempt 2 and job-basil on attempt 3.'),
    check('store-proves-done', 'correctness', reached('job-delta', 'running') && reached('job-ember', 'lost'),
      'Only an artifact for the current attempt proves done; both of these have a database row saying done and no artifact.'),
    check('offsets-decide-the-lease', 'correctness', reached('job-flint', 'lost') && reached('job-grove', 'running'),
      'Both rows are on the other side of the 10-minute lease from how they read: +05:30 and -05:00.'),
    check('one-row-per-job', 'correctness',
      Array.isArray(got) && new Set(got.map(row => row?.[0])).size === got.length,
      'Redelivery means a job can be acked more than once, so joining the queue duplicates its row.'),
    ...params.flatMap((_, i) => [
      equal(`query-error-${i}`, r.value?.[i]?.error, null),
      equal(`read-only-jobs-${i}`, r.value?.[i]?.jobs, rows.jobs.map(x => x).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || a[1] - b[1]), 'instructions'),
      equal(`read-only-store-${i}`, r.value?.[i]?.store, rows.store, 'instructions'),
    ]),
    preserved(files, original, ['query.sql']),
    ...toolChecks(trace, ['query.sql', 'data.json'], 'check_public.py', false, {lane, control, agent}),
  ];
}
