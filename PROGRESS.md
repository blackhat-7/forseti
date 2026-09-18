# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-18

## State

- The framework is built and documented. The **suite is the weak part**, and now has numbers proving it: across 145 graded Claude Code trials six of twelve tasks have never failed for a capable model, 36 of 55 checks have never failed, and the three `quality` checks are 50 passes to 0 failures each. The top three `PLAN.md` items all follow from this.
- That evidence lives in `runs/`, which is gitignored, so it is on this machine only. A fresh clone cannot reproduce or check those numbers.
- The design reviewer works and is validated: `claude-code/sonnet`, thinking medium, 1 round, **32/32** agreement with the recorded standard, zero invented and zero missed defects.
- Last full battery: `npm run check` clean · `npm test` **47/47** · `npm run test:suite` **12 tasks / 24 controls, exit 0** · `npm run test:judge` **32/32** · `TMPDIR="$PWD/.tmp" npm run test:terminal` **PASS**. The first three were re-run after the change below; the last two were not, because they spend plan quota.
- Public at **https://github.com/blackhat-7/forseti**, tracking `origin/main`. `gitleaks` pre-commit hook passing.

## Done this session

- **Stopped tracking generated reports.** `exportReport` writes a `comparison-<timestamp>.md` per export and the PTY smoke test exports every run, so each routine verification added a few hundred committed lines. Those 53 files are now gitignored and untracked, still on disk. The two curated reports the README links stay tracked.

## Next

First unchecked line in `PLAN.md`: rename the `quality` dimension to `hygiene` through types, config, graders, suite manifest, report and TUI, so no view shows a number that is structurally incapable of moving.

## Gotchas

- **`npm run test:terminal` now spends Claude plan quota.** `forseti.json` has the reviewer enabled, the PTY test copies that config unchanged, and `duplicate-rule` declares `design`, so the control run makes a real reviewer call. Runtime went from ~15s to ~25s. Disable the reviewer before the smoke test if quota is tight.
- **Only the Claude Code login works.** Codex OAuth is rejected server-side (`Provided authentication token is expired`) though the stored token looks valid; a read-only preflight cannot see server-side revocation. Kimi's monthly quota is exhausted. Forseti will not rotate a token or buy quota.
- **A reviewer's thinking level is part of its identity.** Changing it invalidates the agreement number. Re-run `npm run test:judge` after any reviewer change.
- **"3 turns" and "3 rounds" are different things.** The reviewer's `--max-turns` is 3, a fix. Raising it to 3 *rounds* is `repeat`, an open task under `PLAN.md` Later.
- Auto mode's gatekeeper classifier fails closed intermittently and blocks all tool calls. Refresh the Codex login in Pi and retry. Do not change auto-mode configuration.
- lean-ctx resolves a different active project root, so some reads outside this workspace are denied, including files under `/private/tmp`. Use the native reader for those. Do not reconfigure it.
- Runs before `19-09-01` predate the suite-hardening and rubric changes, so their hashes differ. Keep them; reports split them into separate groups rather than pooling.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`.
- `CLAUDE.md` is a symlink to `AGENTS.md`. Edit `AGENTS.md`.
