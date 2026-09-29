import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { authInfo, modelsFor } from './auth.ts';
import { runAgent, safeError } from './adapter.ts';
import { runClaudeCode } from './claudecode.ts';
import { DIMENSIONS } from './config.ts';
import { files, inside, localDir, put } from './files.ts';
import { review as reviewSubmission, type JudgeCall, type Review } from './judge.ts';
import { runPython } from './sandbox.ts';
import type { Check, Dimension, GradeContext, JudgeConfig, ModelConfig, RunOptions, Task, Trial } from './types.ts';

/**
 * Everything that decides how one try runs and how it is graded. This file is part of the harness
 * fingerprint; the runner that schedules tries is not, so changing how tries are ordered or run
 * side by side never makes recorded tries incomparable.
 */
export type Agent = 'pi' | 'claude-code';
/** The lane is the model's family: Claude models always run in Claude Code, everything else in the Pi agent. */
export const laneOf = (model: ModelConfig): Agent => (model.provider === 'claude-code' ? 'claude-code' : 'pi');
export function validateChecks(checks: unknown, dimensions?: Dimension[]): Check[] {
  if (!Array.isArray(checks) || !checks.length || checks.length > 100) throw new Error('Grader must return 1–100 checks');
  const ids = new Set<string>();
  for (const c of checks) {
    if (!c || typeof c.id !== 'string' || ids.has(c.id) || !DIMENSIONS.includes(c.dimension) || typeof c.passed !== 'boolean' || typeof c.evidence !== 'string' || c.evidence.length > 8000) throw new Error('Invalid/duplicate grader check');
    ids.add(c.id);
  }
  if (dimensions && (dimensions.some(d => !checks.some(c => c.dimension === d)) || checks.some(c => !dimensions.includes(c.dimension)))) throw new Error('Grader output does not match the declared task dimensions for this lane');
  return checks;
}
/**
 * What the deterministic grader must produce. The tool rubric names Forseti's own file tools, so
 * it grades the Pi lane only: the Claude Code lane reads and writes with its own, which Forseti
 * cannot observe. That is a process check, not a capability one — both lanes can run code, so
 * correctness stays comparable. `design` never appears here because it comes from the reviewer
 * model, which runs after grading and is appended separately.
 */
export function applicableDimensions(task: Task, lane: RunOptions['lane'], control: boolean, agent: Agent = 'pi'): Dimension[] {
  return task.dimensions.filter(d => d !== 'design' && (d !== 'tools' || (lane === 'tools' && !control && agent === 'pi')));
}
export function rejectArtifacts(trial: Trial, task: Task, lane: RunOptions['lane'], control: boolean, reason: string, agent: Agent = 'pi'): void {
  trial.error = [trial.error, `Invalid submission: ${reason}`].filter(Boolean).join('; ');
  if (!['passed', 'failed'].includes(trial.status)) return;
  trial.status = 'failed';
  trial.checks = applicableDimensions(task, lane, control, agent).map(dimension => ({ id: `invalid-submission-${dimension}`, dimension, passed: false, evidence: `Submission rejected before grading: ${reason}` }));
}
export function blankTrial(id: string, model: ModelConfig, task: Task, repetition: number, local = ''): Trial {
  return { id, model: model.id, task: task.id, repetition, status: 'passed', auth: authInfo(model, local), checks: [], wallMs: 0, modelMs: 0, toolMs: 0, gradeMs: 0, firstTokenMs: null, tokens: null, estimatedCost: null, trace: [], answer: '', files: {}, turns: 0 };
}
/** A task's own budget only ever raises the run's, so a big task is not censored by a default sized for small ones. */
export function taskBudget(options: RunOptions, task: Task): RunOptions {
  return { ...options, maxTurns: Math.max(options.maxTurns, task.turns ?? 0), timeout: Math.max(options.timeout, task.timeout ?? 0) };
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
  const work = localDir(trialDir, 'public');
  const record = (event: unknown) => appendFileSync(inside(trialDir, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), event })}\n`, { mode: 0o600 });
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
      const grader = await import(pathToFileURL(inside(ctx.snapshot, job.task.grader)).href) as {
        grade(context: GradeContext): Promise<Check[]>;
        reference?: { files?: Record<string, string>; answer?: string };
        baseline?: { files?: Record<string, string>; answer?: string };
        review?: Review;
      };
      deadline = setTimeout(() => controller.abort(), budget.timeout * 1000);
      if (control) {
        ctx.notify('applying synthetic control');
        const answer = job.model.model === 'reference' ? grader.reference : grader.baseline;
        if (!answer) throw new Error(`Missing ${job.model.model} control for ${job.task.id}`);
        for (const [path, content] of Object.entries(answer.files ?? {})) put(work, path, content);
        trial.answer = answer.answer ?? '';
      } else if (agent === 'claude-code') await runClaudeCode(work, trialDir, job.model, job.task, budget, trial, controller.signal, ctx.notify, record);
      else await runAgent(work, job.model, job.task, budget, trial, controller.signal, ctx.notify, record, modelsFor(job.model, ctx.local, ctx.contexts));
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
        const checks = await grader.grade({ lane: options.lane, control, agent, answer: trial.answer, files: trial.files, trace: trial.trace, python: source => runPython(work, source, controller.signal, 5000, true) });
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
    signal.removeEventListener('abort', cancel);
    controller.abort();
    trial.wallMs = performance.now() - start;
  }
  record({ type: 'finished', status: trial.status, checks: trial.checks, error: trial.error });
  return trial;
}
