# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-29

## State

- **Runs on macOS and Linux.** On Linux, `src/sandbox-linux.py` confines Python with Landlock + seccomp. Kernel 6.12+, x86_64 or arm64; anything else fails closed.
- **28 tasks.** `hard` 3 (`due-dates`, `sheet-eval`, `lock-refresh`) · `standard` 14 · `basic` 11. A task may set its own `turns`/`timeout`; the effective budget is the larger of the run's and the task's.
- **Scoring changed this session.** Running out of a task's turn or time budget counts as unsolved (auth, quota, crash, cancel stay `not-run`). The headline weights each difficulty level equally.
- **The rebuilt hard tier separates, on one try each.** `lock-refresh` and `sheet-eval`: Haiku ✗, Sonnet ✗, Opus ✓. `crew-schedule` and `log-query`: Haiku ✗, Sonnet ✓. Detail in `docs/transcript-research.md`. Not yet a measurement.
- **The leaderboard is strict and currently empty.** It shows only tries recorded under today's code, task fingerprints and default settings; the lane (Claude Code vs Pi) may differ. Live streaming (commit b333ddc) moved the fingerprint on purpose: every earlier try is stale.
- **Every try streams to `trials/<id>/live.jsonl`.** The TUI's Live tab (key 2) tails it: one pane per try in progress, `[` `]` focus, ⏎ zoom. Claude Code runs with `--output-format stream-json`.
- **A run only makes missing tries.** Same model + same task hash + same harness and settings = already done. `--fresh` forces a rerun.
- Battery on Linux: `npm run check` clean · `npm test` **85/85** · `npm run test:terminal` passes · `test:suite`, `test:judge` not run this session.

## Done this session

- TUI split into `src/ui/` (kit, board, live, running). Tabs: Home · Live · Models · Tests · Runs · Settings.
- One drawing per frame; repaints keep the scroll position; clicks reach tabs, list rows, settings and dialog buttons.
- Redesign: hairline header and footer, eighth-block bars, banded selected rows, centered dialogs.

## Next

`PLAN.md`: top up the hard tier to 3 tries — only missing tries run. Editing `src/trial.ts` or anything it calls makes every try stale.

## Gotchas

- **`render(w, 'body')` reuses the last frame drawn at that width.** A test that changes state must render the header (or `'all'`) first.
- **`parallel` in forseti.json sets tries at once (default 1).** Local-server models still run one at a time.
- **If `npm test` fails on `fingerprint.lock`, you changed how tries run.** Only `src/trial.ts` and its imports count, without comments or layout. Record it with `npm run fingerprint -- "why"` only if intended. A Claude Code update also resets Claude tries.
- **Parallel Opus subagents drain the plan's 5-hour window fast.** Four here plus four in another project's session took it from 70% to 100% in about 30 minutes; the benchmark trials were ~2% of that. Run agents one at a time, or on Sonnet.
- **Pilot with Haiku and Sonnet first; run Opus only where both fail.** Opus is the costliest candidate.
- **A prompt that lists expected behaviours makes a bug hunt easy.** It points at every defect.
- **The Linux sandbox denies `exec` of anything, even Python.** A grader that needs a subprocess fails with `PermissionError`.
- **A copied `node_modules` has no `.bin`, so `tsc` is missing.** Run `TMPDIR="$PWD/.tmp" npm ci` after moving machines.
- **`--safe-mode` disables every MCP server.** The Claude Code lane uses `--restricted`. Do not switch back.
- **`forseti.json` holds the local server address; never commit it.**
- **Running `python3` against a fixture writes `__pycache__` into it.** Always `python3 -B`.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`. `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`.
