import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { FINISHED, STALL } from '../report.ts';
import type { Run, Trial } from '../types.ts';
import { BACKDROP, CARD, accent, amber, bold, cards, duration, faint, green, muted, nick, padTo, plain, remaining, rose, terminalText, tierTag, width_ } from './kit.ts';
import { runLine } from './board.ts';
import type { Block, LiveWatch, Open, Transcript } from './live.ts';

/** The narrowest a stream pane gets before the grid drops a column: below it, prose wraps every few words. */
const PANE = 44;
const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
const cut = (s: string, w: number) => truncateToWidth(s, w, '…');
/** dragonBlack5 behind the unfilled part of a bar, so a partial cell reads as part of one smooth bar. */
const TRACK = '\x1b[48;2;57;56;54m';

/** Solved means every correctness check passed, the same rule the leaderboard scores by. */
const solved = (t: Trial) => t.checks.some(c => c.dimension === 'correctness') && t.checks.filter(c => c.dimension === 'correctness').every(c => c.passed);
/** "45s", "1m 12s", "1h 3m": a try's age, precise enough to see it move every second. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}
/** Eighth-block characters give the bar sub-cell precision, so a long run still visibly moves. */
export function progressBar(share: number, w: number): string {
  const cells = Math.max(0, Math.min(1, share)) * w, full = Math.floor(cells), eighth = Math.round((cells - full) * 8);
  const part = eighth ? '▏▎▍▌▋▊▉█'[eighth - 1]! : '';
  return accent('█'.repeat(full)) + TRACK + accent(part) + ' '.repeat(Math.max(0, w - full - (part ? 1 : 0))) + BACKDROP;
}
/**
 * Time left, from each model's own pace. Local tries run one at a time, so their queue is the sum of
 * what is left; the rest share the other slots. One pace for all would let a fast cloud model's
 * finished tries promise minutes while a local model still has hours to go.
 */
function timeLeft(run: Run, now: number): number | null {
  const done = run.trials.length;
  if (!done || run.planned <= done) return null;
  if (!run.plan) return (now - Date.parse(run.created)) / done * (run.planned - done);
  const pace = run.trials.reduce((sum, t) => sum + t.wallMs, 0) / done;
  let local = 0, shared = 0;
  for (const m of run.models) {
    const mine = run.trials.filter(t => t.model === m.id), left = Math.max(0, (run.plan[m.id] ?? 0) - mine.length);
    const each = mine.length ? mine.reduce((sum, t) => sum + t.wallMs, 0) / mine.length : pace;
    if (m.provider === 'local') local += left * each; else shared += left * each;
  }
  const slots = Math.max(1, (run.options.parallel ?? 1) - (run.models.some(m => m.provider === 'local') ? 1 : 0));
  return Math.max(local, shared / slots);
}
/** "12 of 28 tries · 43% · about 1 h 20 min left". */
function progress(run: Run | undefined, now: number): { share: number; note: string } {
  const done = run?.trials.length ?? 0, total = run?.planned ?? 0, share = total ? done / total : 0;
  const ms = run ? timeLeft(run, now) : null;
  return { share, note: `${done} of ${total || '?'} tries · ${Math.round(share * 100)}%${ms === null ? '' : ` · about ${remaining(ms)} left`}` };
}
/** A limit as people say it: "15m", "30m", "90s". */
const limit = (secs: number) => (secs % 60 ? `${secs}s` : `${secs / 60}m`);
/** Where a try in progress stands against its own budget: turns used and time spent, each of its limit. */
function budget(o: Open, run: Run | undefined, now: number): string {
  const turns = Math.max(run?.options.maxTurns ?? 0, o.task.turns ?? 0), secs = Math.max(run?.options.timeout ?? 0, o.task.timeout ?? 0);
  return `turn ${o.tail.transcript.turns}${turns ? `/${turns}` : ''} · ${clock(now - o.since)}${secs ? ` of ${limit(secs)}` : ''}`;
}
function mark(trial: Trial): string {
  return !FINISHED.includes(trial.status) ? faint('·') : STALL.includes(trial.status) ? amber('◷') : solved(trial) ? green('✓') : rose('✗');
}
/**
 * One aligned line per model: tries finished, then solved, wrong and ran out, with zeros faint so
 * the eye lands on what happened. One line each, so a long model name never pushes a count off.
 */
function tallies(run: Run): string[] {
  const n = (paint: (s: string) => string, sign: string, k: number) => padTo(k ? paint(`${sign} ${k}`) : faint(`${sign} 0`), 7);
  const nameW = Math.min(30, Math.max(...run.models.map(m => width_(nick(m.label)))) + 3);
  return run.models.map(m => {
    const mine = run.trials.filter(t => t.model === m.id && FINISHED.includes(t.status));
    const won = mine.filter(solved).length, out = mine.filter(t => STALL.includes(t.status)).length;
    const rate = mine.length ? faint(`${Math.round((won / mine.length) * 100)}% solved`) : '';
    return `${bold(padTo(nick(m.label), nameW))}${padTo(faint(run.plan ? `${mine.length} of ${run.plan[m.id] ?? 0}` : `${mine.length} done`), 10)}${n(green, '✓', won)}${n(rose, '✗', mine.length - won - out)}${n(amber, '◷', out)} ${rate}`;
  });
}

// Wrapped lines of a text block, per block, extended as the text grows: text up to its last line
// break never wraps differently, so only what came after it is wrapped again on each frame.
const wraps = new WeakMap<Block, { w: number; upto: number; lines: string[] }>();
const wrapPlain = (text: string, w: number) => wrapTextWithAnsi(terminalText(text.replaceAll('\t', '  ')), Math.max(4, w));
function textLines(b: Block & { text: string }, w: number, need = Infinity): string[] {
  let c = wraps.get(b);
  if (!c || c.w !== w) wraps.set(b, c = { w, upto: 0, lines: [] });
  const nl = b.text.lastIndexOf('\n');
  if (nl + 1 > c.upto) {
    for (const line of wrapPlain(b.text.slice(c.upto, nl), w)) if (c.lines.length || line.trim()) c.lines.push(line);
    c.upto = nl + 1;
  }
  // Only the tail of an unbroken paragraph can show in a pane, so only the tail is wrapped.
  let rest = b.text.slice(c.upto);
  const cut = rest.length > (need + 1) * w;
  if (cut) rest = rest.slice(-(need + 1) * w);
  // A tail cut mid-paragraph starts mid-line, so its first wrapped line is dropped.
  const lines = [...c.lines.slice(-need), ...(rest.trim() ? wrapPlain(rest, w).slice(cut ? 1 : 0) : [])];
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.slice(-need);
}

/** The file, command or pattern a call is about, read from its arguments even while they stream. */
const TARGET = /"(?:file_path|path|notebook_path|pattern|command|url|query)"\s*:\s*"((?:[^"\\]|\\.)*)/;
const BODY = /"(?:content|new_string|source|code|text)"\s*:\s*"/;
const CODE = /"(?:content|new_string|source|code|text)"\s*:\s*"((?:[^"\\]|\\.)*)/;
const unescape = (s: string) => s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ n: '\n', t: '  ', r: '', b: '', f: '' } as Record<string, string>)[c] ?? c));
function target(args: string): string {
  const head = args.slice(0, 2000), found = TARGET.exec(head) ?? CODE.exec(head), value = found ? unescape(found[1]!) : '';
  const text = plain(value.trim().split('\n')[0]!);
  return /^[\w./-]+$/.test(text) && text.includes('/') ? text.split('/').at(-1)! : text;
}
/** The last lines of a file or program as the model writes it: the most alive thing on screen. */
function writing(args: string): string[] {
  const m = BODY.exec(args.slice(0, 4000));
  if (!m) return [];
  const body = args.slice(Math.max(m.index + m[0].length, args.length - 1500)).split(/(?<!\\)"/)[0]!;
  return unescape(body).split('\n').filter(l => l.trim()).slice(-3).map(l => terminalText(l));
}
function toolLines(b: Block & { kind: 'tool' }, w: number, streaming: boolean): string[] {
  const head = `${accent('▸')} ${accent(plain(b.name) || 'tool')}`;
  const error = b.result && !b.result.ok ? plain(b.result.text.split('\n').find(l => l.trim()) ?? '').trim() : '';
  const end = !b.result ? '' : b.result.ok ? ` ${green('✓')}` : ` ${rose(cut(`✗ ${error}`, Math.max(3, Math.floor(w / 2))))}`;
  const room = w - width_(head) - width_(end) - 2, what = target(b.args);
  const line = `${head}${what && room > 3 ? `  ${muted(cut(what, room))}` : ''}${end}`;
  return [line, ...(streaming ? writing(b.args).map(l => faint(cut(`  ${l}`, w))) : [])];
}
function blockLines(b: Block, w: number, streaming: boolean, need: number): string[] {
  if (b.kind === 'tool' && b.result) streaming = false;
  const lines = b.kind === 'tool' ? toolLines(b, w, streaming)
    : b.kind === 'think' ? textLines(b, w - 2, need).map(l => `${faint('┊')} ${italic(faint(l))}`)
    : textLines(b, w, need);
  if (streaming && lines.length) {
    const last = lines.at(-1)!;
    if (width_(last) < w) lines[lines.length - 1] = last + accent('▍'); else lines.push(accent('▍'));
  }
  return lines;
}
/**
 * A conversation as lines, newest last. With `need`, only as many blocks as can show are laid out,
 * newest first, so a long transcript costs what the pane shows rather than what it holds.
 */
export function conversation(t: Transcript, w: number, live: boolean, need = Infinity): string[] {
  const parts: string[][] = [];
  let n = 0;
  for (let i = t.blocks.length - 1; i >= 0 && n < need; i--) {
    const b = t.blocks[i]!, prev = t.blocks[i - 1];
    const lines = blockLines(b, w, live && i === t.blocks.length - 1, need - n);
    // Words and tool calls read as separate paragraphs; consecutive calls stay one list.
    if (lines.length && prev && prev.kind !== b.kind && b.kind !== 'tool') lines.unshift('');
    parts.push(lines);
    n += lines.length;
  }
  const lines = parts.reverse().flat().slice(-need);
  while (lines.length && !lines[0]) lines.shift();
  return lines;
}

/** A rounded box `w` wide and `h` tall with the title in its top border; the focused one is in the accent. */
function box(title: string, right: string, body: string[], w: number, h: number, focused: boolean, bottom = '', tag = ''): string[] {
  const edge = focused ? accent : faint;
  // The try's age is what shows it is alive, so the title gives way to it.
  if (width_(right) + 16 > w) right = '';
  const lead = tag ? `${tag} ` : '';
  const t = cut(title, Math.max(1, w - 8 - width_(lead) - (right ? width_(right) + 2 : 0)));
  const fill = Math.max(0, w - 6 - width_(lead) - width_(t) - (right ? width_(right) + 2 : 0));
  const out = [edge('╭─ ') + lead + (focused ? bold(accent(t)) : bold(t)) + ' ' + edge('─'.repeat(fill)) + (right ? ` ${muted(right)} ` : '') + edge('─╮')];
  for (let i = 0; i < h - 2; i++) {
    const line = cut(body[i] ?? '', w - 4);
    out.push(`${edge('│')} ${line}${' '.repeat(Math.max(0, w - 4 - width_(line)))} ${edge('│')}`);
  }
  const note = bottom && width_(bottom) + 6 <= w ? ` ${faint(bottom)} ` : '';
  out.push(edge(`╰${'─'.repeat(Math.max(0, w - 3 - width_(note)))}`) + note + edge('─╯'));
  return out;
}

export type Hit = { line: number; x0: number; x1: number; act: (clicks: number) => void };
export type LiveFrame = { watch: LiveWatch; width: number; boxed: boolean; rows: number; busy: boolean; stopping: boolean; last?: Run; now: number };

/** The Live tab: one stream pane per try in progress, one of them focused, any of them zoomed. */
export class LiveView {
  /** The focused try, by trial id, so focus stays on it while others start and finish around it. */
  private focus = '';
  /** Held by reference, so a zoomed try stays readable after it finishes and leaves the grid. */
  zoomed?: Open;
  /** First line shown while scrolled back in a zoomed try; unset follows the newest line. */
  private top?: number;
  private total = 0;
  private page = 10;

  /** Keys the Live tab owns, given the tries in progress. False leaves the key to the rest of the screen. */
  key(data: string, open: Open[]): boolean {
    const key = (name: Parameters<typeof matchesKey>[1]) => matchesKey(data, name);
    if (this.zoomed) {
      const start = this.top ?? Math.max(0, this.total - this.page);
      const step = key('up') || data === 'k' ? -1 : key('down') || data === 'j' ? 1 : data === 'b' ? -this.page : data === ' ' ? this.page : 0;
      if (step) this.top = Math.max(0, start + step);
      else if (data === 'g') this.top = 0;
      else if (data === 'G') this.top = undefined;
      else return false;
      if (this.top !== undefined && this.top >= this.total - this.page) this.top = undefined;
      return true;
    }
    if (data === '[' || data === ']') {
      const i = Math.max(0, open.findIndex(o => o.id === this.focus));
      this.focus = open[(i + (data === '[' ? open.length - 1 : 1)) % Math.max(1, open.length)]?.id ?? '';
      return true;
    }
    if (key('enter')) { this.zoomed = open.find(o => o.id === this.focus) ?? open[0]; this.top = undefined; return true; }
    return false;
  }
  /** Esc and q leave a zoomed try before they reach the run. */
  leave(): boolean {
    if (!this.zoomed) return false;
    this.zoomed = undefined;
    return true;
  }
  hints(open: Open[]): string {
    return this.zoomed ? 'j k ↑↓ scroll   space b page   G newest' : open.length > 1 ? '[ ] focus   ⏎ zoom' : open.length ? '⏎ zoom' : '';
  }

  render(f: LiveFrame): { lines: string[]; hits: Hit[] } {
    const { watch, width, boxed, rows, now } = f, run = watch.run, open = watch.open;
    if (!open.some(o => o.id === this.focus)) this.focus = open[0]?.id ?? '';
    if (this.zoomed) return { lines: this.zoom(f), hits: [] };
    const out: string[] = [], hits: Hit[] = [];
    if (!f.busy && !run) {
      out.push(...cards([`${CARD}Live\u0000`, muted('No run in progress.'), '', ...(f.last ? [faint('Last run'), runLine(f.last), ''] : []), `${accent('r')} ${faint('starts one')}`], width, boxed));
      return { lines: out, hits };
    }
    const inner = boxed ? width - 4 : width, { share, note } = progress(run, now);
    const status = run?.trials.length ? tallies(run) : [open.length ? faint('No try has finished yet.') : muted('Preparing isolated trial workspaces…')];
    const parallel = run?.options.parallel ?? 1;
    out.push(...cards([`${CARD}${f.stopping ? 'Stopping safely' : 'Running'}\u0000${note} · ${parallel} at once`,
      progressBar(share, Math.max(8, inner)), ...status.map(line => cut(line, inner))], width, boxed));
    out.push('');

    // The feed takes the bottom only when every pane keeps room to be worth watching.
    const finished = (run?.trials ?? []).slice(-5).reverse();
    const n = open.length, cols = boxed ? Math.max(1, Math.min(n, Math.floor((width + 1) / (PANE + 1)))) : 1, grid = Math.ceil(n / cols);
    const feedH = finished.length ? finished.length + (boxed ? 3 : 2) : 0;
    let avail = rows - out.length;
    const gap = boxed ? 0 : 1;
    const fits = (room: number) => Math.floor((room - gap * (grid - 1)) / Math.max(1, grid));
    const withFeed = !n || fits(avail - feedH) >= 8;
    if (withFeed) avail -= feedH;
    const h = fits(avail);
    if (n && h < (boxed ? 4 : 3)) {
      // Too short for panes: one line per try, still with what it is doing right now.
      const nameW = Math.min(28, Math.max(...open.map(o => width_(nick(o.model.label)))) + 2), taskW = Math.min(34, Math.floor(width / 4));
      for (const o of open) {
        const on = o.id === this.focus, right = faint(` ${budget(o, run, now)}`);
        const left = `${on ? accent('▌') : ' '} ${bold(padTo(nick(o.model.label), nameW))}${padTo(tierTag(o.task.tier), 10)}${muted(padTo(plain(o.task.title), taskW))}`;
        const room = width - width_(left) - width_(right);
        const doing = room > 8 ? cut(conversation(o.tail.transcript, room - 1, true, 1)[0] ?? '', room - 1) : '';
        hits.push({ line: out.length, x0: 0, x1: width, act: clicks => this.pick(o, clicks) });
        out.push(`${cut(left, width - width_(right))}${doing}${' '.repeat(Math.max(0, room - width_(doing)))}${right}`);
        if (out.length >= rows) break;
      }
    } else {
      for (let r = 0; r < grid; r++) {
        // Panes share the width exactly, the first ones one column wider, so the grid lines up with the cards.
        const row = open.slice(r * cols, r * cols + cols), room = width - (row.length - 1);
        const ws = row.map((_, k) => Math.floor(room / row.length) + (k < room % row.length ? 1 : 0));
        const xs = ws.map((_, k) => ws.slice(0, k).reduce((a, b) => a + b + 1, 0));
        const panes = row.map((o, k) => this.pane(o, ws[k]!, h, boxed, now, run));
        if (r && gap) out.push('');
        for (let i = 0; i < h; i++) {
          row.forEach((o, k) => hits.push({ line: out.length, x0: xs[k]!, x1: xs[k]! + ws[k]!, act: clicks => this.pick(o, clicks) }));
          out.push(panes.map((p, k) => p[i] ?? ' '.repeat(ws[k]!)).join(' '));
        }
      }
    }
    if (withFeed && finished.length) {
      const names = finished.map(t => nick(run!.models.find(m => m.id === t.model)?.label ?? t.model)), nameW = Math.min(28, Math.max(...names.map(width_)) + 2);
      out.push('', ...cards([`${CARD}Finished\u0000newest first`, ...finished.map((t, i) => {
        const correct = t.checks.filter(c => c.dimension === 'correctness');
        const what = !FINISHED.includes(t.status) ? 'not run' : t.status === 'timeout' ? 'out of time' : t.status === 'budget' ? 'out of turns' : solved(t) ? 'solved' : `${correct.filter(c => c.passed).length}/${correct.length} checks`;
        const made = t.tokens?.output ?? 0, tokens = t.tokens ? `${made < 1000 ? '<1k' : `${Math.round(made / 1000)}k`} tokens` : '';
        const tail = `${padTo(what, 14)}${duration(t.wallMs).padStart(6)}${tokens.padStart(12)}`;
        const task = run!.tasks.find(x => x.id === t.task);
        return `${mark(t)} ${bold(padTo(names[i]!, nameW))}${padTo(tierTag(task?.tier), 10)}${padTo(plain(task?.title ?? t.task), Math.max(8, inner - 12 - nameW - width_(tail)))}${faint(tail)}`;
      })], width, boxed));
    }
    return { lines: out, hits };
  }
  private pick(o: Open, clicks: number): void {
    this.focus = o.id;
    if (clicks > 1) { this.zoomed = o; this.top = undefined; }
  }
  private title(o: Open): string { return `${nick(o.model.label)} · ${plain(o.task.title)}`; }
  private state(o: Open, now: number, run?: Run): string {
    const done = run?.trials.find(t => t.id === o.id);
    return done ? `${mark(done)} finished` : budget(o, run, now);
  }
  private pane(o: Open, w: number, h: number, boxed: boolean, now: number, run?: Run): string[] {
    const on = o.id === this.focus, cw = boxed ? w - 4 : w, height = boxed ? h - 2 : h - 1;
    const body = conversation(o.tail.transcript, cw, true, height);
    if (!body.length) body.push(faint('Waiting for the first words…'));
    if (boxed) return box(this.title(o), this.state(o, now, run), body, w, h, on, '', tierTag(o.task.tier));
    const right = faint(this.state(o, now, run)), left = cut(`${on ? accent('▌ ') : ''}${tierTag(o.task.tier)} ${bold(this.title(o))}`, Math.max(1, w - width_(right) - 2));
    return [`${left}${' '.repeat(Math.max(2, w - width_(left) - width_(right)))}${right}`, ...body];
  }
  private zoom(f: LiveFrame): string[] {
    const o = this.zoomed!, live = f.watch.open.includes(o);
    const w = f.boxed ? f.width - 4 : f.width, h = Math.max(3, f.rows - (f.boxed ? 2 : 1));
    const all = conversation(o.tail.transcript, w, live);
    this.total = all.length; this.page = h;
    if (this.top !== undefined && this.top >= all.length - h) this.top = undefined;
    const start = this.top ?? Math.max(0, all.length - h), body = all.slice(start, start + h);
    const where = this.top === undefined ? '' : `${start + 1}–${start + body.length} of ${all.length} · G newest`;
    if (f.boxed) return box(this.title(o), this.state(o, f.now, f.watch.run), body, f.width, h + 2, true, where, tierTag(o.task.tier));
    return [`${bold(this.title(o))}  ${faint(this.state(o, f.now, f.watch.run))}`, ...body];
  }
}

/** Home during a run: how far it is and what each try is doing, in a few lines. */
export function homeCard(watch: LiveWatch, inner: number, stopping: boolean, now: number): string[] {
  const { share, note } = progress(watch.run, now);
  const nameW = Math.min(28, Math.max(0, ...watch.open.map(o => width_(nick(o.model.label)))) + 2);
  return [
    `${CARD}${stopping ? 'Stopping safely' : 'Running'}\u0000${note}`,
    progressBar(share, Math.max(8, inner)),
    ...watch.open.map(o => {
      const right = budget(o, watch.run, now);
      return `${bold(padTo(nick(o.model.label), nameW))}${padTo(tierTag(o.task.tier), 10)}${padTo(plain(o.task.title), Math.max(8, inner - nameW - 10 - width_(right) - 2))}  ${faint(right)}`;
    }),
    `${accent('2')} ${faint('live view')}`,
  ];
}
