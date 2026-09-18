import {fixture, preserved, observeCases, equal, check, toolChecks, pythonHygiene} from './helpers.mjs';
const original = fixture('duplicate-rule');

const SHARED = `RETRYABLE = ("timeout", "throttled", "upstream_5xx")
TERMINAL = ("cancelled", "succeeded")


def should_retry(job):
    if job.get("status") in TERMINAL:
        return False
    if job.get("error_kind") not in RETRYABLE:
        return False
    return job.get("attempts", 0) < job.get("max_attempts", 3)


should_retry_upload = should_retry
should_retry_convert = should_retry
should_retry_export = should_retry
`;
export const reference = {files:{...original,'retries.py':SHARED},answer:'Retry rule lives in one place; the three entry points alias it.'};
// Behaviourally wrong: export still retries a cancelled job, so correctness fails before design.
export const baseline = {files:{...original,'retries.py':SHARED.replace(
  'def should_retry(job):\n    if job.get("status") in TERMINAL:\n        return False\n',
  'def should_retry(job):\n')},answer:'Deduplicated the retry rule.'};

/** A job must be retried only when it is not terminal, failed for a retryable reason, and has attempts left. */
const decide = job => !['cancelled','succeeded'].includes(job.status)
  && ['timeout','throttled','upstream_5xx'].includes(job.error_kind)
  && (job.attempts ?? 0) < (job.max_attempts ?? 3);

/**
 * Named boundary cases rather than a cross product: each one is either side of a line one of the
 * drifted copies got wrong, and the grid would cost hundreds of interpreter round trips to say
 * the same thing.
 */
const JOBS = [
  // Attempt limit, where one copy used <= instead of <.
  {status:'failed',error_kind:'timeout',attempts:2,max_attempts:3},
  {status:'failed',error_kind:'timeout',attempts:3,max_attempts:3},
  {status:'failed',error_kind:'timeout',attempts:4,max_attempts:3},
  // Terminal status with attempts still left, where one copy skipped the status test.
  {status:'cancelled',error_kind:'timeout',attempts:0,max_attempts:3},
  {status:'succeeded',error_kind:'throttled',attempts:0,max_attempts:3},
  {status:'running',error_kind:'upstream_5xx',attempts:1,max_attempts:3},
  // Retryable set, both sides.
  {status:'failed',error_kind:'upstream_5xx',attempts:0,max_attempts:3},
  {status:'failed',error_kind:'bad_input',attempts:0,max_attempts:3},
  {status:'failed',error_kind:'checksum_mismatch',attempts:0,max_attempts:3},
  {status:'failed',error_kind:null,attempts:0,max_attempts:3},
  // Defaults the original relied on must survive the change.
  {status:'failed',error_kind:'timeout'},
  {status:'failed',error_kind:'timeout',attempts:3},
  {status:'failed',error_kind:'timeout',attempts:0,max_attempts:0},
  {error_kind:'throttled',attempts:1,max_attempts:2},
];

export const review = {
  anchor: {'retries.py': SHARED},
  paths: ['retries.py'],
  items: [
    {id:'rule-duplicated', ask:'Is the retry decision itself — the terminal-status test, the retryable-error test and the attempt-limit comparison — still spelled out in more than one place, so changing the rule later would mean editing it more than once? Three names bound to one shared implementation is not duplication.'},
    {id:'unearned-abstraction', ask:'Does the submission add a class, registry, strategy table, config option, decorator or wrapper layer that has only one real use here and could be a plain function or a literal?'},
    {id:'dead-code', ask:'Is there unused or unreachable code left behind: a function nothing calls, an unused constant or import, or a commented-out block?'},
    {id:'explanatory-noise', ask:'Are there comments or docstrings that only restate what the adjacent line already says, rather than recording a reason the code cannot express?'},
  ],
};

export async function grade({files, python, trace, lane, control, agent}) {
  const hygiene = await pythonHygiene(python, files, 'retries.py');
  const checks = [...hygiene];
  const runs = [];
  for (const fn of ['should_retry_upload','should_retry_convert','should_retry_export']) {
    const records = [];
    for (const job of JOBS) {
      const r = await observeCases(python,{module:'retries',function:fn,args:[job]});
      runs.push(r);
      records.push(r.value?.[0]?.output);
    }
    checks.push(equal(fn,records,JOBS.map(decide)));
  }
  return [...checks, check('runs','correctness',runs.every(r => r.ok),runs.filter(r => !r.ok).map(r => r.diagnostic).join('\n')),
    preserved(files,original,['retries.py']), ...toolChecks(trace,['retries.py'],'check_public.py',false,{lane,control,agent})];
}
