# Decisions

Why things are the way they are. Append only. One entry, one to three lines. Add one when you choose something a later reader might otherwise undo.

Entries below were extracted on 2026-09-18 from the work log now at `docs/history.md`; they cite the milestone they came from rather than a date. New entries carry a date.

## Boundaries

- **Suite never imports from `src/`.** (M1) Expected values and verdicts stay in trusted JavaScript, so a candidate's own assertions or pass banners can never decide its grade.
- **Grading Python is read-only.** (M3) Otherwise a candidate's import-time writes make the saved artifact snapshot stale.
- **Code tasks are graded through public immutable `observe.py` drivers.** (M3) They return raw output, state and errors only; all judgement stays outside the sandbox.
- **Sandbox read roots are narrow on purpose** (`/opt/homebrew/Cellar` plus the trial dir). (M2, M3) The exact root-directory read is what Python's loader needs. Do not widen it; tests assert the denials.
- **CLI refuses to run outside the workspace root.** (M3) Everything written stays in this directory.

## Credentials and billing

- **Forseti never reads, copies, refreshes or rotates a credential.** (M3, M8) `pi` auth reads `~/.pi/agent/auth.json` without writing. Claude Code authenticates itself.
- **`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_PROFILE` are stripped from the Claude Code child.** (M8) So this path can never silently bill a metered key.
- **`--safe-mode --disable-slash-commands`, not `--bare`.** (M8) `--bare` explicitly refuses the subscription login and demands an API key. `--safe-mode` preserves it (`apiKeySource: "none"`, confirmed live in M9).
- **`--allowedTools` only pre-approves; it does not restrict.** (M9) An explicit `--disallowedTools` deny list is what actually removes Bash, WebFetch, WebSearch and Task.
- **`models add` refuses to silently pick an environment API key.** (M21) `OPENAI_API_KEY` and friends are set in this shell, and the old fallback would have reached them. `--auth env` is now the only route.

## Measurement

- **A harness failure is `not-run`, never a wrong answer.** (M9, M12) Auth, quota, timeout, turn-cap and crash are excluded from correctness. Counting them was the worst bug found; it is the exact false signal this project exists to prevent.
- **Nothing that changes comparability pools.** (M3, M5, M20) Suite hash, harness hash, lane, cache, budgets, agent and reviewer config all live in `comparisonKey`.
- **`claude-code` models may not run alongside Pi-adapter models.** (M8) The table would compare harnesses, not models. The tool dimension is N/A for Claude Code for the same reason.
- **Correctness is weighted equally per task.** (M12) So a task with many checks cannot dominate. Instructions, quality and tools stay separate columns.
- **Prompt caching is on by default.** (M5) Without it the system prompt, tool schemas and transcript are re-sent every turn, which is where a third-party harness quietly costs 2x+ more than the vendor client. It does not change sampling, so correctness is unaffected.
- **Trial time limit defaults to 180s.** (M20) Measured: the slowest real task needs 89-107s, and the old 90s default was a coin flip. A censored trial costs evidence, which is worse than a hung trial taking longer to give up.
- **Turn cap stays at 12.** (M20) Unlike the time limit, raising it lets slow trials do more work and spend more plan quota, so it is the user's call. Cycle it with `T` on Home.
- **The word "failed" never appears for a trial.** (M12) `pass`, `scored` and `not-run` are the three outcomes; "failed" read as "never ran". A UI test asserts this.
- **`hygiene` is a gate, reported as `ok (30)` or `2 failed`, never a rate.** (2026-09-18) It was called `quality` and drawn as a bar, which read as praise for something never measured: its three AST checks have 0 failures across every recorded trial. Do not restore a percentage here; a UI test asserts no bar appears.
- **`readRun` maps the legacy `quality` dimension to `hygiene`.** (2026-09-18) Same three checks under a new name, so mapping on read is truthful and keeps older runs readable. Saved manifests are never rewritten.

## The design reviewer

- **Off by default.** (M16) It spends quota, and its scores are the only ones here that do not replay from saved artifacts.
- **Five rules make a judged verdict mean something.** (M16) Correctness gates the reviewer; design never touches correctness; binary questions, not a 1-10 score; every defect must cite a line that mechanically verifies against the submission; the reference solution ships in the prompt as the scale anchor.
- **Self-preference is measured, not asserted.** (M16) `test:judge --run <id> --alt <provider>/<model>` splits the defect rate by the family that wrote the code. Reviewing Claude submissions with a Claude reviewer is the case this exists for.
- **Read a perfect agreement score as "no disagreement found yet".** (M18) Eight cases is small by design; the set earns its value by growing from real disagreements.
- **The reviewer gets 3 turns, not 1.** (2026-09-18) Denying a tool does not stop a model reaching for one, and a single rejected call consumed the only turn, so the CLI exited with no result and the reviewer silently scored nothing. Three turns lets a stray attempt bounce off the denial and still leave room to answer.
- **Thinking level is part of the reviewer's identity.** (2026-09-18) A calibration at `thinking: off` says nothing about a reviewer running at `medium`. Re-validate after changing it; `judgeIdentity` already refuses to pool them.
- **Generated `reports/comparison-*.md` are not tracked.** (2026-09-18) `exportReport` writes one per export and the PTY smoke test exports every run, so the repo grew by a few hundred lines on each routine verification. The two curated reports the README links are named by hand and stay tracked. Run artifacts already live in the gitignored `runs/`; publish a report by giving it a name.

- **The harness hash leaves out `report.ts` and `tui.ts`.** (2026-09-20) They only read finished trials, and every run in a comparison group is rendered by the same current copy of them, so a wording fix there cannot make two runs incomparable. Hashing them stranded paid-for runs behind rendering changes. Anything that touches a trial still splits the group.

- **Every rubric shares three questions and adds one of its own.** (2026-09-20) `unearned-abstraction`, `dead-code` and `explanatory-noise` are the same text in all four reviewed tasks, so a design score means the same thing across them; the fourth names the duplication that task invites. Each calibration set keeps two clean traps because a judge rewards length and punishes unfamiliar shapes.

- **The scorecard sorts by headline and names every tied pair beside it.** (2026-09-20) A sorted table invites a ranking, so the verdict list under it says which pairs the run can separate, overall and per kind of task, and lists the pairs tied overall by name. A pair not named as apart is tied; the sort never claims more than that.
- **"Better at Z" clears the same bar as "better overall".** (2026-09-20) `capabilityCard` restricts a card to one capability's tasks and `separated` judges that gap on that evidence alone, so a capability backed by one task cannot hand out a verdict a rerun would reverse.
- **Only `report.ts` and `tui.ts` render, so the UI stays in those two files.** (2026-09-20) A new UI module would join the harness hash and split comparison groups on every wording change; a table helper inside `tui.ts` does not.

- **A Python idiom trap does not survive a rewrite.** (2026-09-20) `zip-manifest` and `double-delivery` shipped the obvious wrong spellings and every candidate threw them away and wrote the stated rules directly (Opus 6/6, Sonnet 6/6, Haiku 5/6). The SQL traps discriminate because the *right* spelling is unobvious even with the rule in hand; in Python the rule is the code.

## Hard-won lessons

- **Look at the instrument's output before changing the thing it measures.** (M18) A citation-check bug was silently discarding *correct* defects. Two full calibration runs were wasted guessing; one raw reviewer reply found it in a minute.
- **A rule that capable models consistently flag is an ambiguous rule, not a model error.** (M14) Two answer keys were wrong and the models caught both.
- **Tests get updated deliberately, never weakened.** (M6) Assertions on text that appears on every screen pass without the view ever opening. Assert view-unique content.
- **A dimension that cannot fail must not be reported as a score.** (2026-09-18) The three `quality` AST checks are 50 passes / 0 failures each over every Claude Code trial, so "Quality 100%" reads as praise for something never measured. Count discriminating power before trusting any headline.
- **Check per-task discrimination, not just the average.** (2026-09-18) Six of twelve tasks have never once failed for a capable model, so most of a 91% is tasks everyone passes. A suite average hides which tasks have stopped earning their place.

## Task difficulty (2026-09-18)

- **A saturated task is kept, not deleted, once its controls still reject a near-miss.** (2026-09-18) Five tasks pass for Opus, Sonnet and Haiku even after hardening, but removing them separates those three no better (83/86/86 versus 90/91/93) and weaker local models are what they now measure.
- **Each hardened task's flawed baseline is a near-miss, not the untouched fixture.** (2026-09-18) It matches the reference on every pre-existing case and differs only on the added ones, so `npm run test:suite` proves the *new* traps are what reject it. A baseline that fails for old reasons proves nothing about new ones.
- **Stop hardening when the model explains the trap back to you.** (2026-09-18) Opus named `ENABLED` as the reason a declared route is unreachable and excluded a branch from a cross-column CHECK. Past that point, more difficulty means volume or obscurity, which measures neither the model nor the task.
- **A float trap must survive JSON.** (2026-09-18) A `count` of `20.0` cannot distinguish int from float through the observation driver, because JavaScript has one number type. Nonfinite values have `$float` tags; ordinary floats do not.
- **A one-repetition suite run is not a measurement.** (2026-09-18) Twelve tasks at one repeat read Haiku 90 / Sonnet 91 / Opus 93 and was briefly written up as "these models are indistinguishable". The full record reads 59 / 80 / 95. Never report a spread from a single repeat.
- **Count who the excluded trials belong to before trusting a score.** (2026-09-18) All 8 turn/time exhaustions ever recorded are Haiku's. Excluding them as `not-run` deletes the weakest model's worst trials from its own denominator, which flatters it by 6 points.
- **A stall is counted and shown, never scored.** (2026-09-18) Running out of turns or time stays out of correctness, because a censored trial is not a wrong answer. But it gets its own column with the score recomputed as if stalls were failures, because the excluded trials are never spread evenly: all 8 on record are one model's.
- **A provider refusal is not a stall.** (2026-09-18) Auth, quota, crash and cancellation are the provider or the harness failing and stay pooled under `not run`. Only `budget` and `timeout` are the model failing to converge inside a budget it was told about. A test asserts the two do not merge.
- **A fence is the client; prose is the model.** (2026-09-18) `json-only` demanded bare text and failed 81 of 81 trials, so it graded the chat client and charged every model the same constant. One fenced block around the whole answer now passes; a preamble, a trailing note or JSON buried in prose still fails. That turned a flat 0% into Haiku 24% / Sonnet 81% / Opus 75%.
- **When a check changes, the prompt changes with it.** (2026-09-18) "Return only JSON" left the fence question to be inferred. The prompts now say a single fenced block is fine and nothing else may accompany the answer, so the rubric is disclosed rather than guessed at.
- **Partial credit is weighted per task, never flat.** (2026-09-18) A flat share of all correctness checks lets a nine-check task drown a one-check task, and on the recorded data it reverses the model order outright. Averaged per trial then per task it agrees with the headline: solved 66/86/91, checks 81/89/96.
- **`Checks` sits beside the headline and never replaces it.** (2026-09-18) A task is done or it is not, so correctness stays all-or-nothing. But 0% solved with 80% of checks passed is "close but never complete", which is not the same result as failing outright, and the per-task table now says which one happened.
- **`esc` and `q` both mean "leave what you are looking at".** (2026-09-18) Reported as confusing, and it was: `esc` backed out of a panel but did nothing at the top level, `q` quit at the top level but did nothing in a panel, so neither key worked everywhere. Both now close a panel, else quit. The one carve-out is a dialog taking typed text, where `q` is a letter.
- **Leaving is one key; cancelling a run is still not.** (2026-09-18) During a run `q` only says that `esc` will cancel. Making the unified key also abort would turn a reflex into thrown-away evidence.
- **Effort is allocated by task, never by model name.** (2026-09-18) Skipping a task for one candidate because it has always passed there bakes a prediction about that model into the evidence, and the next model inherits a suite shaped around the last one. A task that never varies earns one repetition from every candidate; a task that swings earns several from every candidate.
- **More trials cannot separate the top of this suite.** (2026-09-18) Priced from the measured record: a 25-point gap needs 3 repeats, a 5-point gap needs 60 — 2160 trials. Precision buys the bottom of the table, never the top. A suite that only ranks its weakest candidate needs harder tasks, not a bigger budget.
- **Do not weight repeats by observed variance on small samples.** (2026-09-18) Weighting looked like it saved 40% until the rates were smoothed; five passes out of five is not proof a task is deterministic, and once that is admitted almost every task has the same spread and uniform repeats win. Smooth before allocating, or the plan talks itself out of the repetitions that would have caught the sixth.
- **A measurement has to be worth its quota, not just correct.** (2026-09-18) The full-suite re-measure was priced honestly at ~70 minutes and 5.9M input, then stopped at 15 trials: it only tightened a gap the pooled record already shows at ~30 points, and could not touch the 5-point gap at any price. Pricing a run is not the same as justifying it; say what the number changes before spending an hour of someone's plan on it.

## What makes a task discriminate (2026-09-18)

- **Interlocking constraints settle in one repetition; independent judgements never do.** Of eleven tasks, only `weekly-coverage` separates candidates decisively (0/3 against 4/4): it is one artifact that must satisfy timezone normalisation, a half-open interval, week bucketing, join de-duplication and a deleted-row filter *simultaneously*, so there is no path of lucky partial guesses. `migration-safety` asks for six independent judgements and is a coin flip for everyone (14% against 54% across 27 trials).
- **Count the independent chances to slip before adding a case.** More cases make a task noisier, not harder. More *interaction between* cases makes it harder. A task whose checks can each fail on their own needs many repetitions to say anything; a task whose checks all depend on one idea needs one.
- **Interlocking constraints are necessary but not sufficient.** (2026-09-18) `stuck-job` was built to the interlock brief — four ideas, each deciding several outputs — first as a structured answer and then as SQL. Every candidate passed both, including the weakest. A fully stated rule set is translation work, and this tier is good at translation.
- **What actually discriminates is a medium where the obvious spelling is quietly wrong.** (2026-09-18) Every recorded failure on `weekly-coverage` is the same idiom: `date(x, 'weekday 1')` is the *next* Monday, not the current week's, and one attempt invented a `'start of week'` modifier that does not exist. The task is hard because the natural expression is wrong and nothing says so — not because the rules are hard to understand.
- **A public check that covers everything removes the difficulty.** (2026-09-18) `weekly-coverage` grades on rows `check_public.py` never sees, so passing it proves nothing. A candidate that iterates to green is still wrong. Any new task needs that gap on purpose.
- **The idiom trap works, and it is the first thing that has caught a strong candidate.** (2026-09-18) `retry-rollup` pairs two spellings everyone reaches for first — `NOT IN (SELECT ...)` against a column holding a NULL, and a `LEFT JOIN` whose test sits in `WHERE` — with public rows arranged so both are *right* on them. Over three repetitions: weakest 1/3, middle 2/3, strongest 3/3. Nothing else in the suite had ever separated the top two.
- **Ship the wrong query as the starting point.** (2026-09-18) `query.sql` in the fixture is the obvious spelling, and it passes `check_public.py`. A candidate that reads the starting query, runs the public check and sees green has been given every reason to stop, which is the situation being measured.
