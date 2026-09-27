import {isDeepStrictEqual} from 'node:util';
import {fixture, preserved, observeCases, check, bounded, toolChecks, pythonHygiene} from './helpers.mjs';
const original = fixture('log-query');

/**
 * A long written spec whose rules interact, graded on hidden queries over one invented record set.
 * Each rule group below is a separate correctness check so partial credit shows where a candidate
 * broke; the task is solved only when every group is right. The public check covers five easy
 * queries and one error.
 *
 * The traps are the spellings Python offers first, each of which the spec rules out:
 *   `!=` written as `not =`, which is true for absent fields and mismatched kinds (rules 20, 27);
 *   bool being an int, so `status = 1` would match `true` (rule 21);
 *   700 * 0.001 is 0.7000000000000001 in floats, where the spec computes units exactly (rule 9);
 *   float() or \d for numeric strings, which accept " 500", "5e2" and Unicode digits (rule 23);
 *   re.match instead of re.search (rule 25);
 *   error positions: tokenizing first, then the first parse problem, then len(query) at the end.
 */

const REFERENCE = String.raw`import re
from decimal import Decimal

KEYWORDS = {"and", "or", "not", "in", "true", "false", "null"}
UNITS = {"ms": Decimal("0.001"), "s": Decimal(1), "m": Decimal(60), "h": Decimal(3600),
         "d": Decimal(86400), "b": Decimal(1), "kb": Decimal(1024), "mb": Decimal(1048576),
         "gb": Decimal(1073741824)}
ESCAPES = {'"': '"', "\\": "\\", "n": "\n", "t": "\t"}
OPERATORS = ("!=", "<=", ">=", "!~", "=", "<", ">", "~")
WHITESPACE = " \t\n\r"
NUMBER = re.compile(r"-?[0-9]+(?:\.[0-9]+)?")
WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
LETTERS = re.compile(r"[A-Za-z]+")
DIGIT = re.compile(r"[0-9]")
INTEGER = re.compile(r"-?[0-9]+")


class QueryError(Exception):
    def __init__(self, code, position):
        super().__init__(code)
        self.code, self.position = code, position


def tokenize(query):
    """Tokens are (kind, value, position)."""
    tokens, i, n = [], 0, len(query)
    while i < n:
        ch = query[i]
        if ch in WHITESPACE:
            i += 1
        elif ch == '"':
            start, i, out = i, i + 1, []
            while True:
                if i >= n:
                    raise QueryError("unterminated-string", start)
                if query[i] == '"':
                    break
                if query[i] == "\\":
                    if query[i + 1:i + 2] not in ESCAPES:
                        raise QueryError("bad-escape", i)
                    out.append(ESCAPES[query[i + 1]])
                    i += 2
                else:
                    out.append(query[i])
                    i += 1
            tokens.append(("string", "".join(out), start))
            i += 1
        elif DIGIT.match(ch) or (ch == "-" and DIGIT.match(query, i + 1)):
            start = i
            i = INTEGER.match(query, i).end()
            if query[i:i + 1] == ".":
                if not DIGIT.match(query, i + 1):
                    raise QueryError("bad-number", start)
                i = INTEGER.match(query, i + 1).end()
            digits = query[start:i]
            factor = Decimal(1)
            unit = LETTERS.match(query, i)
            if unit:
                if unit.group() not in UNITS:
                    raise QueryError("bad-unit", i)
                factor = UNITS[unit.group()]
                i = unit.end()
            tokens.append(("number", float(Decimal(digits) * factor), start))
        elif ch == "-":
            raise QueryError("unexpected-character", i)
        elif WORD.match(ch):
            start = i
            i = WORD.match(query, i).end()
            while query[i:i + 1] == ".":
                word = WORD.match(query, i + 1)
                if not word:
                    raise QueryError("unexpected-character", i)
                i = word.end()
            text = query[start:i]
            if "." not in text and text.lower() in KEYWORDS:
                tokens.append((text.lower(), text, start))
            else:
                tokens.append(("path", text.split("."), start))
        elif ch in "(),":
            tokens.append((ch, ch, i))
            i += 1
        else:
            for op in OPERATORS:
                if query.startswith(op, i):
                    tokens.append(("op", op, i))
                    i += len(op)
                    break
            else:
                raise QueryError("unexpected-character", i)
    tokens.append(("end", None, n))
    return tokens


class Parser:
    def __init__(self, tokens):
        self.tokens, self.pos = tokens, 0

    def peek(self):
        return self.tokens[self.pos]

    def take(self, *kinds):
        token = self.tokens[self.pos]
        if token[0] not in kinds:
            if token[0] == "end":
                raise QueryError("unexpected-end", token[2])
            raise QueryError("unexpected-token", token[2])
        self.pos += 1
        return token

    def query(self):
        node = self.expression()
        self.take("end")
        return node

    def expression(self):
        node = self.and_expr()
        while self.peek()[0] == "or":
            self.take("or")
            node = ("or", node, self.and_expr())
        return node

    def and_expr(self):
        node = self.not_expr()
        while self.peek()[0] == "and":
            self.take("and")
            node = ("and", node, self.not_expr())
        return node

    def not_expr(self):
        kind = self.peek()[0]
        if kind == "not":
            self.take("not")
            return ("not", self.not_expr())
        if kind == "(":
            self.take("(")
            node = self.expression()
            self.take(")")
            return node
        return self.comparison()

    def literal(self, op):
        token = self.take("number", "string", "true", "false", "null")
        kind, value, position = token
        if op in ("~", "!~"):
            if kind != "string":
                raise QueryError("unexpected-token", position)
            try:
                return ("regex", re.compile(value))
            except re.error:
                raise QueryError("bad-regex", position)
        if kind == "null":
            if op not in ("=", "!="):
                raise QueryError("unexpected-token", position)
            return ("null", None)
        if kind in ("true", "false"):
            return ("bool", kind == "true")
        return (kind, value)

    def comparison(self):
        path = self.take("path")[1]
        if self.peek()[0] == "in":
            self.take("in")
            self.take("(")
            values = [self.literal("=")]
            while self.peek()[0] == ",":
                self.take(",")
                values.append(self.literal("="))
            self.take(")")
            return ("in", path, values)
        op = self.take("op")[1]
        return ("cmp", path, op, self.literal(op))


MISSING = object()


def lookup(record, path):
    value = record
    for key in path:
        if not isinstance(value, dict) or key not in value:
            return MISSING
        value = value[key]
    return value


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


ORDER = {"=": lambda a, b: a == b, "!=": lambda a, b: a != b, "<": lambda a, b: a < b,
         "<=": lambda a, b: a <= b, ">": lambda a, b: a > b, ">=": lambda a, b: a >= b}


def compare(value, op, literal):
    kind, expected = literal
    absent = value is MISSING or value is None
    if kind == "null":
        return absent if op == "=" else not absent
    if absent:
        return False
    if kind == "regex":
        if not isinstance(value, str):
            return False
        found = expected.search(value) is not None
        return found if op == "~" else not found
    if kind == "number":
        if isinstance(value, str) and NUMBER.fullmatch(value):
            value = float(value)
        if not is_number(value):
            return False
        return ORDER[op](value, expected)
    if kind == "string":
        return isinstance(value, str) and ORDER[op](value, expected)
    if isinstance(value, bool) and op in ("=", "!="):
        return ORDER[op](value, expected)
    return False


def matches(node, record):
    kind = node[0]
    if kind == "or":
        return matches(node[1], record) or matches(node[2], record)
    if kind == "and":
        return matches(node[1], record) and matches(node[2], record)
    if kind == "not":
        return not matches(node[1], record)
    value = lookup(record, node[1])
    if kind == "in":
        return any(compare(value, "=", literal) for literal in node[2])
    return compare(value, node[2], node[3])


def run_query(query, records):
    try:
        tokens = tokenize(query)
        if len(tokens) == 1:
            return {"matches": list(range(len(records)))}
        tree = Parser(tokens).query()
    except QueryError as error:
        return {"error": {"code": error.code, "position": error.position}}
    return {"matches": [i for i, record in enumerate(records) if matches(tree, record)]}
`;

const RECORDS = [
  {status: 200, path: '/api/items', latency: 0.12, size: 512, user: 'ana', tags: ['a'], req: {method: 'GET', host: 'alpha'}},
  {status: 500, path: '/api/items', latency: 2.5, size: 2048, user: null, req: {method: 'POST', host: 'beta'}},
  {status: 502, path: '/health', latency: 0.3, size: 0, req: {method: 'GET'}},
  {status: '500', path: '/Health/deep', latency: 1.5, size: 1536, user: 'Bob', req: 'flat', wait: 0.7},
  {status: true, path: '/api/users/7', latency: 0.001, size: 1048576, user: '', cached: false, req: {method: 'get', host: null}},
  {status: 404, path: '/api/items?q="x"', latency: 60, size: 1073741824, user: 'carl', cached: true, note: 'line1\nline2'},
  {status: '5e2', path: null, latency: '0.3', size: '1kb', user: 'dave', req: {method: 'DELETE', host: 'gamma'}, retries: 0},
  {status: 503, path: '/api/ITEMS', latency: 7200, user: 'Émile', req: {}, retries: 3, meta: {in: 1, and: {x: 2}}, wait: 3960},
  {status: ' 500', path: '/tab\there', latency: -1, size: -0.5, user: 'zed', retries: null, flags: {a: 1}},
  {},
];
const ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const err = (code, position) => ({error: {code, position}});
// Each case is [query, expected indices or error].
const GROUPS = {
  logic: [
    ['status = 500 or status = 502 and latency < 1s', [1, 2, 3]],
    ['(status = 500 or status = 502) and latency < 1s', [2]],
    ['not status = 500 and user = null', [2, 9]],
    ['not (status = 500 and user = null)', [0, 2, 3, 4, 5, 6, 7, 8, 9]],
    ['not not user = "ana"', [0]],
    ['user = "ana" or user = "carl" and not cached = true', [0]],
    ['status >= 500 and status < 600 or user ~ "^z"', [1, 2, 3, 7, 8]],
    ['user = "ana" OR NOT status != 200', [0, 4, 6, 8, 9]],
    ['a = 1 or b = 2 or retries = 3', [7]],
    ['((retries = 0))', [6]],
    ['not (user = "ana" or not status = 500) and latency > 2', [1]],
    ['status = 404 And Not (cached = false Or user = null)', [5]],
    ['not cached = true and not cached = false', [0, 1, 2, 3, 6, 7, 8, 9]],
  ],
  absent: [
    ['user = null', [1, 2, 9]],
    ['user != null', [0, 3, 4, 5, 6, 7, 8]],
    ['user != "ana"', [3, 4, 5, 6, 7, 8]],
    ['not user = "ana"', [1, 2, 3, 4, 5, 6, 7, 8, 9]],
    ['req.host = null', [2, 3, 4, 5, 7, 8, 9]],
    ['req.host != null', [0, 1, 6]],
    ['req != null', [0, 1, 2, 3, 4, 6, 7]],
    ['retries = null', [0, 1, 2, 3, 4, 5, 8, 9]],
    ['retries < 1', [6]],
    ['not retries >= 1', [0, 1, 2, 3, 4, 5, 6, 8, 9]],
    ['path !~ "api"', [2, 3, 8]],
    ['path ~ "."', [0, 1, 2, 3, 4, 5, 7, 8]],
    ['user in ("ana", null)', [0, 1, 2, 9]],
    ['meta.in = 1', [7]],
    ['meta.and.x = 2', [7]],
    ['flags = null', [0, 1, 2, 3, 4, 5, 6, 7, 9]],
    ['flags != 1', []],
    ['flags != null', [8]],
    ['tags = "a"', []],
    ['user = NULL', [1, 2, 9]],
    ['req.method.x = null', ALL],
    ['user != null and user != ""', [0, 3, 5, 6, 7, 8]],
  ],
  types: [
    ['status = 500', [1, 3]],
    ['status = "500"', [3]],
    ['status != "500"', [6, 8]],
    ['status = true', [4]],
    ['status = 1', []],
    ['status != 1', [0, 1, 2, 3, 5, 7]],
    ['status > 400', [1, 2, 3, 5, 7]],
    ['status < "6"', [3, 6, 8]],
    ['latency = "0.3"', [6]],
    ['latency = 0.3', [2, 6]],
    ['latency = 300ms', [2, 6]],
    ['latency > 1h', [7]],
    ['latency >= 1m', [5, 7]],
    ['latency = 1ms', [4]],
    ['latency < 0', [8]],
    ['latency > -1.5', [0, 1, 2, 3, 4, 5, 6, 7, 8]],
    ['size = 1.5kb', [3]],
    ['size = 1mb', [4]],
    ['size = 1gb', [5]],
    ['size = "1kb"', [6]],
    ['size = 1kb', []],
    ['size < 0b', [8]],
    ['size >= 0.5kb', [0, 1, 3, 4, 5]],
    ['cached = false', [4]],
    ['cached != true', [4]],
    ['cached < true', []],
    ['cached = 0', []],
    ['user > "Z"', [0, 5, 6, 7, 8]],
    ['user < "b"', [0, 3, 4]],
    ['user = "bob"', []],
    ['req.method = "GET"', [0, 2]],
    ['req.method in ("GET", "get")', [0, 2, 4]],
    ['status in (500, "5e2", true)', [1, 3, 4, 6]],
    ['status in (502, 503)', [2, 7]],
    ['retries = -0', [6]],
    ['status = 500.0', [1, 3]],
    ['status = 0500', [1, 3]],
    ['latency = 120ms', [0]],
    ['latency = 1500ms', [3]],
    ['wait = 700ms', [3]],
    ['wait = 1.1h', [7]],
    ['latency > 0.5m', [5, 7]],
    ['size = 0.5kb', [0]],
    ['size = 1048576b', [4]],
    ['req = "flat"', [3]],
    ['req != "flat"', []],
  ],
  regex: [
    ['path ~ "^/api"', [0, 1, 4, 5, 7]],
    ['path ~ "items"', [0, 1, 5]],
    ['path ~ "(?i)items"', [0, 1, 5, 7]],
    ['path ~ "^/health$"', [2]],
    ['path ~ "health"', [2]],
    ['path ~ "\\\\d+$"', [4]],
    ['user ~ ""', [0, 3, 4, 5, 6, 7, 8]],
    ['user !~ "a"', [3, 4, 7, 8]],
    ['status ~ "5"', [3, 6, 8]],
    ['status !~ "5"', []],
    ['note ~ "1\\nl"', [5]],
    ['path ~ "\\\\?q=\\"x"', [5]],
    ['req ~ "fl"', [3]],
    ['path !~ "^/api" and path != null', [2, 3, 8]],
    ['not path ~ "^/api"', [2, 3, 6, 8, 9]],
    ['path ~ "[A-Z]"', [3, 7]],
    ['path ~ "\\t"', [8]],
    ['latency ~ "0"', [6]],
  ],
  tokens: [
    ['', ALL],
    [' \t\n ', ALL],
    ['status=500', [1, 3]],
    ['status\t=\n500', [1, 3]],
    ['latency<=-1', [8]],
    ['latency>=7200s', [7]],
    ['latency = 2h', [7]],
    ['latency = 0.12', [0]],
    ['size = 2kb', [1]],
    ['retries=3 and meta.in=1', [7]],
    ['user="dave"', [6]],
    ['user = "Émile"', [7]],
    ['a_b.c = 1', []],
    ['status in(500)', [1, 3]],
    ['(status=404)or(status=200)', [0, 5]],
    ['latency = 1.5s', [3]],
    ['path = "/tab\\there"', [8]],
    ['path = "/api/items?q=\\"x\\""', [5]],
    ['note = "line1\\nline2"', [5]],
    ['path = "\\\\"', []],
    ['IN_x = 1 or In.x = 2 or retries IN (3)', [7]],
    ['latency>0.5m', [5, 7]],
  ],
  errors: [
    ['status = 5e2', err('bad-unit', 10)],
    ['latency > 1S', err('bad-unit', 11)],
    ['latency > 1sec', err('bad-unit', 11)],
    ['latency > 1.', err('bad-number', 10)],
    ['latency > 1.s', err('bad-number', 10)],
    ['latency > -1.x', err('bad-number', 10)],
    ['latency > - 1', err('unexpected-character', 10)],
    ['latency > .5', err('unexpected-character', 10)],
    ['path ~ "\\d"', err('bad-escape', 8)],
    ['path = "abc', err('unterminated-string', 7)],
    ['path = "a\\q', err('bad-escape', 9)],
    ['path = "abc\\', err('bad-escape', 11)],
    ["user = 'ana'", err('unexpected-character', 7)],
    ['user == "ana"', err('unexpected-token', 6)],
    ['user ! = "a"', err('unexpected-character', 5)],
    ['user <> "a"', err('unexpected-token', 6)],
    ['status = 500 and', err('unexpected-end', 16)],
    ['status = 500 and or user = null', err('unexpected-token', 17)],
    ['(status = 500', err('unexpected-end', 13)],
    ['status = 500)', err('unexpected-token', 12)],
    ['()', err('unexpected-token', 1)],
    ['status in ()', err('unexpected-token', 11)],
    ['status in (500,)', err('unexpected-token', 15)],
    ['status in 500', err('unexpected-token', 10)],
    ['status not in (500)', err('unexpected-token', 7)],
    ['500 = status', err('unexpected-token', 0)],
    ['null = user', err('unexpected-token', 0)],
    ['status > null', err('unexpected-token', 9)],
    ['path ~ null', err('unexpected-token', 7)],
    ['path ~ 5', err('unexpected-token', 7)],
    ['path ~ "("', err('bad-regex', 7)],
    ['path ~ "[a-" or status = 1.', err('bad-number', 25)],
    ['path ~ "(" or status = )', err('bad-regex', 7)],
    ['status = ) or path ~ "("', err('unexpected-token', 9)],
    ['path ~ "*a"', err('bad-regex', 7)],
    ['status = 500 user = null', err('unexpected-token', 13)],
    ['not', err('unexpected-end', 3)],
    ['a.', err('unexpected-character', 1)],
    ['a..b = 1', err('unexpected-character', 1)],
    ['a.5 = 1', err('unexpected-character', 1)],
    ['req. method = "GET"', err('unexpected-character', 3)],
    ['status = -', err('unexpected-character', 9)],
    ['status = 500 & latency > 1', err('unexpected-character', 13)],
    ['status = 500 or', err('unexpected-end', 15)],
    ['in = 1', err('unexpected-token', 0)],
    ['TRUE = status', err('unexpected-token', 0)],
    ['status = "5"00', err('unexpected-token', 12)],
    ['x = 1 and (y = 2 or', err('unexpected-end', 19)],
    ['user = "a" "b"', err('unexpected-token', 11)],
    ['status = 1 = 2', err('unexpected-token', 11)],
    ['x ~ "\\\\"', err('bad-regex', 4)],
    [') = "x\\q"', err('bad-escape', 6)],
    ['status in (500 501)', err('unexpected-token', 15)],
    ['status =', err('unexpected-end', 8)],
    ['latency < 1 and size > 2KB', err('bad-unit', 24)],
    ['status = 500 and not', err('unexpected-end', 20)],
    ['x !~ null', err('unexpected-token', 5)],
    ['x in (1, null) and y >= null', err('unexpected-token', 24)],
    ['status!=500and status!=200', err('bad-unit', 11)],
  ],
};

export const reference = {files: {...original, 'query.py': REFERENCE}, answer: 'Implemented the query language to SPEC.md.'};
// A strong near-miss: right everywhere except that `!=` is the negation of `=`, so it is true for
// an absent field and for a value of another kind (rules 20 and 27).
const BASELINE = REFERENCE.replace(
  '    kind, expected = literal\n    absent = value is MISSING or value is None\n',
  '    kind, expected = literal\n    if op == "!=":\n        return not compare(value, "=", literal)\n    absent = value is MISSING or value is None\n');
if (BASELINE === REFERENCE) throw new Error('log-query baseline did not apply');
export const baseline = {files: {...original, 'query.py': BASELINE}, answer: 'Implemented the query language to SPEC.md.'};

export async function grade({files, python, trace, lane, control, agent}) {
  const checks = [...await pythonHygiene(python, files, 'query.py')];
  const mutated = [];
  for (const [group, cases] of Object.entries(GROUPS)) {
    const r = await observeCases(python, {module: 'query', function: 'run_query', calls: cases.map(([query]) => [query, RECORDS])});
    const wrong = [];
    cases.forEach(([query, expected], i) => {
      const record = r.value?.[i];
      if (!r.ok || !record) return;
      const want = Array.isArray(expected) ? {matches: expected} : expected;
      if (record.error) wrong.push({query, raised: record.error, want});
      else if (!isDeepStrictEqual(record.output, want)) wrong.push({query, got: record.output, want});
      if (!isDeepStrictEqual(record.args, [query, RECORDS])) mutated.push(query);
    });
    checks.push(check(group, 'correctness', r.ok && r.value?.length === cases.length && wrong.length === 0,
      r.ok ? `${wrong.length} of ${cases.length} queries wrong; wrong=${bounded(wrong)}` : r.diagnostic));
  }
  checks.push(check('input-unchanged', 'correctness', mutated.length === 0, `queries that modified records: ${bounded(mutated)}; expected=[] (rule 3)`));
  return [...checks, preserved(files, original, ['query.py']),
    ...toolChecks(trace, ['SPEC.md', 'query.py'], 'check_public.py', false, {lane, control, agent})];
}
