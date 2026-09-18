import {fixture,preserved,observeCases,equal,check,toolChecks,pythonHygiene} from './helpers.mjs';
const original=fixture('artifact-contract');
const REFERENCE="def audit(manifest):\n    expected = {name: [slider for slider in sliders if manifest[\"settings\"].get(slider) == \"learned\"]\n                for name, sliders in manifest[\"groups\"].items()}\n    required = {name for name, outputs in expected.items() if outputs}\n    present = set(manifest[\"models\"])\n    return {\"missing\": sorted(required - present),\n            \"unexpected\": sorted(present - required),\n            \"mismatched\": sorted(name for name in required & present\n                                 if manifest[\"models\"][name] != expected[name])}\n";
export const reference={files:{...original,'artifacts.py':REFERENCE},answer:'Derived model outputs from learned settings.'};
/**
 * A near-miss rather than the untouched fixture: it agrees with the reference on every case that
 * was already here and differs only on the two added ones, so the controls show the new cases are
 * what rejects it. Its two bugs are the ordinary ones — accept a model whose outputs merely start
 * with the learned sliders, and return the three lists in manifest order instead of sorted.
 */
export const baseline={files:{...original,'artifacts.py':"def audit(manifest):\n    expected = {name: [slider for slider in sliders if manifest[\"settings\"][slider] == \"learned\"]\n                for name, sliders in manifest[\"groups\"].items()}\n    required = {name for name, outputs in expected.items() if outputs}\n    present = manifest[\"models\"]\n    return {\"missing\": [n for n in expected if n in required and n not in present],\n            \"unexpected\": [n for n in present if n not in required],\n            \"mismatched\": [n for n in expected if n in required and n in present\n                           and present[n][:len(expected[n])] != expected[n]]}\n"},answer:'Checked model presence.'};
export async function grade({files,python,trace, lane, control, agent}) {
 const hygiene = await pythonHygiene(python, files, 'artifacts.py');
 const cases=[
 {groups:{pair:['hue','sat'],tone:['light']},settings:{hue:0,sat:'learned',light:1.5},models:{pair:['hue','sat'],tone:['light']}},
 {groups:{pair:['hue','sat']},settings:{hue:'learned',sat:'learned'},models:{pair:['sat','hue']}},
 {groups:{pair:['hue','sat']},settings:{hue:'learned',sat:0},models:{extra:['x']}},
 {groups:{pair:['hue','sat']},settings:{hue:0,sat:0.5},models:{}},
 {groups:{pair:['hue','sat']},settings:{hue:0,sat:'learned'},models:{pair:['sat']}},
 // Outputs that are a superset of the learned members: exactly, not at least.
 {groups:{pair:['hue','sat']},settings:{hue:'learned',sat:0},models:{pair:['hue','sat']}},
 // Several names at once, declared in an order that is not the sorted order.
 {groups:{zulu:['a'],alpha:['b'],mid:['c']},settings:{a:'learned',b:'learned',c:0},models:{yankee:['x'],bravo:['y'],mid:['c']}},
 // A constant between two learned sliders: group order is kept, the constant is dropped.
 {groups:{trio:['a','b','c']},settings:{a:'learned',b:0,c:'learned'},models:{trio:['a','c']}},
 // Present and required, but producing nothing.
 {groups:{pair:['hue','sat']},settings:{hue:'learned',sat:0},models:{pair:[]}},
 // One slider in two groups, and a settings map that omits a slider entirely.
 {groups:{beta:['x','y'],alpha:['y','z']},settings:{y:'learned',z:'learned'},models:{beta:['y'],alpha:['z','y']}}
 ];
 const expected=[{missing:[],unexpected:['tone'],mismatched:['pair']},{missing:[],unexpected:[],mismatched:['pair']},{missing:['pair'],unexpected:['extra'],mismatched:[]},{missing:[],unexpected:[],mismatched:[]},{missing:[],unexpected:[],mismatched:[]},{missing:[],unexpected:[],mismatched:['pair']},{missing:['alpha','zulu'],unexpected:['bravo','mid','yankee'],mismatched:[]},{missing:[],unexpected:[],mismatched:[]},{missing:[],unexpected:[],mismatched:['pair']},{missing:[],unexpected:[],mismatched:['alpha']}];
 const runs=[];
 for (const [i,manifest] of cases.entries()) {
  const r=await observeCases(python,{module:'artifacts',function:'audit',args:[manifest]});
  runs.push(r);
 }
 const outputs=runs.map(r => r.value?.[0]?.output);
 return [...hygiene,check('runs','correctness',runs.every(r => r.ok),runs.filter(r => !r.ok).map(r => r.diagnostic).join('\n')),
  equal('presence-constants-output-order',runs.map(r => r.value?.[0]),cases.map((manifest,i) => ({output:expected[i],args:[manifest],error:null,files:{}}))),
  equal('learned-outputs-exactly',outputs[5],expected[5]),
  equal('name-lists-sorted',outputs[6],expected[6]),
  equal('learned-members-in-group-order',[outputs[7],outputs[8]],[expected[7],expected[8]]),
  equal('absent-setting-not-learned',outputs[9],expected[9]),
  preserved(files,original,['artifacts.py']),...toolChecks(trace,['artifacts.py'],'check_public.py',false,{lane,control,agent})];
}
