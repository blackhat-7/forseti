/**
 * Labelled submissions for the duplicate-rule reviewer.
 *
 * These are the gold labels. They are not the reviewer's opinion and not mine: each `why` names
 * the recorded rule it comes from, either a line in the user's own review standard or a
 * complaint that recurs across their transcripts. A reviewer that cannot reproduce these
 * verdicts has no business scoring new code.
 *
 * Every case is behaviourally correct. Correctness is already gated before the reviewer runs,
 * so a calibration case that failed the hidden tests would be measuring the wrong thing.
 *
 * Half the cases contain no defect at all, and two of those are deliberate traps: a longer
 * readable version and a restructured version with a genuine "why" comment. Judges reward
 * length and punish unfamiliar shapes, and both errors would silently invert this suite's
 * headline finding.
 */
export const task = 'duplicate-rule';

const HEAD = `RETRYABLE = ("timeout", "throttled", "upstream_5xx")
TERMINAL = ("cancelled", "succeeded")
`;
const clean = `${HEAD}

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

const none = {'rule-duplicated': false, 'unearned-abstraction': false, 'dead-code': false, 'explanatory-noise': false};

export const cases = [
  {
    id: 'anchor-clean',
    why: 'The reference itself. A reviewer that finds a defect here is inventing work, which the standard forbids: "do not invent speculative improvements".',
    labels: {...none},
    files: {'retries.py': clean},
  },
  {
    id: 'three-copies-fixed',
    why: 'All three copies corrected separately. Recurring complaint, near-verbatim: "why do we have duplicate logic implemented in <handler>. cant we just change the last part once".',
    labels: {...none, 'rule-duplicated': true},
    files: {'retries.py': `${HEAD}

def should_retry_upload(job):
    if job.get("status") in TERMINAL:
        return False
    if job.get("error_kind") not in RETRYABLE:
        return False
    return job.get("attempts", 0) < job.get("max_attempts", 3)


def should_retry_convert(job):
    if job.get("status") in TERMINAL:
        return False
    if job.get("error_kind") not in RETRYABLE:
        return False
    return job.get("attempts", 0) < job.get("max_attempts", 3)


def should_retry_export(job):
    if job.get("status") in TERMINAL:
        return False
    if job.get("error_kind") not in RETRYABLE:
        return False
    return job.get("attempts", 0) < job.get("max_attempts", 3)
`},
  },
  {
    id: 'strategy-class',
    why: 'Standard, minimality review: reject "unnecessary classes", "generic abstractions used once", and ask "can this abstraction wait until there are at least 2-3 real call sites".',
    labels: {...none, 'unearned-abstraction': true},
    files: {'retries.py': `${HEAD}

class RetryPolicy:
    def __init__(self, retryable=RETRYABLE, terminal=TERMINAL, default_limit=3):
        self.retryable = retryable
        self.terminal = terminal
        self.default_limit = default_limit

    def evaluate(self, job):
        if job.get("status") in self.terminal:
            return False
        if job.get("error_kind") not in self.retryable:
            return False
        return job.get("attempts", 0) < job.get("max_attempts", self.default_limit)


_POLICY = RetryPolicy()


def should_retry(job):
    return _POLICY.evaluate(job)


should_retry_upload = should_retry
should_retry_convert = should_retry
should_retry_export = should_retry
`},
  },
  {
    id: 'config-option',
    why: 'Standard, minimality review: "can this config option be hardcoded because there is only one real use?" and reject "unnecessary configuration"/"unnecessary options".',
    labels: {...none, 'unearned-abstraction': true},
    files: {'retries.py': `${HEAD}

RETRY_SETTINGS = {
    "enabled": True,
    "default_max_attempts": 3,
    "respect_terminal_status": True,
    "retryable_kinds": RETRYABLE,
}


def should_retry(job, settings=RETRY_SETTINGS):
    if not settings["enabled"]:
        return False
    if settings["respect_terminal_status"] and job.get("status") in TERMINAL:
        return False
    if job.get("error_kind") not in settings["retryable_kinds"]:
        return False
    return job.get("attempts", 0) < job.get("max_attempts", settings["default_max_attempts"])


should_retry_upload = should_retry
should_retry_convert = should_retry
should_retry_export = should_retry
`},
  },
  {
    id: 'leftover-helper',
    why: 'Standard, minimality review: reject "unused variables/functions/types" and "dead code". Also a code-simplify red flag: "no dead code was left behind (unused imports, unreachable branches)".',
    labels: {...none, 'dead-code': true},
    files: {'retries.py': `import json

${HEAD}

def _legacy_limit(job):
    return job.get("max_attempts", 3)


def should_retry(job):
    if job.get("status") in TERMINAL:
        return False
    if job.get("error_kind") not in RETRYABLE:
        return False
    return job.get("attempts", 0) < job.get("max_attempts", 3)


should_retry_upload = should_retry
should_retry_convert = should_retry
should_retry_export = should_retry
`},
  },
  {
    id: 'comment-noise',
    why: 'Standard: reject "unnecessary comments" and "LLM-style verbosity"; code-simplify: a comment explaining "what" above self-evident code should be deleted.',
    labels: {...none, 'explanatory-noise': true},
    files: {'retries.py': `${HEAD}

def should_retry(job):
    """Decide whether to retry a job.

    Takes a job dictionary and returns a boolean indicating whether the job
    should be retried or not, based on the job's status, error kind and attempts.
    """
    # Get the status from the job.
    status = job.get("status")
    # Check if the status is terminal.
    if status in TERMINAL:
        # Return False because the job is terminal.
        return False
    # Get the error kind from the job.
    error_kind = job.get("error_kind")
    # Check if the error kind is retryable.
    if error_kind not in RETRYABLE:
        # Return False because the error is not retryable.
        return False
    # Get the number of attempts, defaulting to 0.
    attempts = job.get("attempts", 0)
    # Get the maximum number of attempts, defaulting to 3.
    limit = job.get("max_attempts", 3)
    # Return True if there are attempts remaining.
    return attempts < limit


# Alias for the upload consumer.
should_retry_upload = should_retry
# Alias for the convert consumer.
should_retry_convert = should_retry
# Alias for the export consumer.
should_retry_export = should_retry
`},
  },
  {
    id: 'longer-but-plain',
    why: 'TRAP for length bias. Longer than the anchor and still has no defect. Code-simplify is explicit: "optimizing for line count" is a misuse, "fewer lines is not the goal; easier comprehension is".',
    labels: {...none},
    files: {'retries.py': `${HEAD}

def should_retry(job):
    status = job.get("status")
    error_kind = job.get("error_kind")
    attempts = job.get("attempts", 0)
    max_attempts = job.get("max_attempts", 3)

    if status in TERMINAL:
        return False
    if error_kind not in RETRYABLE:
        return False
    return attempts < max_attempts


should_retry_upload = should_retry
should_retry_convert = should_retry
should_retry_export = should_retry
`},
  },
  {
    id: 'why-comment-kept',
    why: 'TRAP for comment bias. Code-simplify keeps comments explaining "why": they "carry intent the code can\'t express". Restructuring into a single expression is also not a defect on its own.',
    labels: {...none},
    files: {'retries.py': `${HEAD}

def should_retry(job):
    # Terminal jobs are checked first: a cancelled job can still carry a retryable
    # error kind from the attempt that was interrupted, and must not come back.
    if job.get("status") in TERMINAL:
        return False
    return (
        job.get("error_kind") in RETRYABLE
        and job.get("attempts", 0) < job.get("max_attempts", 3)
    )


should_retry_upload = should_retry
should_retry_convert = should_retry
should_retry_export = should_retry
`},
  },
];
