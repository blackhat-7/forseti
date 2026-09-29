import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { authInfo, modelsFor } from './auth.ts';
import { runAgent, safeError } from './adapter.ts';
import { runClaudeCode } from './claudecode.ts';
import { files, inside, localDir, put } from './files.ts';
import { applicableDimensions, gradeSubmission, loadGrader, rejectArtifacts, validateChecks, type Agent, type Grader } from './grade.ts';
import { review as reviewSubmission, type JudgeCall, type Review } from './judge.ts';
import type { JudgeConfig, LiveEvent, ModelConfig, RunOptions, Task, Trial } from './types.ts';
import { loadWorldModule, openWorld, removeWorkspace, runCommand, worldSeed, worldWorkspace } from './world.ts';

/**
 * Everything that decides how one try runs. This file is part of the harness fingerprint; the
 * runner that schedules tries is not, so changing how tries are ordered or run side by side never
 * makes recorded tries incomparable. Grading lives in grade.ts, fingerprinted on its own.
 */
export { applicableDimensions, rejectArtifacts, validateChecks, type Agent } from './grade.ts';
/** The lane is the model's family: Claude models always run in Claude Code, everything else in the Pi agent. */
export const laneOf = (model: ModelConfig): Agent => (model.provider === 'claude-code' ? 'claude-code' : 'pi');
export function blankTrial(id: string, model: ModelConfig, task: Task, repetition: number, local = ''): Trial {
  return { id, model: model.id, task: task.id, repetition, status: 'passed', auth: authInfo(model, local), checks: [], wallMs: 0, modelMs: 0, toolMs: 0, gradeMs: 0, firstTokenMs: null, tokens: null, estimatedCost: null, trace: [], answer: '', files: {}, turns: 0 };
}
/** A task's own budget only ever raises the run's, so a big task is not censored by a default sized for small ones. */
export function taskBudget(options: RunOptions, task: Task): RunOptions {
  return { ...options, maxTurns: Math.max(options.maxTurns, task.turns ?? 0), timeout: Math.max(options.timeout, task.timeout ?? 0) };
}
/**
 * The try's stream as `live.jsonl` beside its workspace. Deltas are merged and written ten times a
 * second, so a fast model costs a few small appends rather than one per token.
 */
function liveLog(path: string) {
  const queue: LiveEvent[] = [];
  const flush = () => { if (queue.length) appendFileSync(path, queue.splice(0).map(e => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 }); };
  const timer = setInterval(flush, 100);
  return {
    emit(event: LiveEvent) {
      const last = queue.at(-1);
      if (last && 's' in last && last.k === event.k && 's' in event && event.k !== 'result') last.s += event.s;
      else queue.push({ ...event });
    },
    close() { clearInterval(timer); flush(); },
  };
}
export type Job = { model: ModelConfig; task: Task; repetition: number };
/** What a try needs from its run. Nothing here describes any other try. */
export type TrialContext = {
  runDir: string; snapshot: string; options: RunOptions; local: string; contexts: Record<string, number>;
  judge: JudgeConfig | null; judgeCall?: JudgeCall; signal: AbortSignal;
  /** Why this try must not call its provider, if an earlier try made that clear. */
  blocked(job: Job): string | undefined;
  notify(phase: string): void;
};
/**
 * One try, start to finish, in its own folder. The model sees only that folder: the fixture copied
 * in, nothing from any other try, so tries running side by side never know of each other.
 */
export async function runTrial(ctx: TrialContext, job: Job, id: string): Promise<Trial> {
  const { options, signal } = ctx, agent = laneOf(job.model), control = job.model.provider === 'control';
  const trial = blankTrial(id, job.model, job.task, job.repetition, ctx.local);
  const trialDir = localDir(ctx.runDir, `trials/${trial.id}`);
  const worldModule = job.task.world ? inside(ctx.snapshot, job.task.world) : undefined;
  // A world task's checkout lives in a folder named like one; its files are recorded with the try as usual.
  const work = worldModule ? worldWorkspace((await loadWorldModule(worldModule)).directory) : localDir(trialDir, 'public');
  const record = (event: unknown) => appendFileSync(inside(trialDir, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), event })}\n`, { mode: 0o600 });
  const live = liveLog(inside(trialDir, 'live.jsonl'));
  const start = performance.now();
  let deadline: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const budget = taskBudget(options, job.task);
    ctx.notify('preparing'); record({ type: 'started', model: job.model.id, task: job.task.id, repetition: job.repetition });
    for (const [path, text] of Object.entries(files(inside(ctx.snapshot, job.task.fixture)))) put(work, path, text);
    const blocked = ctx.blocked(job);
    if (signal.aborted) { trial.status = 'cancelled'; trial.error = 'Run cancelled before this trial'; }
    else if (blocked) { trial.status = 'skipped'; trial.error = blocked; }
    else if (!trial.auth.ready) { trial.status = 'auth_error'; trial.error = trial.auth.note; }
    else {
      const grader = await loadGrader(inside(ctx.snapshot, job.task.grader)) as Grader & {
        reference?: { files?: Record<string, string>; answer?: string; commands?: string[] | ((seed: number) => string[]) };
        baseline?: { files?: Record<string, string>; answer?: string; commands?: string[] | ((seed: number) => string[]) };
        review?: Review;
      };
      deadline = setTimeout(() => controller.abort(), budget.timeout * 1000);
      // The Claude Code lane's estate lives in its tool server's process, which leaves its report here.
      const reportPath = inside(trialDir, 'world.json');
      const seed = worldSeed(job.repetition);
      if (worldModule) record({ type: 'world', seed });
      const world = worldModule && (control || agent === 'pi') ? await openWorld(worldModule, work, seed) : undefined;
      if (control) {
        ctx.notify('applying synthetic control');
        const answer = job.model.model === 'reference' ? grader.reference : grader.baseline;
        if (!answer) throw new Error(`Missing ${job.model.model} control for ${job.task.id}`);
        for (const [path, content] of Object.entries(answer.files ?? {})) put(work, path, content);
        for (const command of (typeof answer.commands === 'function' ? answer.commands(seed) : answer.commands) ?? []) trial.trace.push({ tool: 'bash', args: { command }, ok: true, ms: 0, output: await runCommand(world!, command) });
        trial.answer = answer.answer ?? '';
      } else if (agent === 'claude-code') await runClaudeCode(work, trialDir, job.model, job.task, budget, trial, controller.signal, ctx.notify, record, live.emit, worldModule ? { module: worldModule, report: reportPath, seed } : undefined);
      else await runAgent(work, job.model, job.task, budget, trial, controller.signal, ctx.notify, record, modelsFor(job.model, ctx.local, ctx.contexts), live.emit, world);
      if (worldModule) trial.world = world ? world.report() : existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : (await openWorld(worldModule, work, seed)).report();
      if (controller.signal.aborted) {
        trial.status = signal.aborted ? 'cancelled' : 'timeout';
        trial.error = signal.aborted ? 'Cancelled by user' : `Trial deadline of ${budget.timeout}s exceeded; counted as unsolved`;
      }
      if (trial.status === 'failed') rejectArtifacts(trial, job.task, options.lane, control, trial.checks.map(c => c.evidence).join('; '), agent);
      try { trial.files = files(work); }
      catch (e) { rejectArtifacts(trial, job.task, options.lane, control, safeError(e), agent); }
      if (trial.status === 'passed' && !controller.signal.aborted) {
        ctx.notify('verifying hidden checks');
        const grading = performance.now();
        const checks = await gradeSubmission(grader, trial, options.lane, control, agent, work, controller.signal);
        trial.gradeMs = performance.now() - grading;
        if (controller.signal.aborted) { trial.status = signal.aborted ? 'cancelled' : 'timeout'; trial.error = 'Cancelled/deadline during grading'; }
        else { trial.checks = validateChecks(checks, applicableDimensions(job.task, options.lane, control, agent)); trial.status = trial.checks.every(c => c.passed) ? 'passed' : 'failed'; }
      }
      if (ctx.judge && ctx.judgeCall && job.task.dimensions.includes('design') && !controller.signal.aborted && ['passed', 'failed'].includes(trial.status)) {
        if (!grader.review) throw new Error(`${job.task.id} declares the design dimension but its grader exports no review rubric`);
        // Correctness gates the reviewer. Judging code that is already wrong would score the
        // elegance of a broken answer, and spends quota to do it.
        const wrong = trial.checks.filter(c => c.dimension === 'correctness' && !c.passed);
        if (wrong.length) trial.judgeNote = `Not reviewed: ${wrong.length} correctness check(s) failed first`;
        else {
          ctx.notify('reviewing design');
          const grading = performance.now();
          const { checks, note } = await reviewSubmission(ctx.judgeCall, ctx.judge, grader.review, trial.files, controller.signal);
          trial.gradeMs += performance.now() - grading;
          if (note) trial.judgeNote = note;
          if (checks.length) {
            trial.checks = validateChecks([...trial.checks, ...checks]);
            trial.status = trial.checks.every(c => c.passed) ? 'passed' : 'failed';
          }
          record({ type: 'review', checks, note });
        }
      }
    }
  } catch (error) {
    trial.status = controller.signal.aborted ? (signal.aborted ? 'cancelled' : 'timeout') : 'harness_error';
    trial.error = safeError(error);
  } finally {
    if (deadline) clearTimeout(deadline);
    if (worldModule) removeWorkspace(work);
    live.close();
    signal.removeEventListener('abort', cancel);
    controller.abort();
    trial.wallMs = performance.now() - start;
  }
  record({ type: 'finished', status: trial.status, checks: trial.checks, error: trial.error });
  return trial;
}
