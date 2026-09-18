import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { App } from '../src/app.ts';
import { authInfo, catalogModels, validateCredential } from '../src/auth.ts';
import { failureStatus, runAgent, safeError, taskTools } from '../src/adapter.ts';
import { DEFAULT_CONFIG, DEFAULT_JUDGE, DEFAULT_OPTIONS, loadSuite, validateConfig, validateJudge, validateOptions } from '../src/config.ts';
import { atomicJson, files, inside, localDir, put } from '../src/files.ts';
import { comparisonKey, comparisonReport, correctness, dimensionScore, median } from '../src/report.ts';
import { agentOf, applicableDimensions, blankTrial, listRuns, rejectArtifacts, runBenchmark, schedule, validateChecks } from '../src/runner.ts';
import { CLAUDE_CODE_ALLOWED, CLAUDE_CODE_DENIED, CLAUDE_CODE_JUDGE_DENIED, claudeCodeArgs, claudeCodeJudgeArgs, classify, resultMessage } from '../src/claudecode.ts';
import { checkSandbox, runPython } from '../src/sandbox.ts';
import type { Config, Dimension, ModelConfig, ToolEvent } from '../src/types.ts';
import type { JudgeCall } from '../src/judge.ts';

const root = process.cwd();
mkdirSync(join(root, '.tmp'), { recursive: true });
const temp = () => mkdtempSync(join(root, '.tmp/framework-'));
function workspace() {
  const dir = temp();
  cpSync(join(root, 'suites/personal'), join(dir, 'suites/personal'), { recursive: true });
  cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(root, 'package-lock.json'), join(dir, 'package-lock.json'));
  cpSync(join(root, 'package.json'), join(dir, 'package.json'));
  atomicJson(dir, 'forseti.json', DEFAULT_CONFIG);
  return dir;
}
const cfg = () => structuredClone(DEFAULT_CONFIG);
const task = loadSuite(root, 'suites/personal/suite.json').suite.tasks[0];

test('paths, links, special files and oversized outputs fail closed', () => {
  const dir = temp(); const outside = temp(); put(outside, 'secret', 'private');
  for (const p of ['../escape', join(outside, 'file')]) assert.throws(() => put(dir, p, 'x'), /escapes/);
  symlinkSync(outside, join(dir, 'link'));
  assert.throws(() => inside(dir, 'link/secret'), /Links/);
  symlinkSync(join(outside, 'absent'), join(dir, 'dangling'));
  assert.throws(() => put(dir, 'dangling', 'x'), /Links/);
  linkSync(join(outside, 'secret'), join(dir, 'hard'));
  assert.throws(() => put(dir, 'hard', 'x'), /Links/);
  assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'private');
  assert.throws(() => put(dir, 'huge', 'x'.repeat(131073)), /128 KiB/);
  assert.throws(() => validateConfig(root, { ...cfg(), suite: '../outside.json' }), /escapes/);
});

test('real OS sandbox denies hidden reads, escapes, network, fork, links and host secrets', async () => {
  const dir = temp(); await checkSandbox(dir);
  put(dir, 'private.txt', 'hidden-answer'); const publicDir = localDir(dir, 'public');
  const source = `import os,json,pathlib\nresult=[]\nfor action in [lambda:os.fork(),lambda:os.link('../private.txt','copy')]:\n try:action();result.append(False)\n except PermissionError:result.append(True)\nos.symlink('../private.txt','link')\ntry:pathlib.Path('link').read_text();result.append(False)\nexcept PermissionError:result.append(True)\nresult.append(not any(k.endswith('API_KEY') or k.endswith('TOKEN') for k in os.environ))\npathlib.Path('allowed.txt').write_text('inside')\nprint(json.dumps(result))`;
  const r = await runPython(publicDir, source);
  assert.equal(r.code, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), [true, true, true, true]);
  assert.equal(readFileSync(join(publicDir, 'allowed.txt'), 'utf8'), 'inside');
  assert.equal(readFileSync(join(dir, 'private.txt'), 'utf8'), 'hidden-answer');
  assert.throws(() => files(publicDir), /Links/);
  const deadline = await runPython(localDir(dir, 'timeout'), 'while True: pass', undefined, 120);
  assert.equal(deadline.timedOut, true);
  const flood = await runPython(localDir(dir, 'flood'), "print('x'*400000)");
  assert.equal(flood.timedOut, true); assert.ok(flood.stdout.length <= 256 * 1024);
});

test('strict settings, explicit billing, instruction-only rubrics and seeded schedules', () => {
  for (const o of [{ repeat: 0 }, { repeat: 21 }, { timeout: NaN }, { lane: 'shell' }, { seed: -1 }]) assert.throws(() => validateOptions({ ...DEFAULT_OPTIONS, ...o } as typeof DEFAULT_OPTIONS));
  assert.throws(() => validateConfig(root, { ...cfg(), models: [cfg().models[0], cfg().models[0]] }), /Duplicate/);
  assert.throws(() => validateChecks([]));
  assert.throws(() => validateChecks([{ id: 'x', dimension: 'hygiene', passed: 'yes', evidence: '' }]), /Invalid\/duplicate grader check/, 'passed must be a boolean');
  assert.throws(() => validateChecks([{ id: 'x', dimension: 'quality', passed: true, evidence: '' }]), /Invalid\/duplicate grader check/, 'quality was renamed to hygiene and is no longer a dimension');
  assert.equal(validateChecks([{ id: 'pause', dimension: 'instructions', passed: true, evidence: 'No change' }]).length, 1);
  const tasks = loadSuite(root, 'suites/personal/suite.json').suite.tasks;
  assert.deepEqual(schedule(cfg().models, tasks, 2, 42), schedule(cfg().models, tasks, 2, 42));
  assert.notDeepEqual(schedule(cfg().models, tasks, 2, 42), schedule(cfg().models, tasks, 2, 43));
  assert.equal(schedule(cfg().models, tasks, 2, 42).length, tasks.length * cfg().models.length * 2);
  assert.equal(failureStatus('quota exhausted'), 'rate_limited');
  assert.equal(failureStatus('Forbidden', 403), 'auth_error');
  assert.equal(failureStatus('server error', 500), 'provider_error');
  assert.equal(authInfo(cfg().models[0]).billing, 'control');
  assert.doesNotMatch(safeError('Bearer SECRET sk-secret123'), /SECRET|secret123/);
  // A reviewer is a real model reached by one of two clients, and nothing else.
  const judge = (over: Partial<typeof DEFAULT_JUDGE>) => validateJudge({ ...DEFAULT_JUDGE, ...over });
  assert.doesNotThrow(() => judge({ provider: 'claude-code', model: 'haiku', auth: 'cli' }));
  assert.throws(() => judge({ provider: 'claude-code', model: 'haiku', auth: 'pi' }), /auth "cli"/);
  assert.throws(() => judge({ provider: 'claude-code', model: 'gpt-5.5', auth: 'cli' }), /one of/);
  assert.throws(() => judge({ provider: 'openai-codex', auth: 'cli' }), /only for the claude-code provider/);
  assert.throws(() => judge({ provider: 'control', model: 'reference' }), /not a synthetic control/);
  assert.throws(() => judge({ repeat: 0 }), /1–5/);
  assert.equal(claudeCodeJudgeArgs('haiku').includes('--max-turns'), true);
  assert.equal(claudeCodeJudgeArgs('haiku').at(-1), '3', 'a rejected tool call must not consume the only turn');
  for (const tool of ['Read', 'Write', 'Bash', 'WebFetch']) assert.match(CLAUDE_CODE_JUDGE_DENIED, new RegExp(`\\b${tool}\\b`), `${tool} must be denied to a reviewer`);
});

test('all independent controls run through real sandbox, persist and compare with evidence', async () => {
  const dir = workspace();
  const run = await runBenchmark(dir, cfg(), { ...DEFAULT_OPTIONS, repeat: 1 });
  assert.equal(run.trials.length, loadSuite(root, 'suites/personal/suite.json').suite.tasks.length * cfg().models.length);
  for (const t of run.trials) {
    assert.equal(t.status, t.model === 'control-reference' ? 'passed' : 'failed', `${t.task}: ${t.error ?? JSON.stringify(t.checks.filter(c => !c.passed))}`);
    assert.equal(t.tokens, null); assert.equal(t.estimatedCost, null); assert.equal(t.auth.billing, 'control');
    assert.ok(existsSync(join(dir, 'runs', run.id, 'trials', t.id, 'events.jsonl')));
  }
  assert.ok(run.trials.some(t => t.checks.some(c => c.dimension === 'hygiene')));
  assert.equal(readFileSync(join(dir, 'runs', run.id, 'harness/src/runner.ts'), 'utf8'), readFileSync(join(dir, 'src/runner.ts'), 'utf8'));
  assert.equal(listRuns(dir)[0].status, 'completed');
  const report = comparisonReport([run]);
  assert.match(report, /Synthetic controls/); assert.match(report, /actual=/); assert.match(report, /expected=/); assert.match(report, /No claim about hidden model reasoning/);
  const ablation = structuredClone(run); ablation.options.lane = 'prompt';
  assert.match(comparisonReport([run, ablation]), /Not a controlled model comparison/);
  assert.equal(correctness([]).rate, null); assert.equal(dimensionScore([], 'tools').rate, null); assert.equal(median([]), null);
  assert.ok(!report.includes('NaN'));
});

test('a reviewer adds a design score without ever turning its own failures into model failures', async t => {
  const dir = workspace();
  // A stubbed reviewer still goes through the real auth preflight, so give it a credential this
  // test owns rather than depending on whatever is logged in on the machine.
  const savedKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-only-never-sent';
  t.after(() => { if (savedKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = savedKey; });
  const withJudge = (): Config => ({ ...cfg(), judge: { ...DEFAULT_JUDGE, enabled: true, provider: 'groq', model: 'stub', auth: 'env' } });
  const opts = { ...DEFAULT_OPTIONS, repeat: 1, tests: ['duplicate-rule'], allowMetered: true };
  const judged = (reply: string | (() => never)) => () => (async () => (typeof reply === 'function' ? reply() : reply)) as JudgeCall;

  // The reference is clean, so an honest reviewer finds nothing and the trial still passes.
  const clean = await runBenchmark(dir, withJudge(), { ...opts, models: ['control-reference'] }, undefined, undefined,
    judged(JSON.stringify({ findings: ['rule-duplicated', 'unearned-abstraction', 'dead-code', 'explanatory-noise'].map(id => ({ id, defect: false, evidence: '' })) })));
  const pass = clean.trials[0]!;
  assert.equal(pass.status, 'passed');
  assert.equal(pass.checks.filter(c => c.dimension === 'design').length, 4);
  assert.equal(clean.judge?.enabled, true, 'the reviewer is recorded in the manifest');
  assert.notEqual(comparisonKey(clean), comparisonKey({ ...clean, judge: null }), 'changing the reviewer starts a new experiment');

  // A cited defect scores; an uncited one is discarded rather than charged to the candidate.
  const mixed = await runBenchmark(dir, withJudge(), { ...opts, models: ['control-reference'] }, undefined, undefined,
    judged(JSON.stringify({ findings: [
      { id: 'rule-duplicated', defect: true, evidence: 'retries.py:5 | def should_retry(job):' },
      { id: 'unearned-abstraction', defect: true, evidence: 'retries.py:2 | class RetryPolicyFactory:' },
      { id: 'dead-code', defect: false, evidence: '' }, { id: 'explanatory-noise', defect: false, evidence: '' },
    ] })));
  const scored = mixed.trials[0]!;
  assert.equal(scored.status, 'failed', 'a design defect is scored, not ignored');
  assert.equal(scored.checks.filter(c => c.dimension === 'correctness').every(c => c.passed), true);
  assert.equal(correctness(mixed.trials).rate, 1, 'design never touches the correctness headline');
  assert.equal(scored.checks.find(c => c.id === 'design-unearned-abstraction')!.passed, true, 'invented defect discarded');

  // A reviewer that cannot run leaves a note and no design checks. It must not fail the trial.
  const broken = await runBenchmark(dir, withJudge(), { ...opts, models: ['control-reference'] }, undefined, undefined,
    judged(() => { throw new Error('usage limit reached'); }));
  assert.equal(broken.trials[0]!.status, 'passed');
  assert.equal(broken.trials[0]!.checks.filter(c => c.dimension === 'design').length, 0);
  assert.match(broken.trials[0]!.judgeNote!, /usage limit reached/);
  assert.match(comparisonReport([broken]), /reviewer did not score/i);

  // Wrong code is never reviewed: correctness gates the reviewer.
  const wrong = await runBenchmark(dir, withJudge(), { ...opts, models: ['control-baseline'] }, undefined, undefined,
    judged(() => { throw new Error('the reviewer must not be called at all'); }));
  assert.equal(wrong.trials[0]!.status, 'failed');
  assert.match(wrong.trials[0]!.judgeNote!, /Not reviewed: \d+ correctness check/);

  // With the reviewer off, nothing about design is produced or recorded.
  const off = await runBenchmark(dir, cfg(), { ...opts, models: ['control-reference'] }, undefined, undefined,
    judged(() => { throw new Error('a disabled reviewer must never be constructed'); }));
  assert.equal(off.judge, null);
  assert.equal(off.trials[0]!.checks.some(c => c.dimension === 'design'), false);
  assert.equal(off.trials[0]!.judgeNote, undefined);
});

test('cancelled plans, stale/incomplete manifests and verifier crashes remain distinguishable', async () => {
  const dir = workspace();
  const c = new AbortController(); c.abort();
  const stopped = await runBenchmark(dir, cfg(), { ...DEFAULT_OPTIONS, repeat: 1, tests: [task.id] }, undefined, c.signal);
  assert.equal(stopped.status, 'cancelled'); assert.ok(stopped.trials.every(t => t.status === 'cancelled'));
  const stale = structuredClone(stopped); stale.status = 'running';
  atomicJson(dir, `runs/${stale.id}/run.json`, stale);
  assert.equal(listRuns(dir)[0].status, 'interrupted');
  writeFileSync(join(dir, 'suites/personal/private/shared-count.mjs'), "export const reference={}; export async function grade(){throw new Error('intentional verifier crash')}");
  const bad = await runBenchmark(dir, cfg(), { ...DEFAULT_OPTIONS, repeat: 1, models: ['control-reference'], tests: [task.id] });
  assert.equal(bad.trials[0].status, 'harness_error'); assert.equal(correctness(bad.trials).rate, null);
  assert.match(bad.trials[0].error!, /intentional verifier crash/);
  assert.ok(!existsSync(join(dir, '.state/run.lock')));
});

test('a lock removed underneath a run does not discard the finished run', async () => {
  const dir = workspace();
  const opts = { ...DEFAULT_OPTIONS, repeat: 1, models: ['control-reference'], tests: ['pause-correction'] };
  // Someone clearing a stale lock by hand is the realistic case, and it must not turn a run that
  // already finished and saved every trial into "Run stopped".
  const run = await runBenchmark(dir, cfg(), opts, p => {
    if (p.phase === 'preparing') rmSync(join(dir, '.state/run.lock'), { force: true });
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.trials.length, 1);
  assert.equal(listRuns(dir)[0]!.id, run.id, 'and it is listed');
});

test('missing auth stops the provider cohort without fallback; metered consent precedes calls', async () => {
  const saved = process.env.CEREBRAS_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  try {
    const dir = workspace(), config = cfg();
    const native = catalogModels.getModels('cerebras')[0]; assert.ok(native);
    config.models = ['one', 'two'].map(id => ({ id, label: id, provider: 'cerebras', model: native.id, auth: 'env', enabled: true, thinking: 'off' }));
    const run = await runBenchmark(dir, config, { ...DEFAULT_OPTIONS, repeat: 1, tests: [task.id] });
    assert.deepEqual(run.trials.map(t => t.status).sort(), ['auth_error', 'skipped']);
    assert.ok(run.trials.every(t => t.tokens === null));
    process.env.CEREBRAS_API_KEY = 'test-only-not-a-key';
    await assert.rejects(runBenchmark(dir, config, { ...DEFAULT_OPTIONS, repeat: 1 }), /allow-metered/);
  } finally { if (saved === undefined) delete process.env.CEREBRAS_API_KEY; else process.env.CEREBRAS_API_KEY = saved; }
});

test('real Pi agent loop records tools, usage, schema errors and budgets using an offline provider', async () => {
  const dir = temp(); put(dir, 'input.txt', 'public');
  const provider = fauxProvider(); const models = createModels(); models.setProvider(provider.provider);
  const native = provider.getModel();
  const model: ModelConfig = { id: 'simulated', label: 'Test-only fake', provider: native.provider, model: native.id, auth: 'none', enabled: true, thinking: 'off' };
  const t = blankTrial('fake', cfg().models[0], task, 1);
  provider.setResponses([
    fauxAssistantMessage([fauxToolCall('read_file', { path: 'input.txt' }), fauxToolCall('write_file', { path: 'answer.txt', content: 'done' }), fauxToolCall('unknown_tool', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('Done')]),
  ]);
  const records: unknown[] = [];
  await runAgent(dir, model, task, DEFAULT_OPTIONS, t, new AbortController().signal, () => {}, e => records.push(e), models);
  assert.equal(t.status, 'passed'); assert.equal(t.answer, 'Done'); assert.equal(t.turns, 2);
  assert.deepEqual(t.trace.map(e => [e.tool, e.ok]), [['read_file', true], ['write_file', true], ['unknown_tool', false]]);
  assert.ok(t.tokens!.output > 0); assert.ok(t.modelMs > 0); assert.ok(t.firstTokenMs !== null); assert.ok(records.length);
  provider.setResponses([fauxAssistantMessage([fauxToolCall('list_files', {})], { stopReason: 'toolUse' })]);
  const budget = blankTrial('budget', cfg().models[0], task, 1);
  await runAgent(dir, model, task, { ...DEFAULT_OPTIONS, maxTurns: 1 }, budget, new AbortController().signal, () => {}, () => {}, models);
  assert.equal(budget.status, 'budget');
  provider.setResponses([fauxAssistantMessage([], { stopReason: 'error', errorMessage: '429 usage_limit reached' })]);
  const limit = blankTrial('limit', cfg().models[0], task, 1);
  await runAgent(dir, model, task, DEFAULT_OPTIONS, limit, new AbortController().signal, () => {}, () => {}, models);
  assert.equal(limit.status, 'rate_limited');
});

test('prompt caching is on by default, reaches the provider, and never pools with uncached runs', async () => {
  const dir = temp(); put(dir, 'input.txt', 'public');
  const provider = fauxProvider(); const models = createModels(); models.setProvider(provider.provider);
  const native = provider.getModel();
  const model: ModelConfig = { id: 'simulated', label: 'Test-only fake', provider: native.provider, model: native.id, auth: 'none', enabled: true, thinking: 'off' };
  const seen: unknown[] = [];
  const spy: typeof models = Object.create(models, { streamSimple: { value: (...args: Parameters<typeof models.streamSimple>) => { seen.push(args[2]?.cacheRetention); return models.streamSimple(...args); } } });
  for (const cache of [true, false]) {
    provider.setResponses([fauxAssistantMessage([fauxText('Done')])]);
    await runAgent(dir, model, task, { ...DEFAULT_OPTIONS, cache }, blankTrial('c', cfg().models[0], task, 1), new AbortController().signal, () => {}, () => {}, spy);
  }
  assert.equal(DEFAULT_OPTIONS.cache, true, 'caching must default on so repeated input is not paid for twice');
  assert.deepEqual(seen, ['short', 'none']);

  const base = { schema: 1, id: 'r', created: 'now', status: 'completed', suite: 's', suiteHash: 'a', harnessHash: 'b', environment: {}, models: [], tasks: [], planned: 0, trials: [] } as const;
  const key = (cache: boolean) => comparisonKey({ ...base, options: { ...DEFAULT_OPTIONS, cache } } as never);
  assert.notEqual(key(true), key(false), 'cached and uncached runs must land in separate report groups');
});

test('Claude Code runs under the first-party login, never an API key, and never pools with the Pi harness', () => {
  const cc = (model: string): ModelConfig => ({ id: `cc-${model}`, label: model, provider: 'claude-code', model, auth: 'cli', enabled: true, thinking: 'off' });
  const pi: ModelConfig = { id: 'pi', label: 'pi', provider: 'openai-codex', model: 'gpt-5.5', auth: 'pi', enabled: true, thinking: 'off' };

  // Billing is the subscription, never metered: no PAY gate, and no API key can be charged.
  const auth = authInfo(cc('sonnet'));
  assert.equal(auth.billing, 'subscription');
  assert.match(auth.note, /no API key is used/);

  // Every credential variable that could divert billing to a metered key is stripped.
  const args = claudeCodeArgs('sonnet', 7).join(' ');
  for (const flag of ['--safe-mode', '--permission-mode dontAsk', '--permission-prompts none', '--max-turns 7', '--model sonnet']) assert.ok(args.includes(flag), flag);
  // --allowedTools only pre-approves; only --disallowedTools removes a tool from the session.
  assert.ok(args.includes(`--disallowedTools ${CLAUDE_CODE_DENIED}`), 'tools must be denied, not merely left un-approved');
  for (const denied of ['Bash', 'Task', 'WebFetch', 'WebSearch']) assert.ok(CLAUDE_CODE_DENIED.split(',').includes(denied), denied);
  assert.ok(!args.includes('--bare'), '--bare would drop the subscription login and demand an API key');
  assert.ok(!CLAUDE_CODE_ALLOWED.split(',').includes('Bash'), 'this lane runs outside the sandbox, so it gets no shell');

  // The CLI streams the session as an array; the answer is the last result entry, not the first.
  const stream = JSON.stringify([{ type: 'system' }, { type: 'assistant' }, { type: 'result', result: 'done', num_turns: 3 }]);
  assert.equal(resultMessage(stream)?.result, 'done');
  assert.equal(resultMessage(JSON.stringify({ result: 'plain' }))?.result, 'plain');
  assert.equal(resultMessage('not json'), undefined);
  // A limit phrase inside the transcript must not be read as a provider limit.
  assert.equal(resultMessage(JSON.stringify([{ type: 'assistant', result: 'weekly limit' }])), undefined);

  // Mixing harnesses would measure the harness, not the model.
  assert.equal(agentOf([pi, cfg().models[0]]), 'pi');
  assert.equal(agentOf([cc('sonnet'), cc('haiku'), cfg().models[0]]), 'claude-code');
  assert.throws(() => agentOf([cc('sonnet'), pi]), /different harnesses/);

  // Claude Code's trace cannot satisfy a rubric written for Forseti's tool names.
  const withTools = { ...task, dimensions: ['correctness', 'tools'] as Dimension[] };
  assert.deepEqual(applicableDimensions(withTools, 'tools', false, 'pi'), ['correctness', 'tools']);
  assert.deepEqual(applicableDimensions(withTools, 'tools', false, 'claude-code'), ['correctness']);

  // Provider messages decide the outcome; a plan limit stops the provider instead of retrying.
  assert.equal(classify("You've hit your Sonnet limit", 1), 'rate_limited');
  assert.equal(classify('Please run /login', 1), 'auth_error');
  assert.equal(classify('some tool failed', 0), 'failed');

  const key = (models: ModelConfig[], agent: string) => comparisonKey({
    schema: 1, id: 'r', created: 'now', status: 'completed', suite: 's', suiteHash: 'a', harnessHash: 'b',
    environment: { agent }, options: DEFAULT_OPTIONS, models, tasks: [], planned: 0, trials: [],
  } as never);
  assert.notEqual(key([cc('sonnet')], 'claude-code'), key([pi], 'pi'));
});

test('model tools cannot reach private paths and prompt-lane traversal is a model output failure', async () => {
  const dir = temp(); const work = localDir(dir, 'public'); put(dir, 'answer.txt', 'hidden');
  const trace: ToolEvent[] = [];
  const tools = taskTools(work, trace, new AbortController().signal, () => {});
  await assert.rejects(tools.find(t => t.name === 'read_file')!.execute('x', { path: '../answer.txt' }), /escapes/);
  await assert.rejects(tools.find(t => t.name === 'write_file')!.execute('x', { path: '../answer.txt', content: 'overwrite' }), /escapes/);
  assert.ok(trace.every(t => !t.ok)); assert.equal(readFileSync(join(dir, 'answer.txt'), 'utf8'), 'hidden');
  const p = fauxProvider(); const models = createModels(); models.setProvider(p.provider); const m = p.getModel();
  const mc: ModelConfig = { id: 'fake', label: 'Fake', provider: m.provider, model: m.id, auth: 'none', enabled: true, thinking: 'off' };
  p.setResponses([fauxAssistantMessage([fauxText('{"files":{"../answer.txt":"overwrite"}}')])]);
  const t = blankTrial('escape', cfg().models[0], task, 1);
  await runAgent(work, mc, task, { ...DEFAULT_OPTIONS, lane: 'prompt' }, t, new AbortController().signal, () => {}, () => {}, models);
  assert.equal(t.status, 'failed'); assert.equal(t.checks[0].id, 'safe-output');
  assert.equal(readFileSync(join(dir, 'answer.txt'), 'utf8'), 'hidden');
});

test('add model/test and reversible lifecycle work without touching external references', async () => {
  const dir = workspace(); const app = new App(dir); await app.refresh();
  app.addTest('new-json', 'Return answer seven', '{"answer":7}');
  await app.refresh(); assert.ok(app.suite.tasks.some(t => t.id === 'new-json'));
  const run = await app.run({ ...DEFAULT_OPTIONS, repeat: 1, tests: ['new-json'], models: ['control-reference'] }, () => {}, new AbortController().signal);
  assert.equal(run.trials[0].status, 'passed');
  app.config.removedTests.push('new-json'); app.persist(); await app.refresh();
  assert.ok(app.config.removedTests.includes('new-json'));
  assert.ok(existsSync(join(dir, 'suites/personal/private/new-json.mjs')));
  assert.throws(() => app.addTest('../escape', 'x', '1'));
  assert.throws(() => app.addTest('new-json', 'overwrite', '1'));
  assert.throws(() => app.addModel('missing', 'missing', 'env'));
  assert.ok(existsSync(join(dir, app.exportReport([run.id]))));
});

test('grading is read-only even for import-time effects; saved artifacts stay truthful', async () => {
  const dir = workspace(), app = new App(dir); await app.refresh();
  app.addTest('import-write', 'Do not modify context.txt', 'null');
  const grader = `export const reference={files:{'candidate.py':"from pathlib import Path\\nPath('context.txt').write_text('tampered')\\n"}};
export async function grade({python}) {
 const r=await python('import candidate');
 return [{id:'runs',dimension:'correctness',passed:r.code===0,evidence:r.stderr}, {id:'scope',dimension:'instructions',passed:r.code===0,evidence:'Import must not write protected files'}];
}`;
  writeFileSync(join(dir, 'suites/personal/private/import-write.mjs'), grader);
  const run = await app.run({ ...DEFAULT_OPTIONS, repeat: 1, models: ['control-reference'], tests: ['import-write'] }, () => {}, new AbortController().signal);
  const t = run.trials[0]; assert.equal(t.status, 'failed');
  assert.match(t.checks[0].evidence, /PermissionError/);
  const actual = readFileSync(join(dir, 'runs', run.id, 'trials', t.id, 'public/context.txt'), 'utf8');
  assert.equal(actual, t.files['context.txt']); assert.notEqual(actual, 'tampered');
});

test('invalid submissions cannot inflate correctness or overwrite censored outcomes', () => {
  const invalid = blankTrial('invalid', cfg().models[0], task, 1);
  rejectArtifacts(invalid, task, 'prompt', false, 'path traversal');
  assert.equal(correctness([invalid]).rate, 0);
  assert.ok(!invalid.checks.some(c => c.dimension === 'tools'));
  const good = structuredClone(invalid); good.checks.forEach(c => { c.passed = true; }); good.status = 'passed';
  assert.equal(correctness([good, ...Array(9).fill(invalid)]).rate, 0.1);
  for (const status of ['timeout', 'cancelled', 'provider_error', 'budget'] as const) {
    const censored = blankTrial(status, cfg().models[0], task, 1); censored.status = status;
    rejectArtifacts(censored, task, 'tools', false, 'symlink');
    assert.equal(censored.status, status); assert.equal(correctness([censored]).rate, null);
    assert.match(censored.error!, /symlink/);
  }
  assert.throws(() => validateChecks([{id:'x',dimension:'instructions',passed:true,evidence:'x'}], ['correctness']), /declared/);
});

test('instruction-only comparisons retain differences and selected task sets do not mix', async () => {
  const dir = workspace();
  const run = await runBenchmark(dir, cfg(), { ...DEFAULT_OPTIONS, repeat: 1, tests: ['pause-correction'] });
  const report = comparisonReport([run]);
  assert.match(report, /latest-instruction/); assert.match(report, /Left evidence:/);
  assert.match(report, /pairs without a correctness rubric/);
  assert.doesNotMatch(report, /No differing matched checks observed/);
  const different = structuredClone(run); different.tasks = [{ ...run.tasks[0], hash: 'different-task' }];
  assert.match(comparisonReport([run, different]), /Not a controlled model comparison/);
});

test('read-only OAuth preflight agrees with Pi five-minute validity window', () => {
  const token = { type: 'oauth' as const, access: 'test-only', refresh: 'test-only', expires: Date.now() + 4 * 60_000 };
  assert.throws(() => validateCredential(token), /near expiry/);
  assert.doesNotThrow(() => validateCredential({ ...token, expires: Date.now() + 6 * 60_000 }));
  assert.throws(() => validateCredential({ type: 'api_key', key: '!some-command' }), /Command/);
});
