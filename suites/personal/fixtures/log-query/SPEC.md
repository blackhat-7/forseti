# Log filter query language

Implement `run_query(query, records)` in `query.py`. Every rule below is required. Rules are
numbered so they can be cited; they apply together, not one at a time.

## Input and output

1. `query` is a `str`. `records` is a list of dicts parsed from JSON, so values are dicts, lists,
   strings, ints, floats, booleans or `None`.
2. If the query is well formed, return `{"matches": [...]}`: the indices of the records it matches,
   ascending. If it is malformed, return `{"error": {"code": CODE, "position": P}}` where `P` is a
   0-based character index into `query`. A malformed query is an error even when `records` is empty.
3. Do not modify `records`.

## Tokens

4. Whitespace (space, tab, newline, carriage return) separates tokens and is otherwise ignored.
   Each token is as long as possible.
5. A **path** is a word `[A-Za-z_][A-Za-z0-9_]*`, optionally followed by more words each introduced
   by a `.` with no spaces around it: `status`, `req.path`, `a.b_2.c`. A `.` that is not directly
   followed by a word is an `unexpected-character` error at the `.`.
6. A path of one word that equals `and`, `or`, `not`, `in`, `true`, `false` or `null`, in any case,
   is that keyword, not a path. A path of several words is never a keyword (`req.in` is a path).
7. A **number** is an optional `-`, one or more ASCII digits, and optionally `.` and one or more ASCII
   digits. If a `.` directly after the digits is not followed by a digit, it is a `bad-number` error
   at the number's first character. A `-` not directly followed by a digit is an
   `unexpected-character` error at the `-`.
8. Letters directly after a number's digits are its **unit**; the unit is all the consecutive
   letters. Durations: `ms` 0.001, `s` 1, `m` 60, `h` 3600, `d` 86400 (in seconds). Sizes: `b` 1,
   `kb` 1024, `mb` 1048576, `gb` 1073741824 (in bytes). Units are lower case only. Any other unit is
   a `bad-unit` error at the unit's first letter.
9. A number's value is its decimal digits times its unit's factor, computed exactly, then rounded
   once to the nearest float. So `300ms` equals `0.3` and `1.5kb` equals `1536`.
10. A **string** is written in double quotes. Inside it, `\"` is `"`, `\\` is `\`, `\n` is a newline
    and `\t` is a tab. A backslash followed by anything else, or by nothing because it ends
    the query, is a `bad-escape` error at the backslash. A string with no closing quote is an `unterminated-string` error at its opening quote.
    Every other character stands for itself.
11. The operators are `=`, `!=`, `<`, `<=`, `>`, `>=`, `~`, `!~`, and the punctuation is `(`, `)`, `,`.
    Any other character outside a string (for example `'`, `&`, or `!` alone) is an
    `unexpected-character` error at that character.
12. The whole query is tokenized, left to right, before it is parsed. Tokenizing stops at the first
    error it meets, and that error is reported even if the tokens before it would not parse. Inside
    a string the scan meets a bad escape before it can find the string unterminated, so `"a\q`
    is `bad-escape` at 2.

## Grammar

13. A query that is empty or only whitespace matches every record.
14. Otherwise the query is one *expression*:
    ```
    expression := and_expr ("or" and_expr)*
    and_expr   := not_expr ("and" not_expr)*
    not_expr   := "not" not_expr | "(" expression ")" | comparison
    comparison := path operator literal
                | path "in" "(" literal ("," literal)* ")"
    literal    := number | string | "true" | "false" | "null"
    ```
    So `not` binds tighter than `and`, which binds tighter than `or`.
15. `~` and `!~` take a string literal only. Any other literal after them is an `unexpected-token`
    error at that literal.
16. `null` may only follow `=` or `!=`, or appear in an `in` list. Anywhere else it is an
    `unexpected-token` error at the `null`.
17. The string after `~` or `!~` is a Python `re` pattern (after rule 10's escapes are applied). If it
    does not compile, that is a `bad-regex` error at the string's opening quote.
18. Parsing reads left to right and reports the first problem it meets. A token that cannot continue
    the grammar is an `unexpected-token` error at the token's first character. Running out of tokens
    where one is required is an `unexpected-end` error at position `len(query)`. Rules 15-17 are
    checked as soon as their literal is read, so they win over any problem further right.

## Matching

19. A path is looked up by following its words through nested dicts, starting from the record. If a
    step meets something that is not a dict, or a dict without that key, the field is **missing**.
    Keys are case-sensitive.
20. A field that is missing or `None` is **absent**. `path = null` is true exactly when the field is
    absent, and `path != null` is true exactly when it is not. Every other comparison with an
    absent field is false, whatever the operator: `!=`, `~` and `!~` included.
21. Kinds: a number is an `int` or `float` that is not a `bool`. Booleans are not numbers, so a field
    holding `true` never equals `1`.
22. Number field and number literal: compare numerically (`1` equals `1.0`).
23. String field and number literal: if the whole string matches rule 7's number syntax with no unit
    (optional `-`, ASCII digits, optional `.` and ASCII digits, nothing else, no spaces), compare its
    value numerically. Otherwise the comparison is false, whatever the operator.
24. String field and string literal: `=` and `!=` compare exactly and case-sensitively; `<`, `<=`,
    `>`, `>=` compare by Unicode code points (Python's `str` ordering).
25. `path ~ "re"` is true when the field is a string and the pattern matches anywhere in it (Python's
    `re.search`). `path !~ "re"` is true when the field is a string and the pattern matches nowhere.
    For any field that is not a string, both are false.
26. Boolean field and boolean literal: `=` and `!=` as usual; `<`, `<=`, `>`, `>=` are false.
27. Every other combination of field kind and literal kind is false for every operator, `!=`
    included. That covers a number field against a string literal, a dict or list field against
    anything but `null`, and a boolean against a number.
28. `path in (a, b, ...)` is true when `path = x` is true for at least one listed literal `x`.
29. `not X` is true exactly when `X` is false. So `not status = 500` is true for a record with no
    `status`, while `status != 500` is false for it.
