import {fixture, preserved, observeCases, check, bounded, toolChecks, pythonHygiene} from './helpers.mjs';
const original = fixture('crew-schedule');

const REFERENCE = `"""Choose which maintenance jobs each field crew takes this week."""
import heapq


def assign_crews(jobs, crews, gap):
    # A crew is a unit of flow moving forward in time: it idles along the time line or does a
    # job, which moves it from the job's start to its end plus travel. Each job carries one crew.
    times = sorted({job["start"] for job in jobs} | {job["end"] + gap for job in jobs})
    node = {t: i for i, t in enumerate(times)}
    size = len(times)
    to, cap, cost, head, nxt = [], [], [], [-1] * size, []

    def edge(u, v, c, w):
        for a, b, cc, ww in ((u, v, c, w), (v, u, 0, -w)):
            to.append(b)
            cap.append(cc)
            cost.append(ww)
            nxt.append(head[a])
            head[a] = len(to) - 1

    for i in range(size - 1):
        edge(i, i + 1, crews, 0)
    job_edge = []
    for job in jobs:
        job_edge.append(len(to))
        edge(node[job["start"]], node[job["end"] + gap], 1, -job["value"])

    # Every original edge points forward in time, so exact potentials come from one pass.
    potential = [0] * size
    for u in range(size):
        e = head[u]
        while e != -1:
            if cap[e] and to[e] > u and potential[u] + cost[e] < potential[to[e]]:
                potential[to[e]] = potential[u] + cost[e]
            e = nxt[e]

    inf = float("inf")
    for _ in range(min(crews, len(jobs))):
        dist = [inf] * size
        via = [-1] * size
        dist[0] = 0
        heap = [(0, 0)]
        while heap:
            d, u = heapq.heappop(heap)
            if d > dist[u]:
                continue
            e = head[u]
            while e != -1:
                if cap[e]:
                    v = to[e]
                    nd = d + cost[e] + potential[u] - potential[v]
                    if nd < dist[v]:
                        dist[v] = nd
                        via[v] = e
                        heapq.heappush(heap, (nd, v))
                e = nxt[e]
        if dist[size - 1] == inf:
            break
        for u in range(size):
            if dist[u] < inf:
                potential[u] += dist[u]
        v = size - 1
        while v != 0:
            e = via[v]
            cap[e] -= 1
            cap[e ^ 1] += 1
            v = to[e ^ 1]

    chosen = sorted((job for job, e in zip(jobs, job_edge) if cap[e] == 0), key=lambda job: job["start"])
    free = [(float("-inf"), crew) for crew in range(crews)]
    plan = [[] for _ in range(crews)]
    for job in chosen:
        # No more chosen jobs overlap than there are crews, so the crew free soonest is free in time.
        _, crew = heapq.heappop(free)
        plan[crew].append(job["id"])
        heapq.heappush(free, (job["end"] + gap, crew))
    return plan
`;
export const reference = {files: {...original, 'crews.py': REFERENCE}, answer: 'Plan all crews together as flow along the time line, then hand the chosen jobs to crews.'};
// The fixture's own starting code: the best plan for one crew, repeated on what is left. It passes check_public.py.
export const baseline = {files: original, answer: 'Gave each crew in turn the most valuable jobs it could do.'};

/**
 * The public week is arranged so the obvious plan is right on it: giving the first crew its best
 * possible week and the next crew the best of what is left happens to reach the maximum. Hidden:
 *   small  — boundary cases (a job starting exactly at end plus travel, no jobs, more crews than
 *            jobs) and random weeks where that crew-by-crew plan is right.
 *   joint  — weeks where the first crew's best week takes jobs the crews could share better; the
 *            maximum needs every crew planned together. Most also defeat most-valuable-job-first.
 *   large  — 800 to 1500 jobs across 5 to 20 crews. An exact search over which crew is free when
 *            runs out of CPU long before this.
 * Any valid plan with the maximum total passes. Every maximum was cross-checked: small and joint
 * against an exhaustive search over job subsets (at most `crews` overlapping), the generated weeks
 * against a separately written flow solver and, where it finishes, an exact search over crew states.
 */
const SMALL = [
  [[{"id":"A","start":0,"end":60,"value":5},{"id":"B","start":90,"end":150,"value":5},{"id":"C","start":89,"end":100,"value":4}],1,30,10],
  [[],2,15,0],
  [[{"id":"X","start":0,"end":100,"value":3},{"id":"Y","start":10,"end":90,"value":4},{"id":"Z","start":20,"end":80,"value":2}],4,0,9],
  [[{"id":"J01","start":24,"end":26,"value":3},{"id":"J02","start":24,"end":34,"value":1},{"id":"J03","start":9,"end":10,"value":5},{"id":"J04","start":15,"end":25,"value":7},{"id":"J05","start":22,"end":29,"value":7},{"id":"J06","start":23,"end":33,"value":8},{"id":"J07","start":29,"end":32,"value":6},{"id":"J08","start":3,"end":4,"value":3},{"id":"J09","start":15,"end":19,"value":5},{"id":"J10","start":21,"end":28,"value":5}],4,0,46],
  [[{"id":"J01","start":11,"end":20,"value":7},{"id":"J02","start":18,"end":22,"value":6},{"id":"J03","start":21,"end":22,"value":5},{"id":"J04","start":19,"end":22,"value":6},{"id":"J05","start":17,"end":27,"value":2},{"id":"J06","start":22,"end":26,"value":5},{"id":"J07","start":9,"end":11,"value":2},{"id":"J08","start":15,"end":23,"value":2},{"id":"J09","start":11,"end":13,"value":7},{"id":"J10","start":28,"end":31,"value":1}],3,2,34],
  [[{"id":"J01","start":12,"end":22,"value":9},{"id":"J02","start":3,"end":13,"value":9},{"id":"J03","start":8,"end":15,"value":4},{"id":"J04","start":29,"end":34,"value":7},{"id":"J05","start":8,"end":17,"value":5},{"id":"J06","start":17,"end":23,"value":1},{"id":"J07","start":25,"end":32,"value":6},{"id":"J08","start":0,"end":7,"value":3},{"id":"J09","start":1,"end":7,"value":8},{"id":"J10","start":11,"end":17,"value":5}],3,2,48],
  [[{"id":"J01","start":13,"end":18,"value":7},{"id":"J02","start":1,"end":5,"value":3},{"id":"J03","start":6,"end":7,"value":8},{"id":"J04","start":19,"end":24,"value":7},{"id":"J05","start":17,"end":23,"value":4},{"id":"J06","start":1,"end":7,"value":8},{"id":"J07","start":16,"end":19,"value":9},{"id":"J08","start":10,"end":12,"value":2},{"id":"J09","start":18,"end":21,"value":2}],4,2,48],
];
const JOINT = [
  [[{"id":"J01","start":20,"end":25,"value":1},{"id":"J02","start":13,"end":22,"value":6},{"id":"J03","start":13,"end":21,"value":6},{"id":"J04","start":18,"end":21,"value":4},{"id":"J05","start":9,"end":13,"value":7},{"id":"J06","start":22,"end":24,"value":6},{"id":"J07","start":17,"end":20,"value":6},{"id":"J08","start":29,"end":37,"value":3},{"id":"J09","start":17,"end":24,"value":8},{"id":"J10","start":6,"end":13,"value":9},{"id":"J11","start":18,"end":24,"value":2},{"id":"J12","start":23,"end":24,"value":8}],2,2,43],
  [[{"id":"J01","start":4,"end":7,"value":2},{"id":"J02","start":1,"end":5,"value":7},{"id":"J03","start":11,"end":14,"value":4},{"id":"J04","start":4,"end":5,"value":2},{"id":"J05","start":0,"end":2,"value":6},{"id":"J06","start":5,"end":7,"value":4},{"id":"J07","start":5,"end":6,"value":2},{"id":"J08","start":5,"end":6,"value":7},{"id":"J09","start":5,"end":8,"value":1},{"id":"J10","start":7,"end":11,"value":8},{"id":"J11","start":2,"end":6,"value":1},{"id":"J12","start":1,"end":3,"value":6}],2,2,33],
  [[{"id":"J01","start":7,"end":10,"value":8},{"id":"J02","start":8,"end":10,"value":8},{"id":"J03","start":3,"end":6,"value":2},{"id":"J04","start":5,"end":9,"value":1},{"id":"J05","start":10,"end":13,"value":6},{"id":"J06","start":4,"end":7,"value":5},{"id":"J07","start":9,"end":13,"value":9},{"id":"J08","start":0,"end":4,"value":5},{"id":"J09","start":8,"end":10,"value":8},{"id":"J10","start":3,"end":5,"value":8},{"id":"J11","start":0,"end":2,"value":3},{"id":"J12","start":5,"end":7,"value":1}],2,2,33],
  [[{"id":"J01","start":2,"end":4,"value":6},{"id":"J02","start":0,"end":4,"value":6},{"id":"J03","start":19,"end":24,"value":6},{"id":"J04","start":7,"end":9,"value":5},{"id":"J05","start":1,"end":4,"value":2},{"id":"J06","start":15,"end":18,"value":4},{"id":"J07","start":11,"end":13,"value":2},{"id":"J08","start":7,"end":12,"value":8},{"id":"J09","start":7,"end":10,"value":2},{"id":"J10","start":12,"end":15,"value":8},{"id":"J11","start":14,"end":20,"value":4},{"id":"J12","start":17,"end":20,"value":1},{"id":"J13","start":9,"end":14,"value":3}],3,1,54],
  [[{"id":"J01","start":0,"end":2,"value":5},{"id":"J02","start":24,"end":27,"value":2},{"id":"J03","start":10,"end":17,"value":6},{"id":"J04","start":7,"end":14,"value":3},{"id":"J05","start":3,"end":7,"value":6},{"id":"J06","start":3,"end":11,"value":5},{"id":"J07","start":12,"end":18,"value":5},{"id":"J08","start":4,"end":11,"value":2},{"id":"J09","start":14,"end":18,"value":4},{"id":"J10","start":19,"end":27,"value":2},{"id":"J11","start":8,"end":13,"value":3},{"id":"J12","start":28,"end":36,"value":8},{"id":"J13","start":15,"end":20,"value":9}],3,2,50],
  [[{"id":"J01","start":13,"end":16,"value":8},{"id":"J02","start":19,"end":25,"value":9},{"id":"J03","start":12,"end":14,"value":1},{"id":"J04","start":17,"end":20,"value":6},{"id":"J05","start":17,"end":22,"value":5},{"id":"J06","start":1,"end":5,"value":7},{"id":"J07","start":13,"end":16,"value":5},{"id":"J08","start":11,"end":14,"value":9},{"id":"J09","start":10,"end":16,"value":5},{"id":"J10","start":5,"end":8,"value":3},{"id":"J11","start":7,"end":13,"value":9},{"id":"J12","start":7,"end":8,"value":7},{"id":"J13","start":7,"end":12,"value":9}],3,2,63],
  [[{"id":"J01","start":10,"end":12,"value":9},{"id":"J02","start":7,"end":8,"value":3},{"id":"J03","start":2,"end":6,"value":6},{"id":"J04","start":5,"end":7,"value":3},{"id":"J05","start":6,"end":9,"value":2},{"id":"J06","start":2,"end":4,"value":9},{"id":"J07","start":2,"end":3,"value":5},{"id":"J08","start":1,"end":3,"value":7},{"id":"J09","start":6,"end":7,"value":2},{"id":"J10","start":4,"end":6,"value":6},{"id":"J11","start":9,"end":13,"value":4},{"id":"J12","start":8,"end":10,"value":7}],4,3,52],
];

function random(seed) {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
/** A week of requests in minutes from Monday 00:00, on 5-minute boundaries, lasting 30 minutes to 8 hours. */
function week(seed, count) {
  const next = random(seed);
  const pick = n => Math.floor(next() * n);
  return Array.from({length: count}, (_, k) => {
    const start = 5 * pick(7 * 24 * 12 - 96);
    return {id: `MW-${String(k + 1).padStart(4, '0')}`, start, end: start + 30 * (1 + pick(16)), value: 1 + pick(40)};
  });
}
const generated = (seed, count, crews, gap, best) => [week(seed, count), crews, gap, best];
const MEDIUM = [generated(11, 60, 2, 30, 953), generated(12, 120, 3, 30, 1849), generated(13, 400, 4, 45, 3987)];
const LARGE = [generated(19, 800, 5, 30, 6598), generated(15, 1500, 8, 30, 12101), generated(17, 1500, 12, 30, 15946), generated(18, 1200, 20, 15, 20279)];

/** The plan's total value, or the first reason it is not a plan at all. */
function planValue(plan, jobs, crews, gap) {
  if (!Array.isArray(plan) || plan.length !== crews) return {problem: `expected a list of ${crews} crew lists`};
  const byId = new Map(jobs.map(job => [job.id, job]));
  const seen = new Set();
  let value = 0;
  for (const [crew, ids] of plan.entries()) {
    if (!Array.isArray(ids)) return {problem: `crew ${crew} is not a list`};
    for (const id of ids) {
      if (!byId.has(id)) return {problem: `crew ${crew} has unknown job ${bounded(id, 40)}`};
      if (seen.has(id)) return {problem: `job ${id} is planned twice`};
      seen.add(id);
      value += byId.get(id).value;
    }
    const done = ids.map(id => byId.get(id)).sort((a, b) => a.start - b.start);
    for (let k = 1; k < done.length; k++) {
      if (done[k].start < done[k - 1].end + gap) return {problem: `crew ${crew} cannot do ${done[k].id} after ${done[k - 1].id}`};
    }
  }
  return {value};
}

async function group(python, id, cases, meaning) {
  const failures = [];
  for (const [n, [jobs, crews, gap, best]] of cases.entries()) {
    const r = await observeCases(python, {module: 'crews', function: 'assign_crews', args: [jobs, crews, gap]});
    const got = r.value?.[0];
    const outcome = !r.ok ? {problem: r.diagnostic} : got?.error !== null ? {problem: `raised ${got?.error}`} : planValue(got.output, jobs, crews, gap);
    if (outcome.value !== best) failures.push({case: n, jobs: jobs.length, crews, ...outcome, best});
  }
  return check(id, 'correctness', failures.length === 0, `${meaning}; failed ${failures.length} of ${cases.length}: ${bounded(failures, 1200)}`);
}

export async function grade({files, python, trace, lane, control, agent}) {
  const hygiene = await pythonHygiene(python, files, 'crews.py');
  return [
    ...hygiene,
    await group(python, 'small-weeks', SMALL, 'Boundary cases and small weeks where planning crew by crew happens to reach the maximum'),
    await group(python, 'needs-joint-plan', [...JOINT, ...MEDIUM], "Weeks of 12 to 400 jobs where the first crew's best week is not part of the best plan for all crews"),
    await group(python, 'large-weeks', LARGE, '800 to 1500 jobs across 5 to 20 crews, each call inside the 3-second CPU limit'),
    preserved(files, original, ['crews.py']),
    ...toolChecks(trace, ['crews.py', 'jobs.json'], 'check_public.py', false, {lane, control, agent}),
  ];
}
