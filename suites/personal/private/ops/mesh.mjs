/**
 * A service graph under load, for estates where the symptom is several hops from the cause.
 *
 *   mesh = { services, edges, journeys, routes, samples }   plain data, kept in ctx.state.mesh
 *   meshStep(mesh, { pods, rps, calls }) -> the graph's state for one moment:
 *     services[name] = { load, served, capacity, rho, shed, p50, p99, err, rps }
 *     edges[key]     = { load, tries, attempts, fail, final, retryRps, timeoutMs }
 *     journeys[name] = { rps, p50, p99, err }
 *
 * A service has pods × perPod requests a second of CPU, and, when `concurrency` is set, pods ×
 * concurrency requests in flight: a caller waiting on a slow dependency runs out of workers and
 * sheds before its CPU is busy, which is what keeps a slow leaf from being hit harder. Scaling
 * that caller up takes the brake off.
 *
 * An edge is a call with the caller's own timeout and retries, and optionally a mesh route
 * (Envoy sidecar) with its own. When the route's timeout is shorter than the app's, the app never
 * sees its own timeout and its retry loop never fires; otherwise the two multiply. Every failed
 * attempt costs its timeout and comes back as load, which is how three layers of "retry up to 3
 * times" turn a slow leaf into an outage.
 */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Effective tries and per-try timeout on an edge, with the mesh route in front of the app's call. */
export function edgePolicy(edge, route) {
  if (route && route.timeoutMs !== undefined && route.timeoutMs < edge.appTimeoutMs) {
    // The sidecar gives up first; the app only ever sees one 504 per call and does not retry it.
    const tries = (route.retries ?? 0) + 1;
    return { tries, timeoutMs: Math.min(route.perTryTimeoutMs ?? route.timeoutMs, route.timeoutMs), app: false };
  }
  const tries = (edge.appRetries + 1) * ((route?.retries ?? 0) + 1);
  const timeoutMs = route?.perTryTimeoutMs ? Math.min(route.perTryTimeoutMs, edge.appTimeoutMs) : edge.appTimeoutMs;
  return { tries, timeoutMs, app: true };
}
/** Share of calls slower than `t`, for latencies spread log-normally between p50 and p99. */
function slowerThan(p50, p99, t) {
  if (!(p50 > 0)) return 0;
  const sigma = Math.max(0.05, Math.log(Math.max(p99, p50 * 1.01) / p50) / 2.326);
  const z = (Math.log(t) - Math.log(p50)) / sigma;
  return clamp(1 - phi(z), 0, 1);
}
/** The standard normal CDF (Abramowitz-Stegun 26.2.17). */
function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
/**
 * One moment of the graph. `pods(name)` gives ready pods; `calls(edge)` may override calls per
 * request (a cache miss rate); `rps(journey)` the offered load at the edge of the estate.
 */
export function meshStep(mesh, { pods, calls = (e) => e.calls, rps = (j) => j.rps, down = () => false }) {
  const names = Object.keys(mesh.services);
  const edges = mesh.edges.map(e => ({ ...e, key: `${e.from}>${e.to}`, calls: calls(e), policy: edgePolicy(e, e.bypassMesh ? null : mesh.routes[e.to]) }));
  const out = Object.fromEntries(names.map(n => [n, { load: 0, served: 0, capacity: 0, rho: 0, shed: 0, self50: 0, self99: 0, p50: 0, p99: 0, err: 0, rps: 0 }]));
  const ed = Object.fromEntries(edges.map(e => [e.key, { load: 0, tries: e.policy.tries, attempts: 1, f: 0, final: 0, retryRps: 0, timeoutMs: e.policy.timeoutMs, effective50: 0, effective99: 0 }]));
  const order = topo(names, edges);
  for (let round = 0; round < 12; round++) {
    // Load flows down: what each caller lets through, times calls, times attempts.
    for (const n of order) {
      const s = mesh.services[n], o = out[n];
      let load = 0;
      for (const j of mesh.journeys) if (j.path[0] === n) load += rps(j);
      for (const e of edges) if (e.to === n) load += out[e.from].served * e.calls * ed[e.key].attempts;
      const p = down(n) ? 0 : pods(n);
      const cpu = p * s.perPod;
      const inflight = s.concurrency ? p * s.concurrency / Math.max(0.001, (o.p50 || s.baseMs) / 1000) : Infinity;
      const capacity = Math.min(cpu, inflight);
      o.load = load; o.capacity = capacity;
      o.served = Math.min(load, capacity);
      o.shed = load > 0 ? 1 - o.served / load : 0;
      o.rho = cpu > 0 ? load / cpu : load > 0 ? Infinity : 0;
      const busy = Math.min(o.rho, 0.97);
      // A service that sheds (a bounded queue, `503 too many in-flight`) stays fast and fails the
      // excess at once; one that queues without bound gets slower and slower instead.
      // No pods at all is a fast 503 (no healthy upstream), not an ever-growing queue.
      const queued = s.sheds || p === 0 ? 0 : o.rho > 1 ? Math.min(60000, (o.rho - 1) * 1500) : 0;
      o.self50 = p === 0 ? 2 : s.baseMs / (1 - busy) + queued;
      o.self99 = p === 0 ? 5 : o.self50 * (s.tail ?? 3) + queued * 2;
    }
    // Latency and failure flow up: a caller waits on its calls and inherits their failures.
    for (const n of [...order].reverse()) {
      const o = out[n];
      let p50 = o.self50, p99 = o.self99, ok = 1 - o.shed;
      if (!mesh.services[n] || (down(n) || pods(n) === 0)) { o.p50 = 2; o.p99 = 5; o.err = 1; continue; }
      for (const e of edges.filter(x => x.from === n)) {
        const d = out[e.to], x = ed[e.key], T = x.timeoutMs;
        const f = d.err + (1 - d.err) * slowerThan(d.p50, d.p99, T);
        x.f = round ? 0.5 * x.f + 0.5 * f : f;
        let attempts = 0;
        for (let k = 0; k < x.tries; k++) attempts += x.f ** k;
        x.attempts = attempts;
        x.final = x.f ** x.tries;
        x.effective50 = Math.min(d.p50, T) + (attempts - 1) * T;
        // A failed try costs what the callee took, up to the timeout; fast 503s cost little.
        const tryCost = Math.min(d.p99, T);
        x.effective99 = tryCost * (x.f > 0.05 ? 1 + Math.min(x.tries - 1, Math.ceil(attempts)) : 1);
        p50 += e.calls * x.effective50;
        p99 += Math.max(0, e.calls - 1) * x.effective50 + x.effective99;
        if (!e.optional) ok *= e.calls >= 1 ? (1 - x.final) ** e.calls : 1 - x.final * e.calls;
      }
      o.p50 = p50; o.p99 = Math.max(p99, p50 * 1.3); o.err = clamp(1 - ok, 0, 1);
    }
  }
  for (const e of edges) { const x = ed[e.key]; x.load = out[e.from].served * e.calls * x.attempts; x.retryRps = out[e.from].served * e.calls * (x.attempts - 1); }
  for (const n of names) out[n].rps = out[n].served;
  const journeys = {};
  for (const j of mesh.journeys) {
    let p50 = 0, p99 = 0, ok = 1;
    for (const n of j.path) { p50 += out[n].self50; p99 += out[n].self99 * 0.35; ok *= 1 - out[n].shed; if (down(n) || pods(n) === 0) ok = 0; }
    const last = edges.find(e => e.from === j.path.at(-1) && e.to === j.target);
    if (last) { const x = ed[last.key]; p50 += x.effective50; p99 += x.effective99; ok *= 1 - x.final; }
    // The gateway gives up on anything still waiting after its own timeout.
    if (j.timeoutMs && p99 > j.timeoutMs) { ok *= 1 - clamp((p99 - j.timeoutMs) / p99, 0, 0.5); p99 = j.timeoutMs; }
    p99 = Math.max(p99, p50 * 1.3);
    if (j.timeoutMs && p99 > j.timeoutMs) p99 = j.timeoutMs;
    journeys[j.name] = { rps: rps(j), p50: Math.round(Math.min(p50, p99 / 1.3)), p99: Math.round(p99), err: clamp(1 - ok, 0, 1) };
  }
  return { services: out, edges: ed, journeys };
}
function topo(names, edges) {
  const seen = new Set(), order = [];
  const visit = (n) => { if (seen.has(n)) return; seen.add(n); for (const e of edges) if (e.to === n) visit(e.from); order.push(n); };
  for (const n of names) visit(n);
  return order;
}

// ---------- traces ----------

const hex = (seed, len) => { let h = seed >>> 0, s = ''; while (s.length < len) { h = (Math.imul(h ^ (h >>> 13), 1540483477) + 0x6b43a9b5) >>> 0; s += h.toString(16).padStart(8, '0'); } return s.slice(0, len); };
/**
 * Sampled traces for a journey as a Jaeger query returns them: one span per hop and per attempt,
 * failed attempts tagged with the error Envoy reports, durations from the graph's current state.
 */
export function traces(mesh, state, { journey, count, t0Micros, seed, spanOps, calls: callsOf = (e) => e.calls }) {
  const j = mesh.journeys.find(x => x.name === journey);
  const out = [];
  for (let k = 0; k < count; k++) {
    let rnd = (seed + k * 7919) >>> 0;
    const next = () => { rnd = (Math.imul(rnd ^ (rnd >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return rnd / 4294967296; };
    const traceID = hex(rnd + 17, 32);
    const spans = [], processes = {};
    const proc = (service) => {
      const found = Object.entries(processes).find(([, p]) => p.serviceName === service);
      if (found) return found[0];
      const id = `p${Object.keys(processes).length + 1}`;
      const pod = `${service}-${hex(rnd + service.length * 31, 10).replace(/\d/g, c => 'bcdfghjklm'[Number(c)])}-${hex(rnd + service.length, 5).replace(/\d/g, c => 'npqrstvwxz'[Number(c)])}`;
      processes[id] = { serviceName: service, tags: [{ key: 'host.name', type: 'string', value: pod }, { key: 'k8s.namespace.name', type: 'string', value: mesh.services[service]?.ns ?? 'default' }, { key: 'service.version', type: 'string', value: mesh.services[service]?.version ?? '' }, { key: 'telemetry.sdk.language', type: 'string', value: mesh.services[service]?.lang ?? 'go' }] };
      return id;
    };
    const span = (service, op, start, parent, tags = []) => {
      const spanID = hex(rnd + spans.length * 131 + 9, 16);
      const s = { traceID, spanID, flags: 1, operationName: op, references: parent ? [{ refType: 'CHILD_OF', traceID, spanID: parent }] : [], startTime: Math.round(start), duration: 1, tags: [{ key: 'span.kind', type: 'string', value: 'server' }, ...tags], logs: [], processID: proc(service), warnings: null };
      spans.push(s);
      return s;
    };
    // A hop's own span, then its calls in turn, each attempt as the caller saw it.
    const visit = (service, start, parent, slow = false) => {
      const st = state.services[service];
      const me = span(service, spanOps[service] ?? 'HTTP GET', start, parent, [{ key: 'http.response.status_code', type: 'int64', value: 200 }]);
      let cursor = start + st.self50 * (0.4 + next() * 0.5) * 1000;
      let failed = false;
      for (const e of mesh.edges.filter(x => x.from === service)) {
        const x = state.edges[`${e.from}>${e.to}`];
        const rate = callsOf(e);
        // A call that timed out was, almost always, the slow path: the cache miss, not the hit.
        const calls = rate >= 1 ? Math.round(rate) : (slow || next() < rate ? 1 : 0);
        for (let c = 0; c < calls; c++) {
          let ok = false;
          for (let a = 0; a < x.tries && !ok; a++) {
            if (next() < x.f) {
              const callee = state.services[e.to];
              // Shed at once by an overloaded callee, or cut off by the caller's timeout while the
              // callee was still working on it (its own calls then show inside the failed span).
              const shed = callee.shed > 0 && next() < callee.shed / Math.max(x.f, 1e-9);
              const tags = [{ key: 'error', type: 'bool', value: true }, { key: 'http.response.status_code', type: 'int64', value: shed ? 503 : 504 }, { key: 'upstream_cluster', type: 'string', value: `outbound|8080||${e.to}.${mesh.services[e.to]?.ns}.svc.cluster.local` }, { key: 'response_flags', type: 'string', value: shed ? 'UO' : 'UT' }, ...(a ? [{ key: 'retry.attempt', type: 'int64', value: a }] : [])];
              let d;
              if (shed) { d = 1 + next() * 3; span(e.to, spanOps[e.to] ?? 'HTTP GET', cursor, me.spanID, tags).duration = Math.round(d * 1000); }
              else {
                const first = spans.length;
                visit(e.to, cursor, me.spanID, true);
                d = x.timeoutMs * (0.98 + next() * 0.04);
                const s = spans[first];
                s.duration = Math.round(d * 1000);
                s.tags = [...s.tags.filter(t => t.key !== 'http.response.status_code' && t.key !== 'error'), ...tags];
              }
              cursor += d * 1000;
            } else { cursor += visit(e.to, cursor, me.spanID) * 1000; ok = true; }
          }
          if (!ok && !e.optional) failed = true;
        }
      }
      const total = (cursor - start) / 1000 + st.self50 * 0.3;
      me.duration = Math.max(1, Math.round(total * 1000));
      if (failed) { me.tags = me.tags.map(t => (t.key === 'http.response.status_code' ? { ...t, value: 503 } : t)); me.tags.push({ key: 'error', type: 'bool', value: true }); }
      return total;
    };
    const start = t0Micros - k * 7_300_000 - Math.round(next() * 5_000_000);
    const chain = [];
    let cursor = start, parent = null;
    for (const n of j.path) {
      const s = span(n, spanOps[n] ?? 'ingress', cursor, parent);
      chain.push(s); parent = s.spanID;
      cursor += state.services[n].self50 * 400;
    }
    const inner = visit(j.target, cursor, parent);
    let total = inner;
    for (const s of [...chain].reverse()) { total += 0.8 + next(); s.duration = Math.round(total * 1000); }
    out.push({ traceID, spans, processes, warnings: null });
  }
  return out;
}

// ---------- PromQL, the part incident queries use ----------

/**
 * Evaluates the PromQL an operator types during an incident against a table of series:
 * selectors with =, !=, =~, !~ matchers; rate/irate/increase over a range; sum/avg/max/min with
 * `by`/`without`; histogram_quantile over a `_bucket` selector; + - * / between vectors or scalars;
 * topk. `series(name)` returns [{ labels, value }] for a metric right now, where counters give their
 * per-second rate and histograms give { p50, p90, p99 }. Anything else is the parse error
 * Prometheus would return.
 */
export function promql(query, series) {
  const p = new PromParser(query);
  const node = p.parse();
  return evalNode(node, series);
}
class PromError extends Error {}
export { PromError };
class PromParser {
  constructor(src) { this.src = src; this.k = 0; }
  fail(msg) { throw new PromError(`1:${this.k + 1}: parse error: ${msg}`); }
  ws() { while (/\s/.test(this.src[this.k] ?? '')) this.k++; }
  parse() { const n = this.additive(); this.ws(); if (this.k < this.src.length) this.fail(`unexpected character: '${this.src[this.k]}'`); return n; }
  additive() {
    let left = this.multiplicative();
    for (;;) { this.ws(); const c = this.src[this.k]; if (c === '+' || c === '-') { this.k++; left = { t: 'bin', op: c, left, right: this.multiplicative() }; } else return left; }
  }
  multiplicative() {
    let left = this.unary();
    for (;;) { this.ws(); const c = this.src[this.k]; if ((c === '*' || c === '/') && this.src[this.k + 1] !== '/') { this.k++; left = { t: 'bin', op: c, left, right: this.unary() }; } else return left; }
  }
  unary() {
    this.ws();
    const c = this.src[this.k];
    if (c === '(') { this.k++; const n = this.additive(); this.ws(); if (this.src[this.k] !== ')') this.fail('unclosed left parenthesis'); this.k++; return n; }
    const num = /^\d+(\.\d+)?/.exec(this.src.slice(this.k));
    if (num) { this.k += num[0].length; return { t: 'num', v: Number(num[0]) }; }
    const id = /^[a-zA-Z_:][\w:]*/.exec(this.src.slice(this.k));
    if (!id) this.fail(`unexpected character: '${c ?? 'EOF'}'`);
    this.k += id[0].length;
    const name = id[0];
    this.ws();
    const AGG = ['sum', 'avg', 'max', 'min', 'count', 'topk', 'bottomk'];
    const FUN = ['rate', 'irate', 'increase', 'histogram_quantile', 'delta', 'avg_over_time', 'max_over_time', 'sum_over_time', 'abs', 'round', 'clamp_min', 'clamp_max', 'deriv', 'label_replace', 'absent', 'vector', 'scalar', 'time'];
    if (AGG.includes(name)) {
      let by = null, without = false;
      const grouping = () => { this.ws(); const m = /^(by|without)\s*\(([^)]*)\)/.exec(this.src.slice(this.k)); if (m) { this.k += m[0].length; by = m[2].split(',').map(s => s.trim()).filter(Boolean); without = m[1] === 'without'; } };
      grouping();
      this.ws();
      if (this.src[this.k] !== '(') this.fail(`unexpected identifier "${name}"`);
      this.k++;
      let param = null;
      if (name === 'topk' || name === 'bottomk') { param = this.additive(); this.ws(); if (this.src[this.k] !== ',') this.fail('expected ","'); this.k++; }
      const arg = this.additive();
      this.ws();
      if (this.src[this.k] !== ')') this.fail('unclosed left parenthesis');
      this.k++;
      grouping();
      return { t: 'agg', op: name, by, without, arg, param };
    }
    if (this.src[this.k] === '(') {
      if (!FUN.includes(name)) this.fail(`unknown function with name "${name}"`);
      this.k++;
      const args = [];
      this.ws();
      while (this.src[this.k] !== ')') {
        args.push(this.additive());
        this.ws();
        if (this.src[this.k] === ',') { this.k++; continue; }
        if (this.src[this.k] !== ')') this.fail('unclosed left parenthesis');
      }
      this.k++;
      return { t: 'fn', name, args };
    }
    // A selector: name{matchers}[range]
    const matchers = [];
    if (this.src[this.k] === '{') {
      this.k++;
      for (;;) {
        this.ws();
        if (this.src[this.k] === '}') { this.k++; break; }
        const m = /^([a-zA-Z_]\w*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"\s*,?/.exec(this.src.slice(this.k));
        if (!m) this.fail(`unexpected character inside braces: '${this.src[this.k]}'`);
        this.k += m[0].length;
        matchers.push({ label: m[1], op: m[2], value: m[3] });
      }
    }
    let range = null;
    this.ws();
    if (this.src[this.k] === '[') { const m = /^\[(\d+)([smhd])\]/.exec(this.src.slice(this.k)); if (!m) this.fail('bad duration syntax'); this.k += m[0].length; range = Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]]; }
    return { t: 'sel', name, matchers, range };
  }
}
const matches = (labels, m) => {
  const v = labels[m.label] ?? '';
  if (m.op === '=') return v === m.value;
  if (m.op === '!=') return v !== m.value;
  const re = new RegExp(`^(?:${m.value})$`);
  return m.op === '=~' ? re.test(v) : !re.test(v);
};
function evalNode(n, series) {
  switch (n.t) {
    case 'num': return { scalar: n.v };
    case 'sel': {
      const all = series(n.name.replace(/_bucket$/, '_hist').replace(/_(sum|count)$/, (m) => m));
      if (!all) return { vector: [] };
      const picked = all.filter(s => n.matchers.every(m => matches({ __name__: n.name, ...s.labels }, m)));
      return { vector: picked.map(s => ({ labels: { __name__: n.name, ...s.labels }, value: s.value })), range: n.range, name: n.name };
    }
    case 'fn': {
      if (n.name === 'histogram_quantile') {
        const q = evalNode(n.args[0], series).scalar ?? 0.99;
        const v = evalNode(n.args[1], series);
        return { vector: (v.vector ?? []).map(s => ({ labels: Object.fromEntries(Object.entries(s.labels).filter(([k]) => k !== 'le' && k !== '__name__')), value: typeof s.value === 'object' ? (q >= 0.99 ? s.value.p99 : q >= 0.9 ? s.value.p90 : s.value.p50) : NaN })) };
      }
      if (n.name === 'time') return { scalar: Date.now() / 1000 };
      if (n.name === 'vector') return { vector: [{ labels: {}, value: evalNode(n.args[0], series).scalar }] };
      const v = evalNode(n.args[0], series);
      if (['rate', 'irate', 'increase', 'delta', 'deriv', 'avg_over_time', 'max_over_time', 'sum_over_time'].includes(n.name) && !v.range) throw new PromError(`1:1: parse error: ranges only allowed for vector selectors`);
      const f = { increase: (x) => x * v.range, delta: (x) => x * v.range, sum_over_time: (x) => x * v.range / 15, abs: Math.abs, round: Math.round }[n.name] ?? ((x) => x);
      return { vector: (v.vector ?? []).map(s => ({ labels: n.name === 'rate' || n.name === 'irate' || n.name === 'increase' ? Object.fromEntries(Object.entries(s.labels).filter(([k]) => k !== '__name__')) : s.labels, value: typeof s.value === 'object' ? s.value : f(s.value) })) };
    }
    case 'agg': {
      const v = evalNode(n.arg, series).vector ?? [];
      const key = (labels) => { const keep = n.by ? (n.without ? Object.keys(labels).filter(k => !n.by.includes(k) && k !== '__name__') : n.by) : []; return Object.fromEntries(keep.filter(k => k in labels).map(k => [k, labels[k]])); };
      if (n.op === 'topk' || n.op === 'bottomk') {
        const k = evalNode(n.param, series).scalar ?? 1;
        return { vector: [...v].sort((a, b) => (n.op === 'topk' ? b.value - a.value : a.value - b.value)).slice(0, k) };
      }
      const groups = new Map();
      for (const s of v) { const labels = key(s.labels); const id = JSON.stringify(labels); if (!groups.has(id)) groups.set(id, { labels, values: [] }); groups.get(id).values.push(s.value); }
      return { vector: [...groups.values()].map(g => {
        if (typeof g.values[0] === 'object') return { labels: g.labels, value: g.values.reduce((a, b) => ({ p50: Math.max(a.p50, b.p50), p90: Math.max(a.p90, b.p90), p99: Math.max(a.p99, b.p99) })) };
        const sum = g.values.reduce((a, b) => a + b, 0);
        return { labels: g.labels, value: { sum, avg: sum / g.values.length, max: Math.max(...g.values), min: Math.min(...g.values), count: g.values.length }[n.op] };
      }) };
    }
    case 'bin': {
      const l = evalNode(n.left, series), r = evalNode(n.right, series);
      const op = (a, b) => ({ '+': a + b, '-': a - b, '*': a * b, '/': b === 0 ? NaN : a / b }[n.op]);
      if (l.scalar !== undefined && r.scalar !== undefined) return { scalar: op(l.scalar, r.scalar) };
      if (l.scalar !== undefined) return { vector: r.vector.map(s => ({ labels: s.labels, value: op(l.scalar, s.value) })) };
      if (r.scalar !== undefined) return { vector: l.vector.map(s => ({ labels: s.labels, value: op(s.value, r.scalar) })) };
      const strip = (labels) => JSON.stringify(Object.fromEntries(Object.entries(labels).filter(([k]) => k !== '__name__').sort()));
      const right = new Map(r.vector.map(s => [strip(s.labels), s]));
      return { vector: l.vector.flatMap(s => { const m = right.get(strip(s.labels)); return m ? [{ labels: Object.fromEntries(Object.entries(s.labels).filter(([k]) => k !== '__name__')), value: op(s.value, m.value) }] : []; }) };
    }
  }
  return { vector: [] };
}

// ---------- Istio routing, next to kubectl ----------

const VS = ['virtualservice', 'virtualservices', 'vs', 'virtualservices.networking.istio.io', 'virtualservice.networking.istio.io'];
const DR = ['destinationrule', 'destinationrules', 'dr', 'destinationrules.networking.istio.io', 'destinationrule.networking.istio.io'];
const ms = (text) => { const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(String(text ?? '')); return m ? Number(m[1]) * { ms: 1, s: 1000, m: 60000 }[m[2]] : undefined; };
const dur = (msv) => (msv === undefined ? undefined : msv % 1000 === 0 ? `${msv / 1000}s` : `${msv}ms`);
/** A VirtualService as the API server returns it. */
export function virtualService(v, cluster, t, at) {
  return {
    apiVersion: 'networking.istio.io/v1beta1', kind: 'VirtualService',
    metadata: { ...(v.annotations ? { annotations: v.annotations } : {}), creationTimestamp: at(v.created), generation: v.generation, name: v.name, namespace: v.ns, resourceVersion: String(4418200 + v.generation * 13 + v.name.length), uid: v.uid },
    spec: { hosts: [v.host], http: [{ route: [{ destination: { host: v.host, port: { number: 8080 } } }], ...(v.timeoutMs !== undefined ? { timeout: dur(v.timeoutMs) } : {}), ...(v.retries !== undefined ? { retries: { attempts: v.retries, ...(v.perTryTimeoutMs ? { perTryTimeout: dur(v.perTryTimeoutMs) } : {}), retryOn: v.retryOn ?? '5xx,reset,connect-failure,refused-stream' } } : {}) }] },
  };
}
/**
 * Wraps kubectl with the Istio kinds it does not know: VirtualService and DestinationRule. Routes
 * live in ctx.state.mesh.vs as { name, ns, host, service, timeoutMs, retries, perTryTimeoutMs };
 * a change here changes ctx.state.mesh.routes, which the graph reads every tick.
 */
export function withIstio(ctx, kubectl, { yaml, table, age }) {
  const mesh = () => ctx.state.mesh;
  const sync = () => { mesh().routes = Object.fromEntries(mesh().vs.filter(v => !v.deleted).map(v => [v.service, { timeoutMs: v.timeoutMs, retries: v.retries, perTryTimeoutMs: v.perTryTimeoutMs }])); };
  return function istioKubectl(argv, io) {
    const words = argv.filter((a, k) => !a.startsWith('-') && !['-n', '--namespace', '-o', '--output', '-p', '--patch', '--type', '-f', '--filename', '--context', '-l'].includes(argv[k - 1]));
    const [verb, kindWord, nameWord] = words;
    const kindArg = kindWord?.includes('/') ? kindWord.split('/')[0] : kindWord;
    const name = kindWord?.includes('/') ? kindWord.split('/')[1] : nameWord;
    const isVs = VS.includes(kindArg ?? ''), isDr = DR.includes(kindArg ?? '');
    const flag = (...n) => { for (let k = 0; k < argv.length; k++) { for (const x of n) { if (argv[k] === x) return argv[k + 1]; if (argv[k].startsWith(`${x}=`)) return argv[k].slice(x.length + 1); } } return undefined; };
    const ns = flag('-n', '--namespace') ?? 'default';
    const all = argv.includes('-A') || argv.includes('--all-namespaces');
    const output = flag('-o', '--output');
    if (verb === 'apply' && (flag('-f', '--filename'))) {
      const file = flag('-f', '--filename');
      const text = file === '-' ? [...(io.stdin ?? [])].join('\n') : io.sh.readFile(file);
      if (text !== null && /kind:\s*(VirtualService|DestinationRule)/.test(text)) {
        ctx.wait(1);
        const out = [];
        for (const doc of text.split(/^---\s*$/m)) {
          const kind = /^kind:\s*(\S+)/m.exec(doc)?.[1];
          const vname = /^metadata:\s*\n(?:\s+.*\n)*?\s+name:\s*["']?([\w.-]+)/m.exec(doc)?.[1];
          const vns = /^metadata:\s*\n(?:\s+.*\n)*?\s+namespace:\s*["']?([\w.-]+)/m.exec(doc)?.[1] ?? ns;
          if (kind === 'DestinationRule') { out.push(`destinationrule.networking.istio.io/${vname} unchanged`); continue; }
          if (kind !== 'VirtualService') continue;
          const v = mesh().vs.find(x => x.name === vname && x.ns === vns && !x.deleted);
          if (!v) { out.push(`Error from server (Forbidden): virtualservices.networking.istio.io "${vname}" is forbidden: creating routing rules is restricted to the platform pipeline`); continue; }
          const next = { timeoutMs: ms(/^\s+timeout:\s*["']?([\w.]+)/m.exec(doc)?.[1]), retries: /attempts:\s*(\d+)/.exec(doc) ? Number(/attempts:\s*(\d+)/.exec(doc)[1]) : undefined, perTryTimeoutMs: ms(/perTryTimeout:\s*["']?([\w.]+)/.exec(doc)?.[1]) };
          const changed = next.timeoutMs !== v.timeoutMs || next.retries !== v.retries || next.perTryTimeoutMs !== v.perTryTimeoutMs;
          if (changed) { Object.assign(v, next); v.generation++; sync(); ctx.event('mesh.route', { name: v.name, namespace: v.ns, service: v.service, ...next, via: 'apply' }); }
          out.push(`virtualservice.networking.istio.io/${vname} ${changed ? 'configured' : 'unchanged'}`);
        }
        return { out };
      }
    }
    if (!isVs && !isDr) return kubectl(argv, io);
    ctx.wait(1);
    const list = (isVs ? mesh().vs.filter(v => !v.deleted && (all || v.ns === ns)) : mesh().dr.filter(d => all || d.ns === ns)).sort((a, b) => a.ns.localeCompare(b.ns) || a.name.localeCompare(b.name));
    const plural = isVs ? 'virtualservices.networking.istio.io' : 'destinationrules.networking.istio.io';
    if (verb === 'get') {
      const picked = name ? list.filter(v => v.name === name) : list;
      if (name && !picked.length) return { err: [`Error from server (NotFound): ${plural} "${name}" not found`], code: 1 };
      if (!picked.length) return { err: [`No resources found in ${ns} namespace.`] };
      const docs = picked.map(v => (isVs ? virtualService(v, null, ctx.t, (x) => ctx.at(x).toISOString().replace(/\.\d+Z$/, 'Z')) : destinationRule(v, (x) => ctx.at(x).toISOString().replace(/\.\d+Z$/, 'Z'))));
      if (output === 'yaml') return { out: name ? yaml(docs[0]) : yaml({ apiVersion: 'v1', items: docs, kind: 'List', metadata: { resourceVersion: '' } }) };
      if (output === 'json') return { out: JSON.stringify(name ? docs[0] : { apiVersion: 'v1', items: docs, kind: 'List', metadata: { resourceVersion: '' } }, null, 4).split('\n') };
      if (output === 'name') return { out: picked.map(v => `${plural}/${v.name}`) };
      if (isVs) return { out: table([...(all ? ['NAMESPACE'] : []), 'NAME', 'GATEWAYS', 'HOSTS', 'AGE'], picked.map(v => [...(all ? [v.ns] : []), v.name, v.gateways ? `["${v.gateways}"]` : '', `["${v.host}"]`, age(ctx.t - v.created)])) };
      return { out: table([...(all ? ['NAMESPACE'] : []), 'NAME', 'HOST', 'AGE'], picked.map(d => [...(all ? [d.ns] : []), d.name, d.host, age(ctx.t - d.created)])) };
    }
    const v = list.find(x => x.name === name);
    if (!name) return { err: ['error: resource(s) were provided, but no name was specified'], code: 1 };
    if (!v) return { err: [`Error from server (NotFound): ${plural} "${name}" not found`], code: 1 };
    if (verb === 'describe') {
      const doc = isVs ? virtualService(v, null, ctx.t, (x) => ctx.at(x).toISOString().replace(/\.\d+Z$/, 'Z')) : destinationRule(v, (x) => ctx.at(x).toISOString().replace(/\.\d+Z$/, 'Z'));
      return { out: [`Name:         ${v.name}`, `Namespace:    ${v.ns}`, 'Labels:       <none>', 'Annotations:  <none>', `API Version:  networking.istio.io/v1beta1`, `Kind:         ${isVs ? 'VirtualService' : 'DestinationRule'}`, 'Spec:', ...yaml(doc.spec).map(l => `  ${l}`), 'Events:  <none>'] };
    }
    if (verb === 'edit') return { err: ['Vim: Warning: Output is not to a terminal', 'Vim: Warning: Input is not from a terminal', '', 'Vim: Error reading input, exiting...', 'Edit cancelled, no changes made.'], code: 0 };
    if (verb === 'delete' && isVs) {
      v.deleted = true; sync();
      ctx.event('mesh.route', { name: v.name, namespace: v.ns, service: v.service, deleted: true });
      return { out: [`virtualservice.networking.istio.io "${v.name}" deleted`] };
    }
    if (verb === 'patch' && isVs) {
      const body = flag('-p', '--patch');
      let patch;
      try { patch = JSON.parse(body ?? ''); } catch { return { err: [`error: unable to parse "${body}": yaml: did not find expected node content`], code: 1 }; }
      const type = flag('--type') ?? 'strategic';
      if (type === 'strategic') return { err: [`Error from server (UnsupportedMediaType): the body of the request was in an unknown format - accepted media types include: application/json-patch+json, application/merge-patch+json, application/apply-patch+yaml`], code: 1 };
      const doc = virtualService(v, null, ctx.t, (x) => ctx.at(x).toISOString());
      if (type === 'json') {
        if (!Array.isArray(patch)) return { err: ['error: unable to parse patch: json: cannot unmarshal object into Go value of type jsonpatch.Patch'], code: 1 };
        for (const op of patch) {
          const parts = String(op.path ?? '').split('/').slice(1).map(p => (/^\d+$/.test(p) ? Number(p) : p));
          let target = doc;
          for (const p of parts.slice(0, -1)) { if (target[p] === undefined) return { err: [`The request is invalid: doc is missing path: "${op.path}": missing value`], code: 1 }; target = target[p]; }
          const last = parts.at(-1);
          if (op.op === 'remove') delete target[last]; else target[last] = op.value;
        }
      } else merge(doc, patch);
      const http = doc.spec?.http?.[0] ?? {};
      const next = { timeoutMs: ms(http.timeout), retries: http.retries?.attempts, perTryTimeoutMs: ms(http.retries?.perTryTimeout) };
      const changed = next.timeoutMs !== v.timeoutMs || next.retries !== v.retries || next.perTryTimeoutMs !== v.perTryTimeoutMs;
      if (changed) { Object.assign(v, next); v.generation++; sync(); ctx.event('mesh.route', { name: v.name, namespace: v.ns, service: v.service, ...next, via: 'patch' }); }
      return { out: [`virtualservice.networking.istio.io/${v.name} ${changed ? 'patched' : 'patched (no change)'}`] };
    }
    return { err: [`error: ${verb} is not supported for ${plural} from this kubeconfig; changes go through the platform pipeline`], code: 1 };
  };
}
function destinationRule(d, at) {
  return { apiVersion: 'networking.istio.io/v1beta1', kind: 'DestinationRule', metadata: { creationTimestamp: at(d.created), generation: 1, name: d.name, namespace: d.ns }, spec: { host: d.host, trafficPolicy: d.policy } };
}
function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (Array.isArray(v)) {
      // A merge patch replaces lists, except the one route list every patch aims at.
      if (Array.isArray(target[k]) && k === 'http') target[k] = v.map((x, i) => (target[k][i] ? merge(structuredClone(target[k][i]), x) : x));
      else target[k] = v;
    } else if (typeof v === 'object') { target[k] ??= {}; merge(target[k], v); }
    else target[k] = v;
  }
  return target;
}
