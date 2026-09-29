/**
 * `gcloud scheduler`, `gcloud run` and `gcloud logging`.
 *
 *   makeGcloud(ctx, { scheduler: schedulerGroup(ctx), run: runGroup(ctx), logging: loggingGroup(ctx) })
 *
 * State:
 *   ctx.state.scheduler.jobs  [{ name, location, project, schedule, timeZone, state ('ENABLED'|'PAUSED'),
 *                               description?, target: { uri, httpMethod, serviceAccount }, lastAttempt?, updated? }]
 *   ctx.state.run.jobs        [{ name, region, project, image, envs, updated, updatedBy, serviceAccount,
 *                               executions: [{ name, start, end, succeeded, by }], cloudsql?, memory?, cpu? }]
 *   ctx.state.run.services    [{ name, region, project, image, url, revision, deployed, deployedBy, envs }]
 *   ctx.state.run.images      { 'registry/path': ['v1', 'v2'] }   tags that exist, for --image checks
 *   ctx.state.run.execute     (job, by) => void                   what running a job does to the world
 *   ctx.state.logs            [{ t, severity, resource: { type, labels }, textPayload | jsonPayload, logName }]
 *
 * `cronMatches(expr, date)` answers whether a five-field cron schedule fires at a UTC minute, for a
 * world's tick. Every change is recorded as an event: 'scheduler.pause', 'scheduler.resume',
 * 'scheduler.run', 'scheduler.delete', 'scheduler.update', 'run.job.update', 'run.job.execute',
 * 'run.job.delete'.
 */
import { table } from './world.mjs';

export function cronMatches(expr, d) {
  const fields = String(expr).trim().split(/\s+/);
  const values = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
  return fields.length === 5 && fields.every((f, k) => f.split(',').some(part => {
    const [range, step] = part.split('/');
    const [lo, hi] = range === '*' ? [0, 59] : range.includes('-') ? range.split('-').map(Number) : [Number(range), step ? 59 : Number(range)];
    const v = values[k];
    return v >= lo && v <= hi && (v - lo) % Number(step ?? 1) === 0;
  }));
}
/** The next virtual second at or after `t` at which the schedule fires, within a day. */
export function nextFire(ctx, job, t) {
  const start = Math.ceil((ctx.at(t).getTime()) / 60000) * 60000;
  for (let m = 0; m < 1440; m++) {
    const d = new Date(start + m * 60000);
    if (cronMatches(job.schedule, d)) return (d.getTime() - ctx.at(0).getTime()) / 1000;
  }
  return null;
}
const iso = (ctx, t, micro = false) => { const s = ctx.at(t).toISOString(); return micro ? s.replace(/\.(\d{3})Z$/, (_, ms) => `.${ms}${String(Math.abs(Math.round(t * 131)) % 1000).padStart(3, '0')}Z`) : s; };

export function schedulerGroup(ctx) {
  return function scheduler(args, _io, g) {
    const [resource, verb, ...rest] = args;
    const cmd = `scheduler.${resource ?? ''}.${verb ?? ''}`;
    const err = (m, code = 1) => ({ err: [`ERROR: (gcloud.${cmd}) ${m}`], code });
    if (resource !== 'jobs') return { err: [`ERROR: (gcloud.scheduler) Invalid choice: '${resource ?? ''}'.`, 'Maybe you meant:', '  gcloud scheduler jobs', '', 'To search the help text of gcloud commands, run:', '  gcloud help -- SEARCH_TERMS'], code: 2 };
    const location = g.flag('location');
    const jobs = () => ctx.state.scheduler.jobs.filter(j => !j.deleted && j.project === g.project && (typeof location !== 'string' || j.location === location));
    const noLocation = () => err('Could not determine the location for the project. Please try again with the --location flag.');
    const resourceName = (j) => `projects/${j.project}/locations/${j.location}/jobs/${j.name}`;
    const describe = (j) => ({
      attemptDeadline: '180s',
      httpTarget: { headers: { 'User-Agent': 'Google-Cloud-Scheduler' }, httpMethod: j.target.httpMethod ?? 'POST', oauthToken: { scope: 'https://www.googleapis.com/auth/cloud-platform', serviceAccountEmail: j.target.serviceAccount }, uri: j.target.uri },
      ...(j.lastAttempt !== undefined ? { lastAttemptTime: iso(ctx, j.lastAttempt, true) } : {}),
      name: resourceName(j),
      retryConfig: { maxBackoffDuration: '3600s', maxDoublings: 5, maxRetryDuration: '0s', minBackoffDuration: '5s' },
      schedule: j.schedule,
      ...(j.state === 'ENABLED' ? { scheduleTime: iso(ctx, nextFire(ctx, j, ctx.t + 1) ?? ctx.t) } : {}),
      state: j.state,
      status: {},
      timeZone: j.timeZone ?? 'Etc/UTC',
      userUpdateTime: iso(ctx, j.updated ?? -86400 * 40),
      ...(j.description ? { description: j.description } : {}),
    });
    if (verb === 'list') {
      if (typeof location !== 'string') return noLocation();
      return g.print(jobs().map(describe), [['ID', 'LOCATION', 'SCHEDULE (TZ)', 'TARGET_TYPE', 'STATE'], r => [r.name.split('/').pop(), r.name.split('/')[3], `${r.schedule} (${r.timeZone})`, 'HTTP', r.state]]);
    }
    const name = rest.find(a => !a.startsWith('-'));
    if (!['describe', 'pause', 'resume', 'run', 'delete', 'update', 'create'].includes(verb ?? '')) return { err: [`ERROR: (gcloud.scheduler.jobs) Invalid choice: '${verb ?? ''}'.`, 'Maybe you meant:', '  gcloud scheduler jobs list', '', 'To search the help text of gcloud commands, run:', '  gcloud help -- SEARCH_TERMS'], code: 2 };
    if (verb === 'create') return err('HTTPError 403: The principal (user or service account) lacks IAM permission "cloudscheduler.jobs.create" for the resource (or the resource may not exist).');
    if (verb === 'update') {
      const jobName = rest.filter(a => !a.startsWith('-'))[1];
      if (!['http', 'pubsub', 'app-engine'].includes(name ?? '')) return { err: [`ERROR: (gcloud.scheduler.jobs.update) Invalid choice: '${name ?? ''}'.`], code: 2 };
      if (!jobName) return err('argument JOB: Must be specified.', 2);
      if (typeof location !== 'string') return noLocation();
      const j = jobs().find(x => x.name === jobName);
      if (!j) return err(`NOT_FOUND: Job not found.`);
      if (typeof g.flag('schedule') === 'string') j.schedule = g.flag('schedule');
      if (typeof g.flag('uri') === 'string') j.target.uri = g.flag('uri');
      j.updated = ctx.t;
      ctx.event('scheduler.update', { job: j.name, schedule: j.schedule, uri: j.target.uri });
      return g.print(describe(j));
    }
    if (!name) return err('argument JOB: Must be specified.', 2);
    if (typeof location !== 'string') return noLocation();
    const j = jobs().find(x => x.name === name);
    if (!j) return err(`NOT_FOUND: Job not found.`);
    if (verb === 'describe') return g.print(describe(j));
    if (verb === 'pause') {
      if (j.state === 'PAUSED') return err(`FAILED_PRECONDITION: Job.state is PAUSED.`);
      j.state = 'PAUSED'; j.updated = ctx.t;
      ctx.event('scheduler.pause', { job: j.name });
      return { err: ['Job has been paused.'] };
    }
    if (verb === 'resume') {
      if (j.state === 'ENABLED') return err(`FAILED_PRECONDITION: Job.state is ENABLED.`);
      j.state = 'ENABLED'; j.updated = ctx.t;
      ctx.event('scheduler.resume', { job: j.name });
      return { err: ['Job has been resumed.'] };
    }
    if (verb === 'run') {
      ctx.event('scheduler.run', { job: j.name });
      j.lastAttempt = ctx.t;
      ctx.state.scheduler.fire?.(j, 'manual');
      return {};
    }
    if (verb === 'delete') {
      const c = g.confirm(`You are about to delete job [${j.name}].`);
      j.deleted = true;
      ctx.event('scheduler.delete', { job: j.name });
      return { err: [...c.lines, `Deleted job [${j.name}].`] };
    }
    return err('unsupported');
  };
}

export function runGroup(ctx) {
  return function run(args, _io, g) {
    const [resource, verb, ...rest] = args;
    const cmd = `run.${resource ?? ''}.${verb ?? ''}`;
    const err = (m, code = 1) => ({ err: [`ERROR: (gcloud.${cmd}) ${m}`], code });
    const region = typeof g.flag('region') === 'string' ? g.flag('region') : ctx.state.gcloud.runRegion;
    const needRegion = () => ({ err: [`ERROR: (gcloud.${cmd}) Required parameter [region] is not set. You can set it with the '--region' flag, or with 'gcloud config set run/region <region>'.`], code: 1 });
    const state = ctx.state.run;
    const jobs = () => state.jobs.filter(j => !j.deleted && j.project === g.project && (!region || j.region === region));
    const services = () => state.services.filter(s => s.project === g.project && (!region || s.region === region));
    if (resource === 'jobs') {
      if (verb === 'list') {
        return g.print(jobs().map(j => ({ name: j.name, region: j.region, lastRun: j.executions.at(-1), created: j.created ?? -86400 * 230, creator: j.createdBy ?? j.updatedBy })), [['   JOB', 'REGION', 'LAST RUN AT', 'CREATED', 'CREATED BY'], r => [`✔  ${r.name}`, r.region, r.lastRun ? iso(ctx, r.lastRun.start).replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '', iso(ctx, r.created).replace('T', ' ').replace(/\.\d+Z$/, ' UTC'), r.creator]]);
      }
      if (verb === 'executions') {
        const sub = rest[0];
        if (sub !== 'list' && sub !== 'describe') return { err: [`ERROR: (gcloud.run.jobs.executions) Invalid choice: '${sub ?? ''}'.`], code: 2 };
        if (!region) return needRegion();
        if (sub === 'describe') {
          const name = rest.slice(1).find(a => !a.startsWith('-'));
          const hit = jobs().flatMap(j => j.executions.map(e => ({ e, j }))).find(x => x.e.name === name);
          if (!hit) return err(`Cannot find execution [${name}].`);
          const done = ctx.t >= hit.e.end;
          return { out: [`${done ? (hit.e.succeeded ? '✔' : '✘') : '…'} Execution ${hit.e.name} in region ${hit.j.region}`, `${done ? '1 task completed successfully' : '1 task running'}`, `Elapsed time: ${Math.round(hit.e.end - hit.e.start)} seconds`, '', `Image:           ${hit.e.image ?? hit.j.image}`, `Tasks:           1`, `Task Timeout:    600s`, `Max Retries:     0`] };
        }
        const jobName = g.flag('job');
        const list = jobs().filter(j => typeof jobName !== 'string' || j.name === jobName).flatMap(j => j.executions.map(e => ({ e, j }))).sort((a, b) => b.e.start - a.e.start);
        const limit = Number(g.flag('limit') ?? list.length);
        return g.print(list.slice(0, limit).map(({ e, j }) => ({ name: e.name, job: j.name, region: j.region, running: ctx.t < e.end ? 1 : 0, complete: ctx.t >= e.end ? `${e.succeeded ? 1 : 0} / 1` : '0 / 1', created: iso(ctx, e.start).replace('T', ' ').replace(/\.\d+Z$/, ' UTC'), by: e.by })), [['   EXECUTION', 'JOB', 'REGION', 'RUNNING', 'COMPLETE', 'CREATED', 'RUN BY'], r => [`${r.running ? '…' : '✔'}  ${r.name}`, r.job, r.region, r.running, r.complete, r.created, r.by]]);
      }
      const name = rest.find(a => !a.startsWith('-'));
      if (!['describe', 'update', 'execute', 'delete', 'create', 'deploy'].includes(verb ?? '')) return { err: [`ERROR: (gcloud.run.jobs) Invalid choice: '${verb ?? ''}'.`, 'Maybe you meant:', '  gcloud run jobs list', '', 'To search the help text of gcloud commands, run:', '  gcloud help -- SEARCH_TERMS'], code: 2 };
      if (!name) return err('argument JOB: Must be specified.', 2);
      if (!region) return needRegion();
      const j = jobs().find(x => x.name === name);
      if (verb === 'create' || (verb === 'deploy' && !j)) return err(`PERMISSION_DENIED: Permission 'run.jobs.create' denied on resource 'namespaces/${g.project}/jobs/${name}' (or resource may not exist).`);
      if (!j) return err(`Cannot find job [${name}].`);
      if (verb === 'describe') {
        if (g.flag('format')) return g.print({ apiVersion: 'run.googleapis.com/v1', kind: 'Job', metadata: { name: j.name, namespace: ctx.state.gcloud.projects.find(p => p.id === j.project)?.number, annotations: { 'run.googleapis.com/lastModifier': j.updatedBy } }, spec: { template: { spec: { template: { spec: { containers: [{ image: j.image, env: Object.entries(j.envs).map(([name, value]) => ({ name, value })) }], serviceAccountName: j.serviceAccount } } } } } });
        const width = Math.max(...Object.keys(j.envs).map(k => k.length));
        return { out: [
          `✔ Job ${j.name} in region ${j.region}`,
          `Executed ${j.executed ?? j.executions.length} times`,
          ...(j.executions.length ? [`Last executed ${iso(ctx, j.executions.at(-1).start)} with execution ${j.executions.at(-1).name}`] : []),
          '',
          `Last updated on ${iso(ctx, j.updated)} by ${j.updatedBy}:`,
          `  Image:           ${j.image}`,
          '  Tasks:           1',
          `  Memory:          ${j.memory ?? '512Mi'}`,
          `  CPU:             ${j.cpu ?? '1000m'}`,
          '  Task Timeout:    600s',
          '  Max Retries:     0',
          '  Parallelism:     No limit',
          `  Service account: ${j.serviceAccount}`,
          '  Env vars:',
          ...Object.entries(j.envs).map(([k, v]) => `    ${k.padEnd(width)} ${v}`),
          ...(j.cloudsql ? [`  Cloud SQL connections: ${j.cloudsql}`] : []),
        ] };
      }
      if (verb === 'update' || verb === 'deploy') {
        const image = g.flag('image');
        const changes = {};
        if (typeof image === 'string') {
          const [repo, tag] = image.includes('@') ? [image.split('@')[0], null] : [image.slice(0, image.lastIndexOf(':')), image.slice(image.lastIndexOf(':') + 1)];
          const tags = state.images[repo];
          if (!tags || (tag && !tags.includes(tag))) return err(`Image '${image}' not found.`);
          changes.image = image;
        }
        const envs = { ...j.envs };
        for (const key of ['update-env-vars', 'set-env-vars']) {
          if (typeof g.flag(key) !== 'string') continue;
          if (key === 'set-env-vars') for (const k of Object.keys(envs)) delete envs[k];
          for (const pair of g.flag(key).split(',')) { const [k, ...v] = pair.split('='); envs[k] = v.join('='); }
          changes.envs = envs;
        }
        if (typeof g.flag('remove-env-vars') === 'string') { for (const k of g.flag('remove-env-vars').split(',')) delete envs[k]; changes.envs = envs; }
        if (!Object.keys(changes).length && !['tasks', 'memory', 'cpu', 'task-timeout', 'max-retries', 'parallelism'].some(f => g.has(f))) return err('No configuration change requested. Did you mean to include the flags `--update-env-vars`, `--image`?');
        Object.assign(j, changes);
        j.updated = ctx.t; j.updatedBy = ctx.state.gcloud.account;
        ctx.event('run.job.update', { job: j.name, image: j.image, envs: { ...j.envs } });
        ctx.wait(6);
        const lines = [`Updating Cloud Run job [${j.name}] in project [${j.project}] region [${j.region}]`, 'Updating job... Done.', 'Done.', `Job [${j.name}] has successfully been updated.`, '', 'To execute this job, use:', `gcloud run jobs execute ${j.name}`];
        if (g.has('execute-now')) { state.execute?.(j, ctx.state.gcloud.account); lines.push(`Execution [${j.executions.at(-1)?.name}] has successfully started running.`); }
        return { err: lines };
      }
      if (verb === 'execute') {
        state.execute?.(j, ctx.state.gcloud.account);
        const e = j.executions.at(-1);
        ctx.event('run.job.execute', { job: j.name, execution: e?.name });
        if (g.has('wait')) ctx.wait(Math.max(0, (e?.end ?? ctx.t) - ctx.t));
        return { err: [`Creating execution...${g.has('wait') ? 'Done.' : ''}`, g.has('wait') ? `Execution [${e?.name}] has successfully completed.` : `Execution [${e?.name}] has successfully started running.`, '', 'View details about this execution by running:', `gcloud run jobs executions describe ${e?.name}`] };
      }
      if (verb === 'delete') {
        const c = g.confirm(`Job [${j.name}] will be deleted.`);
        j.deleted = true;
        ctx.event('run.job.delete', { job: j.name });
        return { err: [...c.lines, `Deleted job [${j.name}].`] };
      }
    }
    if (resource === 'services') {
      if (verb === 'list') {
        return g.print(services().map(s => ({ name: s.name, region: s.region, url: s.url, by: s.deployedBy, at: iso(ctx, s.deployed) })), [['   SERVICE', 'REGION', 'URL', 'LAST DEPLOYED BY', 'LAST DEPLOYED AT'], r => [`✔  ${r.name}`, r.region, r.url, r.by, r.at]]);
      }
      const name = rest.find(a => !a.startsWith('-'));
      if (verb === 'describe') {
        if (!name) return err('argument SERVICE: Must be specified.', 2);
        if (!region) return needRegion();
        const s = services().find(x => x.name === name);
        if (!s) return err(`Cannot find service [${name}]`);
        const width = Math.max(0, ...Object.keys(s.envs ?? {}).map(k => k.length));
        return { out: [`✔ Service ${s.name} in region ${s.region}`, '', `URL:     ${s.url}`, 'Ingress: internal', 'Traffic:', `  100% LATEST (currently ${s.revision})`, '', `Last updated on ${iso(ctx, s.deployed)} by ${s.deployedBy}:`, `  Revision ${s.revision}`, `  Container None`, `    Image:           ${s.image}`, '    Port:            8080', '    Memory:          512Mi', '    CPU:             1000m', ...(Object.keys(s.envs ?? {}).length ? ['    Env vars:', ...Object.entries(s.envs).map(([k, v]) => `      ${k.padEnd(width)} ${v}`)] : []), `  Service account:   ${s.serviceAccount ?? `${s.name}@${s.project}.iam.gserviceaccount.com`}`, '  Concurrency:       80', '  Min instances:     0', '  Max instances:     20', '  Timeout:           300s'] };
      }
      if (['update', 'deploy', 'delete', 'update-traffic'].includes(verb ?? '')) return err(`PERMISSION_DENIED: Permission 'run.services.update' denied on resource 'namespaces/${g.project}/services/${name ?? ''}' (or resource may not exist).`);
      return { err: [`ERROR: (gcloud.run.services) Invalid choice: '${verb ?? ''}'.`], code: 2 };
    }
    return { err: [`ERROR: (gcloud.run) Invalid choice: '${resource ?? ''}'.`, 'Maybe you meant:', '  gcloud run jobs', '  gcloud run services', '', 'To search the help text of gcloud commands, run:', '  gcloud help -- SEARCH_TERMS'], code: 2 };
  };
}

const SEVERITY = ['DEFAULT', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'];
/** The Logging query language, as far as one-line filters use it: AND, NOT, =, !=, :, comparisons. */
function matcher(ctx, filter) {
  const terms = [];
  const re = /(NOT\s+|-)?([\w.]+)\s*(>=|<=|!=|=|:|>|<)\s*("(?:[^"\\]|\\.)*"|\S+)|(NOT\s+|-)?("(?:[^"\\]|\\.)*"|[^\s()]+)/gi;
  for (const m of String(filter ?? '').matchAll(re)) {
    if (m[2]) terms.push({ not: Boolean(m[1]), path: m[2], op: m[3], value: m[4].replace(/^"(.*)"$/s, '$1') });
    else if (!/^(AND|OR)$/i.test(m[6])) terms.push({ not: Boolean(m[5]), text: m[6].replace(/^"(.*)"$/s, '$1') });
  }
  const get = (e, path) => {
    if (path === 'timestamp') return iso(ctx, e.t);
    if (path === 'severity') return e.severity;
    let cur = { ...e, logName: e.logName };
    for (const p of path.split('.')) cur = cur?.[p];
    return cur;
  };
  return (e) => terms.every(term => {
    let ok;
    if (term.text !== undefined) ok = JSON.stringify(e).toLowerCase().includes(term.text.toLowerCase());
    else {
      const v = get(e, term.path);
      if (term.path === 'severity' && ['>=', '<=', '>', '<', '='].includes(term.op)) {
        const a = SEVERITY.indexOf(String(v)), b = SEVERITY.indexOf(term.value.toUpperCase());
        ok = { '>=': a >= b, '<=': a <= b, '>': a > b, '<': a < b, '=': a === b }[term.op];
      } else if (term.path === 'timestamp') {
        const a = Date.parse(v), b = Date.parse(term.value);
        ok = { '>=': a >= b, '<=': a <= b, '>': a > b, '<': a < b, '=': a === b, '!=': a !== b }[term.op] ?? false;
      } else if (term.op === ':') ok = v !== undefined && String(typeof v === 'object' ? JSON.stringify(v) : v).toLowerCase().includes(term.value.toLowerCase());
      else if (term.op === '=') ok = String(v) === term.value;
      else if (term.op === '!=') ok = String(v) !== term.value;
      else ok = { '>=': v >= term.value, '<=': v <= term.value, '>': v > term.value, '<': v < term.value }[term.op];
    }
    return term.not ? !ok : ok;
  });
}
const DURATION = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
export function loggingGroup(ctx) {
  return function logging(args, _io, g) {
    const [verb, ...rest] = args;
    if (verb === 'logs' && rest[0] === 'list') {
      const names = [...new Set((ctx.state.logs ?? []).map(e => e.logName))].sort();
      return g.print(names.map(n => ({ name: n })), [['NAME'], r => [r.name]]);
    }
    if (verb !== 'read') return { err: [`ERROR: (gcloud.logging) Invalid choice: '${verb ?? ''}'.`, 'Maybe you meant:', '  gcloud logging read', '  gcloud logging logs list', '', 'To search the help text of gcloud commands, run:', '  gcloud help -- SEARCH_TERMS'], code: 2 };
    const filter = rest.filter(a => !a.startsWith('-')).join(' ');
    const fresh = /^(\d+)([smhdw])$/.exec(String(g.flag('freshness') ?? '1d'));
    if (!fresh) return { err: [`ERROR: (gcloud.logging.read) argument --freshness: given value must be of the form INTEGER[UNIT] where units can be one of s, m, h and d; received: ${g.flag('freshness')}`], code: 2 };
    const since = ctx.t - Number(fresh[1]) * DURATION[fresh[2]];
    const match = matcher(ctx, filter);
    let entries = (ctx.state.logs ?? []).filter(e => e.t <= ctx.t && e.t >= since && (!e.project || e.project === g.project) && match(e));
    entries.sort((a, b) => (g.flag('order') === 'asc' ? a.t - b.t : b.t - a.t));
    if (g.has('limit')) entries = entries.slice(0, Number(g.flag('limit')));
    ctx.wait(3);
    const shaped = entries.map((e, k) => ({
      insertId: e.insertId ?? `${(Math.abs(Math.round(e.t * 977)) + k).toString(36)}f${k.toString(36)}`,
      labels: e.labels,
      logName: e.logName,
      receiveTimestamp: iso(ctx, e.t + 0.21, true),
      resource: e.resource,
      severity: e.severity,
      ...(e.textPayload !== undefined ? { textPayload: e.textPayload } : { jsonPayload: e.jsonPayload }),
      timestamp: iso(ctx, e.t, true),
    }));
    if (!g.flag('format')) {
      const out = [];
      for (const e of shaped) out.push('---', ...g.print(e).out);
      return { out };
    }
    return g.print(shaped);
  };
}

