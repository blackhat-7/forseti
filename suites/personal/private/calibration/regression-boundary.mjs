/**
 * Labelled submissions for the regression-boundary reviewer. Gold labels; each `why` names the
 * line of the recorded standard it comes from. Every case is behaviourally correct. Two clean
 * cases are traps: a longer plain version with a helper and a genuine "why" comment.
 */
export const task = 'regression-boundary';

const CHECKS = `        if not isinstance(metrics, dict):
            return "unknown"
        count, error = metrics.get("count"), metrics.get("error")
        if type(count) is not int or count < 20:
            return "unknown"
        if type(error) not in (int, float) or not math.isfinite(error) or error < 0:
            return "unknown"
`;
const VERDICT = `    return "regressed" if current["error"] > baseline["error"] * 1.1 else "accepted"
`;
const clean = `import math

def decision(current, baseline):
    for metrics in (current, baseline):
${CHECKS}${VERDICT}`;
const none = {'validation-duplicated': false, 'unearned-abstraction': false, 'dead-code': false, 'explanatory-noise': false};

export const cases = [
  {
    id: 'anchor-clean',
    why: 'The reference itself. A reviewer that finds a defect here is inventing work, which the standard forbids: "do not invent speculative improvements".',
    labels: {...none},
    files: {'policy.py': clean},
  },
  {
    id: 'validated-per-side',
    why: 'The same six-line check written once for current and once for baseline. Standard: "If a helper duplicates an existing helper, reject it"; recurring complaint: "why do we have duplicate logic ... cant we just change the last part once".',
    labels: {...none, 'validation-duplicated': true},
    files: {'policy.py': `import math

def decision(current, baseline):
    metrics = current
${CHECKS.replace(/^    /gm, '')}    metrics = baseline
${CHECKS.replace(/^    /gm, '')}${VERDICT}`},
  },
  {
    id: 'policy-config',
    why: 'Standard, minimality review: "Can this config option be hardcoded because there is only one real use?" and reject "unnecessary configuration"/"unnecessary options".',
    labels: {...none, 'unearned-abstraction': true},
    files: {'policy.py': `import math

POLICY = {"min_count": 20, "tolerance": 1.1, "reject_negative_error": True}


def decision(current, baseline, policy=POLICY):
    for metrics in (current, baseline):
        if not isinstance(metrics, dict):
            return "unknown"
        count, error = metrics.get("count"), metrics.get("error")
        if type(count) is not int or count < policy["min_count"]:
            return "unknown"
        if type(error) not in (int, float) or not math.isfinite(error):
            return "unknown"
        if policy["reject_negative_error"] and error < 0:
            return "unknown"
    return "regressed" if current["error"] > baseline["error"] * policy["tolerance"] else "accepted"
`},
  },
  {
    id: 'leftover-helper',
    why: 'Standard, minimality review: reject "unused variables/functions/types"; code-simplify: "no dead code was left behind (unused imports, unreachable branches)".',
    labels: {...none, 'dead-code': true},
    files: {'policy.py': `import math
import statistics


def _relative_change(current, baseline):
    if baseline["error"] == 0:
        return math.inf
    return current["error"] / baseline["error"] - 1


def decision(current, baseline):
    for metrics in (current, baseline):
${CHECKS}${VERDICT}`},
  },
  {
    id: 'comment-noise',
    why: 'Standard: reject "unnecessary comments"; code-simplify: a comment explaining "what" above self-evident code should be deleted.',
    labels: {...none, 'explanatory-noise': true},
    files: {'policy.py': `import math

def decision(current, baseline):
    """Decide whether current has regressed against baseline.

    Validates both metric dictionaries and then compares the error values,
    returning "regressed", "accepted" or "unknown".
    """
    # Check both sides.
    for metrics in (current, baseline):
        # Make sure it is a dict.
        if not isinstance(metrics, dict):
            return "unknown"
        # Read the count and the error.
        count, error = metrics.get("count"), metrics.get("error")
        # The count must be an int of at least 20.
        if type(count) is not int or count < 20:
            return "unknown"
        # The error must be a finite nonnegative number.
        if type(error) not in (int, float) or not math.isfinite(error) or error < 0:
            return "unknown"
    # Compare the errors.
${VERDICT}`},
  },
  {
    id: 'longer-but-plain',
    why: 'TRAP for length and comment bias. A helper used for both sides, named locals and one "why" comment; no defect. Code-simplify: "fewer lines is not the goal; easier comprehension is", and "why" comments "carry intent the code can\'t express".',
    labels: {...none},
    files: {'policy.py': `import math


def _usable(metrics):
    if not isinstance(metrics, dict):
        return False
    count = metrics.get("count")
    error = metrics.get("error")
    # type() rather than isinstance(): True and False are ints and must not count as samples.
    if type(count) is not int or count < 20:
        return False
    if type(error) not in (int, float):
        return False
    return math.isfinite(error) and error >= 0


def decision(current, baseline):
    if not _usable(current) or not _usable(baseline):
        return "unknown"
    allowed = baseline["error"] * 1.1
    if current["error"] > allowed:
        return "regressed"
    return "accepted"
`},
  },
];
