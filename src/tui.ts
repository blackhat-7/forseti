import { stripVTControlCharacters } from 'node:util';
import {
  Input, SelectList, ProcessTerminal, TuiAltScreen, Text, ScrollView, VStack,
  matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type Focusable,
} from '@earendil-works/pi-tui';
import type { App, CatalogEntry } from './app.ts';
import { HARNESS_WARNING, LABEL, SKILL_NAME, TIER_NAME, bar, byCapability, byTier, gate, harnesses, outcome, ranking, scoreError, scorecards, stallNote, taskCell, taskOrder, triesLabel, verdicts } from './report.ts';
import { DEFAULT_OPTIONS } from './config.ts';
import type { AuthInfo, ModelConfig, Progress, Run, RunOptions } from './types.ts';

// Strip whole terminal strings first, then remaining controls (including bidi).
export function terminalText(value: unknown): string {
  return stripVTControlCharacters(String(value)
    .replace(/(?:\x1b[P_^X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, ''))
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}
const plain = (value: unknown) => terminalText(value).replace(/\n/g, ' ');
export function terminalReport(markdown: string): string {
  let headers: string[] = [];
  return terminalText(markdown).split('\n').flatMap(line => {
    if (!line.startsWith('|')) { headers = []; return [line]; }
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim().replaceAll('\\|', '|'));
    if (!headers.length) { headers = cells; return []; }
    if (cells.every(cell => /^[-:]+$/.test(cell))) return [];
    return [cells[0], ...cells.slice(1).map((cell, i) => `  ${headers[i + 1]}: ${cell}`), ''];
  }).join('\n');
}
// Kanagawa Dragon: one dark base, one accent for anything interactive, and colour only where it
// carries meaning. The variable names are the roles; the comments are the palette's own names.
const ink = (r: number, g: number, b: number) => (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
const BACKDROP = '\x1b[48;2;24;22;22m\x1b[38;2;197;201;197m'; // dragonBlack3 on dragonWhite
const accent = ink(139, 164, 176); // dragonBlue2
const teal = ink(142, 164, 162); // dragonAqua
const green = ink(135, 169, 135); // dragonGreen2
const amber = ink(196, 178, 138); // dragonYellow
const rose = ink(196, 116, 110); // dragonRed
const muted = ink(166, 166, 156); // dragonGray
const faint = ink(115, 124, 115); // dragonAsh
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const theme = { selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: faint, noMatch: amber };
const tabs = ['Home', 'Models', 'Tests', 'Runs', 'Settings'];
const THINKING: ModelConfig['thinking'][] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const JUDGE_FIELDS = ['Reviewer', 'Model', 'Thinking', 'Rounds'];
/** Per-trial time limit. A ladder rather than free entry: these are the values worth choosing. */
const TIMEOUTS = [30, 60, 90, 120, 180, 300, 600];
/** Tool-call turns per trial. Too low censors outcomes; too high spends plan quota on stragglers. */
const TURNS = [6, 12, 20, 30, 50];
const dot = (on: boolean) => (on ? green('●') : faint('○'));
const shortRun = (id: string) => (/^\d{4}-\d{2}-\d{2}T/.test(id) ? `${id.slice(11, 19)} · ${id.slice(-8)}` : id);
function statusInk(status: string): (s: string) => string {
  if (['passed', 'completed'].includes(status)) return green;
  if (['failed', 'cancelled', 'interrupted'].includes(status)) return amber;
  if (status === 'running') return accent;
  return muted;
}
function billingInk(billing: AuthInfo['billing']): string {
  if (billing === 'subscription') return teal('subscription');
  if (billing === 'control') return faint('synthetic control');
  return amber(billing);
}
/** Controls already say "synthetic control" in their mode; never print it twice. */
function authLine(auth: AuthInfo): string {
  const pill = auth.ready ? green('READY') : rose('NOT READY');
  return auth.billing === 'control' ? `${pill}   ${faint(plain(auth.mode))}` : `${pill}   ${muted(plain(auth.mode))}   ${billingInk(auth.billing)}`;
}
/** Fixed label/value/hint columns so settings read as a table instead of ad-hoc spacing. */
function field(label: string, value: string, hint: string): string {
  const pad = (n: number) => ' '.repeat(Math.max(2, n));
  return `${muted(label)}${pad(14 - label.length)}${value}${pad(14 - visibleWidth(stripVTControlCharacters(value)))}${faint(hint)}`;
}
/**
 * States in one line which credential every call will use. An API key is never implied: if one
 * would be used it is named here, before anything runs, and it still has to clear the billing
 * prompt afterwards.
 */
function creditLine(entries: { label: string; auth: AuthInfo }[]): string {
  const live = entries.filter(e => e.auth.billing !== 'control');
  if (!live.length) return faint('Synthetic controls only. No model is called and no credential is used.');
  const keyed = live.filter(e => ['metered', 'unknown'].includes(e.auth.billing));
  if (!keyed.length) return teal(`Subscription logins only (${count(live.length, 'call site')}). No API key will be used.`);
  return amber(`${count(keyed.length, 'call site')} would use a metered API key: ${keyed.map(e => e.label).join(', ')}`);
}
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const tries = (n: number) => `${n} ${n === 1 ? 'try' : 'tries'}`;
const width_ = (s: string) => visibleWidth(stripVTControlCharacters(s));
const pct = (rate: number | null) => (rate === null ? 'n/a' : `${Math.round(rate * 100)}%`);
const rateInk = (rate: number | null) => (rate === null ? faint : rate === 1 ? green : rate >= 0.5 ? amber : rose);
/** Long prose stays readable on ultrawide terminals instead of running the full width. */
const MAX_TEXT = 94;
const LIST_WIDTH = 44;
/** Side-by-side panes on wide terminals; stacked when there is not room for both. */
function twoColumn(left: string[], right: string[], inner: number, leftWidth: number): string[] {
  if (!right.length) return left;
  if (inner < leftWidth + 32) return [...left, '', ...right];
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => {
    const cell = truncateToWidth(left[i] ?? '', leftWidth - 2);
    return `${cell}${' '.repeat(Math.max(2, leftWidth - width_(cell)))}${right[i] ?? ''}`;
  });
}
type UIApp = Pick<App, 'root' | 'config' | 'suite' | 'runs' | 'catalog' | 'persist' | 'refresh' | 'run' | 'compare' | 'exportReport' | 'addModel' | 'addTest' | 'authFor'>;
type Dialog = 'picker' | 'auth' | 'test' | 'delete' | 'preflight' | 'billing' | 'report' | 'evidence' | 'help';

export class Dashboard implements Component, Focusable {
  private app: UIApp;
  private repaint: () => void;
  private exit: () => void;
  private input = new Input({ prompt: '› ' });
  private list?: SelectList;
  private tab = 0;
  private selection = [0, 0, 0, 0, 0];
  private dialog?: Dialog;
  private message = 'Local-first. No prompts sent until you confirm a run.';
  /** Why the last attempt produced no run at all. Cleared when the next one starts. */
  private lastFailure = '';
  private draft: string[] = [];
  private candidate?: CatalogEntry;
  private pickerTarget: 'model' | 'judge' = 'model';
  private pendingDelete?: () => void;
  private deleteLabel = '';
  private selectedRuns = new Set<string>();
  private report = '';
  private reportOffset = 0;
  private reportMode: 'summary' | 'full' = 'summary';
  private reportRuns: Run[] = [];
  private reportLength = 0;
  private reportPage = 12;
  private pendingG = false;
  private detailRun?: Run;
  private trialIndex = 0;
  private progress?: Progress;
  private controller?: AbortController;
  private refreshing = false;
  private pendingOptions?: RunOptions;
  private preflightAuth: { label: string; auth: AuthInfo }[] = [];
  private options: RunOptions = { ...DEFAULT_OPTIONS };

  /** Supplied by launchTui so panels fill the real window instead of a fixed 12 rows. */
  private rows: () => number;
  constructor(app: UIApp, repaint: () => void = () => {}, exit: () => void = () => {}, rows: () => number = () => 24) {
    this.app = app;
    this.repaint = repaint;
    this.exit = exit;
    this.rows = rows;
  }
  /** Rows the body region actually gets: the window minus the 3-line header and 2-line footer. */
  private bodyRows(): number { return Math.max(8, Math.min(200, Math.trunc(this.rows()) || 24) - 5); }
  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  invalidate(): void { this.input.invalidate(); this.list?.invalidate(); }

  private listLength(): number {
    return this.tab === 1 ? this.app.config.models.length : this.tab === 2 ? this.tasks().length
      : this.tab === 4 ? JUDGE_FIELDS.length : this.app.runs.length;
  }
  private tasks() { return this.app.suite.tasks.filter(t => !this.app.config.removedTests.includes(t.id)); }
  private enabledTasks() { return this.tasks().filter(t => !this.app.config.disabledTests.includes(t.id)); }
  private models() { return this.app.config.models.filter(m => m.enabled); }
  /** Dialogs that take typed text, where `q` is a letter and only escape can mean "leave". */
  private typing(): boolean { return this.dialog === 'test' || this.dialog === 'billing' || this.dialog === 'picker'; }
  private close(): void { this.pendingG = false; this.dialog = undefined; this.list = undefined; this.input.setValue(''); this.pendingDelete = undefined; this.pendingOptions = undefined; }
  private attempt(action: () => void): void {
    try { action(); } catch (error) { this.message = `Error: ${plain(error instanceof Error ? error.message : error)}`; }
  }
  private persist(change: () => void): void {
    const before = structuredClone(this.app.config);
    try { change(); this.app.persist(); } catch (error) { this.app.config = before; throw error; }
  }

  handleInput(data: string): void {
    this.attempt(() => this.key(data));
    this.repaint();
  }
  private key(data: string): void {
    const key = (name: Parameters<typeof matchesKey>[1]) => matchesKey(data, name);
    // One rule, every level: leave whatever you are looking at. A dialog is the innermost thing
    // open, so it closes first; only then does the key reach the run, which keeps "close this
    // panel" from ever meaning "throw away the run"; and with nothing open there is nowhere left
    // to go back to, so it leaves. `q` means the same thing wherever it is not typed text, because
    // having to remember which of two keys this level wants is the whole complaint.
    if (key('ctrl+c') || key('escape') || (data === 'q' && !this.typing())) {
      if (this.dialog) this.close();
      else if (this.controller) {
        if (data === 'q') this.message = 'A run is in progress. Press esc again to cancel it.';
        else { this.controller.abort(); this.message = 'Cancelling… keeping completed evidence.'; }
      } else if (this.refreshing && data === 'q') this.message = 'Refreshing metadata. Press esc to stop waiting.';
      else this.exit();
      return;
    }
    if (this.dialog) { if (!this.controller) this.dialogKey(data); return; }
    // Looking around is always allowed. A run is long, and being pinned to one screen while it
    // works is why a cancelled run felt like it had vanished.
    if (key('tab') || key('shift+tab') || key('left') || key('right') || /^[1-5]$/.test(data)) {
      this.tab = /^[1-5]$/.test(data) ? Number(data) - 1 : (this.tab + (key('shift+tab') || key('left') ? tabs.length - 1 : 1)) % tabs.length;
      return;
    }
    if (data === '?') { this.dialog = 'help'; return; }
    if (key('down') || data === 'j' || key('up') || data === 'k') {
      const rows = this.listLength();
      this.selection[this.tab] = Math.max(0, Math.min(rows - 1, this.selection[this.tab]! + (key('up') || data === 'k' ? -1 : 1)));
      return;
    }
    // Everything past here changes configuration or starts work, and waits for the run to end.
    if (this.controller || this.refreshing) return;
    if (data === 'r') { this.preflight(); return; }
    if (data === 'R') { void this.refresh(); return; }
    if (data === '+' || data === '=' || data === '-') {
      const step = data === '-' ? -1 : 1;
      // Rounds are the only number on Settings, so − + stay unambiguous there.
      if (this.tab === 4) this.persist(() => { this.app.config.judge.repeat = Math.max(1, Math.min(5, this.app.config.judge.repeat + step)); });
      else this.options.repeat = Math.max(1, Math.min(20, this.options.repeat + step));
      return;
    }
    if (data === 'l') { this.options.lane = this.options.lane === 'tools' ? 'prompt' : 'tools'; return; }
    if (data === 'p') { this.options.cache = !this.options.cache; return; }
    if (data === 't') { this.options.timeout = TIMEOUTS[(TIMEOUTS.indexOf(this.options.timeout) + 1) % TIMEOUTS.length] ?? 180; return; }
    if (data === 'T') { this.options.maxTurns = TURNS[(TURNS.indexOf(this.options.maxTurns) + 1) % TURNS.length] ?? 12; return; }
    const index = this.selection[this.tab]!;
    if (this.tab === 1) {
      if (data === 'a') { this.openPicker(); return; }
      const model = this.app.config.models[index];
      if (!model) return;
      if (key('space') || key('enter')) this.persist(() => { model.enabled = !model.enabled; });
      if (data === 'd') this.confirmDelete(model.label, () => this.persist(() => { this.app.config.models = this.app.config.models.filter(m => m.id !== model.id); }));
    } else if (this.tab === 2) {
      if (data === 'u') {
        const id = this.app.config.removedTests.at(-1);
        if (id) { this.persist(() => { this.app.config.removedTests.pop(); }); this.message = `Restored ${plain(id)}.`; }
        return;
      }
      if (data === 'a') { this.dialog = 'test'; this.draft = []; this.input.setValue(''); return; }
      const task = this.tasks()[index];
      if (!task) return;
      if (key('space') || key('enter')) this.persist(() => {
        const ids = this.app.config.disabledTests;
        this.app.config.disabledTests = ids.includes(task.id) ? ids.filter(id => id !== task.id) : [...ids, task.id];
      });
      if (data === 'd') this.confirmDelete(task.title, () => this.persist(() => { this.app.config.removedTests.push(task.id); }));
    } else if (this.tab === 3) {
      const run = this.app.runs[index];
      if (key('space') && run) { if (this.selectedRuns.has(run.id)) this.selectedRuns.delete(run.id); else this.selectedRuns.add(run.id); }
      if (key('enter') && run) { this.detailRun = run; this.trialIndex = 0; this.reportOffset = 0; this.dialog = 'evidence'; }
      if (data === 'c') { const ids = this.runIds(); this.report = terminalReport(this.app.compare(ids)); this.reportRuns = this.app.runs.filter(r => ids.includes(r.id)); this.reportOffset = 0; this.reportMode = 'summary'; this.dialog = 'report'; }
      if (data === 'e') this.export();
    } else if (this.tab === 4 && (key('space') || key('enter'))) {
      const judge = this.app.config.judge;
      if (index === 0) this.persist(() => { judge.enabled = !judge.enabled; });
      else if (index === 1) this.openPicker('judge');
      else if (index === 2) this.persist(() => { judge.thinking = THINKING[(THINKING.indexOf(judge.thinking) + 1) % THINKING.length]!; });
      else this.persist(() => { judge.repeat = (judge.repeat % 5) + 1; });
    }
  }
  private runIds(): string[] {
    const ids = this.app.runs.filter(r => this.selectedRuns.has(r.id)).map(r => r.id);
    const current = this.app.runs[this.selection[3]!];
    if (!ids.length && current) ids.push(current.id);
    if (!ids.length) throw new Error('No runs yet. Start with r.');
    return ids;
  }
  private export(): void { this.message = `Exported ${plain(this.app.exportReport(this.runIds()))}`; }
  private confirmDelete(label: string, action: () => void): void { this.deleteLabel = plain(label); this.pendingDelete = action; this.dialog = 'delete'; }
  private openPicker(target: 'model' | 'judge' = 'model'): void {
    this.pickerTarget = target;
    this.dialog = 'picker';
    this.input.setValue('');
    this.filterPicker();
  }
  private filterPicker(): void {
    const filter = this.input.getValue().toLowerCase();
    // Do not offer what will be refused: a synthetic control has no model behind it to review with.
    const items = this.app.catalog.map((c, index) => ({ c, index }))
      .filter(({ c }) => this.pickerTarget !== 'judge' || c.provider !== 'control')
      .map(({ c, index }) => ({ value: String(index), label: plain(`${c.provider}/${c.id} · ${c.name}`) }));
    this.list = new SelectList(items.filter(item => item.label.toLowerCase().includes(filter)), 7, theme);
    this.list.onSelect = item => {
      this.candidate = this.app.catalog[Number(item.value)];
      if (!this.candidate) return;
      const judge = this.pickerTarget === 'judge';
      if (judge && this.candidate.provider === 'control') throw new Error('A synthetic control has no model behind it and cannot review anything.');
      this.dialog = 'auth';
      // Claude Code authenticates itself, so there is nothing to choose.
      this.list = new SelectList(this.candidate.provider === 'claude-code'
        ? [{ value: 'cli', label: 'Claude Code CLI', description: 'Your own plan login; no API key is used' }]
        : [
          { value: 'pi', label: 'Pi credentials', description: 'Existing credentials; no login here' },
          { value: 'env', label: 'Environment API key', description: 'Metered · confirm again before run' },
          ...(judge ? [] : [{ value: 'none', label: 'No credentials', description: 'Synthetic controls only' }]),
        ], 3, theme);
      if (!judge && this.candidate.auth.billing === 'control') this.list.setSelectedIndex(2);
      this.list.onSelect = auth => {
        const { provider, id, name } = this.candidate!;
        if (judge) {
          this.persist(() => Object.assign(this.app.config.judge, { provider, model: id, auth: auth.value as 'pi' | 'env' | 'cli' }));
          this.message = `Reviewer set to ${plain(name)}. Run npm run test:judge before trusting its scores.`;
        } else {
          this.app.addModel(provider, id, auth.value as ModelConfig['auth']);
          this.message = `Added ${plain(name)}. Space toggles participation.`;
        }
        this.close();
      };
    };
  }
  private dialogKey(data: string): void {
    const key = (name: Parameters<typeof matchesKey>[1]) => matchesKey(data, name);
    if (this.dialog === 'picker' || this.dialog === 'auth') {
      if (this.dialog === 'auth' || key('up') || key('down') || key('enter')) this.list?.handleInput(data);
      else { this.input.handleInput(data); this.cleanInput(); this.filterPicker(); }
    } else if (this.dialog === 'test') {
      if (!key('enter')) { this.input.handleInput(data); this.cleanInput(); return; }
      const value = this.input.getValue().trim();
      if (!value) throw new Error('This field is required.');
      if (!this.draft.length && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error('Use a lowercase slug, e.g. json-colors.');
      if (this.draft.length === 2) {
        JSON.parse(value);
        this.app.addTest(this.draft[0]!, this.draft[1]!, value);
        this.message = `Added ${this.draft[0]}. Exact JSON grading, independent task.`;
        this.close();
      } else { this.draft.push(value); this.input.setValue(''); }
    } else if (this.dialog === 'delete') {
      if (data === 'y') { this.pendingDelete?.(); this.close(); this.message = 'Removed from configuration. Existing run evidence is unchanged.'; }
      else if (data === 'n') this.close();
    } else if (this.dialog === 'preflight') {
      if (key('enter')) {
        if (this.preflightAuth.some(m => m.auth.billing === 'metered' || m.auth.billing === 'unknown')) { this.dialog = 'billing'; this.input.setValue(''); }
        else void this.startRun(false);
      }
    } else if (this.dialog === 'billing') {
      if (key('enter')) {
        if (this.input.getValue() === 'PAY') void this.startRun(true);
        else this.message = 'Not started. Type uppercase PAY to explicitly allow charges.';
      } else { this.input.handleInput(data); this.cleanInput(); }
    } else if (this.dialog === 'report' || this.dialog === 'evidence') {
      // `gg` is a two-key sequence, so a lone g only arms it and any other key disarms it.
      const armed = this.pendingG;
      this.pendingG = false;
      if (data === 'g') { if (armed) this.reportOffset = 0; else this.pendingG = true; }
      else if (data === 'G') this.reportOffset = Math.max(0, this.reportLength - this.reportPage);
      else if (data === 'e') this.export();
      else if (data === 'm' && this.dialog === 'report') { this.reportMode = this.reportMode === 'summary' ? 'full' : 'summary'; this.reportOffset = 0; this.reportLength = 0; }
      else if (this.dialog === 'evidence' && (key('left') || key('right') || data === '[' || data === ']')) {
        this.trialIndex = Math.max(0, Math.min((this.detailRun?.trials.length ?? 1) - 1, this.trialIndex + (key('left') || data === '[' ? -1 : 1)));
        this.reportOffset = 0;
      } else if (key('down') || data === 'j' || key('up') || data === 'k') this.reportOffset = Math.max(0, this.reportOffset + (key('up') || data === 'k' ? -1 : 1));
      // A full-window page is a lot of lines to cross one at a time.
      else if (data === ' ' || data === 'b') this.reportOffset = Math.max(0, this.reportOffset + (data === 'b' ? -1 : 1) * Math.max(6, this.bodyRows() - 7));
    }
  }
  private cleanInput(): void {
    const value = this.input.getValue();
    const safe = plain(value);
    if (safe !== value) this.input.setValue(safe);
  }
  private preflight(): void {
    const models = this.models();
    const tasks = this.enabledTasks();
    if (!models.length || !tasks.length) throw new Error('Enable at least one model and one test first.');
    this.pendingOptions = { ...this.options, models: models.map(m => m.id), tests: tasks.map(t => t.id), allowMetered: false };
    // The reviewer spends the same kind of credential as a candidate, so it is listed and gated
    // with them. Leaving it out meant a metered reviewer skipped the billing prompt and only
    // surfaced as an error after the run had been confirmed.
    const judge = this.app.config.judge;
    this.preflightAuth = [
      ...models.map(m => ({ label: plain(m.label), auth: this.app.authFor(m) })),
      ...(judge.enabled ? [{ label: `Reviewer · ${plain(judge.provider)}/${plain(judge.model)}`, auth: this.app.authFor({ ...judge, id: 'judge', label: 'judge', enabled: true }) }] : []),
    ];
    this.dialog = 'preflight';
  }
  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.message = 'Refreshing local metadata… no model prompts.';
    this.repaint();
    try { await this.app.refresh(); this.message = 'Metadata refreshed. No prompts sent.'; }
    catch (error) { this.message = `Refresh failed: ${plain(error instanceof Error ? error.message : error)}`; }
    finally { this.refreshing = false; this.repaint(); }
  }
  private async startRun(allowMetered: boolean): Promise<void> {
    if (!this.pendingOptions || this.controller) return;
    const options = { ...this.pendingOptions, allowMetered };
    this.close();
    this.controller = new AbortController();
    this.progress = undefined;
    this.lastFailure = '';
    this.message = 'Starting run… Esc cancels safely.';
    this.repaint();
    try {
      const run = await this.app.run(options, p => { this.progress = p; this.repaint(); }, this.controller.signal);
      // A reviewer that was switched on and scored nothing is worth saying out loud. Its
      // failures are per-trial notes by design, which is easy to miss when every trial otherwise
      // looks fine.
      // The run's own outcome stays first: the footer truncates, and burying it behind a
      // reviewer warning hides the thing the user actually asked for. The warning is short here
      // and the reason is on the Runs tab, which does not truncate.
      const silent = run.judge?.enabled && !run.trials.some(t => t.checks.some(c => c.dimension === 'design'));
      this.message = `Run ${plain(run.status)} · ${run.trials.length}/${run.planned} trials retained.`
        + (silent ? ' Reviewer scored nothing.' : '');
      this.tab = 3;
      this.selection[3] = 0;
    } catch (error) {
      // A run that never reached its first trial leaves no manifest, so the Runs list cannot
      // explain itself. Keep the reason on screen instead of in a status line that scrolls away.
      this.lastFailure = plain(error instanceof Error ? error.message : error);
      this.message = `Run stopped: ${this.lastFailure}`;
      this.tab = 0;
    }
    finally { this.controller = undefined; this.progress = undefined; this.repaint(); }
  }

  render(width: number, region: 'all' | 'header' | 'body' | 'footer' = 'all'): string[] {
    if (width <= 0) return [''];
    const inner = Math.max(1, width - 4);
    const lines: string[] = [];
    const row = (text = '') => lines.push(text);
    const wrap = (text: string, w: number, paint: (s: string) => string = s => s) =>
      new Text(terminalText(text), 0, 0).render(Math.max(12, w)).map(paint);
    const prose = (text: string, paint: (s: string) => string = s => s) =>
      lines.push(...wrap(text, Math.min(inner, MAX_TEXT), paint));
    // Detail panes wrap to their own column when side by side, to the full width when stacked.
    const detailWidth = Math.min(inner >= LIST_WIDTH + 32 ? inner - LIST_WIDTH - 2 : inner, MAX_TEXT);
    const spread = (left: string, right: string) => {
      const gap = inner - visibleWidth(stripVTControlCharacters(left)) - visibleWidth(stripVTControlCharacters(right));
      return gap < 2 ? left : `${left}${' '.repeat(gap)}${right}`;
    };
    const head = (title: string, right = '') => row(spread(bold(title), right && muted(right)));

    // While a run is live the header carries it, so it is never out of sight on another tab.
    const p = this.progress;
    const summary = this.controller
      ? `${this.controller.signal.aborted ? 'stopping' : 'running'} · ${p?.completed ?? 0}/${p?.total ?? '?'}`
      : `${count(this.models().length, 'model')} · ${count(this.enabledTasks().length, 'test')} · ${tries(this.options.repeat)}`;
    row(spread(bold('forseti'), width >= 60 ? (this.controller ? accent(summary) : faint(summary)) : ''));
    // Tabs carry the only underline in the UI, so the active view is obvious without rules or boxes.
    const labels = tabs.map((t, i) => (i === this.tab ? bold(t) : muted(t)));
    row(labels.join('   '));
    const before = tabs.slice(0, this.tab).reduce((n, t) => n + t.length + 3, 0);
    row(' '.repeat(before) + accent('─'.repeat(tabs[this.tab]!.length)));

    if (this.dialog) this.renderDialog(inner, row, prose, head);
    else if (this.controller && this.tab === 0) {
      const ratio = p && p.total ? Math.min(1, Math.max(0, p.completed / p.total)) : 0;
      const cells = Math.max(8, Math.min(40, inner - 10));
      const done = Math.round(cells * ratio);
      row();
      head(this.controller.signal.aborted ? 'Stopping safely' : 'Running', `${p?.completed ?? 0} / ${p?.total ?? '?'}`);
      row();
      row(accent('█'.repeat(done)) + faint('░'.repeat(cells - done)));
      row();
      if (p) { row(plain(`${p.model}  →  ${p.task}`)); row(muted(plain(p.phase))); }
      else row(muted('Preparing isolated trial workspaces…'));
      row();
      if (p) row(faint(`saved as ${plain(shortRun(p.runId))} · visible on Runs while it works`));
      row();
      row(faint('esc cancels · completed trials are kept · 4 watches the run'));
    } else if (this.tab === 0) {
      const planned = this.models().length * this.enabledTasks().length * this.options.repeat;
      const enabled = this.models();
      row();
      head(plain(this.app.suite.title), `${count(planned, 'trial')} · ${this.options.lane} lane`);
      row();
      // Home earns the whole window: what will run sits beside how it will run.
      twoColumn([
        muted('Run settings'), '',
        field('Tries', accent(String(this.options.repeat)), '− +'),
        field('Lane', accent(this.options.lane), 'l'),
        field('Cache', this.options.cache ? teal('on') : amber('off'), 'p'),
        field('Limit', accent(`${this.options.timeout}s`), 't'),
        field('Turns', accent(String(this.options.maxTurns)), 'T'), '',
        faint(`seed ${this.options.seed} · per trial`),
        faint(`${this.options.maxTokens} tokens per turn`),
      ], [
        muted(`Will run · ${count(enabled.length, 'model')} × ${count(this.enabledTasks().length, 'test')}`), '',
        ...(enabled.length
          ? enabled.slice(0, 8).map(m => {
            const label = truncateToWidth(plain(m.label), 26);
            return `${dot(true)} ${label}${' '.repeat(Math.max(2, 28 - width_(label)))}${billingInk(this.app.authFor(m).billing)}`;
          })
          : [faint('No models enabled. Press 2 to choose some.')]),
        ...(enabled.length > 8 ? [faint(`and ${enabled.length - 8} more`)] : []),
      ], inner, LIST_WIDTH).forEach(row);
      row();
      row(creditLine([
        ...enabled.map(m => ({ label: plain(m.label), auth: this.app.authFor(m) })),
        ...(this.app.config.judge.enabled ? [{ label: 'reviewer', auth: this.app.authFor({ ...this.app.config.judge, id: 'judge', label: 'judge', enabled: true }) }] : []),
      ]));
      row();
      row(accent('r') + '  review preflight, then confirm');
      row();
      if (this.lastFailure) {
        row(rose('Last attempt produced no run'));
        prose(this.lastFailure, rose);
        prose('Nothing was recorded, so there is nothing on the Runs tab for it. Fix this and press r again.', faint);
        row();
      }
      prose('Controls are synthetic, not model evidence. Metered or unknown billing needs separate PAY consent.', faint);
      if (this.app.runs.length) {
        row();
        row(muted('Recent runs'));
        row();
        for (const r of this.app.runs.slice(0, 6)) {
          const passed = r.trials.filter(t => t.status === 'passed').length;
          row(`${faint(plain(shortRun(r.id)))}   ${statusInk(r.status)(truncateToWidth(plain(r.status), 12))}${' '.repeat(Math.max(2, 13 - r.status.length))}${muted(`${passed} passed · ${r.trials.length} of ${r.planned} recorded`)}`);
        }
      }
    } else if (this.tab === 1) {
      const models = this.app.config.models;
      const model = models[this.selection[1]!];
      const detail: string[] = [];
      if (model) {
        const auth = this.app.authFor(model);
        detail.push(muted(`${plain(model.provider)}/${plain(model.model)}`),
          authLine(auth),
          faint(`thinking ${model.thinking} · auth ${model.auth}`), '',
          ...wrap(auth.note, detailWidth, faint));
      } else detail.push(muted('No models yet. Press a to browse the catalog.'));
      row();
      head('Models', `${this.models().length} of ${models.length} enabled`);
      row();
      twoColumn(this.listRows(models.map(m => `${dot(m.enabled)} ${plain(m.label)}`)), detail, inner, LIST_WIDTH).forEach(row);
      row();
      row(faint('space toggle   a add   d remove'));
    } else if (this.tab === 2) {
      const tasks = this.tasks();
      const task = tasks[this.selection[2]!];
      const detail = task
        ? [muted(plain(`${task.id} · ${task.tags.join(' · ')}`)), '', ...wrap(task.prompt, detailWidth, faint)]
        : [muted('No tests yet. Press a to create an exact-JSON test.')];
      row();
      head('Tests', `${this.enabledTasks().length} of ${tasks.length} enabled`);
      row();
      twoColumn(this.listRows(tasks.map(t => `${dot(!this.app.config.disabledTests.includes(t.id))} ${plain(t.title)}`)), detail, inner, LIST_WIDTH).forEach(row);
      row();
      row(faint('space toggle   a add   d remove   u restore'));
    } else if (this.tab === 4) {
      const judge = this.app.config.judge;
      const auth = this.app.authFor({ ...judge, id: 'judge', label: 'judge', enabled: true });
      const values = [
        judge.enabled ? green('on') : faint('off'),
        plain(`${judge.provider}/${judge.model}`),
        accent(judge.thinking),
        accent(String(judge.repeat)),
      ];
      row();
      head('Settings', judge.enabled ? 'design reviewed' : 'design not scored');
      row();
      twoColumn([
        muted('Design reviewer'), '',
        ...JUDGE_FIELDS.map((label, i) => {
          const marker = i === this.selection[4] ? accent('›') : ' ';
          return `${marker} ${muted(label)}${' '.repeat(Math.max(2, 12 - label.length))}${values[i]}`;
        }), '',
        judge.enabled ? authLine(auth) : faint('Nothing is sent while the reviewer is off.'),
      ], [
        muted('What this changes'), '',
        ...wrap('A reviewer model answers fixed yes/no questions about design on submissions that already passed every correctness check. It never touches the correctness score.', detailWidth, faint), '',
        ...wrap('Each defect must cite a line that exists in the submission. Uncitable ones are dropped, so an invented finding costs the candidate nothing.', detailWidth, faint), '',
        ...wrap('Design is the only score here that is not reproducible from the saved artifacts. Changing the reviewer starts a new experiment: older runs will not pool with it.', detailWidth, faint),
      ], inner, LIST_WIDTH).forEach(row);
      row();
      if (judge.enabled && /anthropic|claude/.test(judge.provider) && this.models().some(m => /anthropic|claude/.test(m.provider))) {
        prose('This reviewer is the same family as candidates you have enabled. Measure the gap with npm run test:judge -- --run <id> --alt <provider>/<model> before reading these scores.', amber);
        row();
      }
      prose('Validate a reviewer before trusting it: npm run test:judge reports how often it agrees with your recorded standard.', faint);
      row();
      row(faint('space change   − + rounds'));
    } else {
      const run = this.app.runs[this.selection[3]!];
      const detail: string[] = [];
      if (run) {
        const passed = run.trials.filter(t => t.status === 'passed').length;
        const failed = run.trials.filter(t => t.status === 'failed').length;
        const other = run.trials.length - passed - failed;
        detail.push(muted(plain(run.created)),
          green(`${passed} passed`) + muted('   ') + amber(`${failed} failed`) + muted(`   ${other} other`),
          faint(`${run.trials.length} of ${run.planned} recorded`),
          faint(`${run.options.lane} lane · ${tries(run.options.repeat)} · cache ${run.options.cache ? 'on' : 'off'}`),
          faint(`suite ${run.suiteHash.slice(0, 8)} · harness ${run.harnessHash.slice(0, 8)}`));
        if (run.judge?.enabled) {
          const design = run.trials.flatMap(t => t.checks.filter(c => c.dimension === 'design'));
          if (design.length) detail.push(faint(`reviewer ${plain(run.judge.model)} · ${design.filter(c => !c.passed).length}/${design.length} design defects`));
          else detail.push(rose(`reviewer ${plain(run.judge.model)} scored nothing`),
            ...wrap(run.trials.find(t => t.judgeNote)?.judgeNote ?? 'No design checks were produced.', detailWidth, faint));
        }
        detail.push('',
          ...run.models.slice(0, 6).map(m => muted(`${plain(m.label)}`)));
      } else detail.push(muted('No evidence yet. Press r to review a new run.'));
      row();
      head('Runs', `${this.selectedRuns.size} selected`);
      row();
      // An unfinished run says how far it got, so a cancelled or interrupted one reads as
      // partial evidence rather than as a run that never happened.
      twoColumn(this.listRows(this.app.runs.map(r => {
        const live = ['running', 'interrupted', 'cancelled'].includes(r.status);
        const state = statusInk(r.status)(plain(r.status)) + (live ? faint(` ${r.trials.length}/${r.planned}`) : '');
        return `${dot(this.selectedRuns.has(r.id))} ${plain(shortRun(r.id))}  ${state}`;
      })), detail, inner, LIST_WIDTH).forEach(row);
      row();
      row(faint('space select   c compare   ⏎ evidence   e export'));
    }
    const footerStart = lines.length;
    row();
    // Keep status compact; long provider errors remain terminal-safe.
    // The same two keys do the same thing at every level, so the hint names both every time.
    const hint = this.dialog ? (this.typing() ? 'esc back' : 'esc · q  back')
      : this.controller ? 'esc cancel' : '? keys   esc · q  quit';
    const message = truncateToWidth(plain(this.message), Math.max(1, inner - visibleWidth(hint) - 3));
    row(spread(muted(message), faint(hint)));
    const regionLines = region === 'header' ? lines.slice(0, 3) : region === 'body' ? lines.slice(3, footerStart) : region === 'footer' ? lines.slice(footerStart) : lines;
    return regionLines.map(line => {
      const content = truncateToWidth(line, inner);
      const padded = `  ${content}${' '.repeat(Math.max(0, inner - visibleWidth(content)))}  `;
      return `${BACKDROP}${truncateToWidth(padded, width, '')}\x1b[0m`;
    });
  }
  private listRows(items: string[], visible = Math.max(6, this.bodyRows() - 9)): string[] {
    const selected = Math.min(this.selection[this.tab]!, Math.max(0, items.length - 1));
    this.selection[this.tab] = selected;
    const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), items.length - visible));
    // A single accent bar marks the cursor; the dot inside each row carries enabled/selected state.
    const rows = items.slice(Math.max(0, start), Math.max(0, start) + visible)
      .map((item, i) => (i + Math.max(0, start) === selected ? `${accent('▌')} ${item}` : `  ${item}`));
    return items.length > visible ? [...rows, '', faint(`${selected + 1} / ${items.length}   ↑↓`)] : rows;
  }
  private renderAuth(auth: AuthInfo, row: (text?: string) => void, prose: (text: string, paint?: (s: string) => string) => void): void {
    row(authLine(auth));
    prose(auth.note, faint);
  }
  private renderDialog(width: number, row: (text?: string) => void, prose: (text: string, paint?: (s: string) => string) => void, head: (title: string, right?: string) => void): void {
    row();
    if (this.dialog === 'picker') {
      head('Add model', 'filter the pinned catalog');
      row();
      this.input.render(width).forEach(row);
      this.list?.render(width).forEach(row);
      const entry = this.app.catalog[Number(this.list?.getSelectedItem()?.value ?? -1)];
      if (entry) { row(); row(muted(plain(entry.name))); this.renderAuth(entry.auth, row, prose); }
      row();
      row(faint('type to filter   ↑↓ choose   ⏎ next'));
    } else if (this.dialog === 'auth') {
      head('Authentication');
      row();
      if (this.candidate) { row(muted(`${plain(this.candidate.provider)}/${plain(this.candidate.id)}`)); this.renderAuth(this.candidate.auth, row, prose); }
      row(); this.list?.render(width).forEach(row);
      row();
      prose('Uses existing credentials only. Never logs in or sends a prompt here.', faint);
    } else if (this.dialog === 'test') {
      head('Add test', `step ${this.draft.length + 1} of 3`);
      row();
      prose(['Test ID · lowercase slug', 'Prompt · what should the model return?', 'Expected JSON · exact structured answer'][this.draft.length]!, muted);
      this.input.render(width).forEach(row);
      row();
      row(faint('⏎ next / save   esc discard'));
    } else if (this.dialog === 'delete') {
      head('Remove from configuration?');
      row();
      prose(this.deleteLabel);
      row();
      prose('Saved run evidence is kept. Test files are not deleted.', faint);
      row();
      row(amber('y') + faint(' remove   ') + amber('n') + faint(' keep'));
    } else if (this.dialog === 'preflight') {
      const opts = this.pendingOptions!;
      const metered = this.preflightAuth.some(m => ['metered', 'unknown'].includes(m.auth.billing));
      head('Preflight', `${opts.models!.length} × ${opts.tests!.length} × ${opts.repeat}`);
      row();
      row(field('Lane', opts.lane, `seed ${opts.seed}`));
      row(field('Cache', opts.cache ? teal('on') : amber('off'), `${opts.timeout}s · ${opts.maxTurns} turns · ${opts.maxTokens} tokens`));
      row();
      row(creditLine(this.preflightAuth));
      row();
      for (const model of this.preflightAuth) { row(bold(plain(model.label))); this.renderAuth(model.auth, row, prose); row(); }
      prose('Controls are synthetic. Missing auth yields no real evidence. Subscription calls draw on plan usage limits, not money. Estimated cost is not a spending cap.', faint);
      row();
      row(metered ? amber('⏎  billing confirmation — nothing runs yet') : accent('⏎  start run') + faint('   esc cancel'));
    } else if (this.dialog === 'billing') {
      head('Billing', 'explicit consent');
      row();
      prose('Metered or unknown billing is selected. This run may charge your provider account. There is no dollar spending cap.', amber);
      row();
      prose('Type PAY and press Enter to allow charges for this run only. Esc keeps billing disabled.', faint);
      this.input.render(width).forEach(row);
    } else if (this.dialog === 'help') {
      head('Keys');
      row();
      for (const [keys, what] of [
        ['tab · 1–5', 'switch view'], ['↑↓ · j k', 'move'], ['space', 'toggle or select'],
        ['a', 'add model or test'], ['d', 'remove, with confirmation'], ['u', 'restore last removed test'],
        ['r', 'review preflight'], ['− +', 'tries per test, or reviewer rounds on Settings'], ['l', 'tools / prompt lane'],
        ['p', 'prompt caching on / off'], ['t · T', 'time limit · turn limit per trial'], ['5', 'settings: design reviewer'], ['R', 'refresh metadata, sends nothing'],
        ['c · ⏎ · e', 'runs: compare, evidence, export'], ['m', 'comparison: summary / full report'], ['←→', 'evidence: previous / next trial'],
        ['space · b', 'report: page down / up'], ['gg · G', 'report: jump to top / bottom'], ['esc · q', 'leave what you are looking at: close a panel, else quit'], ['esc during a run', 'cancel it safely, keeping completed evidence'], ['during a run', 'tabs and ↑↓ work; edits wait'], ['ctrl+c', 'quit'],
      ] as const) row(`${accent(keys)}${' '.repeat(Math.max(2, 14 - keys.length))}${muted(what)}`);
    } else if (this.dialog === 'report' && this.reportMode === 'summary') {
      // One page that answers, top to bottom: who is best, which gaps are real, and where each
      // model is strong or weak. Every table has the models as columns, so a model is read down
      // one column and a task or skill across one row.
      const { cards: all, tasks, mixed } = scorecards(this.reportRuns);
      // Columns follow the ranking, so the best model is always the first one read.
      const ranked = ranking(all), cards = ranked.map(r => r.card);
      const tagged = harnesses(cards).length > 1;
      const names = cards.map(c => plain(c.label));
      const pad = (text: string, w: number) => { const t = truncateToWidth(text, Math.max(1, w - 1)); return t + ' '.repeat(Math.max(0, w - visibleWidth(t))); };
      head('Model comparison');
      row(muted(`${ranked.some(r => r.rank !== null) ? count(ranked.filter(r => r.rank !== null).length, 'model') : count(cards.length, 'synthetic control')} · ${count(tasks.length, 'task')} · ${triesLabel(cards)}${tagged || !cards.length || cards.every(c => c.synthetic) ? '' : ` · ${cards[0]!.harness}`}`));
      row();
      // The harness line says everything the generic one does, and names the likeliest cause.
      if (tagged) prose(HARNESS_WARNING, amber);
      else if (mixed) prose('Different suite, harness, lane or settings — these are not one controlled comparison.', amber);
      if (mixed || tagged) row();

      row(bold(LABEL.solved) + faint('   every task counts equally'));
      const nameW = Math.max(8, Math.min(22, Math.max(...names.map(n => n.length)) + 2));
      const tagW = tagged || cards.some(c => c.synthetic) ? Math.max(...cards.map(c => c.harness.length)) + 2 : 0;
      const barW = Math.max(6, Math.min(30, width - 4 - nameW - 12 - tagW - 10));
      for (const { card, rank } of ranked) {
        // A control's answers are fixed, so a rerun spread would be a number about nothing.
        const error = card.synthetic ? null : scoreError(card);
        const tag = tagW ? faint(pad(tagged || card.synthetic ? card.harness : '', tagW)) : '';
        row(muted(String(rank ?? '–').padStart(2)) + '  ' + pad(plain(card.label), nameW) + rateInk(card.score)(bar(card.score, barW)) + ' ' + bold(pct(card.score).padStart(4))
          + faint(pad(error === null ? '' : ` ±${Math.round(error * 100)}`, 6)) + tag + (card.notRun ? amber(`${card.notRun} not run`) : ''));
      }
      row();
      prose('Rank = 1 + how many models clearly beat it, so a shared rank means this run cannot tell them apart. ± = how far the number could move on a rerun.', faint);
      if (cards.some(c => c.synthetic)) prose('Synthetic controls check the grader, not a model, so they are never ranked.', faint);
      if (cards.some(c => c.notRun)) prose('Not run = lost to login, quota, crash or cancellation. It never counts against a model.', faint);
      const calls = verdicts(ranked), stalls = cards.map(stallNote).filter(n => n !== null);
      if (calls.length || stalls.length) {
        row();
        row(muted('Verdict'));
        for (const call of calls) prose(call);
        for (const note of stalls) prose(note, amber);
      }
      row();

      // Where each model is strong or weak: one row per slice, one column per model.
      const colW = Math.max(5, Math.min(16, Math.max(...names.map(n => n.length)) + 2, Math.floor((width - 10) / Math.max(1, cards.length))));
      const labelW = Math.max(8, Math.min(38, width - colW * cards.length));
      // In a narrow column "Claude opus" and "Claude sonnet" both truncate to "Cla…", so a first
      // word several models share is dropped there, leaving the part that tells them apart.
      const first = (n: string) => n.split(' ')[0];
      const heads = names.map(n => (n.length < colW || names.filter(m => first(m) === first(n)).length < 2 ? n : n.split(' ').slice(1).join(' ') || n));
      const columns = () => row(' '.repeat(labelW) + heads.map(n => muted(pad(n, colW))).join(''));
      // A label too long for its column gets its own line, so cells never lose their alignment.
      const line = (label: string, cells: string[], paint: (s: string) => string = s => s) => {
        if (visibleWidth(label) >= labelW) { row(paint(label)); row(' '.repeat(labelW) + cells.join('')); }
        else row(paint(pad(label, labelW)) + cells.join(''));
      };
      const rates = (values: (number | null)[]) => values.map(v => rateInk(v)(pad(pct(v), colW)));
      const tiers = cards.map(c => byTier(c, tasks));
      if (tiers[0]?.length) {
        row(bold('By difficulty') + faint('   share of tasks fully solved · (n) tasks'));
        columns();
        for (const [i, r] of tiers[0].entries()) line(`${TIER_NAME[r.tier]} (${r.total})`, rates(tiers.map(rows => rows[i]!.rate)));
        prose('Basic tasks tell small models apart; hard tasks tell the strongest apart.', faint);
        row();
      }
      const skills = cards.map(c => byCapability(c, tasks));
      if (skills[0]?.length) {
        row(bold('By skill') + faint('   share of tasks fully solved · (n) tasks'));
        columns();
        for (const [i, r] of skills[0].entries()) line(`${SKILL_NAME[r.capability]} (${r.total})`, rates(skills.map(rows => rows[i]!.rate)));
        row();
      }
      row(bold('Per task') + faint('   hardest first'));
      prose('Tries fully solved out of tries graded. ✓ every try solved, ✗ none, (80%) share of checks passed when not fully solved, · not graded. Rows where models differ are bright.', faint);
      columns();
      const paint = { solved: green, partly: amber, unsolved: rose, none: faint };
      const order = taskOrder(cards, tasks);
      for (const tier of [...new Set(order.map(i => tasks[i]!.tier ?? 'unrated'))]) {
        const group = order.filter(i => (tasks[i]!.tier ?? 'unrated') === tier);
        if (tasks.some(t => t.tier)) row(muted(TIER_NAME[tier]));
        // Rows every model fully solved say nothing about the difference, so they fold into one line.
        const everyone = group.filter(i => cards.every(c => c.tasks[i]!.rate === 1));
        for (const i of group.filter(i => !everyone.includes(i))) {
          const cells = cards.map(c => taskCell(c.tasks[i]!));
          const same = cells.every(x => x.text === cells[0]!.text);
          line(plain(tasks[i]!.title), cells.map(x => paint[x.kind](pad(visibleWidth(x.text) < colW ? x.text : x.text.replace(/ \(\d+%\)$/, ''), colW))), same ? faint : s => s);
        }
        if (everyone.length) row(faint(`${count(everyone.length, 'task')} every model solved: ${everyone.map(i => plain(tasks[i]!.title)).join(', ')}`));
      }
      row();

      // Signals that describe how a model worked, never part of the rank.
      const partial = cards.some(c => c.checkScore !== null && c.checkScore !== c.score);
      const signals = (['instructions', 'tools', 'design'] as const).filter(d => cards.some(c => c.dimensions[d] !== null));
      const gated = cards.some(c => c.hygiene.total);
      if (partial || signals.length || gated) {
        row(bold('Other signals') + faint('   never part of the rank'));
        columns();
        if (partial) line(LABEL.checks, rates(cards.map(c => c.checkScore)));
        for (const d of signals) line(LABEL[d], rates(cards.map(c => c.dimensions[d])));
        // A gate, never a bar or a percentage: its checks have never failed in any recorded run,
        // so a 100% beside the score would read as praise for an unmeasured thing.
        if (gated) {
          line(LABEL.hygiene, cards.map(c => (!c.hygiene.total ? faint : c.hygiene.passed === c.hygiene.total ? green : rose)(pad(gate(c.hygiene), colW))));
          prose('Safe-code gate: valid Python, standard library only, no eval — a floor, not a score.', faint);
        }
        row();
      }
      row(faint('m full report   e export'));
    } else {
      head(this.dialog === 'report' ? 'Comparison' : 'Evidence', this.dialog === 'report' ? 'selected runs' : 'observable checks');
      row();
      let content = this.report;
      if (this.dialog === 'evidence') {
        const run = this.detailRun!;
        const trial = run.trials[this.trialIndex];
        row(faint(`trial ${trial ? this.trialIndex + 1 : 0} / ${run.trials.length}   ←→`));
        if (trial) {
          const state = outcome(trial.status);
          const chip = state.kind === 'pass' ? green('PASS') : state.kind === 'scored' ? amber('SCORED') : rose('NOT RUN');
          row();
          row(`${chip}  ${bold(plain(trial.model))}${muted(' / ')}${plain(trial.task)}${faint(`  try ${trial.repetition}`)}`);
          // "not run" never means a wrong answer: those trials are excluded from correctness.
          row(faint(state.kind === 'not-run' ? `${state.text} — excluded from scores, not counted against the model` : `${trial.checks.filter(c => c.passed).length} of ${trial.checks.length} checks passed`));
          // A censored trial is recoverable, and the fix is one key away on Home.
          if (trial.status === 'timeout') row(faint(`The model was still working at ${run.options.timeout}s. Raise the limit with t on Home and rerun to get a real outcome.`));
          row();
          for (const dimension of ['correctness', 'instructions', 'tools', 'design', 'hygiene'] as const) {
            const checks = trial.checks.filter(c => c.dimension === dimension);
            if (!checks.length) continue;
            const rate = checks.filter(c => c.passed).length / checks.length;
            row(`${muted(dimension.padEnd(14))}${rateInk(rate)(bar(rate))} ${muted(`${checks.filter(c => c.passed).length}/${checks.length}`)}`);
          }
          row();
          row(faint(`${(trial.wallMs / 1000).toFixed(1)}s wall · ${(trial.modelMs / 1000).toFixed(1)}s model · ${trial.tokens ? `${trial.tokens.input} in / ${trial.tokens.output} out` : 'tokens unavailable'} · ${plain(trial.auth.mode)}`));
          row();
        }
        const failed = trial?.checks.filter(c => !c.passed) ?? [];
        content = trial ? [
          ...(trial.error ? [`Error: ${trial.error}`, ''] : []),
          ...(failed.length ? ['Why it did not pass', ...failed.map(c => `FAIL [${c.dimension}] ${c.id}\n${c.evidence}`), ''] : []),
          ...(trial.checks.length ? ['Passed', ...trial.checks.filter(c => c.passed).map(c => `PASS [${c.dimension}] ${c.id}`), ''] : ['No checks recorded. Not passing evidence.', '']),
          'Answer', trial.answer || '(empty)',
          ...(trial.trace.length ? ['', 'Tool trace', ...trial.trace.map(t => `${t.ok ? 'OK' : 'ERROR'} ${t.tool} · ${t.ms}ms\n${JSON.stringify(t.args)}\n${t.output}`)] : []),
        ].join('\n') : 'No trials recorded.';
      }
      const wrapped = wrapTextWithAnsi(terminalText(content), width);
      // Fill the window: the panel's own chrome is the head, the blanks and the status line.
      const page = Math.max(6, this.bodyRows() - (this.dialog === 'evidence' ? 7 : 5));
      this.reportLength = wrapped.length;
      this.reportPage = page;
      this.reportOffset = Math.min(this.reportOffset, Math.max(0, wrapped.length - page));
      wrapped.slice(this.reportOffset, this.reportOffset + page).forEach(row);
      row();
      row(faint(`${this.reportOffset + 1}–${Math.min(wrapped.length, this.reportOffset + page)} of ${wrapped.length}   ↑↓ line · space/b page · gg/G ends · e export`));
    }
  }
}

export async function launchTui(app: App): Promise<void> {
  // ProcessTerminal captures this environment path at construction. Do not let
  // an inherited debug setting write terminal content outside this workspace.
  const writeLog = process.env.PI_TUI_WRITE_LOG;
  delete process.env.PI_TUI_WRITE_LOG;
  let terminal: ProcessTerminal;
  try { terminal = new ProcessTerminal(); }
  finally { if (writeLog !== undefined) process.env.PI_TUI_WRITE_LOG = writeLog; }
  const tui = new TuiAltScreen(terminal, false, app.root, { copyOnSelect: false });
  await new Promise<void>((resolve, reject) => {
    const dashboard = new Dashboard(app, () => { body.scrollToStart(); tui.requestRender(); }, () => { tui.stop(); resolve(); }, () => terminal.rows);
    const pane = (region: 'header' | 'body' | 'footer'): Component => ({
      render: width => dashboard.render(width, region), invalidate: () => dashboard.invalidate(),
    });
    const body = new ScrollView(pane('body'), { primary: true, follow: 'none', scrollbarThumbStyle: accent });
    tui.addChild(dashboard);
    tui.setLayoutRoot(new VStack([
      { component: pane('header'), basis: 3, shrink: 0 },
      { component: body, basis: 0, grow: 1, minSize: 1 },
      { component: pane('footer'), basis: 'auto', shrink: 0 },
    ]));
    tui.setFocus(dashboard);
    try { tui.start(); } catch (error) { tui.stop(); reject(error); }
  });
}
