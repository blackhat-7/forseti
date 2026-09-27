import {isDeepStrictEqual} from 'node:util';
import {fixture, preserved, observeCases, check, bounded, toolChecks, pythonHygiene} from './helpers.mjs';
const original = fixture('sheet-eval');

/**
 * A long written spec whose rules interact, graded on hidden workbooks. Each rule group below is a
 * separate correctness check so partial credit shows where a candidate broke; the task is solved
 * only when every group is right. The public check covers the easy path only: sums, a division,
 * CONCAT, IF and one cross-sheet reference.
 *
 * The traps are the spellings Python offers first, each of which the spec rules out:
 *   float() for number syntax ("1e3", "inf", "+1", "1_000", Unicode digits all parse);
 *   Python precedence, where -2**2 is -4 and ** is right-associative;
 *   round() and "%.9f", which round the binary value half-to-even instead of the decimal half up;
 *   bool being an int, so TRUE in a referenced cell would be summed;
 *   math.pow and ** on a negative base (complex result or ValueError) and OverflowError;
 *   cycle detection by evaluation stack, which marks the callers of a loop and misses loops that
 *   pass through an IF branch not taken.
 */

const REFERENCE = String.raw`import math
import re
from decimal import Decimal, ROUND_HALF_UP, localcontext

NUMBER = re.compile(r"-?[0-9]+(\.[0-9]+)?")
CELL = re.compile(r"([A-Za-z]{1,3})([1-9][0-9]*)")
WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
LITERAL = re.compile(r"[0-9]+(\.[0-9]+)?")
ARITY = {"SUM": (1, None), "MIN": (1, None), "MAX": (1, None), "COUNT": (1, None),
         "CONCAT": (1, None), "IF": (2, 3), "ROUND": (2, 2)}
REFERENCE_FUNCTIONS = {"SUM", "MIN", "MAX", "COUNT", "CONCAT"}
COMPARISONS = ("<=", ">=", "<>", "=", "<", ">")
EMPTY = object()


class Error(str):
    pass


class ParseError(Exception):
    pass


def column_number(letters):
    n = 0
    for ch in letters.upper():
        n = n * 26 + ord(ch) - 64
    return n


def split_address(address):
    m = CELL.fullmatch(address)
    return column_number(m.group(1)), int(m.group(2))


def rounded(value, places):
    with localcontext() as ctx:
        ctx.prec = 400
        return Decimal(repr(value)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)


def display_number(value):
    text = format(rounded(value, 9), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def text_of(value):
    if value is EMPTY:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float):
        return display_number(value)
    return value


def to_number(value):
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if value is EMPTY:
        return 0.0
    if isinstance(value, float):
        return value
    stripped = value.strip(" ")
    if NUMBER.fullmatch(stripped):
        return float(stripped)
    return Error("#VALUE!")


# ---------- tokenizer and parser ----------

def tokenize(text):
    """Tokens are (kind, value, start, end); offsets let ranges and sheet prefixes forbid spaces."""
    tokens, i = [], 0
    while i < len(text):
        ch, start = text[i], i
        if ch == " ":
            i += 1
            continue
        if ch == '"':
            i, out = i + 1, []
            while True:
                if i >= len(text):
                    raise ParseError()
                if text[i] == '"':
                    if text[i + 1:i + 2] != '"':
                        break
                    i += 1
                out.append(text[i])
                i += 1
            i += 1
            tokens.append(("str", "".join(out), start, i))
            continue
        m = LITERAL.match(text, i) or WORD.match(text, i)
        if m:
            kind = "num" if ch.isdigit() else "word"
            value = float(m.group()) if kind == "num" else m.group()
            i = m.end()
        elif text[i:i + 2] in ("<=", ">=", "<>"):
            kind, value, i = "op", text[i:i + 2], i + 2
        elif ch in "+-*/^&=<>(),:!":
            kind, value, i = "op", ch, i + 1
        else:
            raise ParseError()
        tokens.append((kind, value, start, i))
    tokens.append(("end", None, len(text), len(text)))
    return tokens


class Parser:
    def __init__(self, tokens, sheet):
        self.tokens, self.pos, self.sheet = tokens, 0, sheet

    def peek(self):
        return self.tokens[self.pos]

    def take(self):
        token = self.tokens[self.pos]
        self.pos += 1
        return token

    def is_op(self, *ops):
        t = self.peek()
        return t[0] == "op" and t[1] in ops

    def expect(self, op):
        if not self.is_op(op):
            raise ParseError()
        return self.take()

    def parse(self):
        node = self.comparison()
        if self.peek()[0] != "end":
            raise ParseError()
        return node

    def binary(self, operand, ops):
        node = operand()
        while self.is_op(*ops):
            op = self.take()[1]
            node = ("bin", op, node, operand())
        return node

    def comparison(self):
        return self.binary(self.concat, COMPARISONS)

    def concat(self):
        return self.binary(self.additive, ("&",))

    def additive(self):
        return self.binary(self.term, ("+", "-"))

    def term(self):
        return self.binary(self.power, ("*", "/"))

    def power(self):
        return self.binary(self.unary, ("^",))

    def unary(self):
        if self.is_op("+", "-"):
            op = self.take()[1]
            return ("neg" if op == "-" else "pos", self.unary())
        return self.primary()

    def glued(self):
        """True when the next token touches the previous one, with no space between."""
        return self.tokens[self.pos - 1][3] == self.tokens[self.pos][2]

    def cell(self):
        t = self.take()
        m = CELL.fullmatch(t[1]) if t[0] == "word" else None
        if not m:
            raise ParseError()
        return column_number(m.group(1)), int(m.group(2))

    def reference(self, sheet):
        first = self.cell()
        if self.is_op(":") and self.glued():
            self.take()
            if not self.glued():
                raise ParseError()
            return ("range", sheet, first, self.cell())
        return ("ref", sheet, first)

    def primary(self):
        t = self.take()
        if t[0] in ("num", "str"):
            return ("lit", t[1])
        if t[0] == "op" and t[1] == "(":
            node = self.comparison()
            self.expect(")")
            return ("paren", node)
        if t[0] != "word":
            raise ParseError()
        word = t[1]
        if self.is_op("!") and self.glued():
            self.take()
            if not self.glued():
                raise ParseError()
            return self.reference(word)
        if self.is_op("("):
            self.take()
            args = []
            if not self.is_op(")"):
                while True:
                    args.append(self.comparison())
                    if not self.is_op(","):
                        break
                    self.take()
            self.expect(")")
            return ("call", word.upper(), args)
        if CELL.fullmatch(word):
            self.pos -= 1
            return self.reference(self.sheet)
        if word.upper() in ("TRUE", "FALSE"):
            return ("lit", word.upper() == "TRUE")
        raise ParseError()


def parse(formula, sheet):
    """Returns the tree, or an error code for the whole cell."""
    try:
        tree = Parser(tokenize(formula[1:]), sheet).parse()
    except ParseError:
        return Error("#PARSE!")
    calls = list(walk_calls(tree))
    if any(name not in ARITY for name, _ in calls):
        return Error("#NAME?")
    for name, count in calls:
        low, high = ARITY[name]
        if count < low or (high is not None and count > high):
            return Error("#PARSE!")
    return tree


def walk_calls(node):
    kind = node[0]
    if kind == "call":
        yield node[1], len(node[2])
        for arg in node[2]:
            yield from walk_calls(arg)
    elif kind == "bin":
        yield from walk_calls(node[2])
        yield from walk_calls(node[3])
    elif kind in ("neg", "pos", "paren"):
        yield from walk_calls(node[1])


def range_cells(corner_a, corner_b):
    (c1, r1), (c2, r2) = corner_a, corner_b
    for row in range(min(r1, r2), max(r1, r2) + 1):
        for col in range(min(c1, c2), max(c1, c2) + 1):
            yield col, row


def references(node):
    kind = node[0]
    if kind == "ref":
        yield node[1], node[2]
    elif kind == "range":
        for cell in range_cells(node[2], node[3]):
            yield node[1], cell
    elif kind == "call":
        for arg in node[2]:
            yield from references(arg)
    elif kind == "bin":
        yield from references(node[2])
        yield from references(node[3])
    elif kind in ("neg", "pos", "paren"):
        yield from references(node[1])


# ---------- evaluation ----------

class Workbook:
    def __init__(self, sheets):
        self.sheets = sheets
        self.raw = {}
        for name, cells in sheets.items():
            for address, text in cells.items():
                if text != "":
                    self.raw[(name, split_address(address))] = text
        self.trees = {}
        for key, text in self.raw.items():
            if text.startswith("="):
                self.trees[key] = parse(text, key[0])
        self.cyclic = self.find_cycles()
        self.values = {}

    def find_cycles(self):
        edges = {}
        for key, tree in self.trees.items():
            if not isinstance(tree, Error):
                edges[key] = {ref for ref in references(tree)
                              if ref[0] in self.sheets and ref in self.trees}
        cyclic = set()
        for start in edges:
            seen, stack = set(), list(edges[start])
            while stack:
                node = stack.pop()
                if node == start:
                    cyclic.add(start)
                    break
                if node not in seen:
                    seen.add(node)
                    stack.extend(edges.get(node, ()))
        return cyclic

    def value(self, key):
        if key[0] not in self.sheets:
            return Error("#REF!")
        if key in self.cyclic:
            return Error("#CYCLE!")
        if key not in self.raw:
            return EMPTY
        if key not in self.values:
            text = self.raw[key]
            if key in self.trees:
                tree = self.trees[key]
                result = tree if isinstance(tree, Error) else self.compute(tree)
            elif NUMBER.fullmatch(text.strip(" ")):
                result = float(text.strip(" "))
            else:
                result = text
            self.values[key] = result
        return self.values[key]

    def compute(self, node):
        kind = node[0]
        if kind == "lit":
            return node[1]
        if kind == "paren":
            return self.compute(node[1])
        if kind == "ref":
            return self.value((node[1], node[2]))
        if kind == "range":
            return Error("#VALUE!")
        if kind in ("neg", "pos"):
            operand = self.compute(node[1])
            if isinstance(operand, Error):
                return operand
            number = to_number(operand)
            if isinstance(number, Error) or kind == "pos":
                return number
            return -number
        if kind == "bin":
            left, right = self.compute(node[2]), self.compute(node[3])
            for side in (left, right):
                if isinstance(side, Error):
                    return side
            return binary(node[1], left, right)
        return self.call(node[1], node[2])

    def argument_values(self, arg):
        """Values of one argument, and whether it is a reference argument."""
        if arg[0] == "ref":
            return [self.compute(arg)], True
        if arg[0] == "range":
            if arg[1] not in self.sheets:
                return [Error("#REF!")], True
            return [self.value((arg[1], cell)) for cell in range_cells(arg[2], arg[3])], True
        return [self.compute(arg)], False

    def call(self, name, args):
        if name == "IF":
            condition = self.compute(args[0])
            if isinstance(condition, Error):
                return condition
            if isinstance(condition, str):
                return Error("#VALUE!")
            chosen = condition is not EMPTY and bool(condition)
            if chosen:
                return self.compute(args[1])
            return self.compute(args[2]) if len(args) == 3 else False
        if name == "ROUND":
            x, d = self.compute(args[0]), self.compute(args[1])
            for v in (x, d):
                if isinstance(v, Error):
                    return v
            x, d = to_number(x), to_number(d)
            for v in (x, d):
                if isinstance(v, Error):
                    return v
            return float(rounded(x, int(d)))
        groups = [self.argument_values(arg) for arg in args]
        if name == "COUNT":
            return float(sum(1 for values, _ in groups for v in values
                             if isinstance(v, float)))
        for values, _ in groups:
            for v in values:
                if isinstance(v, Error):
                    return v
        if name == "CONCAT":
            return "".join(text_of(v) for values, _ in groups for v in values)
        numbers = []
        for values, is_reference in groups:
            for v in values:
                if is_reference:
                    if isinstance(v, float):
                        numbers.append(v)
                else:
                    number = to_number(v)
                    if isinstance(number, Error):
                        return number
                    numbers.append(number)
        if name == "SUM":
            return finite(sum_in_order(numbers))
        if not numbers:
            return 0.0
        return min(numbers) if name == "MIN" else max(numbers)


def sum_in_order(numbers):
    total = 0.0
    for n in numbers:
        total += n
    return total


def finite(value):
    return value if math.isfinite(value) else Error("#NUM!")


def binary(op, left, right):
    if op == "&":
        return text_of(left) + text_of(right)
    if op in COMPARISONS:
        return compare(op, left, right)
    a, b = to_number(left), to_number(right)
    for v in (a, b):
        if isinstance(v, Error):
            return v
    if op == "+":
        return finite(a + b)
    if op == "-":
        return finite(a - b)
    if op == "*":
        return finite(a * b)
    if op == "/":
        return Error("#DIV/0!") if b == 0 else finite(a / b)
    if a == 0 and b < 0:
        return Error("#DIV/0!")
    if a < 0 and not b.is_integer():
        return Error("#NUM!")
    try:
        return finite(math.pow(a, b))
    except OverflowError:
        return Error("#NUM!")


def rank(value):
    if isinstance(value, bool):
        return 2
    if isinstance(value, float):
        return 0
    return 1


def compare(op, left, right):
    if left is EMPTY and right is EMPTY:
        left = right = 0.0
    elif left is EMPTY:
        left = False if isinstance(right, bool) else "" if isinstance(right, str) else 0.0
    elif right is EMPTY:
        right = False if isinstance(left, bool) else "" if isinstance(left, str) else 0.0
    a, b = (rank(left), left), (rank(right), right)
    if a[0] == b[0] == 1:
        a, b = (1, left.lower()), (1, right.lower())
    return {"=": a == b, "<>": a != b, "<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b}[op]


def display(value):
    if value is EMPTY:
        return "0"
    return text_of(value)


def evaluate(sheets):
    book = Workbook(sheets)
    result = {}
    for name, cells in sheets.items():
        out = {}
        for address, text in cells.items():
            if text != "":
                out[address] = display(book.value((name, split_address(address))))
        result[name] = out
    return result
`;

// Each workbook maps sheet -> cell -> [raw text, expected display]. `null` means the cell is empty
// and must be absent from the output.
const GROUPS = {
  'number-syntax': [{
    L: {
      A1: ['007', '7'], A2: [' 12 ', '12'], A3: ['-0', '0'], A4: ['1.50', '1.5'], A5: ['+1', '+1'],
      A6: ['.5', '.5'], A7: ['5.', '5.'], A8: ['1e3', '1e3'], A9: ['1_000', '1_000'], A10: ['inf', 'inf'],
      A11: ['٣', '٣'], A12: ['\t5', '\t5'], A13: ['#DIV/0!', '#DIV/0!'], A14: ['TRUE', 'TRUE'],
      A15: ['', null], A16: ['abc ', 'abc '], A17: ['-3.25', '-3.25'],
      B1: ['=A1+A2', '19'], B2: ['=A5+1', '#VALUE!'], B3: ['=A8*1', '#VALUE!'], B4: ['=A11+0', '#VALUE!'],
      B5: ['=A12+0', '#VALUE!'], B6: ['=A14+0', '#VALUE!'], B7: ['=A15+1', '1'], B8: ['="  4 "*2', '8'],
      B9: ['=" 4.0"+0', '4'], B10: ['=A13&1', '#DIV/0!1'], B11: ['=A3&""', '0'], B12: ['=A10*1', '#VALUE!'],
      B13: ['=A9=1000', 'FALSE'], B14: ['="-0.50"*1', '-0.5'], B15: ['=A6+0', '#VALUE!'],
    },
    Empty: {},
  }],
  precedence: [{
    P: {
      A1: ['=-2^2', '4'], A2: ['=2^3^2', '64'], A3: ['=2^-2', '0.25'], A4: ['=--2', '2'], A5: ['=1+2*3', '7'],
      A6: ['=(1+2)*3', '9'], A7: ['=2*3^2', '18'], A8: ['=10-4-3', '3'], A9: ['=16/4/2', '2'],
      A10: ['="a"&1+2', 'a3'], A11: ['=1+2&3', '33'], A12: ['=1<2=TRUE', 'TRUE'], A13: ['=1=1=1', 'FALSE'],
      A14: ['=-3^2', '9'], A15: ['=2*-3', '-6'], A16: ['=1-(-1)', '2'], A17: ['=-2^0.5', '#NUM!'],
      A18: ['=2^0.5', '1.414213562'], A19: ['=-(2^2)', '-4'], A20: ['=4-2^2*3', '-8'], A21: ['=1&2=12', 'FALSE'],
      A22: ['=3>2>1', 'TRUE'], A23: ['=+-+2', '-2'], A24: ['=2&3^2', '29'], A25: ['=100/10*2', '20'],
      A26: ['=2^2^-1', '0.25'], A27: ['=-2^-2', '0.25'], A28: ['=2^3^2=2^9', 'FALSE'],
    },
  }],
  references: [{
    Data: {
      A1: ['5', '5'], B2: ['7', '7'], AA1: ['1', '1'], AZ3: ['2', '2'], BA1: ['3', '3'], ZZ9: ['4', '4'],
      C1: ['x', 'x'], C3: ['=TRUE', 'TRUE'],
    },
    Main: {
      A1: ['=Data!A1+Data!B2', '12'], A2: ['=data!A1', '#REF!'], A3: ['=Blank!A1', '0'], A4: ['=Blank!A1+1', '1'],
      A5: ['=Nope!A1', '#REF!'], A6: ['=SUM(Data!B2:A1)', '12'], A7: ['=Data!aa1+Data!az3+Data!ba1', '6'],
      A8: ['=Data!zz9', '4'], A9: ['=SUM(Data!Y1:AB1)', '1'], A10: ['=A11', '0'], A11: ['', null],
      A12: ['=Z99&"x"', 'x'], A13: ['=COUNT(Data!A1:C3)', '2'], A14: ['=SUM(Data!AY1:BA3)', '5'],
      A15: ['=main!A1', '#REF!'], A16: ['=Main!A1*2', '24'], A17: ['=SUM(Nope!A1:B2)', '#REF!'],
      A18: ['=COUNT(Nope!A1:B2, 1)', '1'], A19: ['=CONCAT(Data!A1:C1)', '5x'], A20: ['=CONCAT(Data!C1:A1)', '5x'],
      A21: ['=Data!C3', 'TRUE'], A22: ['=SUM(Data!ZY9:ZZ9)', '4'], A23: ['=SUM(Data!A1:A1)', '5'],
    },
    Blank: {},
  }],
  functions: [{
    F: {
      A1: ['3', '3'], A2: ['x', 'x'], A3: ['=TRUE', 'TRUE'], A5: ['="4"', '4'], A6: ['-2', '-2'],
      B1: ['=SUM(A1:A6)', '1'], B2: ['=SUM(A1,A2,A3)', '3'], B3: ['=SUM("3", TRUE, 1)', '5'],
      B4: ['=SUM((A3))', '1'], B5: ['=SUM((A2))', '#VALUE!'], B6: ['=SUM(A5)', '0'], B7: ['=SUM(A5+0)', '4'],
      B8: ['=MIN(A2:A3)', '0'], B9: ['=MAX(A1:A6)', '3'], B10: ['=MIN(A1:A6, 10)', '-2'], B11: ['=MAX(A2, -5)', '-5'],
      B12: ['=COUNT(A1:A6, "3", 3, TRUE)', '3'], B13: ['=COUNT(A4)', '0'], B14: ['=COUNT((A1))', '1'],
      B15: ['=CONCAT(A1:A6)', '3xTRUE4-2'], B16: ['=CONCAT(1/4, "-", TRUE)', '0.25-TRUE'],
      B17: ['=IF(A1, "yes", "no")', 'yes'], B18: ['=IF(A4, "yes", "no")', 'no'], B19: ['=IF(A2, 1, 2)', '#VALUE!'],
      B20: ['=IF(0, 1)', 'FALSE'], B21: ['=IF(TRUE, A4)', '0'], B22: ['=IF(TRUE, A4)&"z"', 'z'],
      B23: ['=IF(A5, 1, 2)', '#VALUE!'], B24: ['=ROUND(2.5, 0)', '3'], B25: ['=ROUND(-2.5, 0)', '-3'],
      B26: ['=ROUND(0.125, 2)', '0.13'], B27: ['=ROUND(2.675, 2)', '2.68'], B28: ['=ROUND(1250, -2)', '1300'],
      B29: ['=ROUND(1.2345, 2.9)', '1.23'], B30: ['=ROUND(1.2345, -0.5)', '1'], B31: ['=ROUND("1.55", 1)', '1.6'],
      B32: ['=ROUND(A2, 1)', '#VALUE!'], B33: ['=ROUND(A4, 0)', '0'], B34: ['=ROUND(-0.4, 0)', '0'],
      B35: ['=sum(1,2)+Max(3)', '6'], B36: ['=IF(-0.5, 1, 2)', '1'], B37: ['=SUM(A1:A6)/COUNT(A1:A6)', '0.5'],
      B38: ['=ROUND(1.005, 2)', '1.01'], B39: ['=MIN(A6, A1)', '-2'], B40: ['=CONCAT(A4)', ''],
      B41: ['=SUM(A1:A6, A2)', '1'], B42: ['=IF(A3, A1:A2, 0)', '#VALUE!'], B43: ['=SUM(IF(TRUE, A4), 2)', '2'],
      B44: ['=SUM(IF(TRUE, A2), 2)', '#VALUE!'], B45: ['=MAX(A3, 0.5)', '0.5'], B46: ['=MAX((A3), 0.5)', '1'],
    },
  }],
  comparison: [{
    C: {
      A1: ['10', '10'], A2: ['abc', 'abc'],
      B1: ['="a"="A"', 'TRUE'], B2: ['="a"<"B"', 'TRUE'], B3: ['=1<"a"', 'TRUE'], B4: ['="z"<TRUE', 'TRUE'],
      B5: ['=FALSE<TRUE', 'TRUE'], B6: ['=A3=0', 'TRUE'], B7: ['=A3=""', 'TRUE'], B8: ['=A3=FALSE', 'TRUE'],
      B9: ['=A3<1', 'TRUE'], B10: ['=A3<>""', 'FALSE'], B11: ['=0.1+0.2=0.3', 'FALSE'], B12: ['="10"<"9"', 'TRUE'],
      B13: ['=A1<"9"', 'TRUE'], B14: ['=A2<>"ABC"', 'FALSE'], B15: ['=A3=Z9', 'TRUE'], B16: ['=A3<-1', 'FALSE'],
      B17: ['=TRUE=1', 'FALSE'], B18: ['=A2>=A1', 'TRUE'], B19: ['="abc"<"abd"', 'TRUE'], B20: ['=A3>=FALSE', 'TRUE'],
      B21: ['="10"=10', 'FALSE'], B22: ['=A1=10', 'TRUE'], B23: ['="B"<"a"', 'FALSE'], B24: ['=A3<"a"', 'TRUE'],
      B25: ['=A3>TRUE', 'FALSE'], B26: ['=A1>=10', 'TRUE'], B27: ['=A1<>A1', 'FALSE'],
    },
  }],
  errors: [{
    E: {
      B1: ['1', '1'], B2: ['2', '2'],
      A1: ['=1/0', '#DIV/0!'], A2: ['=0^-1', '#DIV/0!'], A3: ['=10^300*10^300', '#NUM!'], A4: ['=10^400', '#NUM!'],
      A5: ['=(-8)^(1/3)', '#NUM!'], A6: ['=(-8)^3', '-512'], A7: ['=0^0', '1'], A8: ['=1/0+"x"', '#DIV/0!'],
      A9: ['="x"+1/0', '#DIV/0!'], A10: ['=Nope!A1&1/0', '#REF!'], A11: ['=A1+A5', '#DIV/0!'], A12: ['=A5+A1', '#NUM!'],
      A13: ['=SUM(A11:A12)', '#DIV/0!'], A14: ['=SUM(A12,A11)', '#NUM!'], A15: ['=SUM("x", 1/0)', '#DIV/0!'],
      A16: ['=COUNT(1/0, 1, A1:A7)', '3'], A17: ['=IF(TRUE, 1, 1/0)', '1'], A18: ['=IF(FALSE, Nope!A1, 2)', '2'],
      A19: ['=B1:B2+1', '#VALUE!'], A20: ['=B1:B2', '#VALUE!'], A21: ['=IF(B1:B2, 1, 2)', '#VALUE!'],
      A22: ['=SUM(B1:B2+1)', '#VALUE!'], A23: ['=SUM((B1:B2))', '#VALUE!'], A24: ['=CONCAT("a", A1, Nope!A1)', '#DIV/0!'],
      A25: ['=-A1', '#DIV/0!'], A26: ['=IF(A1, 1, 2)', '#DIV/0!'], A27: ['=ROUND(1/0, Nope!A1)', '#DIV/0!'],
      A28: ['=ROUND("x", 1/0)', '#DIV/0!'], A29: ['=A1=A1', '#DIV/0!'], A30: ['=MIN(B1:B2, 1/0)', '#DIV/0!'],
      A31: ['=2/(1-1)', '#DIV/0!'], A32: ['=0/0', '#DIV/0!'], A33: ['=(-1)^0.5', '#NUM!'], A34: ['=(-2)^-1', '-0.5'],
      A35: ['=0^-0.5', '#DIV/0!'], A36: ['="x"*(A5)', '#NUM!'], A37: ['="x"*2', '#VALUE!'],
      A38: ['=MAX(10^300*10^300)', '#NUM!'], A39: ['=B1&A1', '#DIV/0!'], A40: ['=COUNT(B1:B2+1)', '0'],
      A41: ['=SUM(B1:B2)&""', '3'], A42: ['=A1:A2&"x"', '#VALUE!'],
    },
  }],
  parsing: [{
    R: {
      A1: ['=', '#PARSE!'], A2: ['=1+', '#PARSE!'], A3: ['=(1', '#PARSE!'], A4: ['=1.', '#PARSE!'], A5: ['=.5', '#PARSE!'],
      A6: ['=1e3', '#PARSE!'], A7: ['=A0', '#PARSE!'], A8: ['=A01', '#PARSE!'], A9: ['=ABCD1', '#PARSE!'],
      A10: ['=SUM(1,)', '#PARSE!'], A11: ['=T !A1', '#PARSE!'], A12: ['=T! A1', '#PARSE!'], A13: ['=T!A1 :A2', '#PARSE!'],
      A14: ['=B1:T!B2', '#PARSE!'], A15: ["='x'", '#PARSE!'], A16: ['="abc', '#PARSE!'], A17: ['=$A$1', '#PARSE!'],
      A18: ['=1 2', '#PARSE!'], A19: ['=FOO(1)', '#NAME?'], A20: ['=sum(1)+foo(2)', '#NAME?'], A21: ['=foo(1,)', '#PARSE!'],
      A22: ['=IF(1)', '#PARSE!'], A23: ['=ROUND(1)', '#PARSE!'], A24: ['=SUM()', '#PARSE!'], A25: ['=IF(1,2,3,4)', '#PARSE!'],
      A26: ['=bar()', '#NAME?'], A27: ['=B1(1)', '#NAME?'], A28: ['=true', 'TRUE'], A29: ['=tRuE', 'TRUE'],
      A30: ['=TRUE()', '#NAME?'], A31: [' =1', ' =1'], A32: ['= 1 + 2 ', '3'], A33: ['=sum (1, 2)', '3'],
      A34: ['=foo', '#PARSE!'], A35: ['=A1B', '#PARSE!'], A36: ['=A36+', '#PARSE!'], A37: ['=foo(A37)', '#NAME?'],
      A38: ['=A1+1', '#PARSE!'], A39: ['=A19&"x"', '#NAME?'], A40: ['="say ""hi"""', 'say "hi"'], A41: ['=T!a1+1', '2'],
      A42: ['=T!A1:B1', '#VALUE!'], A43: ['=SUM(T!A1:b1)', '1'], A44: ['=1+2)', '#PARSE!'], A45: ['=((2))', '2'],
      A46: ['=_x', '#PARSE!'], A47: ['=ZZZ1', '0'], A48: ['=IF(,1,2)', '#PARSE!'], A49: ['=SUM(1;2)', '#PARSE!'],
      A50: ['=1 +', '#PARSE!'], A51: ['=T!SUM(1)', '#PARSE!'], A52: ['=R!A41', '2'], A53: ['=2+-', '#PARSE!'],
      A54: ['=Foo!A1', '#REF!'], A55: ['=SUM(T!A1: B1)', '#PARSE!'], A56: ['=""""', '"'],
    },
    T: {A1: ['1', '1']},
  }],
  cycles: [{
    Y: {
      A1: ['=A1', '#CYCLE!'], A2: ['=A3+1', '#CYCLE!'], A3: ['=A2*2', '#CYCLE!'], A4: ['=A2+1', '#CYCLE!'],
      A5: ['=COUNT(A2:A3)', '0'], A6: ['=COUNT(A2:A4, 1)', '1'], A7: ['=SUM(A6:A8)', '#CYCLE!'], A8: ['5', '5'],
      B1: ['=IF(TRUE, 1, B2)', '#CYCLE!'], B2: ['=B1+1', '#CYCLE!'], B3: ['=IF(FALSE, A2, 7)', '7'],
      B4: ['=IF(TRUE, 3, A2)', '3'], B5: ['=Z!A1+1', '#CYCLE!'], B6: ['=Z!A2', '#REF!'], B7: ['=3', '3'],
      B8: ['=C1', '#CYCLE!'], B9: ['=IF(TRUE, 1, C1)', '1'], B10: ['=CONCAT("a", B9)', 'a1'],
      C1: ['=C2', '#CYCLE!'], C2: ['=C1', '#CYCLE!'], C3: ['=SUM(C4:C5)', '#CYCLE!'], C4: ['2', '2'], C5: ['=C3', '#CYCLE!'],
      C6: ['=foo(C6)', '#NAME?'], C7: ['=C7+', '#PARSE!'], C8: ['=IF(C9="", 1, 2)', '#CYCLE!'], C9: ['=IF(FALSE, C8)', '#CYCLE!'],
      C10: ['=COUNT(C8, C9, 4)', '1'], D1: ['=D2', '#CYCLE!'], D2: ['=D3', '#CYCLE!'], D3: ['=D4', '#CYCLE!'],
      D4: ['=D2', '#CYCLE!'], D5: ['=COUNT(D1)', '0'], D6: ['=IF(COUNT(D1:D4)=0, "clean", "x")', 'clean'],
      D7: ['=Nope!D7', '#REF!'], D8: ['=IF(FALSE, D8, 1)', '#CYCLE!'], D9: ['=COUNT(D8, D9)', '#CYCLE!'],
    },
    Z: {A1: ['=Y!B5*2', '#CYCLE!'], A2: ['=Nope!B6+Y!B7', '#REF!'], A3: ['=Y!D5+1', '1']},
  }],
  display: [{
    D: {
      A1: ['=0.1+0.2', '0.3'], A2: ['=1/3', '0.333333333'], A3: ['=2/3', '0.666666667'], A4: ['=10^20', '100000000000000000000'],
      A5: ['=1/10^10', '0'], A6: ['=-1/10^10', '0'], A7: ['=1.0000000005', '1.000000001'], A8: ['=5/10^10', '0.000000001'],
      A9: ['=1234567.891', '1234567.891'], A10: ['=1/3&""', '0.333333333'], A11: ['=-0', '0'], A12: ['=""', ''],
      A13: ['=123456789.123456789', '123456789.12345679'], A14: ['=2.5', '2.5'], A15: ['=1/8', '0.125'],
      A16: ['=-2/3', '-0.666666667'], A17: ['=1.0000000004999', '1'], A18: ['=0.0000000015', '0.000000002'],
      A19: ['=10^15+0.3', '1000000000000000.2'], A20: ['=ROUND(1/3, 2)&"%"', '0.33%'], A21: ['=7', '7'],
      A22: ['=-1234.5000', '-1234.5'], A23: ['=3*1.1', '3.3'], A24: ['1.0000000005', '1.000000001'],
      A25: ['=CONCAT(0.1+0.2, "|", 10^20)', '0.3|100000000000000000000'], A26: ['=-0.0000000004', '0'],
    },
  }],
};

export const reference = {files: {...original, 'sheet.py': REFERENCE}, answer: 'Implemented the evaluator to SPEC.md.'};
// A strong near-miss: right everywhere except that it takes only the IF condition as a reference,
// so a loop through an untaken IF branch is evaluated instead of being #CYCLE! (rule 28).
const BASELINE = REFERENCE.replace(
  '    elif kind == "call":\n        for arg in node[2]:\n            yield from references(arg)\n',
  '    elif kind == "call":\n        for arg in (node[2][:1] if node[1] == "IF" else node[2]):\n            yield from references(arg)\n');
if (BASELINE === REFERENCE) throw new Error('sheet-eval baseline did not apply');
export const baseline = {files: {...original, 'sheet.py': BASELINE}, answer: 'Implemented the evaluator to SPEC.md.'};

const inputOf = book => Object.fromEntries(Object.entries(book).map(([sheet, cells]) =>
  [sheet, Object.fromEntries(Object.entries(cells).map(([address, [raw]]) => [address, raw]))]));
const expectedOf = book => Object.fromEntries(Object.entries(book).map(([sheet, cells]) =>
  [sheet, Object.fromEntries(Object.entries(cells).filter(([, [, shown]]) => shown !== null).map(([address, [, shown]]) => [address, shown]))]));

/** Cell-by-cell differences, so the evidence names the formulas a candidate got wrong. */
function differences(book, output) {
  const expected = expectedOf(book);
  if (!output || typeof output !== 'object' || Array.isArray(output)) return [{output: bounded(output, 80)}];
  const wrong = Object.keys(output).filter(sheet => !(sheet in expected)).map(sheet => ({extraSheet: sheet}));
  for (const [sheet, cells] of Object.entries(book)) {
    const got = output[sheet];
    if (!got || typeof got !== 'object') { wrong.push({missingSheet: sheet}); continue; }
    for (const address of new Set([...Object.keys(cells), ...Object.keys(got)])) {
      const want = cells[address]?.[1] ?? null;
      const actual = Object.hasOwn(got, address) ? got[address] : null;
      if (!isDeepStrictEqual(actual, want)) wrong.push({cell: `${sheet}!${address}`, raw: cells[address]?.[0] ?? null, got: actual, want});
    }
  }
  return wrong;
}

export async function grade({files, python, trace, lane, control, agent}) {
  const checks = [...await pythonHygiene(python, files, 'sheet.py')];
  const mutated = [];
  for (const [group, books] of Object.entries(GROUPS)) {
    const inputs = books.map(inputOf);
    const r = await observeCases(python, {module: 'sheet', function: 'evaluate', calls: inputs.map(input => [input])});
    const cells = books.reduce((n, book) => n + Object.values(book).reduce((m, sheet) => m + Object.keys(sheet).length, 0), 0);
    const wrong = [];
    books.forEach((book, i) => {
      const record = r.value?.[i];
      if (!r.ok || !record) return;
      if (record.error) wrong.push({workbook: i, raised: record.error});
      else wrong.push(...differences(book, record.output));
      if (!isDeepStrictEqual(record.args, [inputs[i]])) mutated.push(`${group}#${i}`);
    });
    checks.push(check(group, 'correctness', r.ok && r.value?.length === books.length && wrong.length === 0,
      r.ok ? `${wrong.length} of ${cells} cells wrong; wrong=${bounded(wrong)}` : r.diagnostic));
  }
  checks.push(check('input-unchanged', 'correctness', mutated.length === 0, `workbooks modified by evaluate: ${bounded(mutated)}; expected=[] (rule 4)`));
  return [...checks, preserved(files, original, ['sheet.py']),
    ...toolChecks(trace, ['SPEC.md', 'sheet.py'], 'check_public.py', false, {lane, control, agent})];
}
