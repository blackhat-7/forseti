import {fixture,preserved,observeCases,equal,check,toolChecks,pythonHygiene} from './helpers.mjs';
const original=fixture('artifact-contract');
export const reference={files:{...original,'artifacts.py':"def audit(manifest):\n    expected = {name: [slider for slider in sliders if manifest[\"settings\"][slider] == \"learned\"]\n                for name, sliders in manifest[\"groups\"].items()}\n    required = {name for name, outputs in expected.items() if outputs}\n    present = set(manifest[\"models\"])\n    return {\"missing\": sorted(required - present),\n            \"unexpected\": sorted(present - required),\n            \"mismatched\": sorted(name for name in required & present\n                                 if manifest[\"models\"][name] != expected[name])}\n"},answer:'Derived model outputs from learned settings.'};
export const baseline={files:original,answer:'Checked model presence.'};
export async function grade({files,python,trace, lane, control, agent}) {
 const hygiene = await pythonHygiene(python, files, 'artifacts.py');
 const cases=[
 {groups:{pair:['hue','sat'],tone:['light']},settings:{hue:0,sat:'learned',light:1.5},models:{pair:['hue','sat'],tone:['light']}},
 {groups:{pair:['hue','sat']},settings:{hue:'learned',sat:'learned'},models:{pair:['sat','hue']}},
 {groups:{pair:['hue','sat']},settings:{hue:'learned',sat:0},models:{extra:['x']}},
 {groups:{pair:['hue','sat']},settings:{hue:0,sat:0.5},models:{}},
 {groups:{pair:['hue','sat']},settings:{hue:0,sat:'learned'},models:{pair:['sat']}}
 ];
 const expected=[{missing:[],unexpected:['tone'],mismatched:['pair']},{missing:[],unexpected:[],mismatched:['pair']},{missing:['pair'],unexpected:['extra'],mismatched:[]},{missing:[],unexpected:[],mismatched:[]},{missing:[],unexpected:[],mismatched:[]}];
 const runs=[];
 for (const [i,manifest] of cases.entries()) {
  const r=await observeCases(python,{module:'artifacts',function:'audit',args:[manifest]});
  runs.push(r);
 }
 return [...hygiene,check('runs','correctness',runs.every(r => r.ok),runs.filter(r => !r.ok).map(r => r.diagnostic).join('\n')),equal('presence-constants-output-order',runs.map(r => r.value?.[0]),cases.map((manifest,i) => ({output:expected[i],args:[manifest],error:null,files:{}}))),preserved(files,original,['artifacts.py']),...toolChecks(trace,['artifacts.py'],'check_public.py',false,{lane,control,agent})];
}
