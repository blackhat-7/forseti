/**
 * A bash-like shell over a simulated production estate. Nothing here starts a process, opens a
 * socket or touches a path outside the task workspace: every command is a JavaScript function over
 * in-memory state, so the worst a candidate can do is break the simulation.
 *
 * Programs have the signature (argv, io) => result, where
 *   io = { stdin: string[] | null, env, sh }        stdin is lines, or null when nothing was piped
 *   result = { out?: Iterable<string>, err?: string[], code?: number }
 * `out` may be a lazy iterable, so listing a bucket of millions of objects into `wc -l` works.
 */

const LIMIT = 30_000;

/** Splits source into words and operators, keeping quoting so expansion happens at run time. */
function lex(src) {
  const tokens = [];
  let i = 0;
  const heredocs = [];
  const peek = (n = 0) => src[i + n];
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '#' ) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\n') {
      tokens.push({ op: '\n' });
      i++;
      // Heredoc bodies start after the line that declared them.
      for (const h of heredocs.splice(0)) {
        const lines = [];
        for (;;) {
          if (i >= src.length) break;
          let end = src.indexOf('\n', i);
          if (end < 0) end = src.length;
          let line = src.slice(i, end);
          i = end + 1;
          if (h.strip) line = line.replace(/^\t+/, '');
          if (line === h.tag) break;
          lines.push(line);
        }
        h.token.body = lines.join('\n') + (lines.length ? '\n' : '');
      }
      continue;
    }
    const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
    if (three === '<<<') { tokens.push({ op: '<<<' }); i += 3; continue; }
    if (two === '<<') {
      i += 2;
      let strip = false;
      if (peek() === '-') { strip = true; i++; }
      while (peek() === ' ') i++;
      let tag = '', quoted = false;
      if (peek() === "'" || peek() === '"') {
        const q = src[i++]; quoted = true;
        while (i < src.length && src[i] !== q) tag += src[i++];
        i++;
      } else while (i < src.length && /[\w-]/.test(src[i])) tag += src[i++];
      const token = { op: '<<', tag, quoted, body: '' };
      heredocs.push({ tag, strip, token });
      tokens.push(token);
      continue;
    }
    if (three === '2>&' ) { i += 3; let fd = ''; while (/\d/.test(peek() ?? '')) fd += src[i++]; tokens.push({ op: '2>&', fd }); continue; }
    if (two === '&>') { tokens.push({ op: '&>' }); i += 2; continue; }
    if (two === '2>') { if (src[i + 2] === '>') { tokens.push({ op: '2>>' }); i += 3; } else { tokens.push({ op: '2>' }); i += 2; } continue; }
    if (two === '>>') { tokens.push({ op: '>>' }); i += 2; continue; }
    if (two === '&&' || two === '||' || two === ';;') { tokens.push({ op: two }); i += 2; continue; }
    if (c === '|' || c === ';' || c === '>' || c === '<' || c === '&' || c === '(' || c === ')') { tokens.push({ op: c }); i++; continue; }
    // A word: a run of literal, quoted and substituted parts.
    const parts = [];
    let lit = '';
    const flush = (quoted = false) => { if (lit) { parts.push({ t: 'lit', s: lit, q: quoted }); lit = ''; } };
    while (i < src.length) {
      const d = src[i];
      if (/[\s|;&<>()]/.test(d)) break;
      if (d === '\\') { lit += src[i + 1] ?? ''; i += 2; continue; }
      if (d === "'") {
        flush();
        const end = src.indexOf("'", i + 1);
        if (end < 0) throw new SyntaxError("unexpected EOF while looking for matching `''");
        parts.push({ t: 'lit', s: src.slice(i + 1, end), q: true });
        i = end + 1;
        continue;
      }
      if (d === '"') {
        flush();
        i++;
        let s = '';
        const inner = [];
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\' && '"\\$`\n'.includes(src[i + 1])) { s += src[i + 1]; i += 2; continue; }
          if (src[i] === '$' || src[i] === '`') {
            const sub = dollar(src, i);
            if (sub) { if (s) inner.push({ t: 'lit', s, q: true }); s = ''; inner.push({ ...sub.part, q: true }); i = sub.end; continue; }
          }
          s += src[i++];
        }
        if (i >= src.length) throw new SyntaxError('unexpected EOF while looking for matching `"\'');
        i++;
        if (s || !inner.length) inner.push({ t: 'lit', s, q: true });
        parts.push(...inner);
        continue;
      }
      if (d === '$' || d === '`') {
        const sub = dollar(src, i);
        if (sub) { flush(); parts.push({ ...sub.part, q: false }); i = sub.end; continue; }
      }
      lit += d; i++;
    }
    flush();
    tokens.push({ word: parts });
  }
  if (heredocs.length) for (const h of heredocs) h.token.body = '';
  return tokens;
}
/** `$NAME`, `${NAME}`, `$?`, `$(...)` and backticks, starting at src[i]. */
function dollar(src, i) {
  if (src[i] === '`') {
    const end = src.indexOf('`', i + 1);
    if (end < 0) return null;
    return { part: { t: 'cmd', src: src.slice(i + 1, end) }, end: end + 1 };
  }
  const n = src[i + 1];
  if (n === '(') {
    if (src[i + 2] === '(') {
      const end = src.indexOf('))', i + 3);
      if (end < 0) return null;
      return { part: { t: 'arith', src: src.slice(i + 3, end) }, end: end + 2 };
    }
    let depth = 0, j = i + 1, quote = '';
    for (; j < src.length; j++) {
      const ch = src[j];
      if (quote) { if (ch === quote) quote = ''; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    if (j >= src.length) return null;
    return { part: { t: 'cmd', src: src.slice(i + 2, j) }, end: j + 1 };
  }
  if (n === '{') {
    const end = src.indexOf('}', i + 2);
    if (end < 0) return null;
    const body = src.slice(i + 2, end);
    if (/^#\w+$/.test(body)) return { part: { t: 'var', name: body.slice(1), op: 'length' }, end: end + 1 };
    const m = /^(\w+)(?:(:?-|##?|%%?|\/\/?)(.*))?$/s.exec(body);
    if (!m) return { part: { t: 'var', name: body }, end: end + 1 };
    return { part: { t: 'var', name: m[1], op: m[2], arg: m[3] }, end: end + 1 };
  }
  if (n === '?' || n === '$' || n === '#' || n === '!') return { part: { t: 'var', name: n }, end: i + 2 };
  const m = /^[A-Za-z_]\w*|^\d/.exec(src.slice(i + 1));
  if (!m) return null;
  return { part: { t: 'var', name: m[0] }, end: i + 1 + m[0].length };
}

/**
 * Parses tokens into a list of and-or chains. Supports pipelines, redirections, heredocs,
 * `for ... in ...; do ...; done`, `if ...; then ...; [else ...;] fi`, `while ...; do ...; done` and
 * `( ... )` / `{ ...; }` groups.
 */
function parse(tokens) {
  let i = 0;
  const at = () => tokens[i];
  const isWord = (w) => at()?.word && at().word.length === 1 && at().word[0].t === 'lit' && !at().word[0].q && at().word[0].s === w;
  const skipBreaks = () => { while (at() && (at().op === '\n' || at().op === ';')) i++; };
  function list(stops) {
    const items = [];
    skipBreaks();
    while (at() && !stops.some(s => isWord(s)) && at().op !== ')') {
      items.push(andOr());
      skipBreaks();
    }
    return items;
  }
  function andOr() {
    const chain = [{ pipe: pipeline() }];
    while (at()?.op === '&&' || at()?.op === '||') {
      const op = tokens[i++].op;
      while (at()?.op === '\n') i++;
      chain.push({ op, pipe: pipeline() });
    }
    if (at()?.op === '&') { i++; chain.background = true; }
    return chain;
  }
  function pipeline() {
    let negate = false;
    if (isWord('!')) { negate = true; i++; }
    const cmds = [command()];
    while (at()?.op === '|') { i++; while (at()?.op === '\n') i++; cmds.push(command()); }
    return { cmds, negate };
  }
  function expectWord(w) {
    if (!isWord(w)) throw new SyntaxError(`syntax error near unexpected token \`${tokenText(at())}'`);
    i++;
  }
  function command() {
    if (isWord('for')) {
      i++;
      const name = wordText(tokens[i++]);
      const items = [];
      if (isWord('in')) { i++; while (at()?.word) items.push(tokens[i++].word); }
      skipBreaks();
      expectWord('do');
      const body = list(['done']);
      expectWord('done');
      return { kind: 'for', name, items, body, redirects: redirects() };
    }
    if (isWord('while') || isWord('until')) {
      const until = wordText(tokens[i++]) === 'until';
      const cond = list(['do']);
      expectWord('do');
      const body = list(['done']);
      expectWord('done');
      return { kind: 'while', until, cond, body, redirects: redirects() };
    }
    if (isWord('if')) {
      i++;
      const branches = [];
      let cond = list(['then']);
      expectWord('then');
      let body = list(['elif', 'else', 'fi']);
      branches.push({ cond, body });
      let otherwise = null;
      while (isWord('elif')) { i++; cond = list(['then']); expectWord('then'); body = list(['elif', 'else', 'fi']); branches.push({ cond, body }); }
      if (isWord('else')) { i++; otherwise = list(['fi']); }
      expectWord('fi');
      return { kind: 'if', branches, otherwise, redirects: redirects() };
    }
    if (at()?.op === '(') {
      i++;
      const body = list([]);
      if (at()?.op !== ')') throw new SyntaxError("syntax error: unexpected end of file");
      i++;
      return { kind: 'group', body, redirects: redirects() };
    }
    if (isWord('{')) {
      i++;
      const body = list(['}']);
      expectWord('}');
      return { kind: 'group', body, redirects: redirects() };
    }
    const words = [], assigns = [], redirs = [];
    for (;;) {
      const t = at();
      if (!t) break;
      if (t.word) {
        const text = t.word.length && t.word[0].t === 'lit' && !t.word[0].q ? t.word[0].s : '';
        const m = /^([A-Za-z_]\w*)=/.exec(text);
        if (!words.length && m) {
          assigns.push({ name: m[1], value: [{ ...t.word[0], s: t.word[0].s.slice(m[0].length) }, ...t.word.slice(1)] });
          i++;
          continue;
        }
        words.push(t.word); i++; continue;
      }
      const r = redirect();
      if (r) { redirs.push(r); continue; }
      break;
    }
    if (!words.length && !assigns.length && !redirs.length) throw new SyntaxError(`syntax error near unexpected token \`${tokenText(at())}'`);
    return { kind: 'simple', words, assigns, redirects: redirs };
  }
  function redirect() {
    const t = at();
    if (!t?.op) return null;
    if (['>', '>>', '<', '2>', '2>>', '&>', '<<<'].includes(t.op)) {
      i++;
      if (!at()?.word) throw new SyntaxError(`syntax error near unexpected token \`${tokenText(at())}'`);
      return { op: t.op, target: tokens[i++].word };
    }
    if (t.op === '2>&') { i++; return { op: '2>&', fd: t.fd }; }
    if (t.op === '<<') { i++; return { op: '<<', body: t.body, quoted: t.quoted }; }
    return null;
  }
  function redirects() { const out = []; for (let r = redirect(); r; r = redirect()) out.push(r); return out; }
  const program = list([]);
  if (i < tokens.length) throw new SyntaxError(`syntax error near unexpected token \`${tokenText(at())}'`);
  return program;
}
const tokenText = (t) => (!t ? 'newline' : t.op === '\n' ? 'newline' : t.op ?? wordText(t));
const wordText = (t) => (t?.word ?? []).map(p => p.s ?? '').join('');

class Exit extends Error { constructor(code) { super('exit'); this.code = code; } }

/**
 * One interactive shell session: variables, working directory and `$?` persist between calls,
 * like a terminal the operator keeps open.
 */
export class Shell {
  /**
   * @param {object} o
   * @param {Record<string, Function>} o.programs  name -> program
   * @param {Record<string, string>} o.env
   * @param {{ read(path: string): string, write(path: string, text: string): void, list(): string[], remove?(path: string): void }} o.fs  workspace files, paths relative to it
   * @param {string} o.home  absolute path shown for the workspace
   * @param {(seconds: number) => void} o.wait  advances the world's clock
   * @param {() => Date} o.now
   * @param {(run: () => void) => { id: number, end: number }} [o.detach]  runs a job off the operator's clock; see simulate()
   * @param {(at: number, apply: () => void, job?: number) => void} [o.later]  applies a change at a virtual second
   * @param {() => number} [o.clock]  the virtual second it is now
   */
  constructor({ programs, env, fs, home, wait, now, detach, later, clock, cancel, hostname = 'localhost', user = 'oncall' }) {
    this.detach = detach ?? ((run) => { run(); return { id: 0, end: 0 }; });
    this.later = later ?? ((_at, apply) => apply());
    this.clock = clock ?? (() => 0);
    this.cancel = cancel ?? (() => {});
    /** Background jobs, as `jobs` lists them. */
    this.jobs = [];
    /** Directories made with mkdir: the workspace only holds files, so empty ones live here. */
    this.dirs = new Set();
    /** File writes a background job makes, held until the job gets that far. */
    this.deferred = null;
    this.programs = programs;
    this.env = { HOME: home, PWD: home, USER: user, LOGNAME: user, SHELL: '/bin/bash', HOSTNAME: hostname, PATH: '/usr/local/bin:/usr/bin:/bin:/usr/lib/google-cloud-sdk/bin', LANG: 'C.UTF-8', TERM: 'dumb', ...env };
    this.fs = fs;
    this.home = home;
    this.cwd = '';
    this.wait = wait;
    this.now = now;
    this.status = 0;
    this.scratch = new Map();
    checkedOut = strftime('%b %e 08:12', now());
  }
  /** Runs one command line the way a non-interactive `bash -c` would, returning what a terminal shows. */
  run(source) {
    this.source = source;
    let program;
    try { program = parse(lex(source)); }
    catch (e) { this.status = 2; return { output: `bash: ${e.message}\n`, code: 2 }; }
    const shown = [];
    const term = { write: (line) => shown.push(line) };
    try { this.list(program, null, term, term); }
    catch (e) {
      if (e instanceof Exit) this.status = e.code;
      else throw e;
    }
    let output = shown.join('\n');
    if (shown.length) output += '\n';
    if (output.length > LIMIT) output = `[output truncated: showing the last ${LIMIT} characters]\n` + output.slice(-LIMIT);
    return { output, code: this.status };
  }
  list(items, stdin, out, err) {
    for (const chain of items) {
      if (chain.background) { this.status = this.background(chain, stdin); continue; }
      let status = 0;
      for (const [k, link] of chain.entries()) {
        if (k > 0 && ((link.op === '&&' && status !== 0) || (link.op === '||' && status === 0))) continue;
        status = this.pipeline(link.pipe, stdin, out, err);
      }
      this.status = status;
    }
    return this.status;
  }
  /**
   * `cmd &`: the prompt comes back at once while the job runs on its own clock. Its output goes
   * nowhere unless redirected, and a redirected file only fills in once the job has got that far,
   * as a real log would. What the job changes lands when it would really happen (see `after` in
   * world.mjs), not when it was started.
   */
  background(chain, stdin) {
    const writes = [], saved = this.deferred;
    this.deferred = writes;
    const nul = { write() {} };
    // The job's own words: the command line up to its `&`, from the last separator before it.
    const source = this.source ?? '', amp = /(^|[^&>|])&(?![&>])/.exec(source);
    const head = amp ? source.slice(0, amp.index + amp[1].length) : source;
    const text = head.slice(Math.max(head.lastIndexOf('\n'), head.lastIndexOf(';'), head.lastIndexOf('&&') + 1) + 1).trim();
    let job;
    try {
      job = this.detach(() => {
        let status = 0;
        for (const [k, link] of chain.entries()) {
          if (k > 0 && ((link.op === '&&' && status !== 0) || (link.op === '||' && status === 0))) continue;
          status = this.pipeline(link.pipe, stdin, nul, nul);
        }
      });
    } finally { this.deferred = saved; }
    this.later(job.end, () => { for (const w of writes) this.writeFile(w.target, (w.append ? this.readFile(w.target) ?? '' : '') + w.text); }, job.id);
    this.jobs.push({ id: job.id, end: job.end, pid: 31000 + job.id * 7, text });
    this.env['!'] = String(31000 + job.id * 7);
    return 0;
  }
  pipeline({ cmds, negate }, stdin, out, err) {
    // Each part of a real pipeline runs in a subshell: variables and cd inside it do not survive.
    if (cmds.length > 1) {
      const env = { ...this.env }, cwd = this.cwd;
      try { return this.pipe(cmds, negate, stdin, out, err); }
      finally { this.env = env; this.cwd = cwd; }
    }
    return this.pipe(cmds, negate, stdin, out, err);
  }
  pipe(cmds, negate, stdin, out, err) {
    let input = stdin, status = 0;
    for (const [k, cmd] of cmds.entries()) {
      const last = k === cmds.length - 1;
      // A plain program in the middle of a pipe hands its output on as it produces it, so
      // `gsutil ls -r gs://b | wc -l` over millions of objects never holds them all at once.
      const lazy = !last && this.streamable(cmd);
      if (lazy) { const r = this.start(cmd, input, err); status = r.code; input = r.out; continue; }
      const lines = [];
      const sink = last ? out : { write: (l) => lines.push(l) };
      status = this.command(cmd, input, sink, err);
      input = lines;
    }
    this.status = negate ? (status === 0 ? 1 : 0) : status;
    return this.status;
  }
  /** Applies redirections, then runs `body(stdin, out, err)`. */
  redirected(redirects, stdin, out, err, body) {
    let files = [];
    for (const r of redirects) {
      if (r.op === '<<') { stdin = lines(r.quoted ? r.body : this.expandString(r.body)); continue; }
      if (r.op === '<<<') { stdin = lines(this.expandWord(r.target).join(' ') + '\n'); continue; }
      if (r.op === '2>&') { if (r.fd === '1') err = out; continue; }
      const target = this.expandWord(r.target).join(' ');
      if (r.op === '<') {
        const text = this.readFile(target);
        if (text === null) { err.write(`bash: ${target}: No such file or directory`); return 1; }
        stdin = lines(text);
        continue;
      }
      if (target === '/dev/null') {
        const nul = { write() {} };
        if (r.op === '2>' || r.op === '2>>') err = nul;
        else if (r.op === '&>') { out = nul; err = nul; }
        else out = nul;
        continue;
      }
      if (target === '/dev/stderr') { if (r.op === '>' || r.op === '>>') out = err; continue; }
      if (target === '/dev/stdout') { if (r.op === '2>' || r.op === '2>>') err = out; continue; }
      const buffer = [];
      const append = r.op === '>>' || r.op === '2>>';
      const prior = append ? this.readFile(target) ?? '' : '';
      const sink = { write: (l) => buffer.push(l) };
      files.push({ target, buffer, prior, append });
      if (r.op === '2>' || r.op === '2>>') err = sink;
      else if (r.op === '&>') { out = sink; err = sink; }
      else out = sink;
    }
    const status = body(stdin, out, err);
    for (const f of files) {
      const text = f.buffer.map(l => `${l}\n`).join('');
      if (this.deferred) {
        // Created now, as the shell opens it; filled when the job has written it.
        if (!f.append) this.writeFile(f.target, '');
        this.deferred.push({ target: f.target, text, append: true });
        continue;
      }
      const problem = this.writeFile(f.target, f.prior + text);
      if (problem) { err.write(`bash: ${f.target}: ${problem}`); return 1; }
    }
    return status;
  }
  command(cmd, stdin, out, err) {
    if (cmd.kind === 'group') return this.redirected(cmd.redirects, stdin, out, err, (i, o, e) => this.list(cmd.body, i, o, e));
    if (cmd.kind === 'for') {
      return this.redirected(cmd.redirects, stdin, out, err, (i, o, e) => {
        const values = cmd.items.flatMap(w => this.expandWord(w, true));
        let status = 0;
        for (const v of values) { this.env[cmd.name] = v; status = this.list(cmd.body, i, o, e); }
        return status;
      });
    }
    if (cmd.kind === 'while') {
      return this.redirected(cmd.redirects, stdin, out, err, (i, o, e) => {
        let status = 0;
        for (let guard = 0; guard < 200; guard++) {
          const ok = this.list(cmd.cond, i, o, e) === 0;
          if (ok === cmd.until) return status;
          status = this.list(cmd.body, i, o, e);
        }
        return status;
      });
    }
    if (cmd.kind === 'if') {
      return this.redirected(cmd.redirects, stdin, out, err, (i, o, e) => {
        for (const b of cmd.branches) if (this.list(b.cond, i, o, e) === 0) return this.list(b.body, i, o, e);
        return cmd.otherwise ? this.list(cmd.otherwise, i, o, e) : 0;
      });
    }
    const argv = cmd.words.flatMap(w => this.expandWord(w, true));
    const assigned = Object.fromEntries(cmd.assigns.map(a => [a.name, this.expandWord(a.value).join(' ')]));
    if (!argv.length) { Object.assign(this.env, assigned); return this.redirected(cmd.redirects, stdin, out, err, () => 0); }
    return this.redirected(cmd.redirects, stdin, out, err, (i, o, e) => {
      const saved = { ...this.env };
      Object.assign(this.env, assigned);
      try { return this.exec(argv, i, o, e); }
      finally { if (Object.keys(assigned).length) { for (const k of Object.keys(assigned)) { if (k in saved) this.env[k] = saved[k]; else delete this.env[k]; } } }
    });
  }
  streamable(cmd) {
    if (cmd.kind !== 'simple' || cmd.redirects.length || cmd.assigns.length || !cmd.words.length) return false;
    const [name] = this.expandWord(cmd.words[0], true);
    return Boolean(name) && !BUILTINS[name] && Boolean(this.programs[name] ?? TOOLS[name]);
  }
  /** Runs a program for a pipe and returns its output unread: whatever reads it pulls lines as needed. */
  start(cmd, stdin, err) {
    const [name, ...args] = cmd.words.flatMap(w => this.expandWord(w, true));
    const program = this.programs[name] ?? TOOLS[name];
    let result;
    try { result = program(args, { stdin, env: this.env, sh: this, name }); }
    catch (e) {
      if (e instanceof UsageError) { err.write(e.message); return { code: e.code, out: [] }; }
      throw e;
    }
    for (const line of result.err ?? []) err.write(line);
    return { code: result.code ?? 0, out: result.out ?? [] };
  }
  exec(argv, stdin, out, err) {
    const [name, ...args] = argv;
    const builtin = BUILTINS[name];
    const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
    const program = builtin ?? this.programs[base] ?? (name.includes('/') ? null : TOOLS[base]);
    if (!program) { err.write(`bash: ${name}: command not found`); return 127; }
    let result;
    try { result = program(args, { stdin, env: this.env, sh: this, name: base }); }
    catch (e) {
      if (e instanceof Exit) throw e;
      if (e instanceof UsageError) { err.write(e.message); return e.code; }
      throw e;
    }
    for (const line of result.err ?? []) err.write(line);
    if (result.out) for (const line of result.out) out.write(line);
    return result.code ?? 0;
  }
  /** Runs a nested command line and returns its stdout, for `$(...)`. */
  capture(source) {
    const program = parse(lex(source));
    const lines = [];
    const saved = this.status;
    this.list(program, null, { write: (l) => lines.push(l) }, { write: () => {} });
    void saved;
    return lines.join('\n');
  }
  expandString(text) {
    return lex(`"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\\\\\$/g, '\\$')}"`)[0]?.word?.map(p => this.expandPart(p)).join('') ?? '';
  }
  expandPart(p) {
    if (p.t === 'lit') return p.s;
    if (p.t === 'var') {
      if (p.name === '?') return String(this.status);
      if (p.name === '$') return '4242';
      if (p.name === '#') return '0';
      const v = this.env[p.name] ?? '';
      return varOp(v, p.op, p.arg ?? '');
    }
    if (p.t === 'cmd') return this.capture(p.src).replace(/\n+$/, '');
    if (p.t === 'arith') return String(arith(p.src, this.env));
    return '';
  }
  /** Expands one word. Unquoted expansions split on whitespace; unquoted `*` globs workspace files. */
  expandWord(parts, split = false) {
    if (!split) return [parts.map(p => this.expandPart(p)).join('')];
    const fields = [];
    let current = '', touched = false, glob = false;
    for (const p of parts) {
      const value = this.expandPart(p);
      if (p.t !== 'lit' && !p.q) {
        const pieces = value.split(/\s+/);
        pieces.forEach((piece, k) => {
          if (k > 0) { if (touched || current) fields.push(current); current = ''; touched = false; }
          current += piece;
          if (piece) touched = true;
        });
      } else {
        current += value;
        touched = true;
        if (!p.q && p.t === 'lit' && /[*?]/.test(p.s)) glob = true;
      }
    }
    if (touched || current) fields.push(current);
    if (glob && fields.length === 1 && !/^\w+:\/\//.test(fields[0]) && !fields[0].startsWith('-')) {
      const matches = this.glob(fields[0]);
      if (matches.length) return matches;
    }
    return fields;
  }
  glob(pattern) {
    const rel = this.relative(pattern);
    if (rel === null) return [];
    const re = new RegExp(`^${rel.split('*').map(s => s.split('?').map(escape).join('[^/]')).join('[^/]*')}$`);
    const dirs = new Set();
    for (const f of this.fs.list()) { const parts = f.split('/'); for (let k = 1; k < parts.length; k++) dirs.add(parts.slice(0, k).join('/')); }
    const shown = (p) => (pattern.startsWith('/') ? `${this.home}/${p}` : this.cwd && p.startsWith(`${this.cwd}/`) ? p.slice(this.cwd.length + 1) : p);
    return [...this.fs.list(), ...dirs].filter(f => re.test(f)).sort().map(shown);
  }
  /** Maps a path the operator typed to a workspace-relative path, or null if it is outside it. */
  relative(path) {
    let p = path;
    if (p === '~' || p.startsWith('~/')) p = this.home + p.slice(1);
    const absolute = p.startsWith('/') ? p : `${this.env.PWD}/${p}`;
    const segments = [];
    for (const s of absolute.split('/')) {
      if (!s || s === '.') continue;
      if (s === '..') segments.pop(); else segments.push(s);
    }
    const joined = `/${segments.join('/')}`;
    if (joined === this.home) return '';
    return joined.startsWith(`${this.home}/`) ? joined.slice(this.home.length + 1) : null;
  }
  /**
   * `/tmp` outside the checkout is scratch space for the session, as on any machine: operators
   * stage a policy or a query there. It is kept in memory and is not part of what is graded.
   */
  scratchPath(path) {
    const segments = [];
    for (const s of (path.startsWith('/') ? path : `${this.env.PWD}/${path}`).split('/')) { if (!s || s === '.') continue; if (s === '..') segments.pop(); else segments.push(s); }
    const joined = `/${segments.join('/')}`;
    return /^\/(tmp|var\/tmp)\/./.test(joined) ? joined : null;
  }
  readFile(path) {
    const rel = this.relative(path);
    if (rel === null) {
      const installed = INSTALLED[this.absolute(path)];
      if (installed) return installed.script ?? installed.binary;
      const scratch = this.scratchPath(path);
      return scratch && this.scratch.has(scratch) ? this.scratch.get(scratch) : null;
    }
    if (rel === '') return null;
    try { return this.fs.read(rel); } catch { return null; }
  }
  /** Returns an error message, or undefined on success. */
  writeFile(path, text) {
    const rel = this.relative(path);
    if (rel === null) {
      const scratch = this.scratchPath(path);
      if (!scratch) return 'Permission denied';
      this.scratch.set(scratch, text);
      return undefined;
    }
    if (rel === '' || this.isDir(rel)) return 'Is a directory';
    try { this.fs.write(rel, text); return undefined; } catch (e) { return /128 KiB/.test(String(e?.message)) ? 'File too large' : 'Permission denied'; }
  }
  isDir(rel) { return rel === '' || this.dirs.has(`${this.home}/${rel}`) || this.fs.list().some(f => f.startsWith(`${rel}/`)); }
  /** An absolute path, `..` and `~` resolved against the working directory. */
  absolute(path) {
    let p = path;
    if (p === '~' || p.startsWith('~/')) p = this.home + p.slice(1);
    const segments = [];
    for (const s of (p.startsWith('/') ? p : `${this.env.PWD}/${p}`).split('/')) { if (!s || s === '.') continue; if (s === '..') segments.pop(); else segments.push(s); }
    return `/${segments.join('/')}`;
  }
  /** A directory outside the checkout that exists: /tmp, what mkdir made there, and the folders above the checkout. */
  outsideDir(abs) {
    return abs === '/tmp' || abs === '/var/tmp' || this.dirs.has(abs) || this.home.startsWith(`${abs}/`) || [...this.scratch.keys()].some(k => k.startsWith(`${abs}/`));
  }
  /** Names directly inside an outside directory. */
  outsideEntries(abs) {
    const names = new Set();
    for (const p of [...this.scratch.keys(), ...this.dirs, this.home]) if (p.startsWith(`${abs}/`)) names.add(p.slice(abs.length + 1).split('/')[0]);
    return [...names].sort();
  }
}
/** `${v:-x}`, `${v#p}`, `${v##p}`, `${v%p}`, `${v%%p}`, `${v/a/b}`, `${v//a/b}`, `${#v}`. */
function varOp(v, op, arg) {
  if (!op) return v;
  if (op === 'length') return String(v.length);
  if (op === '-' || op === ':-') return v === '' ? arg : v;
  const pattern = (text, anchor, greedy) => new RegExp(`${anchor === '^' ? '^' : ''}${text.split('*').map(x => x.split('?').map(escape).join('.')).join(greedy ? '.*' : '.*?')}${anchor === '$' ? '$' : ''}`);
  if (op === '#' || op === '##') { const m = pattern(arg, '^', op === '##').exec(v); return m ? v.slice(m[0].length) : v; }
  if (op === '%' || op === '%%') {
    // Shortest suffix first for `%`, longest for `%%`.
    const starts = [...Array(v.length + 1).keys()];
    for (const k of op === '%' ? starts.reverse() : starts) if (pattern(arg, '$', true).test(v.slice(k)) && new RegExp(`^${pattern(arg, '', true).source}$`).test(v.slice(k))) return v.slice(0, k);
    return v;
  }
  const [from, to = ''] = arg.split('/');
  const re = pattern(from, '', true);
  return op === '//' ? v.replace(new RegExp(re.source, 'g'), to) : v.replace(re, to);
}
const escape = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
export class UsageError extends Error { constructor(message, code = 1) { super(message); this.code = code; } }
export const lines = (text) => { const l = String(text).split('\n'); if (l.at(-1) === '') l.pop(); return l; };

function arith(src, env) {
  const expr = src.replace(/\$?([A-Za-z_]\w*)/g, (_, n) => String(Number(env[n] ?? 0) || 0));
  if (!/^[\d\s+\-*/%()<>=!&|]*$/.test(expr)) return 0;
  try { return Math.trunc(Number(Function(`"use strict";return (${expr})`)())) || 0; } catch { return 0; }
}

/** Shell builtins: they change the session itself. */
const BUILTINS = {
  cd(args, { sh }) {
    const target = args[0] === '-' ? sh.env.OLDPWD ?? sh.env.PWD : args[0] ?? '~';
    const rel = sh.relative(target);
    if (rel === null) {
      const abs = sh.absolute(target);
      if (!sh.outsideDir(abs)) return { err: [`bash: cd: ${target}: ${abs.startsWith('/tmp/') || abs.startsWith('/var/tmp/') ? 'No such file or directory' : 'Permission denied'}`], code: 1 };
      sh.env.OLDPWD = sh.env.PWD;
      sh.cwd = null;
      sh.env.PWD = abs;
      return {};
    }
    sh.env.OLDPWD = sh.env.PWD;
    if (!sh.isDir(rel)) return { err: [`bash: cd: ${target}: ${sh.fs.list().includes(rel) ? 'Not a directory' : 'No such file or directory'}`], code: 1 };
    sh.cwd = rel;
    sh.env.PWD = rel ? `${sh.home}/${rel}` : sh.home;
    return {};
  },
  pwd(_a, { sh }) { return { out: [sh.env.PWD] }; },
  /** One line of input into variables, so `... | while read -r a b; do` loops work. */
  read(args, { stdin, sh }) {
    const names = [];
    let array = null;
    for (let k = 0; k < args.length; k++) {
      if (args[k] === '-a') { array = args[++k]; continue; }
      if (['-p', '-d', '-n', '-t', '-u'].includes(args[k])) { k++; continue; }
      if (!args[k].startsWith('-')) names.push(args[k]);
    }
    const line = nextLine(stdin);
    if (line === undefined) return { code: 1 };
    const fields = line.trim().split(/\s+/).filter(Boolean);
    if (array) { sh.env[array] = fields.join(' '); return {}; }
    const vars = names.length ? names : ['REPLY'];
    vars.forEach((name, k) => { sh.env[name] = k === vars.length - 1 ? (names.length ? fields.slice(k).join(' ') : line) : fields[k] ?? ''; });
    return {};
  },
  /** Waits, on the virtual clock, for the background jobs to finish. */
  wait(_a, { sh }) {
    const end = Math.max(sh.clock(), ...sh.jobs.map(j => j.end));
    if (end > sh.clock()) sh.wait(end - sh.clock());
    sh.jobs = [];
    return {};
  },
  jobs(args, { sh }) {
    const now = sh.clock(), out = [];
    sh.jobs.forEach((j, k) => {
      const mark = k === sh.jobs.length - 1 ? '+' : k === sh.jobs.length - 2 ? '-' : ' ';
      out.push(`[${j.id}]${mark}  ${args.includes('-l') ? `${j.pid} ` : ''}${(j.end > now ? 'Running' : 'Done').padEnd(24)}${j.text}${j.end > now ? ' &' : ''}`);
    });
    sh.jobs = sh.jobs.filter(j => j.end > now);
    return { out };
  },
  disown(_a, { sh }) { sh.jobs = []; return {}; },
  kill(args, { sh }) {
    const err = [];
    for (const a of args.filter(x => !x.startsWith('-'))) {
      const job = sh.jobs.find(j => (a.startsWith('%') ? String(j.id) === a.slice(1) : String(j.pid) === a) && j.end > sh.clock());
      if (!job) { err.push(a.startsWith('%') ? `bash: kill: ${a}: no such job` : `bash: kill: (${a}) - No such process`); continue; }
      sh.cancel(job.id);
      job.end = sh.clock();
    }
    return { err, code: err.length ? 1 : 0 };
  },
  export(args, { sh }) {
    for (const a of args) { const m = /^([A-Za-z_]\w*)=(.*)$/s.exec(a); if (m) sh.env[m[1]] = m[2]; }
    return {};
  },
  unset(args, { sh }) { for (const a of args) delete sh.env[a]; return {}; },
  exit(args) { throw new Exit(Number(args[0] ?? 0) || 0); },
  true: () => ({}),
  false: () => ({ code: 1 }),
  ':': () => ({}),
  set: () => ({}),
  source: (args) => ({ err: [`bash: ${args[0] ?? 'source'}: cannot source files in this session`], code: 1 }),
  alias: () => ({}),
  echo(args) {
    let newline = true, escapes = false;
    while (args[0] && /^-[neE]+$/.test(args[0])) { if (args[0].includes('n')) newline = false; if (args[0].includes('e')) escapes = true; args = args.slice(1); }
    let text = args.join(' ');
    if (escapes) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    void newline;
    return { out: lines(`${text}\n`) };
  },
  printf(args) {
    const [format = '', ...rest] = args;
    let k = 0;
    let text = '';
    do {
      text += format.replace(/%(-?\d*)(\.\d+)?([sdf%])/g, (_, width, precision, type) => {
        if (type === '%') return '%';
        let v = rest[k++] ?? '';
        if (type === 'd') v = String(Math.trunc(Number(v) || 0));
        if (type === 'f') v = (Number(v) || 0).toFixed(precision ? Number(precision.slice(1)) : 6);
        const w = Number(width) || 0;
        return w < 0 ? v.padEnd(-w) : v.padStart(w);
      }).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    } while (k > 0 && k < rest.length);
    return { out: lines(text) };
  },
  test: (args) => ({ code: testExpr(args) ? 0 : 1 }),
  '[': (args) => ({ code: testExpr(args.slice(0, -1)) ? 0 : 1 }),
  type(args, { sh }) {
    return { out: args.map(a => (BUILTINS[a] ? `${a} is a shell builtin` : sh.programs[a] || TOOLS[a] ? `${a} is ${programPath(a)}` : `bash: type: ${a}: not found`)) };
  },
  history: () => ({}),
  clear: () => ({}),
};
function testExpr(a) {
  if (a[0] === '!') return !testExpr(a.slice(1));
  if (a.length === 1) return a[0] !== '';
  if (a.length === 2) return a[0] === '-z' ? a[1] === '' : a[0] === '-n' ? a[1] !== '' : false;
  const [l, op, r] = a;
  switch (op) {
    case '=': case '==': return l === r;
    case '!=': return l !== r;
    case '-eq': return Number(l) === Number(r);
    case '-ne': return Number(l) !== Number(r);
    case '-lt': return Number(l) < Number(r);
    case '-le': return Number(l) <= Number(r);
    case '-gt': return Number(l) > Number(r);
    case '-ge': return Number(l) >= Number(r);
    default: return false;
  }
}

/** Input read a line at a time keeps its place, so each `read` in a loop gets the next line. */
const cursors = new WeakMap();
function nextLine(stdin) {
  if (!stdin) return undefined;
  if (!cursors.has(stdin)) cursors.set(stdin, stdin[Symbol.iterator]());
  const next = cursors.get(stdin).next();
  return next.done ? undefined : next.value;
}
/** Reads a program's input: the files it names, or stdin. */
function inputs(files, io, name) {
  if (!files.length || (files.length === 1 && files[0] === '-')) return { lines: io.stdin ?? [], err: [] };
  const out = [], err = [];
  for (const f of files) {
    const text = io.sh.readFile(f);
    if (text === null) err.push(`${name}: ${f}: ${io.sh.relative(f) !== null && io.sh.isDir(io.sh.relative(f)) ? 'Is a directory' : 'No such file or directory'}`);
    else out.push(...lines(text));
  }
  return { lines: out, err };
}
/** Splits `-abc` style flags; returns [flags, operands, values]. */
function flags(args, withValue = '') {
  const set = new Set(), values = {}, rest = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { rest.push(...args.slice(k + 1)); break; }
    if (/^-\d+$/.test(a)) { values.n = a.slice(1); continue; }
    if (a.startsWith('--')) { const [key, v] = a.slice(2).split('='); if (v !== undefined) values[key] = v; else set.add(key); continue; }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (withValue.includes(f)) { values[f] = a.slice(j + 1) || args[++k]; break; }
        set.add(f);
      }
      continue;
    }
    rest.push(a);
  }
  return [set, rest, values];
}

/** Ordinary Unix text tools. They only ever see the workspace and piped input. */
export const TOOLS = {
  cat(args, io) { const [, files] = flags(args); const r = inputs(files, io, 'cat'); return { out: r.lines, err: r.err, code: r.err.length ? 1 : 0 }; },
  less(args, io) { return TOOLS.cat(args, io); },
  more(args, io) { return TOOLS.cat(args, io); },
  head(args, io) {
    const [, files, v] = flags(args, 'nc');
    const n = Number(v.n ?? 10);
    const r = inputs(files, io, 'head');
    return { out: take(r.lines, n), err: r.err };
  },
  tail(args, io) {
    const [set, files, v] = flags(args, 'n');
    const r = inputs(files, io, 'tail');
    const all = [...r.lines];
    const spec = String(v.n ?? '10');
    void set;
    return { out: spec.startsWith('+') ? all.slice(Number(spec.slice(1)) - 1) : all.slice(-Number(spec) || all.length), err: r.err };
  },
  wc(args, io) {
    const [set, files] = flags(args);
    const r = inputs(files, io, 'wc');
    let count = 0, words = 0, chars = 0;
    for (const l of r.lines) { count++; words += l.split(/\s+/).filter(Boolean).length; chars += l.length + 1; }
    const shown = set.has('l') ? [count] : set.has('w') ? [words] : set.has('c') || set.has('m') ? [chars] : [count, words, chars];
    const width = files.length ? 1 : 0;
    void width;
    return { out: [`${shown.map((n, k) => (shown.length > 1 ? String(n).padStart(k ? 8 : 7) : String(n))).join('')}${files.length === 1 ? ` ${files[0]}` : ''}`], err: r.err };
  },
  grep(args, io) {
    const [set, operands, v] = flags(args, 'eABCm');
    const patterns = v.e ? [v.e] : operands.length ? [operands.shift()] : null;
    if (!patterns) return { err: ['Usage: grep [OPTION]... PATTERNS [FILE]...'], code: 2 };
    const source = set.has('F') ? escape(patterns[0]) : toJsRegex(patterns[0], set.has('E') || io.name === 'egrep');
    let re;
    try { re = new RegExp(set.has('w') ? `\\b(?:${source})\\b` : set.has('x') ? `^(?:${source})$` : source, set.has('i') ? 'i' : ''); }
    catch { return { err: ['grep: Unmatched ( or \\('], code: 2 }; }
    const many = operands.length > 1 || set.has('r');
    const results = [], err = [];
    let matched = 0;
    const scan = (text, label) => {
      const all = text;
      const after = Number(v.A ?? v.C ?? 0), before = Number(v.B ?? v.C ?? 0);
      let lastShown = -1;
      for (let k = 0; k < all.length; k++) {
        const hit = re.test(all[k]) !== set.has('v');
        if (!hit) continue;
        matched++;
        if (v.m && matched > Number(v.m)) break;
        if (set.has('c') || set.has('l') || set.has('q')) continue;
        for (let b = Math.max(lastShown + 1, k - before); b < k; b++) results.push(prefix(label, b, all[b], '-'));
        if (set.has('o')) { for (const m of all[k].matchAll(new RegExp(re.source, `g${re.flags}`))) results.push(prefix(label, k, m[0], ':')); }
        else results.push(prefix(label, k, all[k], ':'));
        lastShown = k;
        for (let a = k + 1; a <= Math.min(all.length - 1, k + after); a++) { if (!(re.test(all[a]) !== set.has('v'))) { results.push(prefix(label, a, all[a], '-')); lastShown = a; } }
      }
    };
    const prefix = (label, k, text, sep) => `${many && label ? `${label}${sep}` : ''}${set.has('n') ? `${k + 1}${sep}` : ''}${text}`;
    const context = v.A !== undefined || v.B !== undefined || v.C !== undefined;
    if (!operands.length && !context && !set.has('c') && !set.has('q') && !set.has('l')) {
      // Piped input without context lines streams: matches go on as they are found.
      const stdin = io.stdin ?? [];
      const stream = function* () {
        let k = 0, n = 0;
        for (const line of stdin) {
          if (re.test(line) !== set.has('v')) {
            if (v.m && ++n > Number(v.m)) return;
            if (set.has('o')) { for (const m of line.matchAll(new RegExp(re.source, `g${re.flags}`))) yield prefix('', k, m[0], ':'); }
            else yield prefix('', k, line, ':');
          }
          k++;
        }
      };
      // grep's exit status depends on whether anything matched, so peek at the first match.
      const lines = stream();
      const first = lines.next();
      return { out: first.done ? [] : (function* () { yield first.value; yield* lines; })(), code: first.done ? 1 : 0 };
    }
    if (!operands.length) scan([...(io.stdin ?? [])], '');
    else for (const f of operands) {
      const rel = io.sh.relative(f);
      if (rel !== null && io.sh.isDir(rel)) {
        if (!set.has('r') && !set.has('R')) { err.push(`grep: ${f}: Is a directory`); continue; }
        for (const file of io.sh.fs.list().filter(p => rel === '' || p.startsWith(`${rel}/`))) {
          const before = matched;
          scan(lines(io.sh.fs.read(file)), rel === '' ? file : `${f.replace(/\/$/, '')}/${file.slice(rel.length + 1)}`);
          if (set.has('l') && matched > before) results.push(file);
        }
        continue;
      }
      const text = io.sh.readFile(f);
      if (text === null) { err.push(`grep: ${f}: No such file or directory`); continue; }
      const before = matched;
      scan(lines(text), f);
      if (set.has('l') && matched > before) results.push(f);
    }
    if (set.has('q')) return { code: matched ? 0 : 1 };
    if (set.has('c')) results.push(String(matched));
    return { out: results, err, code: err.length && !matched ? 2 : matched ? 0 : 1 };
  },
  egrep(args, io) { return TOOLS.grep(args, { ...io, name: 'egrep' }); },
  sort(args, io) {
    const [set, files, v] = flags(args, 'kt');
    const r = inputs(files, io, 'sort');
    const key = (l) => {
      if (!v.k) return l;
      const field = Number(String(v.k).split(',')[0].replace(/\D.*$/, '')) - 1;
      const parts = v.t ? l.split(v.t) : l.trim().split(/\s+/);
      return parts[field] ?? '';
    };
    const numeric = set.has('n') || set.has('h') || /n/.test(String(v.k ?? ''));
    const all = [...r.lines].sort((a, b) => (numeric ? (parseFloat(key(a)) || 0) - (parseFloat(key(b)) || 0) : key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    if (set.has('r') || /r/.test(String(v.k ?? ''))) all.reverse();
    return { out: set.has('u') ? [...new Set(all)] : all, err: r.err };
  },
  uniq(args, io) {
    const [set, files] = flags(args);
    const r = inputs(files, io, 'uniq');
    const out = [];
    let prev = null, n = 0;
    const emit = () => { if (prev !== null && (!set.has('d') || n > 1)) out.push(set.has('c') ? `${String(n).padStart(7)} ${prev}` : prev); };
    for (const l of r.lines) { if (l === prev) n++; else { emit(); prev = l; n = 1; } }
    emit();
    return { out, err: r.err };
  },
  cut(args, io) {
    const [, files, v] = flags(args, 'dfc');
    const r = inputs(files, io, 'cut');
    const pick = (list, max) => String(list).split(',').flatMap(s => { const [a, b] = s.split('-'); const lo = Number(a || 1), hi = b === undefined ? lo : Number(b || max); return Array.from({ length: Math.max(0, hi - lo + 1) }, (_, k) => lo + k); });
    if (v.c) return { out: [...r.lines].map(l => pick(v.c, l.length).map(k => l[k - 1] ?? '').join('')) };
    const d = v.d ?? '\t';
    return { out: [...r.lines].map(l => { const parts = l.split(d); return parts.length === 1 ? l : pick(v.f ?? '1', parts.length).map(k => parts[k - 1]).filter(x => x !== undefined).join(d); }), err: r.err };
  },
  tr(args, io) {
    const [set, operands] = flags(args);
    const expand = (s) => s.replace(/\[:upper:\]/g, 'A-Z').replace(/\[:lower:\]/g, 'a-z').replace(/\[:space:\]/g, ' \t').replace(/(.)-(.)/g, (_, a, b) => Array.from({ length: b.charCodeAt(0) - a.charCodeAt(0) + 1 }, (_, k) => String.fromCharCode(a.charCodeAt(0) + k)).join('')).replace(/\\n/g, '\n');
    const from = expand(operands[0] ?? ''), to = expand(operands[1] ?? '');
    const text = [...(io.stdin ?? [])].join('\n') + '\n';
    let result = '';
    for (const ch of text) {
      const k = from.indexOf(ch);
      if (set.has('d')) { if (k < 0) result += ch; }
      else result += k < 0 ? ch : to[Math.min(k, to.length - 1)] ?? ch;
    }
    if (set.has('s')) result = result.replace(new RegExp(`([${escape(to || from)}])\\1+`, 'g'), '$1');
    return { out: lines(result) };
  },
  tee(args, io) {
    const [set, files] = flags(args);
    const all = [...(io.stdin ?? [])];
    for (const f of files) {
      const prior = set.has('a') ? io.sh.readFile(f) ?? '' : '';
      const problem = io.sh.writeFile(f, prior + all.map(l => `${l}\n`).join(''));
      if (problem) return { out: all, err: [`tee: ${f}: ${problem}`], code: 1 };
    }
    return { out: all };
  },
  ls(args, io) {
    const [set, operands] = flags(args);
    const sh = io.sh;
    const targets = operands.length ? operands : ['.'];
    const out = [], err = [];
    for (const t of targets) {
      const rel = sh.relative(t);
      if (rel === null) {
        const abs = sh.absolute(t);
        if (sh.scratch.has(abs)) { out.push(set.has('l') ? long(t, sh.scratch.get(abs), sh.env.USER) : t); continue; }
        if (!sh.outsideDir(abs)) { err.push(`ls: cannot ${abs.startsWith('/tmp') ? `access '${t}': No such file or directory` : `open directory '${t}': Permission denied`}`); continue; }
        const names = sh.outsideEntries(abs);
        if (targets.length > 1) out.push(`${t}:`);
        if (set.has('l')) { out.push(`total ${names.length * 4}`); for (const n of names) { const p = `${abs}/${n}`; out.push(sh.scratch.has(p) ? long(n, sh.scratch.get(p), sh.env.USER) : `drwx------ 3 ${sh.env.USER} ${sh.env.USER}  4096 ${checkedOut} ${n}`); } }
        else out.push(...names);
        continue;
      }
      if (!sh.isDir(rel)) {
        if (sh.fs.list().includes(rel)) out.push(set.has('l') ? long(t, sh.fs.read(rel)) : t);
        else err.push(`ls: cannot access '${t}': No such file or directory`);
        continue;
      }
      const prefix = rel ? `${rel}/` : '';
      const names = new Set();
      for (const f of sh.fs.list()) if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0]);
      const entries = [...names].sort();
      if (set.has('R')) { for (const f of sh.fs.list().filter(p => p.startsWith(prefix)).sort()) out.push(f.slice(prefix.length)); continue; }
      if (targets.length > 1) out.push(`${t}:`);
      if (set.has('l')) {
        out.push(`total ${entries.length * 4}`);
        for (const e of entries) out.push(sh.isDir(prefix + e) ? `drwxr-xr-x 2 ${sh.env.USER} ${sh.env.USER}  4096 ${checkedOut} ${e}` : long(e, sh.fs.read(prefix + e), sh.env.USER));
      } else out.push(...(set.has('1') || true ? entries : []));
    }
    return { out, err, code: err.length ? 2 : 0 };
  },
  find(args, io) {
    const sh = io.sh;
    const root = args[0] && !args[0].startsWith('-') ? args[0] : '.';
    const rel = sh.relative(root);
    if (rel === null) return { err: [`find: '${root}': Permission denied`], code: 1 };
    const nameAt = args.indexOf('-name');
    const pattern = nameAt >= 0 ? new RegExp(`^${(args[nameAt + 1] ?? '*').split('*').map(escape).join('.*')}$`) : null;
    const prefix = rel ? `${rel}/` : '';
    const found = sh.fs.list().filter(f => f.startsWith(prefix)).filter(f => !pattern || pattern.test(f.split('/').pop())).sort();
    return { out: found.map(f => `${root.replace(/\/$/, '')}/${f.slice(prefix.length)}`) };
  },
  mkdir(args, io) {
    const [set, operands] = flags(args, 'm');
    const err = [];
    for (const d of operands) {
      const abs = io.sh.absolute(d), rel = io.sh.relative(d);
      const writable = rel !== null || /^\/(tmp|var\/tmp)\//.test(abs);
      if (!writable) { err.push(`mkdir: cannot create directory '${d}': Permission denied`); continue; }
      const exists = rel !== null ? io.sh.isDir(rel) || io.sh.fs.list().includes(rel) : io.sh.outsideDir(abs) || io.sh.scratch.has(abs);
      if (exists) { if (!set.has('p')) err.push(`mkdir: cannot create directory '${d}': File exists`); continue; }
      const parent = abs.slice(0, abs.lastIndexOf('/')) || '/';
      const parentExists = io.sh.relative(parent) !== null ? io.sh.isDir(io.sh.relative(parent)) : io.sh.outsideDir(parent);
      if (!parentExists && !set.has('p')) { err.push(`mkdir: cannot create directory '${d}': No such file or directory`); continue; }
      for (let p = abs; p.length > 1 && !(p === io.sh.home || (io.sh.relative(p) === null && io.sh.outsideDir(p) && p !== abs)); p = p.slice(0, p.lastIndexOf('/'))) io.sh.dirs.add(p);
    }
    return { err, code: err.length ? 1 : 0 };
  },
  nohup(args, io) {
    if (!args.length) return { err: ["nohup: missing operand", "Try 'nohup --help' for more information."], code: 125 };
    const out = [], err = [];
    const code = io.sh.exec(args, io.stdin, { write: (l) => out.push(l) }, { write: (l) => err.push(l) });
    return { out, err, code };
  },
  setsid(args, io) { return TOOLS.nohup(args, io); },
  stdbuf(args, io) { return TOOLS.nohup(args.filter(a => !a.startsWith('-')), io); },
  timeout(args, io) {
    const rest = args.filter(a => !a.startsWith('-'));
    return TOOLS.nohup(rest.slice(1), io);
  },
  touch(args, io) { for (const f of args.filter(a => !a.startsWith('-'))) if (io.sh.readFile(f) === null) io.sh.writeFile(f, ''); return {}; },
  rm(args, io) {
    const [, files] = flags(args);
    const err = [];
    for (const f of files) {
      const rel = io.sh.relative(f);
      if (rel === null || !io.sh.fs.remove) { err.push(`rm: cannot remove '${f}': Permission denied`); continue; }
      const matches = io.sh.fs.list().filter(p => p === rel || p.startsWith(`${rel}/`));
      for (const p of matches) io.sh.fs.remove(p);
    }
    return { err, code: err.length ? 1 : 0 };
  },
  cp(args, io) {
    const [, files] = flags(args);
    const [from] = files;
    let to = files[1];
    const text = io.sh.readFile(from ?? '');
    if (text === null) return { err: [`cp: cannot stat '${from}': No such file or directory`], code: 1 };
    // Into a directory, the file keeps its name.
    const toRel = io.sh.relative(to ?? '');
    if (to && (to.endsWith('/') || (toRel !== null ? io.sh.isDir(toRel) : io.sh.outsideDir(io.sh.absolute(to))))) to = `${to.replace(/\/$/, '')}/${from.split('/').pop()}`;
    const problem = io.sh.writeFile(to ?? '', text);
    return problem ? { err: [`cp: cannot create regular file '${to}': ${problem}`], code: 1 } : {};
  },
  mv(args, io) {
    const [, files] = flags(args);
    const r = TOOLS.cp(args, io);
    if (r.code) return { err: r.err.map(l => l.replace(/^cp: cannot (stat|create regular file)/, (_, what) => (what === 'stat' ? 'mv: cannot stat' : 'mv: cannot move'))), code: r.code };
    const rel = io.sh.relative(files[0]);
    if (rel !== null) io.sh.fs.remove?.(rel);
    else io.sh.scratch.delete(io.sh.absolute(files[0]));
    return {};
  },
  date(args, io) {
    let now = io.sh.now();
    const dIdx = args.findIndex(a => a === '-d' || a === '--date' || a.startsWith('--date='));
    if (dIdx >= 0) {
      const spec = args[dIdx].startsWith('--date=') ? args[dIdx].slice(7) : args[dIdx + 1] ?? '';
      const parsed = parseDate(spec, now);
      if (!parsed) return { err: [`date: invalid date '${spec}'`], code: 1 };
      now = parsed;
      args = args.filter((_, k) => k !== dIdx && !(k === dIdx + 1 && !args[dIdx].startsWith('--date=')));
    }
    const iso = args.find(a => a.startsWith('-I') || a.startsWith('--iso'));
    const plus = args.find(a => a.startsWith('+'));
    if (iso) return { out: [now.toISOString().replace(/\.\d+Z$/, '+00:00')] };
    if (args.includes('-u') || args.includes('--utc') || !plus) {
      if (plus) return { out: [strftime(plus.slice(1), now)] };
      return { out: [strftime('%a %b %e %H:%M:%S UTC %Y', now)] };
    }
    return { out: [strftime(plus.slice(1), now)] };
  },
  sleep(args, io) {
    const seconds = args.reduce((sum, a) => { const m = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(a); return m ? sum + Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2]] ?? 1) : sum; }, 0);
    io.sh.wait(seconds);
    return {};
  },
  whoami(_a, io) { return { out: [io.sh.env.USER] }; },
  hostname(_a, io) { return { out: [io.sh.env.HOSTNAME] }; },
  id(_a, io) { return { out: [`uid=1001(${io.sh.env.USER}) gid=1001(${io.sh.env.USER}) groups=1001(${io.sh.env.USER}),999(docker)`] }; },
  uname(args) { return { out: [args.includes('-a') ? 'Linux ' + 'ops-bastion 6.1.0-25-cloud-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.1.106-3 (2024-08-26) x86_64 GNU/Linux' : 'Linux'] }; },
  env(_a, io) { return { out: Object.entries(io.sh.env).map(([k, v]) => `${k}=${v}`) }; },
  printenv(args, io) { return args.length ? { out: args.filter(a => a in io.sh.env).map(a => io.sh.env[a]), code: args.every(a => a in io.sh.env) ? 0 : 1 } : TOOLS.env(args, io); },
  which(args, io) {
    const found = args.filter(a => !a.startsWith('-') && (io.sh.programs[a] || TOOLS[a]));
    return { out: found.map(a => programPath(a)), code: found.length === args.filter(a => !a.startsWith('-')).length ? 0 : 1 };
  },
  file(args, io) {
    const out = [];
    for (const f of args.filter(a => !a.startsWith('-'))) {
      const abs = io.sh.absolute(f), text = io.sh.readFile(f), name = abs.split('/').pop();
      if (INSTALLED[abs]) out.push(`${f}: ${INSTALLED[abs].script ? 'POSIX shell script, ASCII text executable' : 'ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, for GNU/Linux 3.2.0, stripped'}`);
      else if (text === null) out.push(`${f}: cannot open \`${f}' (No such file or directory)`);
      else if (!text.length) out.push(`${f}: empty`);
      else out.push(`${f}: ${/^\s*[[{]/.test(text) && /\.json$/.test(name) ? 'JSON data' : /^#!.*(ba)?sh/.test(text) ? 'Bourne-Again shell script, ASCII text executable' : /^#!.*python/.test(text) ? 'Python script, ASCII text executable' : /[^\x00-\x7f]/.test(text) ? 'Unicode text, UTF-8 text' : 'ASCII text'}`);
    }
    return { out };
  },
  seq(args) { const [a, b] = args.length === 1 ? [1, Number(args[0])] : [Number(args[0]), Number(args[1])]; return { out: Array.from({ length: Math.max(0, Math.min(10000, b - a + 1)) }, (_, k) => String(a + k)) }; },
  xargs(args, io) {
    const [set, rest, v] = flags(args, 'In');
    void set;
    const items = [...(io.stdin ?? [])].flatMap(l => (v.I ? [l] : l.split(/\s+/))).filter(Boolean);
    const [cmd = 'echo', ...base] = rest;
    const out = [], err = [];
    const run = (argv) => {
      const sink = { write: (l) => out.push(l) }, errs = { write: (l) => err.push(l) };
      io.sh.exec(argv, null, sink, errs);
    };
    if (v.I) for (const item of items) run([cmd, ...base.map(b => b.split(v.I).join(item))]);
    else if (v.n) for (let k = 0; k < items.length; k += Number(v.n)) run([cmd, ...base, ...items.slice(k, k + Number(v.n))]);
    else if (items.length) run([cmd, ...base, ...items]);
    return { out, err };
  },
  awk(args, io) {
    const [, operands, v] = flags(args, 'Fv');
    const program = operands.shift() ?? '';
    const r = inputs(operands, io, 'awk');
    return awk(program, v.F, r.lines);
  },
  sed(args, io) {
    const [set, operands, v] = flags(args, 'e');
    const script = v.e ?? operands.shift() ?? '';
    const inPlace = set.has('i');
    const run = (text) => sed(script, lines(text), set.has('n'));
    if (inPlace) {
      for (const f of operands) {
        const text = io.sh.readFile(f);
        if (text === null) return { err: [`sed: can't read ${f}: No such file or directory`], code: 2 };
        const result = run(text);
        if (result.error) return { err: [result.error], code: 1 };
        io.sh.writeFile(f, result.out.map(l => `${l}\n`).join(''));
      }
      return {};
    }
    const r = inputs(operands, io, 'sed');
    const result = sed(script, r.lines, set.has('n'));
    if (result.error) return { err: [result.error], code: 1 };
    return { out: result.out, err: r.err };
  },
  base64(args, io) {
    const text = [...(io.stdin ?? [])].join('\n');
    return args.includes('-d') || args.includes('--decode') ? { out: lines(Buffer.from(text, 'base64').toString('utf8')) } : { out: [Buffer.from(`${text}\n`).toString('base64')] };
  },
  column(_args, io) {
    const rows = [...(io.stdin ?? [])].map(l => l.split(/\s+/));
    const widths = [];
    for (const r of rows) r.forEach((c, k) => { widths[k] = Math.max(widths[k] ?? 0, c.length); });
    return { out: rows.map(r => r.map((c, k) => (k === r.length - 1 ? c : c.padEnd(widths[k]))).join('  ')) };
  },
  nl(args, io) { const r = inputs(args, io, 'nl'); return { out: [...r.lines].map((l, k) => `${String(k + 1).padStart(6)}\t${l}`) }; },
  rev(_a, io) { return { out: [...(io.stdin ?? [])].map(l => [...l].reverse().join('')) }; },
  diff(args, io) {
    const [, files] = flags(args);
    const a = io.sh.readFile(files[0] ?? ''), b = io.sh.readFile(files[1] ?? '');
    if (a === null || b === null) return { err: [`diff: ${a === null ? files[0] : files[1]}: No such file or directory`], code: 2 };
    const out = unifiedDiff(lines(a), lines(b), files[0], files[1]);
    return { out, code: out.length ? 1 : 0 };
  },
  vi: () => ({ err: ['Vim: Warning: Output is not to a terminal', 'Vim: Warning: Input is not from a terminal', '', 'Vim: Error reading input, exiting...'], code: 1 }),
  vim: () => TOOLS.vi(),
  nano: () => ({ err: ['Too many errors from stdin'], code: 1 }),
  sudo: (_a, io) => ({ err: [`${io.sh.env.USER} is not in the sudoers file.  This incident will be reported.`], code: 1 }),
  watch: () => ({ err: ['Error opening terminal: dumb.'], code: 1 }),
  top: () => ({ err: ['top: failed tty get'], code: 1 }),
  ssh: (args) => ({ err: [`ssh: connect to host ${args.find(a => !a.startsWith('-')) ?? ''} port 22: Connection timed out`], code: 255 }),
};
function* take(iterable, n) { if (n <= 0) return; let k = 0; for (const x of iterable) { yield x; if (++k >= n) return; } }
/** When the checkout was made: this morning, whatever day the session runs on. */
let checkedOut = 'Jan  1 08:12';
function long(name, text, user = 'oncall') { return `-rw-r--r-- 1 ${user} ${user} ${String(Buffer.byteLength(text)).padStart(5)} ${checkedOut} ${name}`; }
/** Where each program lives, as `which` and `type` report it. */
export function programPath(name) {
  if (['gcloud', 'gsutil', 'bq', 'kubectl', 'gke-gcloud-auth-plugin'].includes(name)) return `/usr/lib/google-cloud-sdk/bin/${name}`;
  if (name === 'cloud-sql-proxy') return '/usr/local/bin/cloud-sql-proxy';
  return `/usr/bin/${name}`;
}
/** Installed programs read as what they are: the Cloud SDK launchers are shell scripts, the rest binaries. */
const LAUNCHER = (tool) => `#!/bin/sh\n#\n# Copyright 2013 Google Inc. All Rights Reserved.\n#\n\n# <cloud-sdk-sh-preamble>\n#\n#  CLOUDSDK_ROOT_DIR            (a)  installation root dir\n#  CLOUDSDK_PYTHON              (u)  python interpreter path\n#  CLOUDSDK_PYTHON_ARGS         (u)  python interpreter arguments\n#  CLOUDSDK_PYTHON_SITEPACKAGES (u)  use python site packages\n#\n# (a) always defined by the preamble\n# (u) user definition overrides preamble\n\n_cloudsdk_root_dir() {\n  case $0 in\n  */*)   link=$0\n         ;;\n  *)     link=$(command -v "$0")\n         ;;\n  esac\n  case $link in\n  */*) ;;\n  *) link=./$link\n     ;;\n  esac\n  while [ -L "$link" ]; do\n    link=$(readlink "$link")\n  done\n  echo "$(dirname "$link")/.."\n}\n\nCLOUDSDK_ROOT_DIR=$(_cloudsdk_root_dir "$0")\n\n# </cloud-sdk-sh-preamble>\n\n"$CLOUDSDK_PYTHON" $CLOUDSDK_PYTHON_ARGS "\${CLOUDSDK_ROOT_DIR}/lib/${tool}.py" "$@"\n`;
const ELF = '\u007fELF\u0002\u0001\u0001\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0003\u0000>\u0000\u0001\u0000\u0000\u0000\u00a0\u0063\u0000\u0000\u0000\u0000\u0000\u0000@\u0000\u0000\u0000\u0000\u0000\u0000\u0000';
const INSTALLED = Object.fromEntries(['gcloud', 'gsutil', 'bq', 'kubectl', 'gke-gcloud-auth-plugin', 'cloud-sql-proxy', 'psql', 'curl', 'git', 'jq', 'gh', 'ssh', 'grep', 'awk', 'sed', 'bash', 'sh']
  .map(n => [programPath(n), ['gcloud', 'gsutil', 'bq'].includes(n) ? { script: LAUNCHER(n === 'gcloud' ? 'googlecloudsdk/gcloud' : n === 'gsutil' ? 'gsutil/gsutil' : 'bq/bq') } : { binary: ELF }]));
/** Basic regular expressions as grep reads them, translated to JavaScript's. */
function toJsRegex(pattern, extended) {
  if (extended) return pattern.replace(/\[\[:(\w+):\]\]/g, (_, c) => ({ digit: '\\d', space: '\\s', alpha: '[A-Za-z]', alnum: '[A-Za-z0-9]', upper: '[A-Z]', lower: '[a-z]' }[c] ?? '.'));
  let out = '';
  for (let k = 0; k < pattern.length; k++) {
    const c = pattern[k];
    if (c === '\\' && k + 1 < pattern.length) {
      const n = pattern[++k];
      out += '|(){}+?'.includes(n) ? n : `\\${n}`;
    } else out += '|(){}+?'.includes(c) ? `\\${c}` : c;
  }
  return out.replace(/\[\[:(\w+):\]\]/g, (_, c) => ({ digit: '\\d', space: '\\s', alpha: '[A-Za-z]', alnum: '[A-Za-z0-9]' }[c] ?? '.'));
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** What `date -d` accepts in practice: "now", "@1700000000", ISO dates, "-3 hours", "3 hours ago", "yesterday". */
function parseDate(spec, now) {
  const s = spec.trim().toLowerCase();
  if (!s || s === 'now') return now;
  if (/^@\d+$/.test(s)) return new Date(Number(s.slice(1)) * 1000);
  if (s === 'today') return now;
  if (s === 'yesterday') return new Date(now.getTime() - 86400000);
  if (s === 'tomorrow') return new Date(now.getTime() + 86400000);
  const unit = { sec: 1, second: 1, min: 60, minute: 60, hour: 3600, day: 86400, week: 604800 };
  let total = 0, matched = false;
  for (const m of s.matchAll(/([+-]?\s*\d+)\s*(sec|second|min|minute|hour|day|week)s?/g)) { total += Number(m[1].replace(/\s/g, '')) * unit[m[2]]; matched = true; }
  if (matched) { if (/\bago\b/.test(s)) total = -Math.abs(total); return new Date(now.getTime() + total * 1000); }
  const iso = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(spec) || !/\d:\d/.test(spec) ? spec : `${spec}Z`);
  return Number.isNaN(iso) ? null : new Date(iso);
}
export function strftime(format, d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return format.replace(/%([a-zA-Z%])/g, (_, c) => ({
    Y: d.getUTCFullYear(), m: p(d.getUTCMonth() + 1), d: p(d.getUTCDate()), e: String(d.getUTCDate()).padStart(2), H: p(d.getUTCHours()), M: p(d.getUTCMinutes()), S: p(d.getUTCSeconds()),
    a: DAYS[d.getUTCDay()], b: MONTHS[d.getUTCMonth()], s: Math.floor(d.getTime() / 1000), Z: 'UTC', z: '+0000', F: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, T: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`, '%': '%', N: '000000000',
  }[c] ?? `%${c}`));
}
/** The `print`, `NR`, `NF`, `-F` and `/re/` subset of awk that one-liners use. */
function awk(program, separator, input) {
  const m = /^\s*(?:(\/(?:[^/\\]|\\.)*\/|NR\s*[<>=!]=?\s*\d+|\$\d+\s*[=!]=\s*"[^"]*"|\$\d+\s*~\s*\/[^/]*\/)\s*)?(?:\{\s*(.*?)\s*\}\s*)?$/s.exec(program);
  if (!m) return { err: [`awk: cmd. line:1: ${program}`, 'awk: cmd. line:1: ^ syntax error'], code: 2 };
  const [, condition, action = 'print'] = m;
  const out = [];
  let nr = 0;
  const sums = {};
  const endMatch = /^(.*?)\s*}\s*END\s*\{\s*(.*)$/s.exec(program);
  if (endMatch) {
    // `{ s += $N } END { print s }`
    const add = /^\{?\s*(\w+)\s*\+=\s*\$(\d+)/.exec(endMatch[1].trim());
    for (const line of input) { const f = split(line); if (add) sums[add[1]] = (sums[add[1]] ?? 0) + (Number(f[Number(add[2]) - 1]) || 0); nr++; }
    const printed = /print\s+(\w+)/.exec(endMatch[2]);
    out.push(printed ? String(printed[1] === 'NR' ? nr : sums[printed[1]] ?? 0) : '');
    return { out };
  }
  function split(line) { return separator ? line.split(separator === '\\t' ? '\t' : separator) : line.trim().split(/\s+/); }
  for (const line of input) {
    nr++;
    const fields = split(line);
    const field = (k) => (k === 0 ? line : fields[k - 1] ?? '');
    if (condition) {
      let ok = true;
      if (condition.startsWith('/')) ok = new RegExp(condition.slice(1, -1)).test(line);
      else if (condition.startsWith('NR')) { const [, op, n] = /NR\s*([<>=!]=?)\s*(\d+)/.exec(condition); ok = compare(nr, op, Number(n)); }
      else if (/~/.test(condition)) { const [, k, re] = /\$(\d+)\s*~\s*\/([^/]*)\//.exec(condition); ok = new RegExp(re).test(field(Number(k))); }
      else { const [, k, op, s] = /\$(\d+)\s*([=!]=)\s*"([^"]*)"/.exec(condition); ok = op === '==' ? field(Number(k)) === s : field(Number(k)) !== s; }
      if (!ok) continue;
    }
    const print = /^print(?:f)?\s*(.*)$/.exec(action.replace(/;\s*$/, ''));
    if (!print) return { err: [`awk: cmd. line:1: ${program}`, 'awk: cmd. line:1: ^ syntax error'], code: 2 };
    const expr = print[1].trim();
    if (!expr || expr === '$0') { out.push(line); continue; }
    const pieces = [];
    for (const term of expr.match(/"[^"]*"|\$\w+|NR|NF|,|[^\s,"$]+/g) ?? []) {
      if (term === ',') pieces.push(' ');
      else if (term.startsWith('"')) pieces.push(term.slice(1, -1));
      else if (term === 'NR') pieces.push(String(nr));
      else if (term === 'NF') pieces.push(String(fields.length));
      else if (term === '$NF') pieces.push(fields.at(-1) ?? '');
      else if (term.startsWith('$')) pieces.push(field(Number(term.slice(1))));
    }
    out.push(pieces.join('').replace(/\\t/g, '\t'));
  }
  return { out };
}
const compare = (a, op, b) => ({ '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b, '==': a === b, '!=': a !== b }[op] ?? false);
/** `s/a/b/[g]`, `/re/d`, `/re/p` with -n, and `Np`/`N,Mp` line ranges. */
function sed(script, input, quiet) {
  const commands = script.split(/;\s*(?=[s\d/])/).map(s => s.trim()).filter(Boolean);
  const out = [];
  let k = 0;
  for (const line of input) {
    k++;
    let text = line, deleted = false, printed = false;
    for (const c of commands) {
      const s = /^s(.)(.*?)\1(.*?)\1([gip]*)$/.exec(c);
      if (s) {
        const re = new RegExp(toJsRegex(s[2], false), s[4].includes('g') ? 'g' : '' + (s[4].includes('i') ? 'i' : ''));
        const before = text;
        text = text.replace(re, s[3].replace(/\\(\d)/g, '$$$1').replace(/&/g, '$$&'));
        if (s[4].includes('p') && before !== text) printed = true;
        continue;
      }
      const range = /^(\d+)(?:,(\d+|\$))?([pd])$/.exec(c);
      if (range) {
        const lo = Number(range[1]), hi = range[2] === '$' ? Infinity : Number(range[2] ?? range[1]);
        if (k >= lo && k <= hi) { if (range[3] === 'd') deleted = true; else printed = true; }
        continue;
      }
      const pattern = /^\/(.*)\/([pd])$/.exec(c);
      if (pattern) {
        if (new RegExp(toJsRegex(pattern[1], false)).test(text)) { if (pattern[2] === 'd') deleted = true; else printed = true; }
        continue;
      }
      return { error: `sed: -e expression #1, char ${c.length}: unknown command: \`${c[0]}'` };
    }
    if (deleted) continue;
    if (!quiet) out.push(text);
    if (printed) out.push(text);
  }
  return { out };
}
/** A small unified diff, for `diff -u` and `git diff`. */
export function unifiedDiff(a, b, from = 'a', to = 'b') {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push([' ', a[i], i, j]); i++; j++; }
    // Removals before additions, as diff and git print a changed line.
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { ops.push(['-', a[i], i, j]); i++; }
    else { ops.push(['+', b[j], i, j]); j++; }
  }
  if (ops.every(o => o[0] === ' ')) return [];
  const out = [`--- ${from}`, `+++ ${to}`];
  const changed = ops.map((o, k) => (o[0] !== ' ' ? k : -1)).filter(k => k >= 0);
  let k = 0;
  while (k < changed.length) {
    let start = Math.max(0, changed[k] - 3), end = Math.min(ops.length, changed[k] + 4);
    while (k + 1 < changed.length && changed[k + 1] - 3 <= end) { k++; end = Math.min(ops.length, changed[k] + 4); }
    const hunk = ops.slice(start, end);
    const aStart = hunk[0][2] + 1, bStart = hunk[0][3] + 1;
    out.push(`@@ -${aStart},${hunk.filter(o => o[0] !== '+').length} +${bStart},${hunk.filter(o => o[0] !== '-').length} @@`);
    for (const o of hunk) out.push(`${o[0]}${o[1]}`);
    k++;
    void start;
  }
  return out;
}
