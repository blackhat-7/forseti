import { clean, hash } from './files.ts';
import { CAPABILITIES, DIMENSIONS, TIERS } from './config.ts';
import { judgeIdentity } from './judge.ts';
import type { Capability, Dimension, Run, Tier, Trial } from './types.ts';

const usable = (t: Trial) => ['passed', 'failed'].includes(t.status);
export function dimensionScore(trials: Trial[], dimension: Dimension): { passed: number; total: number; rate: number | null } {
  const checks = trials.filter(usable).flatMap(t => t.checks.filter(c => c.dimension === dimension));
  const passed = checks.filter(c => c.passed).length;
  return { passed, total: checks.length, rate: checks.length ? passed / checks.length : null };
}
export function correctness(trials: Trial[]) {
  const observed = trials.filter(t => usable(t) && t.checks.some(c => c.dimension === 'correctness'));
  const passed = observed.filter(t => t.checks.filter(c => c.dimension === 'correctness').every(c => c.passed)).length;
  return { passed, total: observed.length, rate: observed.length ? passed / observed.length : null };
}
/**
 * How much of a task was right, for tasks that were not entirely right. `correctness` is all or
 * nothing per trial, so one wrong check out of nine scores the same as nine out of nine — and the
 * difference is real: one recorded model solves 0% of `weekly-coverage` while passing 80% of its
 * checks, which is "close but never complete", not "cannot do it". Averaged per trial and then per
 * task, like the headline, so a task with many checks cannot outweigh a task with one. A flat
 * check rate does not do that, and on this record it reverses the model order.
 */
export function checkShare(trials: Trial[]): number | null {
  const observed = trials.filter(t => usable(t) && t.checks.some(c => c.dimension === 'correctness'));
  if (!observed.length) return null;
  return observed.reduce((sum, t) => {
    const checks = t.checks.filter(c => c.dimension === 'correctness');
    return sum + checks.filter(c => c.passed).length / checks.length;
  }, 0) / observed.length;
}
/**
 * How far the headline would move if the same run happened again. Each task is a handful of
 * coin flips, and the suite score averages them, so a small number of repetitions carries a lot
 * of slack: at one repetition this suite is worth about ±13 points, which is wider than most of
 * the gaps anyone wants to read out of it.
 *
 * The rate is smoothed before the variance is taken. Three passes out of three is not proof that
 * a task cannot fail, and letting it claim zero uncertainty is how a report states a ranking it
 * has not earned.
 */
export function scoreError(card: Scorecard): number | null {
  const scored = card.tasks.filter(t => t.rate !== null && t.evaluated > 0);
  if (!scored.length) return null;
  const variance = scored.reduce((sum, t) => {
    const smoothed = (t.passed + 1) / (t.evaluated + 2);
    return sum + (smoothed * (1 - smoothed)) / t.evaluated;
  }, 0);
  return Math.sqrt(variance) / scored.length;
}
/**
 * Whether two candidates are far enough apart to be called apart. Two standard errors of the
 * difference is the bar; below it the honest answer is that this run cannot tell them apart,
 * which is a result about the suite rather than about either candidate.
 */
export function separated(a: Scorecard, b: Scorecard): { gap: number; bar: number; clear: boolean } | null {
  const ea = scoreError(a), eb = scoreError(b);
  if (a.score === null || b.score === null || ea === null || eb === null) return null;
  const bar = 2 * Math.sqrt(ea ** 2 + eb ** 2);
  const gap = Math.abs(a.score - b.score);
  return { gap, bar, clear: gap > bar };
}
/**
 * A stall is the model failing to converge inside a declared budget, which is not the same thing
 * as the provider refusing to answer. Both stay out of correctness — a censored trial is not a
 * wrong answer, and that rule is why this benchmark exists. But lumping them together under
 * "not run" hides a real difference between models: across every trial recorded here, all eight
 * stalls belong to the weakest model and the other two have none, so silently dropping them
 * flatters exactly the model that earned them. Counted and shown, never scored.
 */
export const STALL: Trial['status'][] = ['budget', 'timeout'];
export function stalled(trials: Trial[]): number {
  return trials.filter(t => STALL.includes(t.status)).length;
}
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function pct(rate: number | null): string { return rate === null ? 'n/a' : `${(rate * 100).toFixed(0)}%`; }
/** A graded trial produced a score. Everything else never reached the rubric. */
export const GRADED = ['passed', 'failed'];
export function outcome(status: Trial['status']): { kind: 'pass' | 'scored' | 'not-run'; text: string } {
  if (status === 'passed') return { kind: 'pass', text: 'all checks passed' };
  if (status === 'failed') return { kind: 'scored', text: 'scored' };
  return { kind: 'not-run', text: `not run · ${status.replace('_', ' ')}` };
}
/**
 * Hygiene is a floor gate, so it reports as pass/fail rather than a rate. Every plausible
 * submission clears it — across every recorded trial its three checks have never once failed —
 * and a 100% beside correctness reads as praise for something that was never measured.
 */
export function gate(score: { passed: number; total: number }): string {
  if (!score.total) return 'n/a';
  return score.passed === score.total ? `ok (${score.total})` : `${score.total - score.passed} failed`;
}
export function bar(rate: number | null, width = 10): string {
  if (rate === null) return '·'.repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round(rate * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
export type TaskScore = { id: string; title: string; rate: number | null; checkRate: number | null; passed: number; evaluated: number; planned: number; stalled: number };
export type Scorecard = {
  label: string; score: number | null; checkScore: number | null; scoreCountingStalls: number | null; dimensions: Record<Dimension, number | null>;
  evaluated: number; planned: number; notRun: number; stalled: number; tasks: TaskScore[];
};
/**
 * What the reader sees. The ids stay terse because they live in suite JSON and saved runs; the
 * names are for someone who has never read the suite, so each one says what it checks.
 */
export const SKILL_NAME: Record<Capability, string> = { evidence: 'Only claims what the files show', restraint: 'No false alarms', exactness: 'Edge cases right', scope: 'Stays within the task', safety: 'Safe under retries and failures' };
export const TIER_NAME: Record<Tier | 'unrated', string> = { basic: 'Basic', standard: 'Standard', hard: 'Hard', unrated: 'Unrated' };
export const LABEL = { solved: 'Tasks fully solved', checks: 'Checks passed', instructions: 'Followed output format', tools: 'Tool use', design: 'Code design (reviewed)', hygiene: 'Safe-code gate', stalled: 'Ran out of turns or time' };
const tries = (n: number) => `${n} ${n === 1 ? 'try' : 'tries'}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/**
 * The same card restricted to some tasks, so `separated` can judge a gap on that slice with only
 * that slice as evidence. "Better on hard tasks" has to clear the same bar as "better overall",
 * or a one-task slice would hand out verdicts for free.
 */
export function sliceCard<T extends Scorecard>(card: T, ids: Set<string>): T {
  const tasks = card.tasks.filter(t => ids.has(t.id));
  const scored = tasks.filter(t => t.rate !== null);
  return { ...card, tasks, score: scored.length ? scored.reduce((sum, t) => sum + t.rate!, 0) / scored.length : null };
}
type RunTask = Run['tasks'][number];
// Rows come from the task list, never from one card, so every card gets the same rows in the same order.
export function skillSlices(runTasks: RunTask[]): { capability: Capability; ids: Set<string> }[] {
  return CAPABILITIES.map(capability => ({ capability, ids: new Set(runTasks.filter(t => t.capabilities?.includes(capability)).map(t => t.id)) }))
    .filter(row => row.ids.size > 0);
}
/** Runs recorded before tiers existed have none; their tasks read Unrated rather than guessed. */
export function tierSlices(runTasks: RunTask[]): { tier: Tier | 'unrated'; ids: Set<string> }[] {
  if (!runTasks.some(t => t.tier)) return [];
  return [...TIERS, 'unrated' as const].map(tier => ({ tier, ids: new Set(runTasks.filter(t => (t.tier ?? 'unrated') === tier).map(t => t.id)) }))
    .filter(row => row.ids.size > 0);
}
/**
 * Per-task correctness rolled up over a slice, weighting each task equally. `tasks` is how many of
 * them this card has a score on and `total` how many exist, so a number resting on one task is
 * visibly thin rather than silently confident.
 */
function rollup(card: Scorecard, ids: Set<string>) {
  const part = sliceCard(card, ids);
  return { rate: part.score, tasks: part.tasks.filter(t => t.rate !== null).length, total: ids.size };
}
export function byCapability(card: Scorecard, runTasks: RunTask[]) {
  return skillSlices(runTasks).map(({ capability, ids }) => ({ capability, ...rollup(card, ids) }));
}
export function byTier(card: Scorecard, runTasks: RunTask[]) {
  return tierSlices(runTasks).map(({ tier, ids }) => ({ tier, ...rollup(card, ids) }));
}
/**
 * Each card's place on one slice of tasks, judged by the same rule as the overall rank but with
 * only that slice as evidence, so a one-task slice cannot hand out a lead for free. Null where a
 * card is a control, has nothing graded there, or there is no second model to be placed against.
 */
export function slicePlaces(cards: ModelCard[], ids: Set<string>): (number | null)[] {
  const parts = cards.map(c => sliceCard(c, ids));
  const ranked = ranking(parts);
  if (ranked.filter(r => r.rank !== null).length < 2) return cards.map(() => null);
  return parts.map(p => ranked.find(r => r.card === p)!.rank);
}
export const place = (n: number) => ['1st', '2nd', '3rd'][n - 1] ?? `${n}th`;
/**
 * One number per model, weighting every task equally so a task with many checks cannot
 * dominate. The headline is correctness; instruction/tool rates stay separate so a
 * formatting miss never reads as a wrong answer.
 */
export function scorecard(label: string, trials: Trial[], tasks: { id: string; title: string }[], planned: number): Scorecard {
  const perTask = tasks.map(t => {
    const subset = trials.filter(x => x.task === t.id);
    const score = correctness(subset);
    return { id: t.id, title: t.title, rate: score.rate, checkRate: checkShare(subset), passed: score.passed, evaluated: score.total, planned: subset.length, stalled: stalled(subset) };
  });
  const scored = perTask.filter(t => t.rate !== null);
  // The same headline, computed as if every stall were a failed trial on its own task. Not the
  // score; the size of what the score leaves out.
  const counted = perTask.filter(t => t.rate !== null || t.stalled);
  return {
    label,
    score: scored.length ? scored.reduce((sum, t) => sum + t.rate!, 0) / scored.length : null,
    checkScore: scored.length ? scored.reduce((sum, t) => sum + t.checkRate!, 0) / scored.length : null,
    scoreCountingStalls: counted.length
      ? counted.reduce((sum, t) => sum + t.passed / (t.evaluated + t.stalled), 0) / counted.length
      : null,
    dimensions: Object.fromEntries(DIMENSIONS.map(d => [d, dimensionScore(trials, d).rate])) as Record<Dimension, number | null>,
    // A stall has its own count; `notRun` is only the provider or harness failing.
    evaluated: trials.filter(usable).length, planned, notRun: trials.filter(t => !usable(t) && !STALL.includes(t.status)).length,
    stalled: stalled(trials), tasks: perTask,
  };
}
function seconds(v: number | null) { return v === null ? 'n/a' : `${(v / 1000).toFixed(2)}s`; }
function escape(s: string) { return clean(s).replaceAll('|', '\\|').replaceAll('\n', ' ').replace(/[<>]/g, ''); }
export function comparisonKey(run: Run): string {
  return hash({ suite: run.suiteHash, tasks: run.tasks.map(t => t.hash).sort(), harness: run.harnessHash, lane: run.options.lane, maxTurns: run.options.maxTurns, maxTokens: run.options.maxTokens, timeout: run.options.timeout, seed: run.options.seed, cache: run.options.cache, judge: judgeIdentity(run.judge ?? null), agent: run.environment.agent ?? 'pi', agentFlags: run.environment.agentFlags ?? '', os: run.environment.os, python: run.environment.python, pythonVersion: run.environment.pythonVersion, proxyConfigured: run.environment.proxyConfigured, node: run.environment.node });
}
export type ModelCard = Scorecard & { harness: string; synthetic: boolean; tries: number; hygiene: { passed: number; total: number } };
const HARNESS: Record<string, string> = { 'claude-code': 'Claude Code', pi: 'Forseti agent' };
/**
 * Shared by the markdown report and the TUI summary so both show the same numbers. One card per
 * model: the same model under the same comparison key is one candidate measured more than once,
 * so its trials pool; under different keys it stays separate, because that difference is the
 * harness or settings, not more evidence. Every card is scored over the union of the selected
 * tasks, so a task one run never had reads "not graded" instead of shifting the columns.
 */
export function scorecards(runs: Run[]): { cards: ModelCard[]; tasks: Run['tasks']; mixed: boolean } {
  const tasks = [...new Map(runs.toReversed().flatMap(r => r.tasks).map(t => [t.id, t])).values()].reverse();
  const entries = runs.flatMap(run => run.models.map(model => ({ run, model })));
  const groups = Map.groupBy(entries, ({ run, model }) => `${comparisonKey(run)} ${model.provider}/${model.model}/${model.thinking}`);
  const name = (label: string) => clean(label).replace(/\s*·\s*via\s.*$/, '').trim();
  const cards = [...groups.values()].map(members => {
    const { run, model } = members[0]!;
    const trials = members.flatMap(m => m.run.trials.filter(t => t.model === m.model.id));
    const planned = members.reduce((sum, m) => sum + m.run.planned / m.run.models.length, 0);
    const synthetic = model.provider === 'control';
    return { run, card: {
      ...scorecard(name(model.label), trials, tasks, planned),
      harness: synthetic ? 'synthetic' : HARNESS[run.environment.agent ?? 'pi'] ?? run.environment.agent!,
      synthetic, tries: members.reduce((sum, m) => sum + m.run.options.repeat, 0), hygiene: dimensionScore(trials, 'hygiene'),
    } };
  });
  // A bare model name is what a reader wants; the run time is added only where two cards would
  // otherwise share one.
  const when = (id: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}/.test(id) ? `${id.slice(5, 10)} ${id.slice(11, 16).replace('-', ':')}` : id);
  const shared = new Set(cards.map(c => c.card.label).filter((label, i, all) => all.indexOf(label) !== i));
  for (const { run, card } of cards) if (shared.has(card.label)) card.label = `${card.label} · ${when(run.id)}`;
  return { cards: cards.map(c => c.card), tasks, mixed: new Set(runs.map(comparisonKey)).size > 1 };
}
/**
 * Rank with ties, best first: a model's rank is one more than the number of models that clearly
 * beat it, so models this run cannot tell apart share a rank. Not "tied with the model above":
 * ties chain, and on a real spread that put a model tied for first with one that clearly beats it.
 * Synthetic controls and cards with nothing graded are listed without a rank.
 */
export function ranking<T extends ModelCard>(cards: T[]): { card: T; rank: number | null }[] {
  const real = cards.filter(c => !c.synthetic && c.score !== null).sort((a, b) => b.score! - a.score!);
  const beats = (a: T, b: T) => a.score! > b.score! && separated(a, b)!.clear;
  return [...real.map(card => ({ card, rank: 1 + real.filter(other => beats(other, card)).length })),
    ...cards.filter(c => !real.includes(c)).map(card => ({ card, rank: null }))];
}
/**
 * One plain sentence per neighbouring pair in the ranking, so the reader is told which gaps are
 * real instead of inferring it from bars. Where a model is tied with its neighbour but still ranks
 * lower, the model that clearly beats it is named, so every step in rank has a stated reason.
 */
export function verdicts(ranked: { card: ModelCard; rank: number | null }[]): string[] {
  const real = ranked.filter(r => r.rank !== null);
  const points = (n: number) => Math.round(n * 100);
  const say = (a: ModelCard, b: ModelCard) => {
    const call = separated(a, b)!;
    return call.clear
      ? `${a.label} beats ${b.label}: ${points(call.gap)} points apart, more than the ${points(call.bar)} needed.`
      : `${a.label} and ${b.label} are tied: ${points(call.gap)} points apart, and this run needs ${points(call.bar)} to tell them apart.`;
  };
  const pairs = real.slice(1).flatMap(({ card, rank }, i) => {
    const above = real[i]!;
    if (separated(above.card, card)!.clear || rank === above.rank) return [say(above.card, card)];
    const winner = real.slice(0, i).findLast(o => o.card.score! > card.score! && separated(o.card, card)!.clear);
    return [say(above.card, card), ...(winner ? [say(winner.card, card)] : [])];
  });
  // Everyone sharing first place is the one case where the listed order could still be read as a ranking.
  return real.length > 1 && real.every(r => r.rank === 1) ? [...pairs, 'No model clearly beats another in this run, so the order above is not a ranking.'] : pairs;
}
/** Hardest tier first, and within a tier the task models found hardest first. */
export function taskOrder(cards: Scorecard[], tasks: Run['tasks']): number[] {
  const rank = (t: RunTask) => (t.tier ? 2 - TIERS.indexOf(t.tier) : 3);
  const mean = (i: number) => { const r = cards.map(c => c.tasks[i]!.rate).filter(r => r !== null); return r.length ? r.reduce((a, b) => a + b, 0) / r.length : 2; };
  return tasks.map((_, i) => i).sort((a, b) => rank(tasks[a]!) - rank(tasks[b]!) || mean(a) - mean(b));
}
/** A per-task cell: tries solved, and how close the rest came. Shared so both views say the same. */
export function taskCell(t: TaskScore): { text: string; kind: 'solved' | 'partly' | 'unsolved' | 'none' } {
  if (t.rate === null) return { text: '·', kind: 'none' };
  const close = t.rate < 1 && t.checkRate ? ` (${pct(t.checkRate)})` : '';
  return { text: `${t.passed}/${t.evaluated}${t.rate === 1 ? ' ✓' : t.rate === 0 ? ' ✗' : ''}${close}`, kind: t.rate === 1 ? 'solved' : t.rate === 0 ? 'unsolved' : 'partly' };
}
/** A stall is shown beside the score it was left out of, never scored. */
export function stallNote(card: Scorecard): string | null {
  if (!card.stalled) return null;
  const counted = pct(card.scoreCountingStalls), scored = pct(card.score);
  return `${card.label} ran out of turns or time on ${tries(card.stalled)}. Left out, not scored; ${counted === scored ? 'counting it as unsolved would not change the score' : `counted as unsolved it would be ${counted} instead of ${scored}`}.`;
}
export function triesLabel(cards: ModelCard[]): string {
  const counts = [...new Set(cards.map(c => c.tries))].sort((a, b) => a - b);
  return counts.length > 1 ? `${counts[0]}–${counts.at(-1)} tries each` : `${tries(counts[0] ?? 0)} each`;
}
/** Whether some cards ran in a different harness from others, which makes their gap partly the harness. */
export function harnesses(cards: ModelCard[]): string[] {
  return [...new Set(cards.filter(c => !c.synthetic).map(c => c.harness))];
}
export const HARNESS_WARNING = 'Not one controlled comparison: these models ran in different harnesses, so each gap is the model plus its harness, not the model alone.';
/** The one-page answer: who is best, which gaps are real, and where each model is strong or weak. */
function summaryMarkdown(runs: Run[]): string[] {
  const { cards: all, tasks, mixed } = scorecards(runs);
  const ranked = ranking(all), cards = ranked.map(r => r.card);
  const tagged = harnesses(cards).length > 1, lost = cards.some(c => c.notRun);
  const names = cards.map(c => escape(c.label));
  const table = (first: string) => [`| ${first} | ${names.join(' | ')} |`, `|---|${cards.map(() => '---:').join('|')}|`];
  const lines = ['# Model comparison', '', `${cards.some(c => !c.synthetic) ? plural(cards.filter(c => !c.synthetic).length, 'model') : plural(cards.length, 'synthetic control')} · ${plural(tasks.length, 'task')} · ${triesLabel(cards)}${tagged || cards.every(c => c.synthetic) ? '' : ` · ${cards[0]!.harness}`}`, ''];
  if (tagged) lines.push(`> **${HARNESS_WARNING}**`, '');
  else if (mixed) lines.push('> **Not one controlled comparison:** suite, selected tasks, lane or settings differ between these runs. See Details for each group.', '');
  lines.push(`## Who is best overall`, '', `**${LABEL.solved}**: the share of tasks a model got completely right, every task counting equally. **±** is how far the number could move if the run were repeated. A model's **rank** is 1 + how many models clearly beat it, so a shared rank means this run cannot tell them apart.`, '',
    `| Rank | Model |${tagged ? ' Harness |' : ''} ${LABEL.solved} | | ± |${lost ? ' Not run |' : ''}`, `|---:|---|${tagged ? '---|' : ''}---:|---|---:|${lost ? '---:|' : ''}`);
  for (const { card, rank } of ranked) {
    const error = card.synthetic ? null : scoreError(card);
    lines.push(`| ${rank ?? '–'} | ${escape(card.label)}${card.synthetic && !/synthetic/i.test(card.label) ? ' (synthetic)' : ''} |${tagged ? ` ${card.harness} |` : ''} **${pct(card.score)}** | \`${bar(card.score)}\` | ${error === null ? '' : `±${Math.round(error * 100)}`} |${lost ? ` ${card.notRun} |` : ''}`);
  }
  if (cards.some(c => c.synthetic)) lines.push('', 'Synthetic controls check the grader, not a model, so they are never ranked.');
  if (lost) lines.push('', '**Not run** counts tries lost to login, quota, crash or cancellation. They never count against a model.');
  const calls = verdicts(ranked), stalls = cards.map(stallNote).filter(n => n !== null);
  if (calls.length) lines.push('', '**Can this run tell them apart?** A gap counts only when it is bigger than two standard errors of the difference.', '', ...calls.map(v => `- ${escape(v)}`));
  if (stalls.length) lines.push('', ...stalls.map(n => `- ${escape(n)}`));
  lines.push('', '## Where each model is strong or weak', '');
  const cells = (rates: (number | null)[], ids: Set<string>) => {
    const places = slicePlaces(cards, ids);
    return rates.map((rate, i) => `${pct(rate)}${places[i] ? ` (${place(places[i])})` : ''}`).join(' | ');
  };
  const PLACES = 'The place in brackets is judged on those tasks alone, by the same rule as the rank; a shared place means this run cannot tell them apart there.';
  const tiers = cards.map(c => byTier(c, tasks));
  if (tiers[0]?.length) {
    lines.push(`**By difficulty** — share of tasks fully solved at each level. Basic tasks tell small models apart; hard tasks tell the strongest apart. ${PLACES}`, '', ...table('Difficulty'));
    for (const [i, { tier, ids }] of tierSlices(tasks).entries()) lines.push(`| ${TIER_NAME[tier]} (${ids.size} tasks) | ${cells(tiers.map(rows => rows[i]!.rate), ids)} |`);
    lines.push('');
  }
  const skills = cards.map(c => byCapability(c, tasks));
  if (skills[0]?.length) {
    lines.push(`**By skill** — share of tasks fully solved among the tasks that test each skill. ${PLACES}`, '', ...table('Skill'));
    for (const [i, { capability, ids }] of skillSlices(tasks).entries()) lines.push(`| ${SKILL_NAME[capability]} (${ids.size} tasks) | ${cells(skills.map(rows => rows[i]!.rate), ids)} |`);
    lines.push('');
  }
  lines.push('**Per task**, hardest first — tries fully solved out of tries graded. ✓ every try solved, ✗ none, (80%) share of checks passed when not fully solved, · not graded.', '', ...table('Task'));
  for (const i of taskOrder(cards, tasks)) lines.push(`| ${escape(tasks[i]!.title)}${tasks[i]!.tier ? ` · ${TIER_NAME[tasks[i]!.tier!]}` : ''} | ${cards.map(c => taskCell(c.tasks[i]!).text).join(' | ')} |`);
  lines.push('', '**Other signals** — never part of the rank.', '', ...table('Signal'),
    `| ${LABEL.checks} (partial credit) | ${cards.map(c => pct(c.checkScore)).join(' | ')} |`,
    ...(['instructions', 'tools', 'design'] as const).filter(d => cards.some(c => c.dimensions[d] !== null)).map(d => `| ${LABEL[d]} | ${cards.map(c => pct(c.dimensions[d])).join(' | ')} |`),
    ...(cards.some(c => c.hygiene.total) ? [`| ${LABEL.hygiene} | ${cards.map(c => gate(c.hygiene)).join(' | ')} |`, '', `The ${LABEL.hygiene} is a floor, not a score: valid Python, standard library only, no eval or exec.`] : []), '');
  return lines;
}
export function comparisonReport(runs: Run[]): string {
  if (!runs.length) throw new Error('Select at least one saved run');
  const lines = summaryMarkdown(runs);
  lines.push('## Details', '', `**${LABEL.solved}** is the fraction of graded tries passing every correctness check; **${LABEL.checks}** gives partial credit for the ones that did not. Other signals are explicit check pass rates, not subjective model grades. Tasks without a signal are N/A, not failures. Infrastructure/auth/limits/cancellation are excluded, counted, and shown separately. If outcomes are missing, overall rates are not a paired estimate; use the matched-case observations.`, '');
  const groups = Map.groupBy(runs, comparisonKey);
  if (groups.size > 1) lines.push('> **Not a controlled model comparison:** suite, selected tasks, harness, lane, settings or environment differ. Results are split into separate groups. Do not attribute cross-group differences to models. A prompt/tool lane change is an elicitation + harness ablation, not a pure model change.', '');
  for (const [key, group] of groups) {
    const first = group[0];
    lines.push(`### Experiment ${key.slice(0, 12)} · ${first.options.lane} lane`, '', `Suite: \`${escape(first.suite)}\` · suite hash \`${first.suiteHash.slice(0, 12)}\` · harness \`${first.harnessHash.slice(0, 12)}\``, '', `Budgets: ${first.options.timeout}s/trial · ${first.options.maxTurns} turns · ${first.options.maxTokens} output tokens/turn · shuffle seed ${first.options.seed}. Pi ${first.environment.pi}. No client retries; prompt caching requested **${first.options.cache ? 'on (short retention)' : 'off'}**. Caching reuses the prefix KV state and does not change sampling, but it does lower repeated input cost and first-delta latency, so cached and uncached runs are never pooled. Provider determinism/cache behavior is not guaranteed.`, '');
    const candidates = group.flatMap(run => run.models.map(model => ({ run, model, trials: run.trials.filter(t => t.model === model.id), label: `${model.label} / ${run.id.slice(11, 19)}` })));
    const hasControls = candidates.some(c => c.model.provider === 'control');
    if (hasControls) lines.push('> **Synthetic controls are fixture checks, not LLMs.** Their answers are supplied by the trusted runner. Do not compare their latency/tokens with real models.', '');
    if (first.environment.agent === 'claude-code') {
      lines.push(`> **Claude Code harness.** These trials ran through the first-party Claude Code CLI under your own plan login, not the Pi adapter. Both lanes can run code: Forseti serves this one the same sandboxed Python interpreter the Pi lane uses, so neither can verify itself against the public check while the other cannot. File access stays each client's own dialect, which is why tool checks are N/A here. What still differs is Claude Code's own system prompt, agent loop and context management, so a result here measures *the model inside Claude Code*, never the model alone. Cost is a client-side estimate at list price and is not what a subscription is billed. Flags: \`${escape(first.environment.agentFlags ?? '')}\`.`, '');
    }
    const cards = candidates.map(c => scorecard(c.label, c.trials, first.tasks, c.run.planned / c.run.models.length));
    if (first.judge?.enabled) {
      lines.push(`> **Design is judged, not computed.** A reviewer model (\`${escape(first.judge.provider)}/${escape(first.judge.model)}\`, thinking ${escape(first.judge.thinking)}, ${first.judge.repeat} round(s), majority) answers a fixed set of yes/no questions against an anchored reference, with every defect required to cite a line that exists in the submission. Uncitable defects are discarded. Design is therefore the only dimension that is not reproducible from the artifacts alone, is excluded from correctness, and is only produced for submissions that already passed every correctness check. Changing the reviewer or the rubric starts a new experiment.`, '');
    }
    lines.push('#### Scores per run', '', `The headline is ${LABEL.solved}, weighting every task equally. Other signals stay separate: a formatting miss is not a wrong answer. The ${LABEL.hygiene} is a floor, not a score — valid Python, standard library only, no eval/exec — so it reads \`ok\` or names the failures instead of scoring a percentage nobody can lose.`, '',
      `**${LABEL.solved}** is the share of tasks a model got entirely right, weighting every task equally. **${LABEL.checks}** is the share of individual correctness checks it passed, averaged the same way — partial credit, for reading beside the headline and never instead of it. A task is done or it is not, so many checks passed beside few tasks solved means close but never complete, which is a different thing from cannot do it.`, '',
      `**${LABEL.stalled}** counts tries that ran out of the ${first.options.maxTurns}-turn or ${first.options.timeout}s budget while still working. They are excluded from the score, because a censored try is not a wrong answer — but a model that cannot finish inside the budget is not equal to one that finishes every time, and the excluded tries are rarely spread evenly. Read the score and this column together.`, '',
      '**±** is how far the headline would move if the same run happened again. A gap between two models smaller than the two errors combined is not a difference this run can see; the check below says which pairs clear it.', '',
      `| Model | ${LABEL.solved} | | ± | ${LABEL.checks} | ${LABEL.stalled} | ${LABEL.instructions} | ${LABEL.tools} | ${LABEL.design} | ${LABEL.hygiene} | Graded |`, '|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const s of cards) {
      const error = scoreError(s);
      lines.push(`| ${escape(s.label)} | **${pct(s.score)}** | \`${bar(s.score)}\` | ${error === null ? 'n/a' : `±${(error * 100).toFixed(1)}`} | ${pct(s.checkScore)} | ${s.stalled ? `**${s.stalled}** · ${pct(s.scoreCountingStalls)} if counted` : '0'} | ${pct(s.dimensions.instructions)} | ${pct(s.dimensions.tools)} | ${pct(s.dimensions.design)} | ${gate(dimensionScore(candidates.find(c => c.label === s.label)!.trials, 'hygiene'))} | ${s.evaluated}/${s.planned}${s.notRun ? ` (${s.notRun} not run)` : ''} |`);
    }
    // Stated next to the scorecard, because a table of percentages invites a ranking whether or
    // not the run can support one, and the reader has no way to tell from the numbers alone.
    if (cards.length > 1) {
      const verdicts = [];
      for (let a = 0; a < cards.length; a++) for (let b = a + 1; b < cards.length; b++) {
        const call = separated(cards[a]!, cards[b]!);
        if (!call) continue;
        const [ahead, behind] = cards[a]!.score! >= cards[b]!.score! ? [cards[a]!, cards[b]!] : [cards[b]!, cards[a]!];
        verdicts.push(call.clear
          ? `- **${escape(ahead.label)} over ${escape(behind.label)}**: ${(call.gap * 100).toFixed(0)} points apart, clear of the ${(call.bar * 100).toFixed(0)}-point bar. This run separates them.`
          : `- **${escape(ahead.label)} and ${escape(behind.label)} are tied here**: ${(call.gap * 100).toFixed(0)} points apart, inside the ${(call.bar * 100).toFixed(0)}-point bar. This run cannot tell them apart; do not read the order above as a ranking. More tries shrink the bar slowly — closing a gap this size takes roughly ${Math.ceil(2 * (call.bar / 2) ** 2 / Math.max(call.gap / 2, 0.001) ** 2)}x the tries — so the faster fix is tasks on which they actually differ.`);
      }
      if (verdicts.length) lines.push('', '**Can this run tell them apart?** A gap must beat two standard errors of the difference before it is a result rather than a draw.', '', ...verdicts);
    }
    lines.push('', '#### Per-run detail', '');
    lines.push(`| Model | Tries fully solved | ${LABEL.instructions} | ${LABEL.tools} | ${LABEL.design} | ${LABEL.hygiene} | Graded / planned | Not graded, by reason |`, '|---|---:|---:|---:|---:|---:|---:|---|');
    for (const c of candidates) {
      const score = correctness(c.trials);
      const failures = Object.entries(Object.groupBy(c.trials.filter(t => !usable(t)), t => t.status)).map(([s, rows]) => `${s}: ${rows!.length}`).join(', ') || 'none';
      const planned = c.run.planned / c.run.models.length;
      const design = dimensionScore(c.trials, 'design');
      lines.push(`| ${escape(c.label)} | ${pct(score.rate)} (${score.passed}/${score.total}) | ${pct(dimensionScore(c.trials, 'instructions').rate)} | ${pct(dimensionScore(c.trials, 'tools').rate)} | ${pct(design.rate)} (${design.passed}/${design.total}) | ${gate(dimensionScore(c.trials, 'hygiene'))} | ${c.trials.filter(usable).length}/${planned} | ${failures}${c.trials.length < planned ? `; unrecorded: ${planned - c.trials.length}` : ''} |`);
    }
    const notes = candidates.flatMap(c => c.trials.filter(t => t.judgeNote).map(t => `- ${escape(c.label)} / \`${escape(t.task)}\` try ${t.repetition}: ${escape(t.judgeNote!)}`));
    if (notes.length) lines.push('', '**Submissions the reviewer did not score.** These are harness outcomes, not model failures, and carry no design score.', '', ...notes);
    lines.push('', '#### Resource use and harness time', '', '| Model | Median wall | Model wait | Tool time | Grading | First delta | Tokens (in/out/cache read/write) | Billing / estimated USD |', '|---|---:|---:|---:|---:|---:|---|---|');
    for (const c of candidates) {
      const live = c.model.provider !== 'control';
      const evaluated = c.trials.filter(usable);
      const totals = c.trials.filter(t => t.tokens).reduce((s, t) => s.map((v, i) => v + Object.values(t.tokens!)[i]), [0, 0, 0, 0]);
      const count = c.trials.filter(t => t.tokens).length;
      const knownCost = c.trials.filter(t => t.estimatedCost !== null);
      const billing = [...new Set(c.trials.map(t => t.auth.billing))].join(', ') || 'not observed';
      const cost = billing === 'subscription' ? 'plan quota; USD n/a' : billing === 'control' ? 'synthetic; USD n/a' : billing === 'local' ? 'your own server; USD n/a' : knownCost.length ? `$${knownCost.reduce((s, t) => s + t.estimatedCost!, 0).toFixed(5)} estimate (${knownCost.length}/${c.trials.length} trials)` : 'USD unknown';
      lines.push(`| ${escape(c.label)} | ${live ? seconds(median(evaluated.map(t => t.wallMs))) : 'n/a'} | ${live ? seconds(median(evaluated.map(t => t.modelMs))) : 'n/a'} | ${seconds(median(evaluated.map(t => t.toolMs)))} | ${seconds(median(evaluated.map(t => t.gradeMs)))} | ${live ? seconds(median(evaluated.flatMap(t => t.firstTokenMs === null ? [] : [t.firstTokenMs]))) : 'n/a'} | ${count ? `${totals.join('/')} (${count}/${c.trials.length} observed)` : 'not reported'} | ${billing}; ${cost} |`);
    }
    lines.push('', 'Timing medians use evaluated trials only. Model wait includes auth, SDK and transport, not pure model inference. Wall includes setup/auth/model/tools/grading; stage medians need not add up. First delta includes reasoning/tool output, not necessarily first visible text. Error-attempt usage is retained when reported. Missing usage is never treated as zero. Estimates use Pi catalog rates, exclude plan fees, and are not invoices.', '', '#### Matched-case observations', '');
    const commonTasks = first.tasks.filter(t => candidates.every(c => c.run.tasks.some(x => x.hash === t.hash)));
    if (!commonTasks.length) lines.push('No common task hashes. No paired comparison is possible.');
    let differences = 0;
    for (let a = 0; a < candidates.length; a++) for (let b = a + 1; b < candidates.length; b++) {
      const left = candidates[a], right = candidates[b];
      let wins = 0, losses = 0, ties = 0, unmatched = 0, dimensionNA = 0;
      for (const task of commonTasks) {
        const lt = left.trials.filter(t => t.task === task.id), rt = right.trials.filter(t => t.task === task.id);
        const repeats = new Set([...lt, ...rt].map(t => t.repetition));
        for (const repetition of repeats) {
          const l = lt.find(t => t.repetition === repetition), r = rt.find(t => t.repetition === repetition);
          if (!l || !r || !usable(l) || !usable(r)) { unmatched++; continue; }
          const lc = correctness([l]).rate, rc = correctness([r]).rate;
          if (lc === null || rc === null) dimensionNA++;
          else if (lc > rc) wins++; else if (lc < rc) losses++; else ties++;
          for (const check of l.checks) {
            const other = r.checks.find(x => x.id === check.id && x.dimension === check.dimension);
            if (!other || other.passed === check.passed) continue;
            differences++;
            lines.push(`- **${escape(task.title)}**, try ${repetition}, \`${escape(check.id)}\` (${check.dimension}): ${escape(left.label)} ${check.passed ? 'passed' : 'failed'}; ${escape(right.label)} ${other.passed ? 'passed' : 'failed'}.`, `  - Left evidence: ${escape(check.evidence)}`, `  - Right evidence: ${escape(other.evidence)}`, `  - Artifacts: \`runs/${left.run.id}/trials/${l.id}/result.json\` · \`runs/${right.run.id}/trials/${r.id}/result.json\``);
          }
        }
      }
      lines.push('', `**${escape(left.label)} vs ${escape(right.label)}**: ${wins} correctness wins, ${losses} losses, ${ties} ties, ${unmatched} missing/censored pairs, ${dimensionNA} pairs without a correctness rubric. Only common task hashes and try numbers with that dimension are paired.`, '');
    }
    if (!differences) lines.push('No differing matched checks observed (or fewer than two comparable candidates). This is not evidence of equivalence.', '');
    lines.push('#### Per-task repeatability', '', '| Model / task | Tries fully solved | Observed rate |', '|---|---:|---:|');
    for (const c of candidates) for (const task of c.run.tasks) {
      const subset = c.trials.filter(t => t.task === task.id), score = correctness(subset);
      lines.push(`| ${escape(c.label)} / ${escape(task.id)} | ${score.passed}/${score.total} evaluated (${c.run.options.repeat} planned) | ${pct(score.rate)} |`);
    }
    lines.push('', 'Small, personalized samples support task-specific observations, not universal rankings. Repeats of one task are correlated; no false independent-trial confidence interval is supplied. Inspect mixed outcomes and collect more matched tries before drawing conclusions. Quality and instruction proxies are limited to the published rubric. No claim about hidden model reasoning is made.', '', '#### Provenance and harness errors', '');
    for (const run of group) {
      lines.push(`- Run \`${run.id}\`: ${run.status}; ${run.trials.length}/${run.planned} recorded. Started ${run.created}. Saved manifest: \`runs/${run.id}/run.json\`.`);
      for (const model of run.models) lines.push(`  - ${escape(model.label)}: \`${escape(model.provider)}/${escape(model.model)}\`, thinking=${model.thinking}, auth=${model.auth}.`);
      for (const t of run.trials.filter(t => t.error)) lines.push(`  - \`${t.id}\` **${t.status}**: ${escape(t.error!)}`);
    }
    lines.push('', '#### Evidence for every check not passed', '');
    let failures = 0;
    for (const c of candidates) for (const trial of c.trials.filter(usable)) for (const check of trial.checks.filter(x => !x.passed)) {
      failures++;
      lines.push(`- ${escape(c.label)} / \`${escape(trial.task)}\` try ${trial.repetition} / \`${escape(check.id)}\` (${check.dimension}): ${escape(check.evidence)}. Artifact: \`runs/${c.run.id}/trials/${trial.id}/result.json\`.`);
    }
    if (!failures) lines.push('No failed checks among evaluated trials. Missing/censored trials are not passing evidence.');
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
