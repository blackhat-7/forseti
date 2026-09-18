// Suite-only verifier. Executes trusted synthetic controls, never model output.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, toolChecks, pythonQuality, observe, observeCases, equal } from './helpers.mjs';

const suiteDir = fileURLToPath(new URL('../', import.meta.url));
const tmp = join(suiteDir, 'private', '.tmp');
mkdirSync(tmp, {recursive:true});
const suite = JSON.parse(readFileSync(join(suiteDir, 'suite.json'), 'utf8'));
function pythonIn(dir) {
  return async source => {
    const run = spawnSync('python3', ['-B','-c',source], {
      cwd:dir, encoding:'utf8', timeout:5000, maxBuffer:1024*1024,
      env:{PATH:process.env.PATH, PYTHONDONTWRITEBYTECODE:'1', PYTHONNOUSERSITE:'1', TMPDIR:tmp}
    });
    return {stdout:run.stdout || '',stderr:run.stderr || '',code:run.status,timedOut:run.error?.code === 'ETIMEDOUT'};
  };
}
const results = [];
for (const task of suite.tasks) {
  const grader = await import(new URL(task.grader, new URL('../', import.meta.url)));
  if (task.dimensions.includes('design')) {
    const review = grader.review;
    assert(review && review.items?.length && review.paths?.length, `${task.id}: design dimension needs a review rubric`);
    assert(new Set(review.items.map(i => i.id)).size === review.items.length, `${task.id}: duplicate review item ids`);
    assert(review.items.every(i => typeof i.ask === 'string' && i.ask.length > 40), `${task.id}: review questions must be specific`);
    // The anchor pins the scale. Without it "simple enough" has nothing to be relative to.
    assert(review.paths.every(p => typeof review.anchor?.[p] === 'string' && review.anchor[p].length), `${task.id}: every reviewed path needs an anchor`);
    assert(review.paths.every(p => grader.reference?.files?.[p] === review.anchor[p]), `${task.id}: the anchor must be the reference solution`);
  } else assert(!grader.review, `${task.id}: a review rubric requires the design dimension`);
  for (const name of ['reference', 'baseline']) {
    const control = grader[name];
    assert(control, `${task.id} lacks ${name}`);
    const files = {...fixture(task.id), ...control.files};
    const dir = mkdtempSync(join(tmp, 'personal-control-'));
    try {
      for (const [path,text] of Object.entries(files)) {
        assert(!path.includes('/') && !path.includes('\\') && path !== '..');
        writeFileSync(join(dir,path),text);
      }
      const python = pythonIn(dir);
      const checks = await grader.grade({answer:control.answer,files,trace:[],python,lane:'tools',control:true});
      assert(checks.length > 0 && checks.every(c => typeof c.passed === 'boolean'));
      assert(checks.every(c => task.dimensions.includes(c.dimension)), `${task.id}: undeclared rubric`);
      // `design` is produced by the reviewer model after grading, never by the grader.
      assert(task.dimensions.filter(d => !['tools','design'].includes(d)).every(d => checks.some(c => c.dimension === d)), `${task.id}: missing declared rubric`);
      assert(!checks.some(c => c.dimension === 'design'), `${task.id}: graders must not emit design checks`);
      assert(!checks.some(c => c.dimension === 'tools'), 'Explicit synthetic controls omit tool checks');
      if (name === 'reference') {
        assert(checks.every(c => c.passed), `${task.id} reference: ${JSON.stringify(checks)}`);
        const live = await grader.grade({answer:control.answer,files,trace:[],python,lane:'tools',control:false});
        const tools = live.filter(c => c.dimension === 'tools');
        assert(tools.length > 0, `${task.id}: live empty trace must not omit tools`);
        if (task.id === 'pause-correction') assert(tools.every(c => c.passed), 'A no-action pause requires no reads');
        else assert(tools.some(c => !c.passed), `${task.id}: missing required tool use must fail`);
        if ('check_public.py' in files) {
          const run = await python("import runpy; runpy.run_path('check_public.py',run_name='__main__')");
          assert.equal(run.code,0,`${task.id} public reference check: ${run.stderr}`);
        }
      } else assert(checks.some(c => !c.passed && ['correctness','instructions'].includes(c.dimension)), `${task.id} baseline must fail substantively`);
      results.push({task:task.id,control:name,checks:checks.length,passed:checks.filter(c => c.passed).length});
    } finally { rmSync(dir,{recursive:true,force:true}); }
  }
}
/**
 * Calibration cases are checked here, without a model, so that `npm run test:judge` only ever
 * adds the reviewer's opinion. Every case must be fully labelled and behaviourally correct:
 * correctness gates the reviewer in a real run, so a broken case would calibrate on code that
 * would never reach a reviewer at all.
 */
const calibrationDir = new URL('./calibration/', import.meta.url);
const calibration = [];
for (const file of readdirSync(fileURLToPath(calibrationDir)).filter(f => f.endsWith('.mjs'))) {
  const { task, cases } = await import(new URL(file, calibrationDir));
  const grader = await import(new URL(`./${task}.mjs`, import.meta.url));
  assert(grader.review, `${task}: calibration set without a review rubric`);
  assert(cases.length >= 4, `${task}: too few calibration cases to mean anything`);
  assert(cases.some(k => !Object.values(k.labels).some(Boolean)), `${task}: needs cases with no defect at all`);
  assert(new Set(cases.map(k => k.id)).size === cases.length, `${task}: duplicate calibration ids`);
  for (const kase of cases) {
    assert(typeof kase.why === 'string' && kase.why.length > 30, `${task}/${kase.id}: every label needs its recorded basis`);
    const ids = grader.review.items.map(i => i.id);
    assert.deepEqual(Object.keys(kase.labels).sort(), [...ids].sort(), `${task}/${kase.id}: label every question, and only the questions`);
    assert(Object.values(kase.labels).every(v => typeof v === 'boolean'), `${task}/${kase.id}: labels are yes/no`);
    const files = {...fixture(task), ...kase.files};
    const dir = mkdtempSync(join(tmp, 'personal-calibration-'));
    try {
      for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
      const checks = await grader.grade({answer:'', files, trace:[], python:pythonIn(dir), lane:'tools', control:true});
      const broken = checks.filter(c => c.dimension === 'correctness' && !c.passed).map(c => c.id);
      assert(!broken.length, `${task}/${kase.id} is not behaviourally correct: ${JSON.stringify(broken)}`);
    } finally { rmSync(dir, {recursive:true, force:true}); }
  }
  calibration.push({task, cases: cases.length, defectLabels: cases.reduce((n, k) => n + Object.values(k.labels).filter(Boolean).length, 0), judgments: cases.length * grader.review.items.length});
}
// Tool checks are exercised separately with explicit synthetic traces.
const read = {tool:'read_file',args:{path:'module.py'},ok:true,ms:1,output:'public contents'};
const write = {tool:'write_file',args:{path:'module.py',content:'replacement'},ok:true,ms:1,output:''};
const run = {tool:'python',args:{source:"import runpy; runpy.run_path('check_public.py', run_name='__main__')"},ok:true,ms:1,output:JSON.stringify({code:0,stdout:'public check passed',stderr:'',timedOut:false})};
assert.deepEqual(toolChecks([],['module.py'],'check_public.py',false,{lane:'prompt'}),[]);
assert.deepEqual(toolChecks([],['module.py'],'check_public.py',false,{lane:'tools',agent:'claude-code'}),[],'another harness cannot satisfy a rubric naming Forseti tools');
assert(toolChecks([read,write,run],['module.py'],'check_public.py').every(c => c.passed));
assert(!toolChecks([write,read,run],['module.py'],'check_public.py')[0].passed);
assert(!toolChecks([read,write,{...run,output:'{"code":1}'}],['module.py'],'check_public.py')[1].passed);
assert(!toolChecks([write],[],null,true)[0].passed);
assert(!toolChecks([read,{...run,args:{source:'# check_public.py\npass'}}],['module.py'],'check_public.py')[1].passed);
assert(toolChecks([],['module.py'],'check_public.py',false,{lane:'tools'}).every(c => !c.passed));
assert(toolChecks([],['module.py'],'check_public.py').every(c => !c.passed), 'Missing context defaults to live tools, not an exemption');
assert.deepEqual(toolChecks([write],['module.py'],'check_public.py',false,{lane:'tools',control:true}),[]);
assert.deepEqual(toolChecks([write],['module.py'],'check_public.py',false,{lane:'prompt'}),[]);
// A pause task needs no tool: not writing is valid, even with an empty live trace.
assert(toolChecks([],[],null,true,{lane:'tools'}).every(c => c.passed));
const probes = [
  ['parse without import', 'import math\nraise RuntimeError("must not execute")', [true,true,true]],
  ['syntax', 'def broken(:', [false,false,false]],
  ['third-party', 'import requests', [true,false,true]],
  ['relative import', 'from . import hidden', [true,false,true]],
  ['direct eval', 'value = eval("1")', [true,true,false]],
  ['exec reference', 'runner = exec', [true,true,false]],
  ['aliased import', 'from builtins import eval as evaluate', [true,true,false]],
  ['attribute exec', 'import builtins as b\nb.exec("pass")', [true,true,false]],
  ['wildcard builtins', 'from builtins import *', [true,true,false]],
  ['transaction rethrow', 'try:\n    operation()\nexcept Exception:\n    rollback()\n    raise', [true,true,true]]
];
const probeDir = mkdtempSync(join(tmp,'personal-quality-'));
try {
  // A model-created module with an analysis-library name must never be imported.
  writeFileSync(join(probeDir,'ast.py'),'raise RuntimeError("candidate ast imported")');
  writeFileSync(join(probeDir,'json.py'),'raise RuntimeError("candidate json imported")');
  for (const [label,source,expected] of probes) {
    const checks = await pythonQuality(pythonIn(probeDir),{'candidate.py':source},'candidate.py');
    assert.deepEqual(checks.map(c => c.passed),expected,label);
  }
} finally { rmSync(probeDir,{recursive:true,force:true}); }
const failure = await observe(async () => ({code:2,timedOut:false,stdout:'partial',stderr:'ValueError: synthetic'}),'');
assert(!failure.ok && failure.diagnostic.includes('exit=2') && failure.diagnostic.includes('ValueError'));
const invalid = await observe(async () => ({code:0,timedOut:false,stdout:'not JSON',stderr:''}),'');
assert(!invalid.ok && invalid.diagnostic.includes('invalid JSON'));
await assert.rejects(() => pythonQuality(async () => { throw Error('synthetic unavailable'); },{'candidate.py':'pass'},'candidate.py'), /synthetic unavailable/);
// Trusted synthetic adversaries: exercise protocol behavior, not a security sandbox.
const observationDir = mkdtempSync(join(tmp,'personal-observation-'));
try {
  const driver = fixture('reconcile-plan')['observe.py'];
  writeFileSync(join(observationDir,'observe.py'),driver);
  const payload={module:'candidate',function:'plan',args:[{items:['original']}],repeat:2};
  writeFileSync(join(observationDir,'candidate.py'), `import json, sys
json.dumps = lambda *a, **k: '{"passed":true,"input_unchanged":true}'
json.loads = lambda *a, **k: None
class Sink:
    def write(self, text): pass
    def flush(self): pass
sys.stdout = Sink()
def plan(snapshot):
    snapshot['items'].append('mutated')
    return snapshot['items']
`);
  const r=await observeCases(pythonIn(observationDir),payload);
  assert(r.ok,r.diagnostic);
  assert.deepEqual(r.value,[
    {output:['original','mutated'],args:[{items:['original','mutated']}],error:null,files:{}},
    {output:['original','mutated','mutated'],args:[{items:['original','mutated','mutated']}],error:null,files:{}}
  ], 'Captured encoder/write and pre-import parsing; each raw snapshot is frozen before the next call');
  assert.deepEqual(payload.args,[{items:['original']}], 'Host original remains independent');
  const grader=await import('./reconcile-plan.mjs');
  const files={...grader.reference.files,'reconcile.py':grader.reference.files['reconcile.py']+`
import json
json.dumps = lambda *a, **k: '{"input_unchanged":true,"rows_unchanged":true}'
original_plan = plan
def plan(snapshot):
    output = original_plan(snapshot)
    snapshot['owner'] = 'mutated'
    return output
`};
  for (const [path,text] of Object.entries(files)) writeFileSync(join(observationDir,path),text);
  const checks=await grader.grade({files,python:pythonIn(observationDir),trace:[],control:true});
  assert(checks.some(c => c.id.startsWith('no-input-mutation') && !c.passed),'Raw mutation cannot pass via a forged boolean');
  assert(checks.filter(c => c.id.startsWith('no-data-write')).every(c => c.passed),'Raw file contents compare on host');
  const scopeFiles={...grader.reference.files,'observe.py':driver+'# edited\n'};
  const scope=await grader.grade({files:scopeFiles,python:pythonIn(observationDir),trace:[],control:true});
  assert(!scope.find(c => c.id==='edit-scope').passed,'Public driver is immutable by scope');
  const ledger=await import('./event-ledger.mjs');
  const ledgerFiles={...ledger.baseline.files,'ledger.py':ledger.baseline.files['ledger.py']+"\nimport json\njson.dumps = lambda *a, **k: '{\"errors\":[true,true,true]}'\n"};
  for (const [path,text] of Object.entries(ledgerFiles)) writeFileSync(join(observationDir,path),text);
  const ledgerChecks=await ledger.grade({files:ledgerFiles,python:pythonIn(observationDir),control:true});
  assert(ledgerChecks.find(c => c.id==='runs').passed,'Ledger captured encoder still reports JSON');
  assert(!ledgerChecks.find(c => c.id==='replay-rollback-validation').passed,'Forged flags cannot replace raw ledger rows/errors');
  const sql=await import('./weekly-coverage.mjs');
  const sqlFiles={...sql.reference.files,'query.sql':'DELETE FROM metrics RETURNING job_id, name;'};
  for (const [path,text] of Object.entries(sqlFiles)) writeFileSync(join(observationDir,path),text);
  const sqlChecks=await sql.grade({files:sqlFiles,python:pythonIn(observationDir),control:true});
  assert(sqlChecks.some(c => c.id.startsWith('read-only-metrics') && !c.passed),'Host compares raw metrics after SQL mutation');
} finally { rmSync(observationDir,{recursive:true,force:true}); }
const compared = equal('bounded', 'x'.repeat(10000), 'expected');
assert(!compared.passed && compared.evidence.length < 1300 && compared.evidence.includes('truncated') && compared.evidence.includes('expected="expected"'));
console.log(JSON.stringify({tasks:suite.tasks.length,controls:results.length,results,calibration,tool_trace_checks:11,live_empty_trace_grader_checks:9,quality_probe_cases:probes.length,diagnostic_assertions:4,observation_regressions:9},null,2));
