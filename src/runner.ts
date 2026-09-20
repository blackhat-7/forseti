import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { authInfo, catalogModels } from './auth.ts';
import { runAgent, safeError, SYSTEM_PROMPT } from './adapter.ts';
import { claudeCodeArgs, runClaudeCode } from './claudecode.ts';
import { DIMENSIONS, loadSuite, selectedModels, validateOptions } from './config.ts';
import { atomicJson, files, hash, inside, localDir, put } from './files.ts';
import { makeJudgeCall, review as reviewSubmission, type JudgeCall, type Review } from './judge.ts';
import { checkSandbox, pythonExecutable, runPython } from './sandbox.ts';
import type { Check, Config, Dimension, GradeContext, ModelConfig, Progress, Run, RunOptions, Task, Trial } from './types.ts';

export function schedule(models: ModelConfig[], tasks: Task[], repeat: number, seed: number) {
  const jobs = [];
  for (let r = 1; r <= repeat; r++) for (const task of tasks) for (const model of models) jobs.push({ model, task, repetition: r });
  let state = seed >>> 0;
  for (let i = jobs.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = Math.floor((state / 4294967296) * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
  }
  return jobs;
}
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
 * What the deterministic grader must produce. The suite's tool rubric names Forseti's own tools,
 * so it cannot grade another harness's trace: controls, the prompt lane and the Claude Code
 * harness therefore carry no tool checks. `design` never appears here because it comes from the
 * reviewer model, which runs after grading and is appended separately.
 */
export function applicableDimensions(task: Task, lane: RunOptions['lane'], control: boolean, agent: Agent = 'pi'): Dimension[] {
  return task.dimensions.filter(d => d !== 'design' && (d !== 'tools' || (lane === 'tools' && !control && agent === 'pi')));
}
export type Agent = 'pi' | 'claude-code';
export function agentOf(models: ModelConfig[]): Agent {
  const claudeCode = models.filter(m => m.provider === 'claude-code');
  if (!claudeCode.length) return 'pi';
  if (claudeCode.length !== models.filter(m => m.provider !== 'control').length) {
    throw new Error('A run cannot mix Claude Code with Pi-adapter providers: they are different harnesses, so the comparison would measure the harness, not the model. Run them separately.');
  }
  return 'claude-code';
}
export function rejectArtifacts(trial: Trial, task: Task, lane: RunOptions['lane'], control: boolean, reason: string, agent: Agent = 'pi'): void {
  trial.error = [trial.error, `Invalid submission: ${reason}`].filter(Boolean).join('; ');
  if (!['passed', 'failed'].includes(trial.status)) return;
  trial.status = 'failed';
  trial.checks = applicableDimensions(task, lane, control, agent).map(dimension => ({ id: `invalid-submission-${dimension}`, dimension, passed: false, evidence: `Submission rejected before grading: ${reason}` }));
}
export function blankTrial(id: string, model: ModelConfig, task: Task, repetition: number): Trial {
  return { id, model: model.id, task: task.id, repetition, status: 'passed', auth: authInfo(model), checks: [], wallMs: 0, modelMs: 0, toolMs: 0, gradeMs: 0, firstTokenMs: null, tokens: null, estimatedCost: null, trace: [], answer: '', files: {}, turns: 0 };
}
/**
 * The harness is what ran the trial. report.ts and tui.ts only read finished trials, and every
 * run in a comparison group is rendered by the same current copy of them, so a change there cannot
 * make two runs incomparable. Hashing them once stranded paid-for runs behind a wording fix.
 */
const RENDER_ONLY = new Set(['report.ts', 'tui.ts']);
export function harnessFiles(root: string): Record<string, string> {
  return Object.fromEntries(Object.entries(files(inside(root, 'src'))).filter(([path]) => !RENDER_ONLY.has(path)));
}
export async function runBenchmark(root: string, config: Config, options: RunOptions, onProgress: (p: Progress) => void = () => {}, signal = new AbortController().signal, makeJudge: typeof makeJudgeCall = makeJudgeCall): Promise<Run> {
  validateOptions(options);
  const models = selectedModels(config, options.models);
  const { suite, dir, contents } = loadSuite(root, config.suite);
  if (options.tests?.some(id => !suite.tasks.some(t => t.id === id))) throw new Error('Unknown test selection');
  const tasks = suite.tasks.filter(t => options.tests ? options.tests.includes(t.id) : !config.disabledTests.includes(t.id) && !config.removedTests.includes(t.id));
  if (!tasks.length) throw new Error('Enable at least one test');
  const agent = agentOf(models);
  for (const model of models) {
    const auth = authInfo(model);
    if (auth.ready && ['metered', 'unknown'].includes(auth.billing) && !options.allowMetered) throw new Error(`${model.label}: ${auth.billing} billing. Review costs and rerun with --allow-metered to consent. No calls made.`);
    if (!['control', 'claude-code'].includes(model.provider) && !catalogModels.getModel(model.provider, model.model)) throw new Error(`Unknown model ${model.provider}/${model.model}`);
  }
  // Resolved before any trial: a reviewer that cannot run must stop the run, not silently
  // degrade every design score to "not judged" after the quota has already been spent.
  const judge = config.judge.enabled ? config.judge : null;
  let judgeCall: JudgeCall | undefined;
  if (judge) {
    const auth = authInfo({ provider: judge.provider, auth: judge.auth });
    if (!auth.ready) throw new Error(`Reviewer ${judge.provider}/${judge.model}: ${auth.note}`);
    if (['metered', 'unknown'].includes(auth.billing) && !options.allowMetered) throw new Error(`Reviewer ${judge.provider}/${judge.model}: ${auth.billing} billing. Review costs and rerun with --allow-metered to consent. No calls made.`);
    judgeCall = makeJudge(judge, options.timeout * 1000, localDir(root, '.state/judge'));
  }
  localDir(root, '.state');
  const lockPath = inside(root, '.state/run.lock');
  let lock: number;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch { throw new Error('Run lock exists. Another run may be active. If it crashed, inspect .state/run.lock and its PID before removing that local file.'); }
  try {
    const pythonVersion = await checkSandbox(root);
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    writeFileSync(lock, JSON.stringify({ pid: process.pid, runId: id }));
    const runDir = localDir(root, `runs/${id}`);
    const snapshot = localDir(runDir, 'suite');
    for (const [path, text] of Object.entries(contents)) put(snapshot, path, text);
    for (const task of suite.tasks) localDir(snapshot, task.fixture);
    const jobs = schedule(models, tasks, options.repeat, options.seed);
    const harness = { src: harnessFiles(root), lock: readFileSync(inside(root, 'package-lock.json'), 'utf8'), system: SYSTEM_PROMPT };
    const harnessDir = localDir(runDir, 'harness');
    for (const [path, text] of Object.entries(harness.src)) put(harnessDir, `src/${path}`, text);
    put(harnessDir, 'package-lock.json', harness.lock);
    put(harnessDir, 'package.json', readFileSync(inside(root, 'package.json'), 'utf8'));
    const run: Run = {
      schema: 1, id, created: new Date().toISOString(), status: 'running', suite: suite.id,
      suiteHash: hash(contents), harnessHash: hash(harness),
      environment: { node: process.version, python: pythonExecutable(), pythonVersion, proxyConfigured: String(Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY)), os: `${platform()} ${release()} ${arch()}`, sandbox: 'macOS Seatbelt; deny default; no network/fork; public trial only', pi: '0.85.1', agent, agentFlags: agent === 'claude-code' ? claudeCodeArgs('MODEL', options.maxTurns).join(' ') : 'pi-agent-core 0.85.1', catalog: JSON.stringify(models.map(m => m.provider === 'control' ? { control: m.model } : m.provider === 'claude-code' ? { claudeCode: m.model } : catalogModels.getModel(m.provider, m.model))) },
      judge,
      options, models, tasks: tasks.map(t => ({ id: t.id, title: t.title, capabilities: t.capabilities, hash: hash({ task: t, fixture: files(inside(dir, t.fixture)), private: Object.entries(contents).filter(([p]) => p.startsWith('private/')) }) })), planned: jobs.length, trials: [],
    };
    atomicJson(runDir, 'run.json', run);
    atomicJson(runDir, 'experiment.json', { system: SYSTEM_PROMPT, config, options, schedule: jobs.map(j => ({ model: j.model.id, task: j.task.id, repetition: j.repetition })), harnessHash: run.harnessHash, suiteHash: run.suiteHash });
    const blockedProviders = new Map<string, string>();
    const blockedModels = new Map<string, string>();
    for (const [i, job] of jobs.entries()) {
      const trial = blankTrial(`${String(i + 1).padStart(4, '0')}-${job.model.id}-${job.task.id}`, job.model, job.task, job.repetition);
      const trialDir = localDir(runDir, `trials/${trial.id}`);
      const work = localDir(trialDir, 'public');
      const notify = (phase: string) => onProgress({ completed: i, total: jobs.length, task: job.task.title, model: job.model.label, phase, runId: id });
      const record = (event: unknown) => appendFileSync(inside(trialDir, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), event })}\n`, { mode: 0o600 });
      const start = performance.now();
      let deadline: NodeJS.Timeout | undefined;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        notify('preparing'); record({ type: 'started', model: job.model.id, task: job.task.id, repetition: job.repetition });
        for (const [path, text] of Object.entries(files(inside(snapshot, job.task.fixture)))) put(work, path, text);
        if (signal.aborted) { trial.status = 'cancelled'; trial.error = 'Run cancelled before this trial'; }
        else if (blockedProviders.has(job.model.provider)) { trial.status = 'skipped'; trial.error = blockedProviders.get(job.model.provider); }
        else if (blockedModels.has(job.model.id)) { trial.status = 'skipped'; trial.error = blockedModels.get(job.model.id); }
        else if (!trial.auth.ready) { trial.status = 'auth_error'; trial.error = trial.auth.note; }
        else {
          const grader = await import(pathToFileURL(inside(snapshot, job.task.grader)).href) as {
            grade(context: GradeContext): Promise<Check[]>;
            reference?: { files?: Record<string, string>; answer?: string };
            baseline?: { files?: Record<string, string>; answer?: string };
            review?: Review;
          };
          deadline = setTimeout(() => controller.abort(), options.timeout * 1000);
          if (job.model.provider === 'control') {
            notify('applying synthetic control');
            const control = job.model.model === 'reference' ? grader.reference : grader.baseline;
            if (!control) throw new Error(`Missing ${job.model.model} control for ${job.task.id}`);
            for (const [path, content] of Object.entries(control.files ?? {})) put(work, path, content);
            trial.answer = control.answer ?? '';
          } else if (job.model.provider === 'claude-code') await runClaudeCode(work, job.model, job.task, options, trial, controller.signal, notify, record);
          else await runAgent(work, job.model, job.task, options, trial, controller.signal, notify, record);
          if (controller.signal.aborted) {
            trial.status = signal.aborted ? 'cancelled' : 'timeout';
            trial.error = signal.aborted ? 'Cancelled by user' : `Trial deadline of ${options.timeout}s exceeded; outcome censored`;
          }
          if (trial.status === 'failed') rejectArtifacts(trial, job.task, options.lane, job.model.provider === 'control', trial.checks.map(c => c.evidence).join('; '), agent);
          try { trial.files = files(work); }
          catch (e) { rejectArtifacts(trial, job.task, options.lane, job.model.provider === 'control', safeError(e), agent); }
          if (trial.status === 'passed' && !controller.signal.aborted) {
            notify('verifying hidden checks');
            const grading = performance.now();
            const checks = await grader.grade({ lane: options.lane, control: job.model.provider === 'control', agent, answer: trial.answer, files: trial.files, trace: trial.trace, python: source => runPython(work, source, controller.signal, 5000, true) });
            trial.gradeMs = performance.now() - grading;
            if (controller.signal.aborted) { trial.status = signal.aborted ? 'cancelled' : 'timeout'; trial.error = 'Cancelled/deadline during grading'; }
            else { trial.checks = validateChecks(checks, applicableDimensions(job.task, options.lane, job.model.provider === 'control', agent)); trial.status = trial.checks.every(c => c.passed) ? 'passed' : 'failed'; }
          }
          if (judge && judgeCall && job.task.dimensions.includes('design') && !controller.signal.aborted && ['passed', 'failed'].includes(trial.status)) {
            if (!grader.review) throw new Error(`${job.task.id} declares the design dimension but its grader exports no review rubric`);
            // Correctness gates the reviewer. Judging code that is already wrong would score the
            // elegance of a broken answer, and spends quota to do it.
            const wrong = trial.checks.filter(c => c.dimension === 'correctness' && !c.passed);
            if (wrong.length) trial.judgeNote = `Not reviewed: ${wrong.length} correctness check(s) failed first`;
            else {
              notify('reviewing design');
              const grading = performance.now();
              const { checks, note } = await reviewSubmission(judgeCall, judge, grader.review, trial.files, controller.signal);
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
      if (['auth_error', 'rate_limited'].includes(trial.status)) blockedProviders.set(job.model.provider, `${trial.status} in ${trial.id}; no retries, account switching or paid fallback. ${trial.error}`);
      if (trial.status === 'provider_error') blockedModels.set(job.model.id, `Provider rejected/failed ${trial.id}; remaining trials for this model are skipped. ${trial.error}`);
      record({ type: 'finished', status: trial.status, checks: trial.checks, error: trial.error });
      atomicJson(trialDir, 'result.json', trial);
      run.trials.push(trial);
      atomicJson(runDir, 'run.json', run);
      onProgress({ completed: i + 1, total: jobs.length, task: job.task.title, model: job.model.label, phase: trial.status, runId: id });
    }
    run.status = signal.aborted ? 'cancelled' : 'completed'; run.finished = new Date().toISOString();
    atomicJson(runDir, 'run.json', run);
    return run;
  } finally {
    // Releasing the lock must never discard a finished run. Every trial and the manifest are
    // already on disk by this point, so a lock that something else removed first is a tidiness
    // problem, not a reason to report the whole run as stopped.
    try { closeSync(lock); } catch { /* Already closed. */ }
    rmSync(lockPath, { force: true });
  }
}
/** The run whose process is still alive. Anything else claiming to be running was interrupted. */
export function activeRunId(root: string): string | undefined {
  try {
    const lock = JSON.parse(readFileSync(inside(root, '.state/run.lock'), 'utf8'));
    process.kill(lock.pid, 0);
    return lock.runId;
  } catch { return undefined; }
}
/**
 * One manifest. The runner rewrites it after every trial, so reading it mid-run is how a live
 * run stays visible without re-parsing the whole history on each update.
 */
export function readRun(root: string, id: string, active = activeRunId(root)): Run | undefined {
  const path = inside(root, `runs/${id}/run.json`);
  if (!existsSync(path)) return undefined;
  const run: Run = JSON.parse(readFileSync(path, 'utf8'));
  if (run.schema !== 1 || !Array.isArray(run.trials)) throw new Error(`Invalid run manifest: ${id}`);
  // `quality` was renamed to `hygiene` on 2026-09-18. Identical checks, so mapping on read is
  // truthful and keeps older runs readable; the file on disk is left exactly as it was recorded.
  for (const trial of run.trials) {
    for (const check of trial.checks) if ((check.dimension as string) === 'quality') check.dimension = 'hygiene';
  }
  if (run.status === 'running' && run.id !== active) run.status = 'interrupted';
  return run;
}
export function listRuns(root: string): Run[] {
  const base = inside(root, 'runs');
  if (!existsSync(base)) return [];
  const active = activeRunId(root);
  return readdirSync(base).sort().reverse().flatMap(id => readRun(root, id, active) ?? []);
}
