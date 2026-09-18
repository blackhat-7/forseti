# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-18

## State

- Twelve tasks, all hardened enough that their controls reject a near-miss baseline, not the untouched fixture. **The suite does separate these models — by about 36 points.** Across all recorded trials, counting turn/time exhaustion as failure: Haiku **59%**, Sonnet **80%**, Opus **95%** (n=19). Equal weight per task: solved **66/86/91**, checks passed **81/89/96**. The separation lives in `weekly-coverage`, `migration-safety`, `event-ledger`, `shared-count` and `reconcile-plan`.
- **Do not trust a one-repeat run.** A single full-suite repeat read 90/91/93 and was briefly written up as "the models are indistinguishable". It was a lucky draw for Haiku; twelve tasks at one repetition is a dozen coin flips.
- **Every trial that ever ran out of turns or time is Haiku's** — 8 of them, none for Sonnet or Opus. They stay out of correctness, but the report and TUI now show a `Stalled` count and the score recomputed with stalls as failures. On the run that exposed it, Haiku reads `83%` with `1 · 71% if counted`.
- **`json-only` used to fail 81/81 and now separates models.** It demanded bare text, which every Claude Code model fails because it fences its final answer. One fence now passes; a preamble or trailing note still fails. Re-graded on every recorded answer: Haiku **24%**, Sonnet **81%**, Opus **75%**.
- `claude-code/opus` is now an enabled model. Codex OAuth is still rejected server-side; Kimi quota is still exhausted. Public at **https://github.com/blackhat-7/forseti**, tracking `origin/main`.
- Full battery after every change below: `npm run check` clean · `npm test` **53/53** · `npm run test:suite` **12 tasks / 24 controls, reference 89/89, baseline 56/89 rejected on all 12** · `TMPDIR="$PWD/.tmp" npm run test:terminal` **PASS**. `npm run test:judge` was **not** re-run.

## Done this session

- **Made `esc` and `q` mean the same thing at every level: leave what you are looking at.** Before, `esc` backed out of a panel but did nothing at the top and `q` quit at the top but did nothing in a panel. Typed-text dialogs still take `q` as a letter, and `q` during a run still refuses to cancel.
- **Added partial credit.** A `Checks` column beside `Correct`, averaged per trial then per task so a nine-check task cannot outweigh a one-check task; a flat rate reverses the model order and a test pins that. The per-task table shows the share for anything not fully solved.
- **Fixed `json-only` and `concise-json`, which graded the chat client.** `unfenced()` in `helpers.mjs` strips one fence wrapping the whole answer before either check runs. The four JSON prompts plus `pause-correction` now state the rule instead of leaving it inferred. 10 packaging cases in `verify-controls.mjs`.
- **Made stalls visible without scoring them.** `stalled()` and `scoreCountingStalls` in `src/report.ts`; a `Stalled` column in the markdown scorecard and a `Stalled` line in the TUI, both hidden when there are none. A provider refusal is deliberately not a stall. Two tests, one framework and one UI.
- **Hardened the five tasks that had never failed a correctness check.** `coverage-audit` grew to nine branches with a second impossible state that only a cross-column `CHECK` rules out; `source-map` became a route table declaring five routes and serving three; `artifact-contract` went from five manifests to ten; `regression-boundary` from fifteen cases to twenty; `pause-correction` gained a staged `apply_migration.py` and an operator note that argues against the pause.
- **Re-measured. It did not work: all five still pass for all three models.** Opus solved the two hardest first try and explained both traps back in its answer. Kept rather than disabled: they are flat for every model while five other tasks carry the whole spread. Numbers in `docs/transcript-research.md`. Every hardened `baseline` is now a near-miss matching the reference on all pre-existing cases, so `test:suite` proves the *added* traps are what reject it.
- `pause-correction` gained a `no-apply-executed` tools check and the `evidence` capability. Measured cost per trial, for planning the re-measure: Haiku 65k cache-read / 4.9k out / 51s, Sonnet 50k / 2.6k / 28s, Opus 29k / 2.7k / 39s. **Haiku is the most expensive**, because it grinds the most turns.

## Next

Add tasks that separate the strongest candidates. **Do not start another full-suite run**: one was begun at 3 repeats and stopped at 15 of 108 trials, because ~70 minutes of plan quota only tightens a gap the record already shows at ~30 points and cannot touch the 5-point gap at any price.

## Gotchas

- **Running `python3` against a fixture directory writes `__pycache__` into it**, and `fixture()` then dies with `EISDIR`. Always `python3 -B`, and check `ls -a` on the fixture afterwards.
- **A float trap cannot travel through the observation driver.** JavaScript has one number type, so `20.0` arrives as `20`. Only `$float`-tagged nonfinite values survive.
- **`quality` is a substring of `equality`.** A blind `sed s/quality/hygiene/` corrupts `regression-boundary`'s title and prompt.
- **`npm run test:terminal` spends Claude plan quota.** `forseti.json` has the reviewer enabled and the PTY test copies that config unchanged.
- **A reviewer's thinking level is part of its identity.** Re-run `npm run test:judge` after any reviewer change.
- **"3 turns" and "3 rounds" are different things.** The reviewer's `--max-turns` is 3, a fix. Raising it to 3 *rounds* is `repeat`.
- lean-ctx resolves a different active project root, so reads outside this workspace are denied, including `/private/tmp`. Use the native reader for those. Do not reconfigure it.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`. `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`.
