import {fixture, preserved, answerJson, jsonOnly, equal, check, bounded, toolChecks} from './helpers.mjs';
const original = fixture('coverage-audit');

// Four traps, each a different way of reading the three files wrong.
// Boundary: domestic_declared_limit is weight_kg 30.0 and insured_value 500 against `> 30` and
// `> 500` tests, so it clears neither and lands on B4; intl_insured_at_limit lands on B6.
// Precedence: three cases set express true, but an earlier branch claims each of them first.
// Impossible states: B1 needs weight_kg <= 0, which CHECK (weight_kg > 0) forbids. B2 needs a
// domestic row with insured_value > 500, which the table CHECK forbids -- that one is only visible
// by reading the two columns together. Every branch a case can reach is reached, so the verdict is
// COMPLETE, but only for an auditor that excludes both impossible branches rather than one.
const expected = {
  verdict: 'COMPLETE',
  uncovered: [],
  redundant: ['domestic_declared_limit', 'domestic_express_over', 'domestic_light_again', 'intl_insured_express'],
  coverage: {
    B3: ['domestic_express_over', 'domestic_over_limit'],
    B4: ['domestic_declared_limit', 'domestic_light', 'domestic_light_again'],
    B5: ['intl_express_heavy'],
    B6: ['intl_insured_at_limit', 'intl_insured_express'],
    B7: ['intl_express_over'],
    B8: ['intl_express'],
    B9: ['intl_insured_just_under'],
  },
};
const sortedList = value => (Array.isArray(value) ? [...value].map(String).sort() : value);
const sortedMap = value => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortedList(v)]))
  : value);

export const reference = {files: original, answer: JSON.stringify(expected)};
// The audit a careless reviewer produces: reads both `>` tests as `>=` so the two at-limit cases
// move up a tier, lets `express` win over the branches that actually precede it, takes B1 for a
// real gap and never notices the cross-column CHECK that rules B2 out, and misses the repeats.
export const baseline = {files: original, answer: JSON.stringify({
  verdict: 'NOT COMPLETE',
  uncovered: ['B1', 'B6'],
  redundant: [],
  coverage: {
    B2: ['domestic_declared_limit', 'domestic_express_over'],
    B3: ['domestic_over_limit'],
    B4: ['domestic_light', 'domestic_light_again'],
    B5: ['intl_insured_at_limit'],
    B7: ['intl_express_heavy', 'intl_express_over'],
    B8: ['intl_express', 'intl_insured_express'],
    B9: ['intl_insured_just_under'],
  },
})};

export async function grade({answer, files, trace, lane, control, agent}) {
  const got = answerJson(answer) ?? {};
  const uncovered = Array.isArray(got.uncovered) ? got.uncovered.map(String) : [];
  const reaches = (branch, name) => sortedList(got.coverage?.[branch])?.includes?.(name) === true;
  return [
    equal('coverage-map', sortedMap(got.coverage), sortedMap(expected.coverage)),
    equal('uncovered-branches', sortedList(got.uncovered), expected.uncovered),
    equal('redundant-cases', sortedList(got.redundant), expected.redundant),
    check('impossible-excluded', 'correctness', !uncovered.includes('B1') && !uncovered.includes('B2'),
      `B1 needs weight_kg <= 0 and B2 needs a domestic row with insured_value > 500; both CHECKs forbid those, so neither is a gap. reported uncovered=${bounded(uncovered)}`),
    check('boundary-cases-placed', 'correctness',
      reaches('B4', 'domestic_declared_limit') && reaches('B6', 'intl_insured_at_limit'),
      `weight_kg 30.0 fails > 30 and insured_value 500 fails > 500, so these land on B4 and B6. reported B4=${bounded(got.coverage?.B4)}; B6=${bounded(got.coverage?.B6)}`),
    check('earlier-branch-wins', 'correctness',
      reaches('B3', 'domestic_express_over') && reaches('B5', 'intl_express_heavy') && reaches('B6', 'intl_insured_express'),
      `All three express cases are claimed by an earlier branch, so none of them reaches B7 or B8. reported B3=${bounded(got.coverage?.B3)}; B5=${bounded(got.coverage?.B5)}; B6=${bounded(got.coverage?.B6)}`),
    equal('verdict', got.verdict, expected.verdict),
    jsonOnly(answer),
    preserved(files, original),
    ...toolChecks(trace, ['shipment.py', 'cases.json', 'schema.sql'], null, true, {lane, control, agent}),
  ];
}
