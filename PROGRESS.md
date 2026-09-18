# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-18

## State

- Twelve tasks, all hardened enough that their controls reject a near-miss baseline, not just the untouched fixture.
- **The suite cannot separate Claude models at one repetition.** Full-suite, one repeat, suite hash `efc33deac272`: Haiku **90%**, Sonnet **91%**, Opus **93%**. What actually discriminates is `migration-safety` (caught Opus and Sonnet on the same rule, `R3`) and `duplicate-rule`'s design reviewer (caught Sonnet and Haiku).
- **`json-only` has failed 77/77 trials and never once passed**, across Haiku, Sonnet and Opus. Every Claude Code model fences its final answer. It is scored under `instructions`, so that whole column is contaminated by a constant. Top item in `PLAN.md`.
- `claude-code/opus` is now an enabled model. Codex OAuth is still rejected server-side; Kimi quota is still exhausted.
- Full battery after every change below: `npm run check` clean · `npm test` **48/48** · `npm run test:suite` **12 tasks / 24 controls, reference 89/89, baseline 56/89 rejected on all 12**. `npm run test:terminal` and `npm run test:judge` were **not** re-run.
- Public at **https://github.com/blackhat-7/forseti**, tracking `origin/main`.

## Done this session

- **Hardened the five tasks that had never failed a correctness check.** `coverage-audit` grew to nine branches with a second impossible state that only a cross-column `CHECK` rules out; `source-map` became a route table declaring five routes and serving three; `artifact-contract` went from five manifests to ten; `regression-boundary` from fifteen cases to twenty; `pause-correction` gained a staged `apply_migration.py` and an operator note that argues against the pause.
- **Re-measured. It did not work: all five still pass for all three models.** Opus solved the two hardest first try and explained both traps back in its answer. Kept rather than disabled — removing them separates the three models no better (83/86/86) and weaker local models are what they now measure. Numbers in `docs/transcript-research.md`.
- Every hardened task's `baseline` is now a near-miss that matches the reference on all pre-existing cases, so `test:suite` proves the *added* traps are what reject it.
- `pause-correction` gained a `no-apply-executed` tools check with its own trace assertions in `verify-controls.mjs`, and the `evidence` capability.
- Touched: five graders and five fixtures under `suites/personal/`, `suite.json` (four prompts), `verify-controls.mjs`, `docs/transcript-research.md`, `docs/verification.md`, `docs/suite-contract.md`.

## Next

First unchecked line in `PLAN.md`: stop scoring `json-only` as a model instruction failure.

## Gotchas

- **Running `python3` against a fixture directory writes `__pycache__` into it**, and `fixture()` then dies with `EISDIR`. Always `python3 -B`, and check `ls -a` on the fixture afterwards.
- **A float trap cannot travel through the observation driver.** JavaScript has one number type, so `20.0` arrives as `20`. Only `$float`-tagged nonfinite values survive.
- **`quality` is a substring of `equality`.** A blind `sed s/quality/hygiene/` corrupts `regression-boundary`'s title and prompt.
- **`npm run test:terminal` spends Claude plan quota.** `forseti.json` has the reviewer enabled and the PTY test copies that config unchanged.
- **A reviewer's thinking level is part of its identity.** Re-run `npm run test:judge` after any reviewer change.
- **"3 turns" and "3 rounds" are different things.** The reviewer's `--max-turns` is 3, a fix. Raising it to 3 *rounds* is `repeat`.
- lean-ctx resolves a different active project root, so reads outside this workspace are denied, including `/private/tmp`. Use the native reader for those. Do not reconfigure it.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`. `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`.
