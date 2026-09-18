import {fixture, preserved, observeCases, equal, check, toolChecks,pythonHygiene} from './helpers.mjs';
const original = fixture('shared-count');
export const reference = {files:{...original, 'counts.py':"def parse_count(value):\n    if type(value) is int:\n        return max(value, 0)\n    if isinstance(value, str):\n        value = value.strip()\n        if value and all(\"0\" <= char <= \"9\" for char in value):\n            return int(value)\n    return 0\n"},answer:'Fixed the shared parser.'};
export const baseline = {files:{...original,'counts.py':'def parse_count(value):\n    try:\n        return max(int(value or 0), 0)\n    except (ValueError, TypeError):\n        return 0\n'},answer:'Fixed invalid counts.'};
export async function grade({files, python, trace, lane, control, agent}) {
 const hygiene = await pythonHygiene(python, files, 'counts.py');
  const values = [null, '', ' 12 ', 'bad', -2, 4, true, false, 2.8, '1.0', '+3', '٣', '001', [], {}];
  const expected = [0,0,12,0,0,4,0,0,0,0,0,0,1,0,0];
  const checks = [...hygiene];
  const runs = [];
  for (const [id,module,fn,key] of [['direct','counts','parse_count',null],['invoice','callers','invoice_total','quantity'],['stock','callers','stock_total','available']]) {
    const records = [];
    for (const value of values) {
      const args = key ? [[{[key]:value}]] : [value];
      const r = await observeCases(python,{module,function:fn,args});
      runs.push(r);
      records.push(r.value?.[0]);
    }
    checks.push(equal(id,records,values.map((value,i) => ({output:expected[i],args:key ? [[{[key]:value}]] : [value],error:null,files:{}}))));
  }
  return [...checks, check('runs','correctness',runs.every(r => r.ok),runs.filter(r => !r.ok).map(r => r.diagnostic).join('\n')), preserved(files,original,['counts.py']), ...toolChecks(trace,['counts.py','callers.py'],'check_public.py',false,{lane,control,agent})];
}
