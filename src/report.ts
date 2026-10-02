import { clean, hash } from './files.ts';
import { CAPABILITIES, DIMENSIONS, TIERS } from './config.ts';
import { judgeIdentity } from './judge.ts';
import type { Capability, Dimension, ModelConfig, Run, Task, Tier, Trial } from './types.ts';

const usable = (t: Trial) => ['passed', 'failed'].includes(t.status);
/**
 * Running out of turns or time is the model failing inside a budget sized for the task: every task
 * may declare its own `turns` and `timeout`, and the effective budget is the larger of the run's
 * and the task's. So a stall counts as an unsolved try. The provider or harness failing (auth,
 * quota, crash, cancellation) is still `not run` and never counts against a model.
 */
export const STALL: Trial['status'][] = ['budget', 'timeout'];
export function stalled(trials: Trial[]): number {
  return trials.filter(t => STALL.includes(t.status)).length;
}
/** A try that counts: graded, or ran out of its budget. Anything else is `not run`. */
const counts = (t: Trial) => usable(t) || STALL.includes(t.status);
const scoredTry = (t: Trial) => STALL.includes(t.status) || (usable(t) && t.checks.some(c => c.dimension === 'correctness'));
export function dimensionScore(trials: Trial[], dimension: Dimension): { passed: number; total: number; rate: number | null } {
  const checks = trials.filter(usable).flatMap(t => t.checks.filter(c => c.dimension === dimension));
  const passed = checks.filter(c => c.passed).length;
  return { passed, total: checks.length, rate: checks.length ? passed / checks.length : null };
}
export function correctness(trials: Trial[]) {
  const observed = trials.filter(scoredTry);
  const passed = observed.filter(t => usable(t) && t.checks.filter(c => c.dimension === 'correctness').every(c => c.passed)).length;
  return { passed, total: observed.length, rate: observed.length ? passed / observed.length : null };
}
/**
 * How much of a task was right, for tasks that were not entirely right. `correctness` is all or
 * nothing per trial, so one wrong check out of nine scores the same as nine out of nine — and the
 * difference is real: one recorded model solves 0% of `weekly-coverage` while passing 80% of its
 * checks, which is "close but never complete", not "cannot do it". Averaged per trial and then per
 * task, like the headline, so a task with many checks cannot outweigh a task with one. A flat
 * check rate does not do that, and on this record it reverses the model order. A stall produced
 * nothing to check, so it earns no partial credit.
 */
export function checkShare(trials: Trial[]): number | null {
  const observed = trials.filter(scoredTry);
  if (!observed.length) return null;
  return observed.reduce((sum, t) => {
    if (!usable(t)) return sum;
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
  const scored = card.tasks.filter(t => t.rate !== null && (!card.levels || card.levels.includes(t.tier!)));
  if (!scored.length) return null;
  // The score is a weighted mean of independent task rates, so its variance is Σ w² · var.
  const w = weights(scored, card.weighting);
  return Math.sqrt(scored.reduce((sum, t, i) => {
    const smoothed = (t.passed + 1) / (t.evaluated + 2);
    return sum + w[i]! ** 2 * (smoothed * (1 - smoothed)) / t.evaluated;
  }, 0));
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
  if (STALL.includes(status)) return { kind: 'scored', text: `ran out of ${status === 'budget' ? 'turns' : 'time'} · counted as unsolved` };
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
// One eighth-block glyph at the boundary reads as a smooth fill instead of a bar that jumps a
// whole cell at a time; text, so it stays plain here and is coloured only where it is drawn.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
export function bar(rate: number | null, width = 10): string {
  if (rate === null) return '·'.repeat(width);
  const exact = Math.max(0, Math.min(1, rate)) * width;
  let filled = Math.floor(exact);
  let eighth = Math.round((exact - filled) * 8);
  if (eighth === 8) { filled++; eighth = 0; }
  const partial = eighth > 0 && filled < width ? EIGHTHS[eighth] : '';
  return '█'.repeat(filled) + partial + '░'.repeat(Math.max(0, width - filled - (partial ? 1 : 0)));
}
export type TaskScore = { id: string; title: string; tier?: Tier; rate: number | null; checkRate: number | null; passed: number; evaluated: number; planned: number; stalled: number };
export type Scorecard = {
  label: string; score: number | null; checkScore: number | null; dimensions: Record<Dimension, number | null>;
  evaluated: number; planned: number; notRun: number; stalled: number; tasks: TaskScore[];
  /** 'tier': each difficulty tier counts equally. 'task': every task counts equally. */
  weighting: 'tier' | 'task';
  /** Set when models cover different difficulty levels: the headline uses only these. */
  levels?: Tier[];
};
/**
 * Per-task weights for a mean over `tasks`. Under 'tier' each tier present counts equally and each
 * task equally within its tier, so eleven tasks everyone solves cannot outvote two hard ones. A
 * run without tiers is a single group, which is plain per-task weighting.
 */
function groups(tasks: TaskScore[], weighting: Scorecard['weighting']): TaskScore[][] {
  return [...Map.groupBy(tasks, t => (weighting === 'tier' ? t.tier ?? 'unrated' : '')).values()];
}
function weights(tasks: TaskScore[], weighting: Scorecard['weighting']): number[] {
  const all = groups(tasks, weighting);
  return tasks.map(t => 1 / (all.length * all.find(g => g.includes(t))!.length));
}
/** The mean of the group means, which is the mean under `weights`. */
function weightedMean(tasks: TaskScore[], weighting: Scorecard['weighting'], value: (t: TaskScore) => number): number | null {
  const all = groups(tasks, weighting);
  return all.length ? all.reduce((sum, g) => sum + g.reduce((s, t) => s + value(t), 0) / g.length, 0) / all.length : null;
}
/** Both headline numbers, weighted the same way so they can be read side by side. */
function headline(tasks: TaskScore[], weighting: Scorecard['weighting']) {
  const scored = tasks.filter(t => t.rate !== null);
  return { score: weightedMean(scored, weighting, t => t.rate!), checkScore: weightedMean(scored, weighting, t => t.checkRate!) };
}
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
  // Every task counts equally inside a slice: a tier slice is one tier, and a skill row reads as
  // the share of its tasks solved.
  return { ...card, tasks, weighting: 'task', ...headline(tasks, 'task') };
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
export type SliceRow = ReturnType<typeof rollup>;
/** Half or more of the slice's tasks not graded: the number rests on too little to place. */
export const thin = (row: { tasks: number; total: number }) => row.tasks * 2 <= row.total;
/**
 * What a tier or skill cell leaves out, or null when nothing. A task the provider or harness never
 * let run drops out of the cell, so a cell can read 100% on one task of two; the count graded
 * sits beside it.
 */
export function sliceGap(row: SliceRow): string | null {
  return row.tasks < row.total ? `${row.tasks} of ${row.total} graded` : null;
}
export const NO_PLACE = 'no place: half or more of these tasks were not graded';
/**
 * Where the headline rests on fewer tasks than the run had. Each tier keeps its full weight however
 * few of its tasks were graded, so one graded hard task can carry half the score.
 */
export function ungradedNote(card: Scorecard, runTasks: RunTask[]): string | null {
  const rows = tierSlices(runTasks).length
    ? byTier(card, runTasks).map(r => ({ ...r, name: `${TIER_NAME[r.tier].toLowerCase()} ` }))
    : [{ ...rollup(card, new Set(runTasks.map(t => t.id))), name: '' }];
  const short = rows.filter(r => r.tasks < r.total);
  return short.length ? `rests on ${short.map(r => `${r.tasks} of ${r.total} ${r.name}tasks`).join(', ')}` : null;
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
  // A thin card is left out, so it neither takes a place nor costs another model one.
  const parts = cards.map(c => sliceCard(c, ids)).map(p => (thin({ tasks: p.tasks.filter(t => t.rate !== null).length, total: ids.size }) ? { ...p, score: null } : p));
  const ranked = ranking(parts);
  if (ranked.filter(r => r.rank !== null).length < 2) return cards.map(() => null);
  return parts.map(p => ranked.find(r => r.card === p)!.rank);
}
export const place = (n: number) => ['1st', '2nd', '3rd'][n - 1] ?? `${n}th`;
/**
 * One number per model: each difficulty tier counts equally and each task equally within its tier,
 * so a task with many checks cannot dominate and a pile of easy tasks cannot drown the hard ones.
 * The headline is correctness; instruction/tool rates stay separate so a formatting miss never
 * reads as a wrong answer.
 */
export function scorecard(label: string, trials: Trial[], tasks: { id: string; title: string; tier?: Tier }[], planned: number): Scorecard {
  const perTask = tasks.map(t => {
    const subset = trials.filter(x => x.task === t.id);
    const score = correctness(subset);
    return { id: t.id, title: t.title, tier: t.tier, rate: score.rate, checkRate: checkShare(subset), passed: score.passed, evaluated: score.total, planned: subset.length, stalled: stalled(subset) };
  });
  return {
    label, weighting: 'tier', ...headline(perTask, 'tier'),
    dimensions: Object.fromEntries(DIMENSIONS.map(d => [d, dimensionScore(trials, d).rate])) as Record<Dimension, number | null>,
    // A stall is scored and has its own count; `notRun` is only the provider or harness failing.
    evaluated: trials.filter(counts).length, planned, notRun: trials.filter(t => !counts(t)).length,
    stalled: stalled(trials), tasks: perTask,
  };
}
function seconds(v: number | null) { return v === null ? 'n/a' : `${(v / 1000).toFixed(2)}s`; }
function escape(s: string) { return clean(s).replaceAll('|', '\\|').replaceAll('\n', ' ').replace(/[<>]/g, ''); }
/** A try that finished: solved, wrong, or out of its budget. Only these are worth not repeating. */
export const FINISHED: Trial['status'][] = ['passed', 'failed', ...STALL];
/**
 * Everything that can change one try's outcome except which model made it. Suite-wide facts (the
 * other tasks, the shuffle seed, how many tries) are left out, so a task's tries pool across runs
 * and a new run only makes the tries that are missing. The kernel release is left out too: it
 * changes with every system update and cannot change an answer; the platform stays.
 */
export function conditionsKey(run: Pick<Run, 'tasks' | 'options' | 'environment' | 'harnessHash' | 'judge'>, taskId: string): string {
  const task = run.tasks.find(t => t.id === taskId)!, o = run.options, e = run.environment;
  return hash({ task: task.hash, harness: run.harnessHash, lane: o.lane, cache: o.cache,
    turns: Math.max(o.maxTurns, task.turns ?? 0), timeout: Math.max(o.timeout, task.timeout ?? 0), judge: judgeIdentity(run.judge ?? null),
    platform: (e.os ?? '').split(' ').filter((_, i) => i !== 1).join(' '), python: e.python, pythonVersion: e.pythonVersion, proxy: e.proxyConfigured });
}
/**
 * The model as it ran: which model, how hard it thought, and the exact client flags that drove it.
 * Output tokens per turn belong here, not to the conditions: only the Pi lane uses the setting, so
 * it tells two local setups apart without making Claude Code tries look unlike.
 */
export function modelKey(run: Pick<Run, 'environment' | 'options'>, model: ModelConfig): string {
  const claude = model.provider === 'claude-code', e = run.environment;
  const tokens = claude ? '' : `/${run.options.maxTokens}`;
  // A run records each lane's client flags; runs from before mixed lanes recorded only their one lane's.
  const flags = (claude ? e.claudeFlags : e.piFlags) ?? e.agentFlags ?? '';
  // Claude Code's release changes its prompt and tools; a local server's context changes what fits.
  const local = localEntry(run, model);
  const release = claude ? `/cc${e.claudeVersion ?? '?'}` : local?.contextWindow ? `/ctx${local.contextWindow}` : '';
  // Behind a server alias, the file it loaded; recorded only then, so older local tries keep their key.
  const file = local?.file ? `/${local.file}` : '';
  return `${model.provider}/${model.model}/${model.thinking}${tokens}/${hash(flags).slice(0, 12)}${release}${file}`;
}
function localEntry(run: Pick<Run, 'environment'>, model: ModelConfig): { contextWindow?: number; file?: string } | undefined {
  try { return (JSON.parse(run.environment.catalog ?? '[]') as { local?: string; contextWindow?: number; file?: string }[]).find(c => c.local === model.model); } catch { return undefined; }
}
/** How a try's checks were made: the grading code and the task's own grader. A regraded try carries the key it was regraded under. */
export function gradingKey(run: Pick<Run, 'tasks' | 'gradingHash' | 'harnessHash'>, taskId: string): string {
  const task = run.tasks.find(t => t.id === taskId)!;
  return hash({ harness: run.gradingHash ?? run.harnessHash, task: task.grading ?? task.hash });
}
export const gradedKey = (run: Run, trial: Trial) => trial.graded ?? gradingKey(run, trial.task);
export function trialKey(run: Run, trial: Trial): string {
  return `${modelKey(run, run.models.find(m => m.id === trial.model)!)} ${conditionsKey(run, trial.task)}`;
}
/**
 * Every finished try recorded under today's conditions, from every run, as one virtual run the
 * comparison page renders unchanged. `now` is what a try would run under today: the code, each
 * task's fingerprint, the default settings and this machine. A try made under anything else is
 * left out, so every bar compares like with like; the one difference allowed is the lane, because
 * Claude models always run in Claude Code and local models always in the Pi agent. Controls are
 * left out: they check the grader, not a model. The suite decides which tasks count and at which
 * difficulty.
 */
export function leaderboard(runs: Run[], suite: Pick<Task, 'id' | 'title' | 'tier' | 'capabilities'>[], now: Pick<Run, 'options' | 'tasks' | 'harnessHash' | 'gradingHash' | 'environment' | 'judge'>): Run | null {
  const live = new Map(suite.map(t => [t.id, t]));
  const wanted = new Map(now.tasks.filter(t => live.has(t.id)).map(t => [t.id, conditionsKey(now, t.id)]));
  // A try graded by older rules waits for `regrade`: its submission is current, its score is not.
  const graded = new Map(now.tasks.map(t => [t.id, gradingKey(now, t.id)]));
  const newestFirst = runs.toSorted((a, b) => b.created.localeCompare(a.created));
  const models = new Map<string, ModelConfig>(), tries = new Map<string, number>(), trials: Trial[] = [];
  for (const run of newestFirst) for (const t of run.trials) {
    const m = run.models.find(x => x.id === t.model)!;
    if (m.provider === 'control' || !FINISHED.includes(t.status) || !run.tasks.some(x => x.id === t.task) || wanted.get(t.task) !== conditionsKey(run, t.task) || graded.get(t.task) !== gradedKey(run, t)) continue;
    const id = modelKey(run, m), pair = `${id} ${t.task}`, n = (tries.get(pair) ?? 0) + 1;
    // Cards pool by model name, so a Pi model's name carries what its key adds: the file behind a server
    // alias, and output tokens per turn. Claude cards keep pooling across Claude Code releases.
    const file = localEntry(run, m)?.file, pi = m.provider !== 'claude-code';
    if (!models.has(id)) models.set(id, { ...m, id, ...(pi ? {
      model: `${m.model}${file ? `/${file}` : ''}/${run.options.maxTokens}`,
      label: `${m.label} · ${Math.round(run.options.maxTokens / 1024)}k tokens`,
    } : {}) });
    tries.set(pair, n);
    trials.push({ ...t, model: id, repetition: n });
  }
  const latest = newestFirst[0];
  if (!latest || !trials.length) return null;
  const { agent: _, ...environment } = latest.environment;
  return { ...latest, id: 'leaderboard', status: 'completed', environment, options: { ...latest.options, repeat: Math.max(...tries.values()) },
    models: [...models.values()], planned: trials.length, trials,
    tasks: suite.flatMap(t => { const e = now.tasks.find(x => x.id === t.id); return e ? [{ ...e, title: t.title, tier: t.tier, capabilities: t.capabilities }] : []; }) };
}
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
/** "claude-sonnet-5-5" reads as "Claude Sonnet 5.5", "claude-haiku-4-5-20251001" as "Claude Haiku 4.5"; any other id as it is. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  return m ? `Claude ${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id;
}
export function scorecards(runs: Run[]): { cards: ModelCard[]; tasks: Run['tasks']; mixed: boolean } {
  const tasks = [...new Map(runs.toReversed().flatMap(r => r.tasks).map(t => [t.id, t])).values()].reverse();
  const entries = runs.flatMap(run => run.models.map(model => ({ run, model })));
  const groups = Map.groupBy(entries, ({ run, model }) => `${comparisonKey(run)} ${model.provider}/${model.model}/${model.thinking}`);
  const name = (label: string) => clean(label).replace(/\s*·\s*via\s.*$/, '').trim();
  // An alias like "sonnet" names whatever Claude Code maps it to, so the card says which model that was.
  const served = (trials: Trial[]) => { const ids = [...new Set(trials.flatMap(t => (t.served ? [t.served] : [])))]; return ids.length === 1 ? modelName(ids[0]!) : undefined; };
  const cards = [...groups.values()].map(members => {
    const { run, model } = members[0]!;
    const trials = members.flatMap(m => m.run.trials.filter(t => t.model === m.model.id));
    const planned = members.reduce((sum, m) => sum + m.run.planned / m.run.models.length, 0);
    const synthetic = model.provider === 'control';
    return { run, card: {
      ...scorecard(served(trials) ?? name(model.label), trials, tasks, planned),
      harness: synthetic ? 'synthetic' : HARNESS[model.provider === 'claude-code' ? 'claude-code' : 'pi']!,
      synthetic, tries: members.reduce((sum, m) => sum + m.run.options.repeat, 0), hygiene: dimensionScore(trials, 'hygiene'),
    } };
  });
  // A bare model name is what a reader wants; the run time is added only where two cards would
  // otherwise share one.
  const when = (id: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}/.test(id) ? `${id.slice(5, 10)} ${id.slice(11, 16).replace('-', ':')}` : id);
  const shared = new Set(cards.map(c => c.card.label).filter((label, i, all) => all.indexOf(label) !== i));
  for (const { run, card } of cards) if (shared.has(card.label)) card.label = `${card.label} · ${when(run.id)}`;
  // A level only some models have tries on would lift or sink only their overall score, so when
  // coverage differs the headline is taken over the levels every model shares.
  const has = (c: ModelCard) => new Set(c.tasks.filter(t => t.rate !== null && t.tier).map(t => t.tier!));
  const real = cards.map(c => c.card).filter(c => !c.synthetic && c.weighting === 'tier');
  const common = TIERS.filter(tier => real.length && real.every(c => has(c).has(tier)));
  if (common.length && real.some(c => has(c).size > common.length)) {
    for (const { card } of cards) Object.assign(card, { levels: common }, headline(card.tasks.filter(t => common.includes(t.tier!)), 'tier'));
  }
  return { cards: cards.map(c => c.card), tasks, mixed: new Set(runs.map(comparisonKey)).size > 1 };
}
/**
 * Rank with ties, best first: a model's rank is one more than the number of models that clearly
 * beat it, so models this run cannot tell apart share a rank. Not "tied with the model above":
 * ties chain, and on a real spread that put a model tied for first with one that clearly beats it.
 * Synthetic controls and cards with nothing graded are listed without a rank.
 */
export function ranking<T extends ModelCard>(cards: T[]): { card: T; rank: number | null }[] {
  // A model with finished tries on fewer than half the tasks has a score about a different, smaller
  // suite, so it is shown but never ranked against models that ran them all.
  const enough = (c: T) => 2 * c.tasks.filter(t => t.rate !== null).length >= c.tasks.length;
  const real = cards.filter(c => !c.synthetic && c.score !== null && enough(c)).sort((a, b) => b.score! - a.score!);
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
  // Stalls are already in the denominator; the note says which unsolved tries they were.
  const close = t.stalled ? ` · ran out ×${t.stalled}` : t.rate < 1 && t.checkRate ? ` (${pct(t.checkRate)})` : '';
  return { text: `${t.passed}/${t.evaluated}${t.rate === 1 ? ' ✓' : t.rate === 0 ? ' ✗' : ''}${close}`, kind: t.rate === 1 ? 'solved' : t.rate === 0 ? 'unsolved' : 'partly' };
}
/** Stalls are scored as unsolved; this says how many of a model's unsolved tries they were. */
export function stallNote(card: Scorecard): string | null {
  return card.stalled ? `${card.label} ran out of turns or time on ${tries(card.stalled)} (counted as unsolved).` : null;
}
/** How the headline weighs tasks, in one plain phrase, so the page states what its number means. */
/** Says which levels the headline covers when models do not all have tries on every level. */
export function levelsNote(cards: Scorecard[]): string | null {
  const levels = cards.find(c => c.levels)?.levels;
  return levels ? `${levels.map(t => TIER_NAME[t]).join(' and ')} only: not every model has tries on every level` : null;
}
export function weighting(runTasks: RunTask[]): string {
  return tierSlices(runTasks).length ? 'Each difficulty level counts equally, and each task within its level' : 'Every task counts equally';
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
  const caveats = cards.map(c => (c.synthetic ? null : ungradedNote(c, tasks))), caveat = caveats.some(n => n);
  const names = cards.map(c => escape(c.label));
  const table = (first: string) => [`| ${first} | ${names.join(' | ')} |`, `|---|${cards.map(() => '---:').join('|')}|`];
  const lines = ['# Model comparison', '', `${cards.some(c => !c.synthetic) ? plural(cards.filter(c => !c.synthetic).length, 'model') : plural(cards.length, 'synthetic control')} · ${plural(tasks.length, 'task')} · ${triesLabel(cards)}${tagged || cards.every(c => c.synthetic) ? '' : ` · ${cards[0]!.harness}`}`, ''];
  if (tagged) lines.push(`> **${HARNESS_WARNING}**`, '');
  const levels = levelsNote(cards);
  if (levels) lines.push(`> **Overall covers ${levels}.**`, '');
  else if (mixed) lines.push('> **Not one controlled comparison:** suite, selected tasks, lane or settings differ between these runs. See Details for each group.', '');
  lines.push(`## Who is best overall`, '', `**${LABEL.solved}**: the share of tasks a model got completely right. ${weighting(tasks)}. **±** is how far the number could move if the run were repeated. A model's **rank** is 1 + how many models clearly beat it, so a shared rank means this run cannot tell them apart.`, '',
    `| Rank | Model |${tagged ? ' Harness |' : ''} ${LABEL.solved} | | ± |${lost ? ' Not run |' : ''}${caveat ? ' Caveat |' : ''}`, `|---:|---|${tagged ? '---|' : ''}---:|---|---:|${lost ? '---:|' : ''}${caveat ? '---|' : ''}`);
  for (const [i, { card, rank }] of ranked.entries()) {
    const error = card.synthetic ? null : scoreError(card);
    lines.push(`| ${rank ?? '–'} | ${escape(card.label)}${card.synthetic && !/synthetic/i.test(card.label) ? ' (synthetic)' : ''} |${tagged ? ` ${card.harness} |` : ''} **${pct(card.score)}** | \`${bar(card.score)}\` | ${error === null ? '' : `±${Math.round(error * 100)}`} |${lost ? ` ${card.notRun} |` : ''}${caveat ? ` ${caveats[i] ?? ''} |` : ''}`);
  }
  if (cards.some(c => c.synthetic)) lines.push('', 'Synthetic controls check the grader, not a model, so they are never ranked.');
  if (lost) lines.push('', '**Not run** counts tries lost to login, quota, crash or cancellation. They never count against a model.');
  const calls = verdicts(ranked), stalls = cards.map(stallNote).filter(n => n !== null);
  if (calls.length) lines.push('', '**Can this run tell them apart?** A gap counts only when it is bigger than two standard errors of the difference.', '', ...calls.map(v => `- ${escape(v)}`));
  if (stalls.length) lines.push('', ...stalls.map(n => `- ${escape(n)}`));
  lines.push('', '## Where each model is strong or weak', '');
  let unplaced = false;
  const cells = (rows: SliceRow[], ids: Set<string>) => {
    const places = slicePlaces(cards, ids), placing = places.some(p => p !== null);
    return rows.map((row, i) => {
      const gap = sliceGap(row), dash = placing && thin(row);
      unplaced ||= dash;
      return `${pct(row.rate)}${places[i] ? ` (${place(places[i])})` : dash ? ' (–)' : ''}${gap ? ` · ${gap}` : ''}`;
    }).join(' | ');
  };
  const PLACES = 'The place in brackets is judged on those tasks alone, by the same rule as the rank; a shared place means this run cannot tell them apart there. Where login, quota or a crash kept tasks from being graded, the cell says how many were.';
  const dashNote = () => { if (unplaced) lines.push(`(–) ${NO_PLACE} for that model.`, ''); unplaced = false; };
  const tiers = cards.map(c => byTier(c, tasks));
  if (tiers[0]?.length) {
    lines.push(`**By difficulty** — share of tasks fully solved at each level. Basic tasks tell small models apart; hard tasks tell the strongest apart. ${PLACES}`, '', ...table('Difficulty'));
    for (const [i, { tier, ids }] of tierSlices(tasks).entries()) lines.push(`| ${TIER_NAME[tier]} (${ids.size} tasks) | ${cells(tiers.map(rows => rows[i]!), ids)} |`);
    lines.push('');
    dashNote();
  }
  const skills = cards.map(c => byCapability(c, tasks));
  if (skills[0]?.length) {
    lines.push(`**By skill** — share of tasks fully solved among the tasks that test each skill. ${PLACES}`, '', ...table('Skill'));
    for (const [i, { capability, ids }] of skillSlices(tasks).entries()) lines.push(`| ${SKILL_NAME[capability]} (${ids.size} tasks) | ${cells(skills.map(rows => rows[i]!), ids)} |`);
    lines.push('');
    dashNote();
  }
  lines.push('**Per task**, hardest first — tries fully solved out of tries graded. ✓ every try solved, ✗ none, (80%) share of checks passed when not fully solved, ran out ×2 = tries that ran out of turns or time, counted as unsolved, · not graded.', '', ...table('Task'));
  for (const i of taskOrder(cards, tasks)) lines.push(`| ${escape(tasks[i]!.title)}${tasks[i]!.tier ? ` · ${TIER_NAME[tasks[i]!.tier!]}` : ''} | ${cards.map(c => taskCell(c.tasks[i]!).text).join(' | ')} |`);
  lines.push('', '**Other signals** — never part of the rank.', '', ...table('Signal'),
    `| ${LABEL.checks} (partial credit) | ${cards.map(c => pct(c.checkScore)).join(' | ')} |`,
    ...(['instructions', 'tools', 'design'] as const).filter(d => cards.some(c => c.dimensions[d] !== null)).map(d => `| ${LABEL[d]} | ${cards.map(c => pct(c.dimensions[d])).join(' | ')} |`),
    ...(cards.some(c => c.hygiene.total) ? [`| ${LABEL.hygiene} | ${cards.map(c => gate(c.hygiene)).join(' | ')} |`, '', `The ${LABEL.hygiene} is a floor, not a score: valid Python, standard library only, no eval or exec.`] : []), '');
  return lines;
}
/**
 * What an ops session did to its estate, as its world reports it: orders lost, customers hit,
 * dollars spent. Pass or fail says whether the fix was acceptable; this says how much it cost,
 * which is what separates two failing models. Empty for tasks without a world.
 */
export function impactOf(trial: Trial): string {
  const impact = (trial.world as { impact?: unknown } | undefined)?.impact;
  if (!Array.isArray(impact)) return '';
  return impact.filter((i): i is { label: string; value: number; unit?: string } => typeof i?.label === 'string' && typeof i?.value === 'number')
    .map(i => `${i.label} ${i.value.toLocaleString('en-US', { maximumFractionDigits: 1 })}${i.unit ? ` ${i.unit}` : ''}`).join(' · ');
}
export function comparisonReport(runs: Run[]): string {
  if (!runs.length) throw new Error('Select at least one saved run');
  const lines = summaryMarkdown(runs);
  lines.push('## Details', '', `**${LABEL.solved}** is the fraction of graded tries passing every correctness check; **${LABEL.checks}** gives partial credit for the ones that did not. Other signals are explicit check pass rates, not subjective model grades. Tasks without a signal are N/A, not failures. Login, quota, crash and cancellation are excluded, counted, and shown separately. Running out of turns or time counts as an unsolved try. If outcomes are missing, overall rates are not a paired estimate; use the matched-case observations.`, '');
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
    lines.push('#### Scores per run', '', `The headline is ${LABEL.solved}. ${weighting(first.tasks)}. Other signals stay separate: a formatting miss is not a wrong answer. The ${LABEL.hygiene} is a floor, not a score — valid Python, standard library only, no eval/exec — so it reads \`ok\` or names the failures instead of scoring a percentage nobody can lose.`, '',
      `**${LABEL.solved}** is the share of tasks a model got entirely right. ${weighting(first.tasks)}. **${LABEL.checks}** is the share of individual correctness checks it passed, averaged the same way — partial credit, for reading beside the headline and never instead of it. A task is done or it is not, so many checks passed beside few tasks solved means close but never complete, which is a different thing from cannot do it.`, '',
      `**${LABEL.stalled}** counts tries that ran out of their turn or time budget while still working: at least ${first.options.maxTurns} turns and ${first.options.timeout}s, more where a task declares its own. They count as unsolved, because the budget is sized for the task.`, '',
      '**±** is how far the headline would move if the same run happened again. A gap between two models smaller than the two errors combined is not a difference this run can see; the check below says which pairs clear it.', '',
      `| Model | ${LABEL.solved} | | ± | ${LABEL.checks} | ${LABEL.stalled} | ${LABEL.instructions} | ${LABEL.tools} | ${LABEL.design} | ${LABEL.hygiene} | Graded |`, '|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const s of cards) {
      const error = scoreError(s);
      lines.push(`| ${escape(s.label)} | **${pct(s.score)}** | \`${bar(s.score)}\` | ${error === null ? 'n/a' : `±${(error * 100).toFixed(1)}`} | ${pct(s.checkScore)} | ${s.stalled} | ${pct(s.dimensions.instructions)} | ${pct(s.dimensions.tools)} | ${pct(s.dimensions.design)} | ${gate(dimensionScore(candidates.find(c => c.label === s.label)!.trials, 'hygiene'))} | ${s.evaluated}/${s.planned}${s.notRun ? ` (${s.notRun} not run)` : ''} |`);
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
      const failures = Object.entries(Object.groupBy(c.trials.filter(t => !counts(t)), t => t.status)).map(([s, rows]) => `${s}: ${rows!.length}`).join(', ') || 'none';
      const planned = c.run.planned / c.run.models.length;
      const design = dimensionScore(c.trials, 'design');
      lines.push(`| ${escape(c.label)} | ${pct(score.rate)} (${score.passed}/${score.total}) | ${pct(dimensionScore(c.trials, 'instructions').rate)} | ${pct(dimensionScore(c.trials, 'tools').rate)} | ${pct(design.rate)} (${design.passed}/${design.total}) | ${gate(dimensionScore(c.trials, 'hygiene'))} | ${c.trials.filter(counts).length}/${planned} | ${failures}${c.trials.length < planned ? `; unrecorded: ${planned - c.trials.length}` : ''} |`);
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
          if (!l || !r || !counts(l) || !counts(r)) { unmatched++; continue; }
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
      lines.push('', `**${escape(left.label)} vs ${escape(right.label)}**: ${wins} correctness wins, ${losses} losses, ${ties} ties, ${unmatched} missing or not-run pairs, ${dimensionNA} pairs without a correctness rubric. Only common task hashes and try numbers with that dimension are paired.`, '');
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
    const harm = candidates.flatMap(c => c.trials.filter(usable).map(trial => [c, trial] as const)).filter(([, t]) => impactOf(t));
    if (harm.length) {
      lines.push('', '#### What each production session did to the estate', '');
      for (const [c, trial] of harm) lines.push(`- ${escape(c.label)} / \`${escape(trial.task)}\` try ${trial.repetition}: ${escape(impactOf(trial))}.`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
