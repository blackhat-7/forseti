import {fixture, preserved, answerJson, jsonOnly, equal, check, bounded, toolChecks} from './helpers.mjs';
const original = fixture('coverage-audit');

// Two boundary traps: domestic_at_limit and intl_insured_at_limit are both weight_kg 30.0,
// and both branches need > 30, so they land on B3 and B5 rather than B2 and B4.
// B1 is unreachable because CHECK (weight_kg > 0) forbids weight_kg <= 0, so it is an
// excluded impossible state rather than a gap.
const expected = {
  verdict: 'NOT COMPLETE',
  uncovered: ['B4'],
  redundant: ['domestic_at_limit', 'domestic_light_again'],
  coverage: {
    B2: ['domestic_over_limit'],
    B3: ['domestic_at_limit', 'domestic_light', 'domestic_light_again'],
    B5: ['intl_insured_at_limit'],
    B6: ['intl_express'],
    B7: ['intl_insured_just_under'],
  },
};
const sortedList = value => (Array.isArray(value) ? [...value].map(String).sort() : value);
const sortedMap = value => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortedList(v)]))
  : value);

export const reference = {files: original, answer: JSON.stringify(expected)};
// The audit a careless reviewer produces: reads 30 > 30 as true so the two boundary cases are
// filed under the heavy branches, trusts the schema-impossible branch, and misses the repeats.
export const baseline = {files: original, answer: JSON.stringify({
  verdict: 'NOT COMPLETE',
  uncovered: ['B1'],
  redundant: [],
  coverage: {
    B2: ['domestic_at_limit', 'domestic_over_limit'],
    B3: ['domestic_light', 'domestic_light_again'],
    B4: ['intl_insured_at_limit'],
    B6: ['intl_express'],
    B7: ['intl_insured_just_under'],
  },
})};

export async function grade({answer, files, trace, lane, control, agent}) {
  const got = answerJson(answer) ?? {};
  const uncovered = Array.isArray(got.uncovered) ? got.uncovered.map(String) : [];
  return [
    equal('coverage-map', sortedMap(got.coverage), sortedMap(expected.coverage)),
    equal('uncovered-branches', sortedList(got.uncovered), expected.uncovered),
    equal('redundant-cases', sortedList(got.redundant), expected.redundant),
    check('impossible-excluded', 'correctness', !uncovered.includes('B1'),
      `B1 needs weight_kg <= 0, which CHECK (weight_kg > 0) forbids, so it is not a gap. reported uncovered=${bounded(uncovered)}`),
    check('boundary-cases-placed', 'correctness',
      sortedList(got.coverage?.B3)?.includes?.('domestic_at_limit') === true && uncovered.includes('B4'),
      `Both weight_kg 30.0 cases fail a > 30 test, so domestic_at_limit belongs to B3 and B4 stays uncovered. reported B3=${bounded(got.coverage?.B3)}; uncovered=${bounded(uncovered)}`),
    equal('verdict', got.verdict, expected.verdict),
    jsonOnly(answer),
    preserved(files, original),
    ...toolChecks(trace, ['shipment.py', 'cases.json', 'schema.sql'], null, true, {lane, control, agent}),
  ];
}
