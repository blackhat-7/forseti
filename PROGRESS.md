# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-18

## State

- The framework is built and documented. The **suite is the weak part**, and now has numbers proving it.
- The design reviewer works and is validated: `claude-code/sonnet`, thinking medium, 1 round, **32/32** agreement with the recorded standard, zero invented and zero missed defects.
- All checks run this session: `npm run check` clean · `npm test` **47/47** · `npm run test:suite` **12 tasks / 24 controls, exit 0** · `npm run test:judge` **32/32** · `TMPDIR="$PWD/.tmp" npm run test:terminal` **PASS**.
- Public at **https://github.com/blackhat-7/forseti**, tracking `origin/main`. `gitleaks` pre-commit hook passing.

## Done this session

- **Fixed the reviewer, which had been scoring nothing.** Its `--max-turns` was 1. Denying a tool does not stop a model reaching for one, so a single rejected tool call consumed the only turn, the CLI exited with no result message, and every trial got a `judgeNote` instead of a design score. Raised to 3 in `claudeCodeJudgeArgs`.
- Re-ran calibration at the settings actually saved in `forseti.json` (thinking `medium`). The earlier 32/32 was measured at thinking `off` and never applied to this config; `judgeIdentity` includes thinking, so the two were always separate experiments.
- **Measured how little the suite discriminates.** Across 145 graded Claude Code trials, six of twelve tasks have never once failed for a capable model: `coverage-audit` 18/18, `source-map` 8/8, `regression-boundary` 8/8, `pause-correction` 8/8, `artifact-contract` 7/7, `duplicate-rule` 6/6. 36 of 55 distinct checks have never failed. The real signal sits in four tasks: `migration-safety` 8/24, `incident-window` 11/20, `shared-count` and `event-ledger` 10/17.
- Confirmed the `quality` dimension cannot fail: `python-ast-parses`, `python-stdlib-imports`, `python-no-eval-exec` are 50 passes and 0 failures each. A "Quality 100%" headline is a floor gate reported as a score.
- Added three tasks to `PLAN.md` from those findings, and four entries to `DECISIONS.md`.

## Next

First unchecked line in `PLAN.md`: rename the `quality` dimension to `hygiene` through types, config, graders, suite manifest, report and TUI, so no view shows a number that is structurally incapable of moving.

## Gotchas

- **`npm run test:terminal` now spends Claude plan quota.** `forseti.json` has the reviewer enabled, the PTY test copies that config unchanged, and `duplicate-rule` declares `design` — so the control run makes a real reviewer call. Runtime went from ~15s to ~25s. Disable the reviewer before the smoke test if quota is tight.
- **Only the Claude Code login works.** Codex OAuth is rejected server-side (`Provided authentication token is expired`) though the stored token looks valid; a read-only preflight cannot see server-side revocation. Kimi's monthly quota is exhausted. Forseti will not rotate a token or buy quota.
- **A reviewer's thinking level is part of its identity.** Changing it invalidates the agreement number. Re-run `npm run test:judge` after any reviewer change.
- Auto mode's gatekeeper classifier fails closed intermittently and blocks all tool calls. Refresh the Codex login in Pi and retry. Do not change auto-mode configuration.
- lean-ctx resolves a different active project root, so some reads outside this workspace are denied, including files under `/private/tmp`. Use the native reader for those. Do not reconfigure it.
- Runs before `19-09-01` predate the suite-hardening and rubric changes, so their hashes differ. Keep them; reports split them into separate groups rather than pooling.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`.
- `CLAUDE.md` is a symlink to `AGENTS.md`. Edit `AGENTS.md`.
