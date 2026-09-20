# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-20 (second session that day)

## State

- Sixteen tasks. Across the whole record the suite separates the bottom of the table by ~36 points (Haiku 59%, Sonnet 80%, Opus 95% at n=19) and still guesses at the top. `retry-rollup` remains the only task that has ever caught the middle candidate (1/3 · 2/3 · 3/3). `zip-manifest` and `double-delivery` do not separate this tier (Opus 6/6, Sonnet 6/6, Haiku 5/6).
- **Do not trust a one-repeat run.** Twelve tasks at one repetition once read 90/91/93; the full record reads 59/80/95.
- Four tasks carry a design rubric: `duplicate-rule`, `event-ledger`, `regression-boundary`, `reconcile-plan`. The reviewer reproduces the recorded standard **104/104**.
- `harnessHash` excludes `report.ts` and `tui.ts`, so this session's UI work does not split comparison groups.
- `claude-code/opus`, `sonnet` and `haiku` are enabled. Codex OAuth is still rejected server-side; Kimi quota is still exhausted. Public at **https://github.com/blackhat-7/forseti**, tracking `origin/main`.
- Battery this session: `npm run check` clean · `npm test` **56/56** · `TMPDIR="$PWD/.tmp" npm run test:terminal` **PASS**. `test:suite` and `test:judge` were not re-run: no task, verifier or reviewer changed.

## Done this session

- **Rebuilt the TUI around one question: which model is better at what.** `src/tui.ts` now has a `table` helper (left-aligned name, right-aligned figures) that every table goes through. The scorecard (`Runs → c`) is one row per candidate, sorted by headline, with `±`, partial credit, the other dimensions and the graded count on the same line.
- **Verdicts are stated in words.** Under the table, "What this run can tell apart" lists `X over Y  +N pts  k tasks` for the overall score and for each kind of task (`evidence`, `restraint`, `exactness`, `scope`, `safety`), only where the gap beats two standard errors of the difference on that evidence alone. Pairs tied overall are named. `capabilityCard` in `src/report.ts` is the restriction that makes the per-kind bar honest.
- **The per-task grid folds the tasks everyone agrees on** into a count; `a` shows all of them.
- **Runs are found by what they showed.** The Runs list is `09-20 14:31  Claude sonnet 100% · Claude haiku 83% · Claude opus 100%  2×3`, with the selected run's headline table under the list. Home's recent runs use the same line.
- **Tests show what they measure** (capabilities, dimensions) and eight lines of prompt instead of the whole thing. The footer's last line names the keys for the current view; the in-panel hint lines are gone.
- `docs/tui.md` and `docs/tui-home.svg` regenerated. Three entries in `DECISIONS.md`.

## Next

The open PLAN line: more tasks that separate the strongest candidates. What has discriminated is a medium where the *correct* spelling is unobvious even with the rule in hand (`date(x,'weekday 1')`, `NOT IN` against NULL). **Do not start another full-suite run.** If a run of the whole record is ever selected in the TUI, the verdict block is where the 36-point spread will show as a stated result.

## Gotchas

- **Running `python3` against a fixture directory writes `__pycache__` into it**, and `fixture()` then dies with `EISDIR`. Always `python3 -B`, and check `ls -a` on the fixture afterwards.
- **A calibration case is Python inside a JS template literal.** Indentation must match where the fragment lands, and a `\d` needs doubling. `npm run test:suite` catches both.
- **A float trap cannot travel through the observation driver.** JavaScript has one number type, so `20.0` arrives as `20`. Only `$float`-tagged nonfinite values survive.
- **`quality` is a substring of `equality`.** A blind `sed s/quality/hygiene/` corrupts `regression-boundary`'s title and prompt.
- **`npm run test:terminal` and `npm run test:judge` spend Claude plan quota.** The PTY test copies `forseti.json` with the reviewer enabled and restores it afterwards; a modified `forseti.json` mid-test is expected.
- **The UI test fixture is a 24-row window.** A scorecard longer than 13 lines is paged, so a test asserting on the lower sections must pass `fixture('subscription', 60)`.
- **A reviewer's thinking level is part of its identity.** Re-run `npm run test:judge` after any reviewer change.
- lean-ctx resolves a different active project root, so reads outside this workspace are denied, including `/private/tmp`. Use the native reader for those.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`. `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`.
