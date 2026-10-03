import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Dashboard } from '../src/tui.ts';
import { DEFAULT_JUDGE } from '../src/config.ts';
import { Tail, Transcript } from '../src/ui/live.ts';
import { conversation } from '../src/ui/running.ts';
import type { LiveEvent, ModelConfig } from '../src/types.ts';

// Every fixture lives under one workspace-local folder: the Live tab reads the run lock under its root.
const ROOT = mkdtempSync(join(process.cwd(), '.tmp/live-'));
test.after(() => rmSync(ROOT, { recursive: true, force: true }));
const line = (e: LiveEvent) => `${JSON.stringify(e)}\n`;
const plain = (lines: string[]) => lines.map(l => stripVTControlCharacters(l));

/** A run in progress with one try per model, each streaming `events` to its live.jsonl. */
function liveRun(events: LiveEvent[][], onRefresh = () => {}) {
  const root = mkdtempSync(join(ROOT, 'run-'));
  const models: ModelConfig[] = events.map((_, i) => ({ id: `m${i + 1}`, label: `Model ${i + 1} · local`, provider: 'local', model: 'x', auth: 'none', enabled: true, thinking: 'off' }));
  const auth = { mode: 'local server', billing: 'local' as const, ready: true, note: '' };
  mkdirSync(join(root, '.state'), { recursive: true });
  writeFileSync(join(root, '.state', 'run.lock'), JSON.stringify({ pid: process.pid, runId: 'live' }));
  mkdirSync(join(root, 'runs', 'live', 'trials'), { recursive: true });
  writeFileSync(join(root, 'runs', 'live', 'run.json'), JSON.stringify({
    schema: 1, id: 'live', created: new Date().toISOString(), status: 'running', suite: 's', suiteHash: 'a', harnessHash: 'b', environment: {}, judge: null,
    options: { repeat: 1, seed: 1, lane: 'tools', timeout: 90, maxTurns: 12, maxTokens: 4096, allowMetered: false, cache: true, parallel: 4 },
    models, tasks: [{ id: 'one', title: 'Task one', hash: 'one' }], planned: 8, trials: [],
  }));
  for (const [i, stream] of events.entries()) {
    const dir = join(root, 'runs', 'live', 'trials', `000${i + 1}-m${i + 1}-one`);
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(join(dir, 'live.jsonl'), stream.map(line).join(''));
  }
  const app = {
    root, config: { schema: 1, suite: 's', models, disabledTests: [], removedTests: [], judge: { ...DEFAULT_JUDGE }, local: { url: '' } },
    suite: { schema: 1, id: 's', title: 's', tasks: [] }, catalog: [], runs: [], localModels: undefined,
    persist() {}, async refresh() { onRefresh(); }, run: () => new Promise(() => {}), compare: () => '', exportReport: () => '', leaderboard: () => null,
    addModel() {}, addTest() {}, authFor: () => auth, setLocalUrl() {}, async probeLocal() { return []; },
  } as unknown as ConstructorParameters<typeof Dashboard>[0];
  return Object.assign((rows: number) => new Dashboard(app, () => {}, () => {}, () => rows), { root });
}
const panes = (n: number) => Array.from({ length: n }, (_, i): LiveEvent[] => [{ k: 'turn' }, { k: 'say', s: `Pane ${i + 1} is thinking.` }]);

test('the tail reads only new bytes and keeps a line cut mid-write for the next read', () => {
  const dir = mkdtempSync(join(ROOT, 'tail-')), file = join(dir, 'live.jsonl');
  const tail = new Tail(dir);
  assert.equal(tail.read(), false, 'nothing written yet');
  const bytes = Buffer.from(line({ k: 'turn' }) + line({ k: 'say', s: 'Héllo wörld' }));
  // Cut inside the two-byte ö, so a character split across two reads must survive.
  const cut = bytes.indexOf(Buffer.from('ö')) + 1;
  writeFileSync(file, bytes.subarray(0, cut));
  assert.equal(tail.read(), true);
  assert.equal(tail.transcript.turns, 1);
  assert.equal(tail.transcript.blocks.length, 0, 'half a line waits');
  appendFileSync(file, bytes.subarray(cut));
  appendFileSync(file, line({ k: 'say', s: '!' }));
  assert.equal(tail.read(), true);
  assert.deepEqual(tail.transcript.blocks, [{ kind: 'say', text: 'Héllo wörld!' }]);
  assert.equal(tail.read(), false, 'nothing new, nothing changed');
});

test('deltas of one kind join into one block; a turn, a tool call or another kind starts the next', () => {
  const t = new Transcript();
  const events: LiveEvent[] = [
    { k: 'turn' }, { k: 'think', s: 'Check ' }, { k: 'think', s: 'the parser.' }, { k: 'say', s: 'Reading it.' },
    { k: 'tool', name: 'read_file' }, { k: 'args', s: '{"path":' }, { k: 'args', s: '"src/parse.py"}' },
    { k: 'tool', name: 'python' }, { k: 'args', s: '{}' },
    { k: 'result', ok: true, s: 'def parse(): ...' }, { k: 'result', ok: false, s: 'Traceback\nNameError: x' },
    { k: 'turn' }, { k: 'say', s: 'Fixed' }, { k: 'turn' }, { k: 'say', s: 'Done' },
  ];
  events.forEach(e => t.add(e));
  assert.equal(t.turns, 3);
  assert.deepEqual(t.blocks, [
    { kind: 'think', text: 'Check the parser.' }, { kind: 'say', text: 'Reading it.' },
    { kind: 'tool', name: 'read_file', args: '{"path":"src/parse.py"}', result: { ok: true, text: 'def parse(): ...' } },
    { kind: 'tool', name: 'python', args: '{}', result: { ok: false, text: 'Traceback\nNameError: x' } },
    { kind: 'say', text: 'Fixed' }, { kind: 'say', text: 'Done' },
  ], 'results answer calls in the order they were made');
  const text = plain(conversation(t, 60, true)).join('\n');
  assert.match(text, /┊ Check the parser\./);
  assert.match(text, /▸ read_file\s+parse\.py ✓/);
  assert.match(text, /▸ python ✗ Traceback/, 'a failure shows its first line');
  assert.match(text, /Done▍$/, 'the block still streaming ends with the cursor');
  assert.equal(text.split('▍').length, 2, 'and only that one');
  assert.doesNotMatch(plain(conversation(t, 60, false)).join('\n'), /▍/, 'a finished try has no cursor');
});

test('a file being written shows its last lines as they stream, then only the call once it returns', () => {
  const t = new Transcript();
  [{ k: 'turn' }, { k: 'tool', name: 'write_file' }, { k: 'args', s: '{"path":"src/a.py","content":"one\\ntwo\\nthree\\nfour' }].forEach(e => t.add(e as LiveEvent));
  const streaming = plain(conversation(t, 60, true));
  assert.match(streaming[0]!, /▸ write_file\s+a\.py$/);
  assert.deepEqual(streaming.slice(1).map(l => l.trim()), ['two', 'three', 'four▍']);
  t.add({ k: 'args', s: '"}' });
  t.add({ k: 'result', ok: true, s: 'wrote 4 lines' });
  assert.deepEqual(plain(conversation(t, 60, true)), ['▸ write_file  a.py ✓']);
});

test('panes fill the window in a grid: side by side when wide, stacked when not, one line each when short', () => {
  const view = liveRun(panes(3));
  for (const width of [40, 80, 160]) {
    for (const rows of [14, 24, 45]) {
      const lines = view(rows).render(width);
      lines.forEach(l => assert.ok(visibleWidth(l) <= width, `${width}x${rows}: ${visibleWidth(l)}`));
      assert.ok(lines.length <= rows, `${width}x${rows}: ${lines.length} lines do not fit the window`);
    }
  }
  const wide = plain(view(45).render(160));
  assert.ok(wide.some(l => /Model 1 · Task one.*Model 2 · Task one.*Model 3 · Task one/.test(l)), 'three columns at 160');
  assert.ok(wide.some(l => /Pane 1 is thinking\..*Pane 2 is thinking\..*Pane 3 is thinking\./.test(l)));
  const stacked = plain(view(45).render(80));
  assert.ok(!stacked.some(l => /Model \d.*Model \d/.test(l)), 'one column at 80');
  assert.ok(stacked.findIndex(l => l.includes('Pane 1')) < stacked.findIndex(l => l.includes('Pane 3')));
  const narrow = plain(view(45).render(40)).join('\n');
  assert.doesNotMatch(narrow, /[╭╰│]/, 'no borders under 60 columns');
  assert.match(narrow, /Pane 3 is thinking\./);
  const short = plain(view(14).render(160));
  assert.equal(short.filter(l => /Model \d\s+Task one\s+Pane \d is thinking\..*turn 1\/12 · \d+s of 90s/.test(l)).length, 3, 'one status line per try, its turns and time against their limits');
  const many = plain(liveRun(panes(8))(45).render(200));
  assert.ok(many.some(l => /Model 1 ·.*Model 2 ·.*Model 3 ·.*Model 4 ·/.test(l)) && many.some(l => /Model 5 ·.*Model 8 ·/.test(l)), 'eight tries in two rows of four');
});

test('] and [ move focus, enter zooms, and esc leaves the zoom before it would cancel the run', () => {
  const long: LiveEvent[] = [{ k: 'turn' }, { k: 'say', s: Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n') }];
  const ui = liveRun([...panes(2), long])(40);
  const text = () => plain(ui.render(160)).join('\n');
  ui.handleInput(']');
  ui.handleInput('\r');
  assert.match(text(), /Model 2 · Task one/);
  assert.doesNotMatch(text(), /Model 1 ·|Model 3 ·/, 'the zoomed try fills the body');
  assert.match(text(), /esc · q back/);
  ui.handleInput('\x1b');
  assert.match(text(), /Model 1 ·.*Model 2 ·.*Model 3 ·/);
  assert.doesNotMatch(text(), /Cancel this run\?/, 'esc left the zoom first');
  ui.handleInput('[');
  ui.handleInput('[');
  ui.handleInput('\r');
  assert.match(text(), /Model 3 · Task one/, 'focus wraps around');
  assert.match(text(), /line 80▍/, 'a zoom follows the newest line');
  ui.handleInput('k');
  assert.match(text(), /line 79\s/);
  assert.doesNotMatch(text(), /line 80/, 'scrolled back one line');
  assert.match(text(), /of \d+ · G newest/);
  ui.handleInput('G');
  assert.match(text(), /line 80▍/);
  ui.handleInput('\x1b');
  ui.handleInput('\x1b');
  assert.match(text(), /Cancel this run\?/, 'with nothing zoomed, esc asks to cancel');
  ui.handleInput('n');
  ui.handleInput('\r');
  ui.handleInput('\x1b[C');
  assert.match(text(), /Models/, 'tab keys still switch tabs while zoomed');
});

test('a click focuses a pane and a double click zooms it', () => {
  const ui = liveRun(panes(3))(45);
  // The header draws each frame and the body reuses it, as on screen.
  const frame = () => { ui.render(160, 'header'); return plain(ui.render(160, 'body')); };
  const body = frame();
  const y = body.findIndex(l => l.includes('Pane 3 is thinking'));
  assert.ok(ui.click('body', y, body[y]!.indexOf('Pane 3')));
  ui.handleInput('\r');
  assert.match(plain(ui.render(160)).join('\n'), /Model 3 · Task one/);
  assert.doesNotMatch(plain(ui.render(160)).join('\n'), /Model 1 ·/);
  ui.handleInput('\x1b');
  const again = frame();
  const y2 = again.findIndex(l => l.includes('Pane 2 is thinking'));
  assert.ok(ui.click('body', y2, again[y2]!.indexOf('Pane 2'), 2));
  assert.match(plain(ui.render(160)).join('\n'), /Model 2 · Task one/);
  assert.doesNotMatch(plain(ui.render(160)).join('\n'), /Model 3 ·/);
});

test('a pane with a very long transcript renders fast', () => {
  const words = 'the model keeps writing a very long reply without a single break ';
  const prose = new Transcript(), code = new Transcript();
  prose.add({ k: 'turn' });
  code.add({ k: 'turn' });
  for (let i = 0; i < 3200; i++) { prose.add({ k: 'say', s: words }); code.add({ k: 'say', s: `x_${i} = compute(${i})  # step\n` }); }
  assert.ok(prose.blocks[0]!.kind === 'say' && prose.blocks[0]!.text.length > 200_000);
  for (const t of [prose, code]) {
    const start = performance.now();
    for (let frame = 0; frame < 5; frame++) { t.add({ k: 'say', s: 'more ' }); conversation(t, 60, true, 30); }
    const ms = (performance.now() - start) / 5;
    assert.ok(ms < 20, `${ms.toFixed(1)} ms a frame`);
  }
  // The same through the whole screen, from disk.
  const ui = liveRun([[{ k: 'turn' }, { k: 'say', s: words.repeat(3200) }], ...panes(3)])(45);
  ui.render(160);
  const start = performance.now();
  ui.render(160);
  assert.ok(performance.now() - start < 50, `${(performance.now() - start).toFixed(1)} ms a frame`);
});

test('a finished try reloads the leaderboard without waiting for the run to end', () => {
  let refreshes = 0;
  const make = liveRun(panes(1), () => refreshes++), ui = make(30) as unknown as { watch(): void };
  ui.watch();
  const before = refreshes, path = join(make.root, 'runs', 'live', 'run.json');
  const run = JSON.parse(readFileSync(path, 'utf8'));
  run.trials.push({ id: '0001-m1-one', model: 'm1', task: 'one', repetition: 1, status: 'passed', checks: [] });
  writeFileSync(path, JSON.stringify(run));
  ui.watch();
  assert.equal(refreshes, before + 1, 'one reload for the new try');
  ui.watch();
  assert.equal(refreshes, before + 1, 'nothing new, no reload');
});
