# Spreadsheet evaluator

Implement `evaluate(sheets)` in `sheet.py`. Every rule below is required. Rules are numbered so
they can be cited; they apply together, not one at a time.

## Input and output

1. `sheets` is a dict from sheet name to a dict from cell address to raw text (a `str`).
   Addresses in the input are upper-case column letters followed by a row number, like `A1` or `AB12`.
   A sheet may have no cells at all; it still exists.
2. A cell whose raw text is the empty string is empty. It behaves exactly like a cell that is not in
   the input. Every cell that is not in the input is empty.
3. Return a dict of the same shape: for every sheet, every non-empty input cell maps to its display
   text (rule 30). Empty cells are left out, but every sheet appears, even with no cells.
4. Do not modify `sheets`.

## Values

5. A value is a number (a Python `float`), a string, a boolean, an error, or *empty* (the value of a
   reference to an empty cell).
6. **Number syntax** is: an optional `-`, one or more ASCII digits `0`-`9`, then optionally `.` and one
   or more ASCII digits. Nothing else is a number: not `+1`, `.5`, `5.`, `1e3`, `1_000`, `inf`, or
   non-ASCII digits.
7. A raw text starting with `=` is a formula (rules 10-18). Otherwise, if the raw text with its leading
   and trailing space characters (U+0020 only) removed matches the number syntax, the cell is that
   number. Otherwise the cell is the string, exactly as given, unstripped.
8. Errors are these seven codes: `#PARSE!`, `#NAME?`, `#REF!`, `#VALUE!`, `#DIV/0!`, `#NUM!`, `#CYCLE!`.
   A raw text that looks like an error code is still just a string.
9. **Text of a value**: a number's text is its display (rule 30); a boolean's is `TRUE` or `FALSE`;
   empty's is the empty string; a string's is itself.

## Formula grammar

10. After the leading `=`, a formula is one expression. Space characters may appear between any two
    tokens and at either end. Any text that does not match this grammar makes the cell `#PARSE!`.
11. Tokens, each as long as possible (so `1e3` is the number `1` then the word `e3`):
    - a number literal: ASCII digits, optionally `.` and more ASCII digits (no sign, no exponent);
    - a string literal in double quotes, where `""` inside it stands for one `"`;
    - a *word*: a letter or `_`, then letters, digits and `_`;
    - the operators `+ - * / ^ & = <> < > <= >=`, and `( ) , : !`.
12. A word is read as follows, in this order:
    - if it is directly followed by `!` it is a sheet name, and a cell reference must directly follow
      the `!` (no spaces anywhere in `Sheet!A1`);
    - else if the next token is `(` it is a function name (rule 19);
    - else if it is 1 to 3 letters followed by a row number of 1 or more written without leading zeros
      (`A1`, `zz10`; not `A0` or `A01`), it is
      a cell reference; column letters are case-insensitive;
    - else if it is `TRUE` or `FALSE` in any case, it is a boolean literal;
    - else the formula is `#PARSE!`.
    Sheet names are case-sensitive.
13. A range is two cell references joined by `:` (`A1:B3`, with no spaces). Only the first may carry a
    sheet prefix (`Data!A1:B3`), and the whole range is on that sheet. Its corners may be given in
    any order: `B3:A1` is the same range as `A1:B3`.
14. Column letters number `A`=1 ... `Z`=26, `AA`=27, `AZ`=52, `BA`=53, and so on.
15. Operator precedence, lowest first: comparison (`= <> < > <= >=`), then `&`, then `+ -`, then `* /`,
    then `^`, then unary `-` and `+`. Every binary operator is left-associative, including `^`
    (`2^3^2` is 64). Unary operators bind tighter than `^` (`-2^2` is 4) and may repeat (`--2` is 2).
16. A cell reference or range on a sheet name that is not in the input evaluates to `#REF!`.
17. A formula that matches the grammar but calls a function not listed in rule 19 (names are
    case-insensitive) makes the cell `#NAME?`. Otherwise, a call with an argument count outside the
    one allowed makes the cell `#PARSE!`. Grammar first, then names, then argument counts.
18. A cell that is `#PARSE!` or `#NAME?` because of rule 10, 12 or 17 has no references (rule 28).

## Functions

19. Functions and their argument counts: `SUM`, `MIN`, `MAX`, `COUNT`, `CONCAT` take one or more;
    `IF` takes 2 or 3; `ROUND` takes exactly 2. An empty argument (`SUM(1,)`) is `#PARSE!`.
20. A *reference argument* is an argument that is exactly a cell reference or a range, optionally
    sheet-prefixed, with nothing else (not even parentheses) around it. Any other argument is a
    *value argument*.
21. `SUM`, `MIN`, `MAX`: collect numbers from the arguments. From a reference argument, take the
    numbers among its cells and ignore strings, booleans and empty cells. A value argument is
    converted to a number (rule 25). `SUM` adds them; `MIN` and `MAX` return 0 when nothing was
    collected.
22. `COUNT` counts cells of reference arguments whose value is a number, plus value arguments whose
    value is a number (no conversion). `COUNT` never returns an error: errors are not counted.
23. `CONCAT` joins the text (rule 9) of each argument; for a reference argument, the text of each of
    its cells.
24. `IF(c, a, b)`: evaluate `c` and convert it: a boolean is itself, a number is `TRUE` unless 0,
    empty is `FALSE`, a string is `#VALUE!`. Then evaluate only the chosen argument and return its
    value, which may be empty. A missing `b` is `FALSE`.
    `ROUND(x, d)`: convert both to numbers (rule 25), truncate `d` toward zero, and round `x` to `d`
    decimal places (`d` may be negative) with rule 31. `x`'s error comes before `d`'s.

## Operators and conversions

25. **To number**: a number is itself; `TRUE` is 1 and `FALSE` is 0; empty is 0; a string whose text,
    with leading and trailing spaces removed, matches the number syntax is that number; any other
    string is `#VALUE!`.
26. Arithmetic (`+ - * / ^` and unary `-` `+`) converts its operands to numbers.
    Dividing by 0 is `#DIV/0!`, and so is 0 raised to a negative power. A negative number raised to a
    non-integer power is `#NUM!`. Any result that is not finite is `#NUM!`. `0^0` is 1.
    `&` joins the text (rule 9) of its operands.
27. Comparison gives a boolean. If one operand is empty it becomes 0, `""` or `FALSE` to match the
    other operand's type; if both are empty both are 0. Operands of different types order as
    number < string < boolean. Numbers compare by value; strings compare case-insensitively (compare
    their lower-cased forms); `FALSE` < `TRUE`.

## Errors and cycles

28. A formula's *references* are every cell named anywhere in it, including every cell of every range
    and cells inside `IF` arguments that are not chosen. References on sheets not in the input do not
    count. A cell is *in a cycle* when following references from it, formula by formula, can lead
    back to itself (a cell that refers to itself included). Such a cell displays `#CYCLE!` whatever
    its formula would give.
29. Errors are values. Operands and arguments are evaluated left to right, and range cells row by
    row, top to bottom, left to right within a row. An operator or function (other than `COUNT` and
    the unchosen `IF` argument) that meets an error returns the first error met in that order,
    before any conversion of its own. Reading a cell in a cycle meets `#CYCLE!`. A range used anywhere
    other than as a reference argument of `SUM`, `MIN`, `MAX`, `COUNT` or `CONCAT` is `#VALUE!`.

## Display

30. Display text: an error is its code; a boolean is `TRUE` or `FALSE`; a string is itself; empty
    (a formula whose result is a reference to an empty cell) is `0`; a number is formatted by rule 31
    to 9 decimal places, then trailing zeros after the decimal point are removed, then a trailing
    `.` is removed, and `-0` becomes `0`. No exponent notation is ever used: 1e20 displays as
    `100000000000000000000`.
31. **Rounding** a number to `n` places means: take the shortest decimal text that reads back as the
    same float (what Python's `repr` gives), and round that decimal half away from zero. So 2.5
    rounds to 3 at 0 places, 2.675 rounds to 2.68 at 2 places, and 1.0000000005 displays as `1.000000001`.
