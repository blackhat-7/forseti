// Replays recorded tries through the real Live tab and saves the frames as a GIF, so the README's
// video is the actual screen streaming an actual model, not a mock-up.
// Usage: node tools/replay.ts RUN_ID TRIAL_ID[,TRIAL_ID] [out.gif]
// Needs ImageMagick (with SVG support) and ffmpeg. Nothing is sent to any model.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { App } from '../src/app.ts';
import { Dashboard } from '../src/tui.ts';
import { COLUMNS, terminalSvg } from './terminal-svg.ts';
import type { Run } from '../src/types.ts';

const [runId, trialList, out = 'docs/live.gif'] = process.argv.slice(2);
if (!runId || !trialList) throw new Error('Usage: node tools/replay.ts RUN_ID TRIAL_ID[,TRIAL_ID] [out.gif]');
const root = process.cwd(), ids = trialList.split(',');
const scratch = mkdtempSync(join(root, '.tmp/replay-'));
try {
  // A copy of the workspace holding only this run, reopened as if its chosen tries were in progress.
  for (const p of ['suites', 'src']) cpSync(join(root, p), join(scratch, p), { recursive: true });
  for (const p of ['package.json', 'package-lock.json']) cpSync(join(root, p), join(scratch, p));
  const run: Run = JSON.parse(readFileSync(join(root, 'runs', runId, 'run.json'), 'utf8'));
  const config = JSON.parse(readFileSync(join(root, 'forseti.json'), 'utf8'));
  writeFileSync(join(scratch, 'forseti.json'), JSON.stringify({ ...config, local: { url: '' }, models: run.models }));
  const streams = ids.map(id => readFileSync(join(root, 'runs', runId, 'trials', id, 'live.jsonl'), 'utf8').split('\n').filter(Boolean));
  mkdirSync(join(scratch, 'runs', runId, 'trials'), { recursive: true });
  writeFileSync(join(scratch, 'runs', runId, 'run.json'), JSON.stringify({ ...run, status: 'running', finished: undefined, trials: [], planned: ids.length }));
  for (const id of ids) { mkdirSync(join(scratch, 'runs', runId, 'trials', id)); writeFileSync(join(scratch, 'runs', runId, 'trials', id, 'live.jsonl'), ''); }
  mkdirSync(join(scratch, '.state'), { recursive: true });
  writeFileSync(join(scratch, '.state/run.lock'), JSON.stringify({ pid: process.pid, runId }));

  const app = new App(scratch);
  await app.refresh();
  const rows = 40;
  const dashboard = new Dashboard(app, () => {}, () => {}, () => rows);
  const watcher = (dashboard as unknown as { watcher: { poll(force: boolean, now: number): boolean } }).watcher;
  const frames = join(scratch, 'frames');
  mkdirSync(frames);
  // Each frame appends the next few events of every stream; long streams move a little faster.
  const steps = 90, clock = Date.now();
  const written = streams.map(() => 0);
  for (let f = 0; f <= steps + 12; f++) {
    streams.forEach((lines, k) => {
      const upto = Math.min(lines.length, Math.ceil((lines.length * Math.min(f, steps)) / steps));
      if (upto > written[k]!) appendFileSync(join(scratch, 'runs', runId, 'trials', ids[k]!, 'live.jsonl'), lines.slice(written[k], upto).join('\n') + '\n');
      written[k] = upto;
    });
    watcher.poll(true, clock + f * 1000);
    const svg = terminalSvg(dashboard.render(COLUMNS), 'Forseti live view', rows);
    writeFileSync(join(frames, `${String(f).padStart(4, '0')}.svg`), svg);
  }
  const png = spawnSync('magick', ['mogrify', '-density', '96', '-format', 'png', join(frames, '*.svg')], { stdio: 'inherit' });
  if (png.status !== 0) throw new Error('ImageMagick could not render the frames');
  const gif = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '6', '-i', join(frames, '%04d.png'),
    '-vf', 'split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none', '-loop', '0', join(root, out)], { stdio: 'inherit' });
  if (gif.status !== 0) throw new Error('ffmpeg could not encode the GIF');
  console.log(`Wrote ${out} (${steps + 13} frames)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
