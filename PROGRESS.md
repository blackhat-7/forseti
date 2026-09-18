# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-18

## State

- The framework is built and documented. The **suite is the weak part**, and the numbers say so: across 145 graded Claude Code trials, six of twelve tasks have never failed for a capable model and 36 of 55 checks have never failed. The two open `PLAN.md` items both follow from this.
- That evidence lives in `runs/`, which is gitignored, so it is on this machine only. A fresh clone cannot reproduce or check those numbers.
- The design reviewer works and is validated: `claude-code/sonnet`, thinking medium, 1 round, **32/32** agreement, zero invented and zero missed defects.
- Full battery run this session, after every change below: `npm run check` clean · `npm test` **48/48** · `npm run test:suite` **12 tasks / 24 controls, exit 0** · `TMPDIR="$PWD/.tmp" npm run test:terminal` **PASS**. `npm run test:judge` was **not** re-run after the rename; it does not touch the `hygiene` dimension, and it spends plan quota.
- Public at **https://github.com/blackhat-7/forseti**, tracking `origin/main`. `gitleaks` pre-commit hook passing.

## Done this session

- **Renamed the `quality` dimension to `hygiene`, and stopped reporting it as a score.** Its three checks — `python-ast-parses`, `python-stdlib-imports`, `python-no-eval-exec` — are 50 passes and 0 failures each across every recorded trial, so "Quality 100%" beside "Correctness 91%" read as praise for something never measured. It is now a gate: the markdown report shows `ok (30)` or `2 failed` in its own column, and the TUI scorecard shows one `Hygiene gate` line instead of a full-width bar. A UI test asserts no bar comes back.
- The freed slot in the TUI bar series went to `Design`, which is a real score and was not being charted at all.
- `readRun` maps the legacy `quality` label to `hygiene` on read, so runs recorded before today still show their gate instead of `n/a`. Saved manifests are not rewritten.
- Touched: `src/types.ts`, `src/config.ts`, `src/report.ts` (new `gate()`), `src/runner.ts`, `src/tui.ts`, all seven graders plus `helpers.mjs` (`pythonQuality` → `pythonHygiene`), `suites/personal/suite.json`, `verify-controls.mjs`, `README.md`, `docs/suite-contract.md`, `docs/verification.md`, `docs/transcript-research.md`.

## Next

First unchecked line in `PLAN.md`: retire or harden the six tasks that have never discriminated — `coverage-audit`, `source-map`, `regression-boundary`, `pause-correction`, `artifact-contract`, `duplicate-rule`. Done when every enabled task has at least one recorded failure from a capable model, or is disabled with the reason recorded.

## Gotchas

- **`quality` is a substring of `equality`.** A blind `sed s/quality/hygiene/` corrupts `regression-boundary`'s title and prompt. Any further rename needs anchored patterns.
- **`npm run test:terminal` spends Claude plan quota.** `forseti.json` has the reviewer enabled, the PTY test copies that config unchanged, and `duplicate-rule` declares `design`, so the control run makes a real reviewer call. ~25s instead of ~15s. Disable the reviewer first if quota is tight.
- **Only the Claude Code login works.** Codex OAuth is rejected server-side (`Provided authentication token is expired`) though the stored token looks valid; a read-only preflight cannot see server-side revocation. Kimi's monthly quota is exhausted. Forseti will not rotate a token or buy quota.
- **A reviewer's thinking level is part of its identity.** Changing it invalidates the agreement number. Re-run `npm run test:judge` after any reviewer change.
- **"3 turns" and "3 rounds" are different things.** The reviewer's `--max-turns` is 3, a fix. Raising it to 3 *rounds* is `repeat`, an open task under `PLAN.md` Later.
- Auto mode's gatekeeper classifier fails closed intermittently and blocks all tool calls. Refresh the Codex login in Pi and retry. Do not change auto-mode configuration.
- lean-ctx resolves a different active project root, so some reads outside this workspace are denied, including files under `/private/tmp`. Use the native reader for those. Do not reconfigure it.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`.
- `CLAUDE.md` is a symlink to `AGENTS.md`. Edit `AGENTS.md`.
