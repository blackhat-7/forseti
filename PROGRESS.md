# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-27

## State

- **Runs on Linux now, as well as macOS.** `src/sandbox-linux.py` confines the Python interpreter with Landlock + seccomp before candidate code runs. Needs kernel 6.12+ (Landlock ABI 6), x86_64 or arm64; anything else fails closed.
- **17 tasks in three tiers.** `basic` 6 (every Claude model passes; separates small local models) · `standard` 7 (separates Haiku from Sonnet/Opus) · `hard` 4 (`retry-rollup` plus three new ones). Tier lives in `suite.json` and on every saved run.
- **The three new hard tasks are unmeasured.** `invoice-rounding` (half-up money rounding, float error, "-0.00"), `league-table` (mutable default, `reverse=True` flips the name tie-break, shared ranks), `ticket-sla` (dropped UTC offsets, `timedelta.seconds`). Each ships the wrong code, and it passes the public check. Only `test:suite` has checked them.
- **Recorded result, older suite:** Haiku 59% · Sonnet 80% · Opus 95% (n=19). Only `retry-rollup` has ever separated Sonnet from Opus.
- Full battery on Linux: `npm run check` clean · `npm test` **57/57** · `npm run test:suite` **17 tasks / 34 controls** · `npm run demo` 68/68 trials through the real sandbox. `test:terminal` and `test:judge` **not run**: both spend plan quota.

## Done this session

- **Results page rebuilt as one comparison.** Ranked models with shared ranks for ties, verdict sentences, tables by difficulty and by skill, per-task grid hardest first, other signals last. The markdown report opens with the same page; the old detail sits under `## Details`.
- **Plain words.** Skills: "Only claims what the files show", "No false alarms", "Edge cases right", "Stays within the task", "Safe under retries and failures". "Tasks fully solved", "Checks passed", "Followed output format", "Safe-code gate", "Ran out of turns or time", "tries". Ids in data are unchanged.
- **Same model in several runs with the same `comparisonKey` pools into one line.** Different keys stay separate. Different harnesses share the page with a harness tag and an amber warning.
- **Kanagawa Dragon palette** in `src/tui.ts`, `tools/screenshot.ts` and `docs/tui-home.svg`. The SVG was recoloured, not regenerated.
- The suite got its own file cap (300); trial folders keep 80.

## Next

Measure the new hard tasks (`PLAN.md`). **Do not benchmark local models until the other session tuning them is finished.** Past runs will not pool with new ones: task hashes (tiers) and the harness hash both changed.

## Gotchas

- **Running `python3` against a fixture directory writes `__pycache__` into it**, and `fixture()` then dies with `EISDIR`. Always `python3 -B`, and check `ls -a` afterwards.
- **A float trap cannot travel through the observation driver.** JavaScript has one number type, so `20.0` arrives as `20`. Only `$float`-tagged nonfinite values survive.
- **`quality` is a substring of `equality`.** A blind `sed s/quality/hygiene/` corrupts `regression-boundary`'s title and prompt.
- **`npm run test:terminal` spends Claude plan quota.** `forseti.json` has the reviewer enabled and the PTY test copies that config unchanged.
- **A reviewer's thinking level is part of its identity.** Re-run `npm run test:judge` after any reviewer change.
- **A copied `node_modules` has no `.bin`, so `tsc` is missing.** Run `TMPDIR="$PWD/.tmp" npm ci` after moving machines.
- **The Linux sandbox denies `exec` of anything, even Python.** A grader that needs a subprocess will fail there with `PermissionError`, by design.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`. `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`.
