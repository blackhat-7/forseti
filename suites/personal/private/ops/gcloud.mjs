/**
 * The `gcloud` front end: global flags, `--format`, `config`, `auth`, `projects`, and dispatch to
 * command groups a scenario supplies (`sql`, `container`, `storage`, ...). A group is
 *   (args, io, g) => result
 * where `args` are the words after the group name and `g` carries what every group needs:
 *   g.project   the effective project (--project, else the active config)
 *   g.flag(name) / g.has(name)   parsed --flags, with `--name value` and `--name=value` both accepted
 *   g.positional                 operands that are not flags
 *   g.print(value, table)        honours --format; `table` is [headers, rowOf] for the default view
 *   g.confirm(message)           gcloud's Y/n prompt as it behaves with no terminal attached
 *   g.error(message)             `ERROR: (gcloud.<command>) message`, exit 1
 */
import { table } from './world.mjs';

/** Flags that never take a value, so `--quiet sql` is not read as `--quiet=sql`. */
const BOOLEAN = new Set(['quiet', 'q', 'async', 'verbosity-debug', 'help', 'all', 'recursive', 'r', 'no-user-output-enabled', 'uniform-bucket-level-access', 'no-uniform-bucket-level-access', 'versioning', 'no-versioning', 'dry-run', 'delete-unmatched-destination-objects', 'no-clobber', 'no-backup', 'enable-bin-log', 'no-enable-bin-log', 'clear-database-flags', 'internal-ip', 'no-promote', 'summarize', 'long', 'l', 'full', 'update', 'wait', 'no-wait', 'enable-cdn', 'no-enable-cdn', 'skip-if-exists', 'continue-on-error', 'dry_run', 'execute-now', 'follow', 'freshness', 'include-managed-folders', 'soft-deleted', 'include-labels', 'overwrite', 'all-versions', 'public-access-prevention', 'readable-sizes', 'enable-autoclass', 'requester-pays', 'default-event-based-hold', 'skip-if-dest-has-newer-mtime', 'checksums-only', 'exclude-symlinks', 'preserve-posix', 'no-ignore-symlinks']);

export function makeGcloud(ctx, groups) {
  return function gcloud(argv, io) {
    const words = [], flags = {};
    for (let k = 0; k < argv.length; k++) {
      const a = argv[k];
      if (a === '--') { words.push(...argv.slice(k + 1)); break; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
        const name = a.slice(2);
        if (BOOLEAN.has(name) || name.startsWith('no-') || argv[k + 1] === undefined || argv[k + 1].startsWith('--')) flags[name] = true;
        else flags[name] = argv[++k];
        continue;
      }
      if (a === '-q') { flags.quiet = true; continue; }
      words.push(a);
    }
    const cfg = ctx.state.gcloud;
    const [group, ...rest] = words;
    const command = words.filter(w => /^[a-z][a-z-]*$/.test(w)).slice(0, 3).join('.');
    const g = {
      project: typeof flags.project === 'string' ? flags.project : cfg.project,
      account: cfg.account,
      flags,
      flag: (name) => flags[name],
      has: (name) => flags[name] !== undefined,
      positional: rest,
      quiet: Boolean(flags.quiet),
      error: (message, code = 1) => ({ err: [`ERROR: (gcloud.${command}) ${message}`], code }),
      print: (value, view) => format(Array.isArray(value) ? listed(value, flags) : value, flags.format, view),
      /** With no terminal, gcloud takes the prompt's default and says so. */
      confirm: (message, fallback = true) => ({ ok: flags.quiet ? true : fallback, lines: flags.quiet ? [] : [message, '', 'Do you want to continue (Y/n)?  ', ''] }),
    };
    if (!group) return { err: ['ERROR: (gcloud) Command name argument expected.', '', 'Available groups for gcloud:', ...Object.keys({ ...BUILTIN, ...groups }).sort().map(n => `      ${n}`), '', "For detailed information on this command and its flags, run:", '  gcloud --help'], code: 2 };
    if (flags.help || group === 'help') return { out: [`NAME`, `    gcloud ${words.join(' ')}`, '', 'SYNOPSIS', `    gcloud ${words.join(' ')} [FLAGS]`] };
    ctx.wait(2);
    const handler = groups[group] ?? BUILTIN[group];
    if (!handler) return { err: [`ERROR: (gcloud) Invalid choice: '${group}'.`, 'Maybe you meant:', '  gcloud config', '', 'To search the help text of gcloud commands, run:', `  gcloud help -- SEARCH_TERMS`], code: 2 };
    return handler(rest, io, g, ctx);
  };
}

const BUILTIN = {
  config(args, _io, g, ctx) {
    const cfg = ctx.state.gcloud;
    const [verb, key, value] = args;
    const props = { 'core/account': cfg.account, 'core/project': cfg.project, 'compute/region': cfg.region, 'compute/zone': cfg.zone, 'core/disable_usage_reporting': 'True' };
    const resolve = (k) => (k?.includes('/') ? k : ({ account: 'core/account', project: 'core/project', region: 'compute/region', zone: 'compute/zone' }[k] ?? `core/${k}`));
    if (verb === 'list') {
      const sections = {};
      for (const [k, v] of Object.entries(props)) { if (v === undefined) continue; const [s, n] = k.split('/'); (sections[s] ??= []).push(`${n} = ${v}`); }
      // The shell prints a program's stderr before its stdout; gcloud prints this note last, so it goes to stdout here.
      return { out: [...Object.entries(sections).sort().flatMap(([s, entries]) => [`[${s}]`, ...entries]), '', `Your active configuration is: [${cfg.configuration ?? 'default'}]`] };
    }
    if (verb === 'get-value' || verb === 'get') {
      const v = props[resolve(key)];
      return v === undefined ? { err: ['(unset)'] } : { out: [v] };
    }
    if (verb === 'set') {
      const k = resolve(key);
      if (k === 'core/project') {
        cfg.project = value;
        ctx.event('gcloud.config.project', { project: value });
        return { err: ['Updated property [core/project].'] };
      }
      if (k === 'compute/region') { cfg.region = value; return { err: ['Updated property [compute/region].'] }; }
      if (k === 'compute/zone') { cfg.zone = value; return { err: ['Updated property [compute/zone].'] }; }
      return { err: [`Updated property [${k}].`] };
    }
    if (verb === 'configurations' && key === 'list') return { out: table(['NAME', 'IS_ACTIVE', 'ACCOUNT', 'PROJECT', 'COMPUTE_DEFAULT_ZONE', 'COMPUTE_DEFAULT_REGION'], [[cfg.configuration ?? 'default', 'True', cfg.account, cfg.project, cfg.zone ?? '', cfg.region ?? '']]) };
    return g.error(`Invalid choice: '${verb ?? ''}'.`, 2);
  },
  auth(args, _io, g, ctx) {
    const cfg = ctx.state.gcloud;
    if (args[0] === 'list') return { out: [`       Credentialed Accounts`, 'ACTIVE  ACCOUNT', `*       ${cfg.account}`, '', 'To set the active account, run:', '    $ gcloud config set account `ACCOUNT`', ''] };
    if (args[0] === 'print-access-token' || args[0] === 'print-identity-token') return { out: ['ya29.a0AfB_byCQm9ndXMtdG9rZW4tZm9yLW9uY2FsbC1zZXNzaW9u'] };
    if (args[0] === 'login' || args[0] === 'application-default') return { err: ['ERROR: (gcloud.auth.login) There was a problem with web authentication. Try running again with --no-browser.'], code: 1 };
    return g.error(`Invalid choice: '${args[0] ?? ''}'.`, 2);
  },
  projects(args, _io, g, ctx) {
    const projects = ctx.state.gcloud.projects;
    if (args[0] === 'list') return g.print(projects.map(p => ({ projectId: p.id, name: p.name, projectNumber: p.number })), [['PROJECT_ID', 'NAME', 'PROJECT_NUMBER'], p => [p.projectId, p.name, p.projectNumber]]);
    if (args[0] === 'describe') {
      const p = projects.find(x => x.id === args[1]);
      if (!p) return g.error(`Project [${args[1]}] not found or permission denied.`);
      return g.print({ createTime: '2019-03-11T09:22:41.118Z', lifecycleState: 'ACTIVE', name: p.name, projectId: p.id, projectNumber: p.number });
    }
    return g.error(`Invalid choice: '${args[0] ?? ''}'.`, 2);
  },
  version() {
    return { out: ['Google Cloud SDK 495.0.0', 'alpha 2024.10.04', 'beta 2024.10.04', 'bq 2.1.9', 'core 2024.10.04', 'gcloud-crc32c 1.0.0', 'gke-gcloud-auth-plugin 0.5.9', 'gsutil 5.30', 'kubectl 1.30.5'] };
  },
  info(_args, _io, _g, ctx) {
    const cfg = ctx.state.gcloud;
    return { out: ['Google Cloud SDK [495.0.0]', '', 'Platform: [Linux, x86_64]', 'Python Version: [3.11.2]', 'Installation Root: [/usr/lib/google-cloud-sdk]', '', `Account: [${cfg.account}]`, `Project: [${cfg.project}]`] };
  },
  components() { return { err: ['ERROR: (gcloud.components.update) ', 'You cannot perform this action because the Google Cloud CLI component manager', 'is disabled for this installation.'], code: 1 }; },
};

/**
 * The list flags every gcloud list command takes: `--filter` (terms joined by AND, each `key=v`,
 * `key:v` (substring), `key~regex` or `key!=v`, with `NOT` and quotes), `--sort-by` (`~` for
 * descending) and `--limit`.
 */
function listed(items, flags) {
  let out = items;
  if (typeof flags.filter === 'string' && flags.filter.trim()) {
    const terms = flags.filter.split(/\s+AND\s+/i).map(term => {
      const negate = /^NOT\s+/i.test(term.trim()) || term.trim().startsWith('-');
      const m = /^(?:NOT\s+|-)?([\w.]+)\s*(!=|=|:|~|<=|>=|<|>)\s*(.*)$/i.exec(term.trim());
      if (!m) return () => true;
      const [, path, op, raw] = m;
      const want = raw.replace(/^["']|["']$/g, '');
      return (item) => {
        const v = stringify(get(item, path));
        const hit = op === '=' ? v === want || v.toLowerCase() === want.toLowerCase() : op === '!=' ? v !== want : op === ':' ? v.toLowerCase().includes(want.toLowerCase().replace(/\*$/, '')) : op === '~' ? new RegExp(want).test(v) : op === '<' ? v < want : op === '>' ? v > want : op === '<=' ? v <= want : v >= want;
        return negate ? !hit : hit;
      };
    });
    out = out.filter(item => terms.every(t => t(item)));
  }
  if (typeof flags['sort-by'] === 'string') {
    for (const key of flags['sort-by'].split(',').reverse()) {
      const desc = key.startsWith('~'), path = key.replace(/^~/, '');
      out = [...out].sort((a, b) => { const x = stringify(get(a, path)), y = stringify(get(b, path)); return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1); });
    }
  }
  if (flags.limit !== undefined && Number(flags.limit) >= 0) out = out.slice(0, Number(flags.limit));
  return out;
}
/** `--format`: json, yaml, value(...), csv(...), table(...), or the group's default table. */
export function format(value, spec, view) {
  const list = Array.isArray(value) ? value : [value];
  if (!spec) {
    if (view && Array.isArray(value)) {
      const [headers, rowOf] = view;
      if (!value.length) return { err: ['Listed 0 items.'] };
      return { out: table(headers, value.map(rowOf), 2) };
    }
    return { out: yaml(value) };
  }
  const m = /^(\w+)(?:\[([^\]]*)\])?(?:\((.*)\))?$/s.exec(spec.trim());
  const kind = m?.[1];
  if (kind === 'json') return { out: JSON.stringify(value, null, 2).split('\n') };
  if (kind === 'yaml') return { out: Array.isArray(value) ? value.flatMap(v => ['---', ...yaml(v)]) : yaml(value) };
  if (kind === 'value' || kind === 'csv' || kind === 'table' || kind === 'list') {
    const fields = splitFields(m[3] ?? '');
    const pick = (v) => fields.map(f => stringify(get(v, f.path)));
    if (!fields.length) return { out: list.map(v => stringify(v)) };
    if (kind === 'value') return { out: list.map(v => pick(v).join('\t')) };
    if (kind === 'csv') return { out: [fields.map(f => f.label).join(','), ...list.map(v => pick(v).join(','))] };
    if (kind === 'list') return { out: list.map(v => ` - ${pick(v).join(' ')}`) };
    return { out: table(fields.map(f => f.label.toUpperCase()), list.map(pick), 2) };
  }
  return { err: [`ERROR: (gcloud) Format [${spec}] is not a valid format.`], code: 1 };
}
function splitFields(text) {
  return text.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const label = /:label=([\w-]+)/.exec(s)?.[1];
    const path = s.replace(/:.*$/, '').replace(/\.(?:basename|date|yesno)\(\)$/, '');
    return { path, label: label ?? path.split('.').pop() };
  });
}
function get(v, path) {
  let cur = v;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && !/^\d+$/.test(part)) cur = cur.map(x => x?.[part]).join(';');
    else cur = cur[part];
  }
  return cur;
}
const stringify = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
/** The block YAML gcloud prints by default for a single resource. */
export function yaml(value, indent = '') {
  if (value === null || value === undefined) return [`${indent}null`];
  if (typeof value !== 'object') return [`${indent}${scalar(value)}`];
  const out = [];
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}[]`];
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length) {
        const [first, ...rest] = yaml(item, `${indent}  `);
        out.push(`${indent}- ${first.trimStart()}`, ...rest);
      } else out.push(`${indent}- ${typeof item === 'object' ? JSON.stringify(item) : scalar(item)}`);
    }
    return out;
  }
  for (const [k, v] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
      out.push(`${indent}${k}:`, ...yaml(v, Array.isArray(v) ? indent : `${indent}  `));
    } else out.push(`${indent}${k}: ${v && typeof v === 'object' ? (Array.isArray(v) ? '[]' : '{}') : scalar(v)}`);
  }
  return out;
}
const scalar = (v) => (typeof v === 'string' ? (/^[\w./@:+-][\w ./@:+,=#-]*$/.test(v) && !/^(true|false|null|yes|no|\d+(\.\d+)?)$/i.test(v) && !/:\s/.test(v) ? v : `'${v.replace(/'/g, "''")}'`) : String(v));
