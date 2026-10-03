import { Text, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { LABEL, SKILL_NAME, TIER_NAME, bar, duration, byCapability, byTier, gate, harnesses, levelsNote, ranking, scoreError, scorecards, skillSlices, stallNote, taskCell, taskOrder, tierSlices, triesLabel, verdicts, weighting } from '../report.ts';
import type { Run } from '../types.ts';
import { CARD, MAX_TEXT, SERIES, amber, bold, count, faint, green, muted, nick, padTo, pct, plain, rateInk, rose, runWhen, statusInk, table, terminalText, width_ } from './kit.ts';

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
  row(muted(`${cards.some(c => !c.synthetic) ? count(cards.filter(c => !c.synthetic).length, 'model') : count(cards.length, 'synthetic control')} · ${count(tasks.length, 'task')} · ${triesLabel(cards)}`) + amber(caveat));
  row();

  // One chart answers the page's question: who is ahead, by how much, and at which difficulty.
  // Coverage shows only where tasks are missing, so a full row stays just a bar and a number.
  const cover = (n: number, total: number) => (n < total ? faint(` ${n}/${total}`) : '');
  const nameW = Math.max(8, Math.min(40, Math.max(...names.map(width_)) + 2));
  // A bar too short to read is dropped, so the percentage itself stays on screen on a narrow terminal.
  // Spread and coverage always show: a score without them overclaims. The wait and "not ranked"
  // columns need about 32 more cells; where they would squeeze the bar below its full 30 they are
  // dropped instead, because the bar is what the page is for and L opens every number.
  const wide = width - 4 - nameW - 6 - 30 - 14 - 32 >= 0;
  const room = Math.min(30, width - 4 - nameW - 18 - (wide ? 32 : 0)), barW = room < 6 ? 0 : room;
  const barLine = (i: number, lead: string, rate: number | null, tail: string) =>
    lead + pad(names[i]!, nameW) + (barW ? (cards[i]!.synthetic ? faint : SERIES[i % SERIES.length]!)(bar(rate, barW)) + ' ' : '') + bold(pct(rate).padStart(4)) + tail;
  const levels = levelsNote(cards);
  row(bold('Overall') + (levels ? faint(`   ${levels}`) : ''));
  // Fixed columns after the score: the spread, then the wait for one right answer, then notes. A
  // column, not a run-on tail, so the eye can read down it and nothing important is cut off first.
  for (const [i, { card, rank }] of ranked.entries()) {
    // A rerun spread means nothing for a control, or for a model not ranked yet.
    const error = card.synthetic || rank === null ? null : scoreError(card), graded = card.tasks.filter(t => t.rate !== null).length;
    const base = faint(error === null ? '' : ` ±${Math.round(error * 100)}`) + cover(graded, card.tasks.length);
    const wait = card.synthetic || card.perCorrectMs === null ? '' : `${duration(card.perCorrectMs)}/correct`;
    const extra = wide ? `${muted(wait.padEnd(17))}${faint(rank === null && !card.synthetic ? 'not ranked' : '')}` : '';
    row(barLine(i, muted(String(rank ?? '–').padStart(2)) + '  ', card.score, `${wide ? padTo(base, 12) : base}${extra}${card.notRun ? amber(` · ${card.notRun} not run`) : ''}`));
  }
  const tiers = cards.map(c => byTier(c, tasks));
  for (const [t, { tier, ids }] of (tiers[0]?.length ? tierSlices(tasks) : []).entries()) {
    row(bold(TIER_NAME[tier]) + faint(` · ${count(ids.size, 'task')}`));
    for (const [i, rows] of tiers.entries()) row(barLine(i, '    ', rows[t]!.rate, cover(rows[t]!.tasks, rows[t]!.total)));
  }
  if (chartOnly) return out;
  const calls = verdicts(ranked), stalls = cards.map(stallNote).filter(n => n !== null);
  if (calls.length || stalls.length) {
    out.push(`${CARD}Verdict\u0000a gap counts only when it beats two standard errors`);
    for (const call of calls) prose(call);
    for (const note of stalls) prose(note, amber);
  }
  row();

  // One column per model, wide enough for "0/3 ✗ (33%)"; a long model name wraps in its heading.
  // When there is no room for a label beside the columns, every label gets its own line above its
  // cells, so the figures keep their alignment at any width.
  const colW = Math.max(6, Math.min(11, Math.floor((width - 2) / Math.max(1, cards.length)) - 2));
  const labelW = Math.max(0, Math.min(48, width - cards.length * (colW + 2)));
  const narrow = labelW < 14;
  const widths = [narrow ? 0 : labelW, ...cards.map(() => colW)];
  const heads = names.map(n => wrapTextWithAnsi(n, colW));
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
      line(`${SKILL_NAME[capability]} (${ids.size})`, skills.map(rows => rows[i]!).map(r => (r.rate === null ? faint('–') : rateInk(r.rate)(pct(r.rate)) + (colW >= 10 ? cover(r.tasks, r.total) : ''))));
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
