import {fixture, preserved, observeCases, equal, check, toolChecks, pythonHygiene} from './helpers.mjs';
const original = fixture('double-delivery');

const REFERENCE = `def initialize(conn):
    conn.executescript("CREATE TABLE outbox (job TEXT PRIMARY KEY, amount INTEGER NOT NULL);")


def handle(conn, delivery):
    amount = delivery.get("amount")
    if type(amount) is not int:
        raise ValueError("amount must be an int")
    with conn:
        written = conn.execute("INSERT OR IGNORE INTO outbox VALUES (?, ?)", (delivery["job"], amount)).rowcount
    return written == 1
`;
export const reference = {files: {...original, 'worker.py': REFERENCE}, answer: 'Keyed on the job, validated before writing, one transaction per call.'};
// The fixture's own starting code: it dedups by delivery id and commits only on success, and it
// passes check_public.py, which is the whole point of shipping it as the starting point.
export const baseline = {files: original, answer: 'Deduplicated deliveries.'};

/**
 * The public check is arranged so the obvious code is *right* on it: the duplicate carries the
 * same delivery id and every amount is a plain int. Each hidden delivery aims at one spelling
 * that looks correct and is not:
 *   `seen(delivery)` keyed on the delivery id, when a redelivery gets a new one.
 *   `isinstance(amount, int)`, which True passes.
 *   a mark written, then a raise, then no rollback: sqlite3 keeps the transaction open, the next
 *   call commits the mark, and the corrected delivery is skipped for good.
 *   `delivery["amount"]` on a delivery with no amount, which is a KeyError and not a ValueError.
 */
const d = (delivery, job, amount) => ({delivery, job, ...(amount === undefined ? {} : {amount})});
const DELIVERIES = [
  d('d-1', 'j-1', 5), d('d-1', 'j-1', 5), d('d-2', 'j-1', 5),
  d('d-3', 'j-2', true), d('d-4', 'j-3', -2), d('d-5', 'j-2', 0),
  d('d-6', 'j-4', '7'), d('d-7', 'j-4', 7), d('d-8', 'j-4', 9),
  d('d-9', 'j-5'), d('d-10', 'j-5', 1),
];
const OUTBOX = [['j-1', 5], ['j-3', -2], ['j-2', 0], ['j-4', 7], ['j-5', 1]];
const EXPECTED = [
  [true, 1], [false, 1], [false, 1], ['ValueError', 1], [true, 2], [true, 3],
  ['ValueError', 3], [true, 4], [false, 4], ['ValueError', 4], [true, 5],
].map(([result, rows]) => ({
  returned: typeof result === 'boolean' ? result : null,
  error: typeof result === 'string' ? result : null,
  outbox: OUTBOX.slice(0, rows),
  open: false,
}));

export async function grade({files, python, trace, lane, control, agent}) {
  const hygiene = await pythonHygiene(python, files, 'worker.py');
  const r = await observeCases(python, DELIVERIES);
  const step = i => r.value?.[i] ?? {};
  const rows = i => (Array.isArray(step(i).outbox) ? step(i).outbox : []);
  return [
    ...hygiene,
    check('runs', 'correctness', r.ok, r.diagnostic),
    equal('scenario', r.value, EXPECTED),
    check('same-job-new-delivery-id', 'correctness', step(2).returned === false && rows(2).filter(row => row?.[0] === 'j-1').length === 1,
      'd-2 redelivers j-1 under a new delivery id. Keyed on the delivery id, the job is written twice.'),
    check('bool-is-not-an-amount', 'correctness', step(3).error === 'ValueError' && rows(3).length === 1,
      'True passes isinstance(amount, int) and lands in the outbox as 1.'),
    check('failed-call-leaves-nothing-open', 'correctness', step(3).open === false && step(6).open === false,
      'sqlite3 opens a transaction at the first write and keeps it open across a raise. Whatever the failed call wrote is committed by the next call.'),
    check('corrected-redelivery-processed', 'correctness', step(5).returned === true && step(7).returned === true,
      'A mark written before validation survives the failure, so the corrected delivery is skipped and the job is processed zero times.'),
    check('missing-amount-is-a-value-error', 'correctness', step(9).error === 'ValueError' && rows(9).length === 4,
      'delivery["amount"] on a delivery without one raises KeyError, and the prompt asks for ValueError.'),
    preserved(files, original, ['worker.py']),
    ...toolChecks(trace, ['worker.py'], 'check_public.py', false, {lane, control, agent}),
  ];
}
