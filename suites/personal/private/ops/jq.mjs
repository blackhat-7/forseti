/**
 * The part of jq that operators reach for with `-o json`: paths, iteration, pipes, select, map,
 * length, keys, object and array construction, comparison and `//`. Anything past that fails the
 * way jq does, with a compile error, rather than silently doing something else.
 */
import { UsageError, lines } from './shell.mjs';

export function jq(args, io) {
  let raw = false, compact = false, slurp = false, nullInput = false, exitStatus = false;
  const rest = [];
  const vars = { __now: io.sh.now().getTime() / 1000 };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--arg') { vars[args[k + 1]] = args[k + 2]; k += 2; continue; }
    if (a === '--argjson') { try { vars[args[k + 1]] = JSON.parse(args[k + 2]); } catch { throw new UsageError(`jq: Invalid JSON text passed to --argjson`, 2); } k += 2; continue; }
    if (/^-[a-zA-Z]+$/.test(a)) {
      for (const f of a.slice(1)) { if (f === 'r' || f === 'j') raw = true; else if (f === 'c') compact = true; else if (f === 's') slurp = true; else if (f === 'n') nullInput = true; else if (f === 'e') exitStatus = true; }
      continue;
    }
    if (a === '--raw-output') { raw = true; continue; }
    if (a === '--compact-output') { compact = true; continue; }
    if (a === '--slurp') { slurp = true; continue; }
    rest.push(a);
  }
  const [filter = '.', ...files] = rest;
  let ast;
  try { ast = new Parser(filter).parse(); }
  catch (e) { return { err: [`jq: error: ${e.message}`, 'jq: 1 compile error'], code: 3 }; }
  let text;
  if (files.length) {
    const read = files.map(f => io.sh.readFile(f));
    const missing = files.find((_, k) => read[k] === null);
    if (missing) return { err: [`jq: error: Could not open ${missing}: No such file or directory`], code: 2 };
    text = read.join('\n');
  } else text = [...(io.stdin ?? [])].join('\n');
  let inputs;
  try { inputs = nullInput ? [null] : parseMany(text); }
  catch (e) { return { err: [`jq: error (at <stdin>:${lines(text).length}): ${e.message}`], code: 2 }; }
  if (slurp) inputs = [inputs];
  const out = [];
  let last;
  try {
    for (const input of inputs) for (const v of evaluate(ast, input, vars)) { last = v; out.push(...lines(raw && typeof v === 'string' ? v : JSON.stringify(v, null, compact ? 0 : 2) + '\n')); }
  } catch (e) { return { out, err: [`jq: error (at <stdin>:${lines(text).length}): ${e.message}`], code: 5 }; }
  return { out, code: exitStatus && (last === null || last === false || last === undefined) ? 1 : 0 };
}
/** jq accepts a stream of JSON values separated by whitespace. */
function parseMany(text) {
  const values = [];
  let k = 0;
  while (k < text.length) {
    while (k < text.length && /\s/.test(text[k])) k++;
    if (k >= text.length) break;
    let depth = 0, inString = false, end = k;
    for (; end < text.length; end++) {
      const c = text[end];
      if (inString) { if (c === '\\') end++; else if (c === '"') inString = false; if (depth === 0 && !inString) { end++; break; } continue; }
      if (c === '"') { inString = true; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) { end++; break; } }
      else if (depth === 0 && /\s/.test(c)) break;
    }
    const chunk = text.slice(k, end);
    try { values.push(JSON.parse(chunk)); }
    catch { throw new Error(`Invalid numeric literal at line 1, column ${k + 1}`); }
    k = end;
  }
  return values;
}

class Parser {
  constructor(src) { this.src = src; this.k = 0; }
  parse() { const node = this.pipe(); this.ws(); if (this.k < this.src.length) throw new Error(`syntax error, unexpected '${this.src[this.k]}'`); return node; }
  ws() { while (/\s/.test(this.src[this.k] ?? '')) this.k++; }
  eat(s) { this.ws(); if (this.src.startsWith(s, this.k)) { this.k += s.length; return true; } return false; }
  expect(s) { if (!this.eat(s)) throw new Error(`syntax error, expected '${s}'`); }
  pipe() {
    let left = this.comma();
    // `expr as $name | body`: body runs once per value of expr, with $name bound to it.
    if (this.word('as')) {
      this.ws();
      if (this.src[this.k] !== '$') throw new Error(`syntax error, unexpected '${this.src[this.k] ?? 'end of file'}', expecting '$' or '[' or '{'`);
      this.k++;
      const name = /^[A-Za-z_]\w*/.exec(this.src.slice(this.k))[0];
      this.k += name.length;
      this.expect('|');
      return { t: 'bind', source: left, name, body: this.pipe() };
    }
    while (this.peekOp('|')) { this.k++; left = { t: 'pipe', left, right: this.comma() }; }
    return left;
  }
  peekOp(op) { this.ws(); return this.src.startsWith(op, this.k) && !(op === '|' && this.src[this.k + 1] === '='); }
  comma() {
    let left = this.alt();
    while (this.peekOp(',')) { this.k++; left = { t: 'comma', left, right: this.alt() }; }
    return left;
  }
  alt() {
    let left = this.or();
    while (this.peekOp('//')) { this.k += 2; left = { t: 'alt', left, right: this.or() }; }
    return left;
  }
  or() { let left = this.and(); while (this.word('or')) left = { t: 'or', left, right: this.and() }; return left; }
  and() { let left = this.cmp(); while (this.word('and')) left = { t: 'and', left, right: this.cmp() }; return left; }
  word(w) { this.ws(); if (this.src.startsWith(w, this.k) && !/\w/.test(this.src[this.k + w.length] ?? '')) { this.k += w.length; return true; } return false; }
  cmp() {
    const left = this.add();
    this.ws();
    for (const op of ['==', '!=', '<=', '>=', '<', '>']) if (this.src.startsWith(op, this.k)) { this.k += op.length; return { t: 'cmp', op, left, right: this.add() }; }
    return left;
  }
  add() {
    let left = this.mul();
    for (;;) { this.ws(); const c = this.src[this.k]; if ((c === '+' || c === '-') && this.src[this.k + 1] !== '=') { this.k++; left = { t: 'arith', op: c, left, right: this.mul() }; } else return left; }
  }
  mul() {
    let left = this.postfix();
    for (;;) { this.ws(); const c = this.src[this.k]; if ((c === '*' || c === '%' || (c === '/' && this.src[this.k + 1] !== '/')) ) { this.k++; left = { t: 'arith', op: c, left, right: this.postfix() }; } else return left; }
  }
  postfix() {
    let node = this.primary();
    for (;;) {
      if (this.src[this.k] === '.' && /[A-Za-z_"]/.test(this.src[this.k + 1] ?? '')) { this.k++; node = { t: 'pipe', left: node, right: this.field() }; continue; }
      if (this.src[this.k] === '[') {
        // In `x[expr]` the subscript is computed from the input, as jq does, not from `x`.
        const b = this.bracket();
        node = b.t === 'index' ? { t: 'subscript', target: node, index: b.index } : { t: 'pipe', left: node, right: b };
        continue;
      }
      if (this.src[this.k] === '?') { this.k++; node = { t: 'try', body: node }; continue; }
      return node;
    }
  }
  field() {
    if (this.src[this.k] === '"') return { t: 'field', name: this.string() };
    const m = /^[A-Za-z_][\w]*/.exec(this.src.slice(this.k));
    this.k += m[0].length;
    return { t: 'field', name: m[0] };
  }
  string() {
    let end = this.k + 1, s = '';
    while (end < this.src.length && this.src[end] !== '"') { if (this.src[end] === '\\') { s += JSON.parse(`"${this.src.slice(end, end + 2)}"`); end += 2; continue; } s += this.src[end++]; }
    this.k = end + 1;
    return s;
  }
  /** A string literal, with `\\(expr)` interpolation as jq has it. */
  interpolated() {
    const parts = [];
    let k = this.k + 1, text = '';
    while (k < this.src.length && this.src[k] !== '"') {
      if (this.src[k] === '\\' && this.src[k + 1] === '(') {
        let depth = 1, j = k + 2, quote = false;
        for (; j < this.src.length && depth; j++) {
          const ch = this.src[j];
          if (quote) { if (ch === '\\') j++; else if (ch === '"') quote = false; continue; }
          if (ch === '"') quote = true; else if (ch === '(') depth++; else if (ch === ')') depth--;
        }
        if (text) parts.push({ t: 'literal', value: text });
        text = '';
        parts.push(new Parser(this.src.slice(k + 2, j - 1)).parse());
        k = j;
        continue;
      }
      if (this.src[k] === '\\') { text += JSON.parse(`"${this.src.slice(k, k + 2)}"`); k += 2; continue; }
      text += this.src[k++];
    }
    if (k >= this.src.length) throw new Error('syntax error, unexpected end of file, expecting QQSTRING_TEXT or QQSTRING_INTERP_START or QQSTRING_END');
    this.k = k + 1;
    if (parts.every(p => p.t === 'literal') && !parts.length) return { t: 'literal', value: text };
    if (text) parts.push({ t: 'literal', value: text });
    return parts.length === 1 && parts[0].t === 'literal' ? parts[0] : { t: 'format', parts };
  }
  bracket() {
    this.expect('[');
    if (this.eat(']')) return { t: 'iterate' };
    const index = this.pipe();
    if (this.eat(':')) { const end = this.src[this.k] === ']' ? null : this.pipe(); this.expect(']'); return { t: 'slice', from: index, to: end }; }
    this.expect(']');
    return { t: 'index', index };
  }
  primary() {
    this.ws();
    const c = this.src[this.k];
    if (c === '.') {
      this.k++;
      if (this.src[this.k] === '.') { this.k++; return { t: 'recurse' }; }
      if (/[A-Za-z_"]/.test(this.src[this.k] ?? '')) return this.field();
      return { t: 'identity' };
    }
    if (c === '"') return this.interpolated();
    if (c === '(') { this.k++; const node = this.pipe(); this.expect(')'); return node; }
    if (c === '[') { this.k++; if (this.eat(']')) return { t: 'array', body: null }; const body = this.pipe(); this.expect(']'); return { t: 'array', body }; }
    if (c === '{') return this.object();
    if (c === '$') { this.k++; const m = /^[A-Za-z_]\w*/.exec(this.src.slice(this.k)); this.k += m[0].length; return { t: 'var', name: m[0] }; }
    if (c === '-' || /\d/.test(c ?? '')) { const m = /^-?\d+(\.\d+)?/.exec(this.src.slice(this.k)); this.k += m[0].length; return { t: 'literal', value: Number(m[0]) }; }
    const m = /^[A-Za-z_][\w]*/.exec(this.src.slice(this.k));
    if (!m) throw new Error(`syntax error, unexpected '${c ?? 'end of file'}'`);
    this.k += m[0].length;
    const name = m[0];
    if (name === 'true' || name === 'false') return { t: 'literal', value: name === 'true' };
    if (name === 'null') return { t: 'literal', value: null };
    if (name === 'not') return { t: 'call', name };
    if (name === 'if') {
      const cond = this.pipe();
      if (!this.word('then')) throw new Error('syntax error, expected then');
      const then = this.pipe();
      let otherwise = { t: 'identity' };
      if (this.word('elif')) throw new Error('syntax error, elif is not supported');
      if (this.word('else')) otherwise = this.pipe();
      if (!this.word('end')) throw new Error('syntax error, expected end');
      return { t: 'if', cond, then, otherwise };
    }
    const args = [];
    if (this.src[this.k] === '(') {
      this.k++;
      args.push(this.pipe());
      while (this.eat(';')) args.push(this.pipe());
      this.expect(')');
    }
    if (!FUNCTIONS.has(name)) throw new Error(`${name}/${args.length} is not defined`);
    return { t: 'call', name, args };
  }
  object() {
    this.expect('{');
    const entries = [];
    if (!this.eat('}')) {
      do {
        this.ws();
        let key;
        if (this.src[this.k] === '"') key = { t: 'literal', value: this.string() };
        else if (this.src[this.k] === '(') { this.k++; key = this.pipe(); this.expect(')'); }
        else if (this.src[this.k] === '$') { this.k++; const m = /^\w+/.exec(this.src.slice(this.k)); this.k += m[0].length; entries.push({ key: { t: 'literal', value: m[0] }, value: { t: 'var', name: m[0] } }); continue; }
        else { const m = /^[A-Za-z_]\w*/.exec(this.src.slice(this.k)); if (!m) throw new Error('syntax error in object'); this.k += m[0].length; key = { t: 'literal', value: m[0] }; }
        const value = this.eat(':') ? this.alt() : { t: 'field', name: key.value };
        entries.push({ key, value });
      } while (this.eat(','));
      this.expect('}');
    }
    return { t: 'object', entries };
  }
}
const FUNCTIONS = new Set(['length', 'keys', 'values', 'select', 'map', 'map_values', 'has', 'type', 'not', 'first', 'last', 'sort', 'sort_by', 'group_by', 'unique', 'unique_by', 'min', 'max', 'min_by', 'max_by', 'add', 'to_entries', 'from_entries', 'with_entries', 'tostring', 'tonumber', 'ascii_downcase', 'ascii_upcase', 'test', 'startswith', 'endswith', 'contains', 'split', 'join', 'reverse', 'any', 'all', 'empty', 'flatten', 'range', 'floor', 'sqrt', 'tojson', 'fromjson', 'env', 'ltrimstr', 'rtrimstr', 'limit', 'del', 'index', 'paths', 'in', 'inside', 'error', 'debug', 'now', 'todate', 'fromdate', 'splits', 'sub', 'gsub', 'match', 'capture', 'indices', 'isempty', 'input', 'recurse', 'ascii', 'objects', 'arrays', 'strings', 'numbers', 'nulls', 'iterables', 'scalars', 'count']);

function* evaluate(node, input, vars) {
  switch (node.t) {
    case 'identity': yield input; return;
    case 'recurse': yield* recurse(input); return;
    case 'literal': yield node.value; return;
    case 'format': {
      let results = [''];
      for (const part of node.parts) {
        const values = part.t === 'literal' ? [part.value] : [...evaluate(part, input, vars)].map(v => (typeof v === 'string' && part.t !== 'literal' ? v : part.t === 'literal' ? v : JSON.stringify(v)));
        results = results.flatMap(r => values.map(v => r + v));
      }
      yield* results; return;
    }
    case 'var': if (!(node.name in vars)) throw new Error(`$${node.name} is not defined`); yield vars[node.name]; return;
    case 'field':
      if (input === null) { yield null; return; }
      if (typeof input !== 'object' || Array.isArray(input)) throw new Error(`Cannot index ${typeOf(input)} with "${node.name}"`);
      yield input[node.name] ?? null; return;
    case 'iterate':
      if (Array.isArray(input)) { yield* input; return; }
      if (input && typeof input === 'object') { yield* Object.values(input); return; }
      throw new Error(`Cannot iterate over ${typeOf(input)}${input === null ? '' : ` (${JSON.stringify(input)})`}`);
    case 'index':
      for (const i of evaluate(node.index, input, vars)) {
        if (input === null) { yield null; continue; }
        if (Array.isArray(input) && typeof i === 'number') { yield input.at(i) ?? null; continue; }
        if (input && typeof input === 'object' && !Array.isArray(input) && typeof i === 'string') { yield input[i] ?? null; continue; }
        throw new Error(`Cannot index ${typeOf(input)} with ${typeOf(i)}`);
      }
      return;
    case 'slice': {
      const from = node.from ? [...evaluate(node.from, input, vars)][0] : 0;
      const to = node.to ? [...evaluate(node.to, input, vars)][0] : undefined;
      yield input?.slice(from ?? 0, to ?? undefined) ?? null; return;
    }
    case 'pipe': for (const v of evaluate(node.left, input, vars)) yield* evaluate(node.right, v, vars); return;
    case 'subscript':
      for (const i of evaluate(node.index, input, vars)) for (const target of evaluate(node.target, input, vars)) yield* evaluate({ t: 'index', index: { t: 'literal', value: i } }, target, vars);
      return;
    case 'bind': for (const v of evaluate(node.source, input, vars)) yield* evaluate(node.body, input, { ...vars, [node.name]: v }); return;
    case 'comma': yield* evaluate(node.left, input, vars); yield* evaluate(node.right, input, vars); return;
    case 'try': try { yield* [...evaluate(node.body, input, vars)]; } catch { /* `?` drops errors */ } return;
    case 'alt': {
      const left = [...(function* () { try { yield* evaluate(node.left, input, vars); } catch { /* treated as empty */ } })()].filter(v => v !== null && v !== false);
      if (left.length) yield* left; else yield* evaluate(node.right, input, vars);
      return;
    }
    case 'and': for (const l of evaluate(node.left, input, vars)) { if (!truthy(l)) { yield false; continue; } for (const r of evaluate(node.right, input, vars)) yield truthy(r); } return;
    case 'or': for (const l of evaluate(node.left, input, vars)) { if (truthy(l)) { yield true; continue; } for (const r of evaluate(node.right, input, vars)) yield truthy(r); } return;
    case 'cmp':
      for (const r of evaluate(node.right, input, vars)) for (const l of evaluate(node.left, input, vars)) {
        const c = order(l, r);
        yield { '==': c === 0, '!=': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[node.op];
      }
      return;
    case 'arith':
      for (const r of evaluate(node.right, input, vars)) for (const l of evaluate(node.left, input, vars)) yield arith(node.op, l, r);
      return;
    case 'array': yield node.body ? [...evaluate(node.body, input, vars)] : []; return;
    case 'object': {
      let results = [{}];
      for (const e of node.entries) {
        const next = [];
        for (const partial of results) for (const k of evaluate(e.key, input, vars)) for (const v of evaluate(e.value, input, vars)) {
          if (typeof k !== 'string') throw new Error(`Object keys must be strings`);
          next.push({ ...partial, [k]: v });
        }
        results = next;
      }
      yield* results; return;
    }
    case 'if':
      for (const c of evaluate(node.cond, input, vars)) yield* evaluate(truthy(c) ? node.then : node.otherwise, input, vars);
      return;
    case 'call': yield* call(node, input, vars); return;
  }
}
function* recurse(v) { yield v; if (v && typeof v === 'object') for (const x of Object.values(v)) yield* recurse(x); }
const truthy = (v) => v !== null && v !== false && v !== undefined;
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);
const RANK = { null: 0, boolean: 1, number: 2, string: 3, array: 4, object: 5 };
function order(a, b) {
  const ta = typeOf(a), tb = typeOf(b);
  if (ta !== tb) return RANK[ta] - RANK[tb];
  if (ta === 'array') { for (let k = 0; k < Math.min(a.length, b.length); k++) { const c = order(a[k], b[k]); if (c) return c; } return a.length - b.length; }
  if (ta === 'object') return JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}
function arith(op, l, r) {
  if (op === '+') {
    if (l === null) return r;
    if (r === null) return l;
    if (typeof l === 'number' && typeof r === 'number') return l + r;
    if (typeof l === 'string' && typeof r === 'string') return l + r;
    if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
    if (typeOf(l) === 'object' && typeOf(r) === 'object') return { ...l, ...r };
    throw new Error(`${typeOf(l)} (${JSON.stringify(l)}) and ${typeOf(r)} (${JSON.stringify(r)}) cannot be added`);
  }
  if (op === '-' && Array.isArray(l) && Array.isArray(r)) return l.filter(x => !r.some(y => order(x, y) === 0));
  if (typeof l !== 'number' || typeof r !== 'number') throw new Error(`${typeOf(l)} (${JSON.stringify(l)}) and ${typeOf(r)} (${JSON.stringify(r)}) cannot be ${{ '-': 'subtracted', '*': 'multiplied', '/': 'divided', '%': 'divided' }[op]}`);
  return { '-': l - r, '*': l * r, '/': l / r, '%': l % r }[op];
}
function* call({ name, args = [] }, input, vars) {
  const one = (k, v = input) => [...evaluate(args[k], v, vars)][0];
  const all = (k, v = input) => [...evaluate(args[k], v, vars)];
  switch (name) {
    case 'length': yield input === null ? 0 : typeof input === 'string' || Array.isArray(input) ? input.length : typeof input === 'object' ? Object.keys(input).length : Math.abs(input); return;
    case 'keys': yield Array.isArray(input) ? input.map((_, k) => k) : Object.keys(input ?? {}).sort(); return;
    case 'values': if (input !== null) yield input; return;
    case 'select': for (const c of evaluate(args[0], input, vars)) if (truthy(c)) yield input; return;
    case 'map': yield (Array.isArray(input) ? input : Object.values(input ?? {})).flatMap(v => all(0, v)); return;
    case 'map_values': yield Array.isArray(input) ? input.map(v => one(0, v)) : Object.fromEntries(Object.entries(input ?? {}).map(([k, v]) => [k, one(0, v)])); return;
    case 'has': yield Array.isArray(input) ? one(0) < input.length : Object.hasOwn(input ?? {}, one(0)); return;
    case 'type': yield typeOf(input); return;
    case 'not': yield !truthy(input); return;
    case 'empty': return;
    case 'first': if (args.length) { const v = all(0); if (v.length) yield v[0]; } else yield input?.[0] ?? null; return;
    case 'last': if (args.length) { const v = all(0); if (v.length) yield v.at(-1); } else yield input?.at?.(-1) ?? null; return;
    case 'limit': { const n = one(0); yield* all(1).slice(0, n); return; }
    case 'sort': yield [...input].sort(order); return;
    case 'sort_by': yield [...input].sort((a, b) => order(one(0, a), one(0, b))); return;
    case 'group_by': {
      const groups = new Map();
      for (const v of [...input].sort((a, b) => order(one(0, a), one(0, b)))) { const k = JSON.stringify(one(0, v)); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(v); }
      yield [...groups.values()]; return;
    }
    case 'unique': yield [...new Map(input.map(v => [JSON.stringify(v), v])).values()].sort(order); return;
    case 'unique_by': yield [...new Map(input.map(v => [JSON.stringify(one(0, v)), v])).values()]; return;
    case 'min': yield input.length ? [...input].sort(order)[0] : null; return;
    case 'max': yield input.length ? [...input].sort(order).at(-1) : null; return;
    case 'min_by': yield input.length ? [...input].sort((a, b) => order(one(0, a), one(0, b)))[0] : null; return;
    case 'max_by': yield input.length ? [...input].sort((a, b) => order(one(0, a), one(0, b))).at(-1) : null; return;
    case 'add': yield (Array.isArray(input) ? input : Object.values(input ?? {})).reduce((s, v) => arith('+', s, v), null); return;
    case 'any': yield (args.length ? input.map(v => one(0, v)) : input).some(truthy); return;
    case 'all': yield (args.length ? input.map(v => one(0, v)) : input).every(truthy); return;
    case 'flatten': yield input.flat(args.length ? one(0) : Infinity); return;
    case 'range': { const [a, b] = args.length === 1 ? [0, one(0)] : [one(0), one(1)]; for (let k = a; k < b; k++) yield k; return; }
    case 'floor': yield Math.floor(input); return;
    case 'sqrt': yield Math.sqrt(input); return;
    case 'to_entries': yield Object.entries(input ?? {}).map(([key, value]) => ({ key, value })); return;
    case 'from_entries': yield Object.fromEntries(input.map(e => [e.key ?? e.name ?? e.k, e.value ?? e.v])); return;
    case 'with_entries': yield Object.fromEntries(Object.entries(input ?? {}).map(([key, value]) => ({ key, value })).flatMap(e => all(0, e)).map(e => [e.key, e.value])); return;
    case 'tostring': yield typeof input === 'string' ? input : JSON.stringify(input); return;
    case 'tonumber': { const n = Number(input); if (Number.isNaN(n)) throw new Error(`Cannot parse '${input}' as JSON`); yield n; return; }
    case 'tojson': yield JSON.stringify(input); return;
    case 'fromjson': yield JSON.parse(input); return;
    case 'ascii_downcase': yield String(input).toLowerCase(); return;
    case 'ascii_upcase': yield String(input).toUpperCase(); return;
    case 'test': yield new RegExp(one(0), args[1] ? one(1).replace(/[^imsu]/g, '') : '').test(input); return;
    case 'match': { const m = new RegExp(one(0)).exec(input); if (m) yield { offset: m.index, length: m[0].length, string: m[0], captures: m.slice(1).map(s => ({ string: s })) }; return; }
    case 'capture': { const m = new RegExp(one(0)).exec(input); if (m) yield { ...(m.groups ?? {}) }; return; }
    case 'sub': yield String(input).replace(new RegExp(one(0)), one(1)); return;
    case 'gsub': yield String(input).replace(new RegExp(one(0), 'g'), one(1)); return;
    case 'startswith': yield String(input).startsWith(one(0)); return;
    case 'endswith': yield String(input).endsWith(one(0)); return;
    case 'ltrimstr': { const s = one(0); yield typeof input === 'string' && input.startsWith(s) ? input.slice(s.length) : input; return; }
    case 'rtrimstr': { const s = one(0); yield typeof input === 'string' && input.endsWith(s) ? input.slice(0, -s.length) : input; return; }
    case 'contains': { const b = one(0); yield typeof input === 'string' ? input.includes(b) : JSON.stringify(input).includes(JSON.stringify(b).replace(/^[[{]|[\]}]$/g, '')); return; }
    case 'inside': { const b = one(0); yield typeof b === 'string' ? b.includes(input) : false; return; }
    case 'index': { const s = one(0); const k = String(input).indexOf(s); yield k < 0 ? null : k; return; }
    case 'indices': { const s = one(0); const out = []; for (let k = String(input).indexOf(s); k >= 0; k = String(input).indexOf(s, k + 1)) out.push(k); yield out; return; }
    case 'split': yield String(input).split(one(0)); return;
    case 'splits': yield* String(input).split(new RegExp(one(0))); return;
    case 'join': { const sep = one(0); yield input.map(v => (v === null ? '' : String(v))).join(sep); return; }
    case 'reverse': yield typeof input === 'string' ? [...input].reverse().join('') : [...input].reverse(); return;
    case 'del': { const clone = structuredClone(input); const target = args[0]; if (target.t === 'field') delete clone[target.name]; yield clone; return; }
    case 'paths': { const out = []; const walk = (v, p) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { const key = Array.isArray(v) ? Number(k) : k; out.push([...p, key]); walk(x, [...p, key]); } }; walk(input, []); yield* out; return; }
    case 'in': yield Object.hasOwn(one(0) ?? {}, input); return;
    case 'isempty': yield all(0).length === 0; return;
    case 'error': throw new Error(args.length ? String(one(0)) : String(input));
    case 'debug': yield input; return;
    case 'env': yield {}; return;
    case 'now': yield vars.__now; return;
    case 'todate': yield new Date(input * 1000).toISOString().replace(/\.\d+Z$/, 'Z'); return;
    case 'fromdate': yield Date.parse(input) / 1000; return;
    case 'recurse': yield* recurse(input); return;
    case 'objects': if (typeOf(input) === 'object') yield input; return;
    case 'arrays': if (Array.isArray(input)) yield input; return;
    case 'strings': if (typeof input === 'string') yield input; return;
    case 'numbers': if (typeof input === 'number') yield input; return;
    case 'nulls': if (input === null) yield input; return;
    case 'iterables': if (input && typeof input === 'object') yield input; return;
    case 'scalars': if (!input || typeof input !== 'object') yield input; return;
    default: throw new Error(`${name}/${args.length} is not defined`);
  }
}
