/**
 * Labelled submissions for the reconcile-plan reviewer. Gold labels; each `why` names the line of
 * the recorded standard it comes from. Every case is behaviourally correct. Two clean cases are
 * traps: a longer plain version and one with a genuine "why" comment.
 */
export const task = 'reconcile-plan';

const clean = `import re

def plan(snapshot):
    existing = {row["folder"] for row in snapshot["rows"] if row["owner"] == snapshot["owner"]}
    add, reject = set(), set()
    for obj in snapshot["objects"]:
        name = obj["folder"]
        if obj["owner"] != snapshot["owner"] or re.fullmatch(r"[a-z][a-z0-9_-]*", name, flags=re.ASCII) is None:
            reject.add(name)
        elif name not in existing:
            add.add(name)
    return {"add": sorted(add), "reject": sorted(reject), "delete": []}
`;
const none = {'helper-duplicates-stdlib': false, 'unearned-abstraction': false, 'dead-code': false, 'explanatory-noise': false};

export const cases = [
  {
    id: 'anchor-clean',
    why: 'The reference itself. A reviewer that finds a defect here is inventing work, which the standard forbids: "do not invent speculative improvements".',
    labels: {...none},
    files: {'reconcile.py': clean},
  },
  {
    id: 'hand-rolled-sorted-unique',
    why: 'A helper that re-implements sorted(set(...)). Standard: "If a helper duplicates an existing helper, reject it"; "duplicated helpers".',
    labels: {...none, 'helper-duplicates-stdlib': true},
    files: {'reconcile.py': `import re


def _sorted_unique(names):
    seen, out = set(), []
    for name in sorted(names):
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out


def plan(snapshot):
    existing = {row["folder"] for row in snapshot["rows"] if row["owner"] == snapshot["owner"]}
    add, reject = [], []
    for obj in snapshot["objects"]:
        name = obj["folder"]
        if obj["owner"] != snapshot["owner"] or re.fullmatch(r"[a-z][a-z0-9_-]*", name, flags=re.ASCII) is None:
            reject.append(name)
        elif name not in existing:
            add.append(name)
    return {"add": _sorted_unique(add), "reject": _sorted_unique(reject), "delete": []}
`},
  },
  {
    id: 'name-policy-class',
    why: 'Standard, minimality review: reject "unnecessary classes", "unnecessary wrappers" and "generic abstractions used once"; "Can this abstraction wait until there are at least 2-3 real call sites?"',
    labels: {...none, 'unearned-abstraction': true},
    files: {'reconcile.py': `import re


class NamePolicy:
    def __init__(self, owner, pattern=r"[a-z][a-z0-9_-]*"):
        self.owner = owner
        self.pattern = re.compile(pattern, re.ASCII)

    def allows(self, obj):
        return obj["owner"] == self.owner and self.pattern.fullmatch(obj["folder"]) is not None


def plan(snapshot):
    policy = NamePolicy(snapshot["owner"])
    existing = {row["folder"] for row in snapshot["rows"] if row["owner"] == snapshot["owner"]}
    add, reject = set(), set()
    for obj in snapshot["objects"]:
        name = obj["folder"]
        if not policy.allows(obj):
            reject.add(name)
        elif name not in existing:
            add.add(name)
    return {"add": sorted(add), "reject": sorted(reject), "delete": []}
`},
  },
  {
    id: 'thrown-away-delete-list',
    why: 'A delete list is computed and then discarded, next to an unused import. Standard: reject "unused variables/functions/types"; code-simplify: "no dead code was left behind (unused imports, unreachable branches)".',
    labels: {...none, 'dead-code': true},
    files: {'reconcile.py': `import json
import re

def plan(snapshot):
    existing = {row["folder"] for row in snapshot["rows"] if row["owner"] == snapshot["owner"]}
    add, reject, seen = set(), set(), set()
    for obj in snapshot["objects"]:
        name = obj["folder"]
        seen.add(name)
        if obj["owner"] != snapshot["owner"] or re.fullmatch(r"[a-z][a-z0-9_-]*", name, flags=re.ASCII) is None:
            reject.add(name)
        elif name not in existing:
            add.add(name)
    delete = sorted(existing - seen)
    return {"add": sorted(add), "reject": sorted(reject), "delete": []}
`},
  },
  {
    id: 'comment-noise',
    why: 'Standard: reject "unnecessary comments"; code-simplify: a comment explaining "what" above self-evident code should be deleted.',
    labels: {...none, 'explanatory-noise': true},
    files: {'reconcile.py': `import re

def plan(snapshot):
    """Build a repair plan for one owner.

    Collects the owner's existing folder names, then walks the objects and
    sorts each one into add or reject, returning the three lists.
    """
    # Collect the folder names this owner already has rows for.
    existing = {row["folder"] for row in snapshot["rows"] if row["owner"] == snapshot["owner"]}
    # Start with empty add and reject sets.
    add, reject = set(), set()
    # Look at every object.
    for obj in snapshot["objects"]:
        # Get the folder name.
        name = obj["folder"]
        # Reject foreign owners and invalid names.
        if obj["owner"] != snapshot["owner"] or re.fullmatch(r"[a-z][a-z0-9_-]*", name, flags=re.ASCII) is None:
            reject.add(name)
        # Otherwise add it if it is missing.
        elif name not in existing:
            add.add(name)
    # Return the sorted lists; delete is always empty.
    return {"add": sorted(add), "reject": sorted(reject), "delete": []}
`},
  },
  {
    id: 'longer-but-plain',
    why: 'TRAP for length and comment bias. A compiled pattern, named locals and one "why" comment; no defect. Code-simplify: "fewer lines is not the goal; easier comprehension is", and "why" comments "carry intent the code can\'t express".',
    labels: {...none},
    files: {'reconcile.py': `import re

VALID_NAME = re.compile(r"[a-z][a-z0-9_-]*", re.ASCII)


def plan(snapshot):
    owner = snapshot["owner"]
    existing = set()
    for row in snapshot["rows"]:
        if row["owner"] == owner:
            existing.add(row["folder"])
    add = set()
    reject = set()
    for obj in snapshot["objects"]:
        name = obj["folder"]
        # Ownership and validity are checked before the membership test: a foreign-owner
        # object whose name matches an existing row is still a rejection, not a no-op.
        if obj["owner"] != owner or VALID_NAME.fullmatch(name) is None:
            reject.add(name)
        elif name not in existing:
            add.add(name)
    # delete stays empty: an object listing is not proof that a row should go.
    return {"add": sorted(add), "reject": sorted(reject), "delete": []}
`},
  },
];
