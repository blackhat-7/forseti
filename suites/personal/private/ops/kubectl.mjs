/**
 * `kubectl` over an in-memory set of GKE clusters.
 *
 * Usage from a scenario:
 *   ctx.state.kube = kubeState({ current, contexts: { [name]: { cluster, project, namespace?, nodes: [...names], namespaces: {
 *     [ns]: { deployments: [deployment({...})], hpas: [hpa({...})], configmaps: [configmap({...})], services: [service({...})] } } } } }, ctx.t)
 *   programs: { kubectl: makeKubectl(ctx, hooks) }
 *   tick:     kubeTick(ctx, hooks)             // every virtual step: rollouts, pod readiness, HPAs
 *   reading:  podsOf(ctx, context, ns, name)   // pods with their captured env, revision, phase, ready
 *
 * hooks (all optional):
 *   cpu(context, ns, deployment) -> percent of request, averaged over running pods (drives HPAs and `top`)
 *   logs(context, ns, pod, { container, previous, since, tail }) -> string[]   (newest last)
 *   readyDelay(context, ns, deployment) -> seconds from pod creation to Ready (default 20)
 *
 * The estate is plain data, so a scenario can `structuredClone` it and run the clock forward to see
 * where things settle. Every mutation records `ctx.event('kube', { verb, context, namespace, object, name, ... })`,
 * `object` being 'deployment', 'pod', 'hpa' or 'configmap'. HPA decisions record 'kube.autoscale'.
 * Pods capture their environment when they are created: a ConfigMap edit only reaches pods created
 * after it, exactly as `envFrom` behaves.
 */
import { UsageError, lines } from './shell.mjs';
import { age, seeded, suffix, table } from './world.mjs';

const CLIENT = 'v1.30.5';
const SERVER = 'v1.30.4-gke.1348000';
const ALIASES = {
  po: 'pods', pod: 'pods', pods: 'pods',
  deploy: 'deployments', deployment: 'deployments', deployments: 'deployments', 'deployment.apps': 'deployments', 'deployments.apps': 'deployments',
  rs: 'replicasets', replicaset: 'replicasets', replicasets: 'replicasets', 'replicaset.apps': 'replicasets',
  hpa: 'hpas', horizontalpodautoscaler: 'hpas', horizontalpodautoscalers: 'hpas', 'horizontalpodautoscaler.autoscaling': 'hpas',
  svc: 'services', service: 'services', services: 'services',
  cm: 'configmaps', configmap: 'configmaps', configmaps: 'configmaps',
  ev: 'events', event: 'events', events: 'events',
  no: 'nodes', node: 'nodes', nodes: 'nodes',
  ns: 'namespaces', namespace: 'namespaces', namespaces: 'namespaces',
  secret: 'secrets', secrets: 'secrets', sts: 'statefulsets', statefulset: 'statefulsets', statefulsets: 'statefulsets',
  ing: 'ingresses', ingress: 'ingresses', ingresses: 'ingresses', job: 'jobs', jobs: 'jobs', cronjob: 'cronjobs', cronjobs: 'cronjobs', cj: 'cronjobs',
  pdb: 'pdbs', poddisruptionbudget: 'pdbs', poddisruptionbudgets: 'pdbs', ds: 'daemonsets', daemonset: 'daemonsets', daemonsets: 'daemonsets',
  all: 'all',
};
const EMPTY_KINDS = new Set(['secrets', 'statefulsets', 'ingresses', 'jobs', 'cronjobs', 'pdbs', 'daemonsets']);
const QUALIFIED = { pods: 'pod', deployments: 'deployment.apps', replicasets: 'replicaset.apps', hpas: 'horizontalpodautoscaler.autoscaling', services: 'service', configmaps: 'configmap', nodes: 'node', namespaces: 'namespace', events: 'event' };
const SINGULAR = { pods: 'pods', deployments: 'deployments.apps', replicasets: 'replicasets.apps', hpas: 'horizontalpodautoscalers.autoscaling', services: 'services', configmaps: 'configmaps', nodes: 'nodes', namespaces: 'namespaces', events: 'events' };

// ---------- state constructors ----------

/** A container spec. `env` is an ordered list of [name, value]. */
export function container({ name, image, env = [], envFrom = [], port = 8080, cpu = '500m', memory = '512Mi', args }) {
  return { name, image, env: env.map(([n, v]) => ({ name: n, value: String(v) })), envFrom: envFrom.map(c => ({ configMapRef: { name: c } })), port, resources: { requests: { cpu, memory }, limits: { memory } }, ...(args ? { args } : {}) };
}
/**
 * A Deployment with its revision history. `history` is oldest first: [{ containers, cause, t }].
 * The last entry is the live template. `created` and history `t` are virtual seconds (negative = before the session).
 */
export function deployment({ name, replicas, history, created = -86400 * 200, labels, surge = 0.25, readyDelay }) {
  const revisions = history.map((h, k) => ({ n: h.n ?? k + 1, containers: h.containers, cause: h.cause ?? null, t: h.t, restartedAt: h.restartedAt ?? null }));
  for (const r of revisions) r.hash = templateHash(name, r);
  return { name, labels: labels ?? { app: name }, replicas, created, surge, readyDelay, revisions, current: revisions.at(-1).n, paused: false, pods: [], generation: revisions.length + 3, deleted: false };
}
export function hpa({ name, target, min, max, cpu = 60, created = -86400 * 200, upPods = 4, upPeriod = 60 }) {
  return { name, target, min, max, cpu, created, upPods, upPeriod, lastScale: -3600, lowSince: null, current: null };
}
export function configmap({ name, data, created = -86400 * 120 }) { return { name, data: { ...data }, created, history: [{ t: created, data: { ...data } }] }; }
export function service({ name, type = 'ClusterIP', clusterIP, ports = ['80/TCP'], externalIP = '<none>', created = -86400 * 200, selector }) { return { name, type, clusterIP, ports, externalIP, created, selector: selector ?? { app: name } }; }

/** Builds the pods every deployment starts the session with: all on the live revision, Ready. */
export function kubeState(kube, t0 = 0) {
  for (const c of Object.values(kube.contexts)) {
    c.events ??= [];
    for (const [nsName, ns] of Object.entries(c.namespaces)) {
      ns.created ??= -86400 * 300;
      ns.deployments ??= []; ns.hpas ??= []; ns.configmaps ??= []; ns.services ??= []; ns.events ??= [];
      for (const d of ns.deployments) {
        const rev = d.revisions.find(r => r.n === d.current);
        const born = d.bornAt ?? Math.max(rev.t + 30, d.created);
        d.pods = [];
        for (let k = 0; k < d.replicas; k++) d.pods.push(newPod(c, nsName, d, rev, born + k * 7, t0, true));
      }
      for (const h of ns.hpas) h.current = ns.deployments.find(d => d.name === h.target)?.replicas ?? 0;
    }
  }
  return kube;
}
function templateHash(name, rev) {
  const rand = seeded(hashString(`${name}|${JSON.stringify(rev.containers)}|${rev.restartedAt ?? ''}`));
  return suffix(rand, 10);
}
export function hashString(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
function newPod(c, ns, d, rev, born, now, ready) {
  const rand = seeded(hashString(`${c.cluster}|${ns}|${d.name}|${rev.hash}|${born}|${d.pods.length}|${(c.seq = (c.seq ?? 0) + 1)}`));
  const name = `${d.name}-${rev.hash}-${suffix(rand, 5)}`;
  const node = c.nodes[Math.floor(rand() * c.nodes.length)];
  const ip = `10.${c.podRange ?? 48}.${Math.floor(rand() * 250) + 2}.${Math.floor(rand() * 250) + 2}`;
  return { name, hash: rev.hash, rev: rev.n, born, node, ip, phase: ready ? 'Running' : 'Pending', ready: Boolean(ready), readyAt: ready ? born + 15 : null, restarts: 0, lastRestart: null, env: envAt(c, ns, rev, born), image: rev.containers[0].image };
}
/** A container's environment as a pod created at `t` would see it: its own env over the ConfigMaps it imports. */
function envAt(c, ns, rev, t) {
  const env = {};
  const main = rev.containers[0];
  for (const from of main.envFrom ?? []) {
    const cm = c.namespaces[ns]?.configmaps.find(m => m.name === from.configMapRef.name);
    if (!cm) continue;
    const version = [...cm.history].reverse().find(h => h.t <= t) ?? cm.history[0];
    Object.assign(env, version.data);
  }
  for (const e of main.env ?? []) env[e.name] = e.value;
  return env;
}

// ---------- reading ----------

export function podsOf(ctx, context, ns, name) {
  const d = ctx.state.kube.contexts[context]?.namespaces[ns]?.deployments.find(x => x.name === name && !x.deleted);
  return d ? d.pods : [];
}
export function deploymentOf(ctx, context, ns, name) {
  return ctx.state.kube.contexts[context]?.namespaces[ns]?.deployments.find(x => x.name === name && !x.deleted) ?? null;
}

// ---------- time ----------

/** One virtual step for every cluster: pods become Ready, rollouts advance, HPAs act. */
export function kubeTick(ctx, hooks = {}) {
  for (const [cname, c] of Object.entries(ctx.state.kube.contexts)) {
    for (const [nsName, ns] of Object.entries(c.namespaces)) {
      if (ctx.t % 60 === 0) for (const h of ns.hpas) scaleByHpa(ctx, cname, c, nsName, ns, h, hooks);
      for (const d of ns.deployments) if (!d.deleted) reconcile(ctx, cname, c, nsName, ns, d, hooks);
    }
  }
}
function reconcile(ctx, cname, c, nsName, ns, d, hooks) {
  const t = ctx.t;
  const delay = hooks.readyDelay?.(cname, nsName, d.name) ?? d.readyDelay ?? 20;
  d.pods = d.pods.filter(p => !(p.terminating && p.terminating <= t));
  for (const p of d.pods) if (p.phase === 'Pending' && p.born + delay <= t) { p.phase = 'Running'; p.ready = true; p.readyAt = t; }
  const rev = d.revisions.find(r => r.n === d.current);
  const live = d.pods.filter(p => !p.terminating);
  const fresh = live.filter(p => p.hash === rev.hash), stale = live.filter(p => p.hash !== rev.hash);
  const R = d.replicas;
  if (d.paused) {
    while (fresh.length + stale.length < R && stale.length) { const r = d.revisions.find(x => x.hash === stale[0].hash) ?? rev; const p = newPod(c, nsName, d, r, t, t, false); d.pods.push(p); stale.push(p); }
    return;
  }
  const surge = Math.max(1, Math.ceil(R * d.surge));
  // Old pods go only once enough new ones are Ready (maxUnavailable 0).
  let readyFresh = fresh.filter(p => p.ready).length;
  const readyStale = stale.filter(p => p.ready);
  while (stale.length && readyFresh + stale.filter(p => !p.terminating).length > R) {
    const victim = stale.pop();
    victim.terminating = t + 10; victim.ready = false;
    ns.events.push({ t, type: 'Normal', reason: 'Killing', object: `pod/${victim.name}`, message: `Stopping container ${d.name}` });
  }
  void readyStale;
  let total = fresh.length + stale.length;
  let created = 0;
  while (fresh.length < R && total < R + (stale.length ? surge : 0)) {
    const p = newPod(c, nsName, d, rev, t, t, false);
    d.pods.push(p); fresh.push(p); total++; created++;
  }
  if (created) ns.events.push({ t, type: 'Normal', reason: 'ScalingReplicaSet', object: `deployment/${d.name}`, message: `Scaled up replica set ${d.name}-${rev.hash} to ${fresh.length}` });
  // Scale down: newest first.
  const excess = fresh.length + stale.length - R;
  if (excess > 0 && !stale.length) {
    const sorted = [...fresh].sort((a, b) => b.born - a.born).slice(0, excess);
    for (const p of sorted) { p.terminating = t + 10; p.ready = false; }
    ns.events.push({ t, type: 'Normal', reason: 'ScalingReplicaSet', object: `deployment/${d.name}`, message: `Scaled down replica set ${d.name}-${rev.hash} to ${R}` });
  }
  void readyFresh;
}
function scaleByHpa(ctx, cname, c, nsName, ns, h, hooks) {
  const d = ns.deployments.find(x => x.name === h.target && !x.deleted);
  if (!d) return;
  const cpu = hooks.cpu?.(cname, nsName, d.name) ?? h.cpu * 0.8;
  h.lastCpu = Math.round(cpu);
  const current = d.replicas;
  let desired = Math.ceil(current * cpu / h.cpu - 1e-9);
  desired = Math.min(h.max, Math.max(h.min, desired));
  const t = ctx.t;
  let next = current;
  if (current < h.min) next = h.min;
  else if (current > h.max) next = h.max;
  else if (desired > current) { if (t - h.lastScale >= h.upPeriod) next = Math.min(desired, current + h.upPods); h.lowSince = null; }
  else if (desired < current) { h.lowSince ??= t; if (t - h.lowSince >= 300) { next = desired; h.lowSince = null; } }
  else h.lowSince = null;
  if (next !== current) {
    d.replicas = next; h.lastScale = t;
    const reason = next > current ? 'cpu resource utilization (percentage of request) above target' : 'All metrics below target';
    ns.events.push({ t, type: 'Normal', reason: 'SuccessfulRescale', object: `horizontalpodautoscaler/${h.name}`, message: `New size: ${next}; reason: ${reason}` });
    ctx.event('kube.autoscale', { context: cname, namespace: nsName, object: 'deployment', name: d.name, from: current, to: next });
  }
  h.current = d.replicas;
}

// ---------- the command ----------

const VALUE_FLAGS = new Set(['context', 'namespace', 'n', 'output', 'o', 'selector', 'l', 'tail', 'since', 'since-time', 'container', 'c', 'to-revision', 'revision', 'replicas', 'timeout', 'type', 'sort-by', 'field-selector', 'grace-period', 'containers', 'cluster', 'user', 'kubeconfig', 'limit-bytes', 'current-replicas', 'min', 'max', 'cpu-percent', 'from-literal', 'from-file', 'from-env-file', 'filename', 'image', 'request-timeout', 'max-log-requests', 'address', 'as', 'env', 'e', 'resource-version', 'field-manager', 'template', 'label-columns', 'L', 'chunk-size']);

function parseArgs(argv) {
  const f = { multi: {} }, pos = [];
  // The verb is the first word that is not a flag or a flag's value: `-n media patch ...` is a patch.
  let verb0;
  for (let k = 0; k < argv.length && verb0 === undefined; k++) {
    const a = argv[k];
    if (!a.startsWith('-')) verb0 = a;
    else if (!a.includes('=') && (a.startsWith('--') ? VALUE_FLAGS.has(a.slice(2)) : a.length === 2 && VALUE_FLAGS.has(a[1]))) k++;
  }
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--') { f.command = argv.slice(k + 1); break; }
    let name, value;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) value = a.slice(eq + 1);
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      name = a[1];
      if (a.length > 2) {
        if (a[2] === '=') value = a.slice(3);
        else if (VALUE_FLAGS.has(name) || (name === 'f' && verb0 !== 'logs') || (name === 'p' && verb0 === 'patch')) value = a.slice(2);
        else { for (const ch of a.slice(1)) f[ch] = true; continue; }
      }
    } else { pos.push(a); continue; }
    const takesValue = VALUE_FLAGS.has(name) || (name === 'f' && verb0 !== 'logs') || (name === 'p' && verb0 === 'patch') || (name === 'patch');
    if (takesValue && value === undefined) value = argv[++k];
    if (value === undefined) value = true;
    if (name === 'from-literal' || name === 'env' || name === 'e') (f.multi[name] ??= []).push(value);
    f[name] = value;
  }
  return { f, pos };
}

export function makeKubectl(ctx, hooks = {}) {
  return function kubectl(argv, io) {
    const { f, pos } = parseArgs(argv);
    const kube = ctx.state.kube;
    const [verb, ...rest] = pos;
    if (!verb) return { out: ['kubectl controls the Kubernetes cluster manager.', '', ' Find more information at: https://kubernetes.io/docs/reference/kubectl/', '', 'Basic Commands (Beginner):', '  create          Create a resource from a file or from stdin', '  expose          Take a replication controller, service, deployment or pod and expose it as a new Kubernetes service', '  run             Run a particular image on the cluster', '  set             Set specific features on objects', '', 'Usage:', '  kubectl [flags] [options]'] };
    if (f.help || f.h) return { out: [`Usage:`, `  kubectl ${verb} [flags] [options]`] };
    const cname = typeof f.context === 'string' ? f.context : kube.current;
    if (verb === 'config') return config(ctx, rest, f);
    if (verb === 'version') {
      ctx.wait(1);
      return { out: [`Client Version: ${CLIENT}`, 'Kustomize Version: v5.0.4-0.20230601165947-6ce0bf390ce3', ...(kube.contexts[cname] ? [`Server Version: ${SERVER}`] : [])] };
    }
    const c = kube.contexts[cname];
    if (!c) return { err: [`error: context "${cname}" does not exist`], code: 1 };
    const ns = typeof (f.namespace ?? f.n) === 'string' ? (f.namespace ?? f.n) : c.namespace ?? 'default';
    const env = { ctx, hooks, c, cname, ns, f, io };
    ctx.wait(1);
    switch (verb) {
      case 'get': return get(env, rest);
      case 'describe': return describe(env, rest);
      case 'logs': case 'log': return logs(env, rest);
      case 'rollout': return rollout(env, rest);
      case 'set': return setCmd(env, rest);
      case 'scale': return scale(env, rest);
      case 'autoscale': return { err: [`Error from server (AlreadyExists): horizontalpodautoscalers.autoscaling "${ref(rest[0]).name}" already exists`], code: 1 };
      case 'patch': return patch(env, rest);
      case 'delete': return del(env, rest);
      case 'top': return top(env, rest);
      case 'apply': return apply(env, rest, false);
      case 'diff': return apply(env, rest, true);
      case 'create': return create(env, rest);
      case 'edit': return { err: ['Vim: Warning: Output is not to a terminal', 'Vim: Warning: Input is not from a terminal', '', 'Vim: Error reading input, exiting...', 'Edit cancelled, no changes made.'], code: 0 };
      case 'exec': return exec(env, rest);
      case 'auth': return rest[0] === 'can-i' ? { out: ['yes'] } : { err: [`error: unknown command "${rest[0] ?? ''}" for "kubectl auth"`], code: 1 };
      case 'port-forward': case 'attach': case 'proxy': case 'debug': case 'run':
        if (verb === 'run' || verb === 'debug') return { err: ['Error from server (Forbidden): pods is forbidden: User "' + ctx.state.gcloud.account + '" cannot create resource "pods" in API group "" in the namespace "' + ns + '": requires one of ["container.pods.create"] permission(s).'], code: 1 };
        ctx.wait(120);
        return { out: verb === 'port-forward' ? [`Forwarding from 127.0.0.1:${(rest[1] ?? '8080').split(':')[0]} -> ${(rest[1] ?? '8080').split(':').pop()}`, `Forwarding from [::1]:${(rest[1] ?? '8080').split(':')[0]} -> ${(rest[1] ?? '8080').split(':').pop()}`] : [], err: ['Command timed out after 120 seconds'], code: 124 };
      case 'cluster-info': return { out: [`Kubernetes control plane is running at https://${c.endpoint ?? '34.118.0.10'}`, `GLBCDefaultBackend is running at https://${c.endpoint ?? '34.118.0.10'}/api/v1/namespaces/kube-system/services/default-http-backend:http/proxy`, `KubeDNS is running at https://${c.endpoint ?? '34.118.0.10'}/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy`, '', "To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'."] };
      case 'api-resources': return { out: ['NAME                  SHORTNAMES   APIVERSION        NAMESPACED   KIND', 'configmaps            cm           v1                true         ConfigMap', 'events                ev           v1                true         Event', 'namespaces            ns           v1                false        Namespace', 'nodes                 no           v1                false        Node', 'pods                  po           v1                true         Pod', 'services              svc          v1                true         Service', 'deployments           deploy       apps/v1           true         Deployment', 'replicasets           rs           apps/v1           true         ReplicaSet', 'horizontalpodautoscalers hpa      autoscaling/v2    true         HorizontalPodAutoscaler'] };
      case 'label': case 'annotate': case 'cordon': case 'uncordon': case 'drain': case 'taint': case 'replace': case 'expose': case 'wait': case 'cp':
        if (verb === 'wait') return waitCmd(env, rest);
        ctx.event('kube', { verb, context: cname, namespace: ns, object: rest[0] ?? '', name: rest[1] ?? '' });
        return { out: [`${rest[0] ?? 'resource'} ${verb === 'cordon' ? 'cordoned' : verb === 'uncordon' ? 'uncordoned' : verb + 'ed'}`] };
      default: return { err: [`error: unknown command "${verb}" for "kubectl"`, '', `Did you mean this?`, `\tget`, `Run 'kubectl --help' for usage.`], code: 1 };
    }
  };
}

function config(ctx, rest, f) {
  const kube = ctx.state.kube;
  const [sub, arg] = rest;
  if (sub === 'current-context') return { out: [kube.current] };
  if (sub === 'get-contexts') {
    const names = arg ? [arg] : Object.keys(kube.contexts).sort();
    if (arg && !kube.contexts[arg]) return { err: [`error: context ${arg} not found`], code: 1 };
    if (f.o === 'name' || f.output === 'name') return { out: names };
    return { out: table(['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], names.map(n => [n === kube.current ? '*' : '', n, n, n, kube.contexts[n].namespace ?? ''])) };
  }
  if (sub === 'use-context' || sub === 'use') {
    if (!kube.contexts[arg]) return { err: [`error: no context exists with the name: "${arg}"`], code: 1 };
    kube.current = arg;
    ctx.event('kube.context', { context: arg });
    return { out: [`Switched to context "${arg}".`] };
  }
  if (sub === 'set-context') {
    const name = f.current ? kube.current : arg;
    const c = kube.contexts[name];
    if (!c) return { err: [`error: context "${name}" does not exist`], code: 1 };
    if (typeof f.namespace === 'string') c.namespace = f.namespace;
    return { out: [`Context "${name}" modified.`] };
  }
  if (sub === 'get-clusters') return { out: ['NAME', ...Object.keys(kube.contexts).sort()] };
  if (sub === 'view') {
    const names = f.minify ? [kube.current] : Object.keys(kube.contexts).sort();
    const doc = {
      apiVersion: 'v1',
      clusters: names.map(n => ({ cluster: { 'certificate-authority-data': 'DATA+OMITTED', server: `https://${kube.contexts[n].endpoint ?? '34.118.0.10'}` }, name: n })),
      contexts: names.map(n => ({ context: { cluster: n, user: n, ...(kube.contexts[n].namespace ? { namespace: kube.contexts[n].namespace } : {}) }, name: n })),
      'current-context': kube.current, kind: 'Config', preferences: {},
      users: names.map(n => ({ name: n, user: { exec: { apiVersion: 'client.authentication.k8s.io/v1beta1', command: 'gke-gcloud-auth-plugin', installHint: 'Install gke-gcloud-auth-plugin for use with kubectl by following\n        https://cloud.google.com/kubernetes-engine/docs/how-to/cluster-access-for-kubectl#install_plugin', interactiveMode: 'IfAvailable', provideClusterInfo: true } } })),
    };
    const o = f.o ?? f.output;
    if (o === 'json') return { out: lines(JSON.stringify(doc, null, 4)) };
    if (typeof o === 'string' && o.startsWith('jsonpath')) return { out: [jsonpath(o.replace(/^jsonpath=/, ''), doc)] };
    return { out: yaml(doc) };
  }
  return { err: [`error: unknown command "${sub ?? ''}" for "kubectl config"`], code: 1 };
}

/** `TYPE NAME`, `TYPE/NAME`, `TYPE1,TYPE2`. */
function targets(rest) {
  if (!rest.length) return [];
  if (rest[0].includes('/')) return rest.map(r => { const [type, name] = r.split('/'); return { type: ALIASES[type.toLowerCase()] ?? `?${type}`, name }; });
  const types = rest[0].split(',').map(t => ALIASES[t.toLowerCase()] ?? `?${t}`);
  const names = rest.slice(1);
  return names.length ? types.flatMap(type => names.map(name => ({ type, name }))) : types.map(type => ({ type, name: null }));
}
function ref(text = '') { const [type, name] = text.includes('/') ? text.split('/') : ['deployment', text]; return { type: ALIASES[type.toLowerCase()] ?? `?${type}`, name }; }
function selectorMatch(sel, labels) {
  if (!sel) return true;
  return String(sel).split(',').every(term => {
    const neq = /^([\w./-]+)!=([\w.-]*)$/.exec(term), eq = /^([\w./-]+)==?([\w.-]*)$/.exec(term), inSet = /^([\w./-]+)\s+in\s+\(([^)]*)\)$/.exec(term);
    if (neq) return labels[neq[1]] !== neq[2];
    if (eq) return labels[eq[1]] === eq[2];
    if (inSet) return inSet[2].split(',').map(s => s.trim()).includes(labels[inSet[1]]);
    return term.startsWith('!') ? !(term.slice(1) in labels) : term in labels;
  });
}
const notFound = (type, name) => ({ err: [`Error from server (NotFound): ${SINGULAR[type] ?? type} "${name}" not found`], code: 1 });

function namespacesOf(env) { return env.f.A || env.f['all-namespaces'] ? Object.keys(env.c.namespaces).sort() : [env.ns]; }
/** Everything of one type, as [namespace, object] pairs. */
function list(env, type) {
  const { c } = env;
  if (type === 'nodes') return c.nodes.map(n => [null, n]);
  if (type === 'namespaces') return Object.keys(c.namespaces).sort().map(n => [null, n]);
  const out = [];
  for (const nsName of namespacesOf(env)) {
    const ns = c.namespaces[nsName];
    if (!ns) continue;
    const add = (items) => { for (const x of items) out.push([nsName, x]); };
    if (type === 'pods') add(ns.deployments.filter(d => !d.deleted).flatMap(d => d.pods.map(p => ({ ...p, deployment: d }))).sort((a, b) => a.name.localeCompare(b.name)));
    if (type === 'deployments') add(ns.deployments.filter(d => !d.deleted).sort((a, b) => a.name.localeCompare(b.name)));
    if (type === 'replicasets') add(ns.deployments.filter(d => !d.deleted).flatMap(d => d.revisions.map(r => ({ ...r, deployment: d, name: `${d.name}-${r.hash}` }))).sort((a, b) => a.name.localeCompare(b.name)));
    if (type === 'hpas') add(ns.hpas.filter(h => !h.deleted));
    if (type === 'services') add(ns.services);
    if (type === 'configmaps') add([{ name: 'kube-root-ca.crt', data: { 'ca.crt': '-----BEGIN CERTIFICATE-----' }, created: ns.created }, ...ns.configmaps].sort((a, b) => a.name.localeCompare(b.name)));
    if (type === 'events') add(ns.events.filter(e => env.ctx.t - e.t < 3600));
  }
  return out;
}
function labelsOf(type, obj) {
  if (type === 'pods') return { ...obj.deployment.labels, 'pod-template-hash': obj.hash };
  if (type === 'deployments') return obj.labels;
  if (type === 'replicasets') return { ...obj.deployment.labels, 'pod-template-hash': obj.hash };
  if (type === 'services') return { app: obj.name };
  if (type === 'nodes') return { 'cloud.google.com/gke-nodepool': 'default-pool', 'kubernetes.io/hostname': obj };
  if (type === 'namespaces') return { 'kubernetes.io/metadata.name': obj };
  return {};
}
function nameOf(type, obj) { return type === 'nodes' || type === 'namespaces' ? obj : obj.name; }

function get(env, rest) {
  const { f, ctx } = env;
  const o = f.o ?? f.output;
  if (f.w || f.watch) { ctx.wait(120); }
  const wanted = targets(rest);
  if (!wanted.length) return { err: ['You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.', '', "error: Required resource not specified.", "Use \"kubectl explain <resource>\" for a detailed description of that resource (e.g. kubectl explain pods).", "See 'kubectl get -h' for help and examples"], code: 1 };
  const bad = wanted.find(w => w.type.startsWith('?'));
  if (bad) return { err: [`error: the server doesn't have a resource type "${bad.type.slice(1)}"`], code: 1 };
  if (wanted.length === 1 && wanted[0].type === 'all') return getAll(env);
  const items = [], errs = [];
  for (const w of wanted) {
    if (w.type === 'secrets') return { err: [`Error from server (Forbidden): secrets${w.name ? ` "${w.name}"` : ''} is forbidden: User "${ctx.state.gcloud.account}" cannot ${w.name ? 'get' : 'list'} resource "secrets" in API group "" in the namespace "${env.ns}": requires one of ["container.secrets.${w.name ? 'get' : 'list'}"] permission(s).`], code: 1 };
    if (EMPTY_KINDS.has(w.type)) { if (w.name) errs.push(...notFound(w.type, w.name).err); continue; }
    let found = list(env, w.type).map(([ns, x]) => ({ type: w.type, ns, x }));
    if (w.name) { found = found.filter(i => nameOf(i.type, i.x) === w.name); if (!found.length) { errs.push(...notFound(w.type, w.name).err); continue; } }
    const sel = f.l ?? f.selector;
    if (sel) found = found.filter(i => selectorMatch(sel, labelsOf(i.type, i.x)));
    items.push(...found);
  }
  if (typeof f['sort-by'] === 'string') items.sort((a, b) => String(jsonpath(`{${f['sort-by']}}`, toObject(env, a))).localeCompare(String(jsonpath(`{${f['sort-by']}}`, toObject(env, b))), undefined, { numeric: true }));
  if (!items.length && !errs.length) {
    if (o === 'json' || o === 'yaml') return render(env, [], o, wanted);
    return { err: [env.f.A || env.f['all-namespaces'] ? 'No resources found' : ['nodes', 'namespaces'].includes(wanted[0].type) ? 'No resources found' : `No resources found in ${env.ns} namespace.`] };
  }
  const single = wanted.length === 1 && wanted[0].name && items.length === 1;
  const out = render(env, items, o, wanted, single);
  return { out: out.out, err: [...errs, ...(out.err ?? [])], code: errs.length ? 1 : out.code ?? 0 };
}
function getAll(env) {
  const out = [];
  for (const type of ['pods', 'services', 'deployments', 'replicasets', 'hpas']) {
    const items = list(env, type).map(([ns, x]) => ({ type, ns, x }));
    if (!items.length) continue;
    const t = tableFor(env, items, false, true);
    if (out.length) out.push('');
    out.push(...t);
  }
  if (!out.length) return { err: [`No resources found in ${env.ns} namespace.`] };
  return { out };
}
function render(env, items, o, wanted, single = false) {
  const many = !single || items.length !== 1;
  if (o === 'json' || o === 'yaml') {
    const objs = items.map(i => toObject(env, i));
    const doc = many ? { apiVersion: 'v1', items: objs, kind: 'List', metadata: { resourceVersion: '' } } : objs[0];
    return { out: o === 'json' ? lines(JSON.stringify(doc, null, 4)) : yaml(doc) };
  }
  if (o === 'name') return { out: items.map(i => `${QUALIFIED[i.type]}/${nameOf(i.type, i.x)}`) };
  if (typeof o === 'string' && (o.startsWith('jsonpath') || o.startsWith('go-template'))) {
    if (o.startsWith('go-template')) return { err: ['error: template: output:1: function "index" not defined'], code: 1 };
    const expr = o.replace(/^jsonpath(-as-json)?=/, '');
    const objs = items.map(i => toObject(env, i));
    const doc = many ? { apiVersion: 'v1', items: objs, kind: 'List', metadata: { resourceVersion: '' } } : objs[0];
    try { const text = jsonpath(expr, doc); return { out: text === '' ? [] : lines(text).length ? [text.replace(/\n$/, '')].flatMap(t => t.split('\n')) : [] }; }
    catch (e) { return { err: [`error: error parsing jsonpath ${expr}, ${e.message}`], code: 1 }; }
  }
  if (typeof o === 'string' && o.startsWith('custom-columns')) {
    const spec = o.replace(/^custom-columns=/, '').split(',').map(s => { const [h, p] = s.split(':'); return { h, p }; });
    const rows = items.map(i => { const obj = toObject(env, i); return spec.map(s => { const v = jsonpath(`{${s.p}}`, obj); return v === '' ? '<none>' : v; }); });
    return { out: f_noHeaders(env) ? table(spec.map(s => s.h), rows).slice(1) : table(spec.map(s => s.h), rows) };
  }
  if (o && o !== 'wide') return { err: [`error: unable to match a printer suitable for the output format "${o}", allowed formats are: custom-columns,custom-columns-file,go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,name,template,templatefile,wide,yaml`], code: 1 };
  // Mixed types print one table per type, like kubectl.
  const byType = [];
  for (const i of items) { const g = byType.find(b => b.type === i.type); if (g) g.items.push(i); else byType.push({ type: i.type, items: [i] }); }
  const out = [];
  for (const g of byType) { if (out.length) out.push(''); out.push(...tableFor(env, g.items, o === 'wide', byType.length > 1)); }
  return { out: f_noHeaders(env) ? out.slice(1) : out };
}
const f_noHeaders = (env) => Boolean(env.f['no-headers']);

function restartsText(p, t) { return p.restarts ? `${p.restarts} (${age(t - p.lastRestart)} ago)` : '0'; }
function podStatus(p) { if (p.terminating) return 'Terminating'; if (p.phase === 'Pending') return 'ContainerCreating'; if (p.crash) return p.crash; return 'Running'; }
function containersOf(p) { const rev = p.deployment.revisions.find(r => r.hash === p.hash); return rev?.containers ?? []; }
function tableFor(env, items, wide, prefixed) {
  const { ctx } = env;
  const t = ctx.t;
  const type = items[0].type;
  const allNs = env.f.A || env.f['all-namespaces'];
  const pre = (i) => (prefixed ? `${QUALIFIED[type]}/` : '') + nameOf(type, i.x);
  const nsCol = allNs && !['nodes', 'namespaces'].includes(type);
  const withNs = (headers, rows) => (nsCol ? [['NAMESPACE', ...headers], rows.map((r, k) => [items[k].ns, ...r])] : [headers, rows]);
  const showLabels = env.f['show-labels'];
  let headers, rows;
  if (type === 'pods') {
    headers = ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'];
    rows = items.map(i => { const p = i.x; const n = containersOf(p).length; return [pre(i), `${p.ready ? n : p.phase === 'Running' && !p.terminating ? n - 1 : 0}/${n}`, podStatus(p), restartsText(p, t), age(t - p.born)]; });
    if (wide) { headers.push('IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'); rows = rows.map((r, k) => [...r, items[k].x.phase === 'Pending' ? '<none>' : items[k].x.ip, items[k].x.node, '<none>', '<none>']); }
  } else if (type === 'deployments') {
    headers = ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'];
    rows = items.map(i => { const d = i.x; const s = depStatus(d); return [pre(i), `${s.ready}/${d.replicas}`, s.updated, s.available, age(t - d.created)]; });
    if (wide) { headers.push('CONTAINERS', 'IMAGES', 'SELECTOR'); rows = rows.map((r, k) => { const rev = cur(items[k].x); return [...r, rev.containers.map(c => c.name).join(','), rev.containers.map(c => c.image).join(','), `app=${items[k].x.labels.app}`]; }); }
  } else if (type === 'replicasets') {
    headers = ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'];
    rows = items.map(i => { const r = i.x; const pods = r.deployment.pods.filter(p => p.hash === r.hash && !p.terminating); const desired = r.n === r.deployment.current ? r.deployment.replicas : pods.length; return [pre(i), desired, pods.length, pods.filter(p => p.ready).length, age(t - r.t)]; });
  } else if (type === 'hpas') {
    headers = ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'];
    rows = items.map(i => { const h = i.x; const cpu = env.hooks.cpu?.(env.cname, i.ns, h.target); return [pre(i), `Deployment/${h.target}`, `cpu: ${cpu === undefined ? '<unknown>' : `${Math.round(cpu)}%`}/${h.cpu}%`, h.min, h.max, depOf(env, i.ns, h.target)?.replicas ?? 0, age(t - h.created)]; });
  } else if (type === 'services') {
    headers = ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'];
    rows = items.map(i => [pre(i), i.x.type, i.x.clusterIP, i.x.externalIP, i.x.ports.join(','), age(t - i.x.created)]);
  } else if (type === 'configmaps') {
    headers = ['NAME', 'DATA', 'AGE'];
    rows = items.map(i => [pre(i), Object.keys(i.x.data).length, age(t - i.x.created)]);
  } else if (type === 'events') {
    headers = ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'];
    const sorted = [...items].sort((a, b) => a.x.t - b.x.t);
    items.splice(0, items.length, ...sorted);
    rows = sorted.map(i => [age(t - i.x.t), i.x.type, i.x.reason, i.x.object, i.x.message]);
  } else if (type === 'nodes') {
    headers = ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'];
    rows = items.map(i => [i.x, 'Ready', '<none>', '41d', SERVER]);
    if (wide) { headers.push('INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME'); rows = rows.map((r, k) => [...r, `10.128.0.${11 + k}`, '<none>', 'Container-Optimized OS from Google', '6.1.100+', 'containerd://1.7.22']); }
  } else if (type === 'namespaces') {
    headers = ['NAME', 'STATUS', 'AGE'];
    rows = items.map(i => [i.x, 'Active', age(t - (env.c.namespaces[i.x].created ?? -86400 * 300))]);
  }
  if (showLabels) { headers.push('LABELS'); rows = rows.map((r, k) => [...r, Object.entries(labelsOf(type, items[k].x)).map(([a, b]) => `${a}=${b}`).join(',') || '<none>']); }
  const [h, r] = withNs(headers, rows);
  return table(h, r);
}
const cur = (d) => d.revisions.find(r => r.n === d.current);
function depOf(env, ns, name) { return env.c.namespaces[ns]?.deployments.find(d => d.name === name && !d.deleted); }
function depStatus(d) {
  const rev = cur(d);
  const live = d.pods.filter(p => !p.terminating);
  const updated = live.filter(p => p.hash === rev.hash).length;
  const ready = live.filter(p => p.ready).length;
  return { updated, ready, available: ready, total: live.length, complete: updated === d.replicas && live.length === d.replicas && ready === d.replicas };
}

function iso(ctx, t) { return ctx.at(t).toISOString().replace(/\.\d+Z$/, 'Z'); }
function containerJson(c) {
  return { ...(c.args ? { args: c.args } : {}), ...(c.env?.length ? { env: c.env } : {}), ...(c.envFrom?.length ? { envFrom: c.envFrom } : {}), image: c.image, imagePullPolicy: 'IfNotPresent', name: c.name, ...(c.port ? { ports: [{ containerPort: c.port, name: 'http', protocol: 'TCP' }] } : {}), resources: c.resources, terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File' };
}
function toObject(env, i) {
  const { ctx } = env;
  const x = i.x;
  const meta = (name, created, extra = {}) => ({ creationTimestamp: iso(ctx, created), name, ...(i.ns ? { namespace: i.ns } : {}), resourceVersion: String(48213000 + (hashString(name) % 90000)), uid: uid(name), ...extra });
  if (i.type === 'deployments') {
    const rev = cur(x);
    const s = depStatus(x);
    return {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: meta(x.name, x.created, { annotations: { 'deployment.kubernetes.io/revision': String(x.current), ...(rev.cause ? { 'kubernetes.io/change-cause': rev.cause } : {}) }, generation: x.generation, labels: x.labels }),
      spec: { progressDeadlineSeconds: 600, replicas: x.replicas, revisionHistoryLimit: 10, selector: { matchLabels: { app: x.labels.app } }, strategy: { rollingUpdate: { maxSurge: `${Math.round(x.surge * 100)}%`, maxUnavailable: 0 }, type: 'RollingUpdate' }, ...(x.paused ? { paused: true } : {}), template: { metadata: { ...(rev.restartedAt ? { annotations: { 'kubectl.kubernetes.io/restartedAt': iso(ctx, rev.restartedAt).replace('Z', '+00:00') } } : {}), labels: { app: x.labels.app } }, spec: { containers: rev.containers.map(containerJson), restartPolicy: 'Always', serviceAccountName: x.labels.app, terminationGracePeriodSeconds: 30 } } },
      status: { availableReplicas: s.available, conditions: [{ lastTransitionTime: iso(ctx, x.created + 60), lastUpdateTime: iso(ctx, x.created + 60), message: s.available >= x.replicas ? 'Deployment has minimum availability.' : 'Deployment does not have minimum availability.', reason: s.available >= x.replicas ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable', status: s.available >= x.replicas ? 'True' : 'False', type: 'Available' }, { lastTransitionTime: iso(ctx, rev.t), lastUpdateTime: iso(ctx, Math.min(ctx.t, rev.t + 90)), message: s.complete ? `ReplicaSet "${x.name}-${rev.hash}" has successfully progressed.` : `ReplicaSet "${x.name}-${rev.hash}" is progressing.`, reason: s.complete ? 'NewReplicaSetAvailable' : 'ReplicaSetUpdated', status: 'True', type: 'Progressing' }], observedGeneration: x.generation, readyReplicas: s.ready, replicas: s.total, updatedReplicas: s.updated },
    };
  }
  if (i.type === 'pods') {
    const containers = containersOf(x);
    return {
      apiVersion: 'v1', kind: 'Pod',
      metadata: meta(x.name, x.born, { generateName: `${x.deployment.name}-${x.hash}-`, labels: { app: x.deployment.labels.app, 'pod-template-hash': x.hash }, ownerReferences: [{ apiVersion: 'apps/v1', blockOwnerDeletion: true, controller: true, kind: 'ReplicaSet', name: `${x.deployment.name}-${x.hash}`, uid: uid(`${x.deployment.name}-${x.hash}`) }] }),
      spec: { containers: containers.map(containerJson), nodeName: x.node, restartPolicy: 'Always', serviceAccountName: x.deployment.labels.app },
      status: {
        conditions: [{ status: 'True', type: 'Initialized' }, { status: x.ready ? 'True' : 'False', type: 'Ready' }, { status: x.ready ? 'True' : 'False', type: 'ContainersReady' }, { status: 'True', type: 'PodScheduled' }],
        containerStatuses: containers.map((c, k) => ({ image: c.image, imageID: `${c.image.split(':')[0]}@sha256:${uid(c.image).replace(/-/g, '')}${uid(c.name).replace(/-/g, '').slice(0, 32)}`, name: c.name, ready: x.ready || (k > 0 && x.phase === 'Running'), restartCount: k === 0 ? x.restarts : 0, ...(k === 0 && x.restarts ? { lastState: { terminated: { containerID: `containerd://${uid(x.name + c.name).replace(/-/g, '')}`, exitCode: x.lastExit ?? 1, finishedAt: iso(env.ctx, x.lastRestart), reason: x.lastReason ?? 'Error', startedAt: iso(env.ctx, x.lastStarted ?? x.lastRestart - 95) } } } : {}), started: x.phase === 'Running', state: x.phase === 'Running' ? { running: { startedAt: iso(env.ctx, x.lastRestart ?? x.born + 5) } } : { waiting: { reason: 'ContainerCreating' } } })),
        hostIP: `10.128.0.${11 + env.c.nodes.indexOf(x.node)}`, phase: x.phase === 'Pending' ? 'Pending' : 'Running', podIP: x.ip, qosClass: 'Burstable', startTime: iso(env.ctx, x.born),
      },
    };
  }
  if (i.type === 'replicasets') {
    const pods = x.deployment.pods.filter(p => p.hash === x.hash && !p.terminating);
    return { apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: meta(x.name, x.t, { annotations: { 'deployment.kubernetes.io/revision': String(x.n), ...(x.cause ? { 'kubernetes.io/change-cause': x.cause } : {}) }, labels: { app: x.deployment.labels.app, 'pod-template-hash': x.hash } }), spec: { replicas: x.n === x.deployment.current ? x.deployment.replicas : pods.length, template: { spec: { containers: x.containers.map(containerJson) } } }, status: { availableReplicas: pods.filter(p => p.ready).length, readyReplicas: pods.filter(p => p.ready).length, replicas: pods.length } };
  }
  if (i.type === 'hpas') {
    const cpu = env.hooks.cpu?.(env.cname, i.ns, x.target);
    const d = depOf(env, i.ns, x.target);
    return { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: meta(x.name, x.created), spec: { maxReplicas: x.max, metrics: [{ resource: { name: 'cpu', target: { averageUtilization: x.cpu, type: 'Utilization' } }, type: 'Resource' }], minReplicas: x.min, scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: x.target } }, status: { currentMetrics: [{ resource: { current: { averageUtilization: Math.round(cpu ?? 0) }, name: 'cpu' }, type: 'Resource' }], currentReplicas: d?.replicas ?? 0, desiredReplicas: d?.replicas ?? 0, lastScaleTime: iso(env.ctx, x.lastScale) } };
  }
  if (i.type === 'configmaps') return { apiVersion: 'v1', data: x.data, kind: 'ConfigMap', metadata: meta(x.name, x.created) };
  if (i.type === 'services') return { apiVersion: 'v1', kind: 'Service', metadata: meta(x.name, x.created, { labels: { app: x.name } }), spec: { clusterIP: x.clusterIP, ports: x.ports.map(p => ({ port: Number(p.split('/')[0].split(':')[0]), protocol: 'TCP', targetPort: 8080 })), selector: x.selector, type: x.type }, status: { loadBalancer: {} } };
  if (i.type === 'events') return { apiVersion: 'v1', kind: 'Event', lastTimestamp: iso(env.ctx, x.t), message: x.message, reason: x.reason, type: x.type, involvedObject: { kind: x.object.split('/')[0], name: x.object.split('/')[1] }, metadata: meta(`${x.object.split('/')[1]}.${uid(x.message).slice(0, 8)}`, x.t) };
  if (i.type === 'nodes') return { apiVersion: 'v1', kind: 'Node', metadata: { labels: labelsOf('nodes', x), name: x }, status: { nodeInfo: { kubeletVersion: SERVER } } };
  if (i.type === 'namespaces') return { apiVersion: 'v1', kind: 'Namespace', metadata: { labels: labelsOf('namespaces', x), name: x }, spec: { finalizers: ['kubernetes'] }, status: { phase: 'Active' } };
  return {};
}
/** YAML as kubectl prints it (go-yaml): sorted keys, lists at their parent's indent, double quotes. */
export function yaml(value, indent = '') {
  if (value === null || value === undefined) return [`${indent}null`];
  if (typeof value !== 'object') return [`${indent}${scalar(value)}`];
  const out = [];
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}[]`];
    for (const item of value) {
      if (item && typeof item === 'object' && Object.keys(item).length) { const [first, ...rest] = yaml(item, `${indent}  `); out.push(`${indent}- ${first.trimStart()}`, ...rest); }
      else out.push(`${indent}- ${item && typeof item === 'object' ? (Array.isArray(item) ? '[]' : '{}') : scalar(item)}`);
    }
    return out;
  }
  for (const [k, v] of Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (v === undefined) continue;
    const key = /^[\w./-]+$/.test(k) ? k : JSON.stringify(k);
    if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) out.push(`${indent}${key}:`, ...yaml(v, Array.isArray(v) ? indent : `${indent}  `));
    else out.push(`${indent}${key}: ${v && typeof v === 'object' ? (Array.isArray(v) ? '[]' : '{}') : scalar(v)}`);
  }
  return out;
}
function scalar(v) {
  if (typeof v !== 'string') return String(v);
  if (v === '' || /^(true|false|null|yes|no|on|off|y|n|~)$/i.test(v) || /^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v) || /^[\s!&*?|>'"%@`#,[\]{}]|^-( |$)|: |\s#|\s$|:$/.test(v) || v.includes('\n')) return JSON.stringify(v);
  return v;
}
function uid(s) { const r = seeded(hashString(s)); const hex = () => Math.floor(r() * 16).toString(16); const part = (n) => Array.from({ length: n }, hex).join(''); return `${part(8)}-${part(4)}-4${part(3)}-a${part(3)}-${part(12)}`; }

/** JSONPath as kubectl reads it: `{.a.b[0]}`, `[*]`, `[?(@.k=="v")]`, `{range ...}{end}`, `{"\n"}`. */
export function jsonpath(template, doc) {
  const t = template.trim().replace(/^'|'$/g, '');
  const parts = [];
  let k = 0;
  while (k < t.length) {
    if (t[k] === '{') { const end = t.indexOf('}', k); if (end < 0) throw new Error('unclosed action'); parts.push({ expr: t.slice(k + 1, end).trim() }); k = end + 1; }
    else { let end = t.indexOf('{', k); if (end < 0) end = t.length; parts.push({ text: t.slice(k, end) }); k = end; }
  }
  if (!parts.some(p => p.expr !== undefined)) parts.splice(0, parts.length, { expr: t });
  let out = '';
  const run = (items, scope) => {
    for (let n = 0; n < items.length; n++) {
      const p = items[n];
      if (p.text !== undefined) { out += p.text; continue; }
      if (p.expr.startsWith('range ')) {
        let depth = 1, j = n + 1;
        for (; j < items.length; j++) { if (items[j].expr?.startsWith('range ')) depth++; if (items[j].expr === 'end' && --depth === 0) break; }
        for (const v of evalPath(p.expr.slice(6).trim(), scope)) run(items.slice(n + 1, j), v);
        n = j;
        continue;
      }
      if (p.expr === 'end') continue;
      if (/^".*"$/.test(p.expr)) { out += JSON.parse(p.expr); continue; }
      const values = evalPath(p.expr, scope);
      out += values.map(v => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))).join(' ');
    }
  };
  run(parts, doc);
  return out;
}
function evalPath(expr, root) {
  let e = expr.trim();
  if (e.startsWith('$')) e = e.slice(1);
  if (e === '' || e === '.' || e === '@') return [root];
  const tokens = e.match(/\.\.|\.[\w-]+|\[\?\(.*?\)\]|\['[^']*'\]|\["[^"]*"\]|\[[^\]]*\]|\.\*/g) ?? [];
  let values = [root];
  for (const tok of tokens) {
    const next = [];
    for (const v of values) {
      if (v === undefined || v === null) continue;
      if (tok === '..') { next.push(...deep(v)); continue; }
      if (tok === '.*' || tok === '[*]') { if (Array.isArray(v)) next.push(...v); else if (typeof v === 'object') next.push(...Object.values(v)); continue; }
      if (tok.startsWith('[?(')) {
        const m = /^\[\?\(@\.([\w.-]+)\s*(==|!=)\s*["']?([^"')]*)["']?\)\]$/.exec(tok);
        if (!m) throw new Error(`unrecognized filter ${tok}`);
        for (const item of Array.isArray(v) ? v : [v]) { const got = String(m[1].split('.').reduce((a, b) => a?.[b], item)); if ((got === m[3]) === (m[2] === '==')) next.push(item); }
        continue;
      }
      if (tok.startsWith('[')) {
        const inner = tok.slice(1, -1).replace(/^['"]|['"]$/g, '');
        if (/^-?\d+$/.test(inner) && Array.isArray(v)) { const x = v.at(Number(inner)); if (x !== undefined) next.push(x); }
        else if (/^\d*:\d*$/.test(inner) && Array.isArray(v)) { const [a, b] = inner.split(':'); next.push(...v.slice(a ? Number(a) : 0, b ? Number(b) : undefined)); }
        else if (v[inner] !== undefined) next.push(v[inner]);
        continue;
      }
      const key = tok.slice(1);
      if (v[key] !== undefined) next.push(v[key]);
    }
    values = next;
  }
  return values;
}
function deep(v) { const out = [v]; if (v && typeof v === 'object') for (const x of Object.values(v)) out.push(...deep(x)); return out; }

// ---------- describe ----------

function describe(env, rest) {
  const wanted = targets(rest);
  if (!wanted.length) return { err: ['error: You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.'], code: 1 };
  const out = [], errs = [];
  for (const w of wanted) {
    if (w.type.startsWith('?')) return { err: [`error: the server doesn't have a resource type "${w.type.slice(1)}"`], code: 1 };
    let found = list(env, w.type).map(([ns, x]) => ({ type: w.type, ns, x }));
    if (w.name) found = found.filter(i => nameOf(i.type, i.x) === w.name || (i.type === 'pods' && i.x.name.startsWith(w.name)));
    const sel = env.f.l ?? env.f.selector;
    if (sel) found = found.filter(i => selectorMatch(sel, labelsOf(i.type, i.x)));
    if (!found.length) { if (w.name) errs.push(...notFound(w.type, w.name).err); else errs.push(`No resources found in ${env.ns} namespace.`); continue; }
    for (const i of found) { if (out.length) out.push('', ''); out.push(...describeOne(env, i)); }
  }
  return { out, err: errs, code: errs.length && !out.length ? 1 : 0 };
}
function envLines(c, pad) {
  const out = [];
  if (c.envFrom?.length) { out.push(`${pad}Environment Variables from:`); for (const e of c.envFrom) out.push(`${pad}  ${e.configMapRef.name}  ConfigMap  Optional: false`); }
  if (c.env?.length) { out.push(`${pad}Environment:`); for (const e of c.env) out.push(`${pad}  ${e.name}:${' '.repeat(Math.max(1, 20 - e.name.length))}${e.value}`); }
  else out.push(`${pad}Environment:   <none>`);
  return out;
}
function describeOne(env, i) {
  const { ctx } = env;
  const t = ctx.t;
  const x = i.x;
  const stamp = (s) => ctx.at(s).toUTCString().replace('GMT', '+0000');
  const events = (object) => {
    const evs = (env.c.namespaces[i.ns]?.events ?? []).filter(e => e.object === object && t - e.t < 3600).slice(-12);
    if (!evs.length) return ['Events:          <none>'];
    return ['Events:', ...table(['  Type', 'Reason', 'Age', 'From', 'Message'], [['  ----', '------', '----', '----', '-------'], ...evs.map(e => [`  ${e.type}`, e.reason, age(t - e.t), object.startsWith('pod') ? 'kubelet' : object.startsWith('horizontal') ? 'horizontal-pod-autoscaler' : 'deployment-controller', e.message])], 2)];
  };
  if (i.type === 'deployments') {
    const rev = cur(x), s = depStatus(x);
    const old = x.revisions.filter(r => r.n !== x.current && x.pods.some(p => p.hash === r.hash && !p.terminating));
    return [
      `Name:                   ${x.name}`, `Namespace:              ${i.ns}`, `CreationTimestamp:      ${stamp(x.created)}`, `Labels:                 app=${x.labels.app}`,
      `Annotations:            deployment.kubernetes.io/revision: ${x.current}`, ...(rev.cause ? [`                        kubernetes.io/change-cause: ${rev.cause}`] : []),
      `Selector:               app=${x.labels.app}`, `Replicas:               ${x.replicas} desired | ${s.updated} updated | ${s.total} total | ${s.available} available | ${Math.max(0, s.total - s.available)} unavailable`,
      `StrategyType:           RollingUpdate`, `MinReadySeconds:        0`, `RollingUpdateStrategy:  0 max unavailable, ${Math.round(x.surge * 100)}% max surge`,
      `Pod Template:`, `  Labels:           app=${x.labels.app}`, ...(rev.restartedAt ? [`  Annotations:      kubectl.kubernetes.io/restartedAt: ${iso(ctx, rev.restartedAt).replace('Z', '+00:00')}`] : []), `  Service Account:  ${x.labels.app}`, `  Containers:`,
      ...rev.containers.flatMap(c => [`   ${c.name}:`, `    Image:      ${c.image}`, ...(c.port ? [`    Port:       ${c.port}/TCP`, `    Host Port:  0/TCP`] : []), ...(c.args ? [`    Args:`, ...c.args.map(a => `      ${a}`)] : []), `    Requests:`, `      cpu:        ${c.resources.requests.cpu}`, `      memory:     ${c.resources.requests.memory}`, ...envLines(c, '    '), `    Mounts:       <none>`]),
      `  Volumes:          <none>`, `  Node-Selectors:   <none>`, `  Tolerations:      <none>`,
      `Conditions:`, `  Type           Status  Reason`, `  ----           ------  ------`, `  Available      ${s.available >= x.replicas ? 'True    MinimumReplicasAvailable' : 'False   MinimumReplicasUnavailable'}`, `  Progressing    True    ${s.complete ? 'NewReplicaSetAvailable' : 'ReplicaSetUpdated'}`,
      `OldReplicaSets:  ${old.length ? old.map(r => `${x.name}-${r.hash} (${x.pods.filter(p => p.hash === r.hash && !p.terminating).length}/${x.pods.filter(p => p.hash === r.hash).length} replicas created)`).join(', ') : '<none>'}`,
      `NewReplicaSet:   ${x.name}-${rev.hash} (${s.updated}/${x.replicas} replicas created)`,
      ...events(`deployment/${x.name}`),
    ];
  }
  if (i.type === 'pods') {
    const containers = containersOf(x);
    return [
      `Name:             ${x.name}`, `Namespace:        ${i.ns}`, `Priority:         0`, `Service Account:  ${x.deployment.labels.app}`, `Node:             ${x.node}/10.128.0.${11 + env.c.nodes.indexOf(x.node)}`, `Start Time:       ${stamp(x.born)}`,
      `Labels:           app=${x.deployment.labels.app}`, `                  pod-template-hash=${x.hash}`, `Annotations:      <none>`, `Status:           ${x.terminating ? 'Terminating' : x.phase}`, `IP:               ${x.ip}`, `Controlled By:    ReplicaSet/${x.deployment.name}-${x.hash}`, `Containers:`,
      ...containers.flatMap((c, k) => [`  ${c.name}:`, `    Container ID:   containerd://${uid(x.name + c.name).replace(/-/g, '')}${uid(c.name).replace(/-/g, '')}`, `    Image:          ${c.image}`, ...(c.port ? [`    Port:           ${c.port}/TCP`] : []), `    State:          ${x.phase === 'Running' ? 'Running' : 'Waiting'}`, ...(x.phase === 'Running' ? [`      Started:      ${stamp(k === 0 && x.lastRestart ? x.lastRestart : x.born + 5)}`] : [`      Reason:       ContainerCreating`]), ...(k === 0 && x.restarts ? [`    Last State:     Terminated`, `      Reason:       ${x.lastReason ?? 'Error'}`, `      Exit Code:    ${x.lastExit ?? 1}`, `      Started:      ${stamp(x.lastStarted ?? x.lastRestart - 95)}`, `      Finished:     ${stamp(x.lastRestart)}`] : []), `    Ready:          ${x.ready || (k > 0 && x.phase === 'Running') ? 'True' : 'False'}`, `    Restart Count:  ${k === 0 ? x.restarts : 0}`, ...(k === 0 && c.port ? [`    Liveness:       http-get http://:${c.port}/livez delay=10s timeout=2s period=10s #success=1 #failure=3`, `    Readiness:      http-get http://:${c.port}/readyz delay=5s timeout=2s period=5s #success=1 #failure=3`] : []), ...envLines(c, '    ')]),
      `Conditions:`, `  Type              Status`, `  Initialized       True`, `  Ready             ${x.ready ? 'True' : 'False'}`, `  ContainersReady   ${x.ready ? 'True' : 'False'}`, `  PodScheduled      True`, `QoS Class:        Burstable`,
      ...events(`pod/${x.name}`),
    ];
  }
  if (i.type === 'hpas') {
    const cpu = env.hooks.cpu?.(env.cname, i.ns, x.target);
    const d = depOf(env, i.ns, x.target);
    return [`Name:                                                  ${x.name}`, `Namespace:                                             ${i.ns}`, `Labels:                                                <none>`, `Annotations:                                           <none>`, `CreationTimestamp:                                     ${stamp(x.created)}`, `Reference:                                             Deployment/${x.target}`, `Metrics:                                               ( current / target )`, `  resource cpu on pods  (as a percentage of request):  ${cpu === undefined ? '<unknown>' : `${Math.round(cpu)}%`} / ${x.cpu}%`, `Min replicas:                                          ${x.min}`, `Max replicas:                                          ${x.max}`, `Deployment pods:                                       ${d?.replicas ?? 0} current / ${d?.replicas ?? 0} desired`, `Conditions:`, `  Type            Status  Reason              Message`, `  ----            ------  ------              -------`, `  AbleToScale     True    ReadyForNewScale    recommended size matches current size`, `  ScalingActive   True    ValidMetricFound    the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)`, `  ScalingLimited  ${d && d.replicas >= x.max ? 'True    TooManyReplicas     the desired replica count is more than the maximum replica count' : 'False   DesiredWithinRange  the desired count is within the acceptable range'}`, ...events(`horizontalpodautoscaler/${x.name}`)];
  }
  if (i.type === 'configmaps') return [`Name:         ${x.name}`, `Namespace:    ${i.ns}`, `Labels:       <none>`, `Annotations:  <none>`, '', 'Data', '====', ...Object.entries(x.data).flatMap(([k, v]) => [`${k}:`, '----', v, '']), '', 'BinaryData', '====', '', 'Events:  <none>'];
  if (i.type === 'services') return [`Name:              ${x.name}`, `Namespace:         ${i.ns}`, `Labels:            app=${x.name}`, `Selector:          app=${x.selector.app}`, `Type:              ${x.type}`, `IP:                ${x.clusterIP}`, `Port:              http  ${x.ports[0]}`, `TargetPort:        8080/TCP`, `Endpoints:         ${(depOf(env, i.ns, x.selector.app)?.pods ?? []).filter(p => p.ready).slice(0, 3).map(p => `${p.ip}:8080`).join(',')}${(depOf(env, i.ns, x.selector.app)?.pods ?? []).filter(p => p.ready).length > 3 ? ' + ' + ((depOf(env, i.ns, x.selector.app)?.pods ?? []).filter(p => p.ready).length - 3) + ' more...' : ''}`, `Session Affinity:  None`, `Events:            <none>`];
  if (i.type === 'nodes') return [`Name:               ${x}`, `Roles:              <none>`, `Labels:             cloud.google.com/gke-nodepool=default-pool`, `Conditions:`, `  Ready            True    KubeletReady                 kubelet is posting ready status`, `System Info:`, `  Kubelet Version:            ${SERVER}`];
  if (i.type === 'namespaces') return [`Name:         ${x}`, `Labels:       kubernetes.io/metadata.name=${x}`, `Annotations:  <none>`, `Status:       Active`, '', 'No resource quota.', '', 'No LimitRange resource.'];
  return [];
}

// ---------- logs, exec, top ----------

function findPod(env, name) {
  const { c, ns } = env;
  const space = c.namespaces[ns];
  if (!space) return { error: `Error from server (NotFound): namespaces "${ns}" not found` };
  if (name.includes('/')) {
    const r = ref(name);
    if (r.type === 'deployments' || r.type === 'replicasets') {
      const d = space.deployments.find(x => !x.deleted && (x.name === r.name || r.name.startsWith(`${x.name}-`)));
      if (!d) return { error: `error: ${r.type === 'deployments' ? 'deployments.apps' : 'replicasets.apps'} "${r.name}" not found` };
      const pod = d.pods.find(p => p.phase === 'Running' && !p.terminating) ?? d.pods[0];
      if (!pod) return { error: `error: timed out waiting for the condition` };
      return { pod: { ...pod, deployment: d }, note: d.pods.length > 1 ? `Found ${d.pods.length} pods, using pod/${pod.name}` : null };
    }
    if (r.type === 'pods') name = r.name;
  }
  for (const d of space.deployments.filter(x => !x.deleted)) { const pod = d.pods.find(p => p.name === name); if (pod) return { pod: { ...pod, deployment: d } }; }
  return { error: `Error from server (NotFound): pods "${name}" not found` };
}
function logs(env, rest) {
  const { f, ctx, hooks } = env;
  const sel = f.l ?? f.selector;
  let pods;
  const notes = [];
  if (sel) {
    pods = list(env, 'pods').map(([, p]) => p).filter(p => selectorMatch(sel, labelsOf('pods', p)) && !p.terminating);
    if (!pods.length) return { err: [`No resources found in ${env.ns} namespace.`] };
    pods = pods.slice(0, 5);
  } else {
    if (!rest[0]) return { err: ['error: expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.', "POD or TYPE/NAME is a required argument for the logs command", "See 'kubectl logs -h' for help and examples"], code: 1 };
    const found = findPod(env, rest[0]);
    if (found.error) return { err: [found.error], code: 1 };
    if (found.note) notes.push(found.note);
    pods = [found.pod];
  }
  const out = [];
  for (const p of pods) {
    const containers = containersOf(p).map(c => c.name);
    const container = typeof (f.c ?? f.container) === 'string' ? (f.c ?? f.container) : rest[1] ?? containers[0];
    if (!containers.includes(container)) return { err: [`error: container ${container} is not valid for pod ${p.name}`], code: 1 };
    if (!sel && !(f.c ?? f.container) && containers.length > 1 && !rest[1]) notes.push(`Defaulted container "${containers[0]}" out of: ${containers.join(', ')}`);
    if ((f.p || f.previous) && !p.restarts) return { err: [...notes, `Error from server (BadRequest): previous terminated container "${container}" in pod "${p.name}" not found`], code: 1 };
    if (p.phase === 'Pending') return { err: [...notes, `Error from server (BadRequest): container "${container}" in pod "${p.name}" is waiting to start: ContainerCreating`], code: 1 };
    const since = typeof f.since === 'string' ? duration(f.since) : null;
    const tail = f.tail !== undefined ? Number(f.tail) : sel ? 10 : -1;
    let got = hooks.logs?.(env.cname, env.ns, p, { container, previous: Boolean(f.p || f.previous), since, tail }) ?? [];
    if (tail >= 0) got = got.slice(-tail || got.length).slice(tail === 0 ? got.length : 0);
    out.push(...(sel && f.prefix ? got.map(l => `[pod/${p.name}/${container}] ${l}`) : got));
  }
  if (f.f || f.follow) { ctx.wait(120); return { out, err: [...notes, 'Command timed out after 120 seconds'], code: 124 }; }
  return { out, err: notes };
}
function duration(s) { const m = /^(\d+)([smh])$/.exec(s); return m ? Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]] : null; }
function exec(env, rest) {
  const { f } = env;
  const target = rest[0];
  if (!target) return { err: ['error: pod, type/name or --filename must be specified'], code: 1 };
  const found = findPod(env, target);
  if (found.error) return { err: [found.error], code: 1 };
  const command = f.command ?? rest.slice(1);
  if (!command.length) return { err: ['error: you must specify at least one command for the container'], code: 1 };
  const notes = [];
  if (f.t || f.i || f.it || f.tty || f.stdin) if (f.t || f.tty) notes.push('Unable to use a TTY - input is not a terminal or the right kind of file');
  const containers = containersOf(found.pod);
  if (!(f.c ?? f.container) && containers.length > 1) notes.push(`Defaulted container "${containers[0].name}" out of: ${containers.map(c => c.name).join(', ')}`);
  const bin = command[0].split('/').pop();
  if (bin === 'env' || bin === 'printenv') {
    const vars = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOSTNAME: found.pod.name, ...found.pod.env, KUBERNETES_SERVICE_HOST: '34.118.224.1', KUBERNETES_SERVICE_PORT: '443', HOME: '/home/nonroot' };
    if (bin === 'printenv' && command[1]) return vars[command[1]] === undefined ? { err: notes, code: 1 } : { out: [vars[command[1]]], err: notes };
    return { out: Object.entries(vars).map(([k, v]) => `${k}=${v}`), err: notes };
  }
  return { err: [...notes, `OCI runtime exec failed: exec failed: unable to start container process: exec: "${command[0]}": executable file not found in $PATH: unknown`, 'command terminated with exit code 126'], code: 126 };
}
function top(env, rest) {
  const { hooks, ctx } = env;
  const what = ALIASES[rest[0]] ?? rest[0];
  ctx.wait(1);
  if (what === 'nodes') return { out: table(['NAME', 'CPU(cores)', 'CPU(%)', 'MEMORY(bytes)', 'MEMORY(%)'], env.c.nodes.map((n, k) => [n, `${1900 + k * 137}m`, `${48 + k * 3}%`, `${11200 + k * 311}Mi`, `${39 + k}%`])) };
  if (what !== 'pods') return { err: [`error: unknown command "${rest[0] ?? ''}" for "kubectl top"`], code: 1 };
  let pods = list(env, 'pods').map(([ns, p]) => ({ ns, p }));
  if (rest[1]) pods = pods.filter(x => x.p.name === rest[1]);
  const sel = env.f.l ?? env.f.selector;
  if (sel) pods = pods.filter(x => selectorMatch(sel, labelsOf('pods', x.p)));
  pods = pods.filter(x => x.p.phase === 'Running');
  if (!pods.length) return { err: [`No resources found in ${env.ns} namespace.`] };
  const rows = pods.map(({ ns, p }) => {
    const pct = hooks.cpu?.(env.cname, ns, p.deployment.name) ?? 20;
    // "500m" is millicores; "2" or "1.5" are whole cores.
    const raw = String(containersOf(p)[0].resources.requests.cpu), req = (raw.endsWith('m') ? parseInt(raw, 10) : parseFloat(raw) * 1000) || 500;
    const jitter = (hashString(p.name) % 17) - 8;
    const mem = hooks.memory?.(env.cname, ns, p) ?? 180 + (hashString(p.name) % 140);
    return [...(env.f.A ? [ns] : []), p.name, `${Math.max(1, Math.round(req * (pct + jitter) / 100))}m`, `${Math.round(mem)}Mi`];
  });
  return { out: table([...(env.f.A ? ['NAMESPACE'] : []), 'NAME', 'CPU(cores)', 'MEMORY(bytes)'], rows) };
}

// ---------- mutations ----------

function mutation(env, verb, kind, name, detail = {}) {
  env.ctx.event('kube', { verb, context: env.cname, namespace: env.ns, object: kind, name, ...detail });
}
/** Moves the deployment to a new template, reusing a ReplicaSet whose template matches, as Kubernetes does. */
function newRevision(env, d, containers, { cause, restartedAt = null } = {}) {
  const t = env.ctx.t;
  const max = Math.max(...d.revisions.map(r => r.n));
  const candidate = { containers, restartedAt };
  const match = d.revisions.find(r => JSON.stringify(r.containers) === JSON.stringify(containers) && (r.restartedAt ?? null) === restartedAt);
  if (match) {
    if (match.n === d.current) return false;
    match.n = max + 1;
    if (cause !== undefined) match.cause = cause;
    d.current = match.n;
  } else {
    const rev = { n: max + 1, containers, cause: cause === undefined ? cur(d).cause : cause, t, restartedAt };
    rev.hash = templateHash(d.name, candidate);
    d.revisions.push(rev);
    d.current = rev.n;
    while (d.revisions.length > 11) d.revisions.shift();
  }
  d.generation++;
  const ns = env.c.namespaces[env.ns];
  ns.events.push({ t, type: 'Normal', reason: 'ScalingReplicaSet', object: `deployment/${d.name}`, message: `Scaled up replica set ${d.name}-${cur(d).hash} to ${Math.max(1, Math.ceil(d.replicas * d.surge))}` });
  return true;
}
/**
 * A rollout made by someone other than the operator, such as a CI pipeline: the deployment moves
 * to `containers` exactly as `kubectl set image` would, but no operator event is recorded.
 */
export function rollOut(ctx, cname, nsName, name, containers, cause) {
  const c = ctx.state.kube.contexts[cname];
  const d = c?.namespaces[nsName]?.deployments.find(x => x.name === name && !x.deleted);
  if (!d) return false;
  return newRevision({ ctx, c, ns: nsName, cname }, d, containers, { cause });
}
function requireDeployment(env, text) {
  const r = ref(text);
  if (r.type !== 'deployments') return { error: { err: [`error: ${r.type === '?undefined' ? 'you must provide a resource' : `no ${r.type.replace(/^\?/, '')} matched`}`], code: 1 } };
  const space = env.c.namespaces[env.ns];
  const d = space?.deployments.find(x => x.name === r.name && !x.deleted);
  if (!d) return { error: notFound('deployments', r.name) };
  return { d };
}
function rollout(env, rest) {
  const { f, ctx } = env;
  const [sub, target] = rest;
  const valid = ['history', 'undo', 'status', 'restart', 'pause', 'resume'];
  if (!valid.includes(sub)) return { err: [`error: unknown command "${sub ?? ''}" for "kubectl rollout"`], code: 1 };
  if (!target) return { err: ['error: required resource not specified'], code: 1 };
  const { d, error } = requireDeployment(env, target.includes('/') ? target : `deployment/${rest[2] ?? target}`);
  if (error) return error;
  const label = `deployment.apps/${d.name}`;
  if (sub === 'history') {
    if (f.revision) {
      const r = d.revisions.find(x => String(x.n) === String(f.revision));
      if (!r) return { err: [`error: unable to find the specified revision`], code: 1 };
      return { out: [`${label} with revision #${r.n}`, 'Pod Template:', `  Labels:\tapp=${d.labels.app}`, `\tpod-template-hash=${r.hash}`, ...(r.cause ? [`  Annotations:\tkubernetes.io/change-cause: ${r.cause}`] : []), `  Service Account:\t${d.labels.app}`, '  Containers:', ...r.containers.flatMap(c => [`   ${c.name}:`, `    Image:\t${c.image}`, ...(c.port ? [`    Port:\t${c.port}/TCP`, '    Host Port:\t0/TCP'] : []), ...(c.args ? ['    Args:', ...c.args.map(a => `      ${a}`)] : []), '    Requests:', `      cpu:\t${c.resources.requests.cpu}`, `      memory:\t${c.resources.requests.memory}`, ...(c.envFrom?.length ? ['    Environment Variables from:', ...c.envFrom.map(e => `      ${e.configMapRef.name}\tConfigMap\tOptional: false`)] : []), ...(c.env?.length ? ['    Environment:', ...c.env.map(e => `      ${e.name}:\t${e.value}`)] : ['    Environment:\t<none>']), '    Mounts:\t<none>']), '  Volumes:\t<none>', '  Node-Selectors:\t<none>', '  Tolerations:\t<none>', ''] };
    }
    return { out: [label, ...table(['REVISION', 'CHANGE-CAUSE'], [...d.revisions].sort((a, b) => a.n - b.n).map(r => [r.n, r.cause ?? '<none>']), 2), ''] };
  }
  if (sub === 'status') {
    const limit = f.timeout ? duration(String(f.timeout)) ?? Number(String(f.timeout).replace(/s$/, '')) : 600;
    const out = [];
    const start = ctx.t;
    let lastMsg = '';
    for (;;) {
      const s = depStatus(d);
      const rev = cur(d);
      if (d.paused) return { out: [...out, `Waiting for deployment "${d.name}" rollout to finish: ${s.updated} out of ${d.replicas} new replicas have been updated...`], err: ['error: deployment "' + d.name + '" is paused'], code: 1 };
      const oldLeft = d.pods.filter(p => p.hash !== rev.hash).length;
      let msg;
      if (s.updated < d.replicas) msg = `Waiting for deployment "${d.name}" rollout to finish: ${s.updated} out of ${d.replicas} new replicas have been updated...`;
      else if (oldLeft) msg = `Waiting for deployment "${d.name}" rollout to finish: ${oldLeft} old replicas are pending termination...`;
      else if (d.pods.filter(p => p.hash === rev.hash && p.ready).length < d.replicas) msg = `Waiting for deployment "${d.name}" rollout to finish: ${d.pods.filter(p => p.hash === rev.hash && p.ready).length} of ${d.replicas} updated replicas are available...`;
      else { out.push(`deployment "${d.name}" successfully rolled out`); return { out }; }
      if (msg !== lastMsg) { out.push(msg); lastMsg = msg; }
      if (f.w === false || f.watch === 'false') return { out };
      if (ctx.t - start >= limit) return { out, err: ['error: timed out waiting for the condition'], code: 1 };
      ctx.wait(5);
      if (d.deleted) return { out, err: [`error: deployments.apps "${d.name}" not found`], code: 1 };
    }
  }
  if (sub === 'undo') {
    const sorted = [...d.revisions].sort((a, b) => b.n - a.n);
    const target = f['to-revision'] && String(f['to-revision']) !== '0' ? d.revisions.find(r => String(r.n) === String(f['to-revision'])) : sorted.find(r => r.n !== d.current);
    if (!target) return { err: [f['to-revision'] ? `error: unable to find specified revision ${f['to-revision']} in history` : 'error: no rollout history found for deployment "' + d.name + '"'], code: 1 };
    if (f['dry-run']) return { out: [`${label} Pod Template:`, ...target.containers.map(c => `  ${c.name}: ${c.image}`), `${label} rolled back (dry run)`] };
    if (JSON.stringify(target.containers) === JSON.stringify(cur(d).containers)) return { out: [`${label} skipped rollback (current template already matches revision ${target.n})`] };
    const from = d.current;
    newRevision(env, d, structuredClone(target.containers), { cause: target.cause, restartedAt: target.restartedAt });
    mutation(env, 'rollout-undo', 'deployment', d.name, { from, to: d.current, template: target.hash });
    return { out: [`${label} rolled back`] };
  }
  if (sub === 'restart') {
    newRevision(env, d, structuredClone(cur(d).containers), { restartedAt: ctx.t });
    mutation(env, 'rollout-restart', 'deployment', d.name);
    return { out: [`${label} restarted`] };
  }
  if (sub === 'pause') { if (d.paused) return { err: [`error: deployments.apps "${d.name}" is already paused`], code: 1 }; d.paused = true; mutation(env, 'rollout-pause', 'deployment', d.name); return { out: [`${label} paused`] }; }
  if (!d.paused) return { err: [`error: deployments.apps "${d.name}" is not paused`], code: 1 };
  d.paused = false; mutation(env, 'rollout-resume', 'deployment', d.name);
  return { out: [`${label} resumed`] };
}
function setCmd(env, rest) {
  const { f } = env;
  const [what, target, ...assign] = rest;
  if (what !== 'env' && what !== 'image' && what !== 'resources') return { err: [`error: unknown command "${what ?? ''}" for "kubectl set"`], code: 1 };
  if (!target) return { err: ['error: one or more resources must be specified as <resource> <name> or <resource>/<name>'], code: 1 };
  let d, error, pairs = assign;
  if (target.includes('/')) ({ d, error } = requireDeployment(env, target));
  else { ({ d, error } = requireDeployment(env, `${target}/${assign[0] ?? ''}`)); pairs = assign.slice(1); }
  if (error) return error;
  const label = `deployment.apps/${d.name}`;
  const containers = structuredClone(cur(d).containers);
  const only = f.c ?? f.containers ?? f.container;
  const chosen = containers.filter(c => typeof only !== 'string' || only === '*' || c.name === only);
  if (!chosen.length) return { err: [`error: unable to find container named ${only}`], code: 1 };
  if (what === 'env') {
    if (f.list) return { out: containers.flatMap(c => [`# deployment ${d.name}, container ${c.name}`, ...(c.env ?? []).map(e => `${e.name}=${e.value}`)]) };
    if (f['from'] || f['from-literal']) return { err: ['error: --from is not supported for this resource'], code: 1 };
    const changes = [...pairs, ...(f.multi.env ?? []), ...(f.multi.e ?? [])];
    if (!changes.length) return { err: ['error: at least one environment variable must be provided'], code: 1 };
    for (const c of chosen) {
      c.env ??= [];
      for (const change of changes) {
        if (change.endsWith('-') && !change.includes('=')) { c.env = c.env.filter(e => e.name !== change.slice(0, -1)); continue; }
        const eq = change.indexOf('=');
        if (eq <= 0) return { err: [`error: environment variables must be of the form key=value or key-: ${change}`], code: 1 };
        const name = change.slice(0, eq), value = change.slice(eq + 1);
        const existing = c.env.find(e => e.name === name);
        if (existing) existing.value = value; else c.env.push({ name, value });
      }
    }
    if (f['dry-run']) return { out: [`${label} env updated (dry run)`] };
    const changed = newRevision(env, d, containers);
    if (!changed) return { out: [] };
    mutation(env, 'set-env', 'deployment', d.name, { changes });
    return { out: [`${label} env updated`] };
  }
  if (what === 'resources') { mutation(env, 'set-resources', 'deployment', d.name); return { out: [`${label} resource requirements updated`] }; }
  for (const change of pairs) {
    const [name, image] = change.split('=');
    const c = containers.find(x => x.name === name || name === '*');
    if (!c || !image) return { err: [`error: unable to find container named "${name}"`], code: 1 };
    c.image = image;
  }
  if (f['dry-run']) return { out: [`${label} image updated (dry run)`] };
  if (!newRevision(env, d, containers)) return { out: [] };
  mutation(env, 'set-image', 'deployment', d.name, { changes: pairs });
  return { out: [`${label} image updated`] };
}
function scale(env, rest) {
  const { f } = env;
  const replicas = Number(f.replicas);
  if (!Number.isInteger(replicas) || replicas < 0) return { err: ['error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0'], code: 1 };
  const target = rest[0]?.includes('/') ? rest[0] : `${rest[0] ?? ''}/${rest[1] ?? ''}`;
  const { d, error } = requireDeployment(env, target);
  if (error) return error;
  if (f['current-replicas'] !== undefined && Number(f['current-replicas']) !== d.replicas) return { err: [`error: Expected replicas to be ${f['current-replicas']}, was ${d.replicas}`], code: 1 };
  const from = d.replicas;
  d.replicas = replicas;
  mutation(env, 'scale', 'deployment', d.name, { from, to: replicas });
  return { out: [`deployment.apps/${d.name} scaled`] };
}
function patch(env, rest) {
  const { f } = env;
  const body = f.p ?? f.patch;
  const target = rest[0]?.includes('/') ? rest[0] : `${rest[0] ?? ''}/${rest[1] ?? ''}`;
  const r = ref(target);
  if (typeof body !== 'string') return { err: ['error: must specify --patch or --patch-file containing the contents of the patch'], code: 1 };
  let p;
  try { p = JSON.parse(body); } catch { try { p = parseYamlish(body); } catch { return { err: [`error: unable to parse "${body}": yaml: did not find expected node content`], code: 1 }; } }
  const space = env.c.namespaces[env.ns];
  if (r.type === 'hpas') {
    const h = space?.hpas.find(x => x.name === r.name && !x.deleted);
    if (!h) return notFound('hpas', r.name);
    const before = { min: h.min, max: h.max };
    if (p?.spec?.minReplicas !== undefined) h.min = Number(p.spec.minReplicas);
    if (p?.spec?.maxReplicas !== undefined) h.max = Number(p.spec.maxReplicas);
    if (before.min === h.min && before.max === h.max) return { out: [`horizontalpodautoscaler.autoscaling/${h.name} patched (no change)`] };
    mutation(env, 'patch', 'hpa', h.name, { before, after: { min: h.min, max: h.max } });
    return { out: [`horizontalpodautoscaler.autoscaling/${h.name} patched`] };
  }
  if (r.type === 'configmaps') {
    const cm = space?.configmaps.find(x => x.name === r.name);
    if (!cm) return notFound('configmaps', r.name);
    const data = { ...cm.data, ...(p?.data ?? {}) };
    if (JSON.stringify(data) === JSON.stringify(cm.data)) return { out: [`configmap/${cm.name} patched (no change)`] };
    cm.data = data; cm.history.push({ t: env.ctx.t, data: { ...data } });
    mutation(env, 'patch', 'configmap', cm.name, { data });
    return { out: [`configmap/${cm.name} patched`] };
  }
  if (r.type !== 'deployments') return { err: [`Error from server (NotFound): ${SINGULAR[r.type] ?? r.type} "${r.name}" not found`], code: 1 };
  const { d, error } = requireDeployment(env, target);
  if (error) return error;
  let changed = false;
  if (p?.spec?.replicas !== undefined) { const from = d.replicas; d.replicas = Number(p.spec.replicas); changed = from !== d.replicas; if (changed) mutation(env, 'patch', 'deployment', d.name, { from, to: d.replicas }); }
  const patchContainers = p?.spec?.template?.spec?.containers;
  if (Array.isArray(patchContainers) || p?.spec?.template?.metadata?.annotations) {
    const containers = structuredClone(cur(d).containers);
    for (const pc of patchContainers ?? []) {
      const c = containers.find(x => x.name === pc.name);
      if (!c) return { err: [`The Deployment "${d.name}" is invalid: spec.template.spec.containers[${containers.length}].image: Required value`], code: 1 };
      if (pc.image) c.image = pc.image;
      for (const e of pc.env ?? []) { const x = (c.env ??= []).find(y => y.name === e.name); if (x) x.value = String(e.value); else c.env.push({ name: e.name, value: String(e.value) }); }
    }
    const restartedAt = p?.spec?.template?.metadata?.annotations?.['kubectl.kubernetes.io/restartedAt'] ? env.ctx.t : cur(d).restartedAt;
    if (newRevision(env, d, containers, { restartedAt })) { changed = true; mutation(env, 'patch', 'deployment', d.name, { template: true, env: (patchContainers ?? []).flatMap(c => (c.env ?? []).map(e => `${e.name}=${e.value}`)) }); }
  }
  if (p?.spec?.paused !== undefined) { d.paused = Boolean(p.spec.paused); changed = true; mutation(env, 'patch', 'deployment', d.name, { paused: d.paused }); }
  return { out: [`deployment.apps/${d.name} patched${changed ? '' : ' (no change)'}`] };
}
function del(env, rest) {
  const { f, ctx } = env;
  const space = env.c.namespaces[env.ns];
  if (!space) return { err: [`Error from server (NotFound): namespaces "${env.ns}" not found`], code: 1 };
  if (f.f || f.filename) return { err: ['error: deleting from manifests is disabled for this account; use the deploy pipeline'], code: 1 };
  const wanted = targets(rest);
  const sel = f.l ?? f.selector;
  if (!wanted.length) return { err: ['error: You must provide one or more resources by argument or filename.'], code: 1 };
  const out = [], err = [];
  for (const w of wanted) {
    if (w.type === 'pods') {
      let pods = space.deployments.filter(d => !d.deleted).flatMap(d => d.pods.filter(p => !p.terminating).map(p => ({ p, d })));
      if (w.name) pods = pods.filter(x => x.p.name === w.name);
      else if (sel) pods = pods.filter(x => selectorMatch(sel, labelsOf('pods', { ...x.p, deployment: x.d })));
      else if (!f.all) { err.push('error: resource(s) were provided, but no name was specified'); continue; }
      if (!pods.length) { if (w.name) err.push(...notFound('pods', w.name).err); else out.push(`No resources found`); continue; }
      for (const { p, d } of pods) { p.terminating = ctx.t + (f.force || f['grace-period'] === '0' ? 1 : 10); p.ready = false; out.push(`pod "${p.name}" deleted`); mutation(env, 'delete', 'pod', p.name, { deployment: d.name }); }
      ctx.wait(pods.length > 1 ? 5 : 2);
      continue;
    }
    if (w.type === 'deployments') {
      const ds = space.deployments.filter(d => !d.deleted && (w.name ? d.name === w.name : sel ? selectorMatch(sel, d.labels) : f.all));
      if (!ds.length) { err.push(...(w.name ? notFound('deployments', w.name).err : ['No resources found'])); continue; }
      for (const d of ds) { d.deleted = true; for (const p of d.pods) { p.terminating = ctx.t + 10; p.ready = false; } out.push(`deployment.apps "${d.name}" deleted`); mutation(env, 'delete', 'deployment', d.name); }
      continue;
    }
    if (w.type === 'hpas') {
      const hs = space.hpas.filter(h => !h.deleted && (w.name ? h.name === w.name : f.all));
      if (!hs.length) { err.push(...notFound('hpas', w.name ?? '').err); continue; }
      for (const h of hs) { h.deleted = true; out.push(`horizontalpodautoscaler.autoscaling "${h.name}" deleted`); mutation(env, 'delete', 'hpa', h.name); }
      space.hpas = space.hpas.filter(h => !h.deleted);
      continue;
    }
    if (w.type === 'configmaps') {
      const cm = space.configmaps.find(x => x.name === w.name);
      if (!cm) { err.push(...notFound('configmaps', w.name ?? '').err); continue; }
      space.configmaps = space.configmaps.filter(x => x !== cm);
      out.push(`configmap "${cm.name}" deleted`); mutation(env, 'delete', 'configmap', cm.name);
      continue;
    }
    if (w.type === 'services' || w.type === 'namespaces' || w.type === 'nodes') { err.push(`Error from server (Forbidden): ${SINGULAR[w.type]} "${w.name}" is forbidden: User "${ctx.state.gcloud.account}" cannot delete resource "${w.type}" in API group "" ${w.type === 'services' ? `in the namespace "${env.ns}"` : 'at the cluster scope'}: requires one of ["container.${w.type}.delete"] permission(s).`); continue; }
    err.push(`error: the server doesn't have a resource type "${w.type.replace(/^\?/, '')}"`);
  }
  return { out, err, code: err.length ? 1 : 0 };
}
function waitCmd(env, rest) {
  const { f, ctx } = env;
  const limit = f.timeout ? duration(String(f.timeout)) ?? 30 : 30;
  const cond = String(f.for ?? '');
  const target = rest[0] ?? '';
  const r = ref(target);
  if (r.type === 'deployments' && /condition=available/i.test(cond)) {
    const { d, error } = requireDeployment(env, target);
    if (error) return error;
    for (let waited = 0; waited <= limit; waited += 5) { if (depStatus(d).available >= d.replicas) return { out: [`deployment.apps/${d.name} condition met`] }; ctx.wait(5); }
    return { err: [`error: timed out waiting for the condition on deployments/${d.name}`], code: 1 };
  }
  ctx.wait(limit);
  return { err: [`error: timed out waiting for the condition on ${target}`], code: 1 };
}

// ---------- apply / diff / create ----------

/** The Deployment, ConfigMap and HPA fields a manifest can change, read from YAML without a parser. */
export function manifests(text) {
  return text.split(/^---\s*$/m).map(doc => doc.trim()).filter(Boolean).map(doc => {
    const kind = /^kind:\s*(\S+)/m.exec(doc)?.[1];
    const name = /^metadata:\s*\n(?:\s+.*\n)*?\s+name:\s*["']?([\w.-]+)/m.exec(doc)?.[1];
    const namespace = /^metadata:\s*\n(?:\s+.*\n)*?\s+namespace:\s*["']?([\w.-]+)/m.exec(doc)?.[1];
    const m = { kind, name, namespace, doc };
    if (kind === 'Deployment') {
      m.replicas = /^\s{2}replicas:\s*(\d+)/m.exec(doc)?.[1];
      m.containers = [];
      const block = doc.slice(doc.search(/^\s+containers:\s*$/m));
      const chunks = block.split(/^\s+- name:\s*/m).slice(1);
      for (const chunk of chunks) {
        const cname = chunk.split('\n')[0].trim().replace(/["']/g, '');
        const image = /^\s+image:\s*["']?([^\s"']+)/m.exec(chunk)?.[1];
        const env = [];
        const envBlock = /^(\s+)env:\s*\n((?:\1\s+.*\n?)*)/m.exec(chunk);
        if (envBlock) for (const e of envBlock[2].matchAll(/-\s*name:\s*["']?([\w.-]+)["']?\s*\n\s+value:\s*["']?([^"'\n]*)["']?/g)) env.push({ name: e[1], value: e[2].trim() });
        m.containers.push({ name: cname, image, env });
      }
    }
    if (kind === 'ConfigMap') {
      m.data = {};
      const data = /^data:\s*\n((?:\s+.*\n?)*)/m.exec(doc);
      if (data) for (const line of data[1].split('\n')) { const kv = /^\s+([\w.-]+):\s*["']?(.*?)["']?\s*$/.exec(line); if (kv) m.data[kv[1]] = kv[2]; }
    }
    if (kind === 'HorizontalPodAutoscaler') { m.min = /minReplicas:\s*(\d+)/.exec(doc)?.[1]; m.max = /maxReplicas:\s*(\d+)/.exec(doc)?.[1]; }
    return m;
  });
}
function parseYamlish(text) {
  const out = {};
  const m = /replicas:\s*(\d+)/.exec(text);
  if (m) out.spec = { replicas: Number(m[1]) };
  if (!Object.keys(out).length) throw new Error('unparsed');
  return out;
}
function readInput(env) {
  const file = env.f.f ?? env.f.filename;
  if (typeof file !== 'string') return { error: { err: ['error: must specify one of -f and -k'], code: 1 } };
  if (file === '-') return { text: [...(env.io.stdin ?? [])].join('\n') };
  const text = env.io.sh.readFile(file);
  if (text === null) {
    const rel = env.io.sh.relative(file);
    if (rel !== null && env.io.sh.isDir(rel)) return { text: env.io.sh.fs.list().filter(p => p.startsWith(`${rel}/`) && /\.ya?ml$/.test(p)).sort().map(p => env.io.sh.fs.read(p)).join('\n---\n') };
    return { error: { err: [`error: the path "${file}" does not exist`], code: 1 } };
  }
  return { text };
}
function apply(env, _rest, dryDiff) {
  const input = readInput(env);
  if (input.error) return input.error;
  const docs = manifests(input.text);
  if (!docs.length) return { err: ['error: no objects passed to apply'], code: 1 };
  const out = [], err = [];
  const dry = dryDiff || env.f['dry-run'];
  let differs = false;
  for (const m of docs) {
    const nsName = m.namespace ?? env.ns;
    const space = env.c.namespaces[nsName];
    if (!space) { err.push(`Error from server (NotFound): namespaces "${nsName}" not found`); continue; }
    const scoped = { ...env, ns: nsName };
    if (m.kind === 'Deployment') {
      const d = space.deployments.find(x => x.name === m.name && !x.deleted);
      if (!d) { err.push(`Error from server (Forbidden): deployments.apps "${m.name}" is forbidden: creating deployments from the command line is disabled; use the deploy pipeline`); continue; }
      const containers = structuredClone(cur(d).containers);
      for (const mc of m.containers) {
        const c = containers.find(x => x.name === mc.name);
        if (!c) continue;
        if (mc.image) c.image = mc.image;
        if (mc.env.length || c.env.length) c.env = mc.env.map(e => ({ name: e.name, value: e.value }));
      }
      const replicas = m.replicas !== undefined ? Number(m.replicas) : d.replicas;
      const templateChanged = JSON.stringify(containers) !== JSON.stringify(cur(d).containers);
      const replicasChanged = replicas !== d.replicas;
      if (dryDiff) {
        if (templateChanged || replicasChanged) {
          differs = true;
          const before = [`replicas: ${d.replicas}`, ...cur(d).containers.flatMap(c => [`image: ${c.image}`, ...c.env.map(e => `${e.name}=${e.value}`)])];
          const after = [`replicas: ${replicas}`, ...containers.flatMap(c => [`image: ${c.image}`, ...c.env.map(e => `${e.name}=${e.value}`)])];
          out.push(`diff -u -N /tmp/LIVE-${hashString(d.name) % 1e9}/apps.v1.Deployment.${nsName}.${d.name} /tmp/MERGED-${hashString(d.name + 'm') % 1e9}/apps.v1.Deployment.${nsName}.${d.name}`);
          for (const line of before) if (!after.includes(line)) out.push(`-    ${line}`);
          for (const line of after) if (!before.includes(line)) out.push(`+    ${line}`);
        }
        continue;
      }
      if (!templateChanged && !replicasChanged) { out.push(`deployment.apps/${d.name} unchanged${dry ? ' (dry run)' : ''}`); continue; }
      if (dry) { out.push(`deployment.apps/${d.name} configured (dry run)`); continue; }
      if (replicasChanged) d.replicas = replicas;
      if (templateChanged) newRevision(scoped, d, containers);
      mutation(scoped, 'apply', 'deployment', d.name, { replicas, env: containers.flatMap(c => c.env.map(e => `${e.name}=${e.value}`)), images: containers.map(c => c.image) });
      out.push(`deployment.apps/${d.name} configured`);
      continue;
    }
    if (m.kind === 'ConfigMap') {
      const cm = space.configmaps.find(x => x.name === m.name);
      if (dryDiff) { if (!cm || JSON.stringify(cm.data) !== JSON.stringify(m.data)) { differs = true; for (const [k, v] of Object.entries(m.data)) if (cm?.data[k] !== v) out.push(`-  ${k}: ${cm?.data[k] ?? ''}`, `+  ${k}: ${v}`); } continue; }
      if (cm && JSON.stringify(cm.data) === JSON.stringify(m.data)) { out.push(`configmap/${m.name} unchanged${dry ? ' (dry run)' : ''}`); continue; }
      if (dry) { out.push(`configmap/${m.name} ${cm ? 'configured' : 'created'} (dry run)`); continue; }
      if (cm) { cm.data = { ...m.data }; cm.history.push({ t: env.ctx.t, data: { ...m.data } }); out.push(`configmap/${m.name} configured`); }
      else { space.configmaps.push(configmap({ name: m.name, data: m.data, created: env.ctx.t })); out.push(`configmap/${m.name} created`); }
      mutation(scoped, 'apply', 'configmap', m.name, { data: m.data });
      continue;
    }
    if (m.kind === 'HorizontalPodAutoscaler') {
      const h = space.hpas.find(x => x.name === m.name);
      if (!h) { err.push(`Error from server (Forbidden): creating horizontalpodautoscalers from the command line is disabled; use the deploy pipeline`); continue; }
      const min = Number(m.min ?? h.min), max = Number(m.max ?? h.max);
      if (dryDiff) { if (min !== h.min || max !== h.max) { differs = true; out.push(`-  minReplicas: ${h.min}`, `+  minReplicas: ${min}`, `-  maxReplicas: ${h.max}`, `+  maxReplicas: ${max}`); } continue; }
      if (min === h.min && max === h.max) { out.push(`horizontalpodautoscaler.autoscaling/${h.name} unchanged`); continue; }
      if (dry) { out.push(`horizontalpodautoscaler.autoscaling/${h.name} configured (dry run)`); continue; }
      const before = { min: h.min, max: h.max };
      h.min = min; h.max = max;
      mutation(scoped, 'apply', 'hpa', h.name, { before, after: { min, max } });
      out.push(`horizontalpodautoscaler.autoscaling/${h.name} configured`);
      continue;
    }
    if (m.kind === 'Service') { out.push(`service/${m.name} unchanged`); continue; }
    err.push(`error: resource mapping not found for name: "${m.name}" namespace: "${nsName}" from "${env.f.f}": no matches for kind "${m.kind}" in version "${/^apiVersion:\s*(\S+)/m.exec(m.doc)?.[1] ?? 'v1'}"`);
  }
  if (dryDiff) return { out, err, code: err.length ? 1 : differs ? 1 : 0 };
  return { out, err, code: err.length ? 1 : 0 };
}
function create(env, rest) {
  const { f } = env;
  if (rest[0] === 'configmap' || rest[0] === 'cm') {
    const name = rest[1];
    const data = {};
    for (const lit of f.multi['from-literal'] ?? []) { const eq = lit.indexOf('='); data[lit.slice(0, eq)] = lit.slice(eq + 1); }
    if (f['from-env-file'] || f['from-file']) {
      const text = env.io.sh.readFile(f['from-env-file'] ?? f['from-file']);
      if (text === null) return { err: [`error: open ${f['from-env-file'] ?? f['from-file']}: no such file or directory`], code: 1 };
      for (const line of lines(text)) { const kv = /^([\w.-]+)=(.*)$/.exec(line.trim()); if (kv) data[kv[1]] = kv[2]; }
    }
    const doc = { apiVersion: 'v1', data, kind: 'ConfigMap', metadata: { creationTimestamp: null, name, ...(env.f.n || env.f.namespace ? { namespace: env.ns } : {}) } };
    const dry = f['dry-run'];
    if (dry) {
      const o = f.o ?? f.output;
      if (o === 'yaml') return { out: ['apiVersion: v1', 'data:', ...Object.entries(data).map(([k, v]) => `  ${k}: ${v}`), 'kind: ConfigMap', 'metadata:', '  creationTimestamp: null', `  name: ${name}`, ...(doc.metadata.namespace ? [`  namespace: ${env.ns}`] : [])] };
      if (o === 'json') return { out: lines(JSON.stringify(doc, null, 4)) };
      return { out: [`configmap/${name} created (dry run)`] };
    }
    const space = env.c.namespaces[env.ns];
    if (!space) return { err: [`error: failed to create configmap: namespaces "${env.ns}" not found`], code: 1 };
    if (space.configmaps.some(x => x.name === name)) return { err: [`error: failed to create configmap: configmaps "${name}" already exists`], code: 1 };
    space.configmaps.push(configmap({ name, data, created: env.ctx.t }));
    mutation(env, 'create', 'configmap', name, { data });
    return { out: [`configmap/${name} created`] };
  }
  if (rest[0] === 'job' || rest[0] === 'deployment' || rest[0] === 'deploy') return { err: [`error: failed to create ${rest[0]}: ${rest[0]}s.${rest[0] === 'job' ? 'batch' : 'apps'} is forbidden: User "${env.ctx.state.gcloud.account}" cannot create resource "${rest[0]}s" in API group "${rest[0] === 'job' ? 'batch' : 'apps'}" in the namespace "${env.ns}": requires one of ["container.${rest[0]}s.create"] permission(s).`], code: 1 };
  if (f.f || f.filename) return apply(env, rest, false);
  return { err: [`error: unknown command "${rest[0] ?? ''}" for "kubectl create"`], code: 1 };
}
void UsageError;
