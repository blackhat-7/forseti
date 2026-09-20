/**
 * Labelled submissions for the event-ledger reviewer. Gold labels; each `why` names the line of
 * the recorded standard it comes from. Every case is behaviourally correct, because correctness
 * gates the reviewer in a real run. Two clean cases are traps: a longer plain version and one
 * with a genuine "why" comment.
 */
export const task = 'event-ledger';

const HEAD = `def initialize(conn):
    conn.executescript("""
    CREATE TABLE events (tenant TEXT, event_id TEXT, amount INTEGER,
                         PRIMARY KEY (tenant, event_id));
    CREATE TABLE balances (tenant TEXT PRIMARY KEY, amount INTEGER NOT NULL);
    """)
`;
const VALID = `if not isinstance(tenant, str) or not tenant or not isinstance(event_id, str) or not event_id or type(amount) is not int:`;
const BODY = `            tenant, event_id, amount = event["tenant"], event["event_id"], event["amount"]
            ${VALID}
                raise ValueError("invalid event")
            old = conn.execute("SELECT amount FROM events WHERE tenant=? AND event_id=?", (tenant, event_id)).fetchone()
            if old is not None:
                if old[0] != amount:
                    raise ValueError("conflicting replay")
                continue
            conn.execute("INSERT INTO events VALUES (?, ?, ?)", (tenant, event_id, amount))
            conn.execute("INSERT INTO balances VALUES (?, ?) ON CONFLICT(tenant) DO UPDATE SET amount = amount + excluded.amount", (tenant, amount))
`;
const clean = `${HEAD}
def apply_events(conn, events):
    with conn:
        for event in events:
${BODY}`;
const none = {'validation-duplicated': false, 'unearned-abstraction': false, 'dead-code': false, 'explanatory-noise': false};

export const cases = [
  {
    id: 'anchor-clean',
    why: 'The reference itself. A reviewer that finds a defect here is inventing work, which the standard forbids: "do not invent speculative improvements".',
    labels: {...none},
    files: {'ledger.py': clean},
  },
  {
    id: 'validated-twice',
    why: 'A pre-pass over the batch and the same condition again inside the loop. Standard: "If a helper duplicates an existing helper, reject it"; recurring complaint: "why do we have duplicate logic ... cant we just change the last part once".',
    labels: {...none, 'validation-duplicated': true},
    files: {'ledger.py': `${HEAD}
def apply_events(conn, events):
    for event in events:
        tenant, event_id, amount = event["tenant"], event["event_id"], event["amount"]
        ${VALID}
            raise ValueError("invalid event")
    with conn:
        for event in events:
${BODY}`},
  },
  {
    id: 'ledger-class',
    why: 'Standard, minimality review: reject "unnecessary classes", "unnecessary wrappers" and "generic abstractions used once"; "Can this abstraction wait until there are at least 2-3 real call sites?"',
    labels: {...none, 'unearned-abstraction': true},
    files: {'ledger.py': `${HEAD}
class Ledger:
    def __init__(self, conn):
        self.conn = conn

    def apply(self, events):
        with self.conn:
            for event in events:
                self.apply_one(event)

    def apply_one(self, event):
        conn = self.conn
        for event in (event,):
${BODY}

def apply_events(conn, events):
    Ledger(conn).apply(events)
`},
  },
  {
    id: 'leftover-helper',
    why: 'Standard, minimality review: reject "unused variables/functions/types"; code-simplify: "no dead code was left behind (unused imports, unreachable branches)".',
    labels: {...none, 'dead-code': true},
    files: {'ledger.py': `import json

MAX_BATCH = 1000

${HEAD}

def _balance(conn, tenant):
    row = conn.execute("SELECT amount FROM balances WHERE tenant=?", (tenant,)).fetchone()
    return row[0] if row else 0


def apply_events(conn, events):
    with conn:
        for event in events:
${BODY}`},
  },
  {
    id: 'comment-noise',
    why: 'Standard: reject "unnecessary comments"; code-simplify: a comment explaining "what" above self-evident code should be deleted.',
    labels: {...none, 'explanatory-noise': true},
    files: {'ledger.py': `${HEAD}
def apply_events(conn, events):
    """Apply a batch of events to the ledger.

    Loops over the events, validates each one, skips replays, rejects conflicts
    and updates the balances table inside a transaction.
    """
    # Open a transaction so the whole batch commits or rolls back together.
    with conn:
        # Go through every event in the batch.
        for event in events:
            # Pull the three fields out of the event.
${BODY.replace('            old = conn', '            # Look up any stored amount for this key.\n            old = conn').replace('            conn.execute("INSERT INTO events', '            # Insert the event row.\n            conn.execute("INSERT INTO events').replace('            conn.execute("INSERT INTO balances', '            # Add the amount to the tenant balance.\n            conn.execute("INSERT INTO balances')}`},
  },
  {
    id: 'longer-but-plain',
    why: 'TRAP for length and comment bias. Separate ifs, named locals and one "why" comment; no defect. Code-simplify: "fewer lines is not the goal; easier comprehension is", and "why" comments "carry intent the code can\'t express".',
    labels: {...none},
    files: {'ledger.py': `${HEAD}
def apply_events(conn, events):
    with conn:
        for event in events:
            tenant = event["tenant"]
            event_id = event["event_id"]
            amount = event["amount"]
            if not isinstance(tenant, str) or not tenant:
                raise ValueError("invalid tenant")
            if not isinstance(event_id, str) or not event_id:
                raise ValueError("invalid event_id")
            # type() rather than isinstance(): bool is a subclass of int and must be rejected.
            if type(amount) is not int:
                raise ValueError("invalid amount")
            stored = conn.execute(
                "SELECT amount FROM events WHERE tenant = ? AND event_id = ?", (tenant, event_id)
            ).fetchone()
            if stored is not None:
                if stored[0] != amount:
                    raise ValueError("conflicting replay")
                continue
            conn.execute("INSERT INTO events VALUES (?, ?, ?)", (tenant, event_id, amount))
            conn.execute(
                "INSERT INTO balances VALUES (?, ?) "
                "ON CONFLICT(tenant) DO UPDATE SET amount = amount + excluded.amount",
                (tenant, amount),
            )
`},
  },
];
