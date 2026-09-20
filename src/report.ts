import { clean, hash } from './files.ts';
import { CAPABILITIES, DIMENSIONS } from './config.ts';
import { judgeIdentity } from './judge.ts';
import type { Capability, Dimension, Run, Trial } from './types.ts';

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
 * Rolls per-task correctness up by capability, weighting each task equally. `tasks` is the
 * number of tasks backing the number, so a capability resting on one task is visibly thin
 * rather than silently confident.
 */
export function byCapability(card: Scorecard, runTasks: { id: string; capabilities?: Capability[] }[]): { capability: Capability; rate: number | null; tasks: number }[] {
  return CAPABILITIES.map(capability => {
    const part = capabilityCard(card, runTasks, capability);
    return { capability, rate: part.score, tasks: part.tasks.filter(t => t.rate !== null).length };
  }).filter(row => row.tasks > 0);
}
/**
 * The same card restricted to the tasks behind one capability, so `separated` can judge a gap on
 * that kind of task with only that kind of task as evidence. "Better at evidence" has to clear the
 * same bar as "better overall", or a one-task capability would hand out verdicts for free.
 */
export function capabilityCard(card: Scorecard, runTasks: { id: string; capabilities?: Capability[] }[], capability: Capability): Scorecard {
  const ids = new Set(runTasks.filter(t => t.capabilities?.includes(capability)).map(t => t.id));
  const tasks = card.tasks.filter(t => ids.has(t.id));
  const scored = tasks.filter(t => t.rate !== null);
  return { ...card, tasks, score: scored.length ? scored.reduce((sum, t) => sum + t.rate!, 0) / scored.length : null };
}
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
    evaluated: trials.filter(usable).length, planned, notRun: trials.filter(t => !usable(t)).length,
    stalled: stalled(trials), tasks: perTask,
  };
}
function seconds(v: number | null) { return v === null ? 'n/a' : `${(v / 1000).toFixed(2)}s`; }
function escape(s: string) { return clean(s).replaceAll('|', '\\|').replaceAll('\n', ' ').replace(/[<>]/g, ''); }
export function comparisonKey(run: Run): string {
  return hash({ suite: run.suiteHash, tasks: run.tasks.map(t => t.hash).sort(), harness: run.harnessHash, lane: run.options.lane, maxTurns: run.options.maxTurns, maxTokens: run.options.maxTokens, timeout: run.options.timeout, seed: run.options.seed, cache: run.options.cache, judge: judgeIdentity(run.judge ?? null), agent: run.environment.agent ?? 'pi', agentFlags: run.environment.agentFlags ?? '', os: run.environment.os, python: run.environment.python, pythonVersion: run.environment.pythonVersion, proxyConfigured: run.environment.proxyConfigured, node: run.environment.node });
}
/** Shared by the markdown report and the TUI summary so both show the same numbers. */
export function scorecards(runs: Run[]): { cards: Scorecard[]; tasks: Run['tasks']; mixed: boolean } {
  const first = runs[0]!;
  const cards = runs.flatMap(run => run.models.map(model =>
    scorecard(`${model.label} / ${run.id.slice(11, 19)}`, run.trials.filter(t => t.model === model.id), first.tasks, run.planned / run.models.length)));
  return { cards, tasks: first.tasks, mixed: new Set(runs.map(comparisonKey)).size > 1 };
}
export function comparisonReport(runs: Run[]): string {
  if (!runs.length) throw new Error('Select at least one saved run');
  const lines = ['# Forseti · evidence, not just rankings', '', 'Correctness is the fraction of evaluated trials passing every correctness check; the Checks column beside it gives partial credit for the ones that did not. Other dimensions are explicit check pass rates, not subjective model grades. Tasks without a dimension are N/A, not failures. Infrastructure/auth/limits/cancellation are excluded, counted, and shown separately. If outcomes are missing, overall rates are not a paired estimate; use the matched-case observations.', ''];
  const groups = Map.groupBy(runs, comparisonKey);
  if (groups.size > 1) lines.push('> **Not a controlled model comparison:** suite, selected tasks, harness, lane, settings or environment differ. Results are split into separate groups. Do not attribute cross-group differences to models. A prompt/tool lane change is an elicitation + harness ablation, not a pure model change.', '');
  for (const [key, group] of groups) {
    const first = group[0];
    lines.push(`## Experiment ${key.slice(0, 12)} · ${first.options.lane} lane`, '', `Suite: \`${escape(first.suite)}\` · suite hash \`${first.suiteHash.slice(0, 12)}\` · harness \`${first.harnessHash.slice(0, 12)}\``, '', `Budgets: ${first.options.timeout}s/trial · ${first.options.maxTurns} turns · ${first.options.maxTokens} output tokens/turn · shuffle seed ${first.options.seed}. Pi ${first.environment.pi}. No client retries; prompt caching requested **${first.options.cache ? 'on (short retention)' : 'off'}**. Caching reuses the prefix KV state and does not change sampling, but it does lower repeated input cost and first-delta latency, so cached and uncached runs are never pooled. Provider determinism/cache behavior is not guaranteed.`, '');
    const candidates = group.flatMap(run => run.models.map(model => ({ run, model, trials: run.trials.filter(t => t.model === model.id), label: `${model.label} / ${run.id.slice(11, 19)}` })));
    const hasControls = candidates.some(c => c.model.provider === 'control');
    if (hasControls) lines.push('> **Synthetic controls are fixture checks, not LLMs.** Their answers are supplied by the trusted runner. Do not compare their latency/tokens with real models.', '');
    if (first.environment.agent === 'claude-code') {
      lines.push(`> **Claude Code harness.** These trials ran through the first-party Claude Code CLI under your own plan login, not the Pi adapter. Claude Code brings its own system prompt, agent loop, context management and tools, so a result here measures *the model inside Claude Code*, never the model alone. Tool checks are N/A because the suite's tool rubric names Forseti's tools. Cost is a client-side estimate at list price and is not what a subscription is billed. Flags: \`${escape(first.environment.agentFlags ?? '')}\`.`, '');
    }
    const cards = candidates.map(c => scorecard(c.label, c.trials, first.tasks, c.run.planned / c.run.models.length));
    if (first.judge?.enabled) {
      lines.push(`> **Design is judged, not computed.** A reviewer model (\`${escape(first.judge.provider)}/${escape(first.judge.model)}\`, thinking ${escape(first.judge.thinking)}, ${first.judge.repeat} round(s), majority) answers a fixed set of yes/no questions against an anchored reference, with every defect required to cite a line that exists in the submission. Uncitable defects are discarded. Design is therefore the only dimension that is not reproducible from the artifacts alone, is excluded from correctness, and is only produced for submissions that already passed every correctness check. Changing the reviewer or the rubric starts a new experiment.`, '');
    }
    lines.push('### Scorecard', '', 'Headline is correctness, weighting every task equally. Other dimensions stay separate: a formatting miss is not a wrong answer. Hygiene is a gate, not a rate — valid AST, stdlib-only imports, no eval/exec — so it reads `ok` or names the failures instead of scoring a percentage nobody can lose.', '',
      `**Correct** is the headline: the share of tasks a candidate got entirely right, weighting every task equally. **Checks** is the share of individual correctness checks it passed, averaged the same way — partial credit, for reading beside the headline and never instead of it. A task is done or it is not, so a high Checks beside a low Correct means close but never complete, which is a different thing from cannot do it.`, '',
      `**Stalled** counts trials that ran out of the ${first.options.maxTurns}-turn or ${first.options.timeout}s budget while still working. They are excluded from correctness, because a censored trial is not a wrong answer — but a model that cannot finish inside the budget is not equal to one that finishes every time, and the excluded trials are rarely spread evenly. Read the score and this column together.`, '',
      '**±** is how far the headline would move if the same run happened again. A gap between two candidates smaller than the two errors combined is not a difference this run can see; the ranking check below says which pairs clear it.', '',
      '| Candidate | Correct | | ± | Checks | Stalled | Instructions | Tools | Design | Hygiene | Graded |', '|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|');
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
          : `- **${escape(ahead.label)} and ${escape(behind.label)} are tied here**: ${(call.gap * 100).toFixed(0)} points apart, inside the ${(call.bar * 100).toFixed(0)}-point bar. This run cannot tell them apart; do not read the order above as a ranking. More repetitions shrink the bar slowly — closing a gap this size takes roughly ${Math.ceil(2 * (call.bar / 2) ** 2 / Math.max(call.gap / 2, 0.001) ** 2)}x the repetitions — so the faster fix is tasks on which they actually differ.`);
      }
      if (verdicts.length) lines.push('', '**Can this run tell them apart?** A gap must beat two standard errors of the difference before it is a result rather than a draw.', '', ...verdicts);
    }
    const suiteTasks = first.tasks;
    const caps = cards.map(s => byCapability(s, suiteTasks));
    if (caps[0]?.length) {
      lines.push('', '**By capability** — correctness rolled up by the skill each task demands, equal weight per task. `t` is how many tasks back the number.', '',
        `| Capability | ${cards.map(s => escape(s.label)).join(' | ')} |`, `|---|${cards.map(() => '---:').join('|')}|`);
      for (const [i, row] of caps[0].entries()) {
        lines.push(`| ${row.capability} | ${caps.map(rows => `${pct(rows[i]!.rate)} (${rows[i]!.tasks}t)`).join(' | ')} |`);
      }
    }
    lines.push('', '**Per task** — ● every repetition correct · ◐ some · ○ none · · not graded. A task that was not fully solved also shows the share of its checks that passed, which is where "close" and "nowhere near" stop looking alike.', '',
      `| Task | ${cards.map(s => escape(s.label)).join(' | ')} |`, `|---|${cards.map(() => '---:').join('|')}|`);
    for (const [i, task] of first.tasks.entries()) {
      const cells = cards.map(s => {
        const t = s.tasks[i]!;
        if (t.rate === null) return '·';
        const mark = `${t.rate === 1 ? '●' : t.rate === 0 ? '○' : '◐'} ${t.passed}/${t.evaluated}`;
        return t.rate === 1 ? mark : `${mark} · ${pct(t.checkRate)} of checks`;
      });
      lines.push(`| ${escape(task.title)} | ${cells.join(' | ')} |`);
    }
    lines.push('', '### Detail', '');
    lines.push('| Candidate | Correct trials | Instructions | Tool checks | Design checks | Hygiene gate | Evaluated / planned | Non-model outcomes |', '|---|---:|---:|---:|---:|---:|---:|---|');
    for (const c of candidates) {
      const score = correctness(c.trials);
      const failures = Object.entries(Object.groupBy(c.trials.filter(t => !usable(t)), t => t.status)).map(([s, rows]) => `${s}: ${rows!.length}`).join(', ') || 'none';
      const planned = c.run.planned / c.run.models.length;
      const design = dimensionScore(c.trials, 'design');
      lines.push(`| ${escape(c.label)} | ${pct(score.rate)} (${score.passed}/${score.total}) | ${pct(dimensionScore(c.trials, 'instructions').rate)} | ${pct(dimensionScore(c.trials, 'tools').rate)} | ${pct(design.rate)} (${design.passed}/${design.total}) | ${gate(dimensionScore(c.trials, 'hygiene'))} | ${c.trials.filter(usable).length}/${planned} | ${failures}${c.trials.length < planned ? `; unrecorded: ${planned - c.trials.length}` : ''} |`);
    }
    const notes = candidates.flatMap(c => c.trials.filter(t => t.judgeNote).map(t => `- ${escape(c.label)} / \`${escape(t.task)}\` repeat ${t.repetition}: ${escape(t.judgeNote!)}`));
    if (notes.length) lines.push('', '**Submissions the reviewer did not score.** These are harness outcomes, not model failures, and carry no design score.', '', ...notes);
    lines.push('', '### Resource use and harness time', '', '| Candidate | Median wall | Model wait | Tool time | Grading | First delta | Tokens (in/out/cache read/write) | Billing / estimated USD |', '|---|---:|---:|---:|---:|---:|---|---|');
    for (const c of candidates) {
      const live = c.model.provider !== 'control';
      const evaluated = c.trials.filter(usable);
      const totals = c.trials.filter(t => t.tokens).reduce((s, t) => s.map((v, i) => v + Object.values(t.tokens!)[i]), [0, 0, 0, 0]);
      const count = c.trials.filter(t => t.tokens).length;
      const knownCost = c.trials.filter(t => t.estimatedCost !== null);
      const billing = [...new Set(c.trials.map(t => t.auth.billing))].join(', ') || 'not observed';
      const cost = billing === 'subscription' ? 'plan quota; USD n/a' : billing === 'control' ? 'synthetic; USD n/a' : knownCost.length ? `$${knownCost.reduce((s, t) => s + t.estimatedCost!, 0).toFixed(5)} estimate (${knownCost.length}/${c.trials.length} trials)` : 'USD unknown';
      lines.push(`| ${escape(c.label)} | ${live ? seconds(median(evaluated.map(t => t.wallMs))) : 'n/a'} | ${live ? seconds(median(evaluated.map(t => t.modelMs))) : 'n/a'} | ${seconds(median(evaluated.map(t => t.toolMs)))} | ${seconds(median(evaluated.map(t => t.gradeMs)))} | ${live ? seconds(median(evaluated.flatMap(t => t.firstTokenMs === null ? [] : [t.firstTokenMs]))) : 'n/a'} | ${count ? `${totals.join('/')} (${count}/${c.trials.length} observed)` : 'not reported'} | ${billing}; ${cost} |`);
    }
    lines.push('', 'Timing medians use evaluated trials only. Model wait includes auth, SDK and transport, not pure model inference. Wall includes setup/auth/model/tools/grading; stage medians need not add up. First delta includes reasoning/tool output, not necessarily first visible text. Error-attempt usage is retained when reported. Missing usage is never treated as zero. Estimates use Pi catalog rates, exclude plan fees, and are not invoices.', '', '### Matched-case observations', '');
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
            lines.push(`- **${escape(task.title)}**, repetition ${repetition}, \`${escape(check.id)}\` (${check.dimension}): ${escape(left.label)} ${check.passed ? 'passed' : 'failed'}; ${escape(right.label)} ${other.passed ? 'passed' : 'failed'}.`, `  - Left evidence: ${escape(check.evidence)}`, `  - Right evidence: ${escape(other.evidence)}`, `  - Artifacts: \`runs/${left.run.id}/trials/${l.id}/result.json\` · \`runs/${right.run.id}/trials/${r.id}/result.json\``);
          }
        }
      }
      lines.push('', `**${escape(left.label)} vs ${escape(right.label)}**: ${wins} correctness wins, ${losses} losses, ${ties} ties, ${unmatched} missing/censored pairs, ${dimensionNA} pairs without a correctness rubric. Only common task hashes and repetition indices with that dimension are paired.`, '');
    }
    if (!differences) lines.push('No differing matched checks observed (or fewer than two comparable candidates). This is not evidence of equivalence.', '');
    lines.push('### Per-task repeatability', '', '| Candidate / task | Correct repetitions | Observed rate |', '|---|---:|---:|');
    for (const c of candidates) for (const task of c.run.tasks) {
      const subset = c.trials.filter(t => t.task === task.id), score = correctness(subset);
      lines.push(`| ${escape(c.label)} / ${escape(task.id)} | ${score.passed}/${score.total} evaluated (${c.run.options.repeat} planned) | ${pct(score.rate)} |`);
    }
    lines.push('', 'Small, personalized samples support task-specific observations, not universal rankings. Repeats of one task are correlated; no false independent-trial confidence interval is supplied. Inspect mixed outcomes and collect more matched repetitions before drawing conclusions. Quality and instruction proxies are limited to the published rubric. No claim about hidden model reasoning is made.', '', '### Provenance and failures', '');
    for (const run of group) {
      lines.push(`- Run \`${run.id}\`: ${run.status}; ${run.trials.length}/${run.planned} recorded. Started ${run.created}. Saved manifest: \`runs/${run.id}/run.json\`.`);
      for (const model of run.models) lines.push(`  - ${escape(model.label)}: \`${escape(model.provider)}/${escape(model.model)}\`, thinking=${model.thinking}, auth=${model.auth}.`);
      for (const t of run.trials.filter(t => t.error)) lines.push(`  - \`${t.id}\` **${t.status}**: ${escape(t.error!)}`);
    }
    lines.push('', '### Failed-check evidence', '');
    let failures = 0;
    for (const c of candidates) for (const trial of c.trials.filter(usable)) for (const check of trial.checks.filter(x => !x.passed)) {
      failures++;
      lines.push(`- ${escape(c.label)} / \`${escape(trial.task)}\` repeat ${trial.repetition} / \`${escape(check.id)}\` (${check.dimension}): ${escape(check.evidence)}. Artifact: \`runs/${c.run.id}/trials/${trial.id}/result.json\`.`);
    }
    if (!failures) lines.push('No failed checks among evaluated trials. Missing/censored trials are not passing evidence.');
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
