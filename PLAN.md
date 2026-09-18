# Plan

One line per task, ordered. Top unchecked line is next. `[ ]` open · `[~]` in progress · `[x]` done.
Each line carries its own done-check. A task too big for one session gets split before it is started.

## Now

- [x] Put the workspace under git: `git init`, confirm `.gitignore` covers `node_modules/ .cache/ .tmp/ .state/ runs/`, commit everything else. Done when `git log` shows one commit and `git status` is clean.
- [x] Validate the reviewer. `npm run test:judge` at the saved settings (`claude-code/sonnet`, thinking medium, 1 round): **32/32**, zero invented and zero missed defects. Needed the judge turn cap raised from 1 to 3 first — a denied tool call still consumes a turn, so the reviewer was exiting with no result and silently scoring nothing.
- [x] **Stop reporting floor checks as "Quality".** `python-ast-parses`, `python-stdlib-imports`, `python-no-eval-exec` are 50 passes / 0 failures each across every Claude Code trial: they cannot fail, so a 100% headline is misleading. Renamed to `hygiene` everywhere, and it now reports as a gate (`ok (30)` / `2 failed`) instead of a percentage. No bar, no rate. Legacy runs map the old label on read so they stay readable.
- [ ] **Retire or harden the six tasks that have never discriminated.** Over 145 graded trials: `coverage-audit` 18/18, `source-map` 8/8, `regression-boundary` 8/8, `pause-correction` 8/8, `artifact-contract` 7/7, `duplicate-rule` 6/6. Done when every enabled task has at least one recorded failure from a capable model, or is disabled with the reason recorded.
- [ ] **Give more than one task a design rubric.** Only `duplicate-rule` declares `design`, so the reviewer can barely move the score. Done when at least four tasks carry a `review` export with calibration cases.
- [ ] Rerun `npm start -- run --models openai-codex-gpt-5-5 --tests shared-count,incident-window --repeat 2` and regenerate `reports/live-smoke.md`. Done when both report groups share the current suite and harness hash.
- [ ] Run Sonnet vs Haiku on `duplicate-rule` with the reviewer on, then `npm run test:judge -- --run <id> --alt <provider>/<model>`. Done when a self-preference number exists for real submissions.
- [ ] Add a second entitled live model when quota allows. Done when one run compares two live models under the same harness, with no recorded provider failure standing in for a result.

## Later

- [ ] Raise the reviewer to 3 rounds and re-measure. Single-round judging was unstable in milestone 18; majority settling is what `repeat` exists for.
- [ ] Grow the judge calibration set past eight cases, from real disagreements rather than invented ones.
