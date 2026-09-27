import {fixture, preserved, observeCases, equal, check, toolChecks, pythonHygieneChanged} from './helpers.mjs';
const original = fixture('room-bookings');
const EDITABLE = Object.keys(original).filter(p => p.endsWith('.py') && !['config.py', 'observe.py', 'check_public.py'].includes(p));

function patch(path, from, to) {
  const text = original[path];
  if (!text.includes(from)) throw new Error(`room-bookings control: ${path} no longer contains the patched text`);
  return text.replace(from, to);
}
// Defect 1, the visible one: the offset is thrown away, so local wall time is stored as if it were UTC.
const CLOCK = patch('clock.py', '    # Storage is UTC.\n    return value.replace(tzinfo=timezone.utc)', '    return value.astimezone(timezone.utc)');
// Defect 2: the keyset cursor is the start time alone, so rows sharing a start straddling a page edge are skipped.
const REPOSITORY = patch('repository.py', `                               and (after is None or row.start_utc > after))
        rows.sort(key=lambda row: row.start_utc)
        page = rows[:limit]
        cursor = page[-1].start_utc if len(rows) > limit else None`, `                               and (after is None or (row.start_utc, row.booking_id) > after))
        rows.sort(key=lambda row: (row.start_utc, row.booking_id))
        page = rows[:limit]
        cursor = (page[-1].start_utc, page[-1].booking_id) if len(rows) > limit else None`);
// Defect 3: the cache is keyed by local day but forgotten by UTC day. Hidden while defect 1 stands.
const SERVICE = patch('booking_service.py', `        self.availability.forget(booking.room_id, booking.start_utc.date().isoformat())`,
  `        offset = SITES[booking.site]["offset_minutes"]
        self.availability.forget(booking.room_id, to_local(booking.start_utc, offset).date().isoformat())`)
  .replace('from errors import SlotTaken, UnknownBooking\n', 'from clock import to_local\nfrom config import SITES\nfrom errors import SlotTaken, UnknownBooking\n');

export const reference = {files: {...original, 'clock.py': CLOCK, 'repository.py': REPOSITORY, 'booking_service.py': SERVICE},
  answer: 'Kept the offset when parsing, made the page cursor unique, and forgot the cached local day.'};
// The symptom plus its most visible cause: check_public.py passes, the two deeper defects remain.
export const baseline = {files: {...original, 'clock.py': CLOCK}, answer: 'Converted booking times to UTC properly.'};

const HOURS = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
const except = (...taken) => HOURS.filter(h => !taken.includes(h));
const book = (room, who, at, hours = 1) => ({op: 'book', room, who, at, hours});
const ok = value => ({value, error: null});
const err = error => ({value: null, error});

/**
 * Each scenario runs against a fresh service in its own interpreter, so one hang costs one
 * scenario. The public check is one Harbour booking on an empty day; each scenario below aims at
 * something that check never reaches:
 *   offsets   other offsets and a two-hour booking, seen through free slots and confirmations.
 *             The confirmation reads start_utc directly, so patching free_slots alone misses it.
 *   rebook    a cancelled row and its rebooking share a start time on either side of a page edge
 *             (PAGE_SIZE is 3). A cursor on the start time alone skips the live one.
 *   ties      four rooms booked at 09:00 at one site: the day report and raw paging. Filtering out
 *             cancelled rows does not help here, and a `>=` cursor never advances past the tie.
 *   westmere  UTC-08:00, so 16:00 local is the next UTC day. The cache is forgotten by UTC day.
 *             This only appears once the offset is kept, because the stored time was local.
 *   combined  all three at once in one room.
 */
const SCENARIOS = {
  offsets: [
    [book('NGT-2', 'Ines', '2031-03-03T09:00:00-04:00', 2), ok(1)],
    [book('HBR-1', 'Omar', '2031-03-03T17:00:00+05:30'), ok(2)],
    [book('KST-1', 'Lee', '2031-03-03T08:00:00+00:00'), ok(3)],
    [{op: 'free', room: 'NGT-2', day: '2031-03-03'}, ok(except('09:00', '10:00'))],
    [{op: 'free', room: 'HBR-1', day: '2031-03-03'}, ok(except('17:00'))],
    [{op: 'free', room: 'KST-1', day: '2031-03-03'}, ok(except('08:00'))],
    [{op: 'confirm', id: 1}, ok('Booked Garden at Northgate on 2031-03-03 from 09:00 to 11:00 for Ines.')],
    [{op: 'confirm', id: 2}, ok('Booked Studio at Harbour on 2031-03-03 from 17:00 to 18:00 for Omar.')],
    [book('NGT-2', 'Pia', '2031-03-03T10:00:00-04:00'), err('SlotTaken')],
    [book('HBR-1', 'Pia', '2031-03-03T11:30:00+00:00'), err('InvalidBooking')],
    [{op: 'report', site: 'NGT', day: '2031-03-03'}, ok({'NGT-1': 0, 'NGT-2': 2})],
  ],
  rebook: [
    [book('HBR-3', 'Ada', '2031-03-04T08:00:00+05:30'), ok(1)],
    [book('HBR-3', 'Ben', '2031-03-04T09:00:00+05:30'), ok(2)],
    [book('HBR-3', 'Cy', '2031-03-04T10:00:00+05:30'), ok(3)],
    [{op: 'cancel', id: 3}, ok(null)],
    [book('HBR-3', 'Dee', '2031-03-04T10:00:00+05:30'), ok(4)],
    [book('HBR-3', 'Eli', '2031-03-04T11:00:00+05:30'), ok(5)],
    [{op: 'free', room: 'HBR-3', day: '2031-03-04'}, ok(except('08:00', '09:00', '10:00', '11:00'))],
    [book('HBR-3', 'Fay', '2031-03-04T10:00:00+05:30'), err('SlotTaken')],
    [{op: 'report', site: 'HBR', day: '2031-03-04'}, ok({'HBR-1': 0, 'HBR-2': 0, 'HBR-3': 4, 'HBR-4': 0})],
  ],
  ties: [
    [book('HBR-1', 'Gus', '2031-03-05T09:00:00+05:30'), ok(1)],
    [book('HBR-2', 'Hal', '2031-03-05T09:00:00+05:30'), ok(2)],
    [book('HBR-3', 'Ivy', '2031-03-05T09:00:00+05:30'), ok(3)],
    [book('HBR-4', 'Jo', '2031-03-05T09:00:00+05:30'), ok(4)],
    [book('HBR-1', 'Kit', '2031-03-05T11:00:00+05:30', 2), ok(5)],
    [book('HBR-2', 'Liv', '2031-03-05T13:00:00+05:30'), ok(6)],
    [{op: 'report', site: 'HBR', day: '2031-03-05'}, ok({'HBR-1': 3, 'HBR-2': 2, 'HBR-3': 1, 'HBR-4': 1})],
    [{op: 'pages', site: 'HBR', start: '2031-03-04T18:30:00+00:00', end: '2031-03-05T18:30:00+00:00', limit: 3}, ok([[1, 2, 3], [4, 5, 6]])],
    [{op: 'pages', site: 'HBR', start: '2031-03-04T18:30:00+00:00', end: '2031-03-05T18:30:00+00:00', limit: 2}, ok([[1, 2], [3, 4], [5, 6]])],
    [{op: 'pages', site: 'HBR', start: '2031-03-04T18:30:00+00:00', end: '2031-03-05T18:30:00+00:00', limit: 6}, ok([[1, 2, 3, 4, 5, 6]])],
    [{op: 'free', room: 'HBR-4', day: '2031-03-05'}, ok(except('09:00'))],
  ],
  westmere: [
    [{op: 'free', room: 'WST-2', day: '2031-03-06'}, ok(HOURS)],
    [book('WST-2', 'Kai', '2031-03-06T16:00:00-08:00'), ok(1)],
    [{op: 'free', room: 'WST-2', day: '2031-03-06'}, ok(except('16:00'))],
    [book('WST-2', 'Lu', '2031-03-06T16:00:00-08:00'), err('SlotTaken')],
    [{op: 'cancel', id: 1}, ok(null)],
    [{op: 'free', room: 'WST-2', day: '2031-03-06'}, ok(HOURS)],
    [book('WST-2', 'Lu', '2031-03-06T16:00:00-08:00'), ok(2)],
    [{op: 'confirm', id: 2}, ok('Booked Atrium at Westmere on 2031-03-06 from 16:00 to 17:00 for Lu.')],
    [book('WST-1', 'Mo', '2031-03-06T17:00:00-08:00'), ok(3)],
    [{op: 'report', site: 'WST', day: '2031-03-06'}, ok({'WST-1': 1, 'WST-2': 1})],
  ],
  combined: [
    [book('WST-1', 'Nia', '2031-03-07T14:00:00-08:00'), ok(1)],
    [book('WST-1', 'Oz', '2031-03-07T15:00:00-08:00'), ok(2)],
    [book('WST-1', 'Pat', '2031-03-07T16:00:00-08:00'), ok(3)],
    [{op: 'cancel', id: 3}, ok(null)],
    [{op: 'free', room: 'WST-1', day: '2031-03-07'}, ok(except('14:00', '15:00'))],
    [book('WST-1', 'Quin', '2031-03-07T16:00:00-08:00'), ok(4)],
    [book('WST-1', 'Rae', '2031-03-07T17:00:00-08:00'), ok(5)],
    [{op: 'free', room: 'WST-1', day: '2031-03-07'}, ok(except('14:00', '15:00', '16:00', '17:00'))],
    [book('WST-1', 'Sol', '2031-03-07T16:00:00-08:00'), err('SlotTaken')],
    [{op: 'report', site: 'WST', day: '2031-03-07'}, ok({'WST-1': 4, 'WST-2': 0})],
  ],
};

export async function grade({files, python, trace, lane, control, agent}) {
  const hygiene = await pythonHygieneChanged(python, files, original, EDITABLE);
  const runs = {}, got = {};
  for (const [name, steps] of Object.entries(SCENARIOS)) {
    runs[name] = await observeCases(python, steps.map(([step]) => step));
    got[name] = runs[name].value;
  }
  const at = (name, i) => got[name]?.[i];
  const same = (name, ...indexes) => indexes.every(i => equal('', at(name, i), SCENARIOS[name][i][1]).passed);
  return [
    ...hygiene,
    check('runs', 'correctness', Object.values(runs).every(r => r.ok), Object.entries(runs).filter(([, r]) => !r.ok).map(([n, r]) => `${n}: ${r.diagnostic}`).join('\n') || 'every scenario ran'),
    ...Object.entries(SCENARIOS).map(([name, steps]) => equal(`scenario-${name}`, got[name], steps.map(([, expected]) => expected))),
    check('booked-hours-busy-at-every-offset', 'correctness', same('offsets', 3, 4, 5, 8),
      'A booking at 09:00-04:00 is 13:00 UTC. Storing the wall time as UTC moves it by the offset, so its hour shows free and a clash is accepted.'),
    check('confirmation-in-local-time', 'correctness', same('offsets', 6, 7) && same('westmere', 7),
      'The confirmation converts start_utc to local time. A fix only inside free_slots leaves the stored instant wrong.'),
    check('rebooked-hour-is-busy', 'correctness', same('rebook', 6, 7, 8),
      'A cancelled 10:00 booking is the last row of page 1 and its rebooking the first of page 2. A cursor on start time alone skips the rebooking.'),
    check('report-counts-tied-starts', 'correctness', same('ties', 6),
      'Four rooms start at 09:00 and a page holds 3. Rows tied on start time across a page edge are dropped from the day report.'),
    check('pages-visit-each-booking-once', 'correctness', same('ties', 7, 8, 9),
      'Following the cursors must return each booking exactly once with at most `limit` per page, for any limit.'),
    check('late-local-hours-refresh', 'correctness', same('westmere', 2, 3, 5),
      'At UTC-08:00, 16:00 local is the next UTC day. The free-slot cache is keyed by local day and was forgotten by UTC day, so it went stale.'),
    preserved(files, original, EDITABLE),
    ...toolChecks(trace, ['availability.py', 'clock.py'], 'check_public.py', false, {lane, control, agent}),
  ];
}
