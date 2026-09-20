import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Dashboard, terminalText } from '../src/tui.ts';
import { DEFAULT_JUDGE } from '../src/config.ts';
import type { AuthInfo, Config, ModelConfig, Progress, Run, RunOptions, Suite } from '../src/types.ts';

const enter = '\r';
const esc = '\x1b';
const down = '\x1b[B';
const up = '\x1b[A';
const auth: AuthInfo = { mode: 'pi', billing: 'subscription', ready: true, note: 'Existing subscription' };
const model: ModelConfig = { id: 'example', label: 'Example model', provider: 'example', model: 'model-one', auth: 'pi', enabled: true, thinking: 'off' };
const options: RunOptions = { repeat: 2, seed: 42, lane: 'tools', timeout: 90, maxTurns: 12, maxTokens: 4096, allowMetered: false, cache: true };
function fixture(billing: AuthInfo['billing'] = 'subscription', rows = 24) {
  const calls: RunOptions[] = [];
  let aborted = false;
  let saves = 0;
  let refreshes = 0;
  let exported: string[] = [];
  let resolveRun: ((run: Run) => void) | undefined;
  const run: Run = {
    schema: 1, id: 'run-001', created: '2026-01-01', status: 'completed', suite: 'suite', suiteHash: 'a', harnessHash: 'b', environment: {}, judge: null,
    options, models: [model], tasks: [{ id: 'json', title: 'JSON test', hash: 'c' }], planned: 2,
    trials: [{ id: 'trial-1', model: 'example', task: 'json', repetition: 1, status: 'failed', auth,
      checks: [{ id: 'exact', dimension: 'correctness', passed: false, evidence: 'Expected 42, observed 41.\x1b]52;c;SECRET\x07' }],
      wallMs: 100, modelMs: 70, toolMs: 20, gradeMs: 10, firstTokenMs: null, tokens: null, estimatedCost: null, trace: [], answer: '41', files: {}, turns: 1 }],
  };
  const app = {
    root: process.cwd(),
    config: { schema: 1, suite: 'suite', models: [structuredClone(model)], disabledTests: [], removedTests: [], judge: { ...DEFAULT_JUDGE } } as Config,
    suite: { schema: 1, id: 'suite', title: 'Independent benchmark', tasks: [{ id: 'json', title: 'JSON test', tags: ['json'], dimensions: ['correctness', 'instructions'], prompt: 'Return 42.', fixture: 'fixtures/json', grader: 'private/json.mjs' }] } as Suite,
    catalog: [
      { provider: 'example', id: 'model-one', name: 'Example model', auth: { ...auth, billing } },
      { provider: 'other', id: 'model-two', name: 'Second model', auth: { ...auth, ready: false, note: 'Credentials missing', billing: 'unknown' as const } },
    ],
    runs: [run],
    authFor(selected: ModelConfig): AuthInfo {
      return { ...auth, mode: selected.auth, billing: selected.auth === 'env' ? 'metered' : billing };
    },
    persist() { saves++; },
    async refresh() { refreshes++; },
    run(opts: RunOptions, progress: (p: Progress) => void, signal: AbortSignal): Promise<Run> {
      calls.push(opts);
      progress({ completed: 1, total: 2, model: 'Example', task: 'json', phase: 'grading', runId: run.id });
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(resolve => { resolveRun = resolve; });
    },
    compare(ids: string[]) { return `# Comparison\n${ids.join(', ')}\n${'Evidence row\n'.repeat(20)}`; },
    exportReport(ids: string[]) { exported = ids; return 'reports/comparison.md'; },
    addModel(provider: string, id: string, mode: ModelConfig['auth']) { this.config.models.push({ ...model, id: 'added', provider, model: id, auth: mode }); },
    addTest(id: string, prompt: string, expected: string) { JSON.parse(expected); this.suite.tasks.push({ id, title: id, prompt, fixture: `fixtures/${id}`, grader: `private/${id}.mjs`, tags: [], dimensions: ['correctness', 'instructions'], capabilities: ['exactness'] }); },
  };
  let renders = 0;
  let exits = 0;
  const ui = new Dashboard(app, () => { renders++; }, () => { exits++; }, () => rows);
  const text = (width = 80) => ui.render(width).map(stripVTControlCharacters).join('\n');
  const key = (...keys: string[]) => keys.forEach(k => ui.handleInput(k));
  return { ui, app, run, calls, text, key, get saves() { return saves; }, get aborted() { return aborted; }, get renders() { return renders; }, get exits() { return exits; }, get refreshes() { return refreshes; }, get exported() { return exported; }, finish() { resolveRun?.({ ...run, status: aborted ? 'cancelled' : 'completed' }); } };
}

test('all views and dialogs fit 40/80/120 columns with clean content', () => {
  const f = fixture();
  f.app.config.models[0]!.label = '\x1b[31m危険\x1b[0m'.repeat(25) + '\x1b]52;c;SECRET\x07';
  f.app.suite.tasks[0]!.prompt = 'Long prompt 🧪 '.repeat(30) + '\x1b[2J';
  const check = () => {
    for (const width of [40, 80, 120]) {
      const rows = f.ui.render(width);
      assert.ok(rows.length);
      rows.forEach(row => assert.ok(visibleWidth(row) <= width, `width ${width}: ${visibleWidth(row)}`));
      const output = rows.join('\n');
      assert.ok(!output.includes('\x1b]52'));
      assert.ok(!output.includes('\x1b[2J'));
    }
  };
  for (const tab of ['1', '2', '3', '4', '5']) { f.key(tab); check(); }
  f.key('2', 'a'); check();
  f.key(enter); check();
  f.key(esc, '3', 'a'); check();
  f.key(esc, 'd'); check();
  f.key(esc, 'r'); check();
  f.key(esc, '4', 'c'); check();
  f.key(esc, enter); check();
  f.key(esc, '?'); check();
  assert.equal(f.calls.length, 0);
});

test('terminal text rejects OSC, DCS, ANSI, C1 and bidi controls', () => {
  assert.equal(terminalText('\x1b[31mred\x1b[0m\x1b]52;c;secret\x07\x1bPpayload\x1b\\\u202ehide\x00\nline'), 'redhide\nline');
  assert.equal(terminalText('safe\x1b_unsafe'), 'safe');
});

test('keyboard navigation, toggles, confirmed removal, settings and empty states', () => {
  const f = fixture();
  f.key('\t', ' ');
  assert.equal(f.app.config.models[0]!.enabled, false);
  f.key(' ');
  assert.equal(f.app.config.models[0]!.enabled, true);
  f.key('d', enter);
  assert.equal(f.app.config.models.length, 1);
  f.key('n', '3', ' ');
  assert.deepEqual(f.app.config.disabledTests, ['json']);
  f.key(' ');
  assert.deepEqual(f.app.config.disabledTests, []);
  f.key('d', 'y');
  assert.deepEqual(f.app.config.removedTests, ['json']);
  assert.match(f.text(), /No tests yet/);
  f.key('r');
  assert.equal(f.calls.length, 0);
  assert.match(f.text(), /Enable at least one/);
  f.key('1', '+', 'l');
  assert.match(f.text(), /3 repeats/);
  assert.match(f.text(), /prompt lane/);
  assert.ok(f.saves >= 5);
  f.key('q'); assert.equal(f.exits, 1);
});

test('filtered native catalog picker shows auth and adds only on explicit selection', () => {
  const f = fixture();
  f.key('2', 'a', 'Second');
  assert.match(f.text(), /Second model/);
  assert.match(f.text(), /NOT READY/);
  assert.match(f.text(), /Credentials missing/);
  f.key(enter);
  assert.match(f.text(), /Authentication/);
  assert.equal(f.app.config.models.length, 1);
  f.key(down, enter);
  assert.equal(f.app.config.models[1]!.model, 'model-two');
  assert.equal(f.app.config.models[1]!.auth, 'env');
  assert.equal(f.calls.length, 0);
  f.key('a', 'no-match');
  assert.match(f.text(), /No matching/i);
  f.key(enter, esc);
  assert.equal(f.app.config.models.length, 2);
});

test('test wizard validates each step, saves JSON and discards cancelled draft', () => {
  const f = fixture();
  f.key('3', 'a', 'Bad ID', enter);
  assert.match(f.text(), /lowercase slug/);
  f.key('\x15', 'answer-test', enter, 'Return the number 42.', enter, 'oops', enter);
  assert.equal(f.app.suite.tasks.length, 1);
  f.key('\x15', '42', enter);
  assert.equal(f.app.suite.tasks[1]!.id, 'answer-test');
  assert.equal(f.app.suite.tasks[1]!.prompt, 'Return the number 42.');
  f.key('a', 'discard-me', enter, esc);
  assert.equal(f.app.suite.tasks.length, 2);
});

for (const billing of ['metered', 'unknown'] as const) {
  test(`${billing}: never starts or opts into payment without PAY confirmation`, async () => {
    const f = fixture(billing);
    f.key('r');
    assert.match(f.text(), /Preflight/);
    assert.match(f.text(), new RegExp(billing));
    assert.equal(f.calls.length, 0);
    f.key(enter, enter, 'y', enter);
    assert.equal(f.calls.length, 0);
    f.key(esc, 'r', enter, 'PAY', esc);
    assert.equal(f.calls.length, 0);
    f.key('r', enter, 'PAY', enter);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.allowMetered, true);
    assert.deepEqual(f.calls[0]!.models, ['example']);
    assert.match(f.text(), /Running/);
    assert.match(f.text(), /grading/);
    f.key('r', 'q');
    assert.equal(f.calls.length, 1);
    assert.equal(f.exits, 0);
    f.key(esc);
    assert.equal(f.aborted, true);
    f.finish(); await Promise.resolve();
    assert.match(f.text(), /cancelled/);
    assert.equal(f.app.runs[0]!.trials.length, 1);
    f.key('r', enter, enter);
    assert.equal(f.calls.length, 1, 'consent must not carry to next run');
  });
}

test('subscription run needs preflight confirmation, Ctrl+C cancels; no automatic requests', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  f.key('r', esc);
  assert.equal(f.calls.length, 0);
  f.key('r', enter);
  assert.equal(f.calls[0]!.allowMetered, false);
  f.key('\x03'); assert.equal(f.aborted, true);
  f.finish(); await Promise.resolve();
  f.key('\x03'); assert.equal(f.exits, 1);
});

test('preflight uses effective selected auth, not catalog auth or UI heuristics', () => {
  const f = fixture();
  f.app.config.models[0]!.auth = 'env';
  f.key('r', enter);
  assert.match(f.text(), /Billing/);
  assert.equal(f.calls.length, 0);
  f.key(esc);
  f.app.authFor = () => ({ mode: 'env plan', billing: 'subscription', ready: false, note: 'Selected credentials expired' });
  f.key('r');
  assert.match(f.text(), /NOT READY/);
  assert.match(f.text(), /Selected credentials expired/);
  f.key(enter);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.allowMetered, false);
});

test('run selection, comparison, check-level evidence, scrolling and workspace export', () => {
  const f = fixture();
  f.key('4', ' ', 'c');
  // The summary opens first: bars and a per-task grid, not a wall of markdown.
  assert.match(f.text(), /Scorecard/);
  assert.match(f.text(), /[█░]{10}/);
  assert.match(f.text(), /all correct/);
  f.key('m');
  assert.match(f.text(), /Comparison/);
  f.key('m');
  assert.match(f.text(), /Scorecard/);
  f.key('m', down, 'e');
  assert.deepEqual(f.exported, ['run-001']);
  assert.match(f.text(), /reports\/comparison.md/);
  // gg / G jump to the ends; a lone g must not move anything.
  f.key('g', 'g');
  const top = f.text();
  f.key('G');
  const bottom = f.text();
  assert.notEqual(top, bottom, 'G should jump to the end of the report');
  f.key('g');
  assert.equal(f.text(), bottom, 'a single g only arms the sequence');
  f.key('g');
  assert.equal(f.text(), top, 'gg should return to the top');
  f.key('G', 'g', 'j', 'g');
  assert.notEqual(f.text(), top, 'an interrupted g sequence must not jump');

  f.key(esc, enter);
  // A graded trial says SCORED, never "failed": "failed" reads as "the test never ran".
  assert.match(f.text(), /SCORED/);
  assert.doesNotMatch(f.text(), /\bfailed\b/);
  assert.match(f.text(), /Why it did not pass/);
  assert.match(f.text(), /FAIL \[correctness\] exact/);
  assert.match(f.text(), /Expected 42, observed 41/);
  assert.ok(!f.text().includes('SECRET'));
  assert.ok(f.renders > 0);
});

test('persistence failure rolls configuration back and is visible', () => {
  const f = fixture();
  f.app.persist = () => { throw new Error('Disk full'); };
  f.key('2', ' ');
  assert.equal(f.app.config.models[0]!.enabled, true);
  assert.match(f.text(), /Disk full/);
});


test('run rejection clears busy state, allows editing and preserves backend evidence', async () => {
  const f = fixture();
  f.ui.focused = true;
  f.app.run = async () => { throw new Error('Provider failed\x1b[2J'); };
  f.key('r', enter);
  await Promise.resolve();
  assert.match(f.text(), /Run stopped: Provider failed/);
  assert.ok(!f.text().includes('Running'));
  assert.equal(f.app.runs[0]!.trials.length, 1);
  f.key('3', 'a', 'after-error', enter, 'Return 1.', enter, '1', enter);
  assert.equal(f.app.suite.tasks[1]!.id, 'after-error');
  f.key('q');
  assert.equal(f.exits, 1);
});

test('settings reach preflight and runtime, obey bounds and do not change while busy', () => {
  const f = fixture();
  f.key('1', '-', '-', '-');
  assert.match(f.text(), /1 repeat\b/);
  f.key(...Array<string>(105).fill('+'));
  assert.match(f.text(), /20 repeats/);
  // The per-trial limit is reachable without the CLI: a censored trial is otherwise unfixable.
  assert.match(f.text(), /Limit\s+180s\s+t/);
  f.key('t');
  assert.match(f.text(), /Limit\s+300s/);
  f.key('t', 't');
  assert.match(f.text(), /Limit\s+30s/, 'the ladder wraps');
  f.key('t', 't', 't', 't');
  f.key('T');
  assert.match(f.text(), /Turns\s+20/, 'the turn limit is reachable too');
  assert.equal(f.calls.length, 0, 'changing a budget starts nothing');
  f.key('l', 'r', enter);
  assert.equal(f.calls[0]!.repeat, 20);
  assert.equal(f.calls[0]!.lane, 'prompt');
  assert.equal(f.calls[0]!.timeout, 180, 'and it reaches the run');
  // A run is long, so looking around stays possible; changing anything does not.
  assert.match(f.text(), /Running/, 'Home shows the progress panel');
  assert.match(f.text(), /running · 1\/2/, 'the header carries the run');
  f.key('-', 'l', '3', 'a');
  assert.match(f.text(), /running · 1\/2/, 'still visible from another tab');
  assert.doesNotMatch(f.text(), /Running/, 'the progress panel belongs to Home');
  assert.equal(f.app.suite.tasks.length, 1, 'a does not open the add-test form while busy');
  f.key('q');
  assert.equal(f.exits, 0, 'q cannot quit out from under a live run');
  assert.equal(f.aborted, false, 'and it cannot cancel one either — leaving is now one key, cancelling still is not');
  assert.match(f.text(), /esc again to cancel it/);
  f.key('4');
  assert.match(f.text(), /Runs/);
  f.key('1');
  assert.match(f.text(), /Running/, 'Home still shows progress after wandering off');
  f.key(esc); f.finish();
});

test('hygiene reads as a gate, never as a score beside correctness', () => {
  const f = fixture();
  const hygiene = (passed: boolean) => ({ id: 'python-ast-parses', dimension: 'hygiene' as const, passed, evidence: 'parsed' });
  f.app.runs = [{ ...f.run, trials: [{ ...f.run.trials[0]!, checks: [...f.run.trials[0]!.checks, hygiene(true)] }] }];
  f.key('4', ' ', 'c');
  const text = f.text(120);
  assert.match(text, /Hygiene gate\s+all 1 passed/);
  assert.match(text, /a floor, not a score/);
  // The thing this rename exists to prevent: a full-width bar at a percentage that cannot move.
  assert.doesNotMatch(text, /Hygiene\s+[█░]/);
  assert.doesNotMatch(text, /Quality/);

  f.key(esc);
  f.app.runs = [{ ...f.run, trials: [{ ...f.run.trials[0]!, checks: [...f.run.trials[0]!.checks, hygiene(false)] }] }];
  f.key('c');
  assert.match(f.text(120), /Hygiene gate\s+1 of 1 checks failed/, 'a real failure is still stated plainly');
});

test('esc and q both mean leave, at every level', () => {
  // The complaint this fixes: esc backed out of a panel but did nothing at the top, and q quit at
  // the top but did nothing in a panel, so neither key worked everywhere and you had to track
  // which level you were on.
  for (const leave of ['\x1b', 'q']) {
    const f = fixture();
    f.key('?');
    assert.match(f.text(), /Keys/, 'a panel is open');
    f.key(leave);
    assert.doesNotMatch(f.text(), /Keys/, `${leave === 'q' ? 'q' : 'esc'} closes the panel`);
    assert.equal(f.exits, 0, 'and closing a panel never quits');

    f.key('4', ' ', 'c');
    assert.match(f.text(), /Scorecard/, 'the comparison panel is open');
    f.key(leave);
    assert.doesNotMatch(f.text(), /Scorecard/, 'the same key closes this one too');
    assert.equal(f.exits, 0);

    f.key(leave);
    assert.equal(f.exits, 1, 'with nothing left to go back to, the same key leaves the app');
  }

  // A dialog that takes typed text is the one carve-out: there q is a letter.
  const typing = fixture();
  typing.key('3', 'a', 'q');
  assert.match(typing.text(), /q/, 'q is typed, not swallowed');
  assert.equal(typing.exits, 0);
  typing.key('\x1b');
  assert.equal(typing.exits, 0, 'escape still backs out of a form without quitting');

  const footer = fixture();
  assert.match(footer.text(), /esc · q\s+quit/, 'the top level names both keys');
  footer.key('?');
  assert.match(footer.text(), /esc · q\s+back/, 'and so does a panel');
});

test('a half-solved task shows how much was right, without a second headline', () => {
  const f = fixture();
  const good = f.run.trials[0]!;
  const half = {
    ...good, id: 'half', status: 'failed' as const,
    checks: [
      { id: 'one', dimension: 'correctness' as const, passed: true, evidence: 'ok' },
      { id: 'two', dimension: 'correctness' as const, passed: false, evidence: 'no' },
    ],
  };
  f.app.runs = [{ ...f.run, trials: [half] }];
  f.key('4', ' ', 'c');
  assert.match(f.text(120), /50% of checks/, 'half the checks passed, and it says so');
  assert.doesNotMatch(f.text(120), /\b50%\s+\d+\/\d+ graded/, 'the headline is still the task, not the checks');

  // Nothing half-right means no second number, so the headline is never ambiguous.
  f.key(esc);
  f.app.runs = [{ ...f.run, trials: [good] }];
  f.key('c');
  assert.doesNotMatch(f.text(120), /of checks/);
});

test('a model that ran out of turns says so beside its score', () => {
  const f = fixture();
  const good = f.run.trials[0]!;
  // The exact shape that misled: every graded trial correct, and a second trial that never
  // finished. Correctness alone reads 100% for a model that only completed half its work.
  const solved = { ...good, status: 'passed' as const, checks: [{ id: 'exact', dimension: 'correctness' as const, passed: true, evidence: 'ok' }] };
  f.app.runs = [{ ...f.run, trials: [solved, { ...good, id: 'stalled', status: 'budget', checks: [] }] }];
  f.key('4', ' ', 'c');
  const text = f.text(120);
  assert.match(text, /Stalled/);
  assert.match(text, /1 stalled/);
  assert.match(text, /100% scored · 50% if counted/, 'the size of what the score omits, not just the count');
  assert.match(text, /ran out of turns or time/);
  assert.match(text, /excluded from correctness/);

  // No stall, no line: this must not become standing noise that stops being read.
  f.key(esc);
  f.app.runs = [{ ...f.run, trials: [good] }];
  f.key('c');
  assert.doesNotMatch(f.text(120), /Stalled/);
});

test('every run states which credential it will use, reviewer included', () => {
  const f = fixture();
  // Subscription-only is the quiet case, and it must still be stated rather than assumed.
  assert.match(f.text(), /Subscription logins only \(1 call site\)\. No API key will be used\./);
  f.key('r');
  assert.match(f.text(), /Subscription logins only/);
  assert.match(f.text(), /draw on plan usage limits, not money/);
  f.key(esc);

  // The reviewer spends a credential too, so it is named and counted with the candidates.
  Object.assign(f.app.config.judge, { enabled: true, provider: 'example', model: 'model-one', auth: 'pi' });
  assert.match(f.text(), /2 call sites/);
  f.key('r');
  assert.match(f.text(), /Reviewer · example\/model-one/);
  f.key(esc);

  // An API key is never silent: it is named before the run and still needs the billing prompt.
  f.app.config.models[0]!.auth = 'env';
  assert.match(f.text(), /would use a metered API key: Example model/);
  f.key('r');
  assert.match(f.text(), /would use a metered API key/);
  f.key(enter);
  assert.match(f.text(), /Billing/);
  assert.equal(f.calls.length, 0, 'still nothing has run');
});

test('a reviewer that was on but scored nothing says so', async () => {
  const f = fixture();
  f.ui.focused = true;
  f.app.run = async () => ({
    ...f.run, judge: { ...DEFAULT_JUDGE, enabled: true },
    trials: [{ ...f.run.trials[0]!, status: 'passed' as const, judgeNote: 'Reviewer unavailable: token expired' }],
  });
  f.key('r', enter);
  await Promise.resolve();
  // The run's own outcome must survive truncation; the warning rides after it, not before.
  assert.match(f.text(), /Run completed · 1\/2 trials retained\./, 'the outcome is never pushed out of view');
  assert.match(f.text(120), /Reviewer scored nothing\./);

  // The reason lives on the Runs tab, which has room for it.
  f.app.runs = [{ ...f.run, judge: { ...DEFAULT_JUDGE, enabled: true, model: 'gpt-5.5' },
    trials: [{ ...f.run.trials[0]!, judgeNote: 'Reviewer unavailable: token expired' }] }];
  f.key('4');
  assert.match(f.text(), /reviewer gpt-5\.5 scored nothing/);
  assert.match(f.text(120), /token expired/, 'the reason is shown, not just the fact');
  f.app.runs = [{
    ...f.run, judge: { ...DEFAULT_JUDGE, enabled: true, model: 'gpt-5.5' },
    trials: [{ ...f.run.trials[0]!, checks: [{ id: 'design-x', dimension: 'design' as const, passed: false, evidence: 'cited' }] }],
  }];
  assert.match(f.text(120), /reviewer gpt-5\.5 · 1\/1 design defects/);
});

test('a run that never started explains itself instead of vanishing', async () => {
  const f = fixture();
  f.ui.focused = true;
  f.app.run = async () => { throw new Error('Run lock exists. Another run may be active.'); };
  f.key('r', enter);
  await Promise.resolve();
  // No manifest exists, so the Runs tab cannot account for it. Home has to.
  assert.match(f.text(), /Last attempt produced no run/);
  assert.match(f.text(), /Run lock exists/);
  assert.match(f.text(), /nothing on the Runs tab for it/);
  f.key('4', '1');
  assert.match(f.text(), /Last attempt produced no run/, 'it survives navigating away and back');
  f.app.run = async () => f.run;
  f.key('r', enter);
  await Promise.resolve();
  assert.doesNotMatch(f.text(), /Last attempt produced no run/, 'cleared once a run starts');
});

test('an unfinished run is listed with how far it got', () => {
  const f = fixture();
  f.app.runs = [
    { ...f.run, id: 'run-live', status: 'running' },
    { ...f.run, id: 'run-stopped', status: 'interrupted' },
    { ...f.run, id: 'run-done', status: 'completed' },
  ];
  f.key('4');
  const line = (id: string) => f.text().split('\n').find(l => l.includes(id))!;
  assert.match(line('run-live'), /running 1\/2/);
  assert.match(line('run-stopped'), /interrupted 1\/2/);
  assert.doesNotMatch(line('run-done'), /completed 1\/2/, 'a finished run needs no fraction');
});

test('the design reviewer is off by default and every setting persists', () => {
  const f = fixture();
  f.key('5');
  assert.match(f.text(), /Design reviewer/);
  assert.match(f.text(), /design not scored/, 'the headline says plainly that nothing is judged yet');
  assert.match(f.text(), /Nothing is sent while the reviewer is off/);
  assert.equal(f.app.config.judge.enabled, false);

  f.key(' ');
  assert.equal(f.app.config.judge.enabled, true);
  assert.match(f.text(), /design reviewed/);
  const saved = f.saves;

  f.key(down, down, ' ');
  assert.equal(f.app.config.judge.thinking, 'minimal', 'thinking cycles');
  f.key(down, ' ');
  assert.equal(f.app.config.judge.repeat, 2, 'rounds cycle');
  f.key('+', '+', '+', '+');
  assert.equal(f.app.config.judge.repeat, 5, 'rounds clamp at 5');
  f.key(...Array<string>(9).fill('-'));
  assert.equal(f.app.config.judge.repeat, 1, 'rounds clamp at 1');
  assert.ok(f.saves > saved, 'every change is written to disk');
  // Repetitions belong to the run, not the reviewer, and must not move from this tab.
  assert.equal(f.calls.length, 0);
  f.key('1');
  assert.match(f.text(), /2 repeats/);

  // Picking a reviewer goes through the same catalog and auth path as a candidate.
  f.key('5', up, up, enter);
  assert.match(f.text(), /example\/model-one/);
  f.key(enter, enter);
  assert.equal(f.app.config.judge.provider, 'example');
  assert.equal(f.app.config.judge.model, 'model-one');
  assert.match(f.text(), /Reviewer set to Example model/);
  assert.match(f.text(), /example\/model-one/, 'the chosen reviewer is shown in the field, not just the message');
});

test('a same-family reviewer is called out where it is chosen', () => {
  const f = fixture();
  f.app.config.models[0]!.provider = 'anthropic';
  Object.assign(f.app.config.judge, { enabled: true, provider: 'anthropic', model: 'claude-sonnet-5' });
  f.key('5');
  assert.match(f.text(), /same family as candidates/);
  f.app.config.judge.provider = 'openai-codex';
  assert.doesNotMatch(f.text(), /same family as candidates/);
});

test('cancel from every form never adds, deletes or enables payment', () => {
  const f = fixture('metered');
  f.key('2', 'a', enter, esc);
  assert.equal(f.app.config.models.length, 1);
  f.key('d', esc);
  assert.equal(f.app.config.models.length, 1);
  f.key('3', 'a', 'cancelled', enter, 'prompt', enter, '42', esc);
  assert.equal(f.app.suite.tasks.length, 1);
  f.key('r', enter, 'PAY', '\x03');
  assert.equal(f.calls.length, 0);
  assert.equal(f.exits, 0);
});

test('headless screen artifacts use only workspace-local mock data', () => {
  if (process.env.FORSETI_UI_ARTIFACTS !== '1') return;
  const dir = new URL('../.cache/ui-artifacts/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const f = fixture('metered');
  const capture = (name: string) => {
    for (const width of [40, 80, 120]) {
      const lines = f.ui.render(width);
      writeFileSync(new URL(`${name}-${width}.ansi`, dir), lines.join('\n') + '\n');
      writeFileSync(new URL(`${name}-${width}.txt`, dir), lines.map(stripVTControlCharacters).join('\n') + '\n');
    }
  };
  capture('home');
  f.key('2'); capture('models');
  f.key('a'); capture('catalog');
  f.key(esc, '3'); capture('tests');
  f.key('a'); capture('test-wizard');
  f.key(esc, '4'); capture('runs');
  f.key(enter); capture('evidence');
  f.key(esc, 'r'); capture('preflight');
  f.key(enter); capture('billing');
  f.key('PAY', enter); capture('progress');
  f.key(esc); f.finish();
});

test('the scorecard says who is better at what, and only where the run can tell', () => {
  // A tall window, so the whole scorecard is on one page.
  const f = fixture('subscription', 60);
  const good = f.run.trials[0]!;
  const tasks = [
    { id: 'a', title: 'Task A', hash: 'a', capabilities: ['evidence' as const] },
    { id: 'b', title: 'Task B', hash: 'b', capabilities: ['evidence' as const] },
    { id: 'c', title: 'Task C', hash: 'c', capabilities: ['safety' as const] },
  ];
  const strong: ModelConfig = { ...model, id: 'strong', label: 'Strong model' };
  const weak: ModelConfig = { ...model, id: 'weak', label: 'Weak model' };
  const trial = (m: string, task: string, repetition: number, passed: boolean) => ({
    ...good, id: `${m}-${task}-${repetition}`, model: m, task, repetition, status: passed ? 'passed' as const : 'failed' as const,
    checks: [{ id: 'exact', dimension: 'correctness' as const, passed, evidence: '' }],
  });
  // The weak model fails every evidence task and passes the safety task, four times over.
  const record = (repeats: number, weakPasses: string[]) => tasks.flatMap(t => Array.from({ length: repeats }, (_, r) => [trial('strong', t.id, r + 1, true), trial('weak', t.id, r + 1, weakPasses.includes(t.id))]).flat());
  f.app.runs = [{ ...f.run, models: [weak, strong], tasks, planned: 6 * 4, trials: record(4, ['c']) }];
  f.key('4', ' ', 'c');
  let text = f.text(120);
  assert.match(text, /overall\s+Strong model over Weak model\s+\+67 pts\s+3 tasks/, 'the overall gap is stated as a verdict');
  assert.match(text, /evidence\s+Strong model over Weak model\s+\+100 pts\s+2 tasks/, 'and so is the kind of task it comes from');
  assert.doesNotMatch(text, /safety\s+\w+ model over/, 'a kind of task with no gap earns no verdict');
  assert.ok(text.indexOf('Strong model') < text.indexOf('Weak model'), 'the stronger candidate is listed first');
  assert.match(text, /Where they differ/);
  assert.match(text, /Task A/);
  assert.doesNotMatch(text, /Task C/, 'a task every candidate agrees on is folded into a count');
  assert.match(text, /1 task where every candidate agrees/);
  f.key('a');
  text = f.text(120);
  assert.match(text, /Per task/);
  assert.match(text, /Task C/, 'a shows every task');

  // One repetition and a smaller gap is inside the noise, and the screen must say so.
  f.key(esc);
  f.app.runs = [{ ...f.run, models: [weak, strong], tasks, planned: 6, trials: record(1, ['a', 'c']) }];
  f.key('c');
  text = f.text(120);
  assert.match(text, /nothing clears the bar/);
  assert.match(text, /not a ranking/);
  assert.doesNotMatch(text, /Strong model over/);

  // A pair can be tied overall and still apart on one kind of task; both facts are stated.
  f.key(esc);
  f.app.runs = [{ ...f.run, models: [weak, strong], tasks, planned: 6, trials: record(1, ['c']) }];
  f.key('c');
  text = f.text(120);
  assert.match(text, /tied overall: Strong model ≈ Weak model/);
  assert.match(text, /evidence\s+Strong model over Weak model\s+\+100 pts/);
  assert.doesNotMatch(text, /overall\s+Strong model over/);
});
