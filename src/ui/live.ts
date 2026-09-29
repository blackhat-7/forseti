import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { activeRunId, readRun } from '../runner.ts';
import type { LiveEvent, ModelConfig, Run } from '../types.ts';

/** One piece of a try's conversation. `result` is unset while the tool is still running. */
export type Block = { kind: 'think' | 'say'; text: string } | { kind: 'tool'; name: string; args: string; result?: { ok: boolean; text: string } };

/** A try's conversation, folded from its stream: deltas of one kind extend the block they belong to. */
export class Transcript {
  blocks: Block[] = [];
  turns = 0;
  /** A new turn starts new blocks even when its first delta is of the same kind as the last one. */
  private split = false;
  add(e: LiveEvent): void {
    if (e.k === 'turn') { this.turns++; this.split = true; return; }
    const last = this.blocks.at(-1);
    if (e.k === 'think' || e.k === 'say') {
      if (!this.split && last?.kind === e.k) last.text += e.s; else this.blocks.push({ kind: e.k, text: e.s });
    } else if (e.k === 'tool') this.blocks.push({ kind: 'tool', name: e.name, args: '' });
    // Arguments stream right after their call starts; results come back in the order calls were made.
    else if (e.k === 'args') { const call = this.blocks.findLast(b => b.kind === 'tool'); if (call?.kind === 'tool') call.args += e.s; }
    else if (e.k === 'result') { const call = this.blocks.find(b => b.kind === 'tool' && !b.result); if (call?.kind === 'tool') call.result = { ok: e.ok, text: e.s }; }
    this.split = false;
  }
}

/** A line of a trial's events.jsonl, which the Pi agent wrote before tries streamed to live.jsonl. */
type Logged = { event?: { type?: string; text?: string; event?: { tool?: string; args?: unknown; ok?: boolean; output?: string } } };
function fromEvents(t: Transcript, entry: Logged): void {
  const e = entry.event;
  if (e?.type === 'assistant') { t.turns++; if (e.text?.trim()) t.blocks.push({ kind: 'say', text: e.text.trim() }); }
  else if (e?.type === 'tool' && e.event?.tool) t.blocks.push({ kind: 'tool', name: e.event.tool, args: JSON.stringify(e.event.args ?? {}), result: { ok: e.event.ok !== false, text: e.event.output ?? '' } });
}

/**
 * Follows one trial folder, reading only the bytes appended since the last look. Runs started
 * before tries streamed have only events.jsonl, which gives whole messages instead of deltas; a
 * try streams to live.jsonl from its first flush, so the tail moves there as soon as it appears.
 */
export class Tail {
  transcript = new Transcript();
  private offset = 0;
  /** A line cut off mid-write, kept as bytes so a character split across two reads survives. */
  private rest = Buffer.alloc(0);
  private legacy = true;
  private dir: string;
  constructor(dir: string) { this.dir = dir; }
  read(): boolean {
    if (this.legacy && existsSync(join(this.dir, 'live.jsonl'))) {
      this.legacy = false; this.offset = 0; this.rest = Buffer.alloc(0); this.transcript = new Transcript();
    }
    const file = join(this.dir, this.legacy ? 'events.jsonl' : 'live.jsonl');
    let size: number;
    try { size = statSync(file).size; } catch { return false; }
    if (size <= this.offset) return false;
    const chunk = Buffer.alloc(size - this.offset);
    const fd = openSync(file, 'r');
    try { readSync(fd, chunk, 0, chunk.length, this.offset); } finally { closeSync(fd); }
    this.offset = size;
    const bytes = Buffer.concat([this.rest, chunk]), end = bytes.lastIndexOf(0x0a) + 1;
    this.rest = bytes.subarray(end);
    for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (this.legacy) fromEvents(this.transcript, parsed as Logged); else this.transcript.add(parsed as LiveEvent);
    }
    return end > 0;
  }
}

/** A try in progress: its folder name is its trial id, and it has no result in run.json yet. */
export type Open = { id: string; model: ModelConfig; task: Run['tasks'][number]; since: number; tail: Tail };

/**
 * The run in progress, read from disk wherever it was started — this TUI, the CLI or another
 * terminal — so every run shows the same screen. Polled often, so each look costs a few stats
 * unless something changed.
 */
export class LiveWatch {
  id?: string;
  run?: Run;
  open: Open[] = [];
  private lockAt = 0;
  private listAt = 0;
  private stamp = '';
  /** The app itself, not its root: the root is read on every look, as the app may move it. */
  private app: { root: string };
  constructor(app: { root: string }) { this.app = app; }
  /** Whether anything on screen changed. `force` reads the lock now instead of within a second. */
  poll(force = false, now = Date.now()): boolean {
    const root = this.app.root;
    let changed = false;
    if (force || now - this.lockAt >= 1000) {
      this.lockAt = now;
      const id = activeRunId(root);
      if (id !== this.id) { this.id = id; this.run = undefined; this.open = []; this.stamp = ''; changed = true; }
    }
    if (!this.id) return changed;
    const dir = join(root, 'runs', this.id);
    try {
      const stat = statSync(join(dir, 'run.json')), stamp = `${stat.mtimeMs}:${stat.size}`;
      // The runner rewrites run.json after every try; a half-written one is read again next time.
      if (stamp !== this.stamp) { this.run = readRun(root, this.id, this.id); this.stamp = stamp; changed = true; this.listAt = 0; }
    } catch { /* Not written yet, or caught mid-write. */ }
    const run = this.run;
    if (!run) return changed;
    if (now - this.listAt >= 500) {
      this.listAt = now;
      const done = new Set(run.trials.map(t => t.id));
      for (const gone of this.open.filter(o => done.has(o.id))) gone.tail.read();
      const kept = this.open.filter(o => !done.has(o.id)), known = new Set(kept.map(o => o.id));
      let names: string[] = [];
      try { names = readdirSync(join(dir, 'trials')).sort(); } catch { /* No try has started. */ }
      for (const name of names.filter(n => !done.has(n) && !known.has(n))) {
        const model = run.models.find(m => run.tasks.some(t => name.slice(5) === `${m.id}-${t.id}`));
        const task = model && run.tasks.find(t => name.slice(5) === `${model.id}-${t.id}`);
        if (!model || !task) continue;
        let since = now;
        try { since = statSync(join(dir, 'trials', name)).birthtimeMs || since; } catch { /* Just made. */ }
        kept.push({ id: name, model, task, since, tail: new Tail(join(dir, 'trials', name)) });
      }
      if (kept.length !== this.open.length || kept.some((o, i) => o !== this.open[i])) changed = true;
      this.open = kept;
    }
    for (const o of this.open) if (o.tail.read()) changed = true;
    return changed;
  }
}
