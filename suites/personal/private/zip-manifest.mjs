import {fixture, preserved, observeCases, equal, check, toolChecks, pythonHygiene} from './helpers.mjs';
const original = fixture('zip-manifest');

const REFERENCE = `import re

ENTRY = re.compile(r"v(\\d+)/([^/]+)\\.onnx")


def manifest(listing, settings):
    newest = {}
    for name in listing:
        match = ENTRY.fullmatch(name)
        if not match:
            continue
        version, slider = int(match.group(1)), match.group(2)
        if slider not in newest or version > newest[slider][0]:
            newest[slider] = (version, name)
    models, constants, missing = {}, {}, []
    for slider, setting in settings.items():
        if setting is None:
            continue
        if setting != "learned":
            constants[slider] = setting
        elif slider in newest:
            models[slider] = newest[slider][1]
        else:
            missing.append(slider)
    return {"models": models, "constants": constants, "missing": sorted(missing)}
`;
export const reference = {files: {...original, 'package.py': REFERENCE}, answer: 'Parsed entries exactly, compared versions as numbers, kept zero constants.'};
// The fixture's own starting code: the spelling everyone reaches for first, and it passes check_public.py.
export const baseline = {files: original, answer: 'Picked the newest file per slider.'};

/**
 * The public listing is arranged so the obvious code is *right* on it: no slider name ends in a
 * character of ".onnx", versions stop at v3, the only constant is nonzero and every entry is a
 * model file. Each hidden row aims at one spelling that looks correct and is not:
 *   `file.rstrip(".onnx")` strips a character set, not a suffix: saturation → saturatio, grain → grai.
 *   `sorted(listing)` or `max()` on names puts v9 after v10, so the older model ships.
 *   `if not setting` treats a constant of 0 as switched off, so the slider vanishes from the zip.
 *   `version, file = name.split("/")` raises on a stray entry instead of ignoring it.
 */
const CASES = [
  {
    listing: ['v3/exposure.onnx', 'v9/exposure.onnx', 'v10/exposure.onnx', 'v9/saturation.onnx', 'v9/grain.onnx',
      'v2/shadows.onnx', 'v9/contrast.onnx', 'v9/dehaze.onnx', 'v10/'],
    settings: {exposure: 'learned', saturation: 'learned', grain: 'learned', shadows: 'learned', contrast: 0,
      vignette: 1.5, temperature: -0.25, tint: null, clarity: 'learned'},
    expected: {
      models: {exposure: 'v10/exposure.onnx', saturation: 'v9/saturation.onnx', grain: 'v9/grain.onnx', shadows: 'v2/shadows.onnx'},
      constants: {contrast: 0, vignette: 1.5, temperature: -0.25},
      missing: ['clarity'],
    },
  },
  {
    listing: ['v1/exposure.onnx', 'v1/', '__MACOSX/v1/._exposure.onnx', 'README.txt', 'v2/exposure.onnx.bak'],
    settings: {exposure: 'learned'},
    expected: {models: {exposure: 'v1/exposure.onnx'}, constants: {}, missing: []},
  },
  {listing: [], settings: {exposure: 'learned', tint: null}, expected: {models: {}, constants: {}, missing: ['exposure']}},
];

export async function grade({files, python, trace, lane, control, agent}) {
  const hygiene = await pythonHygiene(python, files, 'package.py');
  const runs = [];
  for (const c of CASES) runs.push(await observeCases(python, {module: 'package', function: 'manifest', args: [c.listing, c.settings]}));
  const out = runs.map(r => r.value?.[0]?.output ?? {});
  const {models = {}, constants = {}, missing = []} = out[0];
  const nowhere = s => !(s in models) && !(s in constants) && !(Array.isArray(missing) && missing.includes(s));
  return [
    ...hygiene,
    check('runs', 'correctness', runs.every(r => r.ok), runs.filter(r => !r.ok).map(r => r.diagnostic).join('\n')),
    equal('manifest', out[0], CASES[0].expected),
    equal('stray-entries', out[1], CASES[1].expected),
    equal('empty-listing', out[2], CASES[2].expected),
    ...runs.map((r, i) => equal(`error-${i}`, r.value?.[0]?.error, null)),
    check('suffix-is-not-a-character-set', 'correctness', models.saturation === 'v9/saturation.onnx' && models.grain === 'v9/grain.onnx',
      '`rstrip(".onnx")` strips characters, not a suffix: saturation becomes saturatio and grain becomes grai, so both are reported missing.'),
    check('versions-compare-as-numbers', 'correctness', models.exposure === 'v10/exposure.onnx',
      'As text, v9 sorts after v10, so a sorted listing or max() ships the older exposure model.'),
    check('zero-is-a-constant', 'correctness', constants.contrast === 0,
      'A truthiness test on the setting drops a constant of 0 as if the slider were switched off, so contrast is missing from the zip.'),
    check('newest-per-slider', 'correctness', models.shadows === 'v2/shadows.onnx',
      'shadows only exists in v2. The newest version is per slider, not the newest directory.'),
    check('unrequested-files-ignored', 'correctness', nowhere('dehaze') && nowhere('tint'),
      'dehaze has a file but no setting, and tint is switched off. Neither belongs in models, constants or missing.'),
    preserved(files, original, ['package.py']),
    ...toolChecks(trace, ['package.py', 'data.json'], 'check_public.py', false, {lane, control, agent}),
  ];
}
