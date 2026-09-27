import {fixture,preserved,observeCases,equal,check,toolChecks,pythonHygiene} from './helpers.mjs';
const original=fixture('regression-boundary');
export const reference={files:{...original,'policy.py':"import math\n\ndef decision(current, baseline):\n    for metrics in (current, baseline):\n        if not isinstance(metrics, dict):\n            return \"unknown\"\n        count, error = metrics.get(\"count\"), metrics.get(\"error\")\n        if type(count) is not int or count < 20:\n            return \"unknown\"\n        if type(error) not in (int, float) or not math.isfinite(error) or error < 0:\n            return \"unknown\"\n    return \"regressed\" if current[\"error\"] > baseline[\"error\"] * 1.1 else \"accepted\"\n"},answer:'Checked both metric sets and strict threshold.'};
/**
 * A near-miss rather than the untouched fixture: it agrees with the reference on all fifteen cases
 * that were already here and differs only on added ones, so the controls show the added cases are
 * what rejects it. Its bugs are the ordinary ones — subscript the error key instead of getting it,
 * accept any falsy value as a missing metric, and round the comparison to hide float noise.
 */
export const baseline={files:{...original,'policy.py':"import math\n\ndef decision(current, baseline):\n    for metrics in (current, baseline):\n        if not metrics:\n            return \"unknown\"\n        count, error = metrics.get(\"count\"), metrics[\"error\"]\n        if type(count) is bool or not isinstance(count, (int, float)) or count < 20:\n            return \"unknown\"\n        if type(error) not in (int, float) or not math.isfinite(error) or error < 0:\n            return \"unknown\"\n    return \"regressed\" if round(current[\"error\"] - baseline[\"error\"] * 1.1, 10) > 0 else \"accepted\"\n"},answer:'Compared error with the regression threshold.'};
export async function grade({files,python,trace, lane, control, agent}) {
 const hygiene = await pythonHygiene(python, files, 'policy.py');
 const m=(count,error) => ({count,error});
 // Cases 15-17 are the traps a validator that reaches for a value before checking it misses: an
 // absent error key, and a truthy non-dict on either side. An empty dict is already falsy, so only
 // a non-empty one separates "not a dict" from "nothing there".
 // Cases 18-19 are the two sides of the stated formula. `baseline * 1.1` is not `current / baseline
 // > 1.1` and is not the same as that difference rounded off: at these values the three disagree,
 // and only the one the prompt names is right.
 const cases=[[m(20,11),m(20,10)],[m(20,11.01),m(20,10)],[m(19,1),m(20,1)],[m(20,1),m(19,1)],[m(20,0),m(20,0)],[m(20,0.01),m(20,0)],[null,m(20,1)],[{},m(20,1)],[m(true,1),m(20,1)],[m(20,true),m(20,1)],[m(20,{'$float':'nan'}),m(20,1)],[m(20,1),m(20,{'$float':'inf'})],[m(20,-1),m(20,1)],[m(20,'1'),m(20,1)],[m(20,1),m(20,1)],[{count:20},m(20,1)],[[1],m(20,1)],[m(20,1),[2]],[m(20,95.70000000000002),m(20,87.0)],[m(20,132.22000000000003),m(20,120.2)]];
 const expected=['accepted','regressed','unknown','unknown','accepted','regressed','unknown','unknown','unknown','unknown','unknown','unknown','unknown','unknown','accepted','unknown','unknown','unknown','regressed','accepted'];
 const runs=[];
 for (const [i,args] of cases.entries()) {
  const r=await observeCases(python,{module:'policy',function:'decision',args});
  runs.push(r);
 }
 const snapshot=i => ({output:expected[i],args:cases[i],error:null,files:{}});
 return [...hygiene,check('runs','correctness',runs.every(r => r.ok),runs.filter(r => !r.ok).map(r => r.diagnostic).join('\n')),
  equal('threshold-missing-invalid',runs.map(r => r.value?.[0]),cases.map((args,i) => snapshot(i))),
  equal('validate-before-reading',runs.slice(15,18).map(r => r.value?.[0]),[15,16,17].map(snapshot)),
  equal('threshold-as-written',runs.slice(18).map(r => r.value?.[0]),[18,19].map(snapshot)),
  preserved(files,original,['policy.py']),...toolChecks(trace,['policy.py'],'check_public.py',false,{lane,control,agent})];
}

export const review = {
  anchor: {'policy.py': reference.files['policy.py']},
  paths: ['policy.py'],
  items: [
    {id:'validation-duplicated', ask:'Is the metric validation — dict test, count an int not bool and at least 20, error a finite nonnegative number — spelled out separately for current and for baseline instead of once for both? One helper or one loop over both is not duplication.'},
    {id:'unearned-abstraction', ask:'Does the submission add a class, registry, strategy table, config option, decorator or wrapper layer that has only one real use here and could be a plain function or a literal?'},
    {id:'dead-code', ask:'Is there unused or unreachable code left behind: a function nothing calls, an unused constant or import, a value computed and then thrown away, or a commented-out block?'},
    {id:'explanatory-noise', ask:'Are there comments or docstrings that only restate what the adjacent line already says, rather than recording a reason the code cannot express?'},
  ],
};
