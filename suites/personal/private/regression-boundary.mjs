import {fixture,preserved,observeCases,equal,check,toolChecks,pythonHygiene} from './helpers.mjs';
const original=fixture('regression-boundary');
export const reference={files:{...original,'policy.py':"import math\n\ndef decision(current, baseline):\n    for metrics in (current, baseline):\n        if not isinstance(metrics, dict):\n            return \"unknown\"\n        count, error = metrics.get(\"count\"), metrics.get(\"error\")\n        if type(count) is not int or count < 20:\n            return \"unknown\"\n        if type(error) not in (int, float) or not math.isfinite(error) or error < 0:\n            return \"unknown\"\n    return \"regressed\" if current[\"error\"] > baseline[\"error\"] * 1.1 else \"accepted\"\n"},answer:'Checked both metric sets and strict threshold.'};
export const baseline={files:original,answer:'Compared error with the regression threshold.'};
export async function grade({files,python,trace, lane, control, agent}) {
 const hygiene = await pythonHygiene(python, files, 'policy.py');
 const m=(count,error) => ({count,error});
 const cases=[[m(20,11),m(20,10)],[m(20,11.01),m(20,10)],[m(19,1),m(20,1)],[m(20,1),m(19,1)],[m(20,0),m(20,0)],[m(20,0.01),m(20,0)],[null,m(20,1)],[{},m(20,1)],[m(true,1),m(20,1)],[m(20,true),m(20,1)],[m(20,{'$float':'nan'}),m(20,1)],[m(20,1),m(20,{'$float':'inf'})],[m(20,-1),m(20,1)],[m(20,'1'),m(20,1)],[m(20,1),m(20,1)]];
 const expected=['accepted','regressed','unknown','unknown','accepted','regressed','unknown','unknown','unknown','unknown','unknown','unknown','unknown','unknown','accepted'];
 const runs=[];
 for (const [i,args] of cases.entries()) {
  const r=await observeCases(python,{module:'policy',function:'decision',args});
  runs.push(r);
 }
 return [...hygiene,check('runs','correctness',runs.every(r => r.ok),runs.filter(r => !r.ok).map(r => r.diagnostic).join('\n')),equal('threshold-missing-invalid',runs.map(r => r.value?.[0]),cases.map((args,i) => ({output:expected[i],args:args,error:null,files:{}}))),preserved(files,original,['policy.py']),...toolChecks(trace,['policy.py'],'check_public.py',false,{lane,control,agent})];
}
