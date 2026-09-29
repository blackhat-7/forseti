/**
 * `psql` against an in-memory SQLite database dressed as PostgreSQL 15.
 *
 *   makePsql(ctx, { resolve })
 *   resolve({ host, port, dbname, user }) returns either { error, wait? } (printed after
 *   `psql: error: `, exit 2) or a connection:
 *     { db: DatabaseSync, name: instance name, readOnly?, settings?: {name: value},
 *       activity?: () => rows for pg_stat_activity, owners?: Set of table names the user does not own }
 *
 * Behaviour follows psql 15: `-c` runs its statements as one implicit transaction and stops at the
 * first error; files and stdin run statement by statement, keep going after an error unless
 * ON_ERROR_STOP is set, and an explicit BEGIN left open when the session ends is rolled back.
 * Writes are reported as ctx.event('sql.statement', { instance, verb, table, sources, rows, sql })
 * when they commit, never before, so a rolled-back fix leaves no trace but a 'sql.rollback' event.
 * Copies out ('COPY ... TO STDOUT', '\copy ... to file') are reported as 'sql.export'.
 */
import { lines } from './shell.mjs';

const TS = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|UTC|[+-]\d{2}(?::?\d{2})?)?$/i;
/** Canonical storage for timestamptz: UTC, second precision, no offset. */
export const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
function normalizeTimestamp(text) {
  const m = TS.exec(text.trim());
  if (!m || !m[2]) return null;
  const [, date, h, mi, s = '00', zone] = m;
  let offset = 0;
  if (zone && !/^(z|utc)$/i.test(zone)) {
    const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
    offset = (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3] ?? 0));
  }
  const ms = Date.parse(`${date}T${h}:${mi}:${s}Z`) - offset * 60000;
  return Number.isNaN(ms) ? null : stamp(ms);
}
const UNITS = { microsecond: 1e-6, microseconds: 1e-6, us: 1e-6, millisecond: 1e-3, milliseconds: 1e-3, ms: 1e-3, second: 1, seconds: 1, sec: 1, secs: 1, s: 1, minute: 60, minutes: 60, min: 60, mins: 60, m: 60, hour: 3600, hours: 3600, hr: 3600, hrs: 3600, h: 3600, day: 86400, days: 86400, d: 86400, week: 604800, weeks: 604800, w: 604800 };
function intervalParts(spec) {
  let seconds = 0, months = 0, matched = false;
  for (const [, n, unit] of String(spec).toLowerCase().matchAll(/(-?\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
    matched = true;
    if (/^mon(th)?s?$/.test(unit)) months += Number(n);
    else if (/^y(ea)?rs?$/.test(unit)) months += 12 * Number(n);
    else if (UNITS[unit] !== undefined) seconds += Number(n) * UNITS[unit];
    else return null;
  }
  const clock = /(-)?(\d+):(\d{2})(?::(\d{2}))?/.exec(spec);
  if (clock) { matched = true; seconds += (clock[1] ? -1 : 1) * (Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4] ?? 0)); }
  return matched ? { seconds, months } : null;
}
function shift(ts, sign, spec) {
  if (ts === null || ts === undefined) return null;
  const base = normalizeTimestamp(String(ts)) ?? (/^\d{4}-\d{2}-\d{2}$/.test(String(ts)) ? `${ts} 00:00:00` : null);
  const parts = intervalParts(spec);
  if (!base || !parts) return null;
  const d = new Date(`${base.replace(' ', 'T')}Z`);
  const k = sign === '-' ? -1 : 1;
  d.setUTCMonth(d.getUTCMonth() + k * parts.months);
  return stamp(d.getTime() + k * parts.seconds * 1000);
}

/** Splits SQL text into statements, with the line each one ends on. */
export function splitSql(text) {
  const out = [];
  let buf = '', i = 0, line = 1, quote = null, dollar = null;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') line++;
    if (dollar) { if (text.startsWith(dollar, i)) { buf += dollar; i += dollar.length; dollar = null; continue; } buf += c; i++; continue; }
    if (quote) { buf += c; i++; if (c === quote) { if (text[i] === quote) { buf += text[i]; i++; } else quote = null; } continue; }
    if (c === "'" || c === '"') { quote = c; buf += c; i++; continue; }
    if (c === '$') { const m = /^\$\w*\$/.exec(text.slice(i)); if (m) { dollar = m[0]; buf += m[0]; i += m[0].length; continue; } }
    if (c === '-' && text[i + 1] === '-') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); const skipped = text.slice(i, end < 0 ? text.length : end + 2); line += (skipped.match(/\n/g) ?? []).length; i = end < 0 ? text.length : end + 2; buf += ' '; continue; }
    if (c === ';') { if (buf.trim()) out.push({ sql: buf.trim(), line }); buf = ''; i++; continue; }
    buf += c; i++;
  }
  if (buf.trim()) out.push({ sql: buf.trim(), line, unterminated: true });
  return out;
}
/** Replaces literals with placeholders so rewrites never touch quoted text. */
function protect(sql) {
  const literals = [];
  let out = '', i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || ((c === 'E' || c === 'e') && sql[i + 1] === "'" && !/\w/.test(sql[i - 1] ?? ''))) {
      const start = c === "'" ? i : i + 1;
      let j = start + 1, value = '';
      for (; j < sql.length; j++) {
        if (sql[j] === "'") { if (sql[j + 1] === "'") { value += "'"; j++; continue; } break; }
        value += sql[j];
      }
      literals.push(value);
      out += `\u0001${literals.length - 1}\u0001`;
      i = j + 1;
      continue;
    }
    if (c === '"') { const j = sql.indexOf('"', i + 1); out += sql.slice(i, j < 0 ? sql.length : j + 1); i = j < 0 ? sql.length : j + 1; continue; }
    out += c; i++;
  }
  return { code: out, literals };
}
const restore = (code, literals) => code.replace(/\u0001(\d+)\u0001/g, (_, n) => `'${literals[Number(n)].replace(/'/g, "''")}'`);
const LIT = '\\u0001\\d+\\u0001';
/** The operand that ends just before `end` in code: a literal, a call, a parenthesis or a name. */
function operandBefore(code, end) {
  let k = end;
  while (k > 0 && /\s/.test(code[k - 1])) k--;
  const stop = k;
  if (code[k - 1] === '\u0001') return { start: code.lastIndexOf('\u0001', k - 2), stop };
  if (code[k - 1] === ')') {
    let depth = 0;
    for (k = k - 1; k >= 0; k--) { if (code[k] === ')') depth++; else if (code[k] === '(' && --depth === 0) break; }
    while (k > 0 && /[\w.]/.test(code[k - 1])) k--;
    return { start: k, stop };
  }
  while (k > 0 && /[\w.]/.test(code[k - 1])) k--;
  return { start: k, stop };
}
/** PostgreSQL spellings SQLite does not know, rewritten to ones it does. */
export function translate(sql) {
  const { code: raw, literals } = protect(sql);
  let code = raw;
  // Literals that look like instants are stored as UTC seconds, the way timestamptz compares.
  for (let n = 0; n < literals.length; n++) { const ts = normalizeTimestamp(literals[n]); if (ts) literals[n] = ts; }
  code = code.replace(/\bcurrent_timestamp\b|\blocaltimestamp\b|\b(?:transaction|statement|clock)_timestamp\s*\(\s*\)/gi, 'now()');
  code = code.replace(/\bcurrent_date\b/gi, 'date(now())');
  code = code.replace(/\b(?:current_user|session_user)\b/gi, 'pg_current_user()');
  code = code.replace(/\bat\s+time\s+zone\s+\u0001\d+\u0001/gi, '');
  // Casts: `x::date` becomes date(x); `x::int` a CAST; the rest are no-ops here.
  for (let guard = 0; guard < 50; guard++) {
    const m = /::\s*([a-z_]+(?:\s+(?:with|without)\s+time\s+zone)?|"[^"]+")(\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(\[\])?/i.exec(code);
    if (!m) break;
    const type = m[1].toLowerCase().replace(/"/g, '');
    const { start, stop } = operandBefore(code, m.index);
    const operand = code.slice(start, stop);
    let replacement = operand;
    if (type === 'date') replacement = `date(${operand})`;
    else if (/^(int|integer|bigint|smallint|int[248])$/.test(type)) replacement = `CAST(${operand} AS INTEGER)`;
    else if (/^(numeric|decimal|real|float[48]?|double)/.test(type)) replacement = `CAST(${operand} AS REAL)`;
    else if (/^(text|varchar|character|char|name)/.test(type)) replacement = `CAST(${operand} AS TEXT)`;
    else if (type === 'interval') replacement = `interval ${operand}`;
    code = code.slice(0, start) + replacement + code.slice(m.index + m[0].length);
  }
  // `x - interval '2 hours'` and `x + interval '1 day'`.
  for (let guard = 0; guard < 50; guard++) {
    const m = new RegExp(`([+-])\\s*interval\\s*(${LIT})`, 'i').exec(code);
    if (!m) break;
    const { start, stop } = operandBefore(code, m.index);
    if (start === stop) break;
    code = `${code.slice(0, start)}pg_shift(${code.slice(start, stop)}, '${m[1]}', ${m[2]})${code.slice(m.index + m[0].length)}`;
  }
  code = code.replace(/\bextract\s*\(\s*(\w+)\s+from\s+/gi, (_, f) => `pg_extract('${f.toLowerCase()}', `);
  code = code.replace(/\bnot\s+ilike\b/gi, 'NOT LIKE').replace(/\bilike\b/gi, 'LIKE');
  code = code.replace(/\bis\s+not\s+distinct\s+from\b/gi, 'IS').replace(/\bis\s+distinct\s+from\b/gi, 'IS NOT');
  code = code.replace(/=\s*any\s*\(\s*array\s*\[([^\]]*)\]\s*\)/gi, 'IN ($1)');
  code = code.replace(/<>\s*all\s*\(\s*array\s*\[([^\]]*)\]\s*\)/gi, 'NOT IN ($1)');
  code = code.replace(/\bgreatest\s*\(/gi, 'max(').replace(/\bleast\s*\(/gi, 'min(');
  code = code.replace(/\bstring_agg\s*\(/gi, 'group_concat(');
  code = code.replace(/\blimit\s+all\b/gi, '');
  code = code.replace(/\bfor\s+(?:no\s+key\s+)?(?:update|share)(?:\s+of\s+\w+)?(?:\s+(?:skip\s+locked|nowait))?\s*$/i, '');
  code = code.replace(/\bas\s+table\s+([\w.]+)/gi, 'AS SELECT * FROM $1');
  // The statement proper starts after any WITH clause.
  const head = mainStart(code);
  let body = code.slice(head);
  // `UPDATE t s SET` and `DELETE FROM t s WHERE`: SQLite wants the AS.
  body = body.replace(/^(\s*(?:update|delete\s+from)\s+[\w.]+)\s+(?!set\b|where\b|as\b|using\b|returning\b|only\b)([a-z_]\w*)/i, '$1 AS $2');
  body = body.replace(/^(\s*update)\s+only\s+/i, '$1 ').replace(/^(\s*delete\s+from)\s+only\s+/i, '$1 ');
  // DELETE ... USING becomes a correlated EXISTS.
  const using = /^(\s*delete\s+from\s+[\w.]+(?:\s+as\s+\w+)?)\s+using\s+([\s\S]+?)\s+where\s+([\s\S]*?)(\s+returning\s+[\s\S]*)?$/i.exec(body);
  if (using) body = `${using[1]} WHERE EXISTS (SELECT 1 FROM ${using[2]} WHERE ${using[3]})${using[4] ?? ''}`;
  code = code.slice(0, head) + body;
  // SELECT ... INTO new_table FROM ... creates a table in PostgreSQL.
  const into = /^\s*select\s+([\s\S]+?)\s+into\s+(?:unlogged\s+|temp(?:orary)?\s+)?(?:table\s+)?([\w.]+)\s+(from\s[\s\S]*)$/i.exec(code);
  if (into) code = `CREATE TABLE ${into[2]} AS SELECT ${into[1]} ${into[3]}`;
  // DISTINCT ON anywhere: the whole query or any subquery, innermost scope first.
  for (let guard = 0; guard < 10; guard++) {
    const m = /\bselect\s+distinct\s+on\s*\(/i.exec(code);
    if (!m) break;
    let depth = 0, end = m.index;
    for (; end < code.length; end++) { if (code[end] === '(') depth++; else if (code[end] === ')' && --depth < 0) break; }
    const rewritten = distinctOn(code.slice(m.index, end));
    if (rewritten === code.slice(m.index, end)) break;
    code = code.slice(0, m.index) + rewritten + code.slice(end);
  }
  return restore(code, literals);
}
/** Where the statement proper begins: 0, or just past a leading WITH clause. */
function mainStart(code) {
  if (!/^\s*with\b/i.test(code)) return 0;
  let depth = 0;
  for (const m of code.matchAll(/\(|\)|\b(select|insert|update|delete)\b/gi)) {
    if (m[0] === '(') depth++;
    else if (m[0] === ')') depth--;
    else if (depth === 0) return m.index;
  }
  return 0;
}
/** DISTINCT ON (keys) becomes a ROW_NUMBER window keeping the first row per key. */
function distinctOn(code) {
  const m = /^\s*select\s+distinct\s+on\s*\(/i.exec(code);
  if (!m) return code;
  let depth = 1, k = m[0].length;
  for (; k < code.length && depth; k++) { if (code[k] === '(') depth++; else if (code[k] === ')') depth--; }
  const keys = code.slice(m[0].length, k - 1);
  const rest = code.slice(k);
  // The select list ends at the first FROM outside parentheses.
  let from = -1;
  depth = 0;
  for (let j = 0; j < rest.length; j++) {
    if (rest[j] === '(') depth++;
    else if (rest[j] === ')') depth--;
    else if (depth === 0 && /^from\b/i.test(rest.slice(j)) && /\s/.test(rest[j - 1] ?? ' ')) { from = j; break; }
  }
  if (from < 0) return code;
  const list = rest.slice(0, from).trim();
  let tail = rest.slice(from);
  const limit = /\s+limit\s+\d+(?:\s+offset\s+\d+)?\s*$/i.exec(tail);
  if (limit) tail = tail.slice(0, limit.index);
  const order = /\border\s+by\s+([\s\S]*)$/i.exec(tail);
  if (order) tail = tail.slice(0, order.index);
  return `SELECT * FROM (SELECT ${list}, ROW_NUMBER() OVER (PARTITION BY ${keys} ORDER BY ${order ? order[1] : keys}) AS "__pg_rn" ${tail.trim()}) WHERE "__pg_rn" = 1${limit ? limit[0] : ''}`;
}

const COLUMN_TYPES = { timestamptz: 'timestamp with time zone', timestamp: 'timestamp without time zone', int: 'integer', int4: 'integer', int8: 'bigint', bool: 'boolean', varchar: 'character varying' };
const pgType = (declared) => { const t = String(declared ?? '').toLowerCase(); return COLUMN_TYPES[t] ?? (t || 'text'); };

/** SQLite's error text in PostgreSQL's words. */
function pgError(e, verb, table) {
  const msg = String(e?.message ?? e);
  let m;
  if ((m = /no such table: (?:main\.)?([\w.]+)/.exec(msg))) return [`ERROR:  relation "${m[1]}" does not exist`];
  if ((m = /no such column: ([\w.]+)/.exec(msg))) return [`ERROR:  column ${m[1].includes('.') ? m[1] : `"${m[1]}"`} does not exist`];
  if ((m = /near "([^"]*)": syntax error/.exec(msg))) return [`ERROR:  syntax error at or near "${m[1]}"`];
  if (/incomplete input/.test(msg)) return ['ERROR:  syntax error at end of input'];
  if ((m = /no such function: (\w+)/.exec(msg))) return [`ERROR:  function ${m[1].toLowerCase()}() does not exist`, 'HINT:  No function matches the given name and argument types. You might need to add explicit type casts.'];
  if ((m = /wrong number of arguments to function (\w+)/.exec(msg))) return [`ERROR:  function ${m[1].toLowerCase()} does not exist`, 'HINT:  No function matches the given name and argument types. You might need to add explicit type casts.'];
  if ((m = /UNIQUE constraint failed: (\w+)\.(\w+)/.exec(msg))) return [`ERROR:  duplicate key value violates unique constraint "${m[2] === 'id' ? `${m[1]}_pkey` : `${m[1]}_${m[2]}_key`}"`, `DETAIL:  Key (${m[2]})=(…) already exists.`];
  if ((m = /NOT NULL constraint failed: (\w+)\.(\w+)/.exec(msg))) return [`ERROR:  null value in column "${m[2]}" of relation "${m[1]}" violates not-null constraint`];
  if ((m = /CHECK constraint failed: (\w+)/.exec(msg))) return [`ERROR:  new row for relation "${table ?? 'unknown'}" violates check constraint "${m[1]}"`];
  if (/FOREIGN KEY constraint failed/.test(msg)) return [`ERROR:  ${verb === 'DELETE' ? 'update or delete on table violates foreign key constraint' : 'insert or update on table violates foreign key constraint'}`];
  if ((m = /table (\w+) already exists/.exec(msg))) return [`ERROR:  relation "${m[1]}" already exists`];
  if ((m = /index (\w+) already exists/.exec(msg))) return [`ERROR:  relation "${m[1]}" already exists`];
  if ((m = /ambiguous column name: ([\w.]+)/.exec(msg))) return [`ERROR:  column reference "${m[1]}" is ambiguous`];
  if (/misuse of aggregate/.test(msg)) return ['ERROR:  aggregate functions are not allowed in WHERE'];
  if (/must appear in the GROUP BY/.test(msg)) return [`ERROR:  ${msg}`];
  if ((m = /(\d+) values for (\d+) columns/.exec(msg))) return ['ERROR:  INSERT has more expressions than target columns'];
  if (/cannot start a transaction within a transaction/.test(msg)) return ['WARNING:  there is already a transaction in progress'];
  return [`ERROR:  ${msg.replace(/^SQLITE_\w+:\s*/, '')}`];
}

/** The statement's verb, looking past a leading WITH clause. */
function verbOf(sql) {
  const first = /^\s*\(?\s*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? '';
  if (first !== 'WITH') return first;
  let depth = 0;
  const words = sql.matchAll(/\(|\)|\b(select|insert|update|delete)\b/gi);
  for (const w of words) {
    if (w[0] === '(') depth++;
    else if (w[0] === ')') depth--;
    else if (depth === 0) return w[1].toUpperCase();
  }
  return 'SELECT';
}
const targetOf = (sql) => /^\s*(?:update(?:\s+only)?|insert\s+into|delete\s+from(?:\s+only)?|truncate(?:\s+table)?(?:\s+only)?|create\s+(?:unlogged\s+|temp(?:orary)?\s+)?table(?:\s+if\s+not\s+exists)?|drop\s+table(?:\s+if\s+exists)?|alter\s+table(?:\s+if\s+exists)?(?:\s+only)?|create\s+(?:unique\s+)?index(?:\s+concurrently)?(?:\s+if\s+not\s+exists)?\s+\w+\s+on)\s+"?([\w.]+)"?/i.exec(sql)?.[1]?.replace(/^public\./, '').toLowerCase();
const targetOfAny = (sql) => targetOf(sql.slice(mainStart(sql)));
const sourcesOf = (sql) => [...new Set([...sql.matchAll(/\b(?:from|join|using)\s+"?([a-z_][\w.]*)"?/gi)].map(m => m[1].replace(/^public\./, '').toLowerCase()))];

/** Values as psql prints them. */
function show(v, type) {
  if (v === null || v === undefined) return '';
  const t = String(type ?? '').toLowerCase();
  if (t === 'boolean' || t === 'bool') return v ? 't' : 'f';
  if (typeof v === 'string' && (t === 'timestamptz' || !t) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return `${v}+00`;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 1e6) / 1e6);
  if (v instanceof Uint8Array) return `\\x${Buffer.from(v).toString('hex')}`;
  return String(v);
}
/** A column name as PostgreSQL would label it. */
function label(meta) {
  if (meta.column) return meta.name;
  const name = String(meta.name);
  if (/^[a-z_][\w]*$/i.test(name) && !/^(count|sum|min|max|avg)$/i.test(name) && name !== name.toUpperCase()) return name;
  const call = /^(\w+)\s*\(/.exec(name);
  if (call) {
    const f = call[1].toLowerCase();
    return { group_concat: 'string_agg', pg_shift: '?column?', pg_extract: 'extract', date: '?column?', pg_current_user: 'current_user' }[f] ?? f;
  }
  if (/^[a-z_]\w*$/.test(name)) return name;
  if (/^[A-Z_]\w*$/.test(name)) return name.toLowerCase();
  return '?column?';
}

export function formatResult({ columns, rows }, o) {
  const names = columns.map(c => c.label);
  const cells = rows.map(r => r.map((v, k) => show(v, columns[k].type)));
  const numeric = columns.map((c, k) => rows.length > 0 && rows.every(r => r[k] === null || typeof r[k] === 'number' || typeof r[k] === 'bigint'));
  const footer = `(${rows.length} row${rows.length === 1 ? '' : 's'})`;
  const out = [];
  if (o.format === 'csv') {
    const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    if (!o.tuplesOnly) out.push(names.map(q).join(','));
    for (const r of cells) out.push(r.map(q).join(','));
    return out;
  }
  if (o.expanded) {
    if (!rows.length) return o.tuplesOnly ? [] : ['(0 rows)'];
    const kw = Math.max(...names.map(n => n.length));
    if (o.unaligned) {
      cells.forEach((r, i) => { if (i) out.push(''); r.forEach((v, k) => out.push(`${names[k]}${o.separator}${v}`)); });
      return out;
    }
    const vw = Math.max(1, ...cells.flat().map(v => v.length));
    cells.forEach((r, i) => {
      let head = `-[ RECORD ${i + 1} ]`;
      if (head.length < kw + 1) head += '-'.repeat(kw + 1 - head.length);
      out.push(`${head}+${'-'.repeat(vw + 1)}`);
      r.forEach((v, k) => out.push(`${names[k].padEnd(kw)} | ${v}`.replace(/\s+$/, '')));
    });
    out.push('');
    return out;
  }
  if (o.unaligned) {
    if (!o.tuplesOnly) out.push(names.join(o.separator));
    for (const r of cells) out.push(r.join(o.separator));
    if (!o.tuplesOnly) out.push(footer);
    return out;
  }
  const widths = names.map((n, k) => Math.max(n.length, ...cells.map(r => r[k].length)));
  if (!o.tuplesOnly) {
    out.push(` ${names.map((n, k) => { const pad = widths[k] - n.length; const left = Math.floor(pad / 2); return ' '.repeat(left) + n + ' '.repeat(pad - left); }).join(' | ')} `);
    out.push(widths.map(w => '-'.repeat(w + 2)).join('+'));
  }
  for (const r of cells) {
    const text = r.map((v, k) => (numeric[k] ? v.padStart(widths[k]) : k === r.length - 1 ? v : v.padEnd(widths[k]))).join(' | ');
    out.push(` ${text}`);
  }
  if (!o.tuplesOnly) out.push(footer);
  out.push('');
  return out;
}

const attached = new WeakSet();
/** pg_catalog and information_schema as attached schemas, so both qualified and bare names resolve. */
function catalogs(conn, ctx) {
  const db = conn.db;
  if (!attached.has(db)) {
    db.exec("ATTACH DATABASE ':memory:' AS pg_catalog");
    db.exec("ATTACH DATABASE ':memory:' AS information_schema");
    db.exec(`CREATE TABLE pg_catalog.pg_stat_activity (datid INTEGER, datname TEXT, pid INTEGER, usename TEXT, application_name TEXT, client_addr TEXT, backend_start TIMESTAMPTZ, xact_start TIMESTAMPTZ, query_start TIMESTAMPTZ, state_change TIMESTAMPTZ, wait_event_type TEXT, wait_event TEXT, state TEXT, backend_type TEXT, query TEXT)`);
    db.exec('CREATE TABLE pg_catalog.pg_tables (schemaname TEXT, tablename TEXT, tableowner TEXT, hasindexes BOOLEAN)');
    db.exec('CREATE TABLE pg_catalog.pg_stat_user_tables (relid INTEGER, schemaname TEXT, relname TEXT, n_live_tup INTEGER, n_dead_tup INTEGER, last_autovacuum TIMESTAMPTZ)');
    db.exec('CREATE TABLE pg_catalog.pg_settings (name TEXT, setting TEXT, unit TEXT, context TEXT)');
    db.exec('CREATE TABLE information_schema.tables (table_catalog TEXT, table_schema TEXT, table_name TEXT, table_type TEXT)');
    db.exec('CREATE TABLE information_schema.columns (table_catalog TEXT, table_schema TEXT, table_name TEXT, column_name TEXT, ordinal_position INTEGER, column_default TEXT, is_nullable TEXT, data_type TEXT)');
    const fn = (name, f, n) => db.function(name, { deterministic: false, varargs: n === undefined }, f);
    fn('now', () => stamp(ctx.now().getTime()));
    fn('pg_current_user', () => conn.user);
    fn('current_database', () => conn.dbname);
    fn('version', () => `PostgreSQL ${conn.settings?.server_version ?? '15.8'} on x86_64-pc-linux-gnu, compiled by Debian clang version 12.0.1, 64-bit`);
    fn('pg_shift', (ts, sign, spec) => shift(ts, sign, spec));
    fn('pg_extract', (field, ts) => {
      if (ts === null) return null;
      const iso = normalizeTimestamp(String(ts)) ?? String(ts);
      const d = new Date(`${iso.replace(' ', 'T')}${iso.length > 10 ? 'Z' : 'T00:00:00Z'}`);
      return { epoch: d.getTime() / 1000, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), dow: d.getUTCDay(), doy: Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1 }[String(field).toLowerCase()] ?? null;
    });
    fn('date_part', (field, ts) => db.prepare('SELECT pg_extract(?, ?) v').get(field, ts).v);
    fn('date_trunc', (unit, ts) => {
      if (ts === null) return null;
      const s = normalizeTimestamp(String(ts)) ?? (/^\d{4}-\d{2}-\d{2}$/.test(String(ts)) ? `${ts} 00:00:00` : null);
      if (!s) return null;
      const u = String(unit).toLowerCase();
      if (u === 'minute') return `${s.slice(0, 16)}:00`;
      if (u === 'hour') return `${s.slice(0, 13)}:00:00`;
      if (u === 'day') return `${s.slice(0, 10)} 00:00:00`;
      if (u === 'month') return `${s.slice(0, 7)}-01 00:00:00`;
      if (u === 'year') return `${s.slice(0, 4)}-01-01 00:00:00`;
      if (u === 'week') { const d = new Date(`${s.slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return stamp(d.getTime()); }
      return s;
    });
    fn('to_char', (ts, format) => {
      if (ts === null) return null;
      const s = normalizeTimestamp(String(ts)) ?? String(ts);
      return String(format).replace(/YYYY/g, s.slice(0, 4)).replace(/MM/g, s.slice(5, 7)).replace(/DD/g, s.slice(8, 10)).replace(/HH24/g, s.slice(11, 13)).replace(/MI/g, s.slice(14, 16)).replace(/SS/g, s.slice(17, 19));
    });
    fn('pg_sleep', (seconds) => { ctx.wait(Number(seconds) || 0); return ''; });
    fn('pg_backend_pid', () => 48213);
    fn('txid_current', () => 91842277);
    fn('pg_total_relation_size', (name) => { try { return (db.prepare(`SELECT count(*) n FROM "${String(name).replace(/"/g, '')}"`).get().n + 40) * 312; } catch { return null; } });
    fn('pg_relation_size', (name) => { try { return (db.prepare(`SELECT count(*) n FROM "${String(name).replace(/"/g, '')}"`).get().n + 40) * 208; } catch { return null; } });
    fn('pg_size_pretty', (n) => (n === null ? null : n < 10240 ? `${n} bytes` : n < 10485760 ? `${Math.round(n / 1024)} kB` : n < 10737418240 ? `${Math.round(n / 1048576)} MB` : `${Math.round(n / 1073741824)} GB`));
    let uuid = 0;
    fn('gen_random_uuid', () => { uuid++; const h = (uuid * 2654435761 >>> 0).toString(16).padStart(8, '0'); return `${h}-9c1e-4b7a-8f3d-${String(uuid).padStart(12, '0')}`; });
    db.aggregate('array_agg', { start: () => null, step: (acc, v) => [...(acc ?? []), v], result: (acc) => (acc === null ? null : `{${acc.map(v => (v === null ? 'NULL' : String(v))).join(',')}}`) });
    attached.add(db);
  }
}
function refreshCatalogs(conn) {
  const db = conn.db;
  const tables = db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
  db.exec('DELETE FROM information_schema.tables; DELETE FROM information_schema.columns; DELETE FROM pg_catalog.pg_tables; DELETE FROM pg_catalog.pg_stat_user_tables; DELETE FROM pg_catalog.pg_stat_activity; DELETE FROM pg_catalog.pg_settings');
  const insertTable = db.prepare("INSERT INTO information_schema.tables VALUES (?, 'public', ?, 'BASE TABLE')");
  const insertColumn = db.prepare("INSERT INTO information_schema.columns VALUES (?, 'public', ?, ?, ?, ?, ?, ?)");
  const insertPg = db.prepare("INSERT INTO pg_catalog.pg_tables VALUES ('public', ?, ?, 1)");
  const insertStats = db.prepare("INSERT INTO pg_catalog.pg_stat_user_tables VALUES (?, 'public', ?, ?, 0, NULL)");
  tables.forEach((t, k) => {
    insertTable.run(conn.dbname, t);
    insertPg.run(t, ownerOf(conn, t));
    insertStats.run(16384 + k, t, db.prepare(`SELECT count(*) n FROM main."${t}"`).get().n);
    for (const c of columnsOf(db, t)) insertColumn.run(conn.dbname, t, c.name, c.position, c.default, c.nullable ? 'YES' : 'NO', c.type);
  });
  const settings = { max_connections: '100', server_version: '15.8', TimeZone: 'UTC', statement_timeout: '0', ...conn.settings };
  const insertSetting = db.prepare("INSERT INTO pg_catalog.pg_settings VALUES (?, ?, NULL, 'user')");
  for (const [k, v] of Object.entries(settings)) insertSetting.run(k, String(v));
  const insertActivity = db.prepare('INSERT INTO pg_catalog.pg_stat_activity VALUES (16401, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of [...(conn.activity?.() ?? []), { pid: 48213, usename: conn.user, application_name: 'psql', client_addr: '127.0.0.1', state: 'active', query: '(this query)', backend_type: 'client backend' }]) {
    const now = stamp(conn.ctx.now().getTime());
    insertActivity.run(r.datname ?? conn.dbname, r.pid, r.usename, r.application_name ?? '', r.client_addr ?? null, r.backend_start ?? now, r.xact_start ?? null, r.query_start ?? now, r.state_change ?? now, r.wait_event_type ?? null, r.wait_event ?? null, r.state ?? 'idle', r.backend_type ?? 'client backend', r.query ?? '');
  }
}
function columnsOf(db, table) {
  const pk = db.prepare(`PRAGMA main.table_info("${table}")`).all();
  const single = pk.filter(c => c.pk).length === 1;
  return pk.map(c => {
    const serial = single && c.pk && /^integer$/i.test(c.type);
    return { name: c.name, position: c.cid + 1, type: serial ? 'bigint' : pgType(c.type), nullable: !c.notnull && !c.pk, default: serial ? `nextval('${table}_${c.name}_seq'::regclass)` : c.dflt_value === null ? null : pgType(c.type) === 'boolean' ? (String(c.dflt_value) === '0' ? 'false' : 'true') : String(c.dflt_value).replace(/^\((.*)\)$/, '$1').replace(/^CURRENT_TIMESTAMP$/i, 'now()').replace(/^('.*')$/, `$1::${pgType(c.type) === 'text' ? 'text' : pgType(c.type)}`), pk: Boolean(c.pk) };
  });
}
const ownerOf = (conn, table) => (conn.owners?.has(table) ? 'app' : conn.user);

/** One psql process: its options, its connection and its transaction state. */
class Session {
  constructor(ctx, io, conn, o) {
    this.ctx = ctx; this.io = io; this.conn = conn; this.o = o;
    this.db = conn.db;
    this.txn = 'none';
    this.pending = [];
    this.out = [];
    // psql writes notices and errors between results; the terminal shows them in that order.
    this.err = this.out;
    this.code = 0;
    this.stopped = false;
    this.timing = false;
    conn.ctx = ctx;
  }
  begin(mode) { this.db.exec('BEGIN'); this.txn = mode; }
  commit() {
    if (this.txn === 'aborted') { this.db.exec('ROLLBACK'); this.discard(); this.txn = 'none'; return 'ROLLBACK'; }
    if (this.txn !== 'none') { this.db.exec('COMMIT'); this.flush(); }
    this.txn = 'none';
    return 'COMMIT';
  }
  rollback() { if (this.db.isTransaction) this.db.exec('ROLLBACK'); this.discard(); this.txn = 'none'; }
  flush() { for (const e of this.pending) this.ctx.event(e.kind, e.detail); this.pending = []; }
  discard() {
    const writes = this.pending.filter(e => e.kind === 'sql.statement');
    if (writes.length) this.ctx.event('sql.rollback', { instance: this.conn.name, statements: writes.length, rows: writes.reduce((n, e) => n + e.detail.rows, 0) });
    this.pending = [];
  }
  note(kind, detail) {
    if (this.txn === 'none') this.ctx.event(kind, detail);
    else this.pending.push({ kind, detail });
  }
  print(lines_) { this.out.push(...lines_); }
  tag(text) { if (!this.o.quiet) this.out.push(text); }
  /** Runs one statement and prints what psql prints for it. Returns false on error. */
  statement(sql, where) {
    const prefix = where ? `psql:${where}: ` : '';
    const fail = (messages) => { this.err.push(`${prefix}${messages[0]}`, ...messages.slice(1)); if (this.txn !== 'none') this.txn = 'aborted'; return false; };
    if (this.o.echo) this.out.push(sql + ';');
    const verb = verbOf(sql);
    const words = sql.trim().split(/\s+/).map(w => w.toUpperCase());
    const plain = sql.trim().replace(/;$/, '');
    if (['BEGIN', 'START'].includes(verb)) {
      if (this.txn === 'explicit' || this.txn === 'aborted') { this.err.push(`${prefix}WARNING:  there is already a transaction in progress`); this.tag('BEGIN'); return true; }
      if (this.txn === 'implicit') this.txn = 'explicit'; else this.begin('explicit');
      this.tag('BEGIN');
      return true;
    }
    if (['COMMIT', 'END'].includes(verb) || (verb === 'ABORT') || (verb === 'ROLLBACK' && !/\bto\b/i.test(plain))) {
      const rollback = verb === 'ROLLBACK' || verb === 'ABORT';
      if (this.txn === 'none') { this.err.push(`${prefix}WARNING:  there is no transaction in progress`); this.tag(rollback ? 'ROLLBACK' : 'COMMIT'); return true; }
      if (rollback) { this.rollback(); this.tag('ROLLBACK'); } else this.tag(this.commit());
      return true;
    }
    if (this.txn === 'aborted' && !(verb === 'ROLLBACK')) return fail(['ERROR:  current transaction is aborted, commands ignored until end of transaction block']);
    if (verb === 'SAVEPOINT' || verb === 'RELEASE' || verb === 'ROLLBACK') {
      if (this.txn === 'none') return fail([`ERROR:  ${verb} can only be used in transaction blocks`]);
      try { this.db.exec(plain); } catch (e) { return fail(pgError(e)); }
      if (verb === 'ROLLBACK') this.txn = 'explicit';
      this.tag(verb === 'ROLLBACK' ? 'ROLLBACK' : verb);
      return true;
    }
    if (verb === 'SET' || verb === 'RESET' || verb === 'DISCARD') { this.tag(verb); return true; }
    if (verb === 'SHOW') {
      const name = (words[1] ?? '').toLowerCase();
      const settings = { max_connections: '100', server_version: '15.8', timezone: 'UTC', statement_timeout: '0', lock_timeout: '0', transaction_isolation: 'read committed', search_path: '"$user", public', default_transaction_read_only: this.conn.readOnly ? 'on' : 'off', transaction_read_only: this.conn.readOnly ? 'on' : 'off', ...Object.fromEntries(Object.entries(this.conn.settings ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])) };
      if (!(name in settings)) return fail([`ERROR:  unrecognized configuration parameter "${name}"`]);
      this.print(formatResult({ columns: [{ label: name }], rows: [[settings[name]]] }, this.o));
      return true;
    }
    if (verb === 'VACUUM' || verb === 'ANALYZE') { this.tag(verb); return true; }
    if (verb === 'LOCK') {
      if (this.txn === 'none') return fail(['ERROR:  LOCK TABLE can only be used in transaction blocks']);
      this.tag('LOCK TABLE');
      return true;
    }
    if (verb === 'GRANT' || verb === 'REVOKE') return fail(['ERROR:  permission denied to grant privileges']);
    if (verb === 'COPY') return this.copy(sql, fail);
    if (verb === 'EXPLAIN') return this.explain(sql, fail);
    return this.run(sql, verb, fail);
  }
  /** Checks the statement is allowed for this role and connection. */
  denied(sql, verb) {
    const writes = ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE'];
    if (!writes.includes(verb)) return null;
    const target = targetOfAny(sql);
    const kind = verb === 'CREATE' ? (/^\s*create\s+(?:unique\s+)?index/i.test(sql) ? 'CREATE INDEX' : /\bas\s+select\b/i.test(sql) || /\bas\s*\(/i.test(sql) ? 'CREATE TABLE AS' : 'CREATE TABLE') : verb === 'DROP' ? 'DROP TABLE' : verb === 'ALTER' ? 'ALTER TABLE' : verb === 'TRUNCATE' ? 'TRUNCATE TABLE' : verb;
    if (this.conn.readOnly) return [`ERROR:  cannot execute ${kind} in a read-only transaction`];
    if (target && this.conn.owners?.has(target)) {
      if (verb === 'DROP' || verb === 'ALTER') return [`ERROR:  must be owner of table ${target}`];
      if (verb === 'TRUNCATE') return [`ERROR:  permission denied for table ${target}`];
      if (kind === 'CREATE INDEX') return [`ERROR:  must be owner of table ${target}`];
    }
    return null;
  }
  run(sql, verb, fail) {
    const blocked = this.denied(sql, verb);
    if (blocked) return fail(blocked);
    let text = sql;
    if (verb === 'TRUNCATE') {
      const names = sql.replace(/^\s*truncate\s+(?:table\s+)?(?:only\s+)?/i, '').replace(/\s+(restart|continue)\s+identity|\s+(cascade|restrict)/gi, '').split(',').map(s => s.trim()).filter(Boolean);
      text = names.map(n => `DELETE FROM ${n}`).join(';');
      try {
        let rows = 0;
        for (const s of text.split(';')) rows += Number(this.db.prepare(translate(s)).run().changes);
        this.note('sql.statement', { instance: this.conn.name, verb: 'TRUNCATE', table: targetOfAny(sql), sources: [], rows, sql: sql.slice(0, 600) });
        this.tag('TRUNCATE TABLE');
        return true;
      } catch (e) { return fail(pgError(e, 'DELETE')); }
    }
    const drop = /^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?"?([\w.]+)"?\s+drop\s+(?:column\s+)?(?:if\s+exists\s+)?"?(\w+)"?/i.exec(text);
    if (drop) {
      // PostgreSQL drops the indexes that depend on a dropped column; SQLite refuses instead.
      try {
        for (const ix of this.db.prepare(`PRAGMA main.index_list("${drop[1].replace(/^public\./, '')}")`).all()) {
          if (ix.name.startsWith('sqlite_autoindex')) continue;
          if (this.db.prepare(`PRAGMA main.index_info("${ix.name}")`).all().some(c => c.name === drop[2])) this.db.exec(`DROP INDEX main."${ix.name}"`);
        }
      } catch { /* The ALTER below reports the real problem. */ }
    }
    const translated = translate(text);
    if (/\b(pg_catalog|information_schema|pg_stat_activity|pg_tables|pg_stat_user_tables|pg_settings)\b/i.test(translated)) refreshCatalogs(this.conn);
    let stmt;
    try { stmt = this.db.prepare(translated); } catch (e) { return fail(pgError(e, verb, targetOfAny(sql))); }
    const returning = stmt.columns().length > 0;
    const started = this.ctx.t;
    try {
      let rows = [], changes = 0;
      if (returning) {
        stmt.setReturnArrays(true);
        rows = stmt.all();
        if (['INSERT', 'UPDATE', 'DELETE'].includes(verb)) changes = rows.length;
      } else changes = Number(stmt.run().changes);
      this.ctx.wait(0.05 + Math.max(rows.length, changes) / 8000);
      const columns = stmt.columns().map(c => ({ label: label(c), type: c.type })).filter(c => c.label !== '__pg_rn');
      if (returning && stmt.columns().some(c => c.name === '__pg_rn')) { const drop = stmt.columns().findIndex(c => c.name === '__pg_rn'); rows = rows.map(r => r.filter((_, k) => k !== drop)); }
      const isWrite = ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER'].includes(verb);
      if (isWrite) {
        const kind = verb === 'CREATE' && /\bas\s+select\b/i.test(translated) ? 'CREATE TABLE AS' : verb;
        if (kind === 'CREATE TABLE AS') changes = this.db.prepare(`SELECT count(*) n FROM main."${targetOfAny(translated)}"`).get().n;
        this.note('sql.statement', { instance: this.conn.name, verb: kind, table: targetOfAny(sql), sources: sourcesOf(sql), rows: changes, sql: sql.slice(0, 600) });
      }
      if (returning && (verb === 'SELECT' || verb === 'WITH' || rows.length || /\breturning\b/i.test(sql))) this.print(formatResult({ columns, rows }, this.o));
      if (verb === 'INSERT') this.tag(`INSERT 0 ${changes}`);
      else if (verb === 'UPDATE' || verb === 'DELETE') this.tag(`${verb} ${changes}`);
      else if (verb === 'CREATE') this.tag(/\bas\s+select\b/i.test(translated) ? `SELECT ${changes}` : /^\s*create\s+(unique\s+)?index/i.test(sql) ? 'CREATE INDEX' : /^\s*create\s+(or\s+replace\s+)?view/i.test(sql) ? 'CREATE VIEW' : 'CREATE TABLE');
      else if (verb === 'DROP') this.tag(/^\s*drop\s+index/i.test(sql) ? 'DROP INDEX' : /^\s*drop\s+view/i.test(sql) ? 'DROP VIEW' : 'DROP TABLE');
      else if (verb === 'ALTER') this.tag('ALTER TABLE');
      if (this.timing) this.out.push(`Time: ${(0.412 + (this.ctx.t - started) * 1000).toFixed(3)} ms`);
      return true;
    } catch (e) { return fail(pgError(e, verb, targetOfAny(sql))); }
  }
  query(select) {
    const stmt = this.db.prepare(translate(select));
    stmt.setReturnArrays(true);
    const rows = stmt.all();
    return { columns: stmt.columns().map(c => ({ label: label(c), type: c.type })), rows };
  }
  copy(sql, fail) {
    const m = /^\s*copy\s+(\([\s\S]+\)|[\w.]+(?:\s*\([^)]*\))?)\s+to\s+(stdout|'[^']*')\s*(?:with\s*)?([\s\S]*)$/i.exec(sql);
    if (!m) {
      if (/\bfrom\s+stdin\b/i.test(sql)) return fail(['ERROR:  COPY from stdin failed: no input was supplied']);
      if (/\bfrom\s+'/i.test(sql)) return fail(['ERROR:  must be superuser or have privileges of the pg_read_server_files role to COPY from a file', "HINT:  Anyone can COPY to stdout or from stdin. psql's \\copy command also works for anyone."]);
      return fail(['ERROR:  syntax error at or near "COPY"']);
    }
    if (m[2].toLowerCase() !== 'stdout') return fail(['ERROR:  must be superuser or have privileges of the pg_write_server_files role to COPY to a file', "HINT:  Anyone can COPY to stdout or from stdin. psql's \\copy command also works for anyone."]);
    try {
      const result = this.exportRows(m[1]);
      const lines_ = csvLines(result, m[3]);
      this.print(lines_);
      this.ctx.event('sql.export', { instance: this.conn.name, sources: sourcesOf(`from ${m[1]}`), rows: result.rows.length, to: 'stdout' });
      this.tag(`COPY ${result.rows.length}`);
      return true;
    } catch (e) { return fail(pgError(e)); }
  }
  exportRows(source) {
    const s = source.trim();
    if (s.startsWith('(')) return this.query(s.slice(1, -1));
    const t = /^([\w.]+)\s*(?:\(([^)]*)\))?$/.exec(s);
    return this.query(`SELECT ${t[2] ?? '*'} FROM ${t[1]}`);
  }
  explain(sql, fail) {
    const analyze = /^\s*explain\s+(\([^)]*analy[sz]e[^)]*\)|analy[sz]e)/i.test(sql);
    const body = sql.replace(/^\s*explain\s+(\([^)]*\)\s*|analy[sz]e\s+|verbose\s+)*/i, '');
    let plan;
    try { plan = this.db.prepare(`EXPLAIN QUERY PLAN ${translate(body)}`).all(); } catch (e) { return fail(pgError(e)); }
    const rows = plan.map(p => {
      const d = String(p.detail);
      let m;
      if ((m = /^SCAN (\w+)(?: AS (\w+))?/.exec(d))) return `Seq Scan on ${m[1]}${m[2] ? ` ${m[2]}` : ''}  (cost=0.00..${this.estimate(m[1])}.00 rows=${this.rows(m[1])} width=72)`;
      if ((m = /^SEARCH (\w+)(?: AS (\w+))? USING (?:COVERING )?INDEX (\w+)/.exec(d))) return `Index Scan using ${m[3]} on ${m[1]}${m[2] ? ` ${m[2]}` : ''}  (cost=0.29..8.31 rows=1 width=72)`;
      if ((m = /^SEARCH (\w+)(?: AS (\w+))? USING INTEGER PRIMARY KEY/.exec(d))) return `Index Scan using ${m[1]}_pkey on ${m[1]}${m[2] ? ` ${m[2]}` : ''}  (cost=0.29..8.31 rows=1 width=72)`;
      return d.replace(/^USE TEMP B-TREE FOR ORDER BY$/, 'Sort').replace(/^CORRELATED SCALAR SUBQUERY.*/, 'SubPlan 1');
    });
    if (analyze) {
      const verb = verbOf(body);
      const before = this.out.length;
      if (!this.run(body, verb, fail)) return false;
      this.out.length = before;
      rows.push('Planning Time: 0.412 ms', `Execution Time: ${(12.8 + this.rows(targetOfAny(body) ?? '') / 90).toFixed(3)} ms`);
    }
    this.print(formatResult({ columns: [{ label: 'QUERY PLAN' }], rows: rows.map(r => [r]) }, this.o));
    return true;
  }
  rows(table) { try { return this.db.prepare(`SELECT count(*) n FROM main."${table}"`).get().n; } catch { return 1000; } }
  estimate(table) { return Math.round(this.rows(table) * 0.034 + 12); }
  /** Backslash commands. Returns false to stop the session. */
  meta(line, where) {
    const [cmd, ...args] = line.trim().split(/\s+/);
    const arg = args.join(' ');
    const o = this.o;
    const tables = () => this.db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    const titled = (title, result) => {
      const body = formatResult(result, o);
      if (o.unaligned || o.tuplesOnly) return body;
      const width = body[0]?.length ?? title.length;
      return [`${' '.repeat(Math.max(0, Math.floor((width - title.length) / 2)))}${title}`, ...body];
    };
    switch (cmd) {
      case '\\q': case '\\quit': this.stopped = true; return false;
      case '\\dt': case '\\dt+': case '\\d': case '\\d+': case '\\dS': {
        if ((cmd === '\\d' || cmd === '\\d+') && arg) return this.describe(arg.replace(/^public\./, ''), where, titled);
        const pattern = arg ? new RegExp(`^${arg.replace(/^public\./, '').replace(/\*/g, '.*')}$`) : null;
        const list = tables().filter(t => !pattern || pattern.test(t));
        if (!list.length) { this.err.push(arg ? `Did not find any relation named "${arg}".` : 'Did not find any relations.'); return true; }
        this.print(titled('List of relations', { columns: [{ label: 'Schema' }, { label: 'Name' }, { label: 'Type' }, { label: 'Owner' }], rows: list.map(t => ['public', t, 'table', ownerOf(this.conn, t)]) }));
        return true;
      }
      case '\\di': {
        const list = this.db.prepare("SELECT name, tbl_name FROM main.sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        this.print(titled('List of relations', { columns: [{ label: 'Schema' }, { label: 'Name' }, { label: 'Type' }, { label: 'Owner' }, { label: 'Table' }], rows: list.map(r => ['public', r.name, 'index', ownerOf(this.conn, r.tbl_name), r.tbl_name]) }));
        return true;
      }
      case '\\dn': this.print(titled('List of schemas', { columns: [{ label: 'Name' }, { label: 'Owner' }], rows: [['public', 'pg_database_owner']] })); return true;
      case '\\l': case '\\list':
        this.print(titled('List of databases', { columns: ['Name', 'Owner', 'Encoding', 'Collate', 'Ctype', 'ICU Locale', 'Locale Provider', 'Access privileges'].map(l => ({ label: l })), rows: [[this.conn.dbname, 'app', 'UTF8', 'en_US.UTF8', 'en_US.UTF8', '', 'libc', ''], ['postgres', 'cloudsqlsuperuser', 'UTF8', 'en_US.UTF8', 'en_US.UTF8', '', 'libc', ''], ['template0', 'cloudsqladmin', 'UTF8', 'en_US.UTF8', 'en_US.UTF8', '', 'libc', '=c/cloudsqladmin'], ['template1', 'cloudsqlsuperuser', 'UTF8', 'en_US.UTF8', 'en_US.UTF8', '', 'libc', '=c/cloudsqlsuperuser']] }));
        return true;
      case '\\du': this.print(titled('List of roles', { columns: [{ label: 'Role name' }, { label: 'Attributes' }], rows: [['app', ''], ['cloudsqladmin', 'Superuser, Create role, Create DB, Replication, Bypass RLS'], ['cloudsqlsuperuser', 'Create role, Create DB'], [this.conn.user, '']] })); return true;
      case '\\conninfo': this.out.push(`You are connected to database "${this.conn.dbname}" as user "${this.conn.user}" on host "${this.conn.host}" at port "${this.conn.port}".`); return true;
      case '\\x': o.expanded = arg === 'off' ? false : arg === 'on' ? true : arg === 'auto' ? false : !o.expanded; this.out.push(`Expanded display is ${arg === 'auto' ? 'used automatically' : o.expanded ? 'on' : 'off'}.`); return true;
      case '\\timing': this.timing = arg === 'off' ? false : arg === 'on' ? true : !this.timing; this.out.push(`Timing is ${this.timing ? 'on' : 'off'}.`); return true;
      case '\\echo': this.out.push(arg.replace(/^'(.*)'$/, '$1')); return true;
      case '\\set': if (/^ON_ERROR_STOP$/i.test(args[0] ?? '')) o.onErrorStop = !/^(0|off|false)$/i.test(args[1] ?? 'on'); return true;
      case '\\unset': case '\\encoding': case '\\setenv': return true;
      case '\\pset': {
        const [name, value] = args;
        if (name === 'pager') { this.out.push(`Pager usage is ${value === 'off' || value === '0' ? 'off' : 'on'}.`); return true; }
        if (name === 'format') { o.unaligned = value === 'unaligned'; o.format = value === 'csv' ? 'csv' : undefined; this.out.push(`Output format is ${value}.`); return true; }
        if (name === 'tuples_only') { o.tuplesOnly = value !== 'off'; this.out.push(`Tuples only is ${o.tuplesOnly ? 'on' : 'off'}.`); return true; }
        if (name === 'fieldsep') { o.separator = value?.replace(/^'(.*)'$/, '$1') ?? '|'; this.out.push(`Field separator is "${o.separator}".`); return true; }
        return true;
      }
      case '\\a': o.unaligned = !o.unaligned; this.out.push(`Output format is ${o.unaligned ? 'unaligned' : 'aligned'}.`); return true;
      case '\\t': o.tuplesOnly = arg === 'off' ? false : arg === 'on' ? true : !o.tuplesOnly; this.out.push(`Tuples only is ${o.tuplesOnly ? 'on' : 'off'}.`); return true;
      case '\\i': case '\\include': {
        const text = this.io.sh.readFile(arg);
        if (text === null) { this.err.push(`${arg}: No such file or directory`); return true; }
        return this.script(text, arg);
      }
      case '\\copy': return this.backslashCopy(line.trim().slice(5).trim(), where);
      case '\\?': this.out.push('General', '  \\copyright             show PostgreSQL usage and distribution terms', '  \\q                     quit psql', '', 'Informational', '  \\d[S+]                 list tables, views, and sequences', '  \\d[S+]  NAME           describe table, view, sequence, or index', '  \\dt[S+] [PATTERN]      list tables', '  \\l[+]   [PATTERN]      list databases'); return true;
      case '\\!': return true;
      case '\\watch': this.err.push('\\watch cannot be used with an empty query'); return true;
      default:
        this.err.push(`${where ? `psql:${where}: ` : ''}invalid command ${cmd}`, 'Try \\? for help.');
        return true;
    }
  }
  describe(name, where, titled) {
    const exists = this.db.prepare("SELECT type FROM main.sqlite_master WHERE name = ?").get(name);
    if (!exists) { this.err.push(`Did not find any relation named "${name}".`); return true; }
    const cols = columnsOf(this.db, name);
    const out = titled(`Table "public.${name}"`, { columns: ['Column', 'Type', 'Collation', 'Nullable', 'Default'].map(l => ({ label: l })), rows: cols.map(c => [c.name, c.type, '', c.nullable ? '' : 'not null', c.default ?? '']) });
    // A table description has no row-count footer.
    out.splice(-2, 2);
    const indexes = this.db.prepare(`PRAGMA main.index_list("${name}")`).all();
    const lines_ = [];
    if (cols.some(c => c.pk)) lines_.push(`    "${name}_pkey" PRIMARY KEY, btree (${cols.filter(c => c.pk).map(c => c.name).join(', ')})`);
    for (const ix of indexes.filter(i => !i.name.startsWith('sqlite_autoindex')).sort((a, b) => a.name.localeCompare(b.name))) {
      const on = this.db.prepare(`PRAGMA main.index_info("${ix.name}")`).all().map(c => c.name).join(', ');
      lines_.push(`    "${ix.name}"${ix.unique ? ' UNIQUE CONSTRAINT,' : ''} btree (${on})`);
    }
    const pk = cols.filter(c => c.pk).map(c => c.name).join(',');
    for (const ix of indexes.filter(i => i.name.startsWith('sqlite_autoindex'))) {
      const on = this.db.prepare(`PRAGMA main.index_info("${ix.name}")`).all().map(c => c.name);
      if (on.join(',') === pk) continue;
      lines_.push(`    "${name}_${on.join('_')}_key" UNIQUE CONSTRAINT, btree (${on.join(', ')})`);
    }
    if (lines_.length) out.push('Indexes:', ...lines_);
    const create = this.db.prepare("SELECT sql FROM main.sqlite_master WHERE name = ?").get(name)?.sql ?? '';
    const checks = [];
    for (const m of create.matchAll(/CONSTRAINT (\w+) CHECK \(/g)) {
      let depth = 1, k = m.index + m[0].length;
      for (; k < create.length && depth; k++) { if (create[k] === '(') depth++; else if (create[k] === ')') depth--; }
      checks.push(`    "${m[1]}" CHECK (${create.slice(m.index + m[0].length, k - 1).replace(/\bIN \(([^)]*)\)/, (_, list) => `= ANY (ARRAY[${list.split(',').map(v => `${v.trim()}::text`).join(', ')}])`)})`);
    }
    if (checks.length) out.push('Check constraints:', ...checks);
    const fks = this.db.prepare(`PRAGMA main.foreign_key_list("${name}")`).all();
    if (fks.length) out.push('Foreign-key constraints:', ...fks.map(f => `    "${name}_${f.from}_fkey" FOREIGN KEY (${f.from}) REFERENCES ${f.table}(${f.to})`));
    out.push('');
    this.print(out);
    return true;
  }
  backslashCopy(spec, where) {
    const prefix = where ? `psql:${where}: ` : '';
    const m = /^(\([\s\S]+\)|[\w.]+(?:\s*\([^)]*\))?)\s+(to|from)\s+('[^']*'|\S+)\s*(?:with\s*)?([\s\S]*)$/i.exec(spec);
    if (!m) { this.err.push(`${prefix}\\copy: parse error at end of line`); return true; }
    const file = m[3].replace(/^'(.*)'$/, '$1');
    if (m[2].toLowerCase() === 'to') {
      let result;
      try { result = this.exportRows(m[1]); } catch (e) { this.err.push(...pgError(e).map((l, k) => (k ? l : prefix + l))); return true; }
      const text = csvLines(result, m[4]).map(l => `${l}\n`).join('');
      if (file === 'stdout' || file === 'pstdout') this.print(lines(text));
      else {
        const problem = this.io.sh.writeFile(file, text);
        if (problem) { this.err.push(`${file}: ${problem}`); return true; }
      }
      this.ctx.event('sql.export', { instance: this.conn.name, sources: sourcesOf(`from ${m[1]}`), rows: result.rows.length, to: file });
      this.tag(`COPY ${result.rows.length}`);
      return true;
    }
    const text = this.io.sh.readFile(file);
    if (text === null) { this.err.push(`${file}: No such file or directory`); return true; }
    const target = /^([\w.]+)\s*(?:\(([^)]*)\))?$/.exec(m[1].trim());
    if (!target) { this.err.push(`${prefix}\\copy: parse error at end of line`); return true; }
    if (this.conn.readOnly) { this.err.push(`${prefix}ERROR:  cannot execute COPY FROM in a read-only transaction`); return true; }
    const rows = parseCsv(text);
    if (/header/i.test(m[4])) rows.shift();
    const cols = target[2] ? target[2].split(',').map(s => s.trim()) : columnsOf(this.db, target[1]).map(c => c.name);
    try {
      const insert = this.db.prepare(`INSERT INTO ${target[1]} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      const own = this.txn === 'none';
      if (own) this.db.exec('BEGIN');
      try { for (const r of rows) insert.run(...r.map(v => (v === '' ? null : normalizeTimestamp(v) ?? v))); if (own) this.db.exec('COMMIT'); }
      catch (e) { if (own) this.db.exec('ROLLBACK'); throw e; }
      this.note('sql.statement', { instance: this.conn.name, verb: 'COPY FROM', table: target[1].toLowerCase(), sources: [], rows: rows.length, sql: `\\copy ${spec}`.slice(0, 600) });
      this.tag(`COPY ${rows.length}`);
    } catch (e) { this.err.push(...pgError(e).map((l, k) => (k ? l : prefix + l))); if (this.txn !== 'none') this.txn = 'aborted'; }
    return true;
  }
  /** A file or stdin: statement by statement, the way psql reads a script. */
  script(text, name) {
    let buffer = '', startLine = 1, lineNo = 0;
    const all = text.split('\n');
    for (const raw of all) {
      lineNo++;
      if (this.stopped) break;
      if (!buffer.trim() && /^\s*\\/.test(raw)) {
        if (this.meta(raw, `${name}:${lineNo}`) === false) break;
        continue;
      }
      if (!buffer.trim()) startLine = lineNo;
      buffer += `${raw}\n`;
      const parts = splitSql(buffer);
      const complete = parts.filter(p => !p.unterminated);
      if (!complete.length) continue;
      const rest = parts.find(p => p.unterminated);
      buffer = rest ? rest.sql : '';
      for (const p of complete) {
        const ok = this.statement(p.sql, `${name}:${lineNo}`);
        if (!ok && this.o.onErrorStop) { this.code = 3; this.stopped = true; break; }
      }
      void startLine;
    }
    if (buffer.trim() && !this.stopped) {
      // psql sends a final statement without a semicolon at end of input.
      const ok = this.statement(buffer.trim(), `${name}:${lineNo}`);
      if (!ok && this.o.onErrorStop) { this.code = 3; this.stopped = true; }
    }
    return true;
  }
  /** One -c string: a single query message, so one implicit transaction that stops at an error. */
  command(text) {
    if (/^\s*\\/.test(text)) {
      for (const part of text.split(/(?=\\[a-z!?])/i)) if (part.trim() && this.meta(part.trim(), '') === false) break;
      return;
    }
    const parts = splitSql(text);
    if (parts.length > 1 && this.txn === 'none') this.begin('implicit');
    for (const [k, p] of parts.entries()) {
      const ok = this.statement(p.sql, '');
      if (!ok) {
        this.code = 1;
        if (this.txn !== 'none') this.rollback();
        return;
      }
      if (this.txn === 'none' && k < parts.length - 1 && parts.length > 1) this.begin('implicit');
    }
    if (this.txn === 'implicit') this.commit();
  }
  close() { if (this.txn !== 'none') this.rollback(); }
}
function csvLines(result, options) {
  const csv = /\bcsv\b|format\s*\(?\s*csv/i.test(options ?? '');
  const header = /\bheader\b/i.test(options ?? '');
  const delimiter = csv ? ',' : '\t';
  const q = (s) => (csv && /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const out = [];
  if (header) out.push(result.columns.map(c => q(c.label)).join(delimiter));
  for (const r of result.rows) out.push(r.map((v, k) => (v === null ? (csv ? '' : '\\N') : q(show(v, result.columns[k].type)))).join(delimiter));
  return out;
}
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quoted) { if (c === '"') { if (text[k + 1] === '"') { field += '"'; k++; } else quoted = false; } else field += c; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Parses `postgresql://user@host:port/db` and `host=... dbname=...` connection strings. */
function conninfo(text) {
  const out = {};
  if (/^postgres(ql)?:\/\//.test(text)) {
    try {
      const u = new URL(text);
      if (u.hostname) out.host = decodeURIComponent(u.hostname);
      if (u.port) out.port = u.port;
      if (u.username) out.user = decodeURIComponent(u.username);
      if (u.pathname.length > 1) out.dbname = decodeURIComponent(u.pathname.slice(1));
      for (const [k, v] of u.searchParams) if (['host', 'port', 'user', 'dbname'].includes(k)) out[k] = v;
    } catch { out.invalid = true; }
    return out;
  }
  for (const [, k, v] of text.matchAll(/(\w+)\s*=\s*('(?:[^']*)'|\S+)/g)) out[k] = v.replace(/^'(.*)'$/, '$1');
  return out;
}

export function makePsql(ctx, { resolve }) {
  return function psql(argv, io) {
    const o = { separator: '|', tuplesOnly: false, unaligned: false, expanded: false, quiet: false, onErrorStop: false, echo: false, format: undefined, single: false };
    const actions = [];
    const target = {};
    const positional = [];
    const takes = { c: 'command', f: 'file', h: 'host', p: 'port', U: 'user', d: 'dbname', F: 'separator', v: 'variable', P: 'pset', o: 'output', R: 'recordsep' };
    const long = { command: 'command', file: 'file', host: 'host', port: 'port', username: 'user', dbname: 'dbname', 'field-separator': 'separator', variable: 'variable', set: 'variable', pset: 'pset', output: 'output' };
    const apply = (key, value) => {
      if (key === 'command') actions.push({ kind: 'c', text: value });
      else if (key === 'file') actions.push({ kind: 'f', path: value });
      else if (key === 'separator') o.separator = value;
      else if (key === 'variable') { const [k, v] = String(value).split('='); if (k.toUpperCase() === 'ON_ERROR_STOP') o.onErrorStop = !/^(0|off|false)$/i.test(v ?? '1'); }
      else if (key === 'pset') { const [k, v] = String(value).split('='); if (k === 'format') { o.unaligned = v === 'unaligned'; o.format = v === 'csv' ? 'csv' : undefined; } if (k === 'tuples_only') o.tuplesOnly = v !== 'off'; if (k === 'fieldsep') o.separator = v; }
      else if (key === 'output') o.output = value;
      else if (key !== 'recordsep') target[key] = value;
    };
    for (let k = 0; k < argv.length; k++) {
      const a = argv[k];
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
        if (long[name]) { apply(long[name], eq > 0 ? a.slice(eq + 1) : argv[++k]); continue; }
        const flag = { 'tuples-only': 't', 'no-align': 'A', expanded: 'x', quiet: 'q', 'no-psqlrc': 'X', 'single-transaction': '1', 'echo-queries': 'e', 'echo-all': 'a', csv: 'csv', 'no-password': 'w', password: 'W', version: 'V', help: '?' }[name];
        if (!flag) return { err: [`psql: error: unrecognized option '--${name}'`, 'Try "psql --help" for more information.'], code: 1 };
        if (flag === 'csv') { o.format = 'csv'; continue; }
        if (flag === 'V') return { out: ['psql (PostgreSQL) 15.8 (Debian 15.8-0+deb12u1)'] };
        if (flag === '?') return { out: ['psql is the PostgreSQL interactive terminal.', '', 'Usage:', '  psql [OPTION]... [DBNAME [USERNAME]]'] };
        setFlag(flag);
        continue;
      }
      if (a.startsWith('-') && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const f = a[j];
          if (takes[f]) { const value = a.slice(j + 1) || argv[++k]; if (value === undefined) return { err: [`psql: option requires an argument -- '${f}'`, 'Try "psql --help" for more information.'], code: 1 }; apply(takes[f], value); break; }
          if (f === 'V') return { out: ['psql (PostgreSQL) 15.8 (Debian 15.8-0+deb12u1)'] };
          if (!setFlag(f)) return { err: [`psql: invalid option -- '${f}'`, 'Try "psql --help" for more information.'], code: 1 };
        }
        continue;
      }
      positional.push(a);
    }
    function setFlag(f) {
      if (f === 't') o.tuplesOnly = true;
      else if (f === 'A') o.unaligned = true;
      else if (f === 'x') o.expanded = true;
      else if (f === 'q') o.quiet = true;
      else if (f === 'e' || f === 'a') o.echo = true;
      else if (f === '1') o.single = true;
      else if (f === 'l') actions.push({ kind: 'c', text: '\\l' });
      else if (!['X', 'w', 'W', 'b', 'n', 's', 'S', 'E', 'L'].includes(f)) return false;
      return true;
    }
    for (const [k, p] of positional.entries()) {
      if (/^postgres(ql)?:\/\//.test(p) || /\w+=/.test(p)) Object.assign(target, conninfo(p));
      else if (k === 0 && !target.dbname) target.dbname = p;
      else if (!target.user) target.user = p;
    }
    if (target.dbname && (/^postgres(ql)?:\/\//.test(target.dbname) || /\w+=/.test(target.dbname))) { const info = conninfo(target.dbname); delete target.dbname; Object.assign(target, info); }
    const env = io.env;
    const host = target.host ?? env.PGHOST;
    const port = String(target.port ?? env.PGPORT ?? '5432');
    const user = target.user ?? env.PGUSER ?? env.USER;
    const dbname = target.dbname ?? env.PGDATABASE ?? user;
    if (!host || host.startsWith('/')) {
      ctx.wait(0.1);
      return { err: [`psql: error: connection to server on socket "${host ?? '/var/run/postgresql'}/.s.PGSQL.${port}" failed: No such file or directory`, '\tIs the server running locally and accepting connections on that socket?'], code: 2 };
    }
    const conn = resolve({ host, port, dbname, user });
    if (conn.error) { ctx.wait(conn.wait ?? 0.2); return { err: [`psql: error: ${conn.error}`], code: 2 }; }
    ctx.wait(0.3);
    const session = new Session(ctx, io, { ...conn, host, port, dbname, user }, o);
    catalogs(session.conn, ctx);
    try {
      if (o.single) session.begin('explicit');
      if (actions.length) {
        for (const a of actions) {
          if (session.stopped) break;
          if (a.kind === 'c') { session.command(a.text); if (session.code && o.onErrorStop) break; }
          else {
            const text = a.path === '-' ? (io.stdin ?? []).join('\n') : io.sh.readFile(a.path);
            if (text === null) { session.err.push(`psql: error: ${a.path}: No such file or directory`); session.code = 1; break; }
            session.script(text, a.path === '-' ? '<stdin>' : a.path);
          }
        }
      } else if (io.stdin) session.script(io.stdin.join('\n'), '<stdin>');
      if (o.single && session.txn !== 'none') { if (session.code) session.rollback(); else session.tag(session.commit()); }
    } finally { session.close(); }
    if (o.output) { io.sh.writeFile(o.output, session.out.map(l => `${l}\n`).join('')); return { code: session.code }; }
    return { out: session.out, code: session.code };
  };
}
