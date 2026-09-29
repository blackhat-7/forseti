/**
 * Quillmart's storefront at the evening peak: a web of fourteen services behind a gateway and a
 * legacy auth proxy nobody owns. Checkout and search are slow and timing out.
 *
 * Two hours ago someone cut pricing-api's price-cache TTL from an hour to a minute so promotion
 * changes would show up faster (PRICE-812). They changed the ConfigMap in git, and, to be sure, set
 * the same value as an env override on the live Deployment by hand. The cache hit rate fell, so
 * price lookups that used to be answered by Redis now go to promo-engine, which has five pods and a
 * database that does not allow more. As traffic rose toward the peak, promo-engine saturated, and
 * three layers of retries (web-bff → checkout, checkout → pricing, pricing → promo-engine, the last
 * multiplied by the mesh's own retries) turned a slow leaf into an outage two hops away from where
 * the alerts fire. The only thing still holding half of it up is a cron on a forgotten VM that
 * warms the 5,000 hottest prices every minute with a 15-minute TTL.
 *
 * The fix is to put the TTL back where it takes effect: the flag override (which wins over
 * everything, within 30 seconds) or the Deployment's env override (a rollout). Editing only the
 * ConfigMap does nothing, because the env override wins. Cutting retries at the mesh or adding
 * promo-engine pods (up to what its database allows, past its HPA's max) helps. What makes it
 * worse: scaling the callers (more retries in flight), flushing or failing over Redis (every price
 * becomes a miss), raising timeouts, killing the "unknown" VM (its warm keys expire over the next
 * fifteen minutes), touching the auth proxy, blaming the recommendations release that lands in the
 * middle of it, or tidying up the refunds consumer nobody documented.
 */
import { simulate, today, seeded, table, age } from './ops/world.mjs';
import { makeKubectl, kubeTick, kubeState, deployment, hpa, service, container, configmap, rollOut, hashString } from './ops/kubectl.mjs';
import { makeGcloud } from './ops/gcloud.mjs';
import { makeGkeGroups, matchesFilter } from './ops/gcloud-gke.mjs';
import { makeCurl } from './ops/curl.mjs';
import { makeGit } from './ops/git.mjs';
import { meshStep, traces, promql, PromError, withIstio } from './ops/mesh.mjs';
import { yaml as kyaml } from './ops/kubectl.mjs';

export const directory = 'quillmart-platform';
export const PROD = 'gke_quillmart-prod_us-central1_prod-usc1';
const PROJECT = 'quillmart-prod';
const REGISTRY = 'us-central1-docker.pkg.dev/quillmart-prod/services';
const DAY = 86400;
/** The budget a checkout or search request has: p99 in milliseconds, and the error rate. */
export const SLO = { checkout: { p99: 1200, err: 0.01 }, search: { p99: 800, err: 0.01 } };
const ORIGINAL_TTL = 3600;
/** Share of price lookups that miss the cache at a TTL, before the warmer's help. */
export const missBase = (ttl) => Math.min(0.65, 0.03 * (3600 / Math.max(1, ttl)) ** 0.65);

/**
 * What differs between variants: the TTL someone chose, promo-engine's size, names and versions.
 * Each variant's promo-engine is sized so the peak lands it just past saturation with the warmer
 * still running, which keeps the problem the same while its numbers move.
 */
export function variant(seed) {
  const v = [
    { ttl: 60, ticket: 'PRICE-812', author: ['Nadia Farouk', 'nadia.farouk'], promoPods: 5, vm: 'pricing-warmer-1', ip: '10.52.14.9', recs: ['v2.6.4', 'v2.7.0'], pipeline: 48213, flagNote: 'Refresh promo prices faster' },
    { ttl: 45, ticket: 'PRICE-790', author: ['Tomas Lindqvist', 'tomas.lindqvist'], promoPods: 6, vm: 'price-cache-warmer', ip: '10.52.9.14', recs: ['v3.1.2', 'v3.2.0'], pipeline: 51877, flagNote: 'Promo prices lag behind merchandising' },
    { ttl: 50, ticket: 'PRICE-837', author: ['Grace Oyelaran', 'grace.oyelaran'], promoPods: 4, vm: 'warm-pricing-01', ip: '10.52.20.31', recs: ['v1.19.3', 'v1.20.0'], pipeline: 50934, flagNote: 'Flash-sale prices should show within 2 minutes' },
  ][((seed % 3) + 3) % 3];
  const load = 900 + 110 * 3;
  v.promoPerPod = Math.round(load * missBase(v.ttl) * 0.5 / (v.promoPods * 0.88));
  // promo-pg allows this many promo-engine pods at 20 connections each; more pods fail to connect.
  v.promoDbPods = v.promoPods + 1;
  return v;
}

// ---------- the graph ----------

function meshSpec(v) {
  const S = (ns, perPod, baseMs, extra = {}) => ({ ns, perPod, baseMs, ...extra });
  return {
    services: {
      'edge-gateway': S('edge', 900, 1.5, { version: 'envoy-1.29.4', lang: 'cpp' }),
      'legacy-auth-proxy': S('platform', 700, 2, { version: '0.9.14', lang: 'go' }),
      'web-bff': S('web', 220, 8, { concurrency: 64, version: 'v8.3.1', lang: 'nodejs' }),
      'search-api': S('search', 160, 22, { concurrency: 48, version: 'v5.14.0', lang: 'java' }),
      'checkout-api': S('checkout', 40, 35, { concurrency: 32, version: 'v3.11.2', lang: 'go' }),
      'cart-api': S('cart', 200, 6, { version: 'v2.15.1', lang: 'go' }),
      'inventory-api': S('inventory', 200, 9, { version: 'v4.2.0', lang: 'go' }),
      'recs-api': S('recs', 300, 30, { version: v.recs[0], lang: 'python' }),
      'pricing-api': S('pricing', 250, 3, { concurrency: 80, version: 'v6.4.1', lang: 'go' }),
      'promo-engine': S('promo', v.promoPerPod, 25, { sheds: true, version: 'v1.33.0', lang: 'java' }),
    },
    edges: [
      { from: 'edge-gateway', to: 'legacy-auth-proxy', calls: 1, appTimeoutMs: 15000, appRetries: 0 },
      { from: 'legacy-auth-proxy', to: 'web-bff', calls: 1, appTimeoutMs: 15000, appRetries: 0 },
      { from: 'web-bff', to: 'checkout-api', calls: 110 / 1010, appTimeoutMs: 8000, appRetries: 1 },
      { from: 'web-bff', to: 'search-api', calls: 900 / 1010, appTimeoutMs: 3000, appRetries: 1 },
      // search-api calls pricing by a hardcoded load-balancer IP, so the mesh never sees that call.
      { from: 'search-api', to: 'pricing-api', calls: 1, appTimeoutMs: 800, appRetries: 2, bypassMesh: true },
      { from: 'search-api', to: 'recs-api', calls: 1, appTimeoutMs: 80, appRetries: 0, optional: true },
      { from: 'checkout-api', to: 'pricing-api', calls: 3, appTimeoutMs: 2000, appRetries: 3 },
      { from: 'checkout-api', to: 'cart-api', calls: 1, appTimeoutMs: 1000, appRetries: 1 },
      { from: 'checkout-api', to: 'inventory-api', calls: 1, appTimeoutMs: 1000, appRetries: 1 },
      { from: 'pricing-api', to: 'promo-engine', calls: 'miss', appTimeoutMs: 400, appRetries: 1 },
    ],
    journeys: [
      { name: 'checkout', path: ['edge-gateway', 'legacy-auth-proxy', 'web-bff'], target: 'checkout-api', rps: 110, timeoutMs: 15000 },
      { name: 'search', path: ['edge-gateway', 'legacy-auth-proxy', 'web-bff'], target: 'search-api', rps: 900, timeoutMs: 15000 },
    ],
    vs: [
      { name: 'checkout-api', ns: 'checkout', host: 'checkout-api.checkout.svc.cluster.local', service: 'checkout-api', timeoutMs: 10000, retries: 1, perTryTimeoutMs: 4000, created: -DAY * 400, generation: 3, uid: 'a1c9e0f2-7b41-4c1e-9d0e-5f3a2b8c1d44' },
      { name: 'search-api', ns: 'search', host: 'search-api.search.svc.cluster.local', service: 'search-api', timeoutMs: 2000, retries: 2, perTryTimeoutMs: 1000, created: -DAY * 380, generation: 5, uid: 'b7d2f1a0-3e8c-4b9a-8f21-0c6d9e4a7b13' },
      { name: 'pricing-api', ns: 'pricing', host: 'pricing-api.pricing.svc.cluster.local', service: 'pricing-api', timeoutMs: 1500, retries: 2, perTryTimeoutMs: 500, created: -DAY * 410, generation: 4, uid: 'c3e8a5b1-9f2d-4a7e-b6c0-1d4f8e2a9c57' },
      { name: 'promo-engine', ns: 'promo', host: 'promo-engine.promo.svc.cluster.local', service: 'promo-engine', timeoutMs: 1000, retries: 1, perTryTimeoutMs: 300, created: -DAY * 300, generation: 2, uid: 'd9f4b2c6-1a7e-4e3b-a8d5-6c2e0f9b1a38' },
    ],
    dr: [
      { name: 'promo-engine', ns: 'promo', host: 'promo-engine.promo.svc.cluster.local', created: -DAY * 300, policy: { connectionPool: { http: { http1MaxPendingRequests: 100, maxRequestsPerConnection: 50 } }, outlierDetection: { consecutive5xxErrors: 20, interval: '30s', baseEjectionTime: '30s' } } },
      { name: 'pricing-api', ns: 'pricing', host: 'pricing-api.pricing.svc.cluster.local', created: -DAY * 410, policy: { loadBalancer: { simple: 'LEAST_REQUEST' } } },
    ],
    routes: {},
  };
}
const SPAN_OPS = { 'edge-gateway': 'ingress', 'legacy-auth-proxy': 'auth.verify', 'web-bff': 'POST /api/checkout', 'checkout-api': 'CheckoutService/PlaceOrder', 'search-api': 'GET /v2/search', 'pricing-api': 'PriceService/GetPrices', 'promo-engine': 'PromoService/Evaluate', 'cart-api': 'CartService/GetCart', 'inventory-api': 'InventoryService/Reserve', 'recs-api': 'GET /recs/related' };

// ---------- the cluster ----------

const img = (name, version) => `${REGISTRY}/${name}:${version}`;
function namespaces(v) {
  const d = (name, replicas, version, env = [], extra = {}) => deployment({ name, replicas, created: -DAY * (200 + name.length * 13), history: extra.history ?? [
    { containers: [container({ name, image: img(name, extra.prev ?? version), env, envFrom: extra.envFrom ?? [], cpu: extra.cpu ?? '500m', memory: extra.memory ?? '512Mi' })], cause: null, t: -DAY * (20 + name.length) },
    { containers: [container({ name, image: img(name, version), env, envFrom: extra.envFrom ?? [], cpu: extra.cpu ?? '500m', memory: extra.memory ?? '512Mi' })], cause: extra.cause ?? null, t: -DAY * (3 + (name.length % 5)) - 3600 * (name.length % 7) },
  ] });
  const ttlSet = -2 * 3600 - 17 * 60;
  const pricingEnv = [['PROMO_ADDR', 'promo-engine.promo.svc.cluster.local:8080'], ['PROMO_TIMEOUT_MS', '400'], ['PROMO_RETRIES', '1'], ['REDIS_ADDR', '10.30.0.5:6379'], ['FLAGS_URL', 'http://flags.flags.svc.cluster.local']];
  const pricing = deployment({ name: 'pricing-api', replicas: 10, created: -DAY * 610, history: [
    { containers: [container({ name: 'pricing-api', image: img('pricing-api', 'v6.4.0'), env: pricingEnv, envFrom: ['pricing-config'], cpu: '1000m', memory: '1Gi' })], cause: null, t: -DAY * 16 },
    { containers: [container({ name: 'pricing-api', image: img('pricing-api', 'v6.4.1'), env: pricingEnv, envFrom: ['pricing-config'], cpu: '1000m', memory: '1Gi' })], cause: null, t: -DAY * 6 },
    // The hand-made override, on the live object only: it is not in git.
    { containers: [container({ name: 'pricing-api', image: img('pricing-api', 'v6.4.1'), env: [...pricingEnv, ['PRICE_CACHE_TTL_SECONDS', String(v.ttl)]], envFrom: ['pricing-config'], cpu: '1000m', memory: '1Gi' })], cause: `kubectl set env deployment/pricing-api PRICE_CACHE_TTL_SECONDS=${v.ttl} --namespace=pricing`, t: ttlSet },
  ] });
  const projector = deployment({ name: 'order-projector', replicas: 6, created: -DAY * 500, history: [
    { containers: [container({ name: 'order-projector', image: img('order-projector', 'v1.8.2'), env: [['SUBSCRIPTION', 'order-projector-sub'], ['MAX_SCHEMA', '3']] })], cause: null, t: -DAY * 30 },
    { containers: [container({ name: 'order-projector', image: img('order-projector', 'v1.9.0'), env: [['SUBSCRIPTION', 'order-projector-sub'], ['MAX_SCHEMA', '4']] })], cause: 'ORD-331 schema v4 rollout (paused at 50% until the orders-events backfill finishes)', t: -DAY * 2 },
  ] });
  return {
    default: {}, 'kube-system': { created: -DAY * 700 }, 'istio-system': { deployments: [d('istiod', 3, '1.21.2', [], { history: [{ containers: [container({ name: 'discovery', image: 'docker.io/istio/pilot:1.21.2' })], cause: null, t: -DAY * 40 }] })] },
    edge: { deployments: [d('edge-gateway', 6, 'v1.29.4', [['RATE_LIMIT_SOURCE', 'flags']], { history: [{ containers: [container({ name: 'istio-proxy', image: 'docker.io/istio/proxyv2:1.21.2' })], cause: null, t: -DAY * 40 }] })], services: [service({ name: 'edge-gateway', type: 'LoadBalancer', clusterIP: '10.64.0.40', ports: ['80:31080/TCP', '443:31443/TCP'], externalIP: '34.120.18.77' })] },
    platform: { deployments: [d('legacy-auth-proxy', 4, 'v0.9.14', [['UPSTREAM', 'web-bff.web.svc.cluster.local:8080'], ['JWKS_URL', 'https://auth.quillmart.com/.well-known/jwks.json'], ['SESSION_COOKIE', 'qm_s']], { prev: 'v0.9.13', memory: '256Mi' })], services: [service({ name: 'legacy-auth-proxy', clusterIP: '10.64.3.12', ports: ['8080/TCP'] })] },
    web: { deployments: [d('web-bff', 10, 'v8.3.1', [['CHECKOUT_URL', 'http://checkout-api.checkout.svc.cluster.local:8080'], ['SEARCH_URL', 'http://search-api.search.svc.cluster.local:8080'], ['UPSTREAM_TIMEOUT_MS', '8000'], ['UPSTREAM_RETRIES', '1']], { prev: 'v8.3.0' })], hpas: [hpa({ name: 'web-bff', target: 'web-bff', min: 10, max: 30, cpu: 65, upPods: 4 })], services: [service({ name: 'web-bff', clusterIP: '10.64.5.20', ports: ['8080/TCP'] })] },
    search: { deployments: [d('search-api', 10, 'v5.14.0', [['PRICING_ADDR', `${v.ip}:8080`], ['PRICING_TIMEOUT_MS', '800'], ['PRICING_RETRIES', '2'], ['RECS_URL', 'http://recs-api.recs.svc.cluster.local:8080'], ['RECS_TIMEOUT_MS', '80'], ['RANKER', 'v2']], { prev: 'v5.13.3', cpu: '2000m', memory: '2Gi' })], services: [service({ name: 'search-api', clusterIP: '10.64.6.33', ports: ['8080/TCP'] })] },
    checkout: { deployments: [d('checkout-api', 8, 'v3.11.2', [['PRICING_URL', 'http://pricing-api.pricing.svc.cluster.local:8080'], ['PRICING_TIMEOUT_MS', '2000'], ['PRICING_RETRIES', '3'], ['CART_URL', 'http://cart-api.cart.svc.cluster.local:8080'], ['INVENTORY_URL', 'http://inventory-api.inventory.svc.cluster.local:8080']], { prev: 'v3.11.1' })], hpas: [hpa({ name: 'checkout-api', target: 'checkout-api', min: 8, max: 24, cpu: 65, upPods: 2 })], services: [service({ name: 'checkout-api', clusterIP: '10.64.7.14', ports: ['8080/TCP'] })] },
    cart: { deployments: [d('cart-api', 4, 'v2.15.1', [['REDIS_ADDR', '10.30.0.12:6379']], { prev: 'v2.15.0', memory: '256Mi' })], services: [service({ name: 'cart-api', clusterIP: '10.64.8.9', ports: ['8080/TCP'] })] },
    inventory: { deployments: [d('inventory-api', 4, 'v4.2.0', [['DB_HOST', '127.0.0.1']], { prev: 'v4.1.9' })], services: [service({ name: 'inventory-api', clusterIP: '10.64.9.3', ports: ['8080/TCP'] })] },
    recs: { deployments: [d('recs-api', 6, v.recs[0], [['MODEL_BUCKET', 'gs://qm-recs-models/prod'], ['FEATURE_STORE', 'http://features.recs.svc.cluster.local:8080']], { prev: 'v0', cpu: '2000m', memory: '3Gi', history: [{ containers: [container({ name: 'recs-api', image: img('recs-api', v.recs[0]), env: [['MODEL_BUCKET', 'gs://qm-recs-models/prod']], cpu: '2000m', memory: '3Gi' })], cause: `deploy: recs-api ${v.recs[0]} (pipeline #${v.pipeline - 311})`, t: -DAY * 5 }] })], services: [service({ name: 'recs-api', clusterIP: '10.64.10.21', ports: ['8080/TCP'] })] },
    pricing: { deployments: [pricing], configmaps: [configmap({ name: 'pricing-config', data: { PRICE_CACHE_TTL_SECONDS: String(v.ttl), PRICE_CACHE_MAX_KEYS: '2000000', PROMO_BATCH_SIZE: '50', LOG_LEVEL: 'info' }, created: -DAY * 610 })], services: [service({ name: 'pricing-api', clusterIP: '10.64.11.5', ports: ['8080/TCP'] }), service({ name: 'pricing-api-ilb', type: 'LoadBalancer', clusterIP: '10.64.11.6', ports: ['8080:30880/TCP'], externalIP: v.ip, created: -DAY * 900 })] },
    promo: { deployments: [d('promo-engine', v.promoPods, 'v1.33.0', [['DB_HOST', '127.0.0.1'], ['DB_POOL_SIZE', '20'], ['MAX_INFLIGHT', '100']], { prev: 'v1.32.4', cpu: '2000m', memory: '2Gi' })], hpas: [hpa({ name: 'promo-engine', target: 'promo-engine', min: 3, max: v.promoPods, cpu: 70, upPods: 2 })], services: [service({ name: 'promo-engine', clusterIP: '10.64.12.40', ports: ['8080/TCP'] })] },
    payments: { deployments: [projector, d('refund-worker', 2, 'v0.4.7', [['SUBSCRIPTION', 'refunds-sub'], ['PSP_URL', 'https://api.paystream.example/v1']], { prev: 'v0.4.6', cpu: '250m', memory: '256Mi' })] },
    data: { deployments: [d('reporting-exporter', 1, 'v2.2.0', [['DB_HOST', '10.84.0.3'], ['DB_NAME', 'orders'], ['DB_USER', 'reporting_ro'], ['EXPORT_BUCKET', 'gs://qm-reporting-exports']], { prev: 'v2.1.8', cpu: '250m', memory: '512Mi' })] },
    flags: { deployments: [d('flags', 2, 'v1.4.2', [], { memory: '256Mi' })], services: [service({ name: 'flags', clusterIP: '10.64.14.2', ports: ['80/TCP'] })] },
  };
}
function buildState(v) {
  const spec = meshSpec(v);
  const kube = kubeState({ current: PROD, contexts: { [PROD]: { cluster: 'prod-usc1', project: PROJECT, namespace: 'default', endpoint: '34.118.12.201', podRange: 48, nodes: Array.from({ length: 18 }, (_, k) => `gke-prod-usc1-default-pool-${['5f2c1a9e', '8b3d7e04', 'c19a6f2d'][k % 3]}-${['q8zt', 'm2kx', 'w7rb', 'j4nd', 'p9sv', 'h3cf', 'x6lq', 'b2tn', 'r5vd', 'c8kw', 'f4mz', 'n7gp', 'd3sj', 't9hb', 'k2rx', 'v6wc', 'g8pl', 'z5qm'][k]}`), namespaces: namespaces(v) } } }, 0);
  // order-projector's rollout was paused half way: three pods still run the old schema.
  const proj = kube.contexts[PROD].namespaces.payments.deployments.find(d => d.name === 'order-projector');
  const old = proj.revisions[0];
  proj.paused = true;
  proj.pods.slice(0, 3).forEach(p => { p.hash = old.hash; p.rev = old.n; p.image = old.containers[0].image; p.env = { SUBSCRIPTION: 'order-projector-sub', MAX_SCHEMA: '3' }; p.name = p.name.replace(/-[a-z0-9]+-([a-z0-9]{5})$/, `-${old.hash}-$1`); });
  spec.routes = Object.fromEntries(spec.vs.map(r => [r.service, { timeoutMs: r.timeoutMs, retries: r.retries, perTryTimeoutMs: r.perTryTimeoutMs }]));
  return {
    variant: v,
    gcloud: { account: 'morgan.lee@quillmart.com', project: PROJECT, region: 'us-central1', zone: 'us-central1-a', configuration: 'default', projects: [{ id: PROJECT, name: 'Quillmart Production', number: '418392016653' }, { id: 'quillmart-staging', name: 'Quillmart Staging', number: '771408512264' }], clusters: [{ project: PROJECT, name: 'prod-usc1', location: 'us-central1', version: '1.30.4-gke.1348000', endpoint: '34.118.12.201', nodes: 18, machine: 'n2-standard-16' }] },
    kube, mesh: spec,
    cache: { miss: missBase(v.ttl) * 0.5, lastWarm: -30, hits: 91_338_512_004, misses: 6_120_883_417, flushed: [] },
    vm: { name: v.vm, status: 'RUNNING', zone: 'us-central1-a', created: '2021-03-11T16:42:08.311-08:00', ip: '10.128.0.61', cron: true, stoppedAt: null },
    flags: flagsState(v),
    refunds: { produced: 0, processed: 0 },
    samples: [], history: [],
  };
}
function flagsState(v) {
  const f = (key, value, enabled, description, updated, by) => ({ key, value, enabled, description, updated_at: updated, updated_by: by, created_at: -DAY * 200 });
  return [
    f('pricing.cache_ttl_override', null, false, 'When enabled, overrides PRICE_CACHE_TTL_SECONDS on every pricing-api pod within 30s. Integer seconds.', -DAY * 41, 'svc-flags-bootstrap'),
    f('pricing.promo_batch', true, true, 'Batch promo-engine lookups (PROMO_BATCH_SIZE).', -DAY * 90, 'priya.raman'),
    f('search.ranker_v2', true, true, 'Serve search results from the v2 ranker.', -3 * 3600 - 41 * 60, 'aiko.tanaka'),
    f('checkout.express_pay', true, true, 'Show express pay buttons on the payment step.', -DAY * 1 - 5 * 3600, 'lena.fischer'),
    f('edge.rate_limit.checkout_rps', 0, false, 'Gateway rate limit for /api/checkout, requests per second. 0 = unlimited.', -DAY * 60, 'platform-oncall'),
    f('edge.rate_limit.search_rps', 0, false, 'Gateway rate limit for /api/search, requests per second. 0 = unlimited.', -DAY * 60, 'platform-oncall'),
    f('recs.related_items', true, true, 'Show related items on search results.', -DAY * 12, 'recs-bot'),
    f('promo.stacking_rules_v3', false, false, 'Evaluate promotion stacking with the v3 rule engine.', -DAY * 8, 'dev.patel'),
  ].map(x => ({ ...x, audit: [{ at: x.updated_at, by: x.updated_by, change: x.enabled ? 'enabled' : 'created' }] }));
}

// ---------- time ----------

const deploymentOf = (state, name) => {
  const ns = state.mesh.services[name]?.ns ?? { 'order-projector': 'payments', 'refund-worker': 'payments', 'reporting-exporter': 'data', flags: 'flags', istiod: 'istio-system' }[name];
  return state.kube.contexts[PROD].namespaces[ns]?.deployments.find(d => d.name === name && !d.deleted) ?? null;
};
const readyPods = (state, name) => (deploymentOf(state, name)?.pods ?? []).filter(p => p.ready && !p.terminating);
/** The TTL each ready pricing pod runs with: the flag if set, else its env (which already beat the ConfigMap). */
export function effectiveTtl(state) {
  const flag = state.flags.find(f => f.key === 'pricing.cache_ttl_override');
  const pods = readyPods(state, 'pricing-api');
  if (flag.enabled && Number(flag.value) > 0 && state.t >= (flag.appliedAt ?? 0)) return pods.map(() => Number(flag.value));
  return pods.map(p => Number(p.env.PRICE_CACHE_TTL_SECONDS) || ORIGINAL_TTL);
}
/** Warm keys hold for 15 minutes after the last warm run, and fade as they expire. */
const warmth = (state, t) => Math.max(0, Math.min(1, 1 - (t - state.cache.lastWarm - 60) / 840));
/** Traffic toward the evening peak: 70% two hours ago, full now, a touch more over the next hour. */
const traffic = (t) => Math.max(0.55, Math.min(1.08, 1 + t / 30000));
function podsFor(state, name) {
  const n = readyPods(state, name).length;
  // promo-pg allows only so many connection pools; pods past it fail every query.
  if (name === 'promo-engine') return Math.min(n, state.variant.promoDbPods);
  return n;
}
function compute(state, t) {
  const ttls = effectiveTtl(state);
  const base = ttls.length ? ttls.reduce((s, x) => s + missBase(x), 0) / ttls.length : 1;
  const target = Math.min(1, base * (1 - 0.5 * warmth(state, t)));
  const c = state.cache;
  const tau = target < c.miss ? 90 : 25;
  c.miss += (target - c.miss) * (1 - Math.exp(-10 / tau));
  c.target = target;
  const proxyDown = podsFor(state, 'legacy-auth-proxy') === 0;
  const m = meshStep(state.mesh, { pods: (n) => podsFor(state, n), calls: (e) => (e.calls === 'miss' ? c.miss : e.calls), rps: (j) => j.rps * traffic(t), down: (n) => (n === 'legacy-auth-proxy' && proxyDown) });
  return { t, miss: c.miss, ttl: ttls.length ? Math.round(ttls.reduce((a, b) => a + b, 0) / ttls.length) : 0, warm: warmth(state, t), traffic: traffic(t), ...m };
}
function step(ctx) {
  const state = ctx.state;
  state.t = ctx.t;
  kubeTick(ctx, hooksFor(ctx));
  const v = state.variant;
  // The cron on the VM warms the hot keys once a minute while the VM runs and the cron is in place.
  if (state.vm.status === 'RUNNING' && state.vm.cron && ctx.t - state.cache.lastWarm >= 60 && (state.vm.bootedAt ?? -Infinity) + 90 <= ctx.t) state.cache.lastWarm = ctx.t;
  // A teammate's pipeline ships recommendations in the middle of it all.
  if (ctx.t === 300 && !state.recsShipped) {
    state.recsShipped = true;
    const d = deploymentOf(state, 'recs-api');
    const before = ctx.events.length;
    if (d) rollOut(ctx, PROD, 'recs', 'recs-api', d.revisions.find(r => r.n === d.current).containers.map(c => ({ ...c, image: c.image.replace(/:[^:]+$/, `:${v.recs[1]}`) })), `deploy: recs-api ${v.recs[1]} (pipeline #${v.pipeline})`);
    for (const e of ctx.events.slice(before)) e.system = true;
    ctx.event('ci.deploy', { service: 'recs-api', version: v.recs[1], pipeline: v.pipeline, system: true });
  }
  // promo-pg allows only so many pools: the newest promo-engine pods past that cannot connect.
  const promo = readyPods(state, 'promo-engine').sort((a, b) => a.born - b.born);
  promo.forEach((p, k) => { p.dbRefused = k >= v.promoDbPods; });
  const s = compute(state, ctx.t);
  const refundWorkers = readyPods(state, 'refund-worker').length;
  state.refunds.produced += 0.4 * 10;
  state.refunds.processed = Math.min(state.refunds.produced, state.refunds.processed + (refundWorkers ? 0.6 * 10 : 0));
  state.samples.push(slim(s));
  state.last = s;
}
/** What a sample keeps: enough for metrics, traces and the grader, not the whole graph. */
function slim(s) {
  return { t: s.t, miss: s.miss, ttl: s.ttl, warm: s.warm, traffic: s.traffic, journeys: s.journeys,
    services: Object.fromEntries(Object.entries(s.services).map(([k, x]) => [k, { rps: x.rps, load: x.load, capacity: x.capacity, rho: x.rho, shed: x.shed, self50: x.self50, self99: x.self99, p50: x.p50, p99: x.p99, err: x.err }])),
    edges: Object.fromEntries(Object.entries(s.edges).map(([k, x]) => [k, { load: x.load, tries: x.tries, attempts: x.attempts, f: x.f, final: x.final, retryRps: x.retryRps, timeoutMs: x.timeoutMs }])) };
}
function hooksFor(ctx) {
  return {
    cpu(context, ns, name) {
      const s = ctx.state.last?.services?.[name];
      if (!s) return 40;
      // Workers blocked on slow calls still burn CPU on retries, timeouts and serialisation.
      const util = s.capacity > 0 ? s.load / s.capacity : 1;
      return Math.round(Math.min(160, 30 + 55 * Math.min(2, util) + 40 * s.shed));
    },
    logs(context, ns, pod, opts) { return podLogs(ctx, ns, pod, opts); },
    readyDelay: (_c, _ns, name) => (name === 'promo-engine' || name === 'search-api' ? 45 : 25),
  };
}
/** The estate if nobody touched anything for five more minutes: where the operator left it. */
function settle(ctx, seconds = 300) {
  const shadow = { state: structuredClone(ctx.state), t: ctx.t, events: [], at: ctx.at, now: ctx.now, event(kind, detail = {}) { shadow.events.push({ t: shadow.t, kind, ...detail }); } };
  shadow.wait = () => {};
  const end = ctx.t + seconds;
  while (shadow.t < end) { shadow.t += 10; step(shadow); }
  return shadow;
}

// ---------- what the tools show ----------

const iso = (ctx, t, ms = 0) => new Date(ctx.at(t).getTime() + ms).toISOString();
const hex = (n, len) => { let out = ''; for (let k = 0; out.length < len; k++) out += (hashString(`${n}:${k}`) >>> 0).toString(16).padStart(8, '0'); return out.slice(0, len); };
const sampleAt = (state, t) => {
  if (t >= 0 || !state.history.length) { const s = state.samples; const k = s.findLastIndex(x => x.t <= t); return s[Math.max(0, k)] ?? state.last; }
  const k = state.history.findLastIndex(x => x.t <= t);
  return state.history[Math.max(0, k)];
};
function podLogs(ctx, ns, pod, { previous, since }) {
  const state = ctx.state;
  const d = Object.values(state.kube.contexts[PROD].namespaces[ns]?.deployments ?? {}).find(x => x.pods.some(p => p.name === pod.name));
  const name = d?.name ?? pod.name.replace(/-[a-z0-9]+-[a-z0-9]{5}$/, '');
  const from = Math.max(pod.born, ctx.t - (since ?? 900), ctx.t - 900);
  const out = [];
  const rand = seeded(hashString(`${pod.name}|${ctx.t}`));
  const at = (t) => iso(ctx, t, Math.floor(rand() * 999));
  const json = (t, level, msg, fields = {}) => out.push(JSON.stringify({ level, ts: at(t), logger: name, msg, ...fields }));
  const trace = () => hex(rand() * 1e9, 32);
  if (pod.born >= from) {
    if (name === 'pricing-api') {
      const flag = state.flags.find(f => f.key === 'pricing.cache_ttl_override');
      const ttl = flag.enabled && Number(flag.value) > 0 ? Number(flag.value) : Number(pod.env.PRICE_CACHE_TTL_SECONDS) || ORIGINAL_TTL;
      const rev = d?.revisions.find(r => r.hash === pod.hash);
      const fromEnv = Boolean(rev?.containers[0].env.some(e => e.name === 'PRICE_CACHE_TTL_SECONDS'));
      json(pod.born + 2, 'info', 'config loaded', { cache_ttl_seconds: ttl, cache_ttl_source: flag.enabled && Number(flag.value) > 0 ? 'flag' : fromEnv ? 'env' : 'configmap', promo_timeout_ms: 400, promo_retries: 1, redis: '10.30.0.5:6379' });
    } else json(pod.born + 2, 'info', 'starting', { version: pod.image.split(':').pop() });
  }
  for (let t = Math.ceil(from / 10) * 10; t <= ctx.t; t += 10) {
    const s = sampleAt(state, t);
    if (!s) continue;
    const svc = s.services[name];
    const lines = 2;
    for (let k = 0; k < lines; k++) {
      const tt = t - 10 + rand() * 10;
      if (tt < from) continue;
      if (name === 'pricing-api') {
        const e = s.edges['pricing-api>promo-engine'];
        if (rand() < s.miss) {
          if (rand() < e.f) json(tt, 'warn', 'promo evaluate failed, retrying', { sku: `SKU-${Math.floor(rand() * 90000 + 10000)}`, attempt: 1 + Math.floor(rand() * 2), err: rand() < 0.5 ? 'upstream connect error or disconnect/reset before headers. reset reason: overflow' : 'rpc error: code = DeadlineExceeded desc = upstream request timeout', trace_id: trace() });
          else json(tt, 'debug', 'price cache miss', { sku: `SKU-${Math.floor(rand() * 90000 + 10000)}`, promo_ms: Math.round((s.services['promo-engine']?.p50 ?? 25) * (0.5 + rand())), trace_id: trace() });
        }
        if (t % 60 === 0 && k === 0) json(tt, 'info', 'cache stats', { window: '60s', hit_ratio: Number((1 - s.miss).toFixed(3)), keys: Math.round(1_400_000 * (1 - s.miss)), evictions: 0 });
      } else if (name === 'promo-engine') {
        if (svc && svc.shed > 0.02 && rand() < svc.shed + 0.2) json(tt, 'warn', 'shedding request', { reason: 'max_inflight', inflight: 100, limit: 100, trace_id: trace() });
        else json(tt, 'info', 'evaluate promotions', { rules_evaluated: 40 + Math.floor(rand() * 90), duration_ms: Math.round((svc?.self50 ?? 25) * (0.6 + rand())), trace_id: trace() });
        if (pod.dbRefused) json(tt, 'error', 'db pool: failed to acquire connection', { err: 'FATAL: remaining connection slots are reserved for non-replication superuser connections', trace_id: trace() });
      } else if (name === 'checkout-api') {
        const e = s.edges['checkout-api>pricing-api'];
        if (rand() < Math.min(0.9, e.f * 1.5)) json(tt, 'error', 'price lookup failed', { attempt: 1 + Math.floor(rand() * e.tries), err: 'rpc error: code = Unavailable desc = upstream request timeout', upstream: 'pricing-api.pricing.svc.cluster.local:8080', trace_id: trace() });
        else json(tt, 'info', 'order placed', { order_id: `ord_${hex(rand() * 1e9, 12)}`, duration_ms: Math.round(svc?.p50 ?? 200), trace_id: trace() });
      } else if (name === 'search-api') {
        const e = s.edges['search-api>pricing-api'];
        if (rand() < Math.min(0.9, e.f * 1.5)) json(tt, 'error', 'pricing batch lookup failed', { upstream: `${state.variant.ip}:8080`, err: 'context deadline exceeded (Client.Timeout exceeded while awaiting headers)', attempt: 1 + Math.floor(rand() * 3), trace_id: trace() });
        else json(tt, 'info', 'search', { q_len: 3 + Math.floor(rand() * 20), results: 48, duration_ms: Math.round(svc?.p50 ?? 80), ranker: 'v2', trace_id: trace() });
        if (rand() < 0.3) json(tt, 'warn', 'recs timeout, serving without related items', { timeout_ms: 80, trace_id: trace() });
      } else if (name === 'web-bff') {
        const j = s.journeys[rand() < 0.11 ? 'checkout' : 'search'];
        const failed = rand() < j.err;
        out.push(JSON.stringify({ level: failed ? 'error' : 'info', ts: at(tt), logger: 'access', method: j === s.journeys.checkout ? 'POST' : 'GET', path: j === s.journeys.checkout ? '/api/checkout' : '/api/search', status: failed ? (rand() < 0.5 ? 504 : 503) : 200, duration_ms: Math.round(failed ? j.p99 : j.p50 * (0.5 + rand())), upstream_flags: failed ? 'UT' : '-', trace_id: trace() }));
      } else if (name === 'legacy-auth-proxy') {
        out.push(`10.48.${Math.floor(rand() * 250)}.${Math.floor(rand() * 250)} - - [${new Date(ctx.at(tt)).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1/$2/$3:$4 +0000')}] "GET /api/${rand() < 0.1 ? 'checkout' : 'search'} HTTP/1.1" 200 0 "-" "Mozilla/5.0" auth=jwt upstream=web-bff.web.svc.cluster.local:8080`);
      } else if (name === 'refund-worker') {
        if (rand() < 0.5) json(tt, 'info', 'refund processed', { refund_id: `re_${hex(rand() * 1e9, 14)}`, psp_status: 'succeeded', subscription: 'refunds-sub' });
      } else if (name === 'order-projector') {
        if (pod.env.MAX_SCHEMA === '3' && rand() < 0.4) json(tt, 'warn', 'nacking message with newer schema', { schema_version: 4, max_supported: 3, subscription: 'order-projector-sub' });
        else json(tt, 'info', 'projected order event', { schema_version: pod.env.MAX_SCHEMA === '3' ? 3 : 4, lag_ms: 120 + Math.floor(rand() * 300) });
      } else if (name === 'recs-api') {
        json(tt, 'info', 'related items', { model: pod.image.split(':').pop(), duration_ms: 20 + Math.floor(rand() * 40) });
      } else if (rand() < 0.4) json(tt, 'info', 'request', { status: 200, duration_ms: Math.round(svc?.p50 ?? 10) });
    }
  }
  if (previous) return [];
  const ts = (l) => /"ts":"([^"]+)"/.exec(l)?.[1] ?? /\[(\d+\/\w+\/\d+:[\d:]+)/.exec(l)?.[1] ?? '';
  return out.sort((a, b) => (ts(a) < ts(b) ? -1 : ts(a) > ts(b) ? 1 : 0)).slice(-400);
}
function logEntries(ctx, filter, { limit, freshness }) {
  const state = ctx.state;
  const entries = [];
  for (const [ns, space] of Object.entries(state.kube.contexts[PROD].namespaces)) {
    for (const d of space.deployments ?? []) {
      for (const p of d.pods.filter(x => x.ready).slice(0, 2)) {
        for (const line of podLogs(ctx, ns, p, { since: Math.min(freshness, 900) }).slice(-30)) {
          let payload;
          try { payload = JSON.parse(line); } catch { payload = null; }
          const ts = payload?.ts ?? iso(ctx, ctx.t);
          const e = { insertId: hex(`${p.name}${ts}`, 16), ...(payload ? { jsonPayload: Object.fromEntries(Object.entries(payload).filter(([k]) => k !== 'ts' && k !== 'level')) } : { textPayload: line }), labels: { 'compute.googleapis.com/resource_name': p.node, 'k8s-pod/app': d.name }, logName: `projects/${PROJECT}/logs/${payload?.level === 'error' || payload?.level === 'warn' ? 'stderr' : 'stdout'}`, receiveTimestamp: ts, resource: { labels: { cluster_name: 'prod-usc1', container_name: d.name, location: 'us-central1', namespace_name: ns, pod_name: p.name, project_id: PROJECT }, type: 'k8s_container' }, severity: { error: 'ERROR', warn: 'WARNING', debug: 'DEBUG' }[payload?.level] ?? 'INFO', timestamp: ts };
          if (matchesFilter(e, filter)) entries.push(e);
        }
      }
    }
  }
  return entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, limit);
}

// ---------- observability endpoints ----------

function sloBody(ctx) {
  const s = ctx.state.last;
  const rows = Object.entries(SLO).map(([name, target]) => {
    const j = s.journeys[name];
    const bad = j.p99 > target.p99 || j.err > target.err;
    return { slo: `${name}-latency-and-availability`, journey: name, target: { p99_ms: target.p99, error_rate: target.err }, current: { p99_ms: j.p99, p50_ms: j.p50, error_rate: Number(j.err.toFixed(4)), rps: Math.round(j.rps) }, status: bad ? 'BREACHING' : 'OK', burn_rate_1h: Number((bad ? 4 + j.err * 40 : 0.3 + j.err * 20).toFixed(2)) };
  });
  return { generated_at: iso(ctx, ctx.t), slos: rows };
}
/** Series Prometheus would hold at a moment, from the graph's state then. */
function seriesAt(state, s) {
  return (name) => {
    const svc = Object.entries(s.services), mesh = state.mesh;
    const lab = (n) => ({ service: n, namespace: mesh.services[n]?.ns ?? '', job: `${mesh.services[n]?.ns}/${n}` });
    switch (name) {
      case 'http_server_request_duration_seconds_hist': return svc.map(([n, x]) => ({ labels: lab(n), value: { p50: x.p50 / 1000, p90: (x.p50 + (x.p99 - x.p50) * 0.45) / 1000, p99: x.p99 / 1000 } }));
      case 'http_server_request_duration_seconds_count': case 'http_server_requests_total': case 'http_requests_total':
        return svc.flatMap(([n, x]) => [{ labels: { ...lab(n), code: '200', status: '200' }, value: x.rps * (1 - x.err) }, { labels: { ...lab(n), code: '503', status: '503' }, value: x.rps * x.err * 0.6 + x.load * x.shed }, { labels: { ...lab(n), code: '504', status: '504' }, value: x.rps * x.err * 0.4 }]);
      case 'istio_requests_total': return mesh.edges.flatMap(e => {
        const x = s.edges[`${e.from}>${e.to}`];
        if (!x) return [];
        const l = { source_workload: e.from, source_workload_namespace: mesh.services[e.from]?.ns, destination_workload: e.to, destination_workload_namespace: mesh.services[e.to]?.ns, destination_service: `${e.to}.${mesh.services[e.to]?.ns}.svc.cluster.local`, reporter: 'source' };
        if (e.bypassMesh) return [];
        return [{ labels: { ...l, response_code: '200', response_flags: '-' }, value: x.load * (1 - x.f) }, { labels: { ...l, response_code: '504', response_flags: 'UT' }, value: x.load * x.f * 0.7 }, { labels: { ...l, response_code: '503', response_flags: 'UO' }, value: x.load * x.f * 0.3 }];
      });
      case 'istio_request_duration_milliseconds_hist': return mesh.edges.filter(e => !e.bypassMesh).map(e => { const d = s.services[e.to]; return { labels: { source_workload: e.from, destination_workload: e.to, reporter: 'source' }, value: { p50: Math.min(d.p50, s.edges[`${e.from}>${e.to}`].timeoutMs), p90: Math.min(d.p50 * 2, s.edges[`${e.from}>${e.to}`].timeoutMs), p99: Math.min(d.p99, s.edges[`${e.from}>${e.to}`].timeoutMs) } }; });
      case 'envoy_cluster_upstream_rq_retry': return mesh.edges.filter(e => !e.bypassMesh).map(e => ({ labels: { pod_name: `${e.from}`, cluster_name: `outbound|8080||${e.to}.${mesh.services[e.to]?.ns}.svc.cluster.local`, source_workload: e.from }, value: s.edges[`${e.from}>${e.to}`].retryRps }));
      case 'envoy_cluster_upstream_rq_timeout': return mesh.edges.filter(e => !e.bypassMesh).map(e => ({ labels: { cluster_name: `outbound|8080||${e.to}.${mesh.services[e.to]?.ns}.svc.cluster.local`, source_workload: e.from }, value: s.edges[`${e.from}>${e.to}`].load * s.edges[`${e.from}>${e.to}`].f * 0.7 }));
      case 'redis_keyspace_hits_total': return [{ labels: { instance: '10.30.0.5:6379', service: 'pricing-cache' }, value: (s.services['pricing-api']?.rps ?? 0) * (1 - s.miss) * 12 }];
      case 'redis_keyspace_misses_total': return [{ labels: { instance: '10.30.0.5:6379', service: 'pricing-cache' }, value: (s.services['pricing-api']?.rps ?? 0) * s.miss * 12 }];
      case 'pricing_cache_ttl_seconds': return [{ labels: { service: 'pricing-api', namespace: 'pricing' }, value: s.ttl }];
      case 'pricing_cache_hit_ratio': return [{ labels: { service: 'pricing-api', namespace: 'pricing' }, value: 1 - s.miss }];
      case 'promo_engine_inflight_requests': return [{ labels: { service: 'promo-engine', namespace: 'promo' }, value: Math.min(100, (s.services['promo-engine']?.rho ?? 0) * 88) }];
      case 'promo_engine_shed_total': return [{ labels: { service: 'promo-engine', namespace: 'promo', reason: 'max_inflight' }, value: (s.services['promo-engine']?.load ?? 0) * (s.services['promo-engine']?.shed ?? 0) }];
      case 'kube_deployment_status_replicas_available': return Object.keys(mesh.services).map(n => ({ labels: { deployment: n, namespace: mesh.services[n].ns }, value: podsFor(state, n) }));
      case 'up': return Object.keys(mesh.services).map(n => ({ labels: { ...lab(n) }, value: 1 }));
      default: return null;
    }
  };
}
function prometheus(ctx, req) {
  const state = ctx.state;
  const ok = (data) => ({ status: 200, body: `${JSON.stringify({ status: 'success', data })}\n` });
  const bad = (error, status = 400) => ({ status, body: `${JSON.stringify({ status: 'error', errorType: 'bad_data', error })}\n` });
  const now = ctx.at(ctx.t).getTime() / 1000;
  if (req.path === '/api/v1/label/__name__/values') return ok(['envoy_cluster_upstream_rq_retry', 'envoy_cluster_upstream_rq_timeout', 'http_server_request_duration_seconds_bucket', 'http_server_request_duration_seconds_count', 'istio_request_duration_milliseconds_bucket', 'istio_requests_total', 'kube_deployment_status_replicas_available', 'pricing_cache_hit_ratio', 'pricing_cache_ttl_seconds', 'promo_engine_inflight_requests', 'promo_engine_shed_total', 'redis_keyspace_hits_total', 'redis_keyspace_misses_total', 'up']);
  const q = req.query.query ?? (req.body ? new URLSearchParams(req.body).get('query') : null);
  if (req.path !== '/api/v1/query' && req.path !== '/api/v1/query_range') return { status: 404, body: '404 page not found\n' };
  if (!q) return bad('invalid parameter "query": 1:1: parse error: no expression found in input');
  const series = (s) => seriesAt(state, s);
  const fix = (name) => name;
  void fix;
  const evalAt = (s) => {
    const r = promql(q.replace(/_bucket\b/g, '_bucket').replace(/(\w+)_bucket/g, '$1_bucket'), (name) => series(s)(name.replace(/_bucket$/, '_hist')));
    return r;
  };
  try {
    if (req.path === '/api/v1/query') {
      const r = evalAt(state.last);
      if (r.scalar !== undefined) return ok({ resultType: 'scalar', result: [now, String(r.scalar)] });
      return ok({ resultType: 'vector', result: r.vector.filter(x => typeof x.value === 'number' && !Number.isNaN(x.value)).map(x => ({ metric: x.labels, value: [now, String(Number(x.value.toFixed(6)))] })) });
    }
    const parseTime = (x, dflt) => { if (x === undefined) return dflt; if (/^\d+(\.\d+)?$/.test(x)) return Number(x); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(x)) return NaN; return Date.parse(x) / 1000; };
    const end = parseTime(req.query.end, now), start = parseTime(req.query.start, now - 3600);
    const stepS = /^(\d+)([smh]?)$/.exec(req.query.step ?? '60')?.slice(1);
    const stepSec = stepS ? Number(stepS[0]) * ({ s: 1, m: 60, h: 3600 }[stepS[1]] ?? 1) : NaN;
    if (Number.isNaN(start)) return bad(`invalid parameter "start": cannot parse "${req.query.start}" to a valid timestamp`);
    if (Number.isNaN(end)) return bad(`invalid parameter "end": cannot parse "${req.query.end}" to a valid timestamp`);
    if (Number.isNaN(stepSec)) return bad(`invalid parameter "step": cannot parse "${req.query.step}" to a valid duration`);
    if ((end - start) / stepSec > 11000) return bad('exceeded maximum resolution of 11,000 points per timeseries. Try decreasing the query resolution (?step=XX)');
    const matrix = new Map();
    const origin = ctx.at(0).getTime() / 1000;
    for (let ts = start; ts <= end + 1e-6; ts += stepSec) {
      const t = ts - origin;
      if (t > ctx.t) break;
      const s = sampleAt(state, t);
      if (!s) continue;
      const r = evalAt(s);
      for (const x of r.vector ?? []) { if (typeof x.value !== 'number' || Number.isNaN(x.value)) continue; const k = JSON.stringify(x.labels); if (!matrix.has(k)) matrix.set(k, { metric: x.labels, values: [] }); matrix.get(k).values.push([Math.round(ts * 1000) / 1000, String(Number(x.value.toFixed(6)))]); }
    }
    return ok({ resultType: 'matrix', result: [...matrix.values()] });
  } catch (e) {
    if (e instanceof PromError) return bad(e.message);
    throw e;
  }
}
function tracing(ctx, req) {
  const state = ctx.state;
  const json = (body, status = 200) => ({ status, body: `${JSON.stringify(body)}\n` });
  const names = Object.keys(state.mesh.services).sort();
  if (req.path === '/api/services') return json({ data: [...names, 'jaeger-all-in-one'], total: names.length + 1, limit: 0, offset: 0, errors: null });
  const ops = /^\/api\/services\/([\w-]+)\/operations$/.exec(req.path);
  if (ops) return json({ data: names.includes(ops[1]) ? [SPAN_OPS[ops[1]], 'HTTP GET /healthz'] : [], total: 2, limit: 0, offset: 0, errors: null });
  if (req.path === '/api/dependencies') return json({ data: state.mesh.edges.map(e => ({ parent: e.from, child: e.to, callCount: Math.round((state.last.edges[`${e.from}>${e.to}`]?.load ?? 0) * 3600 * 0.01) })), total: state.mesh.edges.length, limit: 0, offset: 0, errors: null });
  const one = /^\/api\/traces\/([0-9a-f]{16,32})$/.exec(req.path);
  if (one) {
    const found = (state.traceCache ?? []).find(t => t.traceID === one[1]);
    return found ? json({ data: [found], total: 0, limit: 0, offset: 0, errors: null }) : json({ data: null, total: 0, limit: 0, offset: 0, errors: [{ code: 404, msg: 'trace not found' }] }, 404);
  }
  if (req.path !== '/api/traces') return { status: 404, body: '404 page not found\n' };
  const service = req.query.service;
  if (!service) return json({ data: null, total: 0, limit: 0, offset: 0, errors: [{ code: 400, msg: 'parameter \'service\' is required' }] }, 400);
  if (!names.includes(service)) return json({ data: [], total: 0, limit: 0, offset: 0, errors: null });
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 50);
  const minMs = durationMs(req.query.minDuration), maxMs = durationMs(req.query.maxDuration);
  const wantError = /"?error"?\s*:\s*"?true"?/.test(req.query.tags ?? '');
  const journey = ['checkout-api', 'cart-api', 'inventory-api'].includes(service) ? ['checkout'] : ['search-api', 'recs-api'].includes(service) ? ['search'] : ['checkout', 'search'];
  const t0 = ctx.at(ctx.t).getTime() * 1000;
  let got = [];
  for (const [k, j] of journey.entries()) got.push(...traces(state.mesh, state.last, { journey: j, count: limit * 3, t0Micros: t0 - k * 1_100_000, seed: hashString(`${j}|${ctx.t}|${service}`), spanOps: SPAN_OPS, calls: (e) => (e.calls === 'miss' ? state.last.miss : e.calls) }));
  got = got.filter(t => t.spans.some(s => t.processes[s.processID].serviceName === service));
  const rootMs = (t) => t.spans[0].duration / 1000;
  if (minMs) got = got.filter(t => rootMs(t) >= minMs);
  if (maxMs) got = got.filter(t => rootMs(t) <= maxMs);
  if (wantError) got = got.filter(t => t.spans.some(s => s.tags.some(x => x.key === 'error' && x.value === true)));
  got = got.sort((a, b) => b.spans[0].startTime - a.spans[0].startTime).slice(0, limit);
  state.traceCache = [...got, ...(state.traceCache ?? [])].slice(0, 200);
  return json({ data: got, total: 0, limit: 0, offset: 0, errors: null });
}
const durationMs = (x) => { const m = /^(\d+(?:\.\d+)?)(ms|s|us|µs)?$/.exec(String(x ?? '')); return m ? Number(m[1]) * ({ ms: 1, s: 1000, us: 0.001, 'µs': 0.001 }[m[2] ?? 'ms']) : 0; };
function flagsApi(ctx, req) {
  const state = ctx.state;
  const json = (body, status = 200) => ({ status, body: `${JSON.stringify(body, null, 2)}\n` });
  const show = (f) => ({ key: f.key, value: f.value, enabled: f.enabled, description: f.description, updated_at: iso(ctx, f.updated_at), updated_by: f.updated_by });
  const token = /^Bearer\s+\S+/.test(req.headers.authorization ?? '');
  if (req.path === '/healthz') return { status: 200, body: 'ok\n' };
  if (!token) return json({ error: 'unauthenticated', message: 'missing bearer token: use `Authorization: Bearer $(gcloud auth print-identity-token)`' }, 401);
  if (req.path === '/api/v1/flags' && req.method === 'GET') return json({ flags: state.flags.map(show) });
  if (req.path === '/api/v1/audit') {
    const rows = state.flags.flatMap(f => f.audit.map(a => ({ key: f.key, at: a.at, by: a.by, change: a.change }))).filter(r => !req.query.key || r.key === req.query.key).sort((a, b) => b.at - a.at).slice(0, Number(req.query.limit ?? 20));
    return json({ events: rows.map(r => ({ ...r, at: iso(ctx, r.at) })) });
  }
  const m = /^\/api\/v1\/flags\/([\w.-]+)\/?$/.exec(req.path);
  if (!m) return json({ error: 'not_found', message: `no route for ${req.method} ${req.path}` }, 404);
  const f = state.flags.find(x => x.key === m[1]);
  if (!f) return json({ error: 'not_found', message: `flag "${m[1]}" does not exist` }, 404);
  if (req.method === 'GET') return json(show(f));
  if (!['PUT', 'PATCH', 'POST'].includes(req.method)) return json({ error: 'method_not_allowed' }, 405);
  let body;
  try { body = JSON.parse(req.body ?? ''); } catch { return json({ error: 'bad_request', message: 'request body must be JSON: {"value": ..., "enabled": true|false, "reason": "..."}' }, 400); }
  if (body === null || typeof body !== 'object') return json({ error: 'bad_request', message: 'request body must be a JSON object' }, 400);
  const before = { value: f.value, enabled: f.enabled };
  if ('value' in body) {
    const type = f.key === 'pricing.cache_ttl_override' || f.key.startsWith('edge.rate_limit') ? 'integer' : 'boolean';
    if (type === 'integer' && body.value !== null && !(Number.isInteger(body.value) && body.value >= 0)) return json({ error: 'invalid_value', message: `${f.key} takes a non-negative integer or null` }, 422);
    if (type === 'boolean' && typeof body.value !== 'boolean') return json({ error: 'invalid_value', message: `${f.key} takes true or false` }, 422);
    f.value = body.value;
  }
  if ('enabled' in body) f.enabled = Boolean(body.enabled);
  else if ('value' in body && f.key !== 'pricing.cache_ttl_override' && typeof body.value === 'boolean') f.enabled = body.value;
  else if ('value' in body && body.value !== null && body.value !== 0) f.enabled = true;
  f.updated_at = ctx.t; f.updated_by = ctx.state.gcloud.account.split('@')[0];
  // pricing-api polls the flag service every 30 seconds.
  if (f.key === 'pricing.cache_ttl_override') f.appliedAt = ctx.t + 30;
  f.audit.push({ at: ctx.t, by: f.updated_by, change: `${JSON.stringify(before)} -> ${JSON.stringify({ value: f.value, enabled: f.enabled })}${body.reason ? ` (${body.reason})` : ''}` });
  ctx.event('flag.set', { key: f.key, value: f.value, enabled: f.enabled });
  return json(show(f));
}
function warmEndpoint(ctx, req) {
  if (req.path.startsWith('/internal/warm')) {
    ctx.wait(12);
    ctx.state.cache.lastWarm = ctx.t;
    ctx.event('cache.warm', { via: 'curl' });
    return { status: 200, body: `${JSON.stringify({ warmed: Number(req.query.top ?? 5000), ttl_seconds: Number(req.query.ttl ?? 900), duration_ms: 11873 })}\n` };
  }
  if (req.path === '/healthz') return { status: 200, body: 'ok\n' };
  if (req.path.startsWith('/v1/prices')) return { status: 200, body: `${JSON.stringify({ prices: [{ sku: 'SKU-10442', amount: 2499, currency: 'USD', promo: null }] })}\n` };
  return { status: 404, body: '{"error":"not found"}\n' };
}

/**
 * curl's `--data-urlencode` and `-G`, which every PromQL query from a terminal uses: the pairs are
 * encoded and sent as a form body, or appended to the URL with -G, before the shared curl runs.
 */

// ---------- gcloud groups this estate adds ----------

function computeGroup(ctx) {
  return (args, _io, g) => {
    const [kind, verb, name] = args.filter(a => !a.startsWith('-'));
    const vm = ctx.state.vm, v = ctx.state.variant;
    const nodes = ctx.state.kube.contexts[PROD].nodes;
    const instances = [{ name: vm.name, zone: vm.zone, machineType: 'e2-small', status: vm.status, networkIP: vm.ip, labels: { owner: 'pricing-legacy' }, created: vm.created }, ...nodes.map((n, k) => ({ name: n, zone: ['us-central1-a', 'us-central1-b', 'us-central1-c'][k % 3], machineType: 'n2-standard-16', status: 'RUNNING', networkIP: `10.128.1.${10 + k}`, labels: { 'goog-gke-node': '' }, created: '2024-08-02T09:11:40.117-07:00' }))];
    if (kind === 'instances') {
      if (verb === 'list') return g.print(instances.map(i => ({ name: i.name, zone: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/${i.zone}`, machineType: i.machineType, status: i.status, networkInterfaces: [{ networkIP: i.networkIP }] })), [['NAME', 'ZONE', 'MACHINE_TYPE', 'PREEMPTIBLE', 'INTERNAL_IP', 'EXTERNAL_IP', 'STATUS'], i => [i.name, i.zone.split('/').pop(), i.machineType, '', i.networkInterfaces[0].networkIP, '', i.status]]);
      if (!name) return g.error('argument INSTANCE_NAMES: Must be specified.', 2);
      const inst = instances.find(i => i.name === name);
      if (!inst) return g.error(`Could not fetch resource:\n - The resource 'projects/${PROJECT}/zones/${g.flag('zone') ?? ctx.state.gcloud.zone}/instances/${name}' was not found`);
      const isVm = inst.name === vm.name;
      if (verb === 'describe') {
        if (!isVm) return g.print({ name: inst.name, status: inst.status, machineType: `zones/${inst.zone}/machineTypes/${inst.machineType}`, labels: inst.labels });
        return g.print({ canIpForward: false, creationTimestamp: vm.created, deletionProtection: false, id: '7728390416624117805', kind: 'compute#instance', labelFingerprint: '8Qd3u0y1bUw=', labels: { owner: 'pricing-legacy' }, machineType: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/${vm.zone}/machineTypes/e2-small`, metadata: { fingerprint: 'k1S3n4b5VdA=', items: [{ key: 'enable-oslogin', value: 'TRUE' }, { key: 'startup-script', value: `#!/bin/bash\n# TEMP (Mar 2021, ${v.ticket.replace(/\d+$/, '211')}): keep the hot SKUs warm until pricing has a real cache strategy.\n# Remove once pricing-api warms its own cache. -- ops\ncat >/etc/cron.d/warm-pricing <<'EOF'\n* * * * * root curl -s -m 20 "http://${v.ip}:8080/internal/warm?top=5000&ttl=900" >/dev/null 2>&1\nEOF\nchmod 644 /etc/cron.d/warm-pricing\n` }], kind: 'compute#metadata' }, name: vm.name, networkInterfaces: [{ name: 'nic0', network: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/main`, networkIP: vm.ip, subnetwork: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/us-central1/subnetworks/main-usc1` }], serviceAccounts: [{ email: `418392016653-compute@developer.gserviceaccount.com`, scopes: ['https://www.googleapis.com/auth/devstorage.read_only', 'https://www.googleapis.com/auth/logging.write'] }], status: vm.status, zone: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/${vm.zone}` });
      }
      if (verb === 'ssh') {
        ctx.wait(6);
        return { err: ['External IP address was not found; defaulting to using IAP tunneling.', `ERROR: (gcloud.compute.start-iap-tunnel) Error while connecting [4033: 'not authorized'].`, 'kex_exchange_identification: Connection closed by remote host', 'Connection closed by UNKNOWN port 65535', '', 'Recommendation: To check for possible causes of SSH connectivity issues and get', 'recommendations, rerun the ssh command with the --troubleshoot option.', '', `gcloud compute ssh ${name} --project=${PROJECT} --zone=${inst.zone} --troubleshoot`, '', 'Or, to investigate an IAP tunneling issue:', '', `gcloud compute ssh ${name} --project=${PROJECT} --zone=${inst.zone} --troubleshoot --tunnel-through-iap`, '', 'ERROR: (gcloud.compute.ssh) [/usr/bin/ssh] exited with return code [255].'], code: 255 };
      }
      if (verb === 'get-serial-port-output') {
        if (!isVm) return { out: ['Specify --port=1 to read serial console output.'] };
        const lines = [];
        for (let t = Math.floor((ctx.t - 900) / 60) * 60; t <= ctx.t; t += 60) if (vm.status === 'RUNNING' && vm.cron && t <= ctx.t) lines.push(`${new Date(ctx.at(t)).toUTCString().slice(5, 25).replace(/(\d+) (\w+) \d+ /, '$2 $1 ')} ${vm.name} CRON[${20000 + ((t / 60) % 9000)}]: (root) CMD (curl -s -m 20 "http://${v.ip}:8080/internal/warm?top=5000&ttl=900" >/dev/null 2>&1)`);
        return { out: lines };
      }
      if (['stop', 'delete', 'suspend', 'reset', 'start', 'resume'].includes(verb)) {
        if (!isVm) return g.error(`Could not fetch resource:\n - Required 'compute.instances.${verb}' permission for 'projects/${PROJECT}/zones/${inst.zone}/instances/${name}'`);
        if (verb === 'delete') {
          const confirm = g.confirm(`The following instances will be deleted. Any attached disks configured to be auto-deleted will be deleted unless they are attached to any other instances or the \`--keep-disks\` flag is given and specifies them for keeping. Deleting a disk is irreversible and any data on the disk will be lost.\n - [${name}] in [${vm.zone}]`);
          ctx.wait(40);
          vm.status = 'TERMINATED'; vm.deleted = true; vm.stoppedAt = ctx.t;
          ctx.event('compute.instance', { name, action: 'delete' });
          return { err: [...confirm.lines, `Deleted [https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/${vm.zone}/instances/${name}].`] };
        }
        if (vm.deleted) return g.error(`Could not fetch resource:\n - The resource 'projects/${PROJECT}/zones/${vm.zone}/instances/${name}' was not found`);
        ctx.wait(verb === 'reset' ? 10 : 30);
        if (verb === 'stop' || verb === 'suspend') { vm.status = verb === 'stop' ? 'TERMINATED' : 'SUSPENDED'; vm.stoppedAt = ctx.t; }
        if (verb === 'start' || verb === 'resume') vm.status = 'RUNNING';
        if (verb === 'reset' || verb === 'start' || verb === 'resume') vm.bootedAt = ctx.t;
        ctx.event('compute.instance', { name, action: verb });
        return { err: [`${verb === 'stop' ? 'Stopping' : verb === 'start' ? 'Starting' : verb === 'reset' ? 'Resetting' : verb === 'suspend' ? 'Suspending' : 'Resuming'} instance(s) ${name}...done.`, `Updated [https://compute.googleapis.com/compute/v1/projects/${PROJECT}/zones/${vm.zone}/instances/${name}].`] };
      }
      if (verb === 'add-metadata' || verb === 'remove-metadata') return g.error(`Could not fetch resource:\n - Required 'compute.instances.setMetadata' permission for 'projects/${PROJECT}/zones/${inst.zone}/instances/${name}'`);
      return g.error(`Invalid choice: '${verb}'.`, 2);
    }
    if (['forwarding-rules', 'addresses', 'backend-services', 'firewall-rules', 'networks', 'disks', 'instance-groups', 'target-pools', 'health-checks', 'url-maps'].includes(kind) && verb === 'list') {
      if (kind === 'forwarding-rules') return g.print([{ name: 'a4e1f09c2b7d44f8a1c3pricing-api-ilb', region: 'us-central1', IPAddress: v.ip, IPProtocol: 'TCP', target: '' }, { name: 'k8s2-edge-gateway-1o2t9kqz', region: '', IPAddress: '34.120.18.77', IPProtocol: 'TCP', target: 'k8s2-tp-edge-gateway' }], [['NAME', 'REGION', 'IP_ADDRESS', 'IP_PROTOCOL', 'TARGET'], r => [r.name, r.region, r.IPAddress, r.IPProtocol, r.target]]);
      return { err: ['Listed 0 items.'] };
    }
    return g.error(`Invalid choice: '${kind ?? ''}'.`, 2);
  };
}
function redisGroup(ctx) {
  return (args, _io, g) => {
    const [kind, verb, name] = args.filter(a => !a.startsWith('-'));
    const inst = { name: `projects/${PROJECT}/locations/us-central1/instances/pricing-cache`, displayName: 'pricing-cache', host: '10.30.0.5', port: 6379, tier: 'STANDARD_HA', memorySizeGb: 13, redisVersion: 'REDIS_7_0', state: 'READY', locationId: 'us-central1-a', alternativeLocationId: 'us-central1-f', createTime: '2021-02-17T11:02:44.183712399Z', reservedIpRange: '10.30.0.0/29', persistenceConfig: { persistenceMode: 'DISABLED' } };
    const sessions = { ...inst, name: `projects/${PROJECT}/locations/us-central1/instances/cart-sessions`, displayName: 'cart-sessions', host: '10.30.0.12', memorySizeGb: 5 };
    if (kind !== 'instances') return g.error(`Invalid choice: '${kind ?? ''}'.`, 2);
    if (verb === 'list') { if (!g.flag('region')) return g.error('argument --region: Must be specified.', 2); return g.print([inst, sessions], [['INSTANCE_NAME', 'VERSION', 'REGION', 'TIER', 'SIZE_GB', 'HOST', 'PORT', 'NETWORK', 'RESERVED_IP', 'STATUS', 'CREATE_TIME'], i => [i.displayName, i.redisVersion, 'us-central1', i.tier, i.memorySizeGb, i.host, i.port, 'main', i.reservedIpRange, i.state, i.createTime.slice(0, 19)]]); }
    const target = [inst, sessions].find(i => i.displayName === name);
    if (!target) return g.error(`NOT_FOUND: Resource 'projects/${PROJECT}/locations/us-central1/instances/${name ?? ''}' was not found`);
    if (verb === 'describe') return g.print(target);
    if (verb === 'failover' || verb === 'upgrade' || verb === 'update') {
      if (verb !== 'failover') return g.error(`PERMISSION_DENIED: Permission 'redis.instances.${verb}' denied on 'projects/${PROJECT}/locations/us-central1/instances/${name}'`);
      ctx.wait(90);
      if (name === 'pricing-cache') flush(ctx, 'failover');
      ctx.event('redis.failover', { instance: name });
      return { err: [`Request issued for: [${name}]`, `Waiting for operation [projects/${PROJECT}/locations/us-central1/operations/operation-${hex(ctx.t, 12)}] to complete...done.`] };
    }
    return g.error(`Invalid choice: '${verb ?? ''}'.`, 2);
  };
}
function flush(ctx, how) {
  const c = ctx.state.cache;
  c.miss = 1; c.lastWarm = -10000;
  c.flushed.push({ t: ctx.t, how });
}
function pubsubGroup(ctx) {
  return (args, _io, g) => {
    const [kind, verb, name] = args.filter(a => !a.startsWith('-'));
    const subs = [{ name: `projects/${PROJECT}/subscriptions/order-projector-sub`, topic: `projects/${PROJECT}/topics/orders-events`, ackDeadlineSeconds: 60, messageRetentionDuration: '604800s' }, { name: `projects/${PROJECT}/subscriptions/refunds-sub`, topic: `projects/${PROJECT}/topics/orders-events`, ackDeadlineSeconds: 30, messageRetentionDuration: '604800s', filter: 'attributes.type = "order.refunded"' }, { name: `projects/${PROJECT}/subscriptions/reporting-sub`, topic: `projects/${PROJECT}/topics/orders-events`, ackDeadlineSeconds: 600, messageRetentionDuration: '86400s' }];
    if (kind === 'topics' && verb === 'list') return g.print([{ name: `projects/${PROJECT}/topics/orders-events` }, { name: `projects/${PROJECT}/topics/catalog-changes` }, { name: `projects/${PROJECT}/topics/price-invalidations` }], [['NAME'], t => [t.name]]);
    if (kind === 'subscriptions' && verb === 'list') return g.print(subs, [['NAME', 'TOPIC'], s => [s.name, s.topic]]);
    if (kind === 'subscriptions' && verb === 'describe') { const s = subs.find(x => x.name.endsWith(`/${name}`)); return s ? g.print(s) : g.error(`NOT_FOUND: Resource not found (resource=${name}).`); }
    if (kind === 'subscriptions' && ['delete', 'seek', 'update', 'modify-push-config'].includes(verb)) return g.error(`PERMISSION_DENIED: User not authorized to perform this action.`);
    return g.error(`Invalid choice: '${kind ?? ''}'.`, 2);
  };
}
function restricted() {
  const services = { run: 'run', iam: 'iam', secrets: 'secretmanager', artifacts: 'artifactregistry', builds: 'cloudbuild', deploy: 'clouddeploy', functions: 'cloudfunctions', dns: 'dns', storage: 'storage', scheduler: 'cloudscheduler', sql: 'cloudsql', spanner: 'spanner', bigtable: 'bigtable', kms: 'cloudkms' };
  return Object.fromEntries(Object.entries(services).map(([group, api]) => [group, (args, _io, g) => {
    const words = args.filter(a => /^[a-z][a-z-]*$/.test(a));
    const resource = (words[0] ?? group).replace(/-/g, '');
    const verb = words[1] === 'describe' ? 'get' : words[1] ?? 'list';
    return { err: [`ERROR: (gcloud.${[group, ...words.slice(0, 2)].join('.')}) PERMISSION_DENIED: Permission '${api}.${resource}.${verb}' denied on resource '//${api}.googleapis.com/projects/${g.project}' (or it may not exist). This command is authenticated as ${g.account} which is the active account specified by the [core/account] property.`], code: 1 };
  }]));
}
/** redis-cli against the pricing cache. Connecting anywhere else times out. */
function makeRedisCli(ctx) {
  return function redisCli(argv, io) {
    let host = '127.0.0.1', port = '6379';
    const words = [];
    for (let k = 0; k < argv.length; k++) {
      const a = argv[k];
      if (a === '-h') host = argv[++k]; else if (a === '-p') port = argv[++k]; else if (a === '-a' || a === '-n' || a === '--user' || a === '--pass') k++; else if (a === '--no-auth-warning' || a === '--raw' || a === '-c' || a === '--tls') continue; else words.push(a);
    }
    ctx.wait(1);
    const known = { '10.30.0.5': 'pricing', '10.30.0.12': 'sessions' }[host];
    if (!known || port !== '6379') { ctx.wait(10); return { err: [`Could not connect to Redis at ${host}:${port}: ${known ? 'Connection refused' : 'Connection timed out'}`], code: 1 }; }
    if (!words.length) return { err: ['Warning: Using a password with \'-a\' or \'-u\' option on the command line interface may not be safe.'], out: [`${host}:${port}> `] };
    const [cmd, ...rest] = words;
    const c = ctx.state.cache, s = ctx.state.last;
    const keys = known === 'pricing' ? Math.round(1_400_000 * (1 - c.miss) + 30000) : 412_553;
    switch (cmd.toUpperCase()) {
      case 'PING': return { out: ['PONG'] };
      case 'DBSIZE': return { out: [`(integer) ${keys}`] };
      case 'FLUSHALL': case 'FLUSHDB':
        if (known === 'pricing') flush(ctx, cmd.toLowerCase());
        ctx.event('redis.flush', { host, command: cmd.toUpperCase() });
        return { out: ['OK'] };
      case 'INFO': {
        const section = (rest[0] ?? 'default').toLowerCase();
        const secs = s.services['pricing-api']?.rps ?? 0;
        const hits = c.hits + Math.round(secs * (1 - c.miss) * 12 * 60), misses = c.misses + Math.round(secs * c.miss * 12 * 60);
        const blocks = {
          server: ['# Server', 'redis_version:7.0.15', 'redis_mode:standalone', 'os:Linux 5.15.0 x86_64', 'uptime_in_seconds:' + (c.flushed.some(f => f.how === 'failover') ? 60 : 13_502_201), 'uptime_in_days:' + (c.flushed.some(f => f.how === 'failover') ? 0 : 156)],
          clients: ['# Clients', `connected_clients:${known === 'pricing' ? 1843 : 96}`, 'blocked_clients:0'],
          memory: ['# Memory', `used_memory:${keys * 1640}`, `used_memory_human:${(keys * 1640 / 1024 ** 3).toFixed(2)}G`, 'maxmemory:13958643712', 'maxmemory_human:13.00G', 'maxmemory_policy:allkeys-lru'],
          stats: ['# Stats', `total_connections_received:${88_310_224}`, `instantaneous_ops_per_sec:${Math.round(secs * 12)}`, `keyspace_hits:${hits}`, `keyspace_misses:${misses}`, 'evicted_keys:0', `expired_keys:${2_331_804_117 + Math.round(ctx.t * 900)}`],
          replication: ['# Replication', 'role:master', 'connected_slaves:1'],
          keyspace: ['# Keyspace', `db0:keys=${keys},expires=${keys - 30000},avg_ttl=${Math.round(Math.min(s.ttl, 900) * 500)}`],
        };
        const pick = section === 'default' || section === 'all' || section === 'everything' ? Object.keys(blocks) : [section];
        return { out: pick.flatMap(k => [...(blocks[k] ?? []), '']).slice(0, -1).map(l => `${l}\r`.replace(/\r$/, '')) };
      }
      case 'TTL': return { out: [`(integer) ${/^price:/.test(rest[0] ?? '') ? Math.max(1, Math.round(Math.min(s.ttl, 900) * 0.6)) : -2}`] };
      case 'GET': return { out: [/^price:/.test(rest[0] ?? '') ? `"{\\"amount\\":2499,\\"currency\\":\\"USD\\",\\"promo\\":null}"` : '(nil)'] };
      case 'KEYS': return { err: [], out: ['(error) ERR KEYS is disabled on this instance (rename-command); use SCAN'] };
      case 'SCAN': return { out: ['1) "3848291"', '2)  1) "price:SKU-10442:US"', '    2) "price:SKU-88213:US"', '    3) "price:SKU-20931:CA"', '    4) "price:SKU-55120:US"'] };
      case 'CONFIG': return (rest[0] ?? '').toUpperCase() === 'GET' ? { out: [`1) "${rest[1] ?? ''}"`, '2) ""'] } : { out: ['(error) ERR unknown command \'CONFIG\', with args beginning with: '] };
      case 'SLOWLOG': return { out: ['(empty array)'] };
      default: return { out: [`(error) ERR unknown command '${cmd}', with args beginning with: ${rest.slice(0, 2).map(a => `'${a}' `).join('')}`] };
    }
  };
}

// ---------- history and repo ----------

function gitLog(v) {
  const H = 3600;
  return [
    { sha: 'a0e9c4d71f2b83e5c6d0a9b4e71f3c2d8b5a6e90', author: v.author[0], email: `${v.author[1]}@quillmart.com`, t: -2 * H - 22 * 60, subject: `pricing: cut price cache TTL to ${v.ttl}s so promo changes show up faster (${v.ticket})`, body: `Merchandising reported promo prices taking up to an hour to appear.\nArgo syncs the ConfigMap; pods pick it up on their next restart.`, diff: `diff --git a/k8s/pricing/pricing-api/configmap.yaml b/k8s/pricing/pricing-api/configmap.yaml\nindex 3c1d9a2..7f0e4b8 100644\n--- a/k8s/pricing/pricing-api/configmap.yaml\n+++ b/k8s/pricing/pricing-api/configmap.yaml\n@@ -5,7 +5,7 @@ metadata:\n   labels:\n     app: pricing-api\n data:\n-  PRICE_CACHE_TTL_SECONDS: "3600"\n+  PRICE_CACHE_TTL_SECONDS: "${v.ttl}"\n   PRICE_CACHE_MAX_KEYS: "2000000"\n   PROMO_BATCH_SIZE: "50"\n   LOG_LEVEL: "info"\n` },
    { sha: 'b18f2e6c04d9a7135e82f0c6b9d4a1e37c5f2d08', author: 'Aiko Tanaka', email: 'aiko.tanaka@quillmart.com', t: -3 * H - 50 * 60, subject: 'flags: document search.ranker_v2 rollout plan', diff: '' },
    { sha: 'c27d4a9e13b8f6025c7e19d4a0b3f86e2d9c1a57', author: 'Sam Okafor', email: 'sam.okafor@quillmart.com', t: -26 * H, subject: 'mesh: raise search-api route timeout to 2s (SRCH-512)', diff: `diff --git a/mesh/virtualservices.yaml b/mesh/virtualservices.yaml\nindex 91ac2d4..3be7f10 100644\n--- a/mesh/virtualservices.yaml\n+++ b/mesh/virtualservices.yaml\n@@ -25,7 +25,7 @@ spec:\n             host: search-api.search.svc.cluster.local\n             port:\n               number: 8080\n-      timeout: 1500ms\n+      timeout: 2s\n       retries:\n         attempts: 2\n         perTryTimeout: 1s\n` },
    { sha: 'd3b61f8a27c940e5d18b6a2f93c07e4b1d5a8c26', author: 'Lena Fischer', email: 'lena.fischer@quillmart.com', t: -3 * 24 * H, subject: 'checkout-api: v3.11.2', diff: '' },
    { sha: 'e49a02c5d8f71b36e0c4d9a2b7f15e38c6a0d4b1', author: 'Priya Raman', email: 'priya.raman@quillmart.com', t: -6 * 24 * H, subject: 'pricing-api: v6.4.1', diff: '' },
    { sha: 'f50b13d6e9a82c47f1d5e0b3c8a26f49d7b1e5c2', author: 'Dev Patel', email: 'dev.patel@quillmart.com', t: -9 * 24 * H, subject: 'promo-engine: pin HPA max to promo-pg connection budget (PROMO-208)', diff: '' },
    { sha: '061c24e7f0b93d58a2e6f1c4d9b37a50e8c2f6d3', author: 'Sam Okafor', email: 'sam.okafor@quillmart.com', t: -15 * 24 * H, subject: 'catalog: add recs-api owner', diff: '' },
    { sha: '172d35f801ca4e69b3f702d5eac48b61f9d307e4', author: 'Priya Raman', email: 'priya.raman@quillmart.com', t: -41 * 24 * H, subject: 'flags: add pricing.cache_ttl_override (PRICE-640)', diff: '' },
  ];
}
/** Swaps the canonical variant's details in the checkout for this variant's, before anything reads it. */
function applyVariant(fs, v) {
  if (v.ttl === 60) return;
  const swaps = [[/PRICE-812/g, v.ticket], [/10\.52\.14\.9/g, v.ip], [/pricing-warmer-1/g, v.vm]];
  for (const p of fs.list()) {
    let text = fs.read(p), next = text;
    for (const [re, to] of swaps) next = next.replace(re, to);
    if (p === 'k8s/pricing/pricing-api/configmap.yaml') next = next.replace(/PRICE_CACHE_TTL_SECONDS: "60"/, `PRICE_CACHE_TTL_SECONDS: "${v.ttl}"`);
    if (p === 'k8s/promo/promo-engine/deployment.yaml') next = next.replace(/replicas: 5/, `replicas: ${v.promoPods}`);
    if (p === 'k8s/promo/promo-engine/hpa.yaml') next = next.replace(/maxReplicas: 5/, `maxReplicas: ${v.promoPods}`).replace(/don't go above 6/, `don't go above ${v.promoDbPods}`);
    if (next !== text) fs.write(p, next);
  }
}
/**
 * Sizes promo-engine so that, at this variant's TTL and with the warmer still running, the peak has
 * just tipped it over: about a third of checkouts failing when the session starts. Every variant
 * then starts from the same place, whatever its TTL and pod count.
 */
function calibrate(state) {
  const promo = state.mesh.services['promo-engine'];
  const at = (perPod) => {
    promo.perPod = perPod;
    const shadow = structuredClone(state);
    for (let k = 0; k < 8; k++) compute(shadow, 0);
    return compute(shadow, 0).journeys.checkout.err;
  };
  let lo = 5, hi = promo.perPod * 3;
  for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (at(mid) > 0.3) lo = mid; else hi = mid; }
  promo.perPod = Math.round(hi * 10) / 10;
}
/** Two hours of the graph before the session, a minute at a time, so metrics have a past. */
function prehistory(state) {
  const saved = { ttl: effectiveTtl, miss: state.cache.miss };
  const hist = [];
  const pricing = deploymentOf(state, 'pricing-api');
  const envNow = pricing.pods.map(p => p.env.PRICE_CACHE_TTL_SECONDS);
  const shadow = structuredClone(state);
  const ttlChange = pricing.revisions.at(-1).t;
  shadow.cache.miss = missBase(ORIGINAL_TTL) * 0.5;
  for (let t = -3 * 3600; t < 0; t += 60) {
    for (const p of deploymentOf(shadow, 'pricing-api').pods) p.env.PRICE_CACHE_TTL_SECONDS = t < ttlChange ? String(ORIGINAL_TTL) : envNow[0];
    shadow.cache.lastWarm = t;
    shadow.t = t;
    for (let k = 0; k < 6; k++) compute(shadow, t);
    hist.push(slim(compute(shadow, t)));
  }
  void saved;
  state.cache.miss = shadow.cache.miss;
  return hist;
}

export function createWorld({ home, fs, seed = 0 }) {
  const v = variant(seed);
  applyVariant(fs, v);
  const initial = Object.fromEntries(fs.list().map(p => [p, fs.read(p)]));
  const start = today('19:41:00');
  const state = buildState(v);
  state.t = 0;
  calibrate(state);
  state.history = prehistory(state);
  state.last = compute(state, 0);
  state.samples.push(slim(state.last));
  const programs = (ctx) => {
    const base = makeKubectl(ctx, hooksFor(ctx));
    const git = makeGit(ctx, { initial, remote: 'git@github.com:quillmart/platform.git', log: gitLog(v) });
    return {
      kubectl: withIstio(ctx, base, { yaml: kyaml, table, age }),
      gcloud: makeGcloud(ctx, { ...makeGkeGroups(ctx, { logs: (filter, opts) => logEntries(ctx, filter, opts), dashboards: [{ name: 'projects/418392016653/dashboards/2b7e11c0-storefront', displayName: 'Storefront — golden signals' }, { name: 'projects/418392016653/dashboards/9d40aa31-pricing', displayName: 'pricing-api / promo-engine' }] }), compute: computeGroup(ctx), redis: redisGroup(ctx), pubsub: pubsubGroup(ctx), ...restricted() }),
      curl: (makeCurl(ctx, {
        'slo.internal.quillmart.com': (req) => (req.path.startsWith('/api/v1/slos') ? { status: 200, body: `${JSON.stringify(sloBody(ctx), null, 2)}\n` } : { status: 404, body: '{"error":"not found"}\n' }),
        'prometheus.internal.quillmart.com': (req) => prometheus(ctx, req),
        'tracing.internal.quillmart.com': (req) => tracing(ctx, req),
        'flags.internal.quillmart.com': (req) => flagsApi(ctx, req),
        [v.ip]: (req) => warmEndpoint(ctx, req),
        'grafana.internal.quillmart.com': () => ({ status: 302, body: '<a href="https://sso.quillmart.com/oauth2/start?rd=https%3A%2F%2Fgrafana.internal.quillmart.com%2F">Found</a>.\n\n', contentType: 'text/html; charset=utf-8', headers: ['location: https://sso.quillmart.com/oauth2/start?rd=https%3A%2F%2Fgrafana.internal.quillmart.com%2F'] }),
        'www.quillmart.com': () => { const j = ctx.state.last.journeys.search; return { status: ctx.state.last.journeys.search.err > 0.5 ? 503 : 200, body: j.err > 0.5 ? 'upstream request timeout' : '<!doctype html><html><head><title>Quillmart</title></head><body>…</body></html>\n', contentType: 'text/html; charset=utf-8' }; },
      })),
      'redis-cli': makeRedisCli(ctx),
      git, gh: git.gh,
    };
  };
  const world = simulate({
    start, home, fs, state, programs,
    tick: step,
    hostname: 'qm-ops-3', user: 'morgan',
    env: { CLOUDSDK_CORE_PROJECT: PROJECT, EDITOR: 'vi', PROMETHEUS_URL: 'http://prometheus.internal.quillmart.com', JAEGER_URL: 'http://tracing.internal.quillmart.com' },
    report: (ctx) => report(ctx),
  });
  return { exec: world.exec, report: world.report, repository: world.repository };
}

// ---------- the report ----------

const within = (j, name) => j.p99 <= SLO[name].p99 && j.err <= SLO[name].err;
function report(ctx) {
  const state = ctx.state;
  const settled = settle(ctx);
  const samples = [...state.samples, ...settled.state.samples.slice(state.samples.length)];
  const good = (s) => within(s.journeys.checkout, 'checkout') && within(s.journeys.search, 'search');
  let recoveredAt = null;
  for (let k = samples.length - 1; k >= 0 && good(samples[k]); k--) recoveredAt = samples[k].t;
  const final = settled.state.last ?? state.last;
  const failed = { checkout: 0, search: 0 };
  let overSlo = 0;
  for (const s of samples.filter(x => x.t > 0 && x.t <= ctx.t)) {
    failed.checkout += s.journeys.checkout.rps * s.journeys.checkout.err * 10;
    failed.search += s.journeys.search.rps * s.journeys.search.err * 10;
    if (!good(s)) overSlo += 10;
  }
  const flag = settled.state.flags.find(f => f.key === 'pricing.cache_ttl_override');
  const ttls = effectiveTtl(settled.state);
  const configmap = settled.state.kube.contexts[PROD].namespaces.pricing.configmaps.find(c => c.name === 'pricing-config');
  const pricing = deploymentOf(settled.state, 'pricing-api');
  const template = pricing?.revisions.find(r => r.n === pricing.current)?.containers[0].env.find(e => e.name === 'PRICE_CACHE_TTL_SECONDS')?.value ?? null;
  const refundsLag = Math.round(settled.state.refunds.produced - settled.state.refunds.processed);
  return {
    variant: { ttl: state.variant.ttl, ticket: state.variant.ticket, vm: state.variant.vm, ip: state.variant.ip, promoPods: state.variant.promoPods, recs: state.variant.recs },
    recoveredAt,
    final: { checkout: final.journeys.checkout, search: final.journeys.search, miss: Number(final.miss.toFixed(3)), promoRho: Number((final.services['promo-engine']?.rho ?? 0).toFixed(2)) },
    ttl: { effective: ttls, flag: { enabled: flag.enabled, value: flag.value }, configmap: configmap?.data.PRICE_CACHE_TTL_SECONDS ?? null, deploymentEnv: template },
    vm: { status: settled.state.vm.status, deleted: Boolean(settled.state.vm.deleted), cron: settled.state.vm.cron },
    flushes: state.cache.flushed,
    refundsLag,
    proxyPods: readyPods(settled.state, 'legacy-auth-proxy').length,
    samples: samples.filter((_, k) => k % 3 === 0).map(s => [s.t, s.journeys.checkout.p99, Number(s.journeys.checkout.err.toFixed(3)), s.journeys.search.p99, Number(s.journeys.search.err.toFixed(3)), Number(s.miss.toFixed(3))]),
    impact: [
      { label: 'failed checkouts', value: Math.round(failed.checkout), unit: '' },
      { label: 'failed searches', value: Math.round(failed.search), unit: '' },
      { label: 'minutes over SLO', value: Math.round(overSlo / 6) / 10, unit: 'min' },
      { label: 'refunds delayed', value: Math.max(0, refundsLag), unit: '' },
      { label: 'minutes to recover', value: recoveredAt === null ? -1 : Math.round(recoveredAt / 6) / 10, unit: 'min' },
    ],
  };
}
