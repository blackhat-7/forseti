import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { arch, platform, release } from 'node:os';
import { spawnSync } from 'node:child_process';
import { authInfo, catalogModels } from './auth.ts';
import { SYSTEM_PROMPT } from './adapter.ts';
import { claudeCodeArgs, claudeCodeBinary } from './claudecode.ts';
import { SCHEME, harnessFingerprint, taskFingerprint, trialClosure, canonical } from './fingerprint.ts';
import { loadSuite, selectedModels, validateOptions } from './config.ts';
import { MAX_ENTRIES, atomicJson, files, hash, inside, localDir, put } from './files.ts';
import { makeJudgeCall, type JudgeCall } from './judge.ts';
import { listLocalModels, LOCAL } from './local.ts';
import { SANDBOX, checkSandbox, pythonExecutable } from './sandbox.ts';
import { FINISHED, conditionsKey, modelKey, trialKey } from './report.ts';
import { laneOf, runTrial, type Job } from './trial.ts';
import type { Config, ModelConfig, Progress, Run, RunOptions, Task, Trial } from './types.ts';

export { applicableDimensions, blankTrial, laneOf, rejectArtifacts, taskBudget, validateChecks, type Agent } from './trial.ts';
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
/** Everything under src/ and the lockfile: saved with every run, so its fingerprint can be recomputed later. */
const harnessOf = (root: string) => ({ src: files(inside(root, 'src')), lock: readFileSync(inside(root, 'package-lock.json'), 'utf8') });
/** The try path as it executes, for tests and for anyone asking what a fingerprint covers. */
export function harnessFiles(root: string): Record<string, string> {
  const src = files(inside(root, 'src'));
  return Object.fromEntries(trialClosure(src).map(path => [path, canonical(path, src[path]!)]));
}
/** The current Claude Code release: it decides that lane's prompt and tools, so it is part of the model. */
function claudeVersion(): string {
  const binary = claudeCodeBinary();
  return /versions\/([\d.]+)/.exec(binary)?.[1] ?? spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim().split(/\s/)[0] ?? '';
}
function taskEntry(t: Task, contents: Record<string, string>): Run['tasks'][number] {
  return { id: t.id, title: t.title, capabilities: t.capabilities, tier: t.tier, turns: t.turns, timeout: t.timeout, hash: taskFingerprint(t, contents) };
}
/**
 * The conditions a try would run under now, with these options: the code, every task in the suite
 * and this machine. A run looks up what is already on record by it, and the leaderboard keeps only
 * tries recorded under it.
 */
export function conditionsNow(root: string, config: Config, options: RunOptions, pythonVersion?: string): Pick<Run, 'options' | 'tasks' | 'harnessHash' | 'environment' | 'judge'> {
  const { suite, contents } = loadSuite(root, config.suite);
  const version = pythonVersion ?? spawnSync(pythonExecutable(), ['-I', '-c', 'import platform; print(platform.python_version())'], { encoding: 'utf8' }).stdout.trim();
  return {
    options, harnessHash: (({ src, lock }) => harnessFingerprint(src, lock))(harnessOf(root)), judge: config.judge.enabled ? config.judge : null,
    environment: { os: `${platform()} ${release()} ${arch()}`, python: pythonExecutable(), pythonVersion: version, proxyConfigured: String(Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY)) },
    tasks: suite.tasks.map(t => taskEntry(t, contents)),
  };
}
/**
 * Runs jobs in schedule order, at most `limit` at a time. Tries on the local server go one at a
 * time whatever the limit: two models sharing one GPU would slow each other into their time limits,
 * which would score the hardware, not the model. A limit of 1 is the plain sequential run.
 */
export async function inParallel<J>(jobs: J[], limit: number, serial: (job: J) => boolean, run: (job: J, index: number) => Promise<void>): Promise<void> {
  const left = jobs.map((job, index) => ({ job, index }));
  let serialBusy = false;
  const waiting: (() => void)[] = [];
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = left.findIndex(x => !(serialBusy && serial(x.job)));
      if (next < 0) {
        if (!left.length) return;
        await new Promise<void>(resolve => waiting.push(resolve));
        continue;
      }
      const { job, index } = left.splice(next, 1)[0]!, alone = serial(job);
      if (alone) serialBusy = true;
      try { await run(job, index); }
      finally { if (alone) { serialBusy = false; for (const wake of waiting.splice(0)) wake(); } }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
}
export async function runBenchmark(root: string, config: Config, options: RunOptions, onProgress: (p: Progress) => void = () => {}, signal = new AbortController().signal, makeJudge: typeof makeJudgeCall = makeJudgeCall): Promise<Run> {
  validateOptions(options);
  const models = selectedModels(config, options.models);
  const { suite, dir, contents } = loadSuite(root, config.suite);
  if (options.tests?.some(id => !suite.tasks.some(t => t.id === id))) throw new Error('Unknown test selection');
  const tasks = suite.tasks.filter(t => options.tests ? options.tests.includes(t.id) : !config.disabledTests.includes(t.id) && !config.removedTests.includes(t.id));
  if (!tasks.length) throw new Error('Enable at least one test');
  const lanes = new Set(models.filter(m => m.provider !== 'control').map(laneOf));
  for (const model of models) {
    const auth = authInfo(model, config.local.url);
    if (auth.ready && ['metered', 'unknown'].includes(auth.billing) && !options.allowMetered) throw new Error(`${model.label}: ${auth.billing} billing. Review costs and rerun with --allow-metered to consent. No calls made.`);
    if (!['control', 'claude-code', LOCAL].includes(model.provider) && !catalogModels.getModel(model.provider, model.model)) throw new Error(`Unknown model ${model.provider}/${model.model}`);
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
    // Read once per run: the local server's real context size, recorded below with the model.
    const contexts: Record<string, number> = models.some(m => m.provider === LOCAL)
      ? Object.fromEntries((await listLocalModels(config.local.url)).flatMap(m => (m.contextWindow ? [[m.id, m.contextWindow]] : []))) : {};
    const harness = harnessOf(root), now = conditionsNow(root, config, options, pythonVersion);
    const taskEntries = tasks.map(t => now.tasks.find(e => e.id === t.id)!);
    // Each model runs in its own family's lane, so one run can hold both; a model's client flags are those of its lane.
    const environment = { node: process.version, ...now.environment, sandbox: SANDBOX, pi: '0.85.1', agent: lanes.size > 1 ? 'mixed' : lanes.has('claude-code') ? 'claude-code' : 'pi',
      claudeFlags: claudeCodeArgs('MODEL', options.maxTurns).join(' '), piFlags: 'pi-agent-core 0.85.1', ...(lanes.has('claude-code') ? { claudeVersion: claudeVersion() } : {}), catalog: JSON.stringify(models.map(m => m.provider === 'control' ? { control: m.model } : m.provider === 'claude-code' ? { claudeCode: m.model } : m.provider === LOCAL ? { local: m.model, url: config.local.url, contextWindow: contexts[m.model] ?? null } : catalogModels.getModel(m.provider, m.model))) };
    // Only the tries not already on record under these exact conditions are run; see trialKey.
    const draft = { ...now, tasks: taskEntries, environment };
    const done = new Map<string, number>();
    if (!options.fresh) for (const past of listRuns(root)) for (const t of past.trials) {
      if (!FINISHED.includes(t.status) || !past.tasks.some(x => x.id === t.task) || !past.models.some(m => m.id === t.model)) continue;
      const key = trialKey(past, t);
      done.set(key, (done.get(key) ?? 0) + 1);
    }
    const jobs = schedule(models, tasks, options.repeat, options.seed)
      .filter(j => j.model.provider === 'control' || j.repetition > (done.get(`${modelKey(draft, j.model)} ${conditionsKey(draft, j.task.id)}`) ?? 0));
    if (!jobs.length) throw new Error(`Nothing to run: every selected model already has ${options.repeat} finished tries of every selected task under these exact conditions. See the leaderboard, or pass --fresh to run them again.`);
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    writeFileSync(lock, JSON.stringify({ pid: process.pid, runId: id }));
    const runDir = localDir(root, `runs/${id}`);
    const snapshot = localDir(runDir, 'suite');
    for (const [path, text] of Object.entries(contents)) put(snapshot, path, text);
    for (const task of suite.tasks) localDir(snapshot, task.fixture);
    const harnessDir = localDir(runDir, 'harness');
    for (const [path, text] of Object.entries(harness.src)) put(harnessDir, `src/${path}`, text);
    put(harnessDir, 'package-lock.json', harness.lock);
    put(harnessDir, 'package.json', readFileSync(inside(root, 'package.json'), 'utf8'));
    const run: Run = {
      schema: 1, id, created: new Date().toISOString(), status: 'running', suite: suite.id,
      suiteHash: hash(contents), harnessHash: draft.harnessHash, environment, judge,
      options, models, tasks: taskEntries, planned: jobs.length, trials: [],
    };
    atomicJson(runDir, 'run.json', run);
    atomicJson(runDir, 'experiment.json', { system: SYSTEM_PROMPT, config, options, schedule: jobs.map(j => ({ model: j.model.id, task: j.task.id, repetition: j.repetition })), harnessHash: run.harnessHash, suiteHash: run.suiteHash });
    const blockedProviders = new Map<string, string>();
    const blockedModels = new Map<string, string>();
    const ctx = { runDir, snapshot, options, local: config.local.url, contexts, judge, judgeCall, signal,
      blocked: (job: Job) => blockedProviders.get(job.model.provider) ?? blockedModels.get(job.model.id) };
    await inParallel(jobs, options.parallel ?? 1, job => job.model.provider === LOCAL, async (job, i) => {
      const notify = (phase: string) => onProgress({ completed: run.trials.length, total: jobs.length, task: job.task.title, model: job.model.label, phase, runId: id });
      const trial: Trial = await runTrial({ ...ctx, notify }, job, `${String(i + 1).padStart(4, '0')}-${job.model.id}-${job.task.id}`);
      if (['auth_error', 'rate_limited'].includes(trial.status)) blockedProviders.set(job.model.provider, `${trial.status} in ${trial.id}; no retries, account switching or paid fallback. ${trial.error}`);
      if (trial.status === 'provider_error') blockedModels.set(job.model.id, `Provider rejected/failed ${trial.id}; remaining trials for this model are skipped. ${trial.error}`);
      atomicJson(inside(runDir, `trials/${trial.id}`), 'result.json', trial);
      run.trials.push(trial);
      atomicJson(runDir, 'run.json', run);
      onProgress({ completed: run.trials.length, total: jobs.length, task: job.task.title, model: job.model.label, phase: trial.status, runId: id });
    });
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
  // Claude Code's first log line names the model behind the alias; the try's log keeps it.
  for (const trial of run.trials) {
    if (trial.served || !run.models.some(m => m.id === trial.model && m.provider === 'claude-code')) continue;
    try { trial.served = /\\"model\\":\\"(claude-[a-z0-9-]+)\\"/.exec(readFileSync(inside(root, `runs/${id}/trials/${trial.id}/events.jsonl`), 'utf8'))?.[1]; } catch { /* no log, no name */ }
  }
  refingerprint(root, run);
  return run;
}
/**
 * Replaces a run's recorded fingerprints with ones recomputed, by the current scheme, from the code
 * and suite the run saved, and caches them beside it. So a better fingerprint never strands an old
 * run, and two runs whose code differs only in comments still compare. Older runs also learn which
 * Claude Code release ran them, from the binary path their trials logged.
 */
function refingerprint(root: string, run: Run): void {
  const dir = inside(root, `runs/${run.id}`), cachePath = inside(dir, 'fingerprint.json');
  type Cache = { scheme: number; harness: string; tasks: Record<string, string>; claudeVersion?: string };
  let cache: Cache | undefined;
  try { cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Cache; } catch { /* Not computed yet. */ }
  if (cache?.scheme !== SCHEME) {
    const at = (path: string) => inside(dir, path);
    if (!existsSync(at('harness/src')) || !existsSync(at('harness/package-lock.json')) || !existsSync(at('suite/suite.json'))) return;
    const suite = files(at('suite'), MAX_ENTRIES), definitions = (JSON.parse(suite['suite.json']!) as { tasks: Task[] }).tasks;
    const logged = run.models.some(m => m.provider === 'claude-code') && !run.environment.claudeVersion && existsSync(at('trials'))
      ? readdirSync(at('trials')).map(t => { try { return /versions\/([\d.]+)/.exec(readFileSync(at(`trials/${t}/events.jsonl`), 'utf8'))?.[1]; } catch { return undefined; } }).find(Boolean) : undefined;
    cache = {
      scheme: SCHEME, harness: harnessFingerprint(files(at('harness/src')), readFileSync(at('harness/package-lock.json'), 'utf8')),
      tasks: Object.fromEntries(run.tasks.map(t => { const d = definitions.find(x => x.id === t.id); return [t.id, d ? taskFingerprint(d, suite) : t.hash]; })),
      ...(logged ? { claudeVersion: logged } : {}),
    };
    // A running run's trials may not have logged yet; its fingerprints are fixed, so only the version waits.
    if (run.status !== 'running' || !run.models.some(m => m.provider === 'claude-code') || run.environment.claudeVersion) try { writeFileSync(cachePath, JSON.stringify(cache)); } catch { /* Read-only is fine. */ }
  }
  run.harnessHash = cache.harness;
  for (const t of run.tasks) t.hash = cache.tasks[t.id] ?? t.hash;
  if (cache.claudeVersion && !run.environment.claudeVersion) run.environment.claudeVersion = cache.claudeVersion;
}
export function listRuns(root: string): Run[] {
  const base = inside(root, 'runs');
  if (!existsSync(base)) return [];
  const active = activeRunId(root);
  return readdirSync(base).sort().reverse().flatMap(id => readRun(root, id, active) ?? []);
}
