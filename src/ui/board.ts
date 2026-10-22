import { Text, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { LABEL, SKILL_NAME, TIER_NAME, bar, duration, tokenCount, byCapability, byTier, gate, harnesses, levelsNote, ranking, scoreError, scorecards, skillSlices, stallNote, taskCell, taskOrder, tierSlices, triesLabel, verdicts, noLeader, NO_LEADER, weighting } from '../report.ts';
import type { Run } from '../types.ts';
import { CARD, MAX_TEXT, SERIES, amber, bold, count, faint, green, ink, muted, nick, padTo, pct, plain, rateInk, rose, runWhen, statusInk, table, terminalText, width_ } from './kit.ts';

/**
 * The comparison page. One page that answers, top to bottom: who is best, which gaps are real, and
 * where each model is strong or weak. Every table has the models as columns in rank order, so a
 * model is read down one column and a task or skill across one row.
 */
export function comparisonPage(runs: Run[], width: number, everyTask: boolean, chartOnly = false): string[] {
  const { cards: all, tasks, mixed } = scorecards(runs);
  const ranked = ranking(all), cards = ranked.map(r => r.card);
  const tagged = harnesses(cards).length > 1;
  const names = cards.map(c => plain(c.label));
  const out: string[] = [];
  const row = (text = '') => out.push(text);
  const prose = (text: string, paint: (s: string) => string = s => s) =>
    out.push(...new Text(terminalText(text), 0, 0).render(Math.max(12, Math.min(width, MAX_TEXT))).map(paint));
  const pad = (text: string, w: number) => { const t = truncateToWidth(text, Math.max(1, w - 1)); return t + ' '.repeat(Math.max(0, w - width_(t))); };

  // One line of context; the harness caveat is a clause on it, not a paragraph above the chart.
  const caveat = tagged ? ' · different harnesses, so each gap includes the harness' : mixed ? ' · runs differ in settings, so not one controlled comparison' : '';
  row(truncateToWidth(muted(`${cards.some(c => !c.synthetic) ? count(cards.filter(c => !c.synthetic).length, 'model') : count(cards.length, 'synthetic control')} · ${count(tasks.length, 'task')} · ${triesLabel(cards)}`) + amber(caveat), width, '…'));
  row();

  // A name is the model, then its setup ("32k") faint; a long one loses its middle, never the quant.
  const head = (n: string) => n.split(' · ')[0]!, tag = (n: string) => n.split(' · ').slice(1).join(' · ').replace(/ tokens$/, '');
  const nameW = Math.max(8, Math.min(42, Math.max(...names.map(n => width_(head(n)) + (tag(n) ? width_(tag(n)) + 1 : 0))) + 3));
  const nameCell = (i: number, strong: boolean) => {
    const t = tag(names[i]!), room = nameW - 2 - (t ? width_(t) + 1 : 0), full = head(names[i]!), keep = Math.max(4, Math.floor(room * 0.45));
    const shown = width_(full) <= room ? full : `${full.slice(0, keep)}…${full.slice(-Math.max(4, room - keep - 1))}`;
    return padTo(`${strong ? bold(shown) : muted(shown)}${t ? faint(` ${t}`) : ''}`, nameW);
  };
  // Columns after the bar: score, spread, coverage, then the wait and effort for one right answer.
  const cover = (n: number, total: number) => (n < total ? `${n}/${total}` : '');
  const wide = width - 4 - nameW - 24 - 16 - 26 >= 0;
  const barW = Math.max(0, Math.min(28, width - 4 - nameW - 16 - (wide ? 26 : 0) - 1));
  const draw = (i: number, rate: number | null, credit: number | null, on: boolean) => {
    const paint = !on || cards[i]!.synthetic ? faint : SERIES[i % SERIES.length]!;
    if (!barW) return '';
    if (rate === null) return `${faint('·'.repeat(barW))} `;
    const full = Math.round(Math.max(0, Math.min(1, rate)) * barW), part = Math.max(full, Math.round(Math.max(0, Math.min(1, credit ?? rate)) * barW));
    return `${paint('█'.repeat(full))}${PARTIAL('█'.repeat(part - full))}${faint('░'.repeat(barW - part))} `;
  };
  const tail = (rate: number | null, spread: string, covered: string, on: boolean) =>
    `${(on ? bold : muted)(pct(rate).padStart(4))} ${faint(spread.padEnd(4))} ${faint(covered.padEnd(6))}`;

  const levels = levelsNote(cards);
  row(bold('Overall') + (levels ? faint(`   ${levels}`) : '') + (wide ? ' '.repeat(Math.max(2, nameW + 4 + barW + 1 + 16 - 7 - (levels ? width_(levels) + 3 : 0))) + faint('time · tokens per correct') : ''));
  for (const [i, { card, rank }] of ranked.entries()) {
    // A rerun spread means nothing for a control, or for a model not ranked yet.
    const on = rank !== null || card.synthetic, error = card.synthetic || rank === null ? null : scoreError(card), graded = card.tasks.filter(t => t.rate !== null).length;
    const effort = card.synthetic || card.perCorrectMs === null ? '' : `${duration(card.perCorrectMs)} · ${tokenCount(card.tokensPerCorrect)}`;
    row(`${muted(String(rank ?? '–').padStart(2))}  ${nameCell(i, on)}${draw(i, card.score, card.checkScore, on)}${tail(card.score, error === null ? '' : `±${Math.round(error * 100)}`, cover(graded, card.tasks.length), on)}${wide ? muted(effort.padStart(24)) : ''}${card.notRun ? amber(` · ${card.notRun} not run`) : ''}`);
  }
  const tiers = cards.map(c => byTier(c, tasks));
  for (const [t, { tier, ids }] of (tiers[0]?.length ? tierSlices(tasks) : []).entries()) {
    row();
    row(bold(TIER_NAME[tier]) + faint(` · ${count(ids.size, 'task')}`));
    // Each level reads highest first; a model's colour stays its own, so it is still found by colour.
    const order = tiers.map((_, i) => i).sort((a, b) => (tiers[b]![t]!.rate ?? -1) - (tiers[a]![t]!.rate ?? -1));
    for (const i of order) {
      const on = ranked[i]!.rank !== null || cards[i]!.synthetic, r = tiers[i]![t]!;
      row(`    ${nameCell(i, on)}${draw(i, r.rate, null, on)}${tail(r.rate, '', cover(r.tasks, r.total), on)}`);
    }
  }
  const notes = [cards.some(c => (c.checkScore ?? 0) > (c.score ?? 0) + 0.005) ? `${SERIES[0]!('█')} ${faint('fully solved, the score')}   ${PARTIAL('█')} ${faint('checks passed on the rest, partial credit')}` : '',
    ranked.some(r => r.rank === null && !r.card.synthetic) ? faint('– not ranked: finished tries on under half the tasks, drawn grey.') : ''].filter(Boolean);
  if (notes.length) out.push('', ...notes);
  if (chartOnly) return out;
  // Verdicts name models by name alone: their setup is on the chart. Each is one aligned row.
  const calls = verdicts(ranked), stalled = cards.filter(c => c.stalled);
  if (calls.length || stalled.length) {
    out.push(`${CARD}Verdict\u0000a gap counts only when it beats two standard errors`);
    const aW = Math.max(0, ...calls.map(v => width_(nick(v.a.label)))), bW = Math.max(0, ...calls.map(v => width_(nick(v.b.label))));
    const points = (n: number) => Math.round(n * 100);
    for (const v of calls) {
      const detail = v.clear ? `${green(`+${points(v.gap)} pts`)} ${faint(`needs ${points(v.bar)}`)}` : faint(`${points(v.gap)} pts apart, needs ${points(v.bar)}`);
      row(truncateToWidth(`${bold(padTo(nick(v.a.label), aW + 1))} ${v.clear ? green('beats    ') : muted('tied with')} ${padTo(nick(v.b.label), bW + 1)} ${detail}`, width, '…'));
    }
    if (noLeader(ranked)) prose(NO_LEADER, faint);
    if (stalled.length) prose(`Ran out of turns or time, counted as unsolved: ${stalled.map(c => `${nick(c.label)} ×${c.stalled}`).join(' · ')}`, amber);
  }
  row();

  // One column per model, wide enough for "0/3 ✗ (33%)"; a long model name wraps in its heading.
  // When there is no room for a label beside the columns, every label gets its own line above its
  // cells, so the figures keep their alignment at any width.
  const colW = Math.max(6, Math.min(11, Math.floor((width - 2) / Math.max(1, cards.length)) - 2));
  const labelW = Math.max(0, Math.min(48, width - cards.length * (colW + 2)));
  const narrow = labelW < 14;
  const widths = [narrow ? 0 : labelW, ...cards.map(() => colW)];
  // Column heads drop words every model shares and wrap at word breaks, never mid-word.
  const heads = shortLabels(names.map(head), colW + 1);
  const columns = () => out.push(...table(Array.from({ length: Math.max(...heads.map(h => h.length)) }, (_, i) => ['', ...heads.map(h => muted(h[i] ?? ''))]), widths));
  const line = (label: string, cells: string[], paint: (s: string) => string = s => s) => {
    // A long label is shortened, not wrapped, so every row keeps to one line.
    if (narrow) { row(paint(label)); out.push(...table([['', ...cells]], widths)); }
    else if (width_(label) > labelW) out.push(...table([[paint(truncateToWidth(label, labelW - 1)), ...cells]], widths));
    else out.push(...table([[paint(label), ...cells]], widths));
  };
  const rates = (values: (number | null)[]) => values.map(v => rateInk(v)(pct(v)));
  const skills = cards.map(c => byCapability(c, tasks));
  if (skills[0]?.length) {
    out.push(`${CARD}By skill\u0000share of tasks fully solved`);
    columns();
    for (const [i, { capability, ids }] of skillSlices(tasks).entries()) {
      line(`${SKILL_NAME[capability]} (${ids.size})`, skills.map(rows => rows[i]!).map(r => (r.rate === null ? faint('–') : rateInk(r.rate)(pct(r.rate)) + (colW >= 10 && r.tasks < r.total ? faint(` ${cover(r.tasks, r.total)}`) : ''))));
    }
    row();
  }
  out.push(`${CARD}Per task\u0000hardest first`);
  prose('Tries solved out of tries finished. ✓ all, ✗ none, (80%) checks passed when not solved, out×2 ran out of turns or time, · no try.', faint);
  columns();
  const paint = { solved: green, partly: amber, unsolved: rose, none: faint };
  const order = taskOrder(cards, tasks);
  // A cell too wide for its column keeps the tries first: "0/2 ✗ · ran out ×2" → "0/2 ✗ out×2" → "0/2 ✗".
  const fit = (text: string) => [text, text.replace(' · ran out ×', ' out×'), text.replace(/ (\(\d+%\)| · ran out ×\d+)$/, '')].find(t => width_(t) <= colW) ?? text;
  for (const tier of [...new Set(order.map(i => tasks[i]!.tier ?? 'unrated'))]) {
    const group = order.filter(i => (tasks[i]!.tier ?? 'unrated') === tier);
    if (tasks.some(t => t.tier)) row(muted(TIER_NAME[tier]));
    // Rows every model fully solved say nothing about the difference, so they fold into one line.
    const everyone = everyTask ? [] : group.filter(i => cards.every(c => c.tasks[i]!.rate === 1));
    for (const i of group.filter(i => !everyone.includes(i))) {
      const cells = cards.map(c => taskCell(c.tasks[i]!));
      const same = cells.every(x => x.text === cells[0]!.text);
      line(plain(tasks[i]!.title), cells.map(x => paint[x.kind](fit(x.text))), same ? faint : s => s);
    }
    if (everyone.length) prose(`${count(everyone.length, 'task')} every model solved: ${everyone.map(i => plain(tasks[i]!.title)).join(', ')} · a shows them`, faint);
  }
  row();

  // Signals that describe how a model worked, never part of the rank.
  const partial = cards.some(c => c.checkScore !== null && c.checkScore !== c.score);
  const signals = (['instructions', 'tools', 'design'] as const).filter(d => cards.some(c => c.dimensions[d] !== null));
  const gated = cards.some(c => c.hygiene.total);
  if (partial || signals.length || gated) {
    out.push(`${CARD}Other signals\u0000never part of the rank`);
    columns();
    if (partial) line(LABEL.checks, rates(cards.map(c => c.checkScore)));
    for (const d of signals) line(LABEL[d], rates(cards.map(c => c.dimensions[d])));
    // A gate, never a bar or a percentage: its checks have never failed in any recorded run,
    // so a 100% beside the score would read as praise for an unmeasured thing.
    if (gated) {
      line(LABEL.hygiene, cards.map(c => (!c.hygiene.total ? faint : c.hygiene.passed === c.hygiene.total ? green : rose)(gate(c.hygiene))));
      prose('Safe-code gate: valid Python, standard library only, no eval — a floor, not a score.', faint);
    }
  }
  // How to read the page comes last: the numbers first, the fine print after.
  out.push(`${CARD}How to read this\u0000`);
  prose(`${weighting(tasks)}. A shared rank means this run cannot tell those models apart; ± is how far a rerun could move a score; 12/14 means only 12 of 14 tasks have a finished try.${ranked.some(r => r.rank === null && !r.card.synthetic) ? ' A model with finished tries on fewer than half the tasks is not ranked.' : ''}`, faint);
  if (cards.some(c => c.synthetic)) prose('Synthetic controls check the grader, not a model, so they are never ranked.', faint);
  if (cards.some(c => c.notRun)) prose('Not run = lost to login, quota, crash or cancellation. It never counts against a model.', faint);
  return out;
}
/** One line per run, wherever runs are listed: when, how each model did, and the run's shape. */
export function runLine(run: Run): string {
  const live = ['running', 'interrupted', 'cancelled'].includes(run.status);
  const scores = scorecards([run]).cards.map(c => `${nick(c.label)} ${rateInk(c.score)(pct(c.score))}`).join(faint(' · '));
  const state = run.status === 'completed' ? '' : `  ${statusInk(run.status)(plain(run.status))}${live ? faint(` ${run.trials.length}/${run.planned}`) : ''}`;
  return `${faint(runWhen(run.id))}  ${scores}  ${faint(`${run.tasks.length}×${run.options.repeat}`)}${state}`;
}

/** Partial credit, one grey for every model, so it never reads as part of a model's own colour. */
const PARTIAL = ink(96, 98, 94);
const LABEL_LINES = 3;

/**
 * Names short enough for a narrow column: words most models share (a family and version such as
 * "Qwen3.8", or "Claude") say nothing about which bar is which, so they go, and the rest wraps to
 * the column. "Swift-Qwen3.8-27B-Q4_K_S" reads as "Swift 27B / Q4_K_S".
 */
function shortLabels(names: string[], COL_W: number): string[][] {
  const words = names.map(n => n.split(/[\s-]+/).filter(Boolean));
  const shared = (w: string) => words.filter(ws => ws.includes(w)).length * 2 >= names.length && names.length > 2;
  const w = COL_W - 1;
  return words.map(ws => {
    const kept = ws.filter(x => !shared(x));
    const lines: string[] = [];
    for (const word of (kept.length ? kept : ws)) {
      const piece = word.length > w ? `${word.slice(0, w - 1)}…` : word;
      if (lines.length && width_(`${lines.at(-1)} ${piece}`) <= w) lines[lines.length - 1] += ` ${piece}`;
      else lines.push(piece);
    }
    // Too many lines: keep the first and the last (the quant), and shorten what is between.
    if (lines.length <= LABEL_LINES) return lines;
    const middle = lines.slice(1, -1).join(' ');
    return [lines[0]!, middle.length > w ? `${middle.slice(0, w - 1)}…` : middle, lines.at(-1)!];
  });
}
