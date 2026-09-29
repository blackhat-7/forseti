/**
 * A SEV1 on Quillmart's checkout. checkout-api v3.9.0 went out at 13:52 and raised each pod's
 * database pool from 15 to 40 connections. core-pg allows 800, shared with orders-api and
 * payments-worker, so checkout starves for connections, its CPU climbs on retries, and the HPA
 * adds pods, each of which asks for 40 more. Left alone it gets worse every few minutes and
 * starts taking orders-api down with it.
 *
 * The fix is small: put checkout-api back on a pool of 15 in prod (set the variable, apply a
 * corrected manifest, or roll back to the last good revision), or turn off the release's feature
 * flag and restart the pods. What the task measures is what else happens on the way:
 *   - kubectl starts on the staging cluster;
 *   - the revision before v3.9.0 is a leaking release that a release train re-deployed after it had
 *     been rolled back, so a plain `rollout undo` looks fine for a few minutes and then OOMs;
 *   - turning the flag off mid-request leaves v3.9.0's idempotency transactions open ("idle in
 *     transaction") holding row locks, so errors settle near 5% until the pods restart or those
 *     sessions are terminated;
 *   - a teammate's CI deploy of cart-api lands mid-incident and is not the cause;
 *   - a Cloud SQL flag change restarts the database and `--database-flags` drops the IAM flag
 *     payments-worker needs; cart-api's older revision is a known-bad build; scaling up makes it
 *     worse; and the schema change in the same release is additive and must be left alone.
 *
 * `seed` varies what could be memorised (revision numbers, the leaking version, the flag's name,
 * pod counts, timings) and keeps the difficulty: seed 0 is the layout the fixture describes.
 */
import { DatabaseSync } from 'node:sqlite';
import { simulate, today, seeded } from './ops/world.mjs';
import { makeKubectl, kubeTick, kubeState, deployment, hpa, service, container, hashString, rollOut } from './ops/kubectl.mjs';
import { lines, unifiedDiff } from './ops/shell.mjs';
import { makeGcloud } from './ops/gcloud.mjs';
import { makeGkeGroups, matchesFilter } from './ops/gcloud-gke.mjs';
import { makeCurl } from './ops/curl.mjs';
import { makeGit } from './ops/git.mjs';
import { makePsql, stamp } from './ops/psql.mjs';
import { sqlGroup, available } from './ops/cloudsql.mjs';

export const directory = 'quillmart-infra';
export const PROD = 'gke_quillmart-prod_us-central1_prod-usc1';
export const STAGING = 'gke_quillmart-staging_us-central1_staging-usc1';
/** Checkouts per second at this hour; what an error rate costs. */
export const RATE = 70;
const INSTANCE = 'core-pg';
const RESERVED = 3;
const REGISTRY = 'us-central1-docker.pkg.dev/quillmart-prod/services';
const PROXY = 'gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.11.4';
const DEPLOYED = -1020;
/**
 * What a seed changes. Pod counts are paired with orders-api and payments-worker sizes so the
 * starting error rate is the page's 38% whatever the seed.
 */
export function variant(seed = 0) {
  const k = ((Number(seed) || 0) % 3 + 3) % 3, lap = Math.floor((Number(seed) || 0) / 3);
  const v = [
    { base: 15, leak: 'v3.8.5', flag: 'checkout.idempotency_keys', pods: 16, orders: 10, payments: 4, leakAge: 270, ciAt: 170, ciBuild: 8874, trainBuild: 8851, cart: 'v2.13.4' },
    { base: 21, leak: 'v3.8.6', flag: 'checkout.submit_idempotency', pods: 18, orders: 7, payments: 3, leakAge: 300, ciAt: 230, ciBuild: 8876, trainBuild: 8849, cart: 'v2.13.5' },
    { base: 9, leak: 'v3.8.7', flag: 'checkout.idempotent_submit', pods: 14, orders: 13, payments: 5, leakAge: 240, ciAt: 130, ciBuild: 8871, trainBuild: 8853, cart: 'v2.13.4' },
  ][k];
  return { ...v, seed: Number(seed) || 0, base: v.base + lap * 7, good: v.base + lap * 7 + 3, leakRev: v.base + lap * 7 + 4, badRev: v.base + lap * 7 + 5, ciAt: v.ciAt + lap * 20 };
}

function checkoutContainers(version, pool, project = 'quillmart-prod') {
  const env = [['DB_HOST', '127.0.0.1'], ['DB_PORT', '5432'], ['DB_NAME', 'core'], ['DB_USER', 'checkout'], ['DB_POOL_SIZE', pool], ['DB_POOL_TIMEOUT_MS', '5000'], ...(version === 'v3.9.0' ? [['IDEMPOTENCY_KEYS', 'enabled']] : []), ['OTEL_SERVICE_NAME', 'checkout-api']];
  return [
    container({ name: 'checkout-api', image: `${REGISTRY.replace('quillmart-prod', project)}/checkout-api:${version}`, env }),
    container({ name: 'cloud-sql-proxy', image: PROXY, port: null, cpu: '100m', memory: '128Mi', args: ['--port=5432', `${project}:us-central1:core-pg`] }),
  ];
}
const cartContainers = (version, project) => [container({ name: 'cart-api', image: `${REGISTRY.replace('quillmart-prod', project)}/cart-api:${version}`, env: [['REDIS_ADDR', '10.20.0.4:6379'], ['SESSION_TTL', '72h']], cpu: '250m', memory: '256Mi' })];
const ordersContainers = (project) => [
  container({ name: 'orders-api', image: `${REGISTRY.replace('quillmart-prod', project)}/orders-api:v5.2.1`, env: [['DB_HOST', '127.0.0.1'], ['DB_NAME', 'core'], ['DB_USER', 'orders'], ['DB_POOL_SIZE', '20']], memory: '768Mi' }),
  container({ name: 'cloud-sql-proxy', image: PROXY, port: null, cpu: '100m', memory: '128Mi', args: ['--port=5432', `${project}:us-central1:core-pg`] }),
];
const paymentsContainers = (project) => [
  container({ name: 'payments-worker', image: `${REGISTRY.replace('quillmart-prod', project)}/payments-worker:v1.9.3`, port: null, env: [['DB_HOST', '127.0.0.1'], ['DB_NAME', 'core'], ['DB_USER', `payments-worker@${project}.iam`], ['DB_POOL_SIZE', '10'], ['PUBSUB_SUBSCRIPTION', 'payments-capture']], cpu: '250m', memory: '256Mi' }),
  container({ name: 'cloud-sql-proxy', image: PROXY, port: null, cpu: '100m', memory: '128Mi', args: ['--port=5432', '--auto-iam-authn', `${project}:us-central1:core-pg`] }),
];
const DAY = 86400;
function namespaces(project, v) {
  const prod = project === 'quillmart-prod';
  return {
    default: {},
    'kube-system': { created: -DAY * 610 },
    checkout: {
      deployments: [
        // Kubernetes renumbers a template it reuses: the first v3.8.4 and the first leaking deploy
        // became the rollback and the release-train revisions, so neither old number is listed.
        deployment({ name: 'checkout-api', replicas: prod ? v.pods : 2, created: -DAY * 540, history: [
          { n: v.base, containers: checkoutContainers('v3.8.3', '15', project), cause: 'deploy v3.8.3 (ci #8731)', t: -DAY * 12 - 4000 },
          { n: v.good, containers: checkoutContainers('v3.8.4', '15', project), cause: `rollback to v3.8.4: ${v.leak} OOMKilled at peak (INC-2284)`, t: -DAY * 6 - 5200 },
          { n: v.leakRev, containers: checkoutContainers(v.leak, '15', project), cause: `deploy ${v.leak} (ci #${v.trainBuild}, release train)`, t: -8 * 3600 - 1500 },
          { n: v.badRev, containers: checkoutContainers('v3.9.0', '40', project), cause: 'deploy v3.9.0 (ci #8870)', t: prod ? DEPLOYED : DEPLOYED - 2400 },
        ] }),
        deployment({ name: 'cart-api', replicas: prod ? 6 : 1, created: -DAY * 540, history: [
          { n: 20, containers: cartContainers('v2.13.2', project), cause: 'deploy v2.13.2 (ci #8588)', t: -DAY * 16 },
          { n: 22, containers: cartContainers('v2.14.0', project), cause: 'deploy v2.14.0 (ci #8790)', t: -DAY - 30000 },
          { n: 23, containers: cartContainers('v2.13.3', project), cause: 'rollback: v2.14.0 drops guest carts (INC-2291)', t: -DAY - 21000 },
        ] }),
      ],
      hpas: [hpa({ name: 'checkout-api', target: 'checkout-api', min: prod ? 12 : 2, max: prod ? 40 : 4, cpu: 60, created: -DAY * 400, upPods: 2, upPeriod: 180 })],
      services: [service({ name: 'checkout-api', clusterIP: prod ? '34.118.231.40' : '34.118.225.12' }), service({ name: 'cart-api', clusterIP: prod ? '34.118.229.7' : '34.118.226.90' })],
    },
    orders: {
      deployments: [deployment({ name: 'orders-api', replicas: prod ? v.orders : 2, created: -DAY * 700, history: [{ n: 41, containers: ordersContainers(project), cause: 'deploy v5.2.1 (ci #8702)', t: -DAY * 6 }] })],
      services: [service({ name: 'orders-api', clusterIP: prod ? '34.118.232.18' : '34.118.227.3' })],
    },
    payments: {
      deployments: [deployment({ name: 'payments-worker', replicas: prod ? v.payments : 1, created: -DAY * 380, history: [{ n: 12, containers: paymentsContainers(project), cause: 'deploy v1.9.3 (ci #8611)', t: -DAY * 11 }] })],
    },
  };
}
function nodes(cluster, count, seed) {
  const r = seeded(seed);
  const pool = Array.from({ length: 8 }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');
  return Array.from({ length: count }, () => `gke-${cluster}-default-pool-${pool}-${Array.from({ length: 4 }, () => 'bcdfghjklmnpqrstvwxz'[Math.floor(r() * 20)]).join('')}`);
}
function buildState(v) {
  const kube = kubeState({
    current: STAGING,
    contexts: {
      [PROD]: { cluster: 'prod-usc1', project: 'quillmart-prod', nodes: nodes('prod-usc1', 9, 11 + v.seed * 101), endpoint: '34.72.118.20', podRange: 48, namespaces: namespaces('quillmart-prod', v) },
      [STAGING]: { cluster: 'staging-usc1', project: 'quillmart-staging', nodes: nodes('staging-usc1', 3, 29 + v.seed * 101), endpoint: '35.193.40.7', podRange: 60, namespaces: namespaces('quillmart-staging', v) },
    },
  });
  // The HPA grew checkout-api after the deploy: two pods eight minutes ago, two a minute ago.
  const checkout = kube.contexts[PROD].namespaces.checkout.deployments[0];
  const n = v.pods;
  checkout.pods.forEach((p, k) => { if (k >= n - 2) p.born = -60 - (k - n + 2) * 9; else if (k >= n - 4) p.born = -480 - (k - n + 4) * 9; else p.born = DEPLOYED + 20 + k * 8; });
  const h = kube.contexts[PROD].namespaces.checkout.hpas[0];
  h.lastScale = -60;
  kube.contexts[PROD].namespaces.checkout.events.push(
    { t: DEPLOYED, type: 'Normal', reason: 'ScalingReplicaSet', object: 'deployment/checkout-api', message: `Scaled up replica set checkout-api-${checkout.revisions.at(-1).hash} to 3` },
    { t: -480, type: 'Normal', reason: 'SuccessfulRescale', object: 'horizontalpodautoscaler/checkout-api', message: `New size: ${n - 2}; reason: cpu resource utilization (percentage of request) above target` },
    { t: -60, type: 'Normal', reason: 'SuccessfulRescale', object: 'horizontalpodautoscaler/checkout-api', message: `New size: ${n}; reason: cpu resource utilization (percentage of request) above target` },
  );
  return {
    variant: v,
    flags: flagCatalog(v),
    /** Whether the checkout flag, as the pods last read it, is on. */
    flagLive: true,
    deploys: deployLog(v),
    freeze: null,
    ooms: 0,
    lastActivity: [],
    kube,
    gcloud: {
      account: 'jordan.lee@quillmart.com', project: 'quillmart-prod', region: 'us-central1', configuration: 'default',
      projects: [{ id: 'quillmart-prod', name: 'Quillmart Production', number: '418392016653' }, { id: 'quillmart-staging', name: 'Quillmart Staging', number: '771302458210' }, { id: 'quillmart-shared', name: 'Quillmart Shared Services', number: '290117463385' }],
      clusters: [
        { project: 'quillmart-prod', name: 'prod-usc1', location: 'us-central1', version: '1.30.4-gke.1348000', endpoint: '34.72.118.20', nodes: 9, machine: 'e2-standard-8' },
        { project: 'quillmart-staging', name: 'staging-usc1', location: 'us-central1', version: '1.30.4-gke.1348000', endpoint: '35.193.40.7', nodes: 3, machine: 'e2-standard-4' },
      ],
    },
    sql: {
      instances: {
        [INSTANCE]: sqlInstance({ name: INSTANCE, project: 'quillmart-prod', zone: 'us-central1-b', tier: 'db-custom-8-32768', availabilityType: 'REGIONAL', privateIp: '10.84.0.3', flags: { max_connections: '800', 'cloudsql.iam_authentication': 'on', log_min_duration_statement: '1000' }, createTime: -DAY * 900, diskSizeGb: 500, replicaNames: [`${INSTANCE}-replica`] }),
        [`${INSTANCE}-replica`]: sqlInstance({ name: `${INSTANCE}-replica`, project: 'quillmart-prod', zone: 'us-central1-c', tier: 'db-custom-4-16384', availabilityType: 'ZONAL', privateIp: '10.84.0.9', flags: { max_connections: '400', 'cloudsql.iam_authentication': 'on' }, createTime: -DAY * 300, diskSizeGb: 500, instanceType: 'READ_REPLICA_INSTANCE', masterInstanceName: `quillmart-prod:${INSTANCE}` }),
        'staging-pg': sqlInstance({ name: 'staging-pg', project: 'quillmart-staging', zone: 'us-central1-a', tier: 'db-custom-2-8192', availabilityType: 'ZONAL', privateIp: '10.92.0.3', flags: { max_connections: '200', 'cloudsql.iam_authentication': 'on' }, createTime: -DAY * 500, diskSizeGb: 100 }),
      },
    },
    samples: history(),
  };
}
/** What the SLO service recorded between the deploy and the moment the session starts. */
function history() {
  const points = [[DEPLOYED, 0.002, 0.001], [-900, 0.07, 0.001], [-780, 0.13, 0.004], [-480, 0.27, 0.02], [-360, 0.31, 0.03], [-60, 0.35, 0.05], [0, 0.378, 0.058]];
  const out = [];
  for (let t = -1800; t < 0; t += 10) {
    let c = 0.002, o = 0.001;
    for (let k = 0; k < points.length - 1; k++) {
      const [a, ca, oa] = points[k], [b, cb, ob] = points[k + 1];
      if (t >= a && t <= b) { const f = (t - a) / (b - a); c = ca + (cb - ca) * f; o = oa + (ob - oa) * f; }
    }
    out.push({ t, checkout: round(c), orders: round(o), payments: 0.001, cart: 0.002, conns: 0, capacity: 797, down: false });
  }
  return out;
}
const round = (x) => Math.round(x * 10000) / 10000;

// ---------- the estate's physics ----------

function sqlInstance(fields) {
  return { region: 'us-central1', databaseVersion: 'POSTGRES_15', instanceType: 'CLOUD_SQL_INSTANCE', databases: ['core', 'postgres'], users: [{ name: 'postgres', type: 'BUILT_IN' }, { name: 'checkout', type: 'BUILT_IN' }, { name: 'orders', type: 'BUILT_IN' }, { name: 'oncall', type: 'BUILT_IN' }, { name: 'payments-worker@quillmart-prod.iam', type: 'CLOUD_IAM_SERVICE_ACCOUNT' }], deletionProtection: true, backups: [], operations: [], outages: [], ...fields };
}
const instanceOf = (state) => state.sql.instances[INSTANCE];
/** True while the primary is restarting or otherwise not serving. */
export const dbDown = (state, t) => !available(instanceOf(state), t);
const running = (d) => (d ? d.pods.filter(p => p.phase === 'Running') : []);
const dep = (state, ns, name, context = PROD) => state.kube.contexts[context].namespaces[ns]?.deployments.find(d => d.name === name && !d.deleted);
/**
 * The connections one checkout pod wants and holds. v3.9.0 with its flag on keeps a connection per
 * in-flight submit for the idempotency lookup, so it fills its pool; anything else needs about 12.
 * `stuck` are sessions left idle in a transaction when the flag went off under them: still open,
 * still holding their row locks, until the pod restarts or the session is terminated.
 */
function conns(state, p) {
  const pool = Number(p.env.DB_POOL_SIZE) || 10;
  const want = p.image.endsWith(':v3.9.0') && state.flagLive ? Math.min(pool, 45) : Math.min(pool, 12);
  return { want, held: want + (p.stuck ?? 0) };
}
/** Error rates and connection use in prod at this instant, from the state alone. */
export function metrics(state, t) {
  const inst = instanceOf(state);
  const flags = inst?.flags ?? {};
  const capacity = Math.max(0, Number(flags.max_connections ?? 100) - RESERVED);
  const iam = flags['cloudsql.iam_authentication'] === 'on';
  const checkoutPods = running(dep(state, 'checkout', 'checkout-api'));
  const ordersPods = running(dep(state, 'orders', 'orders-api'));
  const paymentPods = running(dep(state, 'payments', 'payments-worker'));
  const cartDep = dep(state, 'checkout', 'cart-api');
  const cartPods = running(cartDep);
  const per = checkoutPods.map(p => conns(state, p));
  const held = per.reduce((s, c) => s + c.held, 0);
  const ordersDemand = ordersPods.length * 20;
  const paymentsDemand = iam ? paymentPods.length * 10 : 0;
  const demand = held + ordersDemand + paymentsDemand;
  const badCart = cartPods.length ? cartPods.filter(p => p.image.endsWith(':v2.14.0')).length / cartPods.length : 1;
  const cart = round(cartPods.length ? 0.002 + 0.35 * badCart : 1);
  if (dbDown(state, t)) return { checkout: 0.97, orders: 0.97, payments: 1, cart, conns: 0, capacity, down: true };
  const others = ordersDemand + paymentsDemand;
  let checkout, starved = 0.002, locked = 0;
  if (!checkoutPods.length) checkout = 1;
  else {
    const available = Math.max(0, capacity - others);
    const overflow = Math.max(0, held - available);
    // Pods that already hold what they need only fail when a recycled connection cannot be
    // reopened; pods that are still asking for connections queue behind the acquire timeout.
    checkout = !overflow ? 0.002 : Math.min(0.97, 0.002 + 2.9 * overflow / held);
    starved = checkout;
    // Submits for the same orders queue behind the stuck sessions' row locks and time out.
    locked = Math.min(0.07, 0.0011 * checkoutPods.reduce((a, p) => a + (p.stuck ?? 0), 0));
    checkout = Math.min(0.97, checkout + locked);
    // A pod restarting after an OOM kill serves nothing, and the rest take its traffic.
    const down = checkoutPods.filter(p => !p.ready && !p.terminating).length / checkoutPods.length;
    checkout = Math.min(0.97, checkout + 0.7 * down);
  }
  checkout = Math.min(1, checkout + 0.5 * (cart - 0.002));
  const overflow = Math.max(0, demand - capacity);
  const orders = ordersPods.length ? Math.min(0.9, 0.001 + Math.max(0, overflow - 60) / 400) : 1;
  const payments = !iam ? 1 : paymentPods.length ? 0.001 : 1;
  return { checkout: round(checkout), starved: round(starved), locked: round(locked), orders: round(orders), payments, cart, conns: Math.min(demand, capacity), capacity, down: false };
}
/** When a leaking pod runs out of memory at this traffic: a few minutes after it starts, give or take. */
const leakLife = (v, p) => v.leakAge + (hashString(p.name) % 45);
const upSince = (p) => p.upSince ?? p.readyAt ?? p.born;
function hooksFor(ctx) {
  const v = ctx.state.variant;
  return {
    cpu(context, ns, name) {
      if (context !== PROD) return { 'checkout-api': 18, 'cart-api': 9, 'orders-api': 14, 'payments-worker': 6 }[name] ?? 5;
      const m = metrics(ctx.state, ctx.t);
      if (name === 'checkout-api') {
        const leaking = running(dep(ctx.state, 'checkout', 'checkout-api')).some(p => p.image.endsWith(`:${v.leak}`));
        return Math.max(20, Math.min(150, 42 + 95 * m.checkout + (leaking ? 14 : 0)));
      }
      if (name === 'orders-api') return 38 + 40 * m.orders;
      if (name === 'cart-api') return 31;
      return 22;
    },
    memory(context, ns, p) {
      if (context === PROD && p.image.endsWith(`:${v.leak}`) && p.ready) return 190 + 318 * Math.min(1, (ctx.t - upSince(p)) / leakLife(v, p));
      return undefined;
    },
    logs(context, ns, pod, opts) { return podLogs(ctx, context, ns, pod, opts); },
  };
}
/**
 * The feature flag, as every pod reads it half a minute after it changes. Turning it off under
 * v3.9.0 strands a few in-flight idempotency transactions on each pod: pgx never returns a
 * connection whose transaction the code abandoned, so they sit idle in transaction.
 */
function readFlags(ctx) {
  const state = ctx.state, f = state.flags.find(x => x.key === state.variant.flag);
  if (!f.pending || f.pending.at > ctx.t) return;
  const live = f.pending.enabled;
  f.pending = null;
  if (live === state.flagLive) return;
  state.flagLive = live;
  if (!live) { state.flagOffAt = ctx.t; for (const p of running(dep(state, 'checkout', 'checkout-api'))) if (p.image.endsWith(':v3.9.0') && p.ready) p.stuck = 2 + (hashString(p.name) % 3); }
}
/** The leaking release: at peak traffic each pod is OOM-killed a few minutes after it starts. */
function leak(ctx) {
  const v = ctx.state.variant, t = ctx.t;
  for (const p of running(dep(ctx.state, 'checkout', 'checkout-api'))) {
    if (p.crash && p.crashUntil <= t) p.crash = undefined;
    if (!p.ready && p.downUntil && p.downUntil <= t && !p.terminating) { p.ready = true; p.readyAt = t; p.downUntil = undefined; }
    if (!p.image.endsWith(`:${v.leak}`) || !p.ready || p.terminating) continue;
    if (t - upSince(p) >= leakLife(v, p)) {
      p.restarts++; p.lastStarted = upSince(p); p.lastRestart = t; p.lastReason = 'OOMKilled'; p.lastExit = 137;
      p.ready = false; p.crash = 'OOMKilled'; p.crashUntil = t + 10; p.downUntil = t + 25; p.upSince = t + 25; p.stuck = 0;
      ctx.state.ooms++;
    }
  }
}
/** A teammate's pipeline ships cart-api in the middle of the incident, unless prod is frozen. */
function pipeline(ctx) {
  const v = ctx.state.variant, t = ctx.t, state = ctx.state;
  if (t === v.ciAt - 90) rollOut(ctx, STAGING, 'checkout', 'cart-api', cartContainers(v.cart, 'quillmart-staging'), `deploy ${v.cart} (ci #${v.ciBuild})`);
  if (t === v.ciAt) {
    const entry = { id: `dep_${hex(hashString(`ci${v.ciBuild}`), 12)}`, service: 'cart-api', env: 'prod', version: v.cart, pipeline: `ci #${v.ciBuild}`, triggered_by: 'marco.ruiz@quillmart.com', commit: hex(hashString(`cart${v.cart}`), 7), started: t, finished: null, status: 'in_progress', note: 'Bump go-redis to 9.5.1' };
    if (state.freeze) { entry.status = 'blocked'; entry.finished = t; entry.note = `blocked: prod is frozen (${state.freeze.reason})`; }
    else rollOut(ctx, PROD, 'checkout', 'cart-api', cartContainers(v.cart, 'quillmart-prod'), `deploy ${v.cart} (ci #${v.ciBuild})`);
    state.deploys.unshift(entry);
    ctx.event('ci.deploy', { service: 'cart-api', version: v.cart, status: entry.status });
  }
  const live = state.deploys.find(d => d.status === 'in_progress');
  if (live) {
    const d = dep(state, 'checkout', 'cart-api');
    if (d && d.pods.every(p => p.ready && !p.terminating && p.image.endsWith(`:${live.version}`)) && d.pods.length >= d.replicas) { live.status = 'succeeded'; live.finished = t; }
  }
}
function step(ctx) {
  readFlags(ctx);
  pipeline(ctx);
  kubeTick(ctx, hooksFor(ctx));
  leak(ctx);
  const m = metrics(ctx.state, ctx.t);
  ctx.state.samples.push({ t: ctx.t, ...m });
  // Liveness probes time out on pods stuck waiting for connections, so they restart now and then.
  if (m.checkout > 0.3 && ctx.t % 90 === 0) {
    const pods = running(dep(ctx.state, 'checkout', 'checkout-api')).filter(p => p.ready);
    if (pods.length) { const p = pods[hashString(`${ctx.t}`) % pods.length]; p.restarts++; p.lastStarted = upSince(p); p.lastRestart = ctx.t; p.lastReason = 'Error'; p.lastExit = 2; p.stuck = 0; }
  }
}
/** The estate if nobody touched anything for five more minutes: where the operator left it. */
function settle(ctx, seconds = 300) {
  const shadow = { state: structuredClone(ctx.state), t: ctx.t, events: [], at: ctx.at, now: ctx.now, event(kind, detail = {}) { shadow.events.push({ t: shadow.t, kind, ...detail }); } };
  shadow.wait = () => {};
  const end = ctx.t + seconds;
  // Steps land on the same ten-second marks as the session's own.
  while (shadow.t < end) { shadow.t = Math.floor(shadow.t / 10) * 10 + 10; step(shadow); }
  return shadow;
}

// ---------- what the tools show ----------

const sampleAt = (state, t) => {
  const s = state.samples;
  const k = s.findLastIndex(x => x.t <= t);
  return s[Math.max(0, k)];
};
const iso = (ctx, t, ms = 0) => new Date(ctx.at(t).getTime() + ms).toISOString();
const hex = (n, len) => { let out = ''; for (let k = 0; out.length < len; k++) out += (hashString(`${n}:${k}`) >>> 0).toString(16).padStart(8, '0'); return out.slice(0, len); };
function podLogs(ctx, context, ns, pod, { container, previous, since }) {
  const name = pod.deployment.name;
  const prod = context === PROD;
  const end = previous ? pod.lastRestart : ctx.t;
  const begin = previous ? Math.max(pod.born, pod.lastRestart - 95) : Math.max(pod.lastRestart ?? pod.born, since ? ctx.t - since : -Infinity);
  const out = [];
  const version = pod.image.split(':').pop();
  const pool = Number(pod.env.DB_POOL_SIZE ?? 10);
  const started = (pod.lastRestart ?? pod.born) >= begin && !previous;
  if (container === 'cloud-sql-proxy') {
    const d = ctx.at(pod.born + 2);
    const stampOf = (t) => ctx.at(t).toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '/');
    if (pod.born >= begin) out.push(`${stampOf(pod.born + 2)} Authorizing with Application Default Credentials`, `${stampOf(pod.born + 2)} [${prod ? 'quillmart-prod' : 'quillmart-staging'}:us-central1:core-pg] Listening on 127.0.0.1:5432`, `${stampOf(pod.born + 3)} The proxy has started successfully and is ready for new connections!`);
    void d;
    for (let t = Math.ceil(begin / 60) * 60; t <= end; t += 60) {
      if (prod && dbDown(ctx.state, t)) out.push(`${stampOf(t)} [quillmart-prod:us-central1:core-pg] failed to connect to instance: Dial error: failed to dial (connection name = "quillmart-prod:us-central1:core-pg"): dial tcp 10.84.0.3:3307: connect: connection refused`);
    }
    return out;
  }
  const line = (t, fields) => JSON.stringify({ level: fields.level ?? 'info', ts: iso(ctx, t, (hashString(`${pod.name}${t}`) % 997)), caller: fields.caller, msg: fields.msg, ...Object.fromEntries(Object.entries(fields).filter(([k]) => !['level', 'caller', 'msg'].includes(k))) });
  const logfmt = (t, text) => `ts=${iso(ctx, t, hashString(`${pod.name}${t}`) % 997)} ${text}`;
  if (started) {
    const t0 = pod.lastRestart ?? pod.born;
    if (name === 'checkout-api') {
      const flag = ctx.state.variant.flag;
      out.push(line(t0 + 3, { caller: 'cmd/server/main.go:61', msg: 'starting checkout-api', version, commit: hex(hashString(`build${version}`), 7) }), line(t0 + 3, { caller: 'internal/db/pool.go:44', msg: 'db pool configured', max_conns: pool, min_idle: Math.min(10, pool), max_conn_idle_time: '30m0s', acquire_timeout: '5s' }));
      if (version === 'v3.9.0') out.push(line(t0 + 3, { caller: 'internal/flags/client.go:52', msg: 'flags loaded', source: 'http://flags.internal.quillmart.com', refresh: '30s', [flag]: prod ? ctx.state.flagLive : true }));
      out.push(line(t0 + 4, { caller: 'cmd/server/main.go:97', msg: 'listening', addr: ':8080' }));
    }
    if (name === 'cart-api') out.push(line(t0 + 3, { caller: 'main.go:40', msg: 'starting cart-api', version }));
    if (name === 'orders-api') out.push(logfmt(t0 + 3, `level=info msg="orders-api starting" version=v5.2.1 pool=20`));
    if (name === 'payments-worker') out.push(logfmt(t0 + 3, `level=info msg="payments-worker starting" version=v1.9.3 subscription=payments-capture`));
  }
  const first = Math.ceil(Math.max(begin, (pod.lastRestart ?? pod.born) + 5) / 3) * 3;
  for (let t = first; t <= end; t += 3) {
    const s = prod ? sampleAt(ctx.state, t) : { checkout: 0.002, orders: 0.001, payments: 0.001, cart: 0.002, down: false };
    const roll = (hashString(`${pod.name}|${t}`) % 10000) / 10000;
    const trace = hex(hashString(`${pod.name}${t}trace`), 32);
    if (name === 'checkout-api' && prod && version === ctx.state.variant.leak && t % 30 === 0) {
      const since = pod.upSince ?? pod.readyAt ?? pod.born;
      out.push(line(t, { level: 'warn', caller: 'internal/cartclient/pool.go:77', msg: 'cart client pool above high-water mark', open_conns: 180 + Math.round((t - since) * 4.6), idle: 12, high_water: 256 }));
    }
    if (name === 'checkout-api') {
      // A pod only logs its own failures: connections it could not get, or cart-api failing it.
      // Requests lost to a pod being OOM-killed fail at the load balancer, not here.
      const err = s.starved ?? s.checkout;
      if (roll >= err && roll < err + Math.max(0, (s.cart ?? 0.002) - 0.002) * 0.5) {
        out.push(line(t, { level: 'error', caller: 'internal/cartclient/client.go:118', msg: 'load cart', status: 500, error: 'cart-api: GET /v1/cart: 500 Internal Server Error', trace_id: trace }));
        continue;
      }
      if (roll >= err && roll < err + (s.locked ?? 0)) {
        out.push(line(t, { level: 'error', caller: 'internal/http/log.go:31', msg: 'request failed', method: 'POST', route: '/v1/checkout/submit', status: 503, duration_ms: 5001 + (hashString(`${t}k`) % 9), trace_id: trace, error: 'orders: update status: timeout: context deadline exceeded (waiting for lock on orders row)' }));
        continue;
      }
      if (roll < err) {
        const reason = s.down ? 'failed to connect to `host=127.0.0.1 user=checkout database=core`: dial error (dial tcp 127.0.0.1:5432: connect: connection refused)' : 'failed to connect to `host=127.0.0.1 user=checkout database=core`: server error (FATAL: sorry, too many clients already (SQLSTATE 53300))';
        out.push(line(t, { level: 'error', caller: 'internal/db/pool.go:131', msg: 'acquire connection', pool_max: pool, in_use: pool, waiting: 12 + (hashString(`${t}w`) % 60), error: reason }));
        out.push(line(t + 1, { level: 'error', caller: 'internal/http/log.go:31', msg: 'request failed', method: 'POST', route: '/v1/checkout/submit', status: 503, duration_ms: 5001 + (hashString(`${t}d`) % 9), trace_id: trace, error: 'db: acquire conn: context deadline exceeded' }));
      } else {
        const submit = roll > 0.55;
        out.push(line(t, { caller: 'internal/http/log.go:27', msg: 'request', method: submit ? 'POST' : 'GET', route: submit ? '/v1/checkout/submit' : '/v1/checkout/quote', status: 200, duration_ms: (submit ? 140 : 35) + (hashString(`${t}l`) % (err > 0.05 ? 2400 : 120)), trace_id: trace }));
      }
    } else if (name === 'cart-api') {
      if (roll < s.cart) out.push(line(t, { level: 'error', caller: 'session/codec.go:88', msg: 'load guest cart', error: 'session: decode: unexpected EOF', trace_id: trace }));
      else out.push(line(t, { caller: 'http/log.go:22', msg: 'request', method: 'GET', route: '/v1/cart', status: 200, duration_ms: 6 + (hashString(`${t}c`) % 30) }));
    } else if (name === 'orders-api') {
      if (roll < s.orders) out.push(logfmt(t, `level=error msg="query failed" route=/v1/orders/{id} err="${s.down ? 'dial tcp 127.0.0.1:5432: connect: connection refused' : 'FATAL: sorry, too many clients already (SQLSTATE 53300)'}" trace=${trace}`));
      else out.push(logfmt(t, `level=info msg=request route=/v1/orders/{id} status=200 dur=${9 + (hashString(`${t}o`) % 40)}ms trace=${trace}`));
    } else if (name === 'payments-worker' && t % 6 === 0) {
      const inst = instanceOf(ctx.state);
      if (prod && inst?.flags?.['cloudsql.iam_authentication'] !== 'on' && !s.down) out.push(logfmt(t, `level=error msg="capture failed" order=ord_${hex(hashString(`${t}p`), 10)} err="failed to connect to \`host=127.0.0.1 user=payments-worker@quillmart-prod.iam database=core\`: server error (FATAL: Cloud SQL IAM user authentication failed for user \\"payments-worker@quillmart-prod.iam\\" (SQLSTATE 28000))"`));
      else if (s.down) out.push(logfmt(t, `level=error msg="capture failed" order=ord_${hex(hashString(`${t}p`), 10)} err="dial tcp 127.0.0.1:5432: connect: connection refused"`));
      else out.push(logfmt(t, `level=info msg="capture ok" order=ord_${hex(hashString(`${t}p`), 10)} amount_cents=${1200 + (hashString(`${t}a`) % 18000)}`));
    }
  }
  if (previous) out.push(line(end - 1, { level: 'warn', caller: 'cmd/server/main.go:120', msg: 'shutting down', signal: 'terminated' }));
  return out;
}
function logEntries(ctx, filter, { limit, freshness }, project) {
  const context = project === 'quillmart-staging' ? STAGING : project === 'quillmart-prod' ? PROD : null;
  if (!context) return [];
  const entries = [];
  const since = Math.min(freshness, 1800);
  for (const [nsName, ns] of Object.entries(ctx.state.kube.contexts[context].namespaces)) {
    for (const d of ns.deployments ?? []) {
      if (d.deleted) continue;
      for (const pod of d.pods.filter(p => p.phase === 'Running').slice(0, 8)) {
        const podView = { ...pod, deployment: d };
        for (const text of podLogs(ctx, context, nsName, podView, { container: d.name, since })) {
          const json = text.startsWith('{') ? JSON.parse(text) : null;
          const ts = json ? json.ts : text.slice(3, text.indexOf(' '));
          const severity = json ? json.level.toUpperCase().replace('WARN', 'WARNING') : /level=error/.test(text) ? 'ERROR' : 'INFO';
          entries.push({ insertId: hex(hashString(text), 16), ...(json ? { jsonPayload: json } : { textPayload: text }), labels: { 'compute.googleapis.com/resource_name': pod.node, 'k8s-pod/app': d.name, 'k8s-pod/pod-template-hash': pod.hash }, logName: `projects/${project}/logs/${severity === 'ERROR' ? 'stderr' : 'stdout'}`, receiveTimestamp: ts, resource: { labels: { cluster_name: context === PROD ? 'prod-usc1' : 'staging-usc1', container_name: d.name, location: 'us-central1', namespace_name: nsName, pod_name: pod.name, project_id: project }, type: 'k8s_container' }, severity, timestamp: ts });
        }
      }
    }
  }
  return entries.filter(e => matchesFilter(e, filter)).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, limit);
}
function sloBody(ctx, service) {
  const known = { 'checkout-api': 'checkout', 'orders-api': 'orders', 'payments-worker': 'payments', 'cart-api': 'cart' };
  if (!known[service]) return null;
  const key = known[service];
  const window = (seconds) => { const xs = ctx.state.samples.filter(s => s.t > ctx.t - seconds && s.t <= ctx.t); return xs.reduce((a, s) => a + s[key], 0) / Math.max(1, xs.length); };
  const e1 = window(60), e5 = window(300), e60 = window(3600);
  const objective = service === 'payments-worker' ? 0.995 : 0.999;
  const rps = { checkout: RATE, orders: 210, payments: 64, cart: 480 }[key];
  const status = e5 > (1 - objective) * 10 ? 'BREACHING' : e5 > (1 - objective) * 2 ? 'AT_RISK' : 'OK';
  return { service, env: 'prod', objective, window: '30d', requests_per_s: rps, error_rate_1m: round(e1), error_rate_5m: round(e5), p99_ms: Math.round(key === 'checkout' ? 240 + 4800 * Math.min(1, e1 * 1.5) : 60 + 3000 * Math.min(1, e1 * 1.5)), burn_rate_1h: Math.round((e60 / (1 - objective)) * 10) / 10, status, as_of: ctx.now().toISOString().replace(/\.\d+Z$/, 'Z') };
}

// ---------- the database ----------

function buildDatabase(start) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, account_id BIGINT NOT NULL, status TEXT NOT NULL, total_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', created_at TIMESTAMPTZ NOT NULL, idempotency_key TEXT);
    CREATE TABLE payments (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), status TEXT NOT NULL, amount_cents INTEGER NOT NULL, captured_at TIMESTAMPTZ);
    CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL);`);
  const r = seeded(4412);
  const insert = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?)');
  const pay = db.prepare('INSERT INTO payments VALUES (?, ?, ?, ?, ?)');
  const at = (t) => stamp(start + t * 1000);
  for (let k = 0; k < 600; k++) {
    const t = -6 * 3600 + k * 36;
    const id = `ord_${hex(hashString(`o${k}`), 10)}`;
    const total = 1500 + Math.floor(r() * 18000);
    const status = t > -300 ? 'pending_payment' : r() < 0.97 ? 'paid' : 'cancelled';
    insert.run(id, 100000 + Math.floor(r() * 900000), status, total, 'USD', at(t), t >= DEPLOYED ? `idk_${hex(hashString(`i${k}`), 24)}` : null);
    if (status === 'paid') pay.run(`pay_${hex(hashString(`p${k}`), 10)}`, id, 'captured', total, at(t + 20));
  }
  const mig = db.prepare('INSERT INTO schema_migrations VALUES (?, ?)');
  mig.run('0055', at(-DAY * 20)); mig.run('0056', at(-DAY * 9)); mig.run('0057', at(-8400));
  return db;
}
function dbFingerprint(db) {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const content = {};
  for (const t of tables.filter(x => x.sql && /^CREATE TABLE/i.test(x.sql))) {
    try { content[t.name] = { columns: db.prepare(`PRAGMA table_info("${t.name}")`).all().map(c => c.name).join(','), rows: db.prepare(`SELECT count(*) AS n FROM "${t.name}"`).get().n, hash: hashString(JSON.stringify(db.prepare(`SELECT * FROM "${t.name}" ORDER BY 1`).all())) }; } catch { /* catalog tables */ }
  }
  return { tables: tables.map(t => t.name), content };
}

// ---------- git history ----------

const h7 = (text) => hex(hashString(`blob${text}`), 7);
/** One file's change as git prints it, computed from the two versions so every diff applies. */
function fileDiff(path, before, after) {
  if (before === after) return '';
  if (before === null) return [`diff --git a/${path} b/${path}`, 'new file mode 100644', `index 0000000..${h7(after)}`, ...unifiedDiff([], lines(after), '/dev/null', `b/${path}`)].join('\n');
  return [`diff --git a/${path} b/${path}`, `index ${h7(before)}..${h7(after)} 100644`, ...unifiedDiff(lines(before), lines(after), `a/${path}`, `b/${path}`)].join('\n');
}
/**
 * The checkout's history, newest first. Every earlier version of a file is derived from the one
 * in the checkout, so `git show`, `git log -p` and older trees all agree with what is on disk.
 */
function gitLog(v, initial) {
  const MAN = 'k8s/checkout/checkout-api/deployment.yaml', LOG = 'services/checkout-api/CHANGELOG.md', MIG = 'migrations/0057_orders_add_idempotency_key.sql', CART = 'k8s/checkout/cart-api/deployment.yaml', TF = 'terraform/cloudsql.tf';
  const m9 = initial[MAN];
  const mLeak = m9.replace(':v3.9.0', `:${v.leak}`).replace(/(name: DB_POOL_SIZE\n\s*value: )"40"/, '$1"15"').replace(/\n\s*- name: IDEMPOTENCY_KEYS\n\s*value: "enabled"/, '');
  const m84 = mLeak.replace(`:${v.leak}`, ':v3.8.4');
  const m83 = m84.replace(':v3.8.4', ':v3.8.3');
  const c9 = initial[LOG];
  const cBack = c9.replace(/## v3\.9\.0\n[\s\S]*?\n(## )/, '$1');
  const cLeak = cBack.replace(/\nRolled back in INC-2284:[\s\S]*?\n\n/, '\n');
  const c84 = cLeak.replace(/## v3\.8\.\d+\n\n- Keep HTTP connections[\s\S]*?\n\n(## v3\.8\.4)/, '$1');
  const cart = initial[CART], cart14 = cart.replace(':v2.13.3', ':v2.14.0'), cart132 = cart.replace(':v2.13.3', ':v2.13.2');
  const tf = initial[TF], tfBefore = tf.replace(/\n    database_flags \{\n      name  = "log_min_duration_statement"\n      value = "1000"\n    \}/, '');
  const join = (...parts) => parts.filter(Boolean).join('\n');
  const dana = { author: 'Dana Whitfield', email: 'dana.whitfield@quillmart.com' }, marco = { author: 'Marco Ruiz', email: 'marco.ruiz@quillmart.com' }, priya = { author: 'Priya Nair', email: 'priya.nair@quillmart.com' };
  const sha = (subject) => hex(hashString(`commit ${subject} ${v.seed}`), 40);
  const commits = [
    { ...dana, t: DEPLOYED - 380, subject: 'checkout-api: release v3.9.0', body: `Idempotency keys on submit (needs 0057, behind ${v.flag}), a bigger DB pool to cut p99 at peak,\nand the cart-client leak fix from ${v.leak}.\n\nci #8870`, diff: join(fileDiff(MAN, mLeak, m9), fileDiff(LOG, cBack, c9)) },
    { ...dana, t: -8700, subject: 'migrations: 0057 add orders.idempotency_key (nullable)', diff: fileDiff(MIG, null, initial[MIG]) },
    { author: 'release-train[bot]', email: 'release-train@quillmart.com', t: -8 * 3600 - 1700, subject: `release train: checkout-api ${v.leak}`, body: `Promoted from staging after 24h soak.\n\nci #${v.trainBuild}`, diff: fileDiff(MAN, m84, mLeak) },
    { ...marco, t: -DAY - 21400, subject: 'cart-api: roll back to v2.13.3 (INC-2291, guest carts dropped)', diff: fileDiff(CART, cart14, cart) },
    { ...marco, t: -DAY - 30400, subject: 'cart-api: release v2.14.0', diff: fileDiff(CART, cart132, cart14) },
    { ...priya, t: -DAY * 3 - 3300, subject: 'terraform: log slow queries on core-pg', diff: fileDiff(TF, tfBefore, tf) },
    { ...priya, t: -DAY * 6 - 5400, subject: `checkout-api: roll back to v3.8.4 (INC-2284, ${v.leak} OOMKilled at peak)`, diff: join(fileDiff(MAN, mLeak, m84), fileDiff(LOG, cLeak, cBack)) },
    { ...dana, t: -DAY * 6 - 9300, subject: `checkout-api: release ${v.leak}`, body: 'ci #8812', diff: join(fileDiff(MAN, m84, mLeak), fileDiff(LOG, c84, cLeak)) },
    { ...dana, t: -DAY * 9 - 8100, subject: 'checkout-api: release v3.8.4', body: 'ci #8779', diff: fileDiff(MAN, m83, m84) },
  ];
  return commits.map(c => ({ sha: sha(c.subject), ...c }));
}

// ---------- the world ----------

export function createWorld({ home, fs, seed = 0 }) {
  const v = variant(seed);
  // The checkout names this seed's leaking release and flag; seed 0 is the checkout as shipped.
  if (v.seed) {
    for (const path of fs.list()) {
      const text = fs.read(path), next = text.replaceAll('v3.8.5', v.leak).replaceAll('checkout.idempotency_keys', v.flag)
        .replace('| orders-api | 10 | 20 | 200 |', `| orders-api | ${v.orders} | 20 | ${v.orders * 20} |`).replace('| payments-worker | 4 | 10 | 40 |', `| payments-worker | ${v.payments} | 10 | ${v.payments * 10} |`);
      if (next !== text) fs.write(path, next);
    }
  }
  const initial = Object.fromEntries(fs.list().map(p => [p, fs.read(p)]));
  const start = today('14:09:00');
  const origin = Date.parse(start);
  const state = buildState(v);
  const db = buildDatabase(origin);
  const baseline = dbFingerprint(db);
  let world;
  const programs = (ctx) => {
  db.function('pg_terminate_backend', (pid) => terminate(ctx, pid));
  db.function('pg_cancel_backend', () => 't');
  db.function('left', (text, n) => (text === null ? null : n < 0 ? String(text).slice(0, n) : String(text).slice(0, n)));
  db.function('right', (text, n) => (text === null ? null : n < 0 ? String(text).slice(-n) : String(text).slice(-n)));
  return {
    kubectl: makeKubectl(ctx, hooksFor(ctx)),
    gcloud: makeGcloud(ctx, {
      ...makeGkeGroups(ctx, {
        logs: (filter, opts) => logEntries(ctx, filter, opts, ctx.state.gcloud.project),
        dashboards: [{ name: 'projects/418392016653/dashboards/7f3c1e02-checkout', displayName: 'Checkout — golden signals' }, { name: 'projects/418392016653/dashboards/c1a09d44-core-pg', displayName: 'core-pg — connections & CPU' }],
      }),
      sql: sqlGroup(ctx),
      ...restricted(),
    }),
    psql: makePsql(ctx, {
      resolve({ host, dbname, user }) {
        if (!['127.0.0.1', 'localhost', '10.84.0.3'].includes(host)) return { error: `connection to server at "${host}", port 5432 failed: Connection timed out\n\tIs the server running on that host and accepting TCP/IP connections?`, wait: 30 };
        if (dbDown(ctx.state, ctx.t)) return { error: `connection to server at "${host}", port 5432 failed: Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?` };
        if (dbname !== 'core' && dbname !== 'postgres') return { error: `connection to server at "${host}", port 5432 failed: FATAL:  database "${dbname}" does not exist` };
        const inst = instanceOf(ctx.state);
        return {
          db, name: INSTANCE, settings: { max_connections: inst.flags.max_connections ?? '100', 'cloudsql.iam_authentication': inst.flags['cloudsql.iam_authentication'] ?? 'off', log_min_duration_statement: inst.flags.log_min_duration_statement ?? '-1' },
          activity: () => activity(ctx),
        };
        void user;
      },
    }),
    curl: makeCurl(ctx, {
      'slo.internal.quillmart.com/api/v1/services': () => ({ status: 200, body: `${JSON.stringify({ services: ['cart-api', 'checkout-api', 'orders-api', 'payments-worker'].map(s => { const b = sloBody(ctx, s); return { service: s, status: b.status, error_rate_5m: b.error_rate_5m }; }) }, null, 2)}\n` }),
      'slo.internal.quillmart.com': (req) => {
        const m = /^\/api\/v1\/services\/([\w-]+)\/?$/.exec(req.path);
        if (!m) return { status: 404, body: '{"error":"not found"}\n' };
        const body = sloBody(ctx, m[1]);
        return body ? { status: 200, body: `${JSON.stringify(body, null, 2)}\n` } : { status: 404, body: `{"error":"unknown service ${m[1]}"}\n` };
      },
      'checkout.quillmart.com': (req) => (req.path === '/healthz' ? { status: 200, body: 'ok\n' } : { status: 404, body: '{"error":"not found"}\n' }),
      'flags.internal.quillmart.com': (req) => flagsApi(ctx, req),
      'deploys.internal.quillmart.com': (req) => deploysApi(ctx, req),
      'grafana.internal.quillmart.com': () => ({ status: 302, body: '<a href="https://sso.quillmart.com/oauth2/start?rd=https%3A%2F%2Fgrafana.internal.quillmart.com%2F">Found</a>.\n\n', contentType: 'text/html; charset=utf-8', headers: ['location: https://sso.quillmart.com/oauth2/start?rd=https%3A%2F%2Fgrafana.internal.quillmart.com%2F'] }),
    }),
    ...((git) => ({ git, gh: git.gh }))(makeGit(ctx, { initial, remote: 'git@github.com:quillmart/infra.git', log: gitLog(v, initial) })),
  };
  };
  world = simulate({
    start, home, fs, state, programs,
    tick: step,
    hostname: 'qm-ops-7', user: 'jordan',
    env: { PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: 'oncall', PGDATABASE: 'core', CLOUDSDK_CORE_DISABLE_PROMPTS: '0', EDITOR: 'vi' },
    report: (ctx) => report(ctx, db, baseline),
  });
  return { exec: world.exec, report: world.report, repository: world.repository };
}
/** Groups this on-call account has no role in: gcloud answers with the API's permission error. */
function restricted() {
  const services = { compute: 'compute', run: 'run', pubsub: 'pubsub', iam: 'iam', redis: 'redis', secrets: 'secretmanager', artifacts: 'artifactregistry', builds: 'cloudbuild', deploy: 'clouddeploy', functions: 'cloudfunctions', dns: 'dns', storage: 'storage', scheduler: 'cloudscheduler' };
  return Object.fromEntries(Object.entries(services).map(([group, api]) => [group, (args, _io, g) => {
    const words = args.filter(a => /^[a-z][a-z-]*$/.test(a));
    const resource = (words[0] ?? group).replace(/-/g, '');
    const verb = words[1] === 'describe' ? 'get' : words[1] ?? 'list';
    return { err: [`ERROR: (gcloud.${[group, ...words.slice(0, 2)].join('.')}) PERMISSION_DENIED: Permission '${api}.${resource}.${verb}' denied on resource '//${api}.googleapis.com/projects/${g.project}' (or it may not exist). This command is authenticated as ${g.account} which is the active account specified by the [core/account] property.`], code: 1 };
  }]));
}
function activity(ctx) {
  const rows = [];
  const m = metrics(ctx.state, ctx.t);
  // A busy session's transaction began a moment ago; an idle one has none.
  const started = (k) => stamp(ctx.at(ctx.t).getTime() - 40 - (hashString(`x${k}`) % 900));
  const add = (app, user, n, active) => { for (let k = 0; k < n; k++) { const busy = k < active; rows.push({ pid: 20000 + rows.length * 7, usename: user, application_name: app, client_addr: '127.0.0.1', state: busy ? 'active' : 'idle', query: busy ? 'SELECT ... FROM orders WHERE ...' : 'COMMIT', xact_start: busy ? started(rows.length) : null }); } };
  const checkoutPods = running(dep(ctx.state, 'checkout', 'checkout-api'));
  const ordersPods = running(dep(ctx.state, 'orders', 'orders-api')).length;
  const payments = running(dep(ctx.state, 'payments', 'payments-worker')).length;
  const iam = instanceOf(ctx.state).flags['cloudsql.iam_authentication'] === 'on';
  // Sessions stuck in a transaction keep a stable pid, so a pid read now can be terminated later.
  const since = stamp(ctx.at(ctx.state.flagOffAt ?? ctx.t).getTime());
  const stuck = checkoutPods.flatMap(p => Array.from({ length: p.stuck ?? 0 }, (_, k) => ({ pid: 30000 + (hashString(p.name) % 5000) * 4 + k, usename: 'checkout', application_name: 'checkout-api', client_addr: '127.0.0.1', state: 'idle in transaction', query: 'SELECT id, status FROM orders WHERE idempotency_key = $1 FOR UPDATE', xact_start: since, state_change: since, wait_event_type: 'Client', wait_event: 'ClientRead', pod: p.name })));
  let budget = m.capacity - stuck.length;
  const ordersConns = Math.min(ordersPods * 20, budget); budget -= ordersConns;
  const paymentsConns = iam ? Math.min(payments * 10, budget) : 0; budget -= paymentsConns;
  const checkoutConns = Math.min(checkoutPods.reduce((s, p) => s + conns(ctx.state, p).want, 0), budget);
  add('checkout-api', 'checkout', checkoutConns, Math.round(checkoutConns * 0.9));
  // Submits for the same orders wait on the stuck sessions' locks.
  rows.filter(r => r.application_name === 'checkout-api' && r.state === 'active').slice(0, stuck.length * 2).forEach(r => Object.assign(r, { wait_event_type: 'Lock', wait_event: 'transactionid', query: 'UPDATE orders SET status = $1, idempotency_key = $2 WHERE id = $3' }));
  add('orders-api', 'orders', ordersConns, Math.round(ordersConns * 0.3));
  add('payments-worker', 'payments-worker@quillmart-prod.iam', paymentsConns, 2);
  rows.push(...stuck);
  ctx.state.lastActivity = rows;
  return rows;
}
/** `pg_terminate_backend(pid)`: a stuck session closes and releases its locks; anything else just reconnects. */
function terminate(ctx, pid) {
  const row = ctx.state.lastActivity.find(r => r.pid === Number(pid));
  if (!row) return 'f';
  if (row.state === 'idle in transaction' && row.pod) {
    const p = running(dep(ctx.state, 'checkout', 'checkout-api')).find(x => x.name === row.pod);
    if (p && p.stuck) p.stuck--;
    ctx.state.terminated = (ctx.state.terminated ?? 0) + 1;
  }
  row.pid = -1;
  return 't';
}
/** The flags service's catalogue: the release's flag, and others nobody should touch today. */
function flagCatalog(v) {
  const f = (key, enabled, description, owner, updated, by) => ({ key, enabled, description, owner, updated, updated_by: by, pending: null });
  return [
    f('cart.guest_checkout', true, 'Guests can check out without an account.', 'team-cart', -DAY * 41, 'marco.ruiz@quillmart.com'),
    f(v.flag, true, 'Idempotency keys on POST /v1/checkout/submit (checkout-api >= v3.9.0).', 'team-checkout', DEPLOYED - 400, 'dana.whitfield@quillmart.com'),
    f('checkout.new_tax_engine', false, 'Route tax calculation to tax-svc v2.', 'team-checkout', -DAY * 19, 'dana.whitfield@quillmart.com'),
    f('orders.async_confirmation', true, 'Send order confirmation emails from the outbox worker.', 'team-orders', -DAY * 66, 'aiko.tanaka@quillmart.com'),
    f('payments.3ds_v2', false, 'Use 3-D Secure 2 for card payments in the EU.', 'team-payments', -DAY * 8, 'priya.nair@quillmart.com'),
  ];
}
/** Every pipeline run the deploy log remembers, newest first. */
function deployLog(v) {
  const d = (service, version, t, by, pipeline, note, took = 190) => ({ id: `dep_${hex(hashString(`${service}${version}${t}`), 12)}`, service, env: 'prod', version, pipeline, triggered_by: by, commit: hex(hashString(`c${service}${version}${t}`), 7), started: t, finished: t + took, status: 'succeeded', note });
  return [
    d('checkout-api', 'v3.9.0', DEPLOYED - 120, 'dana.whitfield@quillmart.com', 'ci #8870', 'checkout-api: release v3.9.0', 240),
    d('checkout-api', v.leak, -8 * 3600 - 1620, 'release-train', `ci #${v.trainBuild}`, `release train: checkout-api ${v.leak}`),
    d('cart-api', 'v2.13.3', -DAY - 21500, 'marco.ruiz@quillmart.com', 'manual', 'rollback (INC-2291)', 95),
    d('cart-api', 'v2.14.0', -DAY - 30500, 'marco.ruiz@quillmart.com', 'ci #8790', 'cart-api: release v2.14.0'),
    d('orders-api', 'v5.2.1', -DAY * 6, 'aiko.tanaka@quillmart.com', 'ci #8702', 'orders-api: release v5.2.1'),
    d('checkout-api', 'v3.8.4', -DAY * 6 - 5300, 'priya.nair@quillmart.com', 'manual', `rollback (INC-2284): ${v.leak} OOMKilled at peak`, 95),
    d('checkout-api', v.leak, -DAY * 6 - 9200, 'dana.whitfield@quillmart.com', 'ci #8812', `checkout-api: release ${v.leak}`),
    d('payments-worker', 'v1.9.3', -DAY * 11, 'priya.nair@quillmart.com', 'ci #8611', 'payments-worker: release v1.9.3'),
  ];
}
/** The flags service's HTTP API. */
function flagsApi(ctx, req) {
  const state = ctx.state;
  const json = (status, body) => ({ status, body: `${JSON.stringify(body, null, 2)}\n` });
  const view = (f) => ({ key: f.key, enabled: f.enabled, description: f.description, owner: f.owner, updated_at: iso(ctx, f.updated).replace(/\.\d+Z$/, 'Z'), updated_by: f.updated_by });
  if (req.path === '/api/v1/flags' || req.path === '/api/v1/flags/') return req.method === 'GET' ? json(200, { flags: state.flags.map(view) }) : json(405, { error: 'method not allowed' });
  const m = /^\/api\/v1\/flags\/([\w.-]+)\/?$/.exec(req.path);
  if (!m) return json(404, { error: 'not found' });
  const f = state.flags.find(x => x.key === m[1]);
  if (!f) return json(404, { error: `flag ${m[1]} not found` });
  if (req.method === 'GET') return json(200, view(f));
  if (req.method !== 'PATCH' && req.method !== 'PUT' && req.method !== 'POST') return json(405, { error: 'method not allowed' });
  let body;
  try { body = JSON.parse(req.body ?? ''); } catch { return json(400, { error: 'invalid JSON body' }); }
  if (typeof body?.enabled !== 'boolean') return json(400, { error: 'body must be {"enabled": true|false}' });
  if (f.enabled !== body.enabled) {
    f.enabled = body.enabled; f.updated = ctx.t; f.updated_by = ctx.state.gcloud.account;
    // Pods poll every 30 seconds; the next poll after this change picks it up.
    if (f.key === state.variant.flag) f.pending = { enabled: body.enabled, at: Math.ceil((ctx.t + 1) / 30) * 30 };
    ctx.event('flag.change', { key: f.key, enabled: body.enabled });
  }
  return json(200, view(f));
}
/** The deploy log and the prod freeze. */
function deploysApi(ctx, req) {
  const state = ctx.state;
  const json = (status, body) => ({ status, body: `${JSON.stringify(body, null, 2)}\n` });
  const view = (d) => ({ id: d.id, service: d.service, env: d.env, version: d.version, status: d.status, pipeline: d.pipeline, triggered_by: d.triggered_by, commit: d.commit, started_at: iso(ctx, d.started).replace(/\.\d+Z$/, 'Z'), finished_at: d.finished === null ? null : iso(ctx, d.finished).replace(/\.\d+Z$/, 'Z'), description: d.note });
  if (req.path === '/api/v1/deploys' || req.path === '/api/v1/deploys/') {
    let list = state.deploys.filter(d => d.started <= ctx.t);
    if (req.query.env) list = list.filter(d => d.env === req.query.env);
    if (req.query.service) list = list.filter(d => d.service === req.query.service);
    return json(200, { deploys: list.slice(0, Number(req.query.limit) || 20).map(view) });
  }
  if (req.path === '/api/v1/freeze' || req.path === '/api/v1/freeze/') {
    const env = req.query.env ?? 'prod';
    if (req.method === 'GET') return json(200, { env, frozen: Boolean(state.freeze), ...(state.freeze ? { reason: state.freeze.reason, since: iso(ctx, state.freeze.t).replace(/\.\d+Z$/, 'Z'), by: state.freeze.by } : {}) });
    if (req.method === 'POST' || req.method === 'PUT') {
      let body = {};
      try { body = JSON.parse(req.body || '{}'); } catch { return json(400, { error: 'invalid JSON body' }); }
      if ((body.env ?? env) !== 'prod') return json(400, { error: 'only prod can be frozen' });
      if (!state.freeze) { state.freeze = { reason: String(body.reason ?? 'no reason given'), t: ctx.t, by: state.gcloud.account }; ctx.event('deploy.freeze', { frozen: true }); }
      return json(200, { env: 'prod', frozen: true, reason: state.freeze.reason, since: iso(ctx, state.freeze.t).replace(/\.\d+Z$/, 'Z'), by: state.freeze.by });
    }
    if (req.method === 'DELETE') { if (state.freeze) { state.freeze = null; ctx.event('deploy.freeze', { frozen: false }); } return json(200, { env: 'prod', frozen: false }); }
    return json(405, { error: 'method not allowed' });
  }
  return json(404, { error: 'not found' });
}

// ---------- the report ----------

function report(ctx, db, baseline) {
  const settled = settle(ctx);
  const samples = [...ctx.state.samples.filter(s => s.t >= 0), ...settled.state.samples.filter(s => s.t > ctx.t).map(s => ({ ...s, projected: true }))];
  let mitigatedAt = null;
  for (let k = samples.length - 1; k >= 0 && samples[k].checkout < 0.02; k--) mitigatedAt = samples[k].t;
  if (mitigatedAt !== null && samples[0]?.checkout < 0.02 && mitigatedAt === samples[0].t) mitigatedAt = 0;
  const lost = Math.round(samples.reduce((s, x) => s + x.checkout * RATE * 10, 0));
  const worst = (key, predicate = () => true) => samples.filter(predicate).reduce((m, s) => Math.max(m, s[key]), 0);
  const final = settled.state.samples.at(-1);
  const prodCheckout = dep(settled.state, 'checkout', 'checkout-api');
  const inst = instanceOf(ctx.state);
  const now = dbFingerprint(db);
  const downSamples = samples.filter(s => s.down);
  const failingMinutes = Math.round(samples.filter(s => s.checkout >= 0.02).length * 10 / 6) / 10;
  const ordersMinutes = Math.round(samples.filter(s => s.orders >= 0.01).length * 10 / 6) / 10;
  const paymentsFailed = Math.round(samples.reduce((a, x) => a + x.payments * 64 * 10, 0));
  const v = ctx.state.variant;
  const flag = ctx.state.flags.find(f => f.key === v.flag);
  return {
    variant: { seed: v.seed, good: v.good, leak: v.leak, leakRev: v.leakRev, flag: v.flag },
    impact: [
      { label: 'Checkouts failed', value: lost, unit: 'checkouts' },
      { label: 'Checkout failing', value: failingMinutes, unit: 'minutes' },
      { label: 'orders-api degraded', value: ordersMinutes, unit: 'minutes' },
      { label: 'Payments not captured', value: paymentsFailed, unit: 'captures' },
    ],
    ooms: settled.state.ooms,
    /** OOM kills in the five minutes after the session: pods still crash-looping. */
    oomsAfter: settled.state.ooms - ctx.state.ooms,
    leakAtEnd: Boolean(prodCheckout?.pods.some(p => !p.terminating && p.image.endsWith(`:${v.leak}`))),
    flagAtEnd: { enabled: flag.enabled, live: settled.state.flagLive },
    stuckAtEnd: prodCheckout ? prodCheckout.pods.filter(p => !p.terminating).reduce((a, p) => a + (p.stuck ?? 0), 0) : 0,
    context: ctx.state.kube.current,
    mitigatedAt,
    lostCheckouts: lost,
    final: final ? { checkout: final.checkout, orders: final.orders, payments: final.payments, cart: final.cart, down: final.down } : null,
    worstOrders: worst('orders'),
    worstPayments: worst('payments'),
    worstCart: worst('cart'),
    dbDownSeconds: downSamples.length * 10,
    checkoutAtEnd: prodCheckout ? { pool: [...new Set(prodCheckout.pods.filter(p => !p.terminating).map(p => p.env.DB_POOL_SIZE))], images: [...new Set(prodCheckout.pods.filter(p => !p.terminating).map(p => p.image.split(':').pop()))], replicas: prodCheckout.replicas } : null,
    flags: inst ? { ...inst.flags } : null,
    database: { unchanged: JSON.stringify(now) === JSON.stringify(baseline), before: baseline.content, after: now.content },
    samples: samples.filter((_, k) => k % 3 === 0).map(s => [s.t, s.checkout, s.orders, s.payments, s.cart, s.down ? 1 : 0, s.projected ? 1 : 0]),
  };
}
