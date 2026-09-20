# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-20

## State

- Fourteen tasks. Across the whole record the suite separates the bottom of the table by ~36 points (Haiku 59%, Sonnet 80%, Opus 95% at n=19 before this session) and still guesses at the top. `retry-rollup` remains the only task that has ever caught the middle candidate (1/3 · 2/3 · 3/3).
- **Do not trust a one-repeat run.** Twelve tasks at one repetition once read 90/91/93; the full record reads 59/80/95.
- Four tasks carry a design rubric: `duplicate-rule`, `event-ledger`, `regression-boundary`, `reconcile-plan`. The reviewer reproduces the recorded standard **104/104** on their 26 calibration cases, zero invented and zero missed defects.
- `harnessHash` no longer covers `report.ts` or `tui.ts`. Runs before commit `34c5b10` sit in their own comparison group for that reason alone; that is expected, not a bug.
- `claude-code/opus`, `sonnet` and `haiku` are enabled. Codex OAuth is still rejected server-side; Kimi quota is still exhausted. Public at **https://github.com/blackhat-7/forseti**, tracking `origin/main`.
- Full battery after every change below: `npm run check` clean · `npm test` **55/55** · `npm run test:suite` **14 tasks / 28 controls, every reference clean, every baseline rejected; 4 calibration sets** · `npm run test:judge` **104/104**. `npm run test:terminal` was **not** re-run: nothing in the TUI changed.

## Done this session

- **Added `zip-manifest` and `double-delivery`** on the `retry-rollup` recipe: shipped code that passes `check_public.py`, hidden cases aimed at one wrong spelling each (`rstrip` as a suffix, versions as text, a truthy zero, a stray entry; dedup keyed on the delivery id, `isinstance(True, int)`, a transaction left open across a raise). References 16/16 and 11/11; baselines rejected 10/16 and 6/11.
- **Measured them: they do not separate this tier.** 3 repeats × 3 models, run `2026-09-20T14-31-08-443Z-6d55ccee`: Opus 6/6, Sonnet 6/6, Haiku 5/6 (one zero-constant miss). Every submission rewrote the module from scratch, so the shipped traps never got a vote. Kept for weaker models and partial credit. The PLAN line stays open with this recorded.
- **Stopped rendering-only changes from splitting comparison groups.** `harnessFiles` in `src/runner.ts` hashes `src/` without `report.ts` and `tui.ts`. A test pins that a report edit keeps the hash and a sandbox edit changes it.
- **Gave three more tasks a design rubric** with six calibration cases each, two of them clean traps for length and comment bias. Every rubric shares `unearned-abstraction`, `dead-code` and `explanatory-noise` and adds one task-specific question.

## Next

The open PLAN line. The lesson from this session and from `stuck-job`: a stated rule in Python is translation work, and this tier translates well. What has discriminated is a medium where the *correct* spelling is unobvious even with the rule in hand (`date(x,'weekday 1')`, `NOT IN` against NULL). Look for more of those before building anything else. **Do not start another full-suite run.**

## Gotchas

- **Running `python3` against a fixture directory writes `__pycache__` into it**, and `fixture()` then dies with `EISDIR`. Always `python3 -B`, and check `ls -a` on the fixture afterwards.
- **A calibration case is Python inside a JS template literal.** Indentation must match where the fragment lands, and a `\d` needs doubling. `npm run test:suite` catches both by running the case against the hidden checks.
- **A float trap cannot travel through the observation driver.** JavaScript has one number type, so `20.0` arrives as `20`. Only `$float`-tagged nonfinite values survive.
- **`quality` is a substring of `equality`.** A blind `sed s/quality/hygiene/` corrupts `regression-boundary`'s title and prompt.
- **`npm run test:terminal` and `npm run test:judge` spend Claude plan quota.** The PTY test copies `forseti.json` with the reviewer enabled.
- **A reviewer's thinking level is part of its identity.** Re-run `npm run test:judge` after any reviewer change.
- **"3 turns" and "3 rounds" are different things.** The reviewer's `--max-turns` is 3, a fix. Raising it to 3 *rounds* is `repeat`.
- lean-ctx resolves a different active project root, so reads outside this workspace are denied, including `/private/tmp`. Use the native reader for those.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`. `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`.
