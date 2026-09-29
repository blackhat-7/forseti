import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  Input, SelectList, ProcessTerminal, TuiAltScreen, Text, ScrollView, VStack,
  matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type Focusable, type TuiMouseEvent,
} from '@earendil-works/pi-tui';
import type { App, CatalogEntry } from './app.ts';
import { FINISHED, comparisonReport, LABEL, STALL, SKILL_NAME, TIER_NAME, bar, outcome, scorecards } from './report.ts';
import { DEFAULT_OPTIONS } from './config.ts';
import { activeRunId, readRun } from './runner.ts';
import { LOCAL } from './local.ts';
import type { AuthInfo, ModelConfig, Progress, Run, RunOptions, Task, Trial } from './types.ts';
export { terminalText, terminalReport } from './ui/kit.ts';
import { terminalText, plain, terminalReport, BACKDROP, accent, teal, green, amber, rose, muted, faint, SERIES, bold, theme, tabs, GRADED_ON, THINKING, JUDGE_FIELDS, LOCAL_ROW, TIMEOUTS, TURNS, PARALLEL, dot, nick, remaining, CARD, pill, cards, keyHints, padTo, duration, authLine, field, creditLine, count, tries, width_, pct, rateInk, MAX_TEXT, LIST_WIDTH, twoColumn, table } from './ui/kit.ts';
import { comparisonPage, runLine } from './ui/board.ts';
import { type Line, piChat, claudeChat } from './ui/live.ts';

/** Tab positions, in the order `tabs` names them and keys 1–6 select them. */
const HOME = 0, LIVE = 1, MODELS = 2, TESTS = 3, RUNS = 4, SETTINGS = 5;
type UIApp = Pick<App, 'root' | 'config' | 'suite' | 'runs' | 'catalog' | 'localModels' | 'persist' | 'refresh' | 'run' | 'compare' | 'exportReport' | 'leaderboard' | 'addModel' | 'addTest' | 'authFor' | 'setLocalUrl' | 'probeLocal'>;
type Dialog = 'picker' | 'auth' | 'test' | 'delete' | 'cancel' | 'preflight' | 'billing' | 'report' | 'evidence' | 'help' | 'local';

export class Dashboard implements Component, Focusable {
  private app: UIApp;
  private repaint: () => void;
  private exit: () => void;
  private input = new Input({ prompt: '› ' });
  private list?: SelectList;
  private tab = HOME;
  private selection = [0, 0, 0, 0, 0, 0];
  private dialog?: Dialog;
  private message = '';
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
  /**
   * The run in progress, read from disk wherever it was started — this TUI, the CLI or another
   * terminal — so every run shows the same screen. The lock names it, its run.json holds the tries
   * that finished, and its newest trial folder is the try in progress.
   */
  private live?: Run;
  /** Every try in progress: with tries running side by side there can be several. */
  private nows: { model: string; task: string; since: number; step: string; chat: Line[] }[] = [];
  private reportLength = 0;
  private reportPage = 12;
  private everyTask = false;
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
  private resetScroll: () => void;
  /** The last drawing, reused by the regions drawn after the header in the same frame. */
  private frame?: { width: number; lines: string[]; footerStart: number };
  /** What a click can reach, found while drawing: `line` is counted within its region, `x` in screen columns. */
  private hits: { region: 'header' | 'body'; line: number; x0: number; x1: number; act: (clicks: number) => void }[] = [];
  /** Body hits while drawing, by the line index they had before cards were framed. */
  private pending: { at: number; x0: number; x1: number; act: (clicks: number) => void }[] = [];
  constructor(app: UIApp, repaint: () => void = () => {}, exit: () => void = () => {}, rows: () => number = () => 24, resetScroll: () => void = () => {}) {
    this.app = app;
    this.repaint = repaint;
    this.exit = exit;
    this.rows = rows;
    this.resetScroll = resetScroll;
    // Read now without repainting: nothing is on screen yet, and the caller's render hook may not exist until this returns.
    this.watch(false);
    // Opened during a run, the run is what the user came to see.
    if (this.live) this.tab = LIVE;
    setInterval(() => this.watch(), 2000).unref();
  }
  private watch(repaint = true): void {
    const id = activeRunId(this.app.root), ended = this.live && !id;
    this.live = id ? readRun(this.app.root, id) : undefined;
    this.nows = [];
    if (this.live) {
      const run = this.live, dir = join(this.app.root, 'runs', run.id, 'trials');
      // A trial folder exists from the moment its try starts; one with no result yet is in progress.
      for (const open of existsSync(dir) ? readdirSync(dir).sort().filter(name => !run.trials.some(t => t.id === name)) : []) {
        const model = run.models.find(m => run.tasks.some(t => open.slice(5) === `${m.id}-${t.id}`));
        const task = model && run.tasks.find(t => open.slice(5) === `${model.id}-${t.id}`);
        if (!model || !task) continue;
        // The Pi agent logs every turn and tool call; Claude Code logs only its start and end.
        const events = readFileSync(join(dir, open, 'events.jsonl'), 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l).event]; } catch { return []; } });
        const turns = events.filter(e => e.type === 'assistant').length, tool = events.findLast(e => e.type === 'tool')?.event?.tool;
        const chat = model.provider === 'claude-code' ? claudeChat(join(dir, open, 'public')) : piChat(events);
        this.nows.push({ model: model.label, task: task.title, since: statSync(join(dir, open)).birthtimeMs, step: turns ? `turn ${turns}${tool ? ` · ${tool}` : ''}` : '', chat });
      }
    }
    // A run started elsewhere just ended: its results are new, so the leaderboard reloads.
    if (!repaint) return;
    if (ended && !this.controller) void this.app.refresh().then(() => this.repaint());
    if (this.live || ended) this.repaint();
  }
  /** Rows the body region actually gets: the window minus the 3-line header and 3-line footer. */
  private bodyRows(): number { return Math.max(8, Math.min(200, Math.trunc(this.rows()) || 24) - 6); }
  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  invalidate(): void { this.input.invalidate(); this.list?.invalidate(); }

  private listLength(): number {
    return this.tab === MODELS ? this.app.config.models.length : this.tab === TESTS ? this.tasks().length
      : this.tab === SETTINGS ? JUDGE_FIELDS.length + 1 : this.tab === RUNS ? this.app.runs.length : 0;
  }
  private tasks() { return this.app.suite.tasks.filter(t => !this.app.config.removedTests.includes(t.id)); }
  private enabledTasks() { return this.tasks().filter(t => !this.app.config.disabledTests.includes(t.id)); }
  private models() { return this.app.config.models.filter(m => m.enabled); }
  /** Dialogs that take typed text, where `q` is a letter and only escape can mean "leave". */
  private typing(): boolean { return this.dialog === 'test' || this.dialog === 'billing' || this.dialog === 'picker' || this.dialog === 'local'; }
  private close(): void { this.pendingG = false; this.dialog = undefined; this.list = undefined; this.input.setValue(''); this.pendingDelete = undefined; this.pendingOptions = undefined; }
  private attempt(action: () => void): void {
    try { action(); } catch (error) { this.message = `Error: ${plain(error instanceof Error ? error.message : error)}`; }
  }
  private persist(change: () => void): void {
    const before = structuredClone(this.app.config);
    try { change(); this.app.persist(); } catch (error) { this.app.config = before; throw error; }
  }

  handleInput(data: string): void {
    this.act(() => this.key(data));
  }
  /** Runs one user action. A different tab or panel starts at its top; anything else keeps the scroll where the user left it. */
  private act(action: () => void): void {
    const view = `${this.tab}:${this.dialog}`;
    this.attempt(action);
    if (`${this.tab}:${this.dialog}` !== view) this.resetScroll();
    this.repaint();
  }
  /**
   * A click on the header or body. `line` counts from the top of that region's content, `x` from its
   * left edge; a double click on a list row does what enter would.
   */
  click(region: 'header' | 'body', line: number, x: number, clicks = 1): boolean {
    const target = this.hits.find(h => h.region === region && h.line === line && x >= h.x0 && x < h.x1);
    if (!target) return false;
    this.act(() => target.act(clicks));
    return true;
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
      else if (this.controller && data === 'q') this.message = 'A run is in progress. Press esc to cancel it.';
      // Cancelling throws away the tries not yet made, so it is asked, never done on one key.
      else if (this.controller || (this.live && key('escape'))) this.dialog = 'cancel'; else if (this.refreshing && data === 'q') this.message = 'Refreshing metadata. Press esc to stop waiting.';
      else this.exit();
      return;
    }
    if (this.dialog) { if (!this.controller || this.dialog === 'cancel') this.dialogKey(data); return; }
    // Looking around is always allowed. A run is long, and being pinned to one screen while it
    // works is why a cancelled run felt like it had vanished.
    if (key('tab') || key('shift+tab') || key('left') || key('right') || /^[1-6]$/.test(data)) {
      this.tab = /^[1-6]$/.test(data) ? Number(data) - 1 : (this.tab + (key('shift+tab') || key('left') ? tabs.length - 1 : 1)) % tabs.length;
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
      if (this.tab === SETTINGS) this.persist(() => { this.app.config.judge.repeat = Math.max(1, Math.min(5, this.app.config.judge.repeat + step)); });
      else this.options.repeat = Math.max(1, Math.min(20, this.options.repeat + step));
      return;
    }
    // The leaderboard is what this tool is for, so it opens from anywhere.
    if (data === 'L') {
      const board = this.app.leaderboard();
      if (!board) throw new Error('No finished tries yet. Start with r.');
      this.report = terminalReport(comparisonReport([board])); this.reportRuns = [board]; this.reportOffset = 0; this.reportMode = 'summary'; this.dialog = 'report'; return;
    }
    if (data === 'l') { this.options.lane = this.options.lane === 'tools' ? 'prompt' : 'tools'; return; }
    if (data === 'p') { this.options.cache = !this.options.cache; return; }
    if (data === 't') { this.options.timeout = TIMEOUTS[(TIMEOUTS.indexOf(this.options.timeout) + 1) % TIMEOUTS.length] ?? 180; return; }
    if (data === 'P') { this.persist(() => { this.app.config.parallel = PARALLEL[(PARALLEL.indexOf(this.app.config.parallel ?? 1) + 1) % PARALLEL.length]; }); return; }
    if (data === 'T') { this.options.maxTurns = TURNS[(TURNS.indexOf(this.options.maxTurns) + 1) % TURNS.length] ?? 12; return; }
    const index = this.selection[this.tab]!;
    if (this.tab === MODELS) {
      if (data === 'a') { this.openPicker(); return; }
      const model = this.app.config.models[index];
      if (!model) return;
      if (key('space') || key('enter')) this.persist(() => { model.enabled = !model.enabled; });
      if (data === 'd') this.confirmDelete(model.label, () => this.persist(() => { this.app.config.models = this.app.config.models.filter(m => m.id !== model.id); }));
    } else if (this.tab === TESTS) {
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
    } else if (this.tab === RUNS) {
      const run = this.app.runs[index];
      if (key('space') && run) { if (this.selectedRuns.has(run.id)) this.selectedRuns.delete(run.id); else this.selectedRuns.add(run.id); }
      if (key('enter') && run) { this.detailRun = run; this.trialIndex = 0; this.reportOffset = 0; this.dialog = 'evidence'; }
      if (data === 'c') { const ids = this.runIds(); this.report = terminalReport(this.app.compare(ids)); this.reportRuns = this.app.runs.filter(r => ids.includes(r.id)); this.reportOffset = 0; this.reportMode = 'summary'; this.dialog = 'report'; }
      if (data === 'e') this.export();
    } else if (this.tab === SETTINGS && (key('space') || key('enter'))) {
      const judge = this.app.config.judge;
      if (index === 0) this.persist(() => { judge.enabled = !judge.enabled; });
      else if (index === 1) this.openPicker('judge');
      else if (index === 2) this.persist(() => { judge.thinking = THINKING[(THINKING.indexOf(judge.thinking) + 1) % THINKING.length]!; });
      else if (index === LOCAL_ROW) { this.dialog = 'local'; this.input.setValue(this.app.config.local.url); }
      else this.persist(() => { judge.repeat = (judge.repeat % 5) + 1; });
    }
  }
  private runIds(): string[] {
    const ids = this.app.runs.filter(r => this.selectedRuns.has(r.id)).map(r => r.id);
    const current = this.app.runs[this.selection[RUNS]!];
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
    // The server is asked what it serves the first time someone looks for a model, not at startup.
    if (target === 'model' && this.app.config.local.url && !this.app.localModels) void this.probeLocal();
  }
  private async probeLocal(): Promise<void> {
    const url = plain(this.app.config.local.url);
    this.message = `Listing models at ${url}… no prompt is sent.`;
    this.repaint();
    try {
      const found = await this.app.probeLocal();
      this.message = `${url}: ${count(found.length, 'model')} listed. Press a on Models to add one.`;
    } catch (error) { this.message = `Local server: ${plain(error instanceof Error ? error.message : error)}`; }
    finally { if (this.dialog === 'picker') this.filterPicker(); this.repaint(); }
  }
  private filterPicker(): void {
    const filter = this.input.getValue().toLowerCase();
    // Do not offer what will be refused: a synthetic control has no model behind it to review with.
    const items = this.app.catalog.map((c, index) => ({ c, index }))
      .filter(({ c }) => this.pickerTarget !== 'judge' || (c.provider !== 'control' && c.provider !== LOCAL))
      .map(({ c, index }) => ({ value: String(index), label: plain(`${c.provider}/${c.id} · ${c.name}`) }));
    this.list = new SelectList(items.filter(item => item.label.toLowerCase().includes(filter)), 7, theme);
    this.list.onSelect = item => {
      this.candidate = this.app.catalog[Number(item.value)];
      if (!this.candidate) return;
      const judge = this.pickerTarget === 'judge';
      if (judge && this.candidate.provider === 'control') throw new Error('A synthetic control has no model behind it and cannot review anything.');
      this.dialog = 'auth';
      // Claude Code authenticates itself and a local server takes no credential, so there is nothing to choose.
      this.list = new SelectList(this.candidate.provider === 'claude-code'
        ? [{ value: 'cli', label: 'Claude Code CLI', description: 'Your own plan login; no API key is used' }]
        : this.candidate.provider === LOCAL
          ? [{ value: 'none', label: 'Your own server', description: 'No credential, no charge' }]
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
    } else if (this.dialog === 'local') {
      if (!key('enter')) { this.input.handleInput(data); this.cleanInput(); return; }
      const value = this.input.getValue().trim();
      this.app.setLocalUrl(value);
      this.close();
      if (value) void this.probeLocal();
      else this.message = 'Local server removed. Models added from it stay listed until you remove them.';
    } else if (this.dialog === 'delete') {
      if (data === 'y') { this.pendingDelete?.(); this.close(); this.message = 'Removed from configuration. Existing run evidence is unchanged.'; }
      else if (data === 'n') this.close();
    } else if (this.dialog === 'cancel') {
      if (data === 'n') this.close();
      else if (data === 'y') {
        this.close();
        if (this.controller) this.controller.abort();
        // A run started elsewhere stops the way it would on its own Ctrl+C: finished tries are kept.
        else try { process.kill(JSON.parse(readFileSync(join(this.app.root, '.state/run.lock'), 'utf8')).pid, 'SIGINT'); }
        catch { this.message = 'That run already ended.'; return; }
        this.message = 'Cancelling… keeping completed evidence.';
      }
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
      else if (data === 'a' && this.dialog === 'report') this.everyTask = !this.everyTask;
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
    const options = { ...this.pendingOptions, allowMetered, parallel: this.app.config.parallel ?? 1 };
    this.close();
    this.controller = new AbortController();
    this.progress = undefined;
    this.live = undefined;
    this.lastFailure = '';
    this.message = 'Starting run… Esc cancels safely.';
    this.tab = LIVE;
    this.repaint();
    try {
      const run = await this.app.run(options, p => {
        // The runner saves run.json after each try, just before reporting it, so a new count means a new result on disk.
        if (p.completed !== this.live?.trials.length) this.watch();
        this.progress = p; this.repaint();
      }, this.controller.signal);
      // A reviewer that was switched on and scored nothing is worth saying out loud. Its
      // failures are per-trial notes by design, which is easy to miss when every trial otherwise
      // looks fine.
      // The run's own outcome stays first: the footer truncates, and burying it behind a
      // reviewer warning hides the thing the user actually asked for. The warning is short here
      // and the reason is on the Runs tab, which does not truncate.
      const silent = run.judge?.enabled && !run.trials.some(t => t.checks.some(c => c.dimension === 'design'));
      this.message = `Run ${plain(run.status)} · ${run.trials.length}/${run.planned} trials retained.`
        + (silent ? ' Reviewer scored nothing.' : '');
      this.tab = RUNS;
      this.selection[RUNS] = 0;
    } catch (error) {
      // A run that never reached its first trial leaves no manifest, so the Runs list cannot
      // explain itself. Keep the reason on screen instead of in a status line that scrolls away.
      this.lastFailure = plain(error instanceof Error ? error.message : error);
      this.message = `Run stopped: ${this.lastFailure}`;
      this.tab = HOME;
    }
    finally { this.controller = undefined; this.progress = undefined; this.repaint(); }
  }
  /** The keys that do something where the user is right now. Dialogs with a prompt carry their own. */
  private keys(): string {
    if (this.dialog === 'report') return this.reportMode === 'summary' ? `m full report   a ${this.everyTask ? 'fold' : 'show'} solved tasks   e export   ↑↓ space b scroll` : 'm summary   e export   ↑↓ space b scroll';
    if (this.dialog === 'evidence') return '←→ trial   ↑↓ space b scroll   gg G ends   e export';
    if (this.dialog) return '';
    if (this.controller) return 'tabs and ↑↓ still work · edits wait for the run';
    return [
      'r run   − + tries   l lane   t limit   T turns   p cache   P at once',
      'r run   L leaderboard',
      'space toggle   a add   d remove',
      'space toggle   a add   d remove   u restore',
      'space select   c compare   L leaderboard   ⏎ evidence   e export',
      'space change   − + rounds',
    ][this.tab]!;
  }

  /**
   * The header, body and footer are three components on screen but one drawing: the header, drawn
   * first in each frame, draws everything and the other two reuse it. Scrolling redraws the body
   * alone, and so costs nothing.
   */
  render(width: number, region: 'all' | 'header' | 'body' | 'footer' = 'all'): string[] {
    if (width <= 0) return [''];
    if (region === 'all' || region === 'header' || this.frame?.width !== width) this.frame = { width, ...this.draw(width) };
    const { lines, footerStart } = this.frame;
    return region === 'header' ? lines.slice(0, 3) : region === 'body' ? lines.slice(3, footerStart) : region === 'footer' ? lines.slice(footerStart) : lines;
  }
  private draw(width: number): { lines: string[]; footerStart: number } {
    this.pending = [];
    // Content sits inside a card: two columns of margin, then a border and a space on each side.
    // Under 60 columns borders would eat the content, so cards keep only their titles.
    const boxed = width >= 60, outer = Math.max(1, width - 4), inner = Math.max(1, boxed ? outer - 4 : outer);
    const lines: string[] = [];
    const row = (text = '') => lines.push(text);
    const wrap = (text: string, w: number, paint: (s: string) => string = s => s) =>
      new Text(terminalText(text), 0, 0).render(Math.max(12, w)).map(paint);
    const prose = (text: string, paint: (s: string) => string = s => s) =>
      lines.push(...wrap(text, Math.min(inner, MAX_TEXT), paint));
    // Detail panes wrap to their own column when side by side, to the full width when stacked.
    const detailWidth = Math.min(inner >= LIST_WIDTH + 32 ? inner - LIST_WIDTH - 2 : inner, MAX_TEXT);
    const spreadAt = (left: string, right: string, w: number) => {
      const gap = w - width_(left) - width_(right);
      return gap < 2 ? left : `${left}${' '.repeat(gap)}${right}`;
    };
    const spread = (left: string, right: string) => spreadAt(left, right, inner);
    // A heading opens a card; the frame is drawn around the section once the body is complete.
    const head = (title: string, right = '') => row(`${CARD}${title}\u0000${right}`);

    // While a run is live the header carries it, so it is never out of sight on another tab.
    const p = this.progress;
    const summary = this.controller || this.live
      ? `${this.controller?.signal.aborted ? 'stopping' : 'running'} · ${this.live?.trials.length ?? 0}/${this.live?.planned ?? '?'}`
      : `${count(this.models().length, 'model')} · ${count(this.enabledTasks().length, 'test')} · ${tries(this.options.repeat)}`;
    // One line: the name, the tabs as pills with the active one filled, and the run's status.
    const busy = Boolean(this.controller || this.live);
    const pills = tabs.map((t, i) => (i === this.tab ? pill(` ${t} `) : muted(` ${t} `))).join(' ');
    const status = width >= 72 ? (busy ? green('● ') + accent(summary) : faint(summary)) : '';
    row();
    row(spreadAt(`${bold(accent('forseti'))}  ${pills}`, status, outer));
    row();

    if (this.dialog) this.renderDialog(inner, row, prose, head);
    else if (this.tab === LIVE) {
      const top = lines.length;
      const run = this.live, done = run?.trials.length ?? 0, total = run?.planned ?? 0, share = total ? done / total : 0;
      // Time left from the pace so far: finished tries are the only honest predictor available.
      const left = run && done && total > done ? remaining((Date.now() - Date.parse(run.created)) / done * (total - done)) : '';
      head(this.controller?.signal.aborted ? 'Stopping safely' : 'Running', `${done} of ${total || '?'} tries${left ? ` · about ${left} left` : ''}`);
      const label = ` ${Math.round(share * 100)}%`, cells = Math.max(8, inner - label.length);
      row(accent('━'.repeat(Math.round(cells * share))) + faint('━'.repeat(cells - Math.round(cells * share))) + bold(label));
      head('Now', this.nows.length ? `${tries(this.nows.length)} in progress` : '');
      if (this.nows.length) {
        const nameW = Math.min(20, Math.max(...this.nows.map(n => width_(nick(n.model)))) + 2);
        for (const n of this.nows) {
          const detail = [n.step, duration(Date.now() - n.since)].filter(Boolean).join(' · ');
          row(`${bold(padTo(nick(n.model), nameW))}${padTo(plain(n.task), Math.max(8, inner - nameW - width_(detail) - 2))}  ${faint(detail)}`);
        }
      } else row(muted('Preparing isolated trial workspaces…'));
      const live = this.live;
      const feed = (live?.trials ?? []).map(trial => ({ model: live!.models.find(m => m.id === trial.model)?.label ?? trial.model, task: live!.tasks.find(t => t.id === trial.task)?.title ?? trial.task, trial }));
      if (feed.length) {
        // Solved means every correctness check passed, the same rule the leaderboard scores by.
        const solved = (t: Trial) => t.checks.some(c => c.dimension === 'correctness') && t.checks.filter(c => c.dimension === 'correctness').every(c => c.passed);
        const models = [...new Set(feed.map(f => nick(f.model)))];
        const nameW = Math.min(20, Math.max(...models.map(m => width_(m))) + 2);
        head('Results', 'solved of finished');
        for (const [i, model] of models.entries()) {
          const mine = feed.filter(f => nick(f.model) === model).map(f => f.trial), finished = mine.filter(t => FINISHED.includes(t.status));
          const won = finished.filter(solved).length, out = finished.filter(t => STALL.includes(t.status)).length, wrong = finished.length - won - out;
          const tail = [wrong ? rose(`${wrong} wrong`) : '', out ? amber(`${out} ran out`) : '', mine.length > finished.length ? faint(`${mine.length - finished.length} not run`) : ''].filter(Boolean).join(faint('  ·  '));
          const barW = Math.max(0, Math.min(32, inner - nameW - 8 - 34));
          row(`${bold(padTo(model, nameW))}${barW ? SERIES[i % SERIES.length]!(bar(finished.length ? won / finished.length : 0, barW)) + '  ' : ''}${bold(`${won}/${finished.length}`.padStart(5))}   ${tail}`);
        }
        const latest = feed.slice(-6).reverse();
        const note = (trial: Trial) => {
          const correct = trial.checks.filter(c => c.dimension === 'correctness');
          return !FINISHED.includes(trial.status) ? 'not run' : STALL.includes(trial.status) ? 'ran out' : solved(trial) ? '' : `${correct.filter(c => c.passed).length}/${correct.length} checks`;
        };
        head('Latest', 'newest first');
        for (const { model, task, trial } of latest) {
          const mark = !FINISHED.includes(trial.status) ? faint('·') : STALL.includes(trial.status) ? amber('◷') : solved(trial) ? green('✓') : rose('✗');
          const out = trial.tokens?.output ?? 0, tokens = trial.tokens ? (out < 1000 ? '<1k' : `${Math.round(out / 1000)}k`) : '';
          const tail = `${padTo(note(trial), 12)}${duration(trial.wallMs).padStart(6)}${tokens.padStart(6)}`;
          row(`${mark} ${bold(padTo(nick(model), nameW))}${padTo(plain(task), Math.max(8, inner - 2 - nameW - width_(tail)))}${faint(tail)}`);
        }
      }
      // Each try's own conversation, when the window has room: side by side when it is wide enough for
      // a readable column each, stacked when it is tall, and the short form above when it is neither.
      const framed = lines.slice(top).filter(l => l.startsWith(CARD)).length;
      const room = this.bodyRows() - (lines.length - top - framed) - 3 * framed - 4, talking = this.nows.filter(n => n.chat.length);
      const said = (l: Line, w: number) => l.say
        ? wrap(plain(l.say).replace(/\s+/g, ' '), Math.max(12, w - 2)).map((t, i) => `${i ? ' ' : faint('◆')} ${t}`)
        : [`${l.failed ? rose('✗') : faint('→')} ${accent(padTo(l.tool ?? '', 13))}${faint(truncateToWidth(l.target ?? '', Math.max(4, w - 16)))}`];
      const column = (n: typeof talking[number], w: number, height: number, titled: boolean) =>
        [...(titled ? [bold(truncateToWidth(nick(n.model), w)) + faint(truncateToWidth(`  ${plain(n.task)}`, Math.max(0, w - width_(nick(n.model)))))] : []), ...n.chat.flatMap(l => said(l, w)).slice(-(height - (titled ? 1 : 0)))];
      const colW = talking.length ? Math.floor((inner - 3 * (talking.length - 1)) / talking.length) : 0;
      const cell = (text: string, w: number) => { const t = truncateToWidth(text, w); return t + ' '.repeat(Math.max(0, w - width_(t))); };
      if (talking.length === 1 && room >= 7) {
        head('Live', `${nick(talking[0]!.model)} · ${plain(talking[0]!.task)}`);
        column(talking[0]!, inner, room - 3, false).forEach(line => row(line));
      } else if (talking.length > 1 && room >= 8 && colW >= 38) {
        head('Live', 'side by side');
        const cols = talking.map(n => column(n, colW, room - 3, true));
        for (let r = 0; r < Math.max(...cols.map(c => c.length)); r++) row(cols.map(c => cell(c[r] ?? '', colW)).join(faint(' │ ')));
      } else if (talking.length > 1 && room >= 8 && Math.floor((room - 3) / talking.length) >= 4) {
        head('Live');
        for (const [i, n] of talking.entries()) { if (i) row(); column(n, inner, Math.floor((room - 3) / talking.length) - 1, true).forEach(line => row(line)); }
      }
      // The leaderboard stays on Home during a run: results already on record, below the run's own.
      const board = this.app.leaderboard();
      if (board) {
        head('Leaderboard', 'L for the full page');
        comparisonPage([board], inner, false, true).forEach(line => row(line));
      }
    } else if (this.tab === HOME) {
      const enabled = this.models();
      // The answer comes first: how the models compare, from every comparable try on record.
      const board = this.app.leaderboard();
      row();
      head('Leaderboard', board ? 'L for the full page' : '');
      row();
      if (board) comparisonPage([board], inner, false, true).forEach(line => row(line));
      else prose('No finished tries yet. Press r to run the suite.', faint);
      row();
      // What r would do, in one line; the keys to change it are in the footer.
      head('Next run', 'r to review');
      row();
      prose(`${count(enabled.length, 'model')} × ${count(this.enabledTasks().length, 'test')} × ${tries(this.options.repeat)} · ${this.options.lane} lane · ${this.options.timeout}s · ${this.options.maxTurns} turns · cache ${this.options.cache ? 'on' : 'off'} · ${this.app.config.parallel ?? 1} at once`, muted);
      prose('Tries already on record under the same conditions are skipped.', faint);
      row(creditLine([
        ...enabled.map(m => ({ label: plain(m.label), auth: this.app.authFor(m) })),
        ...(this.app.config.judge.enabled ? [{ label: 'reviewer', auth: this.app.authFor({ ...this.app.config.judge, id: 'judge', label: 'judge', enabled: true }) }] : []),
      ]));
      if (this.lastFailure) {
        row();
        row(rose('Last attempt produced no run'));
        prose(this.lastFailure, rose);
        prose('Nothing was recorded, so there is nothing on the Runs tab for it. Fix this and press r again.', faint);
      }
    } else if (this.tab === MODELS) {
      const models = this.app.config.models;
      const model = models[this.selection[MODELS]!];
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
      twoColumn(this.listRows(models.map(m => `${dot(m.enabled)} ${plain(m.label)}`), lines.length), detail, inner, LIST_WIDTH).forEach(row);
    } else if (this.tab === TESTS) {
      const tasks = this.tasks();
      const task = tasks[this.selection[TESTS]!];
      row();
      head('Tests', `${this.enabledTasks().length} of ${tasks.length} enabled`);
      row();
      twoColumn(this.listRows(tasks.map(t => `${dot(!this.app.config.disabledTests.includes(t.id))} ${plain(t.title)}`), lines.length),
        task ? this.taskDetail(task, detailWidth, wrap) : [muted('No tests yet. Press a to create an exact-JSON test.')], inner, LIST_WIDTH).forEach(row);
    } else if (this.tab === SETTINGS) {
      const judge = this.app.config.judge;
      const auth = this.app.authFor({ ...judge, id: 'judge', label: 'judge', enabled: true });
      const local = this.app.config.local.url;
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
          const marker = i === this.selection[SETTINGS] ? accent('›') : ' ';
          return `${marker} ${muted(label)}${' '.repeat(Math.max(2, 12 - label.length))}${values[i]}`;
        }), '',
        judge.enabled ? authLine(auth) : faint('Nothing is sent while the reviewer is off.'), '',
        muted('Local server'), '',
        `${this.selection[SETTINGS] === LOCAL_ROW ? accent('›') : ' '} ${muted('Address')}${' '.repeat(Math.max(2, 12 - 'Address'.length))}${local ? accent(plain(local)) : faint('not set')}`,
        faint(!local ? 'space to point at llama-server, Ollama, LM Studio…' : this.app.localModels ? `${count(this.app.localModels.length, 'model')} listed · a on Models adds one` : 'space to change · a on Models lists its models'),
      ], [
        muted('What this changes'), '',
        ...wrap('A reviewer model answers fixed yes/no questions about design on submissions that already passed every correctness check. It never touches the correctness score.', detailWidth, faint), '',
        ...wrap('Each defect must cite a line that exists in the submission. Uncitable ones are dropped, so an invented finding costs the candidate nothing.', detailWidth, faint), '',
        ...wrap('Design is the only score here that is not reproducible from the saved artifacts. Changing the reviewer starts a new experiment: older runs will not pool with it.', detailWidth, faint), '',
        ...wrap('A local server is any OpenAI-compatible endpoint on your own machine. Forseti only asks it which models it serves, sends no credential, and runs its trials through the same Pi adapter as every other API model, so they compare directly.', detailWidth, faint),
      ], inner, LIST_WIDTH).forEach(row);
      row();
      if (judge.enabled && /anthropic|claude/.test(judge.provider) && this.models().some(m => /anthropic|claude/.test(m.provider))) {
        prose('This reviewer is the same family as candidates you have enabled. Measure the gap with npm run test:judge -- --run <id> --alt <provider>/<model> before reading these scores.', amber);
        row();
      }
      prose('Validate a reviewer before trusting it: npm run test:judge reports how often it agrees with your recorded standard.', faint);
    } else {
      const run = this.app.runs[this.selection[RUNS]!];
      // The selected run sits under the list with its headline table, so a run is found by what
      // it showed rather than by its hash.
      const detail: string[] = [];
      if (run) {
        const { cards } = scorecards([run]);
        detail.push(...wrap(`${plain(run.created).slice(0, 16).replace('T', ' ')}   ${plain(run.status)} · ${run.trials.length} of ${run.planned} recorded · ${run.options.lane} lane · ${tries(run.options.repeat)} · cache ${run.options.cache ? 'on' : 'off'} · suite ${run.suiteHash.slice(0, 8)} · harness ${run.harnessHash.slice(0, 8)}`, inner, muted), '');
        const nameW = Math.max(8, Math.min(28, Math.max(...cards.map(c => width_(plain(c.label))))));
        detail.push(...table([['', LABEL.solved, 'graded'].map(muted), ...cards.map(c => [
          plain(c.label), rateInk(c.score)(bar(c.score, 12)) + ' ' + bold(pct(c.score).padStart(4)),
          faint(`${c.evaluated}/${c.planned}`) + (c.notRun ? rose(` ${c.notRun} not run`) : ''),
        ])], [nameW, 18, 18]));
        if (run.judge?.enabled) {
          const design = run.trials.flatMap(t => t.checks.filter(c => c.dimension === 'design'));
          if (design.length) detail.push(faint(`reviewer ${plain(run.judge.model)} · ${design.filter(c => !c.passed).length}/${design.length} design defects`));
          else detail.push(rose(`reviewer ${plain(run.judge.model)} scored nothing`) + faint(`: ${plain(run.trials.find(t => t.judgeNote)?.judgeNote ?? 'No design checks were produced.')}`));
        }
      } else detail.push(muted('No evidence yet. Press r to review a new run.'));
      row();
      head('Runs', `${this.selectedRuns.size} selected`);
      row();
      this.listRows(this.app.runs.map(r => `${dot(this.selectedRuns.has(r.id))} ${runLine(r)}`), lines.length, Math.max(4, this.bodyRows() - detail.length - 10)).forEach(row);
      if (this.app.runs.length) head('Selected run');
      detail.forEach(row);
    }
    const where: number[] = [];
    const body = cards(lines.splice(3), outer, boxed, where);
    lines.push(...body);
    // Clicks land on screen columns: two columns of margin, then a card's border and its space.
    const indent = boxed ? 4 : 2;
    this.hits = [
      ...this.headerHits(),
      ...this.pending.flatMap(h => (where[h.at - 3] === undefined ? [] : [{ region: 'body' as const, line: where[h.at - 3]!, x0: h.x0 + indent, x1: h.x1 + indent, act: h.act }])),
    ];
    const footerStart = lines.length;
    row();
    // Long provider errors remain terminal-safe; the line appears only when there is something to say.
    if (this.message) row(muted(truncateToWidth(plain(this.message), outer)));
    // The same two keys do the same thing at every level, so the hint names both every time.
    const leave = this.dialog ? (this.typing() ? `${accent('esc')} ${faint('back')}` : `${accent('esc · q')} ${faint('back')}`)
      : busy && this.tab === HOME ? `${accent('esc')} ${faint('cancel')}` : `${accent('?')} ${faint('keys')}   ${accent('esc · q')} ${faint('quit')}`;
    row(spreadAt(keyHints(this.keys(), Math.max(1, outer - width_(leave) - 3)), leave, outer));
    return { footerStart, lines: lines.map(line => {
      const content = truncateToWidth(line, outer);
      const padded = `  ${content}${' '.repeat(Math.max(0, outer - visibleWidth(content)))}  `;
      return `${BACKDROP}${truncateToWidth(padded, width, '')}\x1b[0m`;
    }) };
  }
  /** Each tab's pill in the header row, where `draw` puts it: margin, name, two spaces, then pills one space apart. */
  private headerHits(): typeof this.hits {
    let x = 2 + 'forseti'.length + 2;
    return tabs.map((t, i) => {
      const hit = { region: 'header' as const, line: 1, x0: x, x1: x + t.length + 2, act: () => { this.tab = i; } };
      x = hit.x1 + 1;
      return hit;
    });
  }
  /** What a test measures, then enough of the prompt to recognise it. The whole prompt is on disk. */
  private taskDetail(task: Task, width: number, wrap: (text: string, w: number, paint?: (s: string) => string) => string[]): string[] {
    const brief = wrap(task.prompt, width, faint);
    return [
      muted(plain(`${task.id}${task.tier ? ` · ${TIER_NAME[task.tier]}` : ''} · ${task.tags.join(' · ')}`)),
      ...wrap(`Tests: ${(task.capabilities ?? []).map(c => SKILL_NAME[c]).join(' · ') || 'nothing declared'}`, width, faint),
      ...wrap(`Graded on: ${task.dimensions.map(d => GRADED_ON[d]).join(' · ')}`, width, faint), '',
      ...brief.slice(0, 8), ...(brief.length > 8 ? [faint('…')] : []),
    ];
  }
  /** The rows of a list that fit, pushed from body line `at`; a click selects a row and a double click opens it. */
  private listRows(items: string[], at: number, visible = Math.max(6, this.bodyRows() - 8)): string[] {
    const selected = Math.min(this.selection[this.tab]!, Math.max(0, items.length - 1));
    this.selection[this.tab] = selected;
    const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), items.length - visible));
    const tab = this.tab;
    for (let k = 0; k < Math.min(visible, items.length - Math.max(0, start)); k++) {
      this.pending.push({ at: at + k, x0: 0, x1: LIST_WIDTH, act: clicks => { this.selection[tab] = Math.max(0, start) + k; if (clicks > 1) this.key('\r'); } });
    }
    // A single accent bar marks the cursor; the dot inside each row carries enabled/selected state.
    const rows = items.slice(Math.max(0, start), Math.max(0, start) + visible)
      .map((item, i) => (i + Math.max(0, start) === selected ? `${accent('▌')} ${item}` : `  ${item}`));
    return items.length > visible ? [...rows, faint(`  ${selected + 1} / ${items.length}   ↑↓`)] : rows;
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
    } else if (this.dialog === 'local') {
      head('Local server', 'address and port');
      row();
      prose('Base address of an OpenAI-compatible server: llama-server, Ollama (http://127.0.0.1:11434), LM Studio (http://127.0.0.1:1234) or similar. Leave it empty to remove.', muted);
      this.input.render(width).forEach(row);
      row();
      row(faint('⏎ save and list its models   esc keep current'));
    } else if (this.dialog === 'cancel') {
      const run = this.live, done = run?.trials.length ?? 0, total = run?.planned ?? 0;
      head('Cancel this run?');
      row();
      prose(total ? `${tries(done)} finished and ${done === 1 ? 'is' : 'are'} kept. The other ${total - done} will not run.` : 'Tries that finished are kept. The rest will not run.');
      prose('Starting the same run again later makes only the missing tries.', faint);
      row();
      row(amber('y') + faint(' cancel the run   ') + amber('n') + faint(' keep it running'));
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
        ['p', 'prompt caching on / off'], ['P', 'tries at once: 1, 2, 4, 8 (saved; local models one at a time)'], ['t · T', 'time limit · turn limit per trial'], ['5', 'settings: design reviewer, local server'], ['R', 'refresh metadata, sends nothing'],
        ['c · ⏎ · e', 'runs: compare, evidence, export'], ['L', 'leaderboard of every comparable try, from any tab'], ['m', 'comparison: summary / full report'], ['a', 'comparison: show / fold tasks every model solved'], ['←→', 'evidence: previous / next trial'],
        ['space · b', 'report: page down / up'], ['gg · G', 'report: jump to top / bottom'], ['esc · q', 'leave what you are looking at: close a panel, else quit'], ['esc during a run', 'asks, then cancels it, keeping completed evidence'], ['during a run', 'tabs and ↑↓ work; edits wait'], ['ctrl+c', 'quit'],
      ] as const) row(`${accent(keys)}${' '.repeat(Math.max(2, 14 - keys.length))}${muted(what)}`);
    } else {
      const summary = this.dialog === 'report' && this.reportMode === 'summary';
      const first = this.reportRuns[0], board = first?.id === 'leaderboard';
      head(this.dialog === 'evidence' ? 'Evidence' : board ? 'Leaderboard' : summary ? 'Model comparison' : 'Full report',
        this.dialog === 'evidence' ? 'observable checks' : board ? 'every comparable try, all runs' : summary ? count(this.reportRuns.length, 'run') : `${count(this.reportRuns.length, 'run')} · ${first?.tasks.length ?? 0} tests × ${tries(first?.options.repeat ?? 0)} · ${first?.options.lane ?? ''} lane`);
      row();
      let body: string[];
      let chrome = 5;
      if (summary) body = comparisonPage(this.reportRuns, width, this.everyTask);
      else {
        let content = this.report;
        if (this.dialog === 'evidence') {
          const run = this.detailRun!;
          const trial = run.trials[this.trialIndex];
          row(faint(`trial ${trial ? this.trialIndex + 1 : 0} / ${run.trials.length}   ←→`));
          chrome = 7;
          if (trial) {
            const state = outcome(trial.status);
            const chip = state.kind === 'pass' ? green('PASS') : state.kind === 'scored' ? amber('SCORED') : rose('NOT RUN');
            row();
            row(`${chip}  ${bold(plain(trial.model))}${muted(' / ')}${plain(trial.task)}${faint(`  try ${trial.repetition}`)}`);
            // "not run" never means a wrong answer: those trials are excluded from correctness. A
            // stall is the model running out of a budget sized for the task, so it is scored.
            row(faint(state.kind === 'not-run' ? `${state.text} — excluded from scores, not counted against the model` : STALL.includes(trial.status) ? state.text : `${trial.checks.filter(c => c.passed).length} of ${trial.checks.length} checks passed`));
            row();
            for (const dimension of ['correctness', 'instructions', 'tools', 'design', 'hygiene'] as const) {
              const checks = trial.checks.filter(c => c.dimension === dimension);
              if (!checks.length) continue;
              const rate = checks.filter(c => c.passed).length / checks.length;
              row(`${muted(dimension.padEnd(14))}${rateInk(rate)(bar(rate))} ${muted(`${checks.filter(c => c.passed).length}/${checks.length}`)}`);
              chrome++;
            }
            row();
            row(faint(`${(trial.wallMs / 1000).toFixed(1)}s wall · ${(trial.modelMs / 1000).toFixed(1)}s model · ${trial.tokens ? `${trial.tokens.input} in / ${trial.tokens.output} out` : 'tokens unavailable'} · ${plain(trial.auth.mode)}`));
            row();
            chrome += 7;
          }
          const failed = trial?.checks.filter(c => !c.passed) ?? [];
          const passed = trial?.checks.filter(c => c.passed) ?? [];
          content = trial ? [
            ...(trial.error ? [`Error: ${trial.error}`, ''] : []),
            ...(failed.length ? ['Why it did not pass', ...failed.map(c => `FAIL [${c.dimension}] ${c.id}\n${c.evidence}`), ''] : []),
            ...(passed.length ? [`Passed ${passed.length}: ${passed.map(c => c.id).join(' · ')}`, ''] : []),
            ...(trial.checks.length ? [] : ['No checks recorded. Not passing evidence.', '']),
            'Answer', trial.answer || '(empty)',
            ...(trial.trace.length ? ['', 'Tool trace', ...trial.trace.map(t => `${t.ok ? 'OK' : 'ERROR'} ${t.tool} · ${t.ms}ms\n${JSON.stringify(t.args)}\n${t.output}`)] : []),
          ].join('\n') : 'No trials recorded.';
        }
        body = wrapTextWithAnsi(terminalText(content), width);
      }
      // Fill the window: the panel's own chrome is the head, the blanks and the position line.
      const page = Math.max(6, this.bodyRows() - chrome);
      this.reportLength = body.length;
      this.reportPage = page;
      this.reportOffset = Math.min(this.reportOffset, Math.max(0, body.length - page));
      body.slice(this.reportOffset, this.reportOffset + page).forEach(row);
      if (body.length > page) { row(); row(faint(`${this.reportOffset + 1}–${Math.min(body.length, this.reportOffset + page)} of ${body.length}`)); }
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
    const dashboard = new Dashboard(app, () => tui.requestRender(), () => { tui.stop(); resolve(); }, () => terminal.rows, () => body.scrollToStart());
    const pane = (region: 'header' | 'body' | 'footer'): Component => ({
      render: width => dashboard.render(width, region), invalidate: () => dashboard.invalidate(),
      handleMouse: region === 'header' ? event => (event.type === 'click' && dashboard.click('header', event.y, event.x, event.clickCount) ? { handled: true } : undefined) : undefined,
    });
    // The body scrolls, so a click is found by its line in the whole page, not in the window.
    class Body extends ScrollView {
      handleMouse(event: TuiMouseEvent) {
        if (event.type !== 'click' || !dashboard.click('body', event.y + this.scrollTop, event.x, event.clickCount)) return undefined;
        return { handled: true as const, target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height } };
      }
    }
    const body = new Body(pane('body'), { primary: true, follow: 'none', scrollbarThumbStyle: accent });
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
