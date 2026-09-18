import {fixture,preserved,observeCases,equal,check,toolChecks} from './helpers.mjs';
const original=fixture('weekly-coverage');
export const reference={files:{...original,'query.sql':"SELECT date(j.finished_at, '-6 days', 'weekday 1') AS week_start,\n       COUNT(*) AS jobs,\n       SUM(EXISTS(SELECT 1 FROM metrics m WHERE m.job_id = j.id)) AS with_metrics\nFROM jobs j\nWHERE j.deleted = 0\n  AND julianday(j.finished_at) >= julianday(:start)\n  AND julianday(j.finished_at) < julianday(:end)\nGROUP BY week_start\nORDER BY week_start;\n"},answer:'Used UTC weeks and a half-open window.'};
export const baseline={files:original,answer:'Counted rows by date.'};
export async function grade({files,python,trace, lane, control, agent}) {
 const data=JSON.parse(original['data.json']);
 data.jobs.push([7,'2031-01-05T23:30:00-01:00',0],[8,'2031-01-20T00:30:00+01:00',0],[9,'2031-01-05T23:59:59Z',0],[10,'2031-01-14T00:00:00Z',0]);
 data.metrics.push([7,'x'],[7,'y'],[8,'x'],[999,'orphan']);
 const params=[{start:'2031-01-06T00:00:00Z',end:'2031-01-20T00:00:00Z'},{start:'2032-01-01T00:00:00Z',end:'2032-01-02T00:00:00Z'}];
 const r=await observeCases(python,{...data,params});
 return [check('runs','correctness',r.ok,r.diagnostic),equal('utc-dedupe-deletion-window',r.value?.[0]?.rows,[['2031-01-06',4,3],['2031-01-13',3,2]]),equal('empty-window',r.value?.[1]?.rows,[]),
 ...params.flatMap((_,i) => [equal(`query-error-${i}`,r.value?.[i]?.error,null),equal(`read-only-jobs-${i}`,r.value?.[i]?.jobs,data.jobs,'instructions'),equal(`read-only-metrics-${i}`,r.value?.[i]?.metrics,data.metrics,'instructions')]),
 preserved(files,original,['query.sql']),...toolChecks(trace,['query.sql','data.json'],'check_public.py',false,{lane,control,agent})];
}
