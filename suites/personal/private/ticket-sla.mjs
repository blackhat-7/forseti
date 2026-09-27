import {fixture, preserved, observeCases, equal, check, toolChecks, pythonHygiene} from './helpers.mjs';
const original = fixture('ticket-sla');

const body = elapsed => `from datetime import datetime


def breaches(tickets, limit_hours, now):
    late = []
    for ticket in tickets:
        took = datetime.fromisoformat(ticket["resolved"] or now) - datetime.fromisoformat(ticket["opened"])
        if ${elapsed} > limit_hours * 3600:
            late.append(ticket["id"])
    return late
`;
export const reference = {files: {...original, 'sla.py': body('took.total_seconds()')}, answer: 'Parsed offsets and measured the whole duration.'};
/**
 * A near-miss: it keeps each offset, so every same-day ticket comes out right, but it still reads
 * `timedelta.seconds`, which is only the part after the whole days. Only the tickets that stayed
 * open for more than a day reject it.
 */
export const baseline = {files: {...original, 'sla.py': body('took.seconds')}, answer: 'Parsed offsets before subtracting.'};

/**
 * The public tickets are arranged so the shipped code is *right* on them: every stamp is +00:00 and
 * nothing stays open for a day. Hidden rows aim at the two spellings that look right:
 *   `strptime(stamp[:19], ...)` drops the offset, so a ticket logged from another region is off by
 *     hours either way — a breach missed (T-202), a false breach (T-203), and one that is exactly
 *     the limit and so not a breach (T-204).
 *   `delta.seconds` is the remainder after whole days: 25 hours reads as 1 and 72 hours as 0.
 * T-206 needs both: 25 hours in truth, 23 with the offsets dropped, 1 with `.seconds`. Under a
 * 24-hour limit only the fully right reading flags it.
 */
const ticket = (id, opened, resolved) => ({id, opened, resolved});
const HIDDEN = [
  ticket('T-201', '2031-04-30T10:00:00+00:00', '2031-05-01T11:00:00+00:00'),
  ticket('T-202', '2031-05-01T09:00:00+02:00', '2031-05-01T12:30:00+00:00'),
  ticket('T-203', '2031-05-01T09:00:00+00:00', '2031-05-01T15:00:00+03:00'),
  ticket('T-204', '2031-05-01T08:00:00-04:00', '2031-05-01T16:00:00+00:00'),
  ticket('T-205', '2031-04-29T12:00:00+00:00', null),
  ticket('T-206', '2031-05-01T12:00:00+02:00', '2031-05-02T11:00:00+00:00'),
];
// The same four tickets check_public.py uses, so the public answer is graded too.
const PUBLIC = [
  ticket('T-101', '2031-05-02T08:00:00+00:00', '2031-05-02T11:00:00+00:00'),
  ticket('T-102', '2031-05-02T01:00:00+00:00', '2031-05-02T06:30:00+00:00'),
  ticket('T-103', '2031-05-02T09:00:00+00:00', null),
  ticket('T-104', '2031-05-02T06:00:00+00:00', null),
];
const NOW = '2031-05-02T12:00:00+00:00';
const CASES = [
  [4, ['T-102', 'T-104', 'T-201', 'T-202', 'T-205', 'T-206']],
  [24, ['T-201', 'T-205', 'T-206']],
];

export async function grade({files, python, trace, lane, control, agent}) {
  const hygiene = await pythonHygiene(python, files, 'sla.py');
  const tickets = [...PUBLIC, ...HIDDEN];
  const runs = [];
  for (const [limit] of CASES) runs.push(await observeCases(python, {module: 'sla', function: 'breaches', args: [tickets, limit, NOW]}));
  const late = runs.map(r => r.value?.[0]?.output);
  const has = (i, id) => Array.isArray(late[i]) && late[i].includes(id);
  return [
    ...hygiene,
    check('runs', 'correctness', runs.every(r => r.ok), runs.filter(r => !r.ok).map(r => r.diagnostic).join('\n')),
    equal('breaches', runs.map(r => r.value?.[0]), CASES.map(([limit, output]) => ({output, args: [tickets, limit, NOW], error: null, files: {}}))),
    check('offsets-are-kept', 'correctness', has(0, 'T-202') && !has(0, 'T-203') && !has(0, 'T-204'),
      `limit 4: T-202 took 5.5h, T-203 3h, T-204 exactly 4h (not a breach); dropping the offsets reads 3.5h, 6h and 8h. actual=${JSON.stringify(late[0])}`),
    check('whole-days-count', 'correctness', has(0, 'T-201') && has(0, 'T-205'),
      `limit 4: T-201 took 25h and T-205 has been open 72h; timedelta.seconds reads 1h and 0h. actual=${JSON.stringify(late[0])}`),
    check('both-at-once', 'correctness', has(1, 'T-206') && !has(1, 'T-202'),
      `limit 24: T-206 took 25h; dropping the offsets reads 23h and .seconds reads 1h. actual=${JSON.stringify(late[1])}`),
    preserved(files, original, ['sla.py']),
    ...toolChecks(trace, ['sla.py', 'check_public.py'], 'check_public.py', false, {lane, control, agent}),
  ];
}
