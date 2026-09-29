/**
 * The frame every simulated production estate shares: a virtual clock, a shell session, a log of
 * what the operator ran and what it did to the estate.
 *
 * A task's world module exports `createWorld({ home, fs })` and returns
 * `{ exec(command) -> { output, code }, report() -> JSON }`. Forseti serves `exec` to the model as
 * its shell and hands `report()` to the grader; nothing else crosses between the two.
 *
 * Time is virtual and deterministic. Each command costs the operator THINK seconds (reading the
 * last output and typing the next one), plus whatever the command itself takes: a rollout that is
 * waited on, a backup, a `sleep`. The estate moves on in between: an incident keeps burning, a
 * scheduled job fires. So a model that runs thirty careful read-only commands before acting pays
 * for it the way an on-call engineer does, while its real thinking speed, which depends on the
 * provider and the hardware, never enters the score.
 */
import { Shell } from './shell.mjs';
import { jq } from './jq.mjs';

export const THINK = 20;
const STEP = 10;

/**
 * @param {object} o
 * @param {string} o.start           ISO instant the session begins at
 * @param {string} o.home            absolute path the workspace is shown as
 * @param {object} o.fs              workspace access: read, write, list, remove
 * @param {object} o.state           the estate, owned by the scenario
 * @param {(ctx) => Record<string, Function>} o.programs  the scenario's command-line tools
 * @param {(ctx) => void} [o.tick]   moves the estate on by one STEP of virtual time
 * @param {(ctx) => object} o.report what the grader receives
 */
export function simulate({ start, home, fs, state, programs, tick = () => {}, report, hostname, user, env = {} }) {
  const origin = Date.parse(start);
  const ctx = {
    state,
    t: 0,
    /** Every command the operator ran, with the virtual second it started at and its exit code. */
    commands: [],
    /** What happened to the estate, recorded by programs and by tick: the grader reads these. */
    events: [],
    now: () => new Date(origin + ctx.t * 1000),
    at: (t = ctx.t) => new Date(origin + t * 1000),
    event(kind, detail = {}) { ctx.events.push({ t: ctx.t, kind, ...detail }); },
    wait(seconds) {
      const end = ctx.t + Math.max(0, seconds);
      while (ctx.t < end) {
        const next = Math.min(end, (Math.floor(ctx.t / STEP) + 1) * STEP);
        ctx.t = next;
        if (next % STEP === 0) tick(ctx);
      }
    },
  };
  const tools = { jq, ...programs(ctx) };
  const shell = new Shell({ programs: tools, env, fs, home, wait: ctx.wait, now: ctx.now, hostname, user });
  ctx.shell = shell;
  return {
    exec(command) {
      ctx.wait(THINK);
      const at = ctx.t;
      const result = shell.run(String(command));
      ctx.commands.push({ t: at, command: String(command), code: result.code, seconds: ctx.t - at });
      return result;
    },
    report: () => ({ elapsed: ctx.t, commands: ctx.commands, events: ctx.events, ...report(ctx) }),
    ctx,
  };
}
/** "3m20s" for a number of virtual seconds, for evidence lines. */
export const minutes = (seconds) => `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
/** A stable pseudo-random sequence, so the same world is built every time. */
export function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; s ^= s >>> 13; s = Math.imul(s, 3266489909) >>> 0; return ((s ^ (s >>> 16)) >>> 0) / 4294967296; };
}
/** Kubernetes-style suffixes: `7d9f8b6c5d`, `x2k9p`. */
export function suffix(rand, length) {
  const alphabet = 'bcdfghjklmnpqrstvwxz2456789';
  let s = '';
  for (let k = 0; k < length; k++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}
/** Fixed-width columns the way kubectl and gcloud print tables. */
export function table(headers, rows, gap = 3) {
  const widths = headers.map((h, k) => Math.max(h.length, ...rows.map(r => String(r[k] ?? '').length)));
  const line = (cells) => cells.map((c, k) => (k === cells.length - 1 ? String(c ?? '') : String(c ?? '').padEnd(widths[k] + gap))).join('').replace(/\s+$/, '');
  return [line(headers), ...rows.map(line)];
}
/** Kubernetes ages: 45s, 12m, 3h20m, 6d. */
export function age(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 120) return `${s}s`;
  if (s < 600) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`;
  if (s < 3 * 3600) return `${Math.floor(s / 60)}m`;
  if (s < 8 * 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60) ? `${Math.floor((s % 3600) / 60)}m` : ''}`;
  if (s < 2 * 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
/**
 * The session starts today at `time` UTC ("14:09:00"). The Claude Code client tells the model the
 * real date, so an estate stuck on a fixed day would contradict it. Everything else in a world is
 * relative to this instant, and graders only ever compare virtual seconds, so the date a run
 * happens on never changes a grade.
 */
export function today(time) {
  return `${new Date().toISOString().slice(0, 10)}T${time}Z`;
}
