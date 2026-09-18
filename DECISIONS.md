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

## The design reviewer

- **Off by default.** (M16) It spends quota, and its scores are the only ones here that do not replay from saved artifacts.
- **Five rules make a judged verdict mean something.** (M16) Correctness gates the reviewer; design never touches correctness; binary questions, not a 1-10 score; every defect must cite a line that mechanically verifies against the submission; the reference solution ships in the prompt as the scale anchor.
- **Self-preference is measured, not asserted.** (M16) `test:judge --run <id> --alt <provider>/<model>` splits the defect rate by the family that wrote the code. Reviewing Claude submissions with a Claude reviewer is the case this exists for.
- **Read a perfect agreement score as "no disagreement found yet".** (M18) Eight cases is small by design; the set earns its value by growing from real disagreements.

## Hard-won lessons

- **Look at the instrument's output before changing the thing it measures.** (M18) A citation-check bug was silently discarding *correct* defects. Two full calibration runs were wasted guessing; one raw reviewer reply found it in a minute.
- **A rule that capable models consistently flag is an ambiguous rule, not a model error.** (M14) Two answer keys were wrong and the models caught both.
- **Tests get updated deliberately, never weakened.** (M6) Assertions on text that appears on every screen pass without the view ever opening. Assert view-unique content.
