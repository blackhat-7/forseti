/**
 * gcloud groups for GKE and Cloud Logging: `container`, `logging`, and `monitoring` dashboards.
 *
 *   makeGkeGroups(ctx, { logs })   logs(filter, { limit, freshness }) -> entries, newest first,
 *                                  each shaped like a Cloud Logging LogEntry
 * Clusters come from ctx.state.gcloud.clusters: [{ project, name, location, version, endpoint, nodes, machine }].
 * `get-credentials` switches kubectl to `gke_<project>_<location>_<name>`, which must exist in ctx.state.kube.
 */
import { format, yaml } from './gcloud.mjs';

export function makeGkeGroups(ctx, { logs = () => [], dashboards = [] } = {}) {
  return {
    container(args, _io, g) {
      const [sub, verb, name] = g.positional.length ? [args[0], args[1], args[2]] : [];
      const clusters = ctx.state.gcloud.clusters.filter(c => c.project === g.project);
      const location = g.flag('region') ?? g.flag('location') ?? g.flag('zone') ?? ctx.state.gcloud.region;
      if (sub === 'clusters') {
        if (verb === 'list') {
          if (!clusters.length) return { err: ['Listed 0 items.'] };
          return g.print(clusters.map(c => ({ name: c.name, location: c.location, currentMasterVersion: c.version, endpoint: c.endpoint, nodeConfig: { machineType: c.machine }, currentNodeVersion: c.version, currentNodeCount: c.nodes, status: 'RUNNING' })), [['NAME', 'LOCATION', 'MASTER_VERSION', 'MASTER_IP', 'MACHINE_TYPE', 'NODE_VERSION', 'NUM_NODES', 'STATUS'], c => [c.name, c.location, c.currentMasterVersion, c.endpoint, c.nodeConfig.machineType, c.currentNodeVersion, c.currentNodeCount, c.status]]);
        }
        if (verb === 'describe' || verb === 'get-credentials') {
          if (!name) return g.error('argument NAME: Must be specified.', 2);
          const c = clusters.find(x => x.name === name && (!location || x.location === location));
          if (!c) return g.error(`ResponseError: code=404, message=Not found: projects/${g.project}/locations/${location}/clusters/${name}.\nNo cluster named '${name}' in ${g.project}.`);
          if (verb === 'describe') return g.print({ currentMasterVersion: c.version, currentNodeCount: c.nodes, currentNodeVersion: c.version, endpoint: c.endpoint, location: c.location, name: c.name, network: 'projects/' + c.project + '/global/networks/main', nodeConfig: { diskSizeGb: 100, machineType: c.machine }, releaseChannel: { channel: 'REGULAR' }, selfLink: `https://container.googleapis.com/v1/projects/${c.project}/locations/${c.location}/clusters/${c.name}`, status: 'RUNNING', workloadIdentityConfig: { workloadPool: `${c.project}.svc.id.goog` } });
          const context = `gke_${c.project}_${c.location}_${c.name}`;
          ctx.state.kube.current = context;
          ctx.event('kube.context', { context, via: 'get-credentials' });
          return { err: ['Fetching cluster endpoint and auth data.', `kubeconfig entry generated for ${c.name}.`] };
        }
        return g.error(`Invalid choice: '${verb ?? ''}'.`, 2);
      }
      if (sub === 'node-pools' && verb === 'list') {
        const cluster = g.flag('cluster');
        const c = clusters.find(x => x.name === cluster);
        if (!c) return g.error(`argument --cluster: ${cluster ? `No cluster named '${cluster}'` : 'Must be specified.'}`, cluster ? 1 : 2);
        return format([{ name: 'default-pool', config: { machineType: c.machine, diskSizeGb: 100 }, version: c.version }], g.flag('format'), [['NAME', 'MACHINE_TYPE', 'DISK_SIZE_GB', 'NODE_VERSION'], p => [p.name, p.config.machineType, p.config.diskSizeGb, p.version]]);
      }
      if (sub === 'operations' && verb === 'list') return { err: ['Listed 0 items.'] };
      return g.error(`Invalid choice: '${sub ?? ''}'.`, 2);
    },
    logging(args, _io, g) {
      const [sub] = args;
      if (sub === 'read') {
        const filter = g.positional.slice(1).join(' ');
        const limit = Number(g.flag('limit') ?? 1000);
        const freshness = parseFreshness(g.flag('freshness') ?? '1d');
        if (freshness === null) return g.error(`argument --freshness: Failed to parse duration: ${g.flag('freshness')}`, 2);
        const entries = logs(filter, { limit, freshness }).slice(0, limit);
        const fmt = g.flag('format');
        if (!entries.length) return {};
        if (fmt) return format(entries, fmt);
        return { out: entries.flatMap(e => ['---', ...yaml(e)]).slice(1) };
      }
      if (sub === 'logs' && args[1] === 'list') return { out: ['NAME', `projects/${g.project}/logs/stderr`, `projects/${g.project}/logs/stdout`, `projects/${g.project}/logs/cloudaudit.googleapis.com%2Factivity`, `projects/${g.project}/logs/events`] };
      if (sub === 'tail') return { err: ['ERROR: gcloud crashed (ImportError): Please ensure that the gRPC module is installed and the environment is correctly configured. Run:', 'sudo pip3 install grpcio', 'and set:', 'export CLOUDSDK_PYTHON_SITEPACKAGES=1', '', 'If you would like to report this issue, please run the following command:', '  gcloud feedback'], code: 1 };
      return g.error(`Invalid choice: '${sub ?? ''}'.`, 2);
    },
    monitoring(args, _io, g) {
      if (args[0] === 'dashboards' && args[1] === 'list') return g.print(dashboards, [['DISPLAY_NAME', 'ID'], d => [d.displayName, d.name.split('/').pop()]]);
      if (args[0] === 'dashboards' && args[1] === 'describe') {
        const d = dashboards.find(x => x.name.endsWith(`/${args[2]}`));
        return d ? g.print(d) : g.error(`NOT_FOUND: Requested entity was not found.`);
      }
      return g.error(`Invalid choice: '${args[0] ?? ''}'.`, 2);
    },
  };
}
function parseFreshness(text) {
  const m = /^(\d+)([smhdw])$/.exec(String(text));
  return m ? Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2]] : null;
}
/**
 * The subset of the Logging query language a quick incident query uses: `a.b="x"`, `a.b:x`,
 * `severity>=ERROR`, bare quoted text, joined by AND (implicit) or OR. Unknown syntax matches nothing.
 */
export function matchesFilter(entry, filter) {
  const text = filter.trim();
  if (!text) return true;
  const ors = text.split(/\s+OR\s+/);
  return ors.some(part => {
    const terms = part.match(/(?:[\w."/-]+\s*(?:>=|<=|!=|=|:|>|<)\s*(?:"[^"]*"|\S+))|"[^"]*"|\S+/g) ?? [];
    return terms.filter(t => t !== 'AND').every(term => {
      const m = /^([\w."/-]+)\s*(>=|<=|!=|=|:|>|<)\s*("?)(.*?)\3$/.exec(term);
      if (!m) { const needle = term.replace(/^"|"$/g, '').toLowerCase(); return JSON.stringify(entry).toLowerCase().includes(needle); }
      const [, path, op, , raw] = m;
      const value = path === 'severity' ? entry.severity : path.split('.').map(p => p.replace(/^"|"$/g, '')).reduce((v, k) => v?.[k], entry);
      if (path === 'severity') {
        const order = ['DEFAULT', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'];
        const a = order.indexOf(String(value)), b = order.indexOf(raw.toUpperCase());
        return { '>=': a >= b, '<=': a <= b, '=': a === b, '!=': a !== b, '>': a > b, '<': a < b, ':': a === b }[op];
      }
      if (value === undefined) return op === '!=';
      if (op === ':') return String(typeof value === 'object' ? JSON.stringify(value) : value).toLowerCase().includes(raw.toLowerCase());
      if (op === '=') return String(value) === raw;
      if (op === '!=') return String(value) !== raw;
      return { '>=': String(value) >= raw, '<=': String(value) <= raw, '>': String(value) > raw, '<': String(value) < raw }[op];
    });
  });
}
