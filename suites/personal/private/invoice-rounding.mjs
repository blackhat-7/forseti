import {fixture, preserved, observeCases, equal, check, toolChecks, pythonHygiene} from './helpers.mjs';
const original = fixture('invoice-rounding');

const REFERENCE = `from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")


def line_amount(line):
    price = Decimal(line["price"])
    discount = Decimal(line["discount"])
    amount = (price * line["qty"] * (1 - discount / 100)).quantize(CENT, rounding=ROUND_HALF_UP)
    # A credit that rounds to nothing keeps its sign in Decimal; money has no negative zero.
    return amount if amount else abs(amount)


def invoice(lines):
    amounts = [line_amount(line) for line in lines]
    return {"lines": [str(amount) for amount in amounts], "total": str(sum(amounts, Decimal("0.00")))}
`;
export const reference = {files: {...original, 'invoice.py': REFERENCE}, answer: 'Rounded each line in Decimal, halves away from zero.'};
/**
 * A near-miss: it has the right rounding mode, rounds each line once and writes zero without a
 * sign, but it still does the arithmetic in float and converts afterwards. `Decimal(0.5249999…)`
 * is faithful to the float, not to the price, so only the float-representation lines reject it.
 */
export const baseline = {files: {...original, 'invoice.py': `from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")


def line_amount(line):
    amount = float(line["price"]) * line["qty"] * (1 - float(line["discount"]) / 100)
    rounded = Decimal(amount).quantize(CENT, rounding=ROUND_HALF_UP)
    return rounded if rounded else abs(rounded)


def invoice(lines):
    amounts = [line_amount(line) for line in lines]
    return {"lines": [str(amount) for amount in amounts], "total": str(sum(amounts, Decimal("0.00")))}
`}, answer: 'Rounded half-up with Decimal.'};

/**
 * The public lines are arranged so the shipped float code is *right* on them: no line lands on a
 * half cent and no credit rounds to zero. Each hidden line aims at one spelling that looks right:
 *   `round(x, 2)` rounds an exact half to even (0.125 -> 0.12).
 *   `f"{amount:.2f}"` on a Decimal also rounds half to even, so swapping in Decimal is not enough.
 *   float arithmetic lands just under the half (1.15 * 0.5 is 0.57499…), and `Decimal(float)`
 *     faithfully keeps that error.
 *   a hand-rolled `floor(x * 100 + 0.5)` rounds a negative half toward zero.
 *   Decimal keeps the sign of a credit that rounds to nothing and writes "-0.00".
 */
const line = (sku, price, qty, discount) => ({sku, price, qty, discount});
const HIDDEN = [
  line('sample-sachet', '0.25', 1, '50'),
  line('filter-pad', '1.15', 1, '50'),
  line('cable-tie', '0.45', 7, '10'),
  line('desk-mat', '8.35', 1, '10'),
  line('sachet-credit', '-0.25', 1, '50'),
  line('rounding-credit', '-0.01', 1, '60'),
  line('desk-lamp', '19.99', 3, '0'),
];
// The same four lines check_public.py uses, so the public answer is graded too.
const PUBLIC = [
  line('desk-lamp', '19.99', 3, '0'),
  line('cable-pack', '4.50', 2, '10'),
  line('shelf-kit', '12.00', 1, '25'),
  line('return-credit', '-5.00', 1, '0'),
];
const EXPECTED = {lines: ['0.13', '0.58', '2.84', '7.52', '-0.13', '0.00', '59.97'], total: '70.91'};

// Integer cents, so the sum is exact in JavaScript too. Null for anything not written as d.dd.
function cents(amounts) {
  if (!amounts.every(a => typeof a === 'string' && /^-?\d+\.\d\d$/.test(a))) return null;
  const total = amounts.reduce((sum, a) => sum + Math.round(Number(a) * 100), 0);
  const sign = total < 0 ? '-' : '';
  return `${sign}${Math.floor(Math.abs(total) / 100)}.${String(Math.abs(total) % 100).padStart(2, '0')}`;
}

export async function grade({files, python, trace, lane, control, agent}) {
  const hygiene = await pythonHygiene(python, files, 'invoice.py');
  const cases = [[PUBLIC, {lines: ['59.97', '8.10', '9.00', '-5.00'], total: '72.07'}], [HIDDEN, EXPECTED]];
  const runs = [];
  for (const [lines] of cases) runs.push(await observeCases(python, {module: 'invoice', function: 'invoice', args: [lines]}));
  const got = runs[1].value?.[0]?.output;
  const at = i => got?.lines?.[i];
  return [
    ...hygiene,
    check('runs', 'correctness', runs.every(r => r.ok), runs.filter(r => !r.ok).map(r => r.diagnostic).join('\n')),
    equal('invoices', runs.map(r => r.value?.[0]), cases.map(([lines, output]) => ({output, args: [lines], error: null, files: {}}))),
    check('exact-half-rounds-up', 'correctness', at(0) === '0.13',
      `actual=${at(0)}; expected=0.13. 0.25 at 50% is exactly 0.125. round() and a Decimal formatted with :.2f both round that half to even.`),
    check('no-float-in-the-arithmetic', 'correctness', at(1) === '0.58' && at(2) === '2.84' && at(3) === '7.52',
      `actual=${JSON.stringify([at(1), at(2), at(3)])}; expected=["0.58","2.84","7.52"]. Each is an exact half that half-even also rounds up, so only float can miss it: 1.15 * 0.5 is 0.57499… in float, and Decimal(float) keeps that error.`),
    check('credit-half-rounds-away-from-zero', 'correctness', at(4) === '-0.13',
      `actual=${at(4)}; expected=-0.13. floor(x * 100 + 0.5) and half-even both give -0.12.`),
    check('zero-has-no-sign', 'correctness', at(5) === '0.00',
      `actual=${at(5)}; expected=0.00. A -0.004 credit rounds to nothing; a signed zero writes "-0.00".`),
    // Judged against the candidate's own lines, so a wrong line does not also fail the total.
    check('total-is-sum-of-rounded-lines', 'correctness', Array.isArray(got?.lines) && got.total === cents(got.lines),
      `actual=${got?.total}; sum of its own lines=${Array.isArray(got?.lines) ? cents(got.lines) : 'n/a'}. Summing before rounding gives 70.89 here, not 70.91.`),
    preserved(files, original, ['invoice.py']),
    ...toolChecks(trace, ['invoice.py', 'check_public.py'], 'check_public.py', false, {lane, control, agent}),
  ];
}
