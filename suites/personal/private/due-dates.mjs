import {fixture, preserved, observeCases, equal, check, toolChecks} from './helpers.mjs';
const original = fixture('due-dates');

const REFERENCE = `WITH due AS (
  SELECT id, amount,
         min(date(issued_at, '+1 month'),
             date(issued_at, 'start of month', '+2 months', '-1 day')) AS due
  FROM invoices
),
paid AS (
  SELECT invoice_id, SUM(amount) AS paid
  FROM payments
  WHERE julianday(paid_at) < julianday(:asof)
  GROUP BY invoice_id
)
SELECT d.id, d.due, d.amount - COALESCE(p.paid, 0) AS outstanding
FROM due d
LEFT JOIN paid p ON p.invoice_id = d.id
WHERE d.due < date(:asof)
  AND d.amount - COALESCE(p.paid, 0) > 0
ORDER BY d.id;
`;
export const reference = {files: {...original, 'query.sql': REFERENCE}, answer: 'Clamped the due day and counted only payments before :asof.'};
// The fixture's own starting query: the spelling everyone reaches for first, and it passes check_public.py.
export const baseline = {files: original, answer: 'Listed invoices due before :asof with a balance.'};

/**
 * The public rows are arranged so the obvious query is *right* on them: no invoice is issued after
 * the 28th, every overdue invoice has a partial payment, every payment is before :asof and every
 * timestamp is already UTC. Each hidden row aims at one spelling that looks correct and is not:
 *   `date(issued_at, '+1 month')` — SQLite does not clamp: Jan 31 becomes Mar 3 and Mar 31 becomes
 *     May 1, which on :asof = May 1 is no longer "before", so the invoice vanishes.
 *   `LEFT JOIN payments ... WHERE p.paid_at < :asof` — the test in WHERE turns the outer join back
 *     into an inner one, so an invoice with no payment at all, the most overdue kind, is dropped.
 *   `amount - SUM(p.amount)` with no payment rows is NULL, and `HAVING NULL < amount` drops it too.
 *   `p.paid_at < :asof` as text — a payment at 22:00-05:00 reads as April 30 and is May 1 in UTC.
 */
const HIDDEN = {
  invoices: [
    [10, '2031-01-31T09:00:00+00:00', 3000],
    [11, '2031-03-31T09:00:00+00:00', 8000],
    [12, '2031-01-31T22:00:00-05:00', 4000],
    [13, '2031-04-01T09:00:00+00:00', 2000],
    [14, '2031-03-05T09:00:00+00:00', 6000],
    [15, '2031-03-06T09:00:00+00:00', 6000],
  ],
  payments: [
    [11, '2031-04-15T09:00:00+00:00', 1000],
    [12, '2031-03-20T09:00:00+00:00', 1000],
    [14, '2031-04-01T00:00:00+00:00', 2000],
    [14, '2031-04-30T22:00:00-05:00', 4000],
    [15, '2031-05-01T03:00:00+05:30', 6000],
  ],
};

export async function grade({files, python, trace, lane, control, agent}) {
  const data = JSON.parse(original['data.json']);
  const rows = {invoices: [...data.invoices, ...HIDDEN.invoices], payments: [...data.payments, ...HIDDEN.payments]};
  const params = [
    {asof: '2031-05-01T00:00:00+00:00'},
    {asof: '2031-03-01T00:00:00+00:00'},
    // Nothing is due yet: the report is empty, not an error.
    {asof: '2031-02-01T00:00:00+00:00'},
  ];
  const r = await observeCases(python, {...rows, params});
  const expected = [
    [1, '2031-03-10', 6000], [4, '2031-04-12', 7000], [10, '2031-02-28', 3000],
    [11, '2031-04-30', 7000], [12, '2031-03-01', 3000], [14, '2031-04-05', 4000],
  ];
  const got = r.value?.[0]?.rows;
  const row = id => (Array.isArray(got) ? got.find(x => x?.[0] === id) : undefined);
  return [
    check('runs', 'correctness', r.ok, r.diagnostic),
    equal('overdue-as-of', got, expected),
    equal('earlier-asof', r.value?.[1]?.rows, [[10, '2031-02-28', 3000]]),
    equal('nothing-overdue', r.value?.[2]?.rows, []),
    check('month-end-clamps', 'correctness', row(10)?.[1] === '2031-02-28' && row(11)?.[1] === '2031-04-30',
      "Issued Jan 31 is due Feb 28 and Mar 31 is due Apr 30. SQLite's '+1 month' does not clamp: it gives Mar 3 and May 1."),
    check('unpaid-invoices-appear', 'correctness', row(10)?.[2] === 3000,
      'Invoice 10 has no payment at all. A payment filter in WHERE, or a SUM that is NULL for no rows, drops exactly the most overdue invoices.'),
    check('payments-after-asof-do-not-count', 'correctness', row(14)?.[2] === 4000,
      "Invoice 14's second payment is 2031-04-30T22:00:00-05:00, which is May 1 in UTC and so not received by :asof."),
    check('offsets-pick-the-day', 'correctness', row(12)?.[1] === '2031-03-01',
      'Invoice 12 was issued 2031-01-31T22:00:00-05:00, which is Feb 1 in UTC, so it is due Mar 1.'),
    check('due-on-asof-is-not-overdue', 'correctness', row(13) === undefined,
      'Invoice 13 is due on the UTC day of :asof. Due before means strictly before.'),
    ...params.flatMap((_, i) => [
      equal(`query-error-${i}`, r.value?.[i]?.error, null),
      equal(`read-only-invoices-${i}`, r.value?.[i]?.invoices, rows.invoices, 'instructions'),
      equal(`read-only-payments-${i}`, r.value?.[i]?.payments, rows.payments, 'instructions'),
    ]),
    preserved(files, original, ['query.sql']),
    ...toolChecks(trace, ['query.sql', 'data.json'], 'check_public.py', false, {lane, control, agent}),
  ];
}
