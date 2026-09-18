# Plan

One line per task, ordered. Top unchecked line is next. `[ ]` open · `[~]` in progress · `[x]` done.
Each line carries its own done-check. A task too big for one session gets split before it is started.

## Now

- [x] Put the workspace under git: `git init`, confirm `.gitignore` covers `node_modules/ .cache/ .tmp/ .state/ runs/`, commit everything else. Done when `git log` shows one commit and `git status` is clean.
- [ ] After a fresh Pi Codex login, run `npm run test:judge`. Done when an agreement number exists. Until then the reviewer is unvalidated and its design scores must not be read.
- [ ] Rerun `npm start -- run --models openai-codex-gpt-5-5 --tests shared-count,incident-window --repeat 2` and regenerate `reports/live-smoke.md`. Done when both report groups share the current suite and harness hash.
- [ ] Run Sonnet vs Haiku on `duplicate-rule` with the reviewer on, then `npm run test:judge -- --run <id> --alt <provider>/<model>`. Done when a self-preference number exists for real submissions.
- [ ] Add a second entitled live model when quota allows. Done when one run compares two live models under the same harness, with no recorded provider failure standing in for a result.

## Later

- [ ] Raise the reviewer to 3 rounds and re-measure. Single-round judging was unstable in milestone 18; majority settling is what `repeat` exists for.
- [ ] Grow the judge calibration set past eight cases, from real disagreements rather than invented ones.
