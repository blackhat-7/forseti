import test from 'node:test';
import assert from 'node:assert/strict';
import { blind, judgeIdentity, judgePrompt, parseFindings, settle, verifyCitation, review, JUDGE_RUBRIC, type JudgeCall, type Review } from '../src/judge.ts';
import { DEFAULT_JUDGE } from '../src/config.ts';
import type { JudgeConfig } from '../src/types.ts';

const items = [{ id: 'dup', ask: 'Is the rule written more than once?' }, { id: 'abs', ask: 'Is there an abstraction with one use?' }];
const spec: Review = { anchor: { 'a.py': 'def f():\n    return 1\n' }, paths: ['a.py'], items };
const submission = { 'a.py': 'def f():\n    return 1\n\ndef g():\n    return 1\n' };
const judge: JudgeConfig = { ...DEFAULT_JUDGE, enabled: true, repeat: 1 };
const stub = (...replies: string[]): JudgeCall => { let i = 0; return async () => replies[Math.min(i++, replies.length - 1)]!; };

test('a cited line must exist in the submission', () => {
  assert(verifyCitation(submission, 'a.py:5 | return 1'));
  assert(verifyCitation(submission, 'a.py:4 |     def g():'), 'whitespace is normalised, not trusted');
  // Pointing at a block is normal, and the reviewer quotes the whole block when it does.
  assert(verifyCitation(submission, 'a.py:4-5 | def g():\n    return 1'), 'line range with a multi-line quote');
  assert(verifyCitation(submission, 'a.py:1 | def f():\n    return 1'), 'multi-line quote without a range');
  assert(!verifyCitation(submission, 'a.py:4-5 | def h():\n    return 2'), 'a range does not excuse invented text');
  assert(!verifyCitation(submission, 'b.py:1 | return 1'), 'unknown file');
  assert(!verifyCitation(submission, 'a.py:99 | return 1'), 'line past end of file');
  assert(!verifyCitation(submission, 'a.py:1 | return 42'), 'text that is not in the file');
  assert(!verifyCitation(submission, 'a.py:1 | '), 'empty quotation proves nothing');
  assert(!verifyCitation(submission, 'the duplication is obvious'), 'unstructured evidence');
});

test('an uncitable defect is discarded, never charged to the candidate', async () => {
  const { checks } = await review(stub(JSON.stringify({ findings: [
    { id: 'dup', defect: true, evidence: 'a.py:1 | def f():' },
    { id: 'abs', defect: true, evidence: 'a.py:1 | a factory that does not exist' },
  ] })), judge, spec, submission);
  assert.equal(checks.find(c => c.id === 'design-dup')!.passed, false, 'a verifiable defect stands');
  const invented = checks.find(c => c.id === 'design-abs')!;
  assert.equal(invented.passed, true);
  assert.match(invented.evidence, /discarded uncitable evidence/);
});

test('a reviewer failure produces no checks and never fails the trial', async () => {
  for (const reply of ['not json at all', '{"findings":[]}', JSON.stringify({ findings: [{ id: 'dup', defect: 'maybe' }] })]) {
    const { checks, note } = await review(stub(reply), judge, spec, submission);
    assert.deepEqual(checks, [], reply);
    assert.match(note!, /Reviewer unavailable or unparseable/);
  }
  const thrown = await review(async () => { throw new Error('rate limited'); }, judge, spec, submission);
  assert.deepEqual(thrown.checks, []);
  assert.match(thrown.note!, /rate limited/);
});

test('absent reviewed paths are a note, not a defect', async () => {
  const { checks, note } = await review(stub('{}'), judge, spec, {});
  assert.deepEqual(checks, []);
  assert.match(note!, /absent from the submission/);
});

test('repeats settle by majority and report how many rounds agreed', () => {
  const defect = (id: string, d: boolean) => ({ id, defect: d, evidence: d ? 'a.py:1 | def f():' : '' });
  const rounds = [[defect('dup', true), defect('abs', false)], [defect('dup', true), defect('abs', true)], [defect('dup', false), defect('abs', false)]];
  const checks = settle(rounds, items);
  assert.equal(checks.find(c => c.id === 'design-dup')!.passed, false, '2 of 3 saw the defect');
  assert.match(checks.find(c => c.id === 'design-dup')!.evidence, /2\/3 rounds agreed/);
  assert.equal(checks.find(c => c.id === 'design-abs')!.passed, true, '1 of 3 is not a majority');
  // An even split is not evidence of a defect.
  assert.equal(settle([[defect('dup', true)], [defect('dup', false)]], [items[0]!])[0]!.passed, true);
});

test('authorship signals are stripped but comments survive review', () => {
  const blinded = blind({ 'a.py': '# written by Claude Sonnet for OpenAI parity\nx = 1  # set x\n' }, ['a.py']);
  assert(!/claude|sonnet|openai/i.test(blinded['a.py']!), 'model and vendor names go');
  assert.match(blinded['a.py']!, /# set x/, 'comments stay: unnecessary comments are a thing being judged');
  assert.deepEqual(blind({ 'a.py': 'x', 'secret.py': 'y' }, ['a.py']), { 'a.py': 'x' }, 'only reviewed paths are sent');
});

test('the prompt anchors on the reference and numbers every line', () => {
  const prompt = judgePrompt(spec, submission);
  assert.match(prompt, /Reference solution \(scale anchor/);
  assert.match(prompt, /1\tdef f\(\):/);
  for (const item of items) assert(prompt.includes(item.ask), item.id);
  assert.match(JUDGE_RUBRIC, /untrusted data/);
  assert.match(JUDGE_RUBRIC, /discarded and scored as false/);
});

test('the reviewer is part of the experiment identity', () => {
  assert.equal(judgeIdentity(null), 'none');
  assert.equal(judgeIdentity({ ...judge, enabled: false }), 'none', 'a disabled judge is not an experiment variable');
  const base = judgeIdentity(judge);
  assert.notEqual(base, judgeIdentity({ ...judge, model: 'other' }));
  assert.notEqual(base, judgeIdentity({ ...judge, repeat: 3 }));
  assert.notEqual(base, judgeIdentity({ ...judge, thinking: 'high' }));
  assert.equal(base, judgeIdentity({ ...judge }));
});

test('parseFindings requires an answer to every question', () => {
  assert.throws(() => parseFindings(JSON.stringify({ findings: [{ id: 'dup', defect: true, evidence: '' }] }), items), /skipped question: abs/);
  const fenced = parseFindings('```json\n{"findings":[{"id":"dup","defect":false,"evidence":""},{"id":"abs","defect":false,"evidence":""}]}\n```', items);
  assert.equal(fenced.length, 2, 'a fenced reply is still readable');
});
