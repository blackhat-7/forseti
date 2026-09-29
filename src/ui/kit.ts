import { stripVTControlCharacters } from 'node:util';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { AuthInfo, ModelConfig, Task } from '../types.ts';

/** Shared look and small layout helpers for every screen. */
// Strip whole terminal strings first, then remaining controls (including bidi).
export function terminalText(value: unknown): string {
  return stripVTControlCharacters(String(value)
    .replace(/(?:\x1b[P_^X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, ''))
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, '');
}
export const plain = (value: unknown) => terminalText(value).replace(/\n/g, ' ');
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
export const ink = (r: number, g: number, b: number) => (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
const BASE_BG = '\x1b[48;2;24;22;22m'; // dragonBlack3
export const BACKDROP = `${BASE_BG}\x1b[38;2;197;201;197m`; // dragonBlack3 on dragonWhite
// A selected row's band, one step lighter than the backdrop; UNBAND returns to it so the band
// never bleeds past the row it marks.
export const BAND = '\x1b[48;2;40;39;39m';
export const UNBAND = BASE_BG;
export const accent = ink(139, 164, 176); // dragonBlue2
export const teal = ink(142, 164, 162); // dragonAqua
export const green = ink(135, 169, 135); // dragonGreen2
export const amber = ink(196, 178, 138); // dragonYellow
export const rose = ink(196, 116, 110); // dragonRed
export const muted = ink(166, 166, 156); // dragonGray
export const faint = ink(115, 124, 115); // dragonAsh
// One colour per model on the comparison chart, so a model reads as the same bar in every group.
export const SERIES = [accent, ink(137, 146, 167) /* dragonViolet */, green, ink(182, 146, 123) /* dragonOrange */, teal, rose];
export const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const theme = { selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: faint, noMatch: amber };
export const tabs = ['Home', 'Live', 'Models', 'Tests', 'Runs', 'Settings'];
/** Plain names for what a test is graded on; the dimension ids are rubric vocabulary. */
export const GRADED_ON: Record<Task['dimensions'][number], string> = { correctness: 'correct answer', instructions: 'output format', tools: 'tool use', design: 'code design', hygiene: 'safe-code gate' };
export const THINKING: ModelConfig['thinking'][] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const JUDGE_FIELDS = ['Reviewer', 'Model', 'Thinking', 'Rounds'];
/** Settings rows: the reviewer fields, then the local server address. */
export const LOCAL_ROW = JUDGE_FIELDS.length;
/** Per-trial time limit. A ladder rather than free entry: these are the values worth choosing. */
export const TIMEOUTS = [30, 60, 90, 120, 180, 300, 600];
/** Tool-call turns per trial. Too low censors outcomes; too high spends plan quota on stragglers. */
export const TURNS = [6, 12, 20, 30, 50];
/** Tries a run makes at once. Saved to your config; local-server models still go one at a time. */
export const PARALLEL = [1, 2, 4, 8];
export const dot = (on: boolean) => (on ? green('●') : faint('○'));
/** "2026-09-20T14-31-08-443Z-6d55ccee" reads as "09-20 14:31"; anything else is shown as it is. */
export const runWhen = (id: string) => (/^\d{4}-\d{2}-\d{2}T/.test(id) ? `${id.slice(5, 10)} ${id.slice(11, 13)}:${id.slice(14, 16)}` : id);
/** "Claude sonnet · via Claude Code / 14-31-08" is provenance; a column needs "Claude sonnet". */
export const nick = (label: string) => plain(label).split(' / ')[0]!.split(' · ')[0]!.trim();
/** "under a minute", "46 min", "1 h 20 min": an estimate, so no false precision. */
export function remaining(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
/** Marks a line as the start of a card: its title and right-hand note follow. Never printed. */
export const CARD = '\u0000card\u0000';
export const pill = (s: string) => `\x1b[48;2;139;164;176m\x1b[38;2;24;22;22m\x1b[1m${s}\x1b[22m\x1b[39m\x1b[49m`;
/** A filled background chip: a state (PASS, SCORED, NOT RUN) or a dialog's y/n choice, never a tab. */
const bg = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;
export const CHIP_GREEN = bg(135, 169, 135), CHIP_AMBER = bg(196, 178, 138), CHIP_ROSE = bg(196, 116, 110), CHIP_MUTED = bg(56, 54, 54);
export const chip = (color: string, s: string) => `${color}\x1b[38;2;24;22;22m\x1b[1m ${s} \x1b[22m\x1b[39m${UNBAND}`;
/** A full-width faint rule: the header's third row and the footer's first, so both frame the same way. */
export const hairline = (width: number) => faint('─'.repeat(Math.max(0, width)));
/** A status line reads as a toast: green settled, amber in progress or asking, rose gone wrong. */
export function toast(text: string): string {
  if (/^error:|failed|no answer from|run stopped:|^local server: /i.test(text)) return rose(text);
  if (/cancel|interrupted|already ended|refreshing|listing|starting run|press esc|not started|no prompt is sent/i.test(text)) return amber(text);
  return green(text);
}
/**
 * Draws a rounded card around each section a heading opened, trimming blank lines at its edges
 * and leaving one blank line between cards. Lines outside any card pass through unchanged.
 */
/**
 * `where[i]` receives the output line that input line `i` landed on, or stays unset when the line
 * was trimmed, so something registered against an input line can be found again on screen.
 */
export function cards(lines: string[], outer: number, boxed = true, where: number[] = []): string[] {
  const out: string[] = [];
  let open: { title: string; right: string; body: [string, number][] } | undefined;
  const edge = (s: string) => faint(s);
  const flush = () => {
    if (!open) return;
    const body = open.body.slice(open.body.findIndex(([l]) => width_(l) > 0));
    while (body.length && !width_(body.at(-1)![0])) body.pop();
    if (!open.body.some(([l]) => width_(l) > 0)) body.length = 0;
    while (out.length && !width_(out.at(-1)!)) out.pop();
    if (out.length) out.push('');
    if (!boxed) {
      out.push(truncateToWidth(bold(accent(open.title)) + (open.right ? faint(`  ${open.right}`) : ''), outer));
      for (const [line, i] of body) { where[i] = out.length; out.push(line); }
      open = undefined;
      return;
    }
    let title = truncateToWidth(open.title, Math.max(1, outer - 8)), right = open.right;
    if (width_(title) + width_(right) + 9 > outer) right = '';
    const fill = Math.max(1, outer - 5 - width_(title) - (right ? width_(right) + 2 : 0) - 1);
    out.push(edge('╭─ ') + bold(accent(title)) + edge(` ${'─'.repeat(fill)}`) + (right ? ` ${muted(right)} ` : '') + edge('╮'));
    for (const [line, i] of body) { const t = truncateToWidth(line, outer - 4); where[i] = out.length; out.push(`${edge('│')} ${t}${' '.repeat(Math.max(0, outer - 4 - width_(t)))} ${edge('│')}`); }
    out.push(edge(`╰${'─'.repeat(Math.max(0, outer - 2))}╯`));
    open = undefined;
  };
  for (const [i, line] of lines.entries()) {
    if (line.startsWith(CARD)) { flush(); const [title = '', right = ''] = line.slice(CARD.length).split('\u0000'); open = { title, right, body: [] }; }
    else if (open) open.body.push([line, i]);
    else { where[i] = out.length; out.push(line); }
  }
  flush();
  return out;
}
/** "r run   P at once" → each key in the accent, its meaning faint, so the eye finds keys first. */
export function keyHints(text: string, width: number): string {
  const items = text.split(/ {3,}/).filter(Boolean).map(item => { const [key = '', ...rest] = item.split(/ (?=[a-z(])/); return rest.length ? `${accent(key)} ${faint(rest.join(' '))}` : faint(key); });
  let out = '';
  for (const item of items) { const next = out ? `${out}   ${item}` : item; if (width_(next) > width) break; out = next; }
  return out;
}
/** Truncates or pads to a column, so feed rows line up at any width. */
export function padTo(text: string, w: number): string {
  const t = truncateToWidth(text, Math.max(1, w - 1));
  return t + ' '.repeat(Math.max(0, w - width_(t)));
}
/** "45s", "4.2m", "1h 20m": short enough for a feed column, exact enough to plan around. */
export function duration(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${Math.max(1, Math.round(s))}s` : s < 3600 ? `${(s / 60).toFixed(1)}m` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}
export function statusInk(status: string): (s: string) => string {
  if (['passed', 'completed'].includes(status)) return green;
  if (['failed', 'cancelled', 'interrupted'].includes(status)) return amber;
  if (status === 'running') return accent;
  return muted;
}
export function billingInk(billing: AuthInfo['billing']): string {
  if (billing === 'subscription') return teal('subscription');
  if (billing === 'control') return faint('synthetic control');
  if (billing === 'local') return teal('no charge');
  return amber(billing);
}
/** Controls already say "synthetic control" in their mode; never print it twice. */
export function authLine(auth: AuthInfo): string {
  const pill = auth.ready ? green('READY') : rose('NOT READY');
  return auth.billing === 'control' ? `${pill}   ${faint(plain(auth.mode))}` : `${pill}   ${muted(plain(auth.mode))}   ${billingInk(auth.billing)}`;
}
/** Fixed label/value/hint columns so settings read as a table instead of ad-hoc spacing. */
export function field(label: string, value: string, hint: string): string {
  const pad = (n: number) => ' '.repeat(Math.max(2, n));
  return `${muted(label)}${pad(14 - label.length)}${value}${pad(14 - width_(value))}${faint(hint)}`;
}
/**
 * States in one line which credential every call will use. An API key is never implied: if one
 * would be used it is named here, before anything runs, and it still has to clear the billing
 * prompt afterwards.
 */
export function creditLine(entries: { label: string; auth: AuthInfo }[]): string {
  const live = entries.filter(e => e.auth.billing !== 'control');
  if (!live.length) return faint('Synthetic controls only. No model is called and no credential is used.');
  const keyed = live.filter(e => ['metered', 'unknown'].includes(e.auth.billing));
  if (!keyed.length) {
    const local = live.filter(e => e.auth.billing === 'local').length;
    const who = local === live.length ? 'Your own local server only' : local ? 'Subscription logins and your own local server' : 'Subscription logins only';
    return teal(`${who} (${count(live.length, 'call site')}). No API key will be used.`);
  }
  return amber(`${count(keyed.length, 'call site')} would use a metered API key: ${keyed.map(e => e.label).join(', ')}`);
}
export const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const tries = (n: number) => `${n} ${n === 1 ? 'try' : 'tries'}`;
export const width_ = (s: string) => visibleWidth(stripVTControlCharacters(s));
export const pct = (rate: number | null) => (rate === null ? 'n/a' : `${Math.round(rate * 100)}%`);
export const rateInk = (rate: number | null) => (rate === null ? faint : rate === 1 ? green : rate >= 0.5 ? amber : rose);
/** Long prose stays readable on ultrawide terminals instead of running the full width. */
export const MAX_TEXT = 94;
export const LIST_WIDTH = 44;
/** Side-by-side panes on wide terminals; stacked when there is not room for both. */
export function twoColumn(left: string[], right: string[], inner: number, leftWidth: number): string[] {
  if (!right.length) return left;
  if (inner < leftWidth + 32) return [...left, '', ...right];
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => {
    // A faint rule between the list and its details keeps two columns from reading as one.
    const cell = truncateToWidth(left[i] ?? '', leftWidth - 3);
    return `${cell}${' '.repeat(Math.max(1, leftWidth - 2 - width_(cell)))}${faint('│')} ${right[i] ?? ''}`;
  });
}
/**
 * Every table in the UI: a left-aligned name column, then right-aligned figures. Numbers in one
 * column line up under their heading, which is what makes three models readable at a glance.
 */
export function table(rows: string[][], widths: number[]): string[] {
  return rows.map(cells => cells.map((cell, i) => {
    const text = truncateToWidth(cell, widths[i]!);
    const pad = ' '.repeat(Math.max(0, widths[i]! - width_(text)));
    return i === 0 ? text + pad : pad + text;
  }).join('  ').trimEnd());
}
