# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-21

## State

- Nineteen tasks. Across the whole record the suite separates the bottom of the table by ~36 points (Haiku 59%, Sonnet 80%, Opus 95% at n=19). **`due-dates` is the first task the report calls a separation between Opus and Sonnet**: pooled over two runs Opus 6/6, Sonnet 1/5 (one stall), Haiku 0/2. `retry-rollup` (2/3 vs 3/3) and `iso-weeks` (2/3 vs 3/3) lean the same way but stay inside the noise.
- **Do not trust a one-repeat run.** Twelve tasks at one repetition once read 90/91/93; the full record reads 59/80/95.
- Four tasks carry a design rubric: `duplicate-rule`, `event-ledger`, `regression-boundary`, `reconcile-plan`. The reviewer reproduces the recorded standard **104/104**.
- `claude-code/opus`, `sonnet` and `haiku` are enabled. Codex OAuth is still rejected server-side; Kimi quota is still exhausted. Public at **https://github.com/blackhat-7/forseti**, tracking `origin/main`.
- Battery this session: `npm run check` clean · `npm test` **56/56** · `npm run test:suite` passes (references 19/19, 13/13, 18/18; shipped baselines rejected 5/19, 4/13, 7/18). `test:terminal` and `test:judge` were not re-run: no UI or reviewer change.

## Done this session

- **Added `due-dates`, `all-green` and `iso-weeks`, three SQL idiom-trap tasks** built to the `retry-rollup` recipe: the fixture ships the obvious query, it passes `check_public.py`, and each hidden row aims at one spelling that looks right and is not.
- `due-dates`: overdue invoices as of an instant. Traps: SQLite's `'+1 month'` does not clamp (Jan 31 → Mar 3), a payment filter in `WHERE` drops the invoices with no payment, `SUM` over no rows is NULL, and a text compare on an offset moves a payment across `:asof`.
- `all-green`: profiles whose every run in a window succeeded. Traps: `SUM(status <> 'succeeded') = 0`, `MIN(status)`, `NOT EXISTS (... <> ...)` all ignore a NULL status; `MAX(finished_at)` on text picks the wrong instant; driving from the profile set includes a profile with no run in the window.
- `iso-weeks`: deploys per ISO 8601 week. Traps: `strftime('%Y-W%W')` labels January 1 2034 as `2034-W00` and is one week behind for all of 2032; the ISO spelling is `%G-W%V`. Plus offsets and the half-open end.
- **Measured at 3 repeats** (three `reports/comparison-2026-09-20T*` files): `due-dates` Opus 3/3 + 3/3, Sonnet 1/3 + 0/2 (one timeout), Haiku 0/2; `all-green` Opus 3/3, Sonnet 2/2, Haiku 0/2; `iso-weeks` Opus 3/3, Sonnet 2/3, Haiku 0/3. The first run hit the plan rate limit at trial 16 of 18. Every Sonnet failure on `due-dates` is `month-end-clamps`: nobody but Opus wrote the clamp.
- **The suite snapshot outgrew the 80-file cap.** `files()` in `src/files.ts` now takes a `limit`, and `loadSuite` reads the whole suite under the 400-entry bound. The per-trial workspace cap is unchanged. This changes `harnessHash`; every task hash changed anyway, because a task hash covers all of `private/`.

## Next

The open PLAN line is still the top one and needs one more task like `due-dates`. What discriminated is behaviour the engine offers no spelling for: Postgres and MySQL clamp `+1 month`, SQLite does not, and the fix is an expression nobody has memorised. A rule the prompt states (`all-green`) or a format code the docs name (`iso-weeks`, `%G-W%V`) gets found by Sonnet. **Do not start another full-suite run.**

## Gotchas

- **The Claude plan rate limit stops the whole run for that provider**, and the remaining trials of every Claude model are skipped. Budget a measurement below the limit or expect `not-run` rows.
- **Running `python3` against a fixture directory writes `__pycache__` into it**, and `fixture()` then dies with `EISDIR`. Always `python3 -B`, and check `ls -a` on the fixture afterwards.
- **A calibration case is Python inside a JS template literal.** Indentation must match where the fragment lands, and a `\d` needs doubling. `npm run test:suite` catches both.
- **A float trap cannot travel through the observation driver.** JavaScript has one number type, so `20.0` arrives as `20`. Only `$float`-tagged nonfinite values survive.
- **`quality` is a substring of `equality`.** A blind `sed s/quality/hygiene/` corrupts `regression-boundary`'s title and prompt.
- **`npm run test:terminal` and `npm run test:judge` spend Claude plan quota.** The PTY test copies `forseti.json` with the reviewer enabled and restores it afterwards.
- **The UI test fixture is a 24-row window.** A scorecard longer than 13 lines is paged, so a test asserting on the lower sections must pass `fixture('subscription', 60)`.
- **A reviewer's thinking level is part of its identity.** Re-run `npm run test:judge` after any reviewer change.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`. `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`.
