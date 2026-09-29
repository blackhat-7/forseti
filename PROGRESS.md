# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-27

## State

- **Runs on macOS and Linux.** On Linux, `src/sandbox-linux.py` confines Python with Landlock + seccomp. Kernel 6.12+, x86_64 or arm64; anything else fails closed.
- **28 tasks.** `hard` 3 (`due-dates`, `sheet-eval`, `lock-refresh`) · `standard` 14 · `basic` 11. A task may set its own `turns`/`timeout`; the effective budget is the larger of the run's and the task's.
- **Scoring changed this session.** Running out of a task's turn or time budget counts as unsolved (auth, quota, crash, cancel stay `not-run`). The headline weights each difficulty level equally.
- **The rebuilt hard tier separates, on one try each.** `lock-refresh` and `sheet-eval`: Haiku ✗, Sonnet ✗, Opus ✓. `crew-schedule` and `log-query`: Haiku ✗, Sonnet ✓. Detail in `docs/transcript-research.md`. Not yet a measurement.
- **The leaderboard is strict and currently empty.** It shows only tries recorded under today's code, task fingerprints and default settings; the lane (Claude Code vs Pi) may differ. The 2026-09-29 fingerprint change reset it: every earlier try is on older code.
- **A run only makes missing tries.** Same model + same task hash + same harness and settings = already done. `--fresh` forces a rerun.
- Battery on Linux: `npm run check` clean · `npm test` **65/65** · `npm run test:suite` passes, 28 tasks. `test:terminal`, `test:judge` not run.

## Done this session

- One-page comparison page with plain words, ties sharing a rank, difficulty and skill tables. Kanagawa Dragon palette.
- Six big tasks built: 2 multi-file bug hunts, 2 search problems, 2 long specs. The bug hunts proved too easy and sit in `standard`.
- Merged the 2026-09-21 work from `origin/main` (local provider, Python over MCP for Claude Code).

## Next

`PLAN.md`: top up the hard tier to 3 tries — only missing tries run. Editing `src/trial.ts` or anything it calls makes every try stale.

## Gotchas

- **`parallel` in forseti.json sets tries at once (default 1).** Local-server models still run one at a time. Only `src/trial.ts` and what it calls are fingerprinted; editing `runner.ts`, `app.ts`, `cli.ts`, `report.ts` or `tui.ts` keeps recorded tries.
- **Parallel Opus subagents drain the plan's 5-hour window fast.** Four here plus four in another project's session took it from 70% to 100% in about 30 minutes; the benchmark trials were ~2% of that. Run agents one at a time, or on Sonnet.
- **Pilot with Haiku and Sonnet first; run Opus only where both fail.** Opus is the costliest candidate.
- **A prompt that lists expected behaviours makes a bug hunt easy.** It points at every defect.
- **The Linux sandbox denies `exec` of anything, even Python.** A grader that needs a subprocess fails with `PermissionError`.
- **A copied `node_modules` has no `.bin`, so `tsc` is missing.** Run `TMPDIR="$PWD/.tmp" npm ci` after moving machines.
- **`--safe-mode` disables every MCP server.** The Claude Code lane uses `--restricted`. Do not switch back.
- **`forseti.json` holds the local server address; never commit it.**
- **Running `python3` against a fixture writes `__pycache__` into it.** Always `python3 -B`.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`. `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`.
