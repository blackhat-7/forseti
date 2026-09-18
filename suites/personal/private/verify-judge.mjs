/**
 * Tests the reviewer, the way every other grader in this suite is tested.
 *
 * A judge you cannot validate is an opinion. This script turns "is the reviewer any good?" into
 * two numbers you can read before trusting a single design score:
 *
 *   1. Agreement  - how often the reviewer reproduces the recorded standard on labelled cases.
 *   2. Restraint  - how often it claims a defect that is not there. The standard is explicit
 *                   that inventing work is itself a failure, so this is reported separately
 *                   from missed defects rather than averaged away.
 *
 * With `--run <runId>` it instead measures self-preference: the same submissions are reviewed by
 * the configured judge and by an alternate from a different family, and the defect rates are
 * split by the family that authored the code. A judge that is soft on its own relatives shows up
 * as a gap between the two columns. That is the measured number for this setup, not one quoted
 * from a paper.
 *
 * Live model calls. Run it deliberately: npm run test:judge
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../../src/config.ts';
import { authInfo } from '../../../src/auth.ts';
import { makeJudgeCall, review, judgeIdentity } from '../../../src/judge.ts';
import { fixture } from './helpers.mjs';

const suiteDir = fileURLToPath(new URL('../', import.meta.url));
const root = join(suiteDir, '..', '..');
const tmp = join(suiteDir, 'private', '.tmp');
mkdirSync(tmp, { recursive: true });

const config = loadConfig(root);
const signal = new AbortController().signal;
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const named = spec => {
  const provider = spec.slice(0, spec.indexOf('/'));
  return { provider, model: spec.slice(spec.indexOf('/') + 1), ...(provider === 'claude-code' ? { auth: 'cli' } : {}) };
};
// `--judge <provider>/<model>` compares a reviewer without editing the saved settings.
const override = flag('--judge');
const judge = { ...config.judge, enabled: true, ...(override ? named(override) : {}) };
const auth = authInfo({ provider: judge.provider, auth: judge.auth });
assert(auth.ready, `Reviewer ${judge.provider}/${judge.model} is not usable: ${auth.note}`);

function pythonIn(dir) {
  return async source => {
    const run = spawnSync('python3', ['-B', '-c', source], {
      cwd: dir, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', TMPDIR: tmp },
    });
    return { stdout: run.stdout || '', stderr: run.stderr || '', code: run.status, timedOut: run.error?.code === 'ETIMEDOUT' };
  };
}
async function inSandbox(files, fn) {
  const dir = mkdtempSync(join(tmp, 'judge-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      assert(!path.includes('/') && !path.includes('\\') && path !== '..');
      writeFileSync(join(dir, path), text);
    }
    return await fn(pythonIn(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const pct = (n, d) => d ? `${((n / d) * 100).toFixed(0)}%` : 'n/a';

const scratch = join(root, '.state', 'judge');
mkdirSync(scratch, { recursive: true });
const call = makeJudgeCall(judge, 180_000, scratch);
console.log(`Reviewer: ${judge.provider}/${judge.model} · thinking ${judge.thinking} · ${judge.repeat} round(s) · identity ${judgeIdentity(judge).slice(0, 12)}\n`);

const runId = flag('--run');
if (!runId) {
  // ---- Calibration gate -------------------------------------------------------------------
  const dir = new URL('./calibration/', import.meta.url);
  const sets = existsSync(fileURLToPath(dir)) ? readdirSync(fileURLToPath(dir)).filter(f => f.endsWith('.mjs')) : [];
  assert(sets.length, 'No calibration sets found');
  let agreed = 0, total = 0, falseDefect = 0, missedDefect = 0, cleanCases = 0;
  const rows = [];
  for (const file of sets) {
    const { task, cases } = await import(new URL(file, dir));
    const grader = await import(new URL(`./${task}.mjs`, import.meta.url));
    assert(grader.review, `${task}: no review rubric`);
    for (const kase of cases) {
      const files = { ...fixture(task), ...kase.files };
      // A calibration case that is behaviourally wrong would train the reviewer on the wrong
      // thing, because correctness gates the reviewer in a real run.
      const checks = await inSandbox(files, python => grader.grade({ files, python, trace: [], lane: 'tools', control: true }));
      const broken = checks.filter(c => c.dimension === 'correctness' && !c.passed);
      assert(!broken.length, `${task}/${kase.id} is not behaviourally correct: ${JSON.stringify(broken.map(c => c.id))}`);

      const { checks: design, note } = await review(call, judge, grader.review, files, signal);
      // The reviewer being unreachable is a harness problem, not a disagreement. Say so plainly
      // rather than reporting it as a calibration miss.
      if (note) { console.error(`\nReviewer could not be used: ${note}`); console.error(`Fix the reviewer (log in again in Pi, or pick another with --judge <provider>/<model>) and rerun. Nothing was scored.`); process.exit(2); }
      const wrong = [];
      for (const item of grader.review.items) {
        const expectDefect = kase.labels[item.id];
        assert(typeof expectDefect === 'boolean', `${task}/${kase.id}: no label for ${item.id}`);
        const check = design.find(c => c.id === `design-${item.id}`);
        const got = !check.passed;
        total++;
        if (got === expectDefect) agreed++;
        else {
          // "Said clean" has two very different causes: the reviewer saw nothing, or it saw
          // something and the citation check threw the evidence away. Show which.
          wrong.push(`${item.id}: said ${got ? 'defect' : 'clean'}, standard says ${expectDefect ? 'defect' : 'clean'}`);
          wrong.push(`  evidence: ${check.evidence.replace(/\s+/g, ' ').slice(0, 400)}`);
          if (got) falseDefect++; else missedDefect++;
        }
      }
      if (!Object.values(kase.labels).some(Boolean)) cleanCases++;
      rows.push({ case: `${task}/${kase.id}`, verdict: wrong.length ? 'DISAGREES' : 'agrees', detail: wrong });
    }
  }
  for (const r of rows) {
    console.log(`${r.verdict === 'agrees' ? '  ok  ' : ' MISS '} ${r.case}`);
    for (const d of r.detail) console.log(`         ${d}`);
  }
  console.log(`\nAgreement with the recorded standard: ${agreed}/${total} (${pct(agreed, total)})`);
  console.log(`  invented defects (reviewer saw one that is not there): ${falseDefect}`);
  console.log(`  missed defects:                                        ${missedDefect}`);
  console.log(`  clean cases in the set: ${cleanCases}/${rows.length}`);
  console.log(`\nA design score from this reviewer is worth exactly what this number says it is.`);
  if (agreed < total) process.exitCode = 1;
} else {
  // ---- Self-preference probe --------------------------------------------------------------
  const alt = flag('--alt');
  assert(alt?.includes('/'), 'Pass an alternate reviewer from a different family: --alt <provider>/<model>');
  const other = { ...judge, auth: 'pi', ...named(alt) };
  const otherCall = makeJudgeCall(other, 180_000, scratch);
  const run = JSON.parse(readFileSync(join(root, 'runs', runId, 'run.json'), 'utf8'));
  const family = id => {
    const m = run.models.find(x => x.id === id);
    return /claude|anthropic/.test(`${m?.provider}${m?.model}`) ? 'claude'
      : /openai|codex|gpt/.test(`${m?.provider}${m?.model}`) ? 'openai' : (m?.provider ?? 'unknown');
  };
  const tallies = new Map();
  for (const trial of run.trials) {
    if (!['passed', 'failed'].includes(trial.status)) continue;
    const task = run.tasks.find(t => t.id === trial.task);
    if (!task) continue;
    let grader;
    try { grader = await import(new URL(`./${trial.task}.mjs`, import.meta.url)); } catch { continue; }
    if (!grader.review) continue;
    for (const [label, c] of [['configured', call], ['alternate', otherCall]]) {
      const { checks, note } = await review(c, judge, grader.review, trial.files, signal);
      if (note) continue;
      const key = `${family(trial.model)}|${label}`;
      const t = tallies.get(key) ?? { defects: 0, items: 0 };
      t.defects += checks.filter(x => !x.passed).length; t.items += checks.length;
      tallies.set(key, t);
    }
  }
  assert(tallies.size, `No reviewable submissions in run ${runId}`);
  console.log(`Defect rate by the family that wrote the code (run ${runId}):\n`);
  console.log('| Code written by | Configured reviewer | Alternate reviewer | Gap |');
  console.log('|---|---:|---:|---:|');
  for (const fam of [...new Set([...tallies.keys()].map(k => k.split('|')[0]))]) {
    const a = tallies.get(`${fam}|configured`), b = tallies.get(`${fam}|alternate`);
    const ra = a?.items ? a.defects / a.items : null, rb = b?.items ? b.defects / b.items : null;
    console.log(`| ${fam} | ${ra === null ? 'n/a' : pct(a.defects, a.items)} | ${rb === null ? 'n/a' : pct(b.defects, b.items)} | ${ra === null || rb === null ? 'n/a' : `${((ra - rb) * 100).toFixed(0)} pts`} |`);
  }
  console.log(`\nConfigured: ${judge.provider}/${judge.model}. Alternate: ${other.provider}/${other.model}.`);
  console.log('A reviewer that is soft on its own family shows a more negative gap on that row than on the others.');
}
